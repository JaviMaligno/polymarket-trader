from __future__ import annotations
import numpy as np, pandas as pd
from verdict import Verdict
from validators.base import bootstrap_ci


class CalibrationValidator:
    hypothesis_id = "H-CAL-1"
    hclass = "calibration"

    def required_inputs(self) -> list[str]:
        return ["market_panel_resolved"]

    def run(self, ctx) -> list[Verdict]:
        return [self._overall(ctx)]

    def _overall(self, ctx) -> Verdict:
        df = ctx.df
        n = len(df)
        if n < ctx.min_n:
            return Verdict(self.hypothesis_id, self.hclass, n, None, None, None,
                           "full", {}, f"entry_only_{ctx.cost}", "inconclusive",
                           [f"n={n} below floor {ctx.min_n}"], ctx.computed_at)
        p = df["yes_price"].to_numpy(float)
        y = df["outcome_yes"].to_numpy(float)
        brier = float(np.mean((p - y) ** 2))
        edges = np.linspace(0.0, 1.0, ctx.n_bins + 1)
        idx = np.clip(np.digitize(p, edges[1:-1]), 0, ctx.n_bins - 1)
        best = None  # (abs_excess, signed_edge, bin_dev, bin_n, ci_lo, ci_hi)
        for b in range(ctx.n_bins):
            m = idx == b
            bn = int(m.sum())
            if bn < ctx.min_n:
                continue
            dev = float(y[m].mean() - p[m].mean())  # outcome - price, payoff units
            excess = abs(dev) - ctx.cost
            if excess <= 0:
                continue
            lo, hi = bootstrap_ci(y[m] - p[m], seed=ctx.seed)
            if lo <= 0 <= hi:   # not significant
                continue
            signed = dev - np.sign(dev) * ctx.cost  # net edge per share, signed
            if best is None or abs(signed) > abs(best[1]):
                best = (excess, signed, dev, bn, lo, hi)
        if best is None:
            return Verdict(self.hypothesis_id, self.hclass, n, None, None, None,
                           "full", {"brier": brier}, f"entry_only_{ctx.cost}",
                           "fail", [], ctx.computed_at)
        _, signed, dev, bn, lo, hi = best
        return Verdict(self.hypothesis_id, self.hclass, n, float(signed), float(signed),
                       float((hi - lo) / 2), "full",
                       {"brier": brier, "edged_bin_n": bn}, f"entry_only_{ctx.cost}",
                       "pass", [], ctx.computed_at)
