from __future__ import annotations
import numpy as np
from verdict import Verdict
from validators.base import bootstrap_ci

_CAVEAT = ("fine-cadence maker fill-sim, queue-reactive (front/back bounds); exact "
           "queue position unobservable without live orders; excludes inventory + "
           "rewards (H-MM-2)")
_HORIZONS = [("10s", "mid_10s"), ("60s", "mid_60s"), ("300s", "mid_300s")]


class MMFineValidator:
    """H-MM-3 — passive-maker retained spread, queue-reactive fills (front/back)."""

    hypothesis_id = "H-MM-3"
    hclass = "market_making"

    def required_inputs(self) -> list[str]:
        return ["mm_fine_fills"]

    def run(self, ctx) -> list[Verdict]:
        df = ctx.datasets["mm_fine_fills"].copy()
        df["tradeable"] = df["market_type"] != "event_long"
        p75 = df["size"].quantile(0.75) if len(df) else 0.0

        fills = []
        for bound in ("front", "back"):
            for _tok, sub in df.sort_values("time").groupby("token_id", sort=False):
                fills.extend(self._walk(sub, bound))
        fdf = self._to_frame(fills)

        groups = [("headline:tradeable", lambda d: d["tradeable"])]
        for mt in sorted(df["market_type"].dropna().unique()):
            groups.append((mt, (lambda m: (lambda d: d["market_type"] == m))(mt)))

        out: list[Verdict] = []
        for label, mask in groups:
            base = fdf[mask(fdf)] if len(fdf) else fdf
            for hname, hcol in _HORIZONS:
                for size_label in ("all", "large"):
                    sized = base if size_label == "all" else base[base["size"] >= p75]
                    for bound in ("front", "back"):
                        cohort = f"{label}:{hname}:{size_label}:{bound}"
                        sub = sized[sized["bound"] == bound]
                        out.append(self._verdict(ctx, cohort, sub, hcol))
        return out

    def _walk(self, sub, bound) -> list[dict]:
        size_ahead = {-1: None, 1: None}  # -1 bid side, +1 ask side; None = not placed
        out = []
        for r in sub.itertuples(index=False):
            sign = int(r.maker_sign)
            if sign not in (-1, 1):
                continue
            touch = r.best_bid_size if sign == -1 else r.best_ask_size
            if size_ahead[sign] is None:
                size_ahead[sign] = 0.0 if bound == "front" else self._queue(touch)
            tsize = float(r.size) if r.size == r.size else 0.0
            size_ahead[sign] -= tsize
            if size_ahead[sign] <= 0:
                out.append({
                    "market_type": r.market_type, "tradeable": bool(r.tradeable),
                    "size": float(r.size) if r.size == r.size else 0.0, "bound": bound,
                    "ret_10s": self._ret(r, r.mid_10s), "ret_60s": self._ret(r, r.mid_60s),
                    "ret_300s": self._ret(r, r.mid_300s),
                })
                size_ahead[sign] = None
        return out

    @staticmethod
    def _queue(touch) -> float:
        return float(touch) if touch is not None and touch == touch else 0.0

    @staticmethod
    def _ret(r, mid_after):
        if mid_after != mid_after:
            return float("nan")
        return float(r.maker_sign) * (float(r.maker_price) - float(mid_after))

    @staticmethod
    def _to_frame(fills):
        import pandas as pd
        cols = ["market_type", "tradeable", "size", "bound", "ret_10s", "ret_60s", "ret_300s"]
        return pd.DataFrame(fills, columns=cols)

    def _verdict(self, ctx, cohort, sub, hcol) -> Verdict:
        floor = getattr(ctx, "mm_min_n", 200)
        retcol = {"mid_10s": "ret_10s", "mid_60s": "ret_60s", "mid_300s": "ret_300s"}[hcol]
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
