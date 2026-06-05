import numpy as np, pandas as pd
from validators.calibration import CalibrationValidator

class Ctx:
    def __init__(self, df):
        self.datasets = {"market_panel_resolved": df}; self.cost = 0.005; self.computed_at = "t"
        self.n_bins = 10; self.min_n = 50; self.seed = 7

def test_emits_one_verdict_per_slice():
    rng = np.random.default_rng(0)
    n = 4000
    df = pd.DataFrame({
        "yes_price": np.full(n, 0.10),
        "outcome_yes": (rng.uniform(size=n) < 0.18).astype(int),
        "market_type": ["event_long"] * (n // 2) + ["event_short"] * (n // 2),
        "ttr_days": [3.0] * (n // 2) + [40.0] * (n // 2),
        "market_score": [0.5] * n,
    })
    verdicts = CalibrationValidator().run(Ctx(df))
    ids = [v.hypothesis_id for v in verdicts]
    assert "H-CAL-1" in ids       # overall
    assert "H-CAL-2" in ids       # by type
    assert "H-CAL-3" in ids       # by TTR bucket
    by_type = [v for v in verdicts if v.hypothesis_id == "H-CAL-2"]
    assert all("slice" in v.class_metric for v in by_type)
