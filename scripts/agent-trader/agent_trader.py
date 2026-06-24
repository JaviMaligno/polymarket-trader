#!/usr/bin/env python3
"""Agent-Trader experiment — Claude (the agent) IS the signal.

LLM-as-trader benchmark on Polymarket. The harness fetches researchable candidate
markets (free Gamma API), records the agent's hold-to-resolution paper bets net of
spread, and evaluates calibration + P&L as markets resolve. The DECISION layer is the
agent itself (research per market via web + reasoning), not a hardcoded signal.

Bankroll: $1000 hypothetical, flat $25/bet to start (clean evaluation; evolve to
edge-sized once calibration data exists). Universe: researchable (politics/geo/macro/
policy/tech) + crypto catalysts; per-market research. Cadence: weekly + short-horizon.

Log: bets.jsonl (append-only). Lessons: lessons.md (loaded into future decisions).
"""
from __future__ import annotations
from datetime import datetime, timezone
from pathlib import Path
import json
import requests

HERE = Path(__file__).resolve().parent
BETS = HERE / "bets.jsonl"
GAMMA = "https://gamma-api.polymarket.com/markets"
BANKROLL0 = 1000.0
DEFAULT_STAKE = 25.0


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_dt(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def fetch_candidates(horizon_days=45, min_liquidity=20000, max_spread=0.03,
                     min_vol24=5000, pages=6, page_size=100):
    """Active binary markets resolving within horizon, liquid, tradeable spread."""
    now = _now()
    out = []
    for p in range(pages):
        r = requests.get(GAMMA, params={
            "closed": "false", "active": "true", "limit": page_size,
            "offset": p * page_size, "order": "volume24hr", "ascending": "false",
        }, timeout=30)
        if r.status_code != 200:
            break
        batch = r.json()
        if not batch:
            break
        for m in batch:
            try:
                end = _parse_dt(m.get("endDate"))
                if end is None or end <= now:
                    continue
                if (end - now).days > horizon_days:
                    continue
                if m.get("closed") or not m.get("acceptingOrders", True):
                    continue
                outs = json.loads(m.get("outcomes", "[]"))
                if [o.lower() for o in outs] != ["yes", "no"]:
                    continue
                liq = float(m.get("liquidityNum") or m.get("liquidity") or 0)
                spread = float(m.get("spread") or 1)
                v24 = float(m.get("volume24hr") or 0)
                if liq < min_liquidity or spread > max_spread or v24 < min_vol24:
                    continue
                prices = json.loads(m.get("outcomePrices", "[]"))
                out.append({
                    "market_id": str(m.get("id")), "slug": m.get("slug"),
                    "question": m.get("question"), "end_date": m.get("endDate"),
                    "days_left": (end - now).days,
                    "yes_price": float(prices[0]) if prices else None,
                    "best_bid": float(m.get("bestBid") or 0),
                    "best_ask": float(m.get("bestAsk") or 0),
                    "spread": spread, "liquidity": round(liq),
                    "volume24hr": round(v24), "condition_id": m.get("conditionId"),
                    "description": (m.get("description") or "")[:300],
                })
            except (ValueError, TypeError, KeyError):
                continue
    # de-dup by market_id, sort by liquidity
    seen, uniq = set(), []
    for c in sorted(out, key=lambda x: -x["liquidity"]):
        if c["market_id"] not in seen:
            seen.add(c["market_id"])
            uniq.append(c)
    return uniq


import re

_SPORTS_NOISE = re.compile(
    r"world cup|win on \d{4}-\d{2}-\d{2}| vs\.? | vs | end in a draw|"
    r"\bnba\b|\bnfl\b|\bmlb\b|\bnhl\b|premier league|champions league|"
    r"super bowl|\bufc\b|\bf1\b|grand prix|tennis|golf|cricket|"
    r"\bup or down\b|hit \$.* (?:today|by end of (?:the )?(?:day|hour))", re.I)


def is_researchable(question: str) -> bool:
    """Exclude pure-sports / intraday-noise markets where research gives no edge."""
    return not _SPORTS_NOISE.search(question or "")


def _entry_and_pnl_factors(side, best_bid, best_ask):
    """Entry price you actually pay (cross the spread), and the gross payout multiple
    if you win. YES: pay ask. NO: pay (1 - bid) [= No ask]."""
    if side.upper() == "YES":
        entry = best_ask if best_ask > 0 else None
    else:
        entry = (1 - best_bid) if best_bid > 0 else None
    return entry


def record_bet(market, side, my_prob, rationale, stake=DEFAULT_STAKE, confidence=None):
    """Append a hold-to-resolution paper bet net of spread."""
    entry = _entry_and_pnl_factors(side, market["best_bid"], market["best_ask"])
    if not entry or entry <= 0 or entry >= 1:
        raise ValueError(f"bad entry price {entry}")
    yes_p = market["yes_price"]
    fair = my_prob if side.upper() == "YES" else (1 - my_prob)
    edge = fair - entry  # expected value per $1 of contract, net of spread
    bet = {
        "bet_id": f"b{int(_now().timestamp())}_{market['market_id']}",
        "placed_at": _now().isoformat(),
        "market_id": market["market_id"], "slug": market["slug"],
        "question": market["question"], "end_date": market["end_date"],
        "side": side.upper(), "my_prob_yes": round(my_prob, 4),
        "market_yes_price": yes_p, "entry_price": round(entry, 4),
        "spread": market["spread"], "stake": stake,
        "edge_per_contract": round(edge, 4), "confidence": confidence,
        "rationale": rationale, "status": "open",
        "resolved_outcome": None, "pnl_net": None,
    }
    with BETS.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(bet, ensure_ascii=False) + "\n")
    return bet


def load_bets():
    if not BETS.exists():
        return []
    return [json.loads(l) for l in BETS.open(encoding="utf-8") if l.strip()]


def _fetch_market(market_id):
    r = requests.get(f"{GAMMA}/{market_id}", timeout=30)
    return r.json() if r.status_code == 200 else None


def evaluate():
    """Re-fetch open bets; if resolved, compute pnl_net and update the log in place."""
    bets = load_bets()
    changed = False
    for b in bets:
        if b["status"] != "open":
            continue
        m = _fetch_market(b["market_id"])
        if not m or not m.get("closed"):
            continue
        prices = json.loads(m.get("outcomePrices", "[]"))
        if not prices:
            continue
        yes_won = float(prices[0]) > 0.5
        won = (yes_won and b["side"] == "YES") or ((not yes_won) and b["side"] == "NO")
        entry = b["entry_price"]
        b["pnl_net"] = round((b["stake"] / entry - b["stake"]) if won else -b["stake"], 2)
        b["resolved_outcome"] = "YES" if yes_won else "NO"
        b["status"] = "won" if won else "lost"
        changed = True
    if changed:
        with BETS.open("w", encoding="utf-8") as fh:
            for b in bets:
                fh.write(json.dumps(b, ensure_ascii=False) + "\n")
    return bets


def summary():
    bets = load_bets()
    closed = [b for b in bets if b["status"] in ("won", "lost")]
    openb = [b for b in bets if b["status"] == "open"]
    pnl = sum(b["pnl_net"] for b in closed if b["pnl_net"] is not None)
    wins = sum(1 for b in closed if b["status"] == "won")
    # Brier on resolved (my_prob_yes vs actual yes outcome)
    brier = None
    if closed:
        sq = [(b["my_prob_yes"] - (1 if b["resolved_outcome"] == "YES" else 0)) ** 2
              for b in closed]
        brier = round(sum(sq) / len(sq), 4)
    print(f"bets: {len(bets)}  open: {len(openb)}  resolved: {len(closed)}")
    if closed:
        print(f"record: {wins}-{len(closed)-wins}  hit_rate: {wins/len(closed):.2%}")
        print(f"P&L net: ${pnl:+.2f}  bankroll: ${BANKROLL0 + pnl:.2f}  Brier: {brier}")
    print(f"capital at risk (open): ${sum(b['stake'] for b in openb):.0f}")


def _latest_lessons_section() -> str:
    p = HERE / "lessons.md"
    if not p.exists():
        return ""
    lines = p.read_text(encoding="utf-8").splitlines()
    idxs = [i for i, l in enumerate(lines) if l.startswith("## Run")]
    return "\n".join(lines[idxs[-1]:]) if idxs else ""


def email_html() -> str:
    """Build an HTML weekly summary email body (record + open bets + latest lessons)."""
    bets = load_bets()
    closed = [b for b in bets if b["status"] in ("won", "lost")]
    openb = [b for b in bets if b["status"] == "open"]
    pnl = sum(b["pnl_net"] for b in closed if b["pnl_net"] is not None)
    wins = sum(1 for b in closed if b["status"] == "won")
    brier = ""
    if closed:
        sq = [(b["my_prob_yes"] - (1 if b["resolved_outcome"] == "YES" else 0)) ** 2
              for b in closed]
        brier = f"{sum(sq)/len(sq):.4f}"
    rec = (f"{wins}-{len(closed)-wins} ({wins/len(closed):.0%})" if closed else "0-0 (n/a)")

    def esc(s):
        return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))

    rows = "".join(
        f"<tr><td>{esc(b['side'])}</td><td>{b['entry_price']:.3f}</td>"
        f"<td>{b.get('edge_per_contract', 0):+.3f}</td><td>{esc(b['end_date'][:10])}</td>"
        f"<td>{esc(b['question'][:70])}</td></tr>"
        for b in openb)
    resolved_rows = "".join(
        f"<tr><td>{esc(b['status'].upper())}</td><td>${b['pnl_net']:+.2f}</td>"
        f"<td>{esc(b['side'])}</td><td>{esc(b['question'][:70])}</td></tr>"
        for b in closed[-8:])

    return f"""<html><body style="font-family:sans-serif;max-width:720px">
<h2>Agent-Trader — weekly run</h2>
<p><b>Record:</b> {rec} &nbsp;|&nbsp; <b>P&amp;L net:</b> ${pnl:+.2f} &nbsp;|&nbsp;
<b>Bankroll:</b> ${BANKROLL0 + pnl:.2f} &nbsp;|&nbsp; <b>Brier:</b> {brier or 'n/a'} &nbsp;|&nbsp;
<b>Open:</b> {len(openb)} (${sum(b['stake'] for b in openb):.0f} at risk)</p>
<h3>Open bets</h3>
<table border="1" cellpadding="4" cellspacing="0">
<tr><th>Side</th><th>Entry</th><th>Edge</th><th>Resolves</th><th>Market</th></tr>{rows or '<tr><td colspan=5>none</td></tr>'}</table>
{"<h3>Recently resolved</h3><table border=1 cellpadding=4 cellspacing=0><tr><th>Result</th><th>P&amp;L</th><th>Side</th><th>Market</th></tr>" + resolved_rows + "</table>" if closed else ""}
<h3>This run's notes (from lessons.md)</h3>
<pre style="white-space:pre-wrap;background:#f6f8fa;padding:10px;border-radius:6px">{esc(_latest_lessons_section())}</pre>
<p style="color:#888;font-size:12px">Paper experiment — hypothetical $1000 bankroll, no real funds.
Track record: scripts/agent-trader/bets.jsonl</p>
</body></html>"""


if __name__ == "__main__":
    import sys
    cmd = sys.argv[1] if len(sys.argv) > 1 else "candidates"
    if cmd == "candidates":
        cands = fetch_candidates()
        research = "--research" in sys.argv
        if research:
            cands = [c for c in cands if is_researchable(c["question"])]
        print(f"{len(cands)} candidates (liquid, <=45d, spread<=3%"
              f"{', researchable' if research else ''})")
        for c in cands[:60]:
            print(f"  [{c['market_id']}] yes={c['yes_price']:.3f} spr={c['spread']:.3f} "
                  f"liq={c['liquidity']:>7d} {c['days_left']:>3d}d  {c['question'][:62]}")
    elif cmd == "evaluate":
        evaluate(); summary()
    elif cmd == "summary":
        summary()
    elif cmd == "email_html":
        out = sys.argv[2] if len(sys.argv) > 2 else "email.html"
        Path(out).write_text(email_html(), encoding="utf-8")
        print(f"wrote {out}")
