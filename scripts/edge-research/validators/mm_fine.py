from __future__ import annotations
import numpy as np
from verdict import Verdict
from validators.base import bootstrap_ci

_CAVEAT = ("fine-cadence maker fill-sim; fill = trade crossed the touch (queue not "
           "observable); excludes inventory + rewards (H-MM-2)")
_HORIZONS = [("10s", "mid_10s"), ("60s", "mid_60s"), ("300s", "mid_300s")]


class MMFineValidator:
    """H-MM-3 — passive-maker retained spread at fine cadence with realistic fills."""

    hypothesis_id = "H-MM-3"
    hclass = "market_making"

    def required_inputs(self) -> list[str]:
        return ["mm_fine_fills"]

    def run(self, ctx) -> list[Verdict]:
        df = ctx.datasets["mm_fine_fills"].copy()
        df["tradeable"] = df["market_type"] != "event_long"
        p75 = df["size"].quantile(0.75) if len(df) else 0.0
        out: list[Verdict] = []
        groups = [("headline:tradeable", df[df["tradeable"]])]
        for mt in sorted(df["market_type"].dropna().unique()):
            groups.append((mt, df[df["market_type"] == mt]))
        for label, sub in groups:
            for hname, hcol in _HORIZONS:
                out.append(self._cohort(ctx, f"{label}:{hname}:all", sub, hcol))
                out.append(self._cohort(ctx, f"{label}:{hname}:large", sub[sub["size"] >= p75], hcol))
        return out

    def _cohort(self, ctx, label, sub, hcol) -> Verdict:
        floor = getattr(ctx, "mm_min_n", 200)
        s = sub.dropna(subset=[hcol, "maker_price", "maker_sign"])
        n = len(s)
        if n < floor:
            return Verdict(self.hypothesis_id, self.hclass, n, None, None, None,
                           "full", {"cohort": label}, "maker_fee_0", "inconclusive",
                           [_CAVEAT, f"n={n} below floor {floor}"], ctx.computed_at)
        retained = (s["maker_sign"].to_numpy(float) *
                    (s["maker_price"].to_numpy(float) - s[hcol].to_numpy(float)))
        edge = float(retained.mean())
        lo, hi = bootstrap_ci(retained, seed=ctx.seed)
        status = "pass" if (edge > 0 and lo > 0) else "fail"
        return Verdict(self.hypothesis_id, self.hclass, n, edge, edge,
                       float((hi - lo) / 2), "full", {"cohort": label}, "maker_fee_0",
                       status, [_CAVEAT], ctx.computed_at)
