import numpy as np, types
from validators.ensemble import combine_signals, EnsembleValidator


def _ctx(passing):
    return types.SimpleNamespace(passing=passing, cost=0.005, computed_at="t",
                                 seed=7, ens_min_n=30, ens_train_frac=0.6)


def test_ensemble_beats_best_component_when_signals_are_complementary():
    rng = np.random.default_rng(0)
    n = 1000
    outcome = (rng.uniform(size=n) < 0.5).astype(float)
    price = np.full(n, 0.5)
    # two noisy-but-real signals; each weakly predicts outcome, averaging is stronger
    s1 = (outcome - 0.5) + rng.normal(0, 1.0, n)
    s2 = (outcome - 0.5) + rng.normal(0, 1.0, n)
    res = combine_signals({"s1": s1, "s2": s2}, outcome, price, cost=0.0,
                          train_frac=0.6, seed=7)
    assert res["ensemble_edge"] >= res["best_component_edge"] - 1e-9
    assert res["n"] > 0


def test_collinear_components_are_merged():
    rng = np.random.default_rng(1)
    n = 600
    outcome = (rng.uniform(size=n) < 0.5).astype(float)
    price = np.full(n, 0.5)
    s1 = (outcome - 0.5) + rng.normal(0, 1.0, n)
    s2 = s1 * 1.0001            # near-identical → correlation ~1
    res = combine_signals({"s1": s1, "s2": s2}, outcome, price, cost=0.0,
                          train_frac=0.6, seed=7)
    assert res["n_components_used"] == 1   # collinear pair collapsed to one


def test_validator_inconclusive_with_fewer_than_two_passing():
    v = EnsembleValidator().run(_ctx(passing={}))[0]
    assert v.status == "inconclusive"
    assert "nothing to combine" in " ".join(v.n_caveats).lower()


def test_validator_runs_with_two_passing_components():
    rng = np.random.default_rng(2)
    n = 800
    outcome = (rng.uniform(size=n) < 0.5).astype(float)
    price = np.full(n, 0.5)
    s1 = (outcome - 0.5) + rng.normal(0, 1.0, n)
    s2 = (outcome - 0.5) + rng.normal(0, 1.0, n)
    passing = {"s1": (s1, outcome, price), "s2": (s2, outcome, price)}
    v = EnsembleValidator().run(_ctx(passing))[0]
    assert v.status in ("pass", "fail")          # ran the combination
    assert v.hypothesis_id == "H-ENS-1"
