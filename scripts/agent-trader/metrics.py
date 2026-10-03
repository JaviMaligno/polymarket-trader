#!/usr/bin/env python3
"""Agent-Trader metrics — calibration, cost-aware P&L significance, trajectory.

Pure-stdlib (no numpy) so it runs in the lightweight CI. Reads bets.jsonl (the source
of truth), computes the metrics that actually judge an LLM-as-forecaster, appends a
per-run snapshot to metrics.jsonl (the trajectory), and renders text + HTML.

The headline test is the SAME cost-aware bar the quant program used: mean P&L/bet > 0
AND the bootstrap lower bound > 0 — i.e. the agent's net-of-spread edge is real and
significant, not noise. Plus calibration (when it says 70%, does it happen ~70%?).
"""
from __future__ import annotations
from pathlib import Path
import json
import random

HERE = Path(__file__).resolve().parent
BETS = HERE / "bets.jsonl"
METRICS_LOG = HERE / "metrics.jsonl"
BANKROLL0 = 1000.0


def load_bets():
    if not BETS.exists():
        return []
    return [json.loads(l) for l in BETS.open(encoding="utf-8") if l.strip()]


# An open position whose market has priced it this far is decided in substance; only
# Polymarket's formal resolution is outstanding. Disclosed as a pending win/loss, never
# folded into the resolved-only statistics (calibration, Brier, bootstrap verdict).
DECIDED_P = 0.02


def mark_outcome(b):
    """'pending_win' / 'pending_loss' / None for an open bet, from its last mark."""
    if b["status"] != "open" or b.get("mark_yes_price") is None:
        return None
    yes = float(b["mark_yes_price"])
    # Case-normalised: an exact comparison sends a lowercase "yes" down the NO branch and
    # complements the mark, which turns a pending LOSS into a pending WIN and flatters the
    # honest record. record_bet writes side.upper(), so this only bites hand-edited rows.
    p_win = yes if str(b["side"]).upper() == "YES" else 1 - yes
    if p_win >= 1 - DECIDED_P:
        return "pending_win"
    if p_win <= DECIDED_P:
        return "pending_loss"
    return None


def mark_pnl(b):
    """P&L this open bet would book at its mark, on the same terms as evaluate()."""
    o = mark_outcome(b)
    if o is None:
        return 0.0
    return round(b["stake"] / b["entry_price"] - b["stake"], 2) if o == "pending_win" \
        else -b["stake"]


def honest_record(bets):
    """Resolved record + positions the market has already decided but not yet booked."""
    closed = [b for b in bets if b["status"] in ("won", "lost")]
    pending = [b for b in bets if mark_outcome(b)]
    wins = sum(1 for b in closed if b["status"] == "won") \
        + sum(1 for b in pending if mark_outcome(b) == "pending_win")
    losses = len(closed) + len(pending) - wins
    pnl = sum(b["pnl_net"] for b in closed if b["pnl_net"] is not None) \
        + sum(mark_pnl(b) for b in pending)
    return {"n_pending": len(pending), "wins": wins, "losses": losses,
            "pnl": round(pnl, 2), "bankroll": round(BANKROLL0 + pnl, 2)}


def _bootstrap_ci(xs, n_boot=2000, seed=0, alpha=0.05):
    if len(xs) < 2:
        return (None, None)
    rng = random.Random(seed)
    k = len(xs)
    means = []
    for _ in range(n_boot):
        s = 0.0
        for _ in range(k):
            s += xs[rng.randrange(k)]
        means.append(s / k)
    means.sort()
    return (means[int(alpha / 2 * n_boot)], means[int((1 - alpha / 2) * n_boot)])


def compute_metrics(bets=None) -> dict:
    bets = load_bets() if bets is None else bets
    closed = [b for b in bets if b["status"] in ("won", "lost")]
    openb = [b for b in bets if b["status"] == "open"]
    n = len(closed)
    pnls = [b["pnl_net"] for b in closed if b["pnl_net"] is not None]
    total_pnl = sum(pnls)
    staked = sum(b["stake"] for b in closed)
    wins = sum(1 for b in closed if b["status"] == "won")
    brier = (sum((b["my_prob_yes"] - (1 if b["resolved_outcome"] == "YES" else 0)) ** 2
                 for b in closed) / n) if n else None
    mean_pnl = (total_pnl / n) if n else None
    lo, hi = _bootstrap_ci(pnls)

    # Calibration: predicted YES prob vs actual YES frequency, by 0.2 bucket.
    calib = []
    edges = [0.0, 0.2, 0.4, 0.6, 0.8, 1.0001]
    for i in range(len(edges) - 1):
        a, b2 = edges[i], edges[i + 1]
        grp = [x for x in closed if a <= x["my_prob_yes"] < b2]
        if grp:
            calib.append({
                "range": f"{a:.1f}-{min(b2,1.0):.1f}", "n": len(grp),
                "pred": round(sum(x["my_prob_yes"] for x in grp) / len(grp), 3),
                "actual": round(sum(1 for x in grp if x["resolved_outcome"] == "YES") / len(grp), 3),
            })

    # by_side: the prospective test of the 2026-09-21 side-bias hypothesis (NO 5-1 vs
    # YES 3-6 at n=15, the first subset whose CI excluded zero). Computed here so the
    # operator's trajectory carries it from now on; deliberately absent from render_text,
    # because render_text is what the AGENT reads and an agent told its YES bets lose
    # stops taking YES bets — which would destroy the very sample being collected.
    # See HYPOTHESIS-side-bias.md.
    by_side = {}
    for b in closed:
        # Case-normalised for the same reason mark_outcome() is: a hand-edited lowercase
        # "no" must not open a second bucket and halve both samples.
        k = str(b.get("side") or "n/a").upper()
        d = by_side.setdefault(k, {"n": 0, "wins": 0, "pnl": 0.0, "_pnls": []})
        d["n"] += 1
        d["wins"] += 1 if b["status"] == "won" else 0
        d["pnl"] += b["pnl_net"] or 0
        d["_pnls"].append(b["pnl_net"] or 0)
    for d in by_side.values():
        xs = d.pop("_pnls")
        d["pnl"] = round(d["pnl"], 2)
        d["mean"] = round(sum(xs) / len(xs), 3) if xs else None
        slo, shi = _bootstrap_ci(xs)
        d["boot_lo"] = round(slo, 3) if slo is not None else None
        d["boot_hi"] = round(shi, 3) if shi is not None else None

    by_conf = {}
    for b in closed:
        c = b.get("confidence") or "n/a"
        d = by_conf.setdefault(c, {"n": 0, "pnl": 0.0, "wins": 0})
        d["n"] += 1
        d["pnl"] += b["pnl_net"] or 0
        d["wins"] += 1 if b["status"] == "won" else 0
    for d in by_conf.values():
        d["pnl"] = round(d["pnl"], 2)

    # cost-aware verdict (same bar as the quant program)
    if n < 20:
        verdict = "too_few"          # need a real sample first
    elif mean_pnl is not None and mean_pnl > 0 and lo is not None and lo > 0:
        verdict = "edge_shown"       # net-positive AND significant
    elif mean_pnl is not None and mean_pnl > 0:
        verdict = "positive_unproven"  # positive but CI straddles 0
    else:
        verdict = "no_edge"

    # Mark-to-market DISCLOSURE only. Everything above (calibration, Brier, bootstrap,
    # verdict) stays on formally-resolved bets — a mark is a price, not an outcome, and
    # folding it into the significance bar would be exactly the shortcut this experiment
    # exists to avoid. It goes next to the headline so a resolution lag can't flatter it.
    hr = honest_record(bets)

    return {
        "n_resolved": n, "n_open": len(openb), "wins": wins, "losses": n - wins,
        "n_pending": hr["n_pending"], "wins_mtm": hr["wins"], "losses_mtm": hr["losses"],
        "pnl_net_mtm": hr["pnl"], "bankroll_mtm": hr["bankroll"],
        "hit_rate": round(wins / n, 4) if n else None,
        "pnl_net": round(total_pnl, 2),
        "roi": round(total_pnl / staked, 4) if staked else None,
        "bankroll": round(BANKROLL0 + total_pnl, 2),
        "brier": round(brier, 4) if brier is not None else None,
        "mean_pnl_per_bet": round(mean_pnl, 3) if mean_pnl is not None else None,
        "pnl_boot_lo": round(lo, 3) if lo is not None else None,
        "pnl_boot_hi": round(hi, 3) if hi is not None else None,
        "open_at_risk": round(sum(b["stake"] for b in openb), 2),
        "calibration": calib, "by_confidence": by_conf, "by_side": by_side,
        "verdict": verdict,
    }


_VERDICT_LABEL = {
    "too_few": "too few resolved bets (need >=20)",
    "edge_shown": "EDGE SHOWN — net-positive AND significant",
    "positive_unproven": "positive but not yet significant (CI straddles 0)",
    "no_edge": "no edge (net ≤ 0)",
}


def snapshot_row(m: dict, date: str) -> dict:
    """The trajectory row for one run: headline metrics plus the side split."""
    row = {"date": date, **{k: m[k] for k in (
        "n_resolved", "n_open", "wins", "losses", "hit_rate", "pnl_net", "roi",
        "bankroll", "brier", "mean_pnl_per_bet", "pnl_boot_lo", "pnl_boot_hi",
        "verdict", "n_pending", "wins_mtm", "losses_mtm", "pnl_net_mtm",
        "bankroll_mtm")}}
    # Flat side columns so the trajectory stays one JSON object per line and a plain
    # grep/jq over it can plot the hypothesis without unnesting.
    for side in ("YES", "NO"):
        d = m.get("by_side", {}).get(side) or {}
        pre = side.lower()
        row[f"{pre}_n"] = d.get("n", 0)
        row[f"{pre}_wins"] = d.get("wins", 0)
        row[f"{pre}_pnl"] = d.get("pnl", 0.0)
        row[f"{pre}_mean"] = d.get("mean")
        row[f"{pre}_boot_lo"] = d.get("boot_lo")
        row[f"{pre}_boot_hi"] = d.get("boot_hi")
    return row


def append_snapshot(m: dict, date: str) -> None:
    """One row per DATE = the trajectory of cumulative metrics over time.

    Rewrites that date's row when it already has one, instead of appending beside it.
    Manual re-runs of a week (the 2026-09-14 recovery, the 2026-07-20 provider switch)
    left duplicates — 17 rows for 18 runs across 13 distinct dates — which makes the
    trajectory unusable as a series without deduplicating it first. A re-run supersedes
    its earlier attempt at that date; it is not a second observation.
    """
    import datetime
    datetime.date.fromisoformat(date)  # ValueError: a flag is never a trajectory key
    row = snapshot_row(m, date)
    rows = [json.loads(l) for l in METRICS_LOG.open(encoding="utf-8")
            if l.strip()] if METRICS_LOG.exists() else []
    replaced = False
    for i, r in enumerate(rows):
        if r.get("date") == date:
            rows[i] = row          # in place: a re-run keeps its slot in the series
            replaced = True
    if not replaced:
        rows.append(row)
    with METRICS_LOG.open("w", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")


def render_text(m: dict) -> str:
    L = [
        f"resolved: {m['n_resolved']}  record: {m['wins']}-{m['losses']}  "
        f"hit_rate: {m['hit_rate']}  open: {m['n_open']} (${m['open_at_risk']:.0f})",
        f"P&L net: ${m['pnl_net']:+.2f}  ROI: {m['roi']}  bankroll: ${m['bankroll']:.2f}  "
        f"Brier: {m['brier']}",
        f"mean P&L/bet: {m['mean_pnl_per_bet']}  bootstrap 95% CI: "
        f"[{m['pnl_boot_lo']}, {m['pnl_boot_hi']}]",
        f"VERDICT: {_VERDICT_LABEL.get(m['verdict'], m['verdict'])}",
    ]
    if m.get("n_pending"):
        L.insert(2, f"mark-to-market ({m['n_pending']} open position(s) the market has "
                    f"already decided): {m['wins_mtm']}-{m['losses_mtm']}  "
                    f"P&L ${m['pnl_net_mtm']:+.2f}  bankroll: ${m['bankroll_mtm']:.2f}")
    if m["calibration"]:
        L.append("calibration (pred YES vs actual YES):")
        for c in m["calibration"]:
            L.append(f"  {c['range']}: n={c['n']} pred={c['pred']} actual={c['actual']}")
    if m["by_confidence"]:
        L.append("by confidence:")
        for k, d in m["by_confidence"].items():
            L.append(f"  {k}: n={d['n']} pnl=${d['pnl']:+.2f} wins={d['wins']}")
    return "\n".join(L)


def _side_lines(m: dict) -> list:
    """The YES/NO split. OPERATOR-ONLY — see the blindness note in compute_metrics."""
    if not m.get("by_side"):
        return []
    L = ["by side (operator view — not shown to the agent):"]
    for k in ("NO", "YES"):
        d = m["by_side"].get(k)
        if not d:
            continue
        ci = (f"[{d['boot_lo']:+.2f}, {d['boot_hi']:+.2f}]"
              if d["boot_lo"] is not None else "[n/a]")
        L.append(f"  {k:3}: n={d['n']} {d['wins']}-{d['n'] - d['wins']} "
                 f"pnl=${d['pnl']:+.2f} mean={d['mean']} 95% CI {ci}")
    return L


def render_operator_text(m: dict) -> str:
    """render_text plus the side split: the view for the weekly review and the email.

    A superset of the agent-facing text on purpose — same numbers from the same
    computation, one extra block — so the two views can never disagree.
    """
    return "\n".join([render_text(m)] + _side_lines(m))


def render_html(m: dict) -> str:
    def calib_rows():
        if not m["calibration"]:
            return "<tr><td colspan=4>no resolved bets yet</td></tr>"
        return "".join(
            f"<tr><td>{c['range']}</td><td>{c['n']}</td><td>{c['pred']}</td>"
            f"<td>{c['actual']}</td></tr>" for c in m["calibration"])
    def side_rows_html():
        rows = []
        for k in ("NO", "YES"):
            d = (m.get("by_side") or {}).get(k)
            if not d:
                continue
            ci = (f"[{d['boot_lo']:+.2f}, {d['boot_hi']:+.2f}]"
                  if d["boot_lo"] is not None else "&mdash;")
            rows.append(
                f"<tr><td>{k}</td><td>{d['n']}</td>"
                f"<td>{d['wins']}-{d['n'] - d['wins']}</td>"
                f"<td>${d['pnl']:+.2f}</td><td>{d['mean']}</td><td>{ci}</td></tr>")
        return "".join(rows) or "<tr><td colspan=6>&mdash;</td></tr>"
    side_rows = side_rows_html()
    conf_rows = "".join(
        f"<tr><td>{k}</td><td>{d['n']}</td><td>${d['pnl']:+.2f}</td><td>{d['wins']}</td></tr>"
        for k, d in m["by_confidence"].items()) or "<tr><td colspan=4>—</td></tr>"
    return f"""<h3>Metrics</h3>
<p><b>Resolved:</b> {m['n_resolved']} &nbsp; <b>Record:</b> {m['wins']}-{m['losses']} &nbsp;
<b>Hit:</b> {m['hit_rate']} &nbsp; <b>P&amp;L net:</b> ${m['pnl_net']:+.2f} &nbsp;
<b>ROI:</b> {m['roi']} &nbsp; <b>Brier:</b> {m['brier']}</p>
{f"<p style='color:#b34700'><b>Mark-to-market:</b> {m['wins_mtm']}-{m['losses_mtm']} &nbsp; <b>P&amp;L:</b> ${m['pnl_net_mtm']:+.2f} &nbsp; <b>Bankroll:</b> ${m['bankroll_mtm']:.2f} &nbsp; <i>({m['n_pending']} open position(s) already decided by the market, awaiting formal resolution)</i></p>" if m.get('n_pending') else ""}
<p><b>mean P&amp;L/bet:</b> {m['mean_pnl_per_bet']} &nbsp;
<b>bootstrap 95% CI:</b> [{m['pnl_boot_lo']}, {m['pnl_boot_hi']}] &nbsp;
<b>verdict:</b> {_VERDICT_LABEL.get(m['verdict'], m['verdict'])}</p>
<table border="1" cellpadding="4" cellspacing="0">
<tr><th>pred-prob bucket</th><th>n</th><th>pred YES</th><th>actual YES</th></tr>{calib_rows()}</table>
<p style="margin:6px 0"><b>By confidence:</b></p>
<table border="1" cellpadding="4" cellspacing="0">
<tr><th>confidence</th><th>n</th><th>P&amp;L</th><th>wins</th></tr>{conf_rows}</table>
<p style="margin:6px 0"><b>By side</b> &nbsp;<i>(operator view &mdash; deliberately not shown
to the agent; see HYPOTHESIS-side-bias.md)</i></p>
<table border="1" cellpadding="4" cellspacing="0">
<tr><th>side</th><th>n</th><th>record</th><th>P&amp;L</th><th>mean/bet</th>
<th>95% CI</th></tr>{side_rows}</table>"""


def main(argv: list[str], bets: list[dict] | None = None) -> str:
    """`metrics.py [--operator] [YYYY-MM-DD]`.

    Bare: the agent view. `--operator`: adds the side split (never a snapshot). A date:
    also writes that date's snapshot row. Anything else is an error — `--operator` used to
    be taken as a snapshot date, which printed the agent view and wrote a "--operator" row.
    """
    import argparse
    parser = argparse.ArgumentParser(prog="metrics.py")
    parser.add_argument("--operator", action="store_true")
    parser.add_argument("date", nargs="?")
    args = parser.parse_args(argv)
    m = compute_metrics(bets)
    out = render_operator_text(m) if args.operator else render_text(m)
    if args.date:
        append_snapshot(m, args.date)
        out += f"\n\nwrote snapshot to {METRICS_LOG}"
    return out


if __name__ == "__main__":
    import sys
    print(main(sys.argv[1:]))
