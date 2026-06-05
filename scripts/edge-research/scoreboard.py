from __future__ import annotations
import csv, io


def _sort_key(v):
    return (v.edge_net_pct if v.edge_net_pct is not None else float("-inf"))


def render_markdown(verdicts: list, blocked: list[dict], pending: list[dict] | None = None) -> str:
    rows = sorted(verdicts, key=_sort_key, reverse=True)
    lines = ["# Edge Research scoreboard", "",
             "| id | class | n | edge_net% | insample% | sig | status | caveats |",
             "|----|-------|---|-----------|-----------|-----|--------|---------|"]
    for v in rows:
        e = "" if v.edge_net_pct is None else f"{v.edge_net_pct*100:.2f}"
        ins = "" if v.edge_insample_pct is None else f"{v.edge_insample_pct*100:.2f}"
        sig = "" if v.significance is None else f"{v.significance:.2f}"
        cav = "; ".join(v.n_caveats)
        lines.append(f"| {v.hypothesis_id} | {v.hclass} | {v.n} | {e} | {ins} | {sig} | {v.status} | {cav} |")
    if pending:
        lines += ["", "## Pending (data available, validator not implemented yet)", ""]
        for p in pending:
            lines.append(f"- {p['id']} — {p.get('name','')} (pending)")
    if blocked:
        lines += ["", "## Blocked (data not available)", ""]
        for b in blocked:
            lines.append(f"- {b['id']} — {b.get('name','')} (blocked)")
    return "\n".join(lines) + "\n"


def render_csv(verdicts: list) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", "class", "n", "edge_net_pct", "edge_insample_pct",
                "significance", "split", "cost_model", "status", "caveats"])
    for v in sorted(verdicts, key=_sort_key, reverse=True):
        w.writerow([v.hypothesis_id, v.hclass, v.n, v.edge_net_pct, v.edge_insample_pct,
                    v.significance, v.split, v.cost_model, v.status, "; ".join(v.n_caveats)])
    return buf.getvalue()
