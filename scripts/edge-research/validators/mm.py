from __future__ import annotations
from verdict import Verdict
from validators.base import bootstrap_ci

_CAVEAT = ("Δ≈10min (coarse); passive-maker proxy, not simulated fills; "
           "excludes queue priority / inventory risk / rewards (H-MM-2)")


class MMSpreadValidator:
    """H-MM-1 — passive market-maker retained spread net of adverse selection.

    From sampled trades joined to the book mid before/after (mm_trade_spreads):
    real_half is the half-spread a maker keeps after the mid moves (≈ revenue per
    share). Per market_type cohort, edge = mean(real_half) − maker_fee; the eff_half
    (gross) and impact_half (adverse selection) decomposition is exposed in
    class_metric. Headline = tradeable types pooled (market_type != event_long).
    `pass` only on a positive, bootstrap-significant mean with n >= floor.
    """

    hypothesis_id = "H-MM-1"
    hclass = "market_making"

    def required_inputs(self) -> list[str]:
        return ["mm_trade_spreads"]

    def run(self, ctx) -> list[Verdict]:
        df = ctx.datasets["mm_trade_spreads"].copy()
        df["tradeable"] = df["market_type"] != "event_long"
        cohorts = [("headline:tradeable", df[df["tradeable"]])]
        for mt in sorted(df["market_type"].unique()):
            cohorts.append((mt, df[df["market_type"] == mt]))
        return [self._cohort(ctx, label, sub) for label, sub in cohorts]

    def _cohort(self, ctx, label, sub) -> Verdict:
        floor = getattr(ctx, "mm_min_n", 200)
        fee = getattr(ctx, "mm_maker_fee", 0.0)
        cost_model = f"maker_fee_{fee}"
        n = len(sub)
        if n < floor:
            return Verdict(self.hypothesis_id, self.hclass, n, None, None, None,
                           "full", {"cohort": label}, cost_model, "inconclusive",
                           [_CAVEAT, f"n={n} below floor {floor}"], ctx.computed_at)
        real = sub["real_half"].to_numpy(float)
        edge = float(real.mean()) - fee
        lo, hi = bootstrap_ci(real - fee, seed=ctx.seed)
        status = "pass" if (edge > 0 and lo > 0) else "fail"
        meta = {"cohort": label,
                "eff_half": float(sub["eff_half"].to_numpy(float).mean()),
                "impact_half": float(sub["impact_half"].to_numpy(float).mean()),
                "avg_size": float(sub["size"].to_numpy(float).mean())}
        return Verdict(self.hypothesis_id, self.hclass, n, edge, edge,
                       float((hi - lo) / 2), "full", meta, cost_model,
                       status, [_CAVEAT], ctx.computed_at)
