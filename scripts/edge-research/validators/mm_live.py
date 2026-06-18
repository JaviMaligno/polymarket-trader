from __future__ import annotations
import numpy as np
from verdict import Verdict
from validators.base import bootstrap_ci

_CAVEAT = ("live maker fill — cola exacta (sin drain bounds); excluye rewards (H-MM-2); "
           "n pequeño en piloto")
_HORIZONS = [("10s", "mid_10s"), ("60s", "mid_60s"), ("300s", "mid_300s")]


class MMLiveValidator:
    """H-MM-5 — live maker retained spread con cola exacta (fills reales)."""

    hypothesis_id = "H-MM-5"
    hclass = "market_making"

    def required_inputs(self):
        return ["mm_live_fills"]

    def run(self, ctx):
        df = ctx.datasets["mm_live_fills"].copy()
        df["tradeable"] = df["market_type"] != "event_long"
        groups = [("headline:tradeable", lambda d: d["tradeable"])]
        for mt in sorted(df["market_type"].dropna().unique()):
            groups.append((mt, (lambda m: (lambda d: d["market_type"] == m))(mt)))
        out = []
        for label, mask in groups:
            base = df[mask(df)] if len(df) else df
            for hname, hcol in _HORIZONS:
                cohort = f"{label}:{hname}"
                sub = base[base[hcol].notna()] if len(base) else base
                # retained = side_sign * (fill_price - mid_after); side -1 bid, +1 ask
                vals = (sub["side"] * (sub["fill_price"] - sub[hcol])).to_numpy(float) if len(sub) else np.array([])
                out.append(self._verdict(ctx, cohort, vals))
        return out

    def _verdict(self, ctx, cohort, vals):
        floor = getattr(ctx, "min_n", 200)
        n = int(vals.size)
        if n < floor:
            return Verdict(self.hypothesis_id, self.hclass, n, None, None, None, "full",
                           {"cohort": cohort}, "maker_fee_0", "inconclusive",
                           [_CAVEAT, f"n={n} below floor {floor}"], ctx.computed_at)
        edge = float(vals.mean())
        lo, hi = bootstrap_ci(vals, seed=ctx.seed)
        status = "pass" if (edge > 0 and lo > 0) else "fail"
        return Verdict(self.hypothesis_id, self.hclass, n, edge, edge, float((hi - lo) / 2),
                       "full", {"cohort": cohort}, "maker_fee_0", status, [_CAVEAT], ctx.computed_at)
