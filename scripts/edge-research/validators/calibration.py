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
        df = ctx.datasets["market_panel_resolved"]
        out = [self._slice(ctx, df, "H-CAL-1", {})]
        for mt, sub in df.groupby("market_type"):
            out.append(self._slice(ctx, sub, "H-CAL-2", {"slice": f"type={mt}"}))
        ttr_bucket = pd.cut(df["ttr_days"], bins=[-1, 2, 7, 30, 1e9],
                            labels=["<=2d", "2-7d", "7-30d", ">30d"])
        for b, sub in df.groupby(ttr_bucket, observed=True):
            out.append(self._slice(ctx, sub, "H-CAL-3", {"slice": f"ttr={b}"}))
        q = pd.qcut(df["market_score"].rank(method="first"), 4, labels=False, duplicates="drop")
        for b, sub in df.groupby(q, observed=True):
            out.append(self._slice(ctx, sub, "H-CAL-4", {"slice": f"liq_q={int(b)}"}))
        return out

    def _slice(self, ctx, df, hid, extra_metric) -> Verdict:
        n = len(df)
        if n < ctx.min_n:
            return Verdict(hid, self.hclass, n, None, None, None,
                           "full", {**extra_metric}, f"entry_only_{ctx.cost}", "inconclusive",
                           [f"n={n} below floor {ctx.min_n}"], ctx.computed_at)
        p = df["yes_price"].to_numpy(float)
        y = df["outcome_yes"].to_numpy(float)
        brier = float(np.mean((p - y) ** 2))
        edges = np.linspace(0.0, 1.0, ctx.n_bins + 1)
        idx = np.clip(np.digitize(p, edges[1:-1]), 0, ctx.n_bins - 1)
        best = None  # (net, net, bin_dev, bin_n, ci_lo, ci_hi)
        for b in range(ctx.n_bins):
            m = idx == b
            bn = int(m.sum())
            if bn < ctx.min_n:
                continue
            dev = float(y[m].mean() - p[m].mean())  # outcome - price; >0 = underpriced
            net = dev - ctx.cost                      # net LONG edge after entry cost
            if net <= 0:                              # overpriced/short side never passes
                continue
            lo, hi = bootstrap_ci(y[m] - p[m], seed=ctx.seed)
            if lo <= 0:                               # CI must exclude 0 on the positive side
                continue
            if best is None or net > best[1]:
                best = (net, net, dev, bn, lo, hi)
        if best is None:
            return Verdict(hid, self.hclass, n, None, None, None,
                           "full", {"brier": brier, **extra_metric}, f"entry_only_{ctx.cost}",
                           "fail", [], ctx.computed_at)
        _, signed, dev, bn, lo, hi = best
        return Verdict(hid, self.hclass, n, float(signed), float(signed),
                       float((hi - lo) / 2), "full",
                       {"brier": brier, "edged_bin_n": bn, **extra_metric}, f"entry_only_{ctx.cost}",
                       "pass", [], ctx.computed_at)
