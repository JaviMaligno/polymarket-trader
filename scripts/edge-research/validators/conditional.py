from __future__ import annotations
import numpy as np
from verdict import Verdict
from validators.base import bootstrap_ci


class ConditionalValidator:
    """H-INE-4: conditional/dependent market staleness.

    After market A resolves, a logically-dependent market B has a determinate
    implied value (`b_implied_value` in {0,1}). We enter B in the implied direction
    at its first price after `t_a + entry_offset` and hold to resolution. Per-event
    gross return is `(b_outcome - b_entry_price)` when implied YES (long) and
    `(b_entry_price - b_outcome)` when implied NO (short). Net subtracts a flat
    one-way entry cost. `pass` only on a positive, bootstrap-significant NET mean
    with n >= floor. edge_insample_pct = gross mean, edge_net_pct = net mean, so
    the scoreboard shows the friction side by side (as FLB does).
    """

    hypothesis_id = "H-INE-4"
    hclass = "inefficiency"

    def required_inputs(self) -> list[str]:
        return ["conditional_events"]

    def run(self, ctx) -> list[Verdict]:
        df = ctx.datasets["conditional_events"].copy()
        long = df["b_implied_value"].astype(int) == 1
        df["gross"] = np.where(
            long, df["b_outcome"] - df["b_entry_price"],
            df["b_entry_price"] - df["b_outcome"]).astype(float)
        df["staleness"] = (df["b_entry_price"] - df["b_implied_value"]).abs().astype(float)

        cohorts: list[tuple[str, object]] = [("headline", np.ones(len(df), dtype=bool))]
        for rel in sorted(df["relation"].dropna().unique()):
            cohorts.append((f"relation:{rel}", df["relation"] == rel))
        for mt in sorted(df["market_type_b"].dropna().unique()):
            cohorts.append((f"type:{mt}", df["market_type_b"] == mt))
        for off in sorted(df["entry_offset"].dropna().unique()):
            cohorts.append((f"offset:{off}", df["entry_offset"] == off))
        # OOS temporal cohort: later half by t_a (the decision verdict).
        floor = getattr(ctx, "min_n", 200)
        verdicts = [self._verdict(ctx, df[m], label) for label, m in cohorts]
        if len(df) >= 2 * floor:
            ordered = df.sort_values("t_a")
            later = ordered.iloc[len(ordered) // 2:]
            verdicts.append(self._verdict(ctx, later, "oos"))
        else:
            verdicts.append(Verdict(
                self.hypothesis_id, self.hclass, len(df), None, None, None, "full",
                {"slice": "oos"}, "real_one_way", "inconclusive",
                [f"n={len(df)} below 2*floor {2*floor}; cannot split out-of-sample"],
                ctx.computed_at))
        return verdicts

    def _verdict(self, ctx, sub, label) -> Verdict:
        floor = getattr(ctx, "min_n", 200)
        cost = getattr(ctx, "cond_cost", 0.0054)
        n = len(sub)
        if n < floor:
            return Verdict(self.hypothesis_id, self.hclass, n, None, None, None,
                           "full", {"slice": label}, "real_one_way", "inconclusive",
                           [f"n={n} below floor {floor}"], ctx.computed_at)
        gross = sub["gross"].to_numpy(float)
        net = gross - cost
        gmean, nmean = float(gross.mean()), float(net.mean())
        lo, hi = bootstrap_ci(net, seed=ctx.seed)
        status = "pass" if (nmean > 0 and lo > 0) else "fail"
        return Verdict(self.hypothesis_id, self.hclass, n, nmean, gmean,
                       float((hi - lo) / 2), "full",
                       {"slice": label, "staleness": float(sub["staleness"].mean()),
                        "avg_hold_days": float(sub["hold_days"].mean())},
                       "real_one_way", status, [], ctx.computed_at)
