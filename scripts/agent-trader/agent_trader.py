#!/usr/bin/env python3
"""Agent-Trader experiment — Claude (the agent) IS the signal.

LLM-as-trader benchmark on Polymarket. The harness fetches researchable candidate
markets (free Gamma API), records the agent's hold-to-resolution paper bets net of
spread, and evaluates calibration + P&L as markets resolve. The DECISION layer is the
agent itself (research per market via web + reasoning), not a hardcoded signal.

Bankroll: $1000 hypothetical, flat $25/bet to start (clean evaluation; evolve to
edge-sized once calibration data exists). Universe: researchable (politics/geo/macro/
policy/tech) + crypto catalysts; per-market research. Cadence: weekly + short-horizon.

Log: bets.jsonl — rows are only ever appended by `record`; `evaluate` updates an existing
row in place (status/pnl on resolution, mark_yes_price weekly) and never deletes one.
Lessons: lessons.md (loaded into future decisions).
"""
from __future__ import annotations
from datetime import datetime, timezone
from pathlib import Path
import json
import os
import tempfile
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


def _write_bets(bets):
    """Rewrite the track record atomically.

    `evaluate` updates rows in place, so it has to rewrite the whole file — and a
    truncated `bets.jsonl` is the only unrecoverable failure this experiment has.
    Write a sibling temp file and `os.replace` it in, so an interrupted run leaves
    the previous track record intact.
    """
    fd, tmp = tempfile.mkstemp(dir=str(BETS.parent), prefix=".bets-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            for b in bets:
                fh.write(json.dumps(b, ensure_ascii=False) + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, BETS)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def evaluate():
    """Re-fetch open bets; if resolved, compute pnl_net and update the log in place.

    Also snapshots the current YES price of every still-open bet into `mark_yes_price`.
    Polymarket's formal resolution can lag the real-world outcome by weeks (Bet 1 traded
    at 0.0005 for a fortnight after expiry while `closed` stayed false), and a decided-
    but-unbooked position silently flatters the headline record. The mark is what lets
    the summary/email/metrics disclose those without touching the resolved-only stats.
    """
    bets = load_bets()
    changed = False
    for b in bets:
        if b["status"] != "open":
            continue
        try:
            # RequestException also covers requests' JSONDecodeError: a transport
            # failure and a garbled body are the same "try again next run" case.
            # Anything else (schema drift, a bug here) propagates instead of being
            # silently swallowed into a stale record.
            m = _fetch_market(b["market_id"])
        except requests.RequestException as e:
            print(f"  warn: fetch failed for {b['market_id']}: {e}")
            continue
        if not m:
            continue
        prices = json.loads(m.get("outcomePrices", "[]"))
        if not prices:
            continue
        if not m.get("closed"):
            mark = round(float(prices[0]), 4)
            # marked_at is the date the mark was last OBSERVED, not last changed —
            # an unchanged price still means "this is today's price".
            marked_at = _now().date().isoformat()
            if b.get("mark_yes_price") != mark or b.get("marked_at") != marked_at:
                b["mark_yes_price"] = mark
                b["marked_at"] = marked_at
                changed = True
            continue
        yes_won = float(prices[0]) > 0.5
        won = (yes_won and b["side"] == "YES") or ((not yes_won) and b["side"] == "NO")
        entry = b["entry_price"]
        b["pnl_net"] = round((b["stake"] / entry - b["stake"]) if won else -b["stake"], 2)
        b["resolved_outcome"] = "YES" if yes_won else "NO"
        b["status"] = "won" if won else "lost"
        changed = True
    if changed:
        _write_bets(bets)
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
    hr = _honest_record(bets)
    if hr and hr["n_pending"]:
        print(f"mark-to-market: {hr['wins']}-{hr['losses']}  P&L ${hr['pnl']:+.2f}  "
              f"bankroll: ${hr['bankroll']:.2f}  "
              f"({hr['n_pending']} open position(s) already decided by the market)")
    print(f"capital at risk (open): ${sum(b['stake'] for b in openb):.0f}")


def _honest_record(bets):
    """Resolved record plus open positions the market has already decided (mark-to-market).

    Lives in metrics.py (pure, no network); imported lazily so this module keeps working
    if metrics.py is unavailable. Returns None when it can't be computed — but says so:
    silently dropping the disclosure is how a flattered headline gets shipped.
    """
    try:
        import metrics as _metrics
        return _metrics.honest_record(bets)
    except ImportError:
        return None
    except Exception as e:
        print(f"  warn: mark-to-market unavailable ({type(e).__name__}: {e})")
        return None


def _mark_outcome(b):
    try:
        import metrics as _metrics
        return _metrics.mark_outcome(b)
    except ImportError:
        return None
    except Exception as e:
        print(f"  warn: mark unavailable for {b.get('bet_id')} "
              f"({type(e).__name__}: {e})")
        return None


# --- Open positions: every price tagged with the frame it lives in -------------------
#
# Two frames exist and they are NOT interchangeable:
#   HELD frame  — the price of the token you actually own (YES token for a YES bet, NO
#                 token for a NO bet). `entry_price` is always in this frame.
#   YES frame   — the market's YES price. `market_yes_price` and `mark_yes_price` are
#                 always in this frame, whichever side was taken.
# Mixing them is not hypothetical. lessons.md quotes bet 7 (a NO position) in the YES frame
# twice: Run 11 "current YES=0.595" and Run 12 "mark YES=0.325". Read as this position's
# entry and mark they imply a 0.27 move; in the held frame the move is 0.620 -> 0.675, i.e.
# +0.055 — about a fifth of that. The old email table invited precisely that subtraction:
# an unlabelled "Entry" column (held frame, 0.62 on a NO) sat next to "Mark (YES)".
# Anything that reports on an open position must go through these two functions.

_MISSING = "—"


def open_positions(bets):
    """One row per OPEN bet, with every price labelled by frame. Pure — no network.

    Returned keys:
      bet_id, side, question, end_date, stake, confidence
      entry_held  — entry in the HELD-token frame (= entry_price, as logged)
      mark_held   — last mark in the HELD-token frame (mark_yes_price for YES,
                    1 - mark_yes_price for NO); None when there is no mark
      delta_held  — mark_held - entry_held, i.e. the move in your favour; None w/o a mark
      entry_yes   — entry in the YES frame (= market_yes_price at the time of the bet)
      mark_yes    — last mark in the YES frame (= mark_yes_price, as logged)
      marked_at   — the date the mark was last observed
      decided     — metrics.mark_outcome(): 'pending_win' / 'pending_loss' / None

    CAVEAT, and it is not cosmetic: `entry_held` is the price actually PAID, i.e. the ask
    after crossing the spread, while `mark_held` derives from `outcomePrices` (a mid),
    which crosses nothing. So `delta_held` is APPROXIMATE and slightly PESSIMISTIC versus
    a like-for-like mid-to-mid comparison — by roughly the half-spread paid on entry. It
    is a position-tracking number, not a realisable P&L; the realisable figure only exists
    at resolution (`pnl_net`) or in metrics' mark-to-market for already-decided positions.
    """
    rows = []
    for b in bets:
        if b.get("status") != "open":
            continue
        entry_held = b.get("entry_price")
        mark_yes = b.get("mark_yes_price")
        if mark_yes is None:
            mark_held = delta = None
        else:
            mark_yes = float(mark_yes)
            # Case-normalised on purpose: a lowercase "yes" compared exactly would fall
            # into the NO branch and complement the mark — a silent frame inversion, the
            # one failure this whole function exists to make impossible. record_bet
            # writes side.upper(), so this only ever matters for hand-edited rows.
            is_yes = str(b.get("side") or "").upper() == "YES"
            mark_held = round(mark_yes if is_yes else 1 - mark_yes, 4)
            delta = (round(mark_held - float(entry_held), 4)
                     if entry_held is not None else None)
        rows.append({
            "bet_id": b.get("bet_id"), "side": b.get("side"),
            "question": b.get("question"), "end_date": b.get("end_date"),
            "stake": b.get("stake"), "confidence": b.get("confidence"),
            "entry_held": entry_held, "mark_held": mark_held, "delta_held": delta,
            "entry_yes": b.get("market_yes_price"), "mark_yes": mark_yes,
            # NOT `or 0.0`: a missing edge would print as "+0.000", i.e. a measured zero,
            # inventing the one number this view exists to stop inventing. None renders
            # as the em-dash in both the ASCII table and the email.
            "edge_at_entry": b.get("edge_per_contract"),
            "marked_at": b.get("marked_at"), "decided": _mark_outcome(b),
        })
    return rows


def format_positions(rows) -> str:
    """Deterministic ASCII table of `open_positions` rows. Frames named in the headers."""
    if not rows:
        return "no open positions."

    def num(v, sign=False):
        if v is None:
            return _MISSING
        return f"{v:+.3f}" if sign else f"{v:.3f}"

    hdr = ["side", "entry(held)", "mark(held)", "delta(held)", "edge@entry",
           "entry(YES)", "mark(YES)", "decided", "stake", "marked", "resolves",
           "question"]
    body = [[
        str(r["side"]), num(r["entry_held"]), num(r["mark_held"]),
        num(r["delta_held"], sign=True), num(r["edge_at_entry"], sign=True),
        num(r["entry_yes"]), num(r["mark_yes"]),
        {"pending_win": "WIN", "pending_loss": "LOSS"}.get(r["decided"], ""),
        f"${r['stake']:.0f}" if r["stake"] is not None else _MISSING,
        str(r["marked_at"] or _MISSING), str(r["end_date"] or "")[:10],
        (r["question"] or "")[:60],
    ] for r in rows]
    w = [max(len(h), *(len(row[i]) for row in body)) for i, h in enumerate(hdr)]
    line = "  ".join(h.ljust(w[i]) for i, h in enumerate(hdr)).rstrip()
    out = [line, "-" * len(line)]
    out += ["  ".join(c.ljust(w[i]) for i, c in enumerate(row)).rstrip() for row in body]
    out += [
        "",
        "(held) = frame of the token you own: YES token for a YES bet, NO token for a NO "
        "bet.",
        "(YES)  = the market's YES price, whichever side was taken. entry(YES) is the YES "
        "price when the bet was placed; mark(YES) is the latest observed YES price.",
        "delta(held) = mark(held) - entry(held). APPROXIMATE and slightly pessimistic: "
        "entry(held) is the ask actually paid (spread crossed), the mark is a mid "
        "(spread not crossed). Not a realisable P&L.",
        "The entry(YES)/mark(YES) pair is mid-to-mid, so the move it implies is LARGER "
        "than delta(held) by the half-spread paid on entry. delta(held) is the position's "
        "number; the YES pair is the market's quote.",
        "Never subtract across frames — entry(held) minus mark(YES) is meaningless.",
    ]
    return "\n".join(out)


def _latest_lessons_section() -> str:
    p = HERE / "lessons.md"
    if not p.exists():
        return ""
    lines = p.read_text(encoding="utf-8").splitlines()
    idxs = [i for i, l in enumerate(lines) if l.startswith("## Run")]
    return "\n".join(lines[idxs[-1]:]) if idxs else ""


# Module level, not inline in the f-string below: a backslash inside an f-string
# expression is a syntax error before Python 3.12, which made the whole module
# unparseable on a stock 3.11 (CI pins 3.12; a laptop usually doesn't).
_LIST_ITEM = re.compile(r"^\s*(?:[-*]|\d+\.)\s+")


_BLOCKQUOTE = re.compile(r"^\s*>\s?")
# Italic runs AFTER bold, so every '**' is already consumed and a lone '*' is unambiguous.
# The lookarounds refuse a marker that hugs whitespace or a word character, which is what
# keeps arithmetic ("2 * 3") and leftover list markers from being read as emphasis.
_ITALIC = re.compile(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])")


def _md_to_html(md: str) -> str:
    """Minimal Markdown -> HTML for the lessons section.

    Assembles BLOCKS first and renders inline spans once per block, rather than rendering
    line by line. That ordering is the whole point: lessons.md is hard-wrapped prose written
    by a different author every week, so an inline span routinely straddles a line break.
    The old line-based version emitted the 2026-08-10 audit correction with 10 literal '**',
    24 literal '*', 11 escaped '&gt;' and 14 fragmented <ul> blocks — no exception, no lost
    text, just silent fidelity loss in the one artefact a human actually reads.

    Supports headers, bold, italic, code, bullet/numbered lists (with wrapped continuations)
    and blockquotes. Anything else degrades to a paragraph, which is the safe direction.
    """
    def inline(t):
        t = t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        t = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", t)
        t = re.sub(r"`([^`]+?)`", r"<code>\1</code>", t)
        t = _ITALIC.sub(r"<em>\1</em>", t)
        return t

    out = []
    kind = None          # None | 'p' | 'li' | 'quote'
    buf = []
    in_ul = False

    def flush():
        nonlocal kind, buf
        if kind and buf:
            text = inline(" ".join(s.strip() for s in buf if s.strip()))
            if kind == "li":
                out.append(f"<li>{text}</li>")
            elif kind == "quote":
                out.append("<blockquote style='margin:6px 0 6px 12px;padding-left:10px;"
                           f"border-left:3px solid #d0d7de;color:#444'>{text}</blockquote>")
            else:
                out.append(f"<p style='margin:6px 0'>{text}</p>")
        kind, buf = None, []

    def close_ul():
        nonlocal in_ul
        if in_ul:
            out.append("</ul>")
            in_ul = False

    for raw in md.splitlines():
        line = raw.rstrip()
        if not line.strip():
            flush(); close_ul()
            continue
        if line.startswith("### ") or line.startswith("## "):
            flush(); close_ul()
            tag, text = ("h4", line[4:]) if line.startswith("### ") else ("h3", line[3:])
            margin = "10px 0 4px" if tag == "h4" else "12px 0 4px"
            out.append(f"<{tag} style='margin:{margin}'>{inline(text)}</{tag}>")
        elif _LIST_ITEM.match(line):
            flush()
            if not in_ul:
                out.append("<ul style='margin:4px 0;padding-left:20px'>")
                in_ul = True
            kind, buf = "li", [_LIST_ITEM.sub("", line)]
        elif _BLOCKQUOTE.match(line):
            if kind != "quote":
                flush(); close_ul()
                kind = "quote"
            buf.append(_BLOCKQUOTE.sub("", line))
        elif kind in ("li", "quote", "p"):
            # A continuation line: same block, joined with a space. This is what lets a
            # bold span, a code span or a list item survive the author's line wrapping.
            buf.append(line)
        else:
            close_ul()
            kind, buf = "p", [line]
    flush(); close_ul()
    return "\n".join(out)


def email_html(bets=None) -> str:
    """Build an HTML weekly summary email body (record + open bets + latest lessons).

    `bets` defaults to the real track record; it is a parameter so the frame contract of
    the open-bets table can be pinned by a test without touching bets.jsonl. The email is
    the artefact a human actually reads, so its frames need a test of their own.
    """
    bets = load_bets() if bets is None else bets
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

    # Open bets: entry and mark side by side ONLY in the same frame (the held token).
    # The YES-frame pair is kept for reference but labelled so it can't be mistaken for
    # the position's own prices — the previous table put an unlabelled "Entry" (held
    # frame) next to "Mark (YES)", which is a subtraction across frames waiting to happen
    # (see the frames note above open_positions for the bet-7 case).
    def num(v, sign=False):
        if v is None:
            return "—"
        return f"{v:+.3f}" if sign else f"{v:.3f}"

    def mark_cell(r):
        if r["mark_held"] is None:
            return "<td>—</td>"
        note = {"pending_win": " ✅ decided", "pending_loss": " ❌ decided"}.get(
            r["decided"], "")
        return (f"<td>{num(r['mark_held'])}{note}"
                f"<br><span style='color:#888;font-size:11px'>"
                f"{esc(r.get('marked_at') or '?')}</span></td>")

    rows = "".join(
        f"<tr><td>{esc(r['side'])}</td><td>{num(r['entry_held'])}</td>{mark_cell(r)}"
        f"<td>{num(r['delta_held'], sign=True)}</td>"
        f"<td>{num(r['edge_at_entry'], sign=True)}</td>"
        f"<td style='color:#888'>{num(r['entry_yes'])} → {num(r['mark_yes'])}</td>"
        f"<td>{esc(str(r['end_date'] or '')[:10])}</td>"
        f"<td>{esc((r['question'] or '')[:70])}</td></tr>"
        for r in open_positions(bets))
    resolved_rows = "".join(
        f"<tr><td>{esc(b['status'].upper())}</td><td>${b['pnl_net']:+.2f}</td>"
        f"<td>{esc(b['side'])}</td><td>{esc(b['question'][:70])}</td></tr>"
        for b in closed[-8:])

    # The metrics block already opens with the mark-to-market paragraph when there is
    # anything pending (metrics.render_html), and it is rendered directly under the
    # headline — so it stays the single place that disclosure is written. Don't add a
    # second copy here: two different-looking lines with the same numbers read as two
    # findings.
    try:
        import metrics as _metrics
        metrics_block = _metrics.render_html(_metrics.compute_metrics(bets))
    except ImportError:
        metrics_block = ""
    except Exception as e:
        print(f"  warn: metrics block unavailable ({type(e).__name__}: {e})")
        metrics_block = ""

    return f"""<html><body style="font-family:sans-serif;max-width:720px">
<h2>Agent-Trader — weekly run</h2>
<p><b>Record:</b> {rec} &nbsp;|&nbsp; <b>P&amp;L net:</b> ${pnl:+.2f} &nbsp;|&nbsp;
<b>Bankroll:</b> ${BANKROLL0 + pnl:.2f} &nbsp;|&nbsp; <b>Brier:</b> {brier or 'n/a'} &nbsp;|&nbsp;
<b>Open:</b> {len(openb)} (${sum(b['stake'] for b in openb):.0f} at risk)</p>
{metrics_block}
<h3>Open bets</h3>
<p style="color:#666;font-size:12px;margin:4px 0">Entry and mark are both in the
<b>held-token frame</b> (the YES token on a YES bet, the NO token on a NO bet), so the
delta is the move in your favour. The greyed column is the same position in the
<b>YES frame</b> for reference only — never subtract across the two.</p>
<table border="1" cellpadding="4" cellspacing="0">
<tr><th>Side</th><th>Entry<br>(held)</th><th>Mark<br>(held)</th><th>Δ<br>(held)</th><th>Edge<br>at entry</th><th>Market mid at entry →<br>latest mid (YES frame)</th><th>Resolves</th><th>Market</th></tr>{rows or '<tr><td colspan=8>none</td></tr>'}</table>
<p style="color:#888;font-size:11px;margin:4px 0">Δ is approximate and slightly
pessimistic: entry is the ask actually paid (spread crossed), the mark is a mid (spread
not crossed). Not a realisable P&amp;L. The greyed YES-frame pair is mid-to-mid, so the
move it implies is <b>larger</b> than Δ(held) by the half-spread paid on entry — Δ(held)
is the position's number, the greyed pair is the market's quote.</p>
{"<h3>Recently resolved</h3><table border=1 cellpadding=4 cellspacing=0><tr><th>Result</th><th>P&amp;L</th><th>Side</th><th>Market</th></tr>" + resolved_rows + "</table>" if closed else ""}
<h3>This run's notes (from lessons.md)</h3>
<div style="background:#f6f8fa;padding:10px 14px;border-radius:6px;line-height:1.45">{_md_to_html(_latest_lessons_section())}</div>
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
    elif cmd == "record":
        # record <market_id> <YES|NO> <p_hat_yes> <rationale_file> [stake] [confidence]
        #
        # The rationale comes from a FILE, never from an argv string. Passing it as a
        # shell argument silently corrupted four bets' rationales: bash expands `$4`,
        # `$1`, `$7` inside double quotes to empty positional parameters, so "$4.7M"
        # was logged as ".7M" and "$143K" as "43K" — every dollar figure in the audit
        # trail quietly lost its leading digit. A file is immune to the shell entirely.
        mid = sys.argv[2]
        m = requests.get(f"{GAMMA}/{mid}", timeout=30).json()
        p = json.loads(m["outcomePrices"])
        mkt = {"market_id": str(mid), "slug": m["slug"], "question": m["question"],
               "end_date": m["endDate"], "yes_price": float(p[0]),
               "best_bid": float(m["bestBid"]), "best_ask": float(m["bestAsk"]),
               "spread": float(m["spread"])}
        rationale = Path(sys.argv[5]).read_text(encoding="utf-8").strip()
        if not rationale:
            raise SystemExit("empty rationale file — a bet needs a defensible written view")
        bet = record_bet(mkt, sys.argv[3], float(sys.argv[4]), rationale,
                         stake=float(sys.argv[6]) if len(sys.argv) > 6 else DEFAULT_STAKE,
                         confidence=sys.argv[7] if len(sys.argv) > 7 else None)
        print(f"recorded {bet['bet_id']}: {bet['side']} @ {bet['entry_price']:.3f} "
              f"(p_hat_yes={bet['my_prob_yes']}, edge/contract={bet['edge_per_contract']:+.3f})")
    elif cmd == "evaluate":
        evaluate(); summary()
    elif cmd == "summary":
        summary()
    elif cmd == "positions":
        # The ONLY sanctioned source for any claim about an open position. Reciting
        # entries/marks from memory or from a previous run is what produced the Run 12
        # error; paste this output instead.
        text = format_positions(open_positions(load_bets()))
        try:
            print(text)
        except UnicodeEncodeError:
            print(text.encode("ascii", "replace").decode())
    elif cmd == "email_html":
        out = sys.argv[2] if len(sys.argv) > 2 else "email.html"
        Path(out).write_text(email_html(), encoding="utf-8")
        print(f"wrote {out}")
    elif cmd == "metrics":
        import metrics as _metrics
        m = _metrics.compute_metrics()
        date = sys.argv[2] if len(sys.argv) > 2 else _now().date().isoformat()
        _metrics.append_snapshot(m, date)   # persist first (robust to console issues)
        try:
            print(_metrics.render_text(m))
        except UnicodeEncodeError:
            print(_metrics.render_text(m).encode("ascii", "replace").decode())
        print(f"\nappended snapshot ({date}) to metrics.jsonl")
