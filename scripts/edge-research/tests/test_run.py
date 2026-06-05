import numpy as np, pandas as pd
from run import run_validators

def _panel():
    rng = np.random.default_rng(0)
    n = 4000
    return pd.DataFrame({
        "market_id": [f"m{i}" for i in range(n)],
        "yes_price": np.full(n, 0.10),
        "outcome_yes": (rng.uniform(size=n) < 0.18).astype(int),
        "market_type": ["event_long"] * n, "ttr_days": [10.0] * n,
        "market_score": [0.5] * n,
        "snapshot_at": pd.date_range("2026-05-01", periods=n, freq="h"),
    })

def test_run_dispatches_calibration_and_is_deterministic():
    datasets = {"market_panel_resolved": _panel()}
    r1 = run_validators(datasets, computed_at="t")
    r2 = run_validators(datasets, computed_at="t")
    assert [v.to_json() for v in r1["verdicts"]] == [v.to_json() for v in r2["verdicts"]]
    assert any(v.hypothesis_id == "H-CAL-1" for v in r1["verdicts"])
    # H-MM-1 needs gamma_rewards → blocked when only the panel is available
    assert any(b["id"] == "H-MM-1" for b in r1["blocked"])

def test_run_reports_pending_for_runnable_hypothesis_without_validator():
    # H-INE-5 needs market_panel_resolved (available) but has no validator yet →
    # it must be reported as pending, never silently dropped.
    datasets = {"market_panel_resolved": _panel()}
    res = run_validators(datasets, computed_at="t")
    assert any(p["id"] == "H-INE-5" for p in res["pending"])
