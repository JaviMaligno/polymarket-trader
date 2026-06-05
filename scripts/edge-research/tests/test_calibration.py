import numpy as np, pandas as pd
from validators.calibration import CalibrationValidator

def _frame(prices, outcomes):
    n = len(prices)
    return pd.DataFrame({
        "yes_price": prices, "outcome_yes": outcomes,
        "market_type": ["event_long"] * n, "ttr_days": [10.0] * n,
        "market_score": [0.5] * n,
    })

class Ctx:
    def __init__(self, df, cost=0.005, ts="2026-06-05T00:00:00Z"):
        self.datasets = {"market_panel_resolved": df}; self.cost = cost; self.computed_at = ts
        self.n_bins = 10; self.min_n = 50; self.seed = 7

def test_well_calibrated_has_no_edge():  # P2
    rng = np.random.default_rng(0)
    prices = rng.uniform(0.05, 0.95, 4000)
    outcomes = (rng.uniform(size=4000) < prices).astype(int)  # perfectly calibrated
    v = CalibrationValidator().run(Ctx(_frame(prices, outcomes)))[0]
    assert v.status == "fail"
    assert v.class_metric["brier"] > 0

def test_underpriced_longshots_show_edge():  # P1
    rng = np.random.default_rng(1)
    prices = np.full(3000, 0.10)
    outcomes = (rng.uniform(size=3000) < 0.18).astype(int)
    v = CalibrationValidator().run(Ctx(_frame(prices, outcomes)))[0]
    assert v.status == "pass"
    assert v.edge_net_pct is not None and v.edge_net_pct > 0

def test_below_floor_is_inconclusive():  # P3
    v = CalibrationValidator().run(Ctx(_frame([0.1, 0.2], [0, 1])))[0]
    assert v.status == "inconclusive"

def test_deviation_below_cost_is_not_edge():  # P4
    rng = np.random.default_rng(2)
    prices = np.full(3000, 0.10)
    outcomes = (rng.uniform(size=3000) < 0.103).astype(int)  # dev ~0.003 < cost 0.005
    v = CalibrationValidator().run(Ctx(_frame(prices, outcomes), cost=0.005))[0]
    assert v.status == "fail"

def test_determinism():  # P5
    df = _frame(np.full(3000, 0.10), (np.random.default_rng(3).uniform(size=3000) < 0.18).astype(int))
    a = CalibrationValidator().run(Ctx(df))[0]
    b = CalibrationValidator().run(Ctx(df))[0]
    assert a == b

def test_overpriced_favourite_bin_is_not_pass():  # short/anti-edge side must not pass
    rng = np.random.default_rng(9)
    # price 0.90 but true prob ~0.70 → dev ~ -0.20 (overpriced); must be fail, not pass
    v = CalibrationValidator().run(Ctx(_frame(np.full(3000, 0.90),
        (rng.uniform(size=3000) < 0.70).astype(int))))[0]
    assert v.status == "fail"
    assert v.edge_net_pct is None

def test_significance_real_ci_and_insample_equals_net():  # P6 — regression for Fix 1 & Fix 2
    # Clear-edge frame: price 0.10, true prob 0.18, n=3000 → FLB longshot bin passes CI
    rng = np.random.default_rng(42)
    prices = np.full(3000, 0.10)
    outcomes = (rng.uniform(size=3000) < 0.18).astype(int)
    v = CalibrationValidator().run(Ctx(_frame(prices, outcomes)))[0]
    assert v.status == "pass"
    # Fix 1: significance must be a real bootstrap CI half-width, NOT the 1e-9 placeholder
    assert v.significance is not None and v.significance > 0.001
    # Fix 2: edge_insample_pct must equal edge_net_pct (no train/holdout split in calibration)
    assert v.edge_insample_pct == v.edge_net_pct
