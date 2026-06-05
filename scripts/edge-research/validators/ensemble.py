from __future__ import annotations
import numpy as np
from verdict import Verdict
from validators.base import bootstrap_ci


def _dedup_collinear(signals: dict, thresh: float = 0.9) -> dict:
    """Drop near-collinear signals (|corr| > thresh): two hypotheses exploiting
    the same inefficiency must not count as independent diversification."""
    names = list(signals)
    keep, kept_arrays = [], []
    for nm in names:
        a = np.asarray(signals[nm], float)
        if any(abs(np.corrcoef(a, k)[0, 1]) > thresh for k in kept_arrays):
            continue
        keep.append(nm); kept_arrays.append(a)
    return {nm: signals[nm] for nm in keep}


def _edge(sig_ho, outcome_ho, price_ho, cost):
    """Trade the (standardized) signal direction, hold to resolution."""
    direction = np.sign(sig_ho)
    realized = direction * (outcome_ho - price_ho) - cost
    return float(realized.mean()) if realized.size else 0.0, realized


def combine_signals(signals: dict, outcome, price, cost: float,
                    train_frac: float, seed: int) -> dict:
    """Equal-weight ensemble of standardized signals over a temporal split.
    Returns ensemble vs best-component holdout edge + the (paired) lift and its
    significance. Collinear components are merged first."""
    outcome = np.asarray(outcome, float); price = np.asarray(price, float)
    signals = _dedup_collinear({k: np.asarray(v, float) for k, v in signals.items()})
    n = len(outcome)
    cut = int(n * train_frac)
    sl_tr, sl_ho = slice(0, cut), slice(cut, n)
    out_ho, pr_ho = outcome[sl_ho], price[sl_ho]

    # standardize each signal on train, apply to holdout
    comp_ho = {}
    for nm, s in signals.items():
        mu, sd = s[sl_tr].mean(), s[sl_tr].std() or 1.0
        comp_ho[nm] = (s[sl_ho] - mu) / sd
    ens_ho = np.mean(np.vstack(list(comp_ho.values())), axis=0)

    ens_edge, ens_real = _edge(ens_ho, out_ho, pr_ho, cost)
    comp_edges = {}
    comp_real = {}
    for nm, s_ho in comp_ho.items():
        e, r = _edge(s_ho, out_ho, pr_ho, cost)
        comp_edges[nm], comp_real[nm] = e, r
    best_nm = max(comp_edges, key=comp_edges.get)
    best_edge = comp_edges[best_nm]
    lift_paired = ens_real - comp_real[best_nm]
    lo, hi = bootstrap_ci(lift_paired, seed=seed)
    return {
        "ensemble_edge": ens_edge, "best_component_edge": best_edge,
        "lift": ens_edge - best_edge, "lift_significant": lo > 0,
        "n": int(out_ho.size), "n_components_used": len(signals),
    }


class EnsembleValidator:
    """Combines the per-market signals of validators that pass standalone.
    Inconclusive when fewer than two pass (nothing to combine). v1 assumes the
    components share a universe (aligned by row); combining across datasets needs
    a market_id join (follow-up)."""

    hypothesis_id = "H-ENS-1"
    hclass = "ensemble"

    def required_inputs(self) -> list[str]:
        return []   # special: fed prior passing components via ctx.passing, not a dataset

    def run(self, ctx) -> list[Verdict]:
        passing = getattr(ctx, "passing", {}) or {}
        floor = getattr(ctx, "ens_min_n", 30)
        if len(passing) < 2:
            return [Verdict(self.hypothesis_id, self.hclass, len(passing), None, None, None,
                            "train_holdout", {}, f"entry_only_{ctx.cost}", "inconclusive",
                            ["fewer than 2 passing components — nothing to combine"],
                            ctx.computed_at)]
        names = list(passing)
        outcome = passing[names[0]][1]
        price = passing[names[0]][2]
        signals = {nm: passing[nm][0] for nm in names}
        r = combine_signals(signals, outcome, price, ctx.cost,
                            getattr(ctx, "ens_train_frac", 0.6), ctx.seed)
        if r["n"] < floor:
            return [Verdict(self.hypothesis_id, self.hclass, r["n"], None, None, None,
                            "train_holdout", r, f"entry_only_{ctx.cost}", "inconclusive",
                            [f"holdout n={r['n']} below floor {floor}"], ctx.computed_at)]
        status = "pass" if (r["ensemble_edge"] > 0 and r["lift"] > 0 and r["lift_significant"]) else "fail"
        return [Verdict(self.hypothesis_id, self.hclass, r["n"],
                        float(r["ensemble_edge"]), float(r["ensemble_edge"]), None,
                        "train_holdout", r, f"entry_only_{ctx.cost}", status, [],
                        ctx.computed_at)]
