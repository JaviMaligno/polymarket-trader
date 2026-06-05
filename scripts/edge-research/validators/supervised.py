from __future__ import annotations
import numpy as np
from verdict import Verdict
from validators.base import bootstrap_ci


def _design_matrix(df, types_index):
    num = df[["yes_price", "ttr_days", "market_score"]].to_numpy(float)
    oh = np.zeros((len(df), len(types_index)))
    mt = df["market_type"].to_numpy()
    for j, t in enumerate(types_index):
        oh[:, j] = (mt == t).astype(float)
    return np.hstack([num, oh])


def _fit_logistic(X, y, iters=1000, lr=0.5):
    w = np.zeros(X.shape[1])
    n = len(y)
    for _ in range(iters):
        p = 1.0 / (1.0 + np.exp(-(X @ w)))
        w -= lr * (X.T @ (p - y) / n)
    return w


class SupervisedValidator:
    """Logistic model on panel features → outcome_yes; trade the gap
    (model_prob − price), hold to resolution (entry-only cost). Temporal
    train/holdout split (earlier snapshots train, later holdout) so the edge is
    out-of-sample. `pass` only on a positive, significant holdout edge."""

    hypothesis_id = "H-SUP-1"
    hclass = "supervised"

    def required_inputs(self) -> list[str]:
        return ["market_panel_resolved"]

    def run(self, ctx) -> list[Verdict]:
        df = ctx.datasets["market_panel_resolved"].sort_values("snapshot_at").reset_index(drop=True)
        n = len(df)
        floor = getattr(ctx, "sup_min_n", 30)
        train_frac = getattr(ctx, "sup_train_frac", 0.6)
        if n < 2 * floor:
            return [self._inconclusive(ctx, n, f"n={n} below 2*floor {2*floor}")]

        cut = int(n * train_frac)
        train, hold = df.iloc[:cut], df.iloc[cut:]
        types_index = sorted(df["market_type"].unique())
        Xtr, Xho = _design_matrix(train, types_index), _design_matrix(hold, types_index)
        mean, std = Xtr.mean(axis=0), Xtr.std(axis=0)
        std[std == 0] = 1.0
        Xtr_s = np.hstack([(Xtr - mean) / std, np.ones((len(train), 1))])
        Xho_s = np.hstack([(Xho - mean) / std, np.ones((len(hold), 1))])
        w = _fit_logistic(Xtr_s, train["outcome_yes"].to_numpy(float))

        edge_ho, n_ho, ret_ho = self._trade(Xho_s, w, hold, ctx.cost)
        edge_tr, _, _ = self._trade(Xtr_s, w, train, ctx.cost)
        if n_ho < floor:
            return [self._inconclusive(ctx, n, f"holdout trades n={n_ho} below floor {floor}")]
        lo, hi = bootstrap_ci(ret_ho, seed=ctx.seed)
        status = "pass" if (edge_ho > 0 and lo > 0) else "fail"
        return [Verdict(self.hypothesis_id, self.hclass, n_ho, float(edge_ho), float(edge_tr),
                        float((hi - lo) / 2), "train_holdout",
                        {"n_train_trades": int((train.shape[0]))}, f"entry_only_{ctx.cost}",
                        status, [], ctx.computed_at)]

    def _trade(self, X, w, sub, cost):
        prob = 1.0 / (1.0 + np.exp(-(X @ w)))
        price = sub["yes_price"].to_numpy(float)
        outcome = sub["outcome_yes"].to_numpy(float)
        gap = prob - price
        direction = np.where(gap > cost, 1.0, np.where(gap < -cost, -1.0, 0.0))
        traded = direction != 0
        realized = (direction * (outcome - price) - cost)[traded]   # hold-to-resolution, entry-only
        edge = float(realized.mean()) if realized.size else 0.0
        return edge, int(traded.sum()), realized

    def _inconclusive(self, ctx, n, msg):
        return Verdict(self.hypothesis_id, self.hclass, n, None, None, None,
                       "train_holdout", {}, f"entry_only_{ctx.cost}", "inconclusive",
                       [msg], ctx.computed_at)
