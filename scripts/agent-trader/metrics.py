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

    return {
        "n_resolved": n, "n_open": len(openb), "wins": wins, "losses": n - wins,
        "hit_rate": round(wins / n, 4) if n else None,
        "pnl_net": round(total_pnl, 2),
        "roi": round(total_pnl / staked, 4) if staked else None,
        "bankroll": round(BANKROLL0 + total_pnl, 2),
        "brier": round(brier, 4) if brier is not None else None,
        "mean_pnl_per_bet": round(mean_pnl, 3) if mean_pnl is not None else None,
        "pnl_boot_lo": round(lo, 3) if lo is not None else None,
        "pnl_boot_hi": round(hi, 3) if hi is not None else None,
        "open_at_risk": round(sum(b["stake"] for b in openb), 2),
        "calibration": calib, "by_confidence": by_conf, "verdict": verdict,
    }


_VERDICT_LABEL = {
    "too_few": "too few resolved bets (need >=20)",
    "edge_shown": "EDGE SHOWN — net-positive AND significant",
    "positive_unproven": "positive but not yet significant (CI straddles 0)",
    "no_edge": "no edge (net ≤ 0)",
}


def append_snapshot(m: dict, date: str) -> None:
    """One row per run = the trajectory of cumulative metrics over time."""
    row = {"date": date, **{k: m[k] for k in (
        "n_resolved", "n_open", "wins", "losses", "hit_rate", "pnl_net", "roi",
        "bankroll", "brier", "mean_pnl_per_bet", "pnl_boot_lo", "pnl_boot_hi",
        "verdict")}}
    with METRICS_LOG.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")


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
    if m["calibration"]:
        L.append("calibration (pred YES vs actual YES):")
        for c in m["calibration"]:
            L.append(f"  {c['range']}: n={c['n']} pred={c['pred']} actual={c['actual']}")
    if m["by_confidence"]:
        L.append("by confidence:")
        for k, d in m["by_confidence"].items():
            L.append(f"  {k}: n={d['n']} pnl=${d['pnl']:+.2f} wins={d['wins']}")
    return "\n".join(L)


def render_html(m: dict) -> str:
    def calib_rows():
        if not m["calibration"]:
            return "<tr><td colspan=4>no resolved bets yet</td></tr>"
        return "".join(
            f"<tr><td>{c['range']}</td><td>{c['n']}</td><td>{c['pred']}</td>"
            f"<td>{c['actual']}</td></tr>" for c in m["calibration"])
    conf_rows = "".join(
        f"<tr><td>{k}</td><td>{d['n']}</td><td>${d['pnl']:+.2f}</td><td>{d['wins']}</td></tr>"
        for k, d in m["by_confidence"].items()) or "<tr><td colspan=4>—</td></tr>"
    return f"""<h3>Metrics</h3>
<p><b>Resolved:</b> {m['n_resolved']} &nbsp; <b>Record:</b> {m['wins']}-{m['losses']} &nbsp;
<b>Hit:</b> {m['hit_rate']} &nbsp; <b>P&amp;L net:</b> ${m['pnl_net']:+.2f} &nbsp;
<b>ROI:</b> {m['roi']} &nbsp; <b>Brier:</b> {m['brier']}</p>
<p><b>mean P&amp;L/bet:</b> {m['mean_pnl_per_bet']} &nbsp;
<b>bootstrap 95% CI:</b> [{m['pnl_boot_lo']}, {m['pnl_boot_hi']}] &nbsp;
<b>verdict:</b> {_VERDICT_LABEL.get(m['verdict'], m['verdict'])}</p>
<table border="1" cellpadding="4" cellspacing="0">
<tr><th>pred-prob bucket</th><th>n</th><th>pred YES</th><th>actual YES</th></tr>{calib_rows()}</table>
<p style="margin:6px 0"><b>By confidence:</b></p>
<table border="1" cellpadding="4" cellspacing="0">
<tr><th>confidence</th><th>n</th><th>P&amp;L</th><th>wins</th></tr>{conf_rows}</table>"""


if __name__ == "__main__":
    import sys
    m = compute_metrics()
    print(render_text(m))
    if len(sys.argv) > 1:  # any arg => also append a dated snapshot to metrics.jsonl
        append_snapshot(m, sys.argv[1])
        print(f"\nappended snapshot to {METRICS_LOG}")
