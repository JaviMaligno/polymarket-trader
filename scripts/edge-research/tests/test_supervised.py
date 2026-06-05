import numpy as np, pandas as pd, types
from validators.supervised import SupervisedValidator


def _ctx(df, min_n=30, cost=0.005):
    return types.SimpleNamespace(datasets={"market_panel_resolved": df},
                                 cost=cost, computed_at="t", seed=7,
                                 sup_min_n=min_n, sup_train_frac=0.6)


def _frame(prices, outcomes, types_, scores=None, ttr=None):
    n = len(prices)
    return pd.DataFrame({
        "market_id": [f"m{i}" for i in range(n)],
        "yes_price": prices, "outcome_yes": outcomes,
        "market_type": types_,
        "ttr_days": ttr if ttr is not None else [10.0] * n,
        "market_score": scores if scores is not None else [0.5] * n,
        "snapshot_at": pd.date_range("2026-05-01", periods=n, freq="h"),
    })


def test_model_beats_price_when_a_feature_predicts_outcome():
    # type A → always YES, type B → always NO, but price is 0.5 for everyone.
    # The model learns type→outcome; the gap (model_prob − price) is tradeable.
    n = 600
    types_ = (["A"] * (n // 2)) + (["B"] * (n // 2))
    outcomes = ([1] * (n // 2)) + ([0] * (n // 2))
    # interleave so the temporal split has both classes in train and holdout
    order = np.argsort(np.random.default_rng(0).permutation(n))
    df = _frame([0.5] * n, outcomes, types_).iloc[order].reset_index(drop=True)
    df["snapshot_at"] = pd.date_range("2026-05-01", periods=n, freq="h")
    v = SupervisedValidator().run(_ctx(df))[0]
    assert v.status == "pass"
    assert v.edge_net_pct is not None and v.edge_net_pct > 0


def test_well_calibrated_price_gives_no_tradeable_gap():
    # price == true prob, the model can't beat it → no positive OOS edge.
    rng = np.random.default_rng(1)
    n = 800
    prices = rng.uniform(0.1, 0.9, n)
    outcomes = (rng.uniform(size=n) < prices).astype(int)
    df = _frame(prices, outcomes, ["A"] * n)
    v = SupervisedValidator().run(_ctx(df))[0]
    assert v.status in ("fail", "inconclusive")


def test_below_floor_is_inconclusive():
    df = _frame([0.5] * 20, [1, 0] * 10, ["A"] * 20)
    v = SupervisedValidator().run(_ctx(df, min_n=30))[0]
    assert v.status == "inconclusive"


def test_determinism():
    n = 600
    types_ = (["A"] * (n // 2)) + (["B"] * (n // 2))
    outcomes = ([1] * (n // 2)) + ([0] * (n // 2))
    df = _frame([0.5] * n, outcomes, types_)
    a = SupervisedValidator().run(_ctx(df))[0]
    b = SupervisedValidator().run(_ctx(df))[0]
    assert a == b
