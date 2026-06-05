from __future__ import annotations
import numpy as np
from verdict import Verdict
from validators.base import bootstrap_ci


class FLBValidator:
    """Favorite-longshot hold-to-resolution at REAL cost, from flb_shadow_signals.

    net_pnl_real is already the per-signal return net of the real entry half-spread.
    We segment into cohorts — tradeable (market_type != event_long) vs event_long
    (shadow-only) — and an enterable filter (entry_cost_real <= max_cost). The
    headline is the tradeable+enterable cohort: what the executor would actually
    fill. `pass` only on a positive, bootstrap-significant mean with n >= floor.
    """

    hypothesis_id = "H-INE-1"
    hclass = "inefficiency"

    def required_inputs(self) -> list[str]:
        return ["flb_shadow_signals"]

    def run(self, ctx) -> list[Verdict]:
        df = ctx.datasets["flb_shadow_signals"].copy()
        max_cost = getattr(ctx, "flb_max_cost", 0.01)
        df["cohort"] = np.where(df["market_type"] == "event_long", "event_long", "tradeable")
        df["enterable"] = df["entry_cost_real"].astype(float) <= max_cost
        # Headline first (tradeable + enterable), then the other cohorts as context.
        order = [("tradeable", True), ("event_long", True),
                 ("tradeable", False), ("event_long", False)]
        return [self._cohort(ctx, df, coh, ent) for coh, ent in order]

    def _cohort(self, ctx, df, cohort, enterable) -> Verdict:
        floor = getattr(ctx, "min_n_flb", 30)
        sub = df[(df["cohort"] == cohort) & (df["enterable"] == enterable)]
        n = len(sub)
        label = f"{cohort}/{'enterable' if enterable else 'high-cost'}"
        if n < floor:
            return Verdict(self.hypothesis_id, self.hclass, n, None, None, None,
                           "full", {"slice": label}, "real_per_signal", "inconclusive",
                           [f"n={n} below floor {floor}"], ctx.computed_at)
        x = sub["net_pnl_real"].to_numpy(float)
        edge = float(x.mean())
        lo, hi = bootstrap_ci(x, seed=ctx.seed)
        status = "pass" if (edge > 0 and lo > 0) else "fail"
        return Verdict(self.hypothesis_id, self.hclass, n, edge, edge,
                       float((hi - lo) / 2), "full",
                       {"slice": label, "avg_cost": float(sub["entry_cost_real"].mean())},
                       "real_per_signal", status, [], ctx.computed_at)
