import subprocess, sys, pathlib
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
    # H-INE-5 (time-decay extreme band) now has a validator → it emits a verdict
    assert any(v.hypothesis_id == "H-INE-5" for v in r1["verdicts"])
    # H-MM-1 needs mm_trade_spreads → blocked when only the panel is available
    assert any(b["id"] == "H-MM-1" for b in r1["blocked"])

def test_run_reports_pending_for_runnable_hypothesis_without_validator():
    # H-INE-2 needs market_panel_resolved + price_history_resolved (both supplied)
    # but has no validator yet → it must be reported as pending, never dropped.
    datasets = {"market_panel_resolved": _panel(),
                "price_history_resolved": _panel()}
    res = run_validators(datasets, computed_at="t")
    assert any(p["id"] == "H-INE-2" for p in res["pending"])

def test_run_dispatches_mm_when_trade_spreads_available():
    mm = pd.DataFrame({
        "market_id": [f"m{i}" for i in range(300)],
        "market_type": ["crypto_intraday"] * 300,
        "token_id": ["tk"] * 300,
        "time": ["2026-06-04T10:00:00Z"] * 300,
        "size": [100.0] * 300,
        "eff_half": [0.012] * 300,
        "real_half": [0.004] * 300,
        "impact_half": [0.008] * 300,
    })
    res = run_validators({"mm_trade_spreads": mm}, computed_at="t")
    assert any(v.hypothesis_id == "H-MM-1" for v in res["verdicts"])
    assert not any(b["id"] == "H-MM-1" for b in res["blocked"])

def test_main_datasets_dir_mode_writes_scoreboard(tmp_path):
    # Offline CSV mode end-to-end: a tiny market_panel.csv drives run.py without
    # a DB, and a scoreboard is produced.
    pd.DataFrame({
        "market_id": [f"m{i}" for i in range(300)],
        "snapshot_at": ["2026-05-19"] * 300,
        "end_date": ["2026-05-22"] * 300,
        "yes_price": [0.10] * 300,
        "market_type": ["event_short"] * 300,
        "market_score": [0.5] * 300,
        "outcome_yes": ([0] * 294) + ([1] * 6),   # 2% YES → longshot SHORT edge
    }).to_csv(tmp_path / "market_panel.csv", index=False)
    root = pathlib.Path(__file__).resolve().parents[1]
    res = subprocess.run(
        [sys.executable, str(root / "run.py"), "--datasets-dir", str(tmp_path),
         "--out", str(tmp_path / "out"), "--computed-at", "t"],
        capture_output=True, text=True, cwd=str(root))
    assert res.returncode == 0, res.stderr
    assert (tmp_path / "out" / "scoreboard.md").exists()
    assert "H-INE-5" in (tmp_path / "out" / "scoreboard.md").read_text()

def test_h_ine_4_runs_when_conditional_events_present():
    df = pd.DataFrame({
        "pair_id": [f"p{i}" for i in range(5)],
        "relation": ["implies_yes"] * 5, "market_type_b": ["event_short"] * 5,
        "t_a": pd.to_datetime(["2026-01-01"] * 5, utc=True), "outcome_a": [1] * 5,
        "entry_offset": ["1h"] * 5, "b_entry_price": [0.6] * 5,
        "b_implied_value": [1] * 5, "b_outcome": [1] * 5,
        "b_resolved_at": pd.to_datetime(["2026-01-08"] * 5, utc=True),
        "hold_days": [7.0] * 5,
    })
    res = run_validators({"conditional_events": df}, "t")
    ids = {v.hypothesis_id for v in res["verdicts"]}
    assert "H-INE-4" in ids
