from __future__ import annotations
import numpy as np
from verdict import Verdict
from validators.base import bootstrap_ci

_CAVEAT = ("shadow live-quoting: cola inicial exacta, drain bounds trades/cancels; "
           "cancels-ahead inobservable (bound optimista); sin órdenes reales")
_HORIZONS = [("10s", "mid_10s"), ("60s", "mid_60s"), ("300s", "mid_300s")]


class MMShadowValidator:
    """H-MM-4 — retained de fills sombra del quoter (cola exacta).

    Sign convention (same as H-MM-3 / mm_fine_fills.sql):
        retained = side * (placement_price − mid_after)
        side -1 = bid (maker bought): profit when mid rises above price
        side +1 = ask (maker sold):  profit when mid falls below price
    """

    hypothesis_id = "H-MM-4"
    hclass = "market_making"

    def required_inputs(self) -> list[str]:
        return ["mm_shadow_fills"]

    def run(self, ctx) -> list[Verdict]:
        df = ctx.datasets["mm_shadow_fills"].copy()
        df["tradeable"] = df["market_type"] != "event_long"

        # Pre-compute retained return per horizon: side * (price - mid_after)
        for hname, hcol in _HORIZONS:
            df[f"ret_{hname}"] = df["side"] * (df["price"] - df[hcol])

        # Build cohort groups: headline + per market_type + per flag (if any rows)
        groups: list[tuple[str, object]] = [("headline:tradeable", df["tradeable"])]
        for mt in sorted(df["market_type"].dropna().unique()):
            groups.append((mt, df["market_type"] == mt))
        for flag in ("exit_improve", "rewards_constrained"):
            m = df["flags"].fillna("").str.contains(flag)
            if m.any():
                groups.append((f"flag:{flag}", m))

        out: list[Verdict] = []
        for label, mask in groups:
            base = df[mask]
            for hname, _ in _HORIZONS:
                for bound in ("trades", "cancels"):
                    sub = base[base["bound"] == bound]
                    cohort = f"{label}:{hname}:{bound}"
                    out.append(self._verdict(ctx, cohort, sub, f"ret_{hname}"))
        return out

    def _verdict(self, ctx, cohort: str, sub, retcol: str) -> Verdict:
        floor = getattr(ctx, "mm_min_n", 200)
        vals = sub[retcol].dropna().to_numpy(float) if len(sub) else np.array([])
        n = int(vals.size)
        if n < floor:
            return Verdict(self.hypothesis_id, self.hclass, n, None, None, None,
                           "full", {"cohort": cohort}, "maker_fee_0", "inconclusive",
                           [_CAVEAT, f"n={n} below floor {floor}"], ctx.computed_at)
        edge = float(vals.mean())
        lo, hi = bootstrap_ci(vals, seed=ctx.seed)
        status = "pass" if (edge > 0 and lo > 0) else "fail"
        return Verdict(self.hypothesis_id, self.hclass, n, edge, edge,
                       float((hi - lo) / 2), "full", {"cohort": cohort}, "maker_fee_0",
                       status, [_CAVEAT], ctx.computed_at)
