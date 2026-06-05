from __future__ import annotations
import numpy as np
from verdict import Verdict
from validators.base import bootstrap_ci


class TimeDecayExtremeBandValidator:
    """H-INE-5 — time-decay extreme-band mispricing on the resolved panel.

    Near expiry (ttr_days <= cap), do the extreme price bands drift to
    resolution enough to beat cost? Two cohorts, each with a FIXED structural
    direction from the favorite-longshot prior (so the direction is a hypothesis,
    not fit to the data):
      - longshot (yes_price <= band): SHORT YES (-1) — longshots are overpriced,
        bet they resolve NO.
      - favorite (yes_price >= 1-band): LONG YES (+1) — favorites are underpriced.
    Per-market entry-only return: direction*(outcome - price) - cost, held to
    resolution. `pass` only on a positive, bootstrap-significant mean.

    Cost is FLAT (ctx.cost): the panel has no per-market spread. The real-cost
    answer for the longshot side lives in H-INE-1 (FLB), which refuted it; this
    flat-cost verdict is observability, not a promotion signal — carried as a
    caveat on the longshot cohort.
    """

    hypothesis_id = "H-INE-5"
    hclass = "inefficiency"

    def required_inputs(self) -> list[str]:
        return ["market_panel_resolved"]

    def run(self, ctx) -> list[Verdict]:
        df = ctx.datasets["market_panel_resolved"]
        band = getattr(ctx, "ine5_band", 0.10)
        ttr_max = getattr(ctx, "ine5_ttr_max_days", 7.0)
        near = df[df["ttr_days"] <= ttr_max]
        return [
            self._cohort(ctx, near[near["yes_price"] <= band], "longshot", -1,
                         ["flat cost; real-cost refuted for this side by H-INE-1 (FLB)"]),
            self._cohort(ctx, near[near["yes_price"] >= 1.0 - band], "favorite", 1, []),
        ]

    def _cohort(self, ctx, sub, label, direction, caveats) -> Verdict:
        floor = getattr(ctx, "ine5_min_n", 50)
        n = len(sub)
        meta = {"band": label, "direction": direction,
                "ttr_max_days": getattr(ctx, "ine5_ttr_max_days", 7.0)}
        cost_model = f"entry_only_{ctx.cost}"
        if n < floor:
            return Verdict(self.hypothesis_id, self.hclass, n, None, None, None,
                           "full", meta, cost_model, "inconclusive",
                           caveats + [f"n={n} below floor {floor}"], ctx.computed_at)
        price = sub["yes_price"].to_numpy(float)
        outcome = sub["outcome_yes"].to_numpy(float)
        r = direction * (outcome - price) - ctx.cost
        edge = float(r.mean())
        lo, hi = bootstrap_ci(r, seed=ctx.seed)
        status = "pass" if (edge > 0 and lo > 0) else "fail"
        meta["avg_price"] = float(price.mean())
        return Verdict(self.hypothesis_id, self.hclass, n, edge, edge,
                       float((hi - lo) / 2), "full", meta, cost_model,
                       status, caveats, ctx.computed_at)
