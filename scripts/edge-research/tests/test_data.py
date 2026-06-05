import pandas as pd
from data import shape_panel, load_all_datasets_from_dir

def test_shape_panel_takes_earliest_snapshot_and_computes_ttr():
    raw = pd.DataFrame({
        "market_id": ["m1", "m1", "m2"],
        "snapshot_at": pd.to_datetime(["2026-05-19", "2026-05-26", "2026-05-19"], utc=True),
        "end_date": pd.to_datetime(["2026-05-29", "2026-05-29", "2026-06-08"], utc=True),
        "yes_price": [0.10, 0.40, 0.80],
        "market_type": ["event_long", "event_long", "event_short"],
        "market_score": [0.5, 0.5, 0.6],
        "outcome_yes": [1, 1, 0],
    })
    df = shape_panel(raw)
    assert len(df) == 2                       # one row per market (earliest)
    m1 = df[df.market_id == "m1"].iloc[0]
    assert m1.yes_price == 0.10               # earliest snapshot kept
    assert abs(m1.ttr_days - 10.0) < 1e-6     # 05-29 minus 05-19
    assert set(["yes_price","outcome_yes","market_type","ttr_days","market_score"]).issubset(df.columns)


# --- CSV / --datasets-dir mode (offline runner, no DB) ---

def _write_csvs(d):
    # Raw market_panel rows (mirror of RESOLVED_SQL output) — two markets, m1
    # with two snapshots so the earliest-snapshot shaping is exercised.
    pd.DataFrame({
        "market_id": ["m1", "m1", "m2"],
        "snapshot_at": ["2026-05-19", "2026-05-26", "2026-05-19"],
        "end_date": ["2026-05-29", "2026-05-29", "2026-06-08"],
        "yes_price": [0.10, 0.40, 0.80],
        "market_type": ["event_long", "event_long", "event_short"],
        "market_score": [0.5, 0.5, 0.6],
        "outcome_yes": [1, 1, 0],
    }).to_csv(d / "market_panel.csv", index=False)
    pd.DataFrame({
        "market_id": ["a", "b"],
        "entry_yes_price": [0.05, 0.07],
        "market_type": ["event_long", "crypto_daily"],
        "net_pnl": [0.02, -0.01],
        "net_pnl_real": [0.015, -0.02],
        "entry_cost_real": [0.004, 0.012],
        "resolved_at": ["2026-05-20", "2026-05-21"],
    }).to_csv(d / "flb_shadow_signals.csv", index=False)


def test_load_from_dir_matches_db_shaping(tmp_path):
    _write_csvs(tmp_path)
    out = load_all_datasets_from_dir(str(tmp_path))
    # Same three tokens the DB path produces.
    assert set(out) == {"market_panel_resolved", "market_panel_full", "flb_shadow_signals"}
    res = out["market_panel_resolved"]
    assert len(res) == 2                                  # one row per market (earliest)
    m1 = res[res.market_id == "m1"].iloc[0]
    assert m1.yes_price == 0.10                           # earliest snapshot kept
    assert abs(m1.ttr_days - 10.0) < 1e-6                 # dates parsed → TTR computed
    assert out["market_panel_full"].shape[0] == 3        # all snapshots retained
    flb = out["flb_shadow_signals"]
    assert len(flb) == 2
    assert "net_pnl_real" in flb.columns


def test_load_from_dir_missing_file_maps_to_none(tmp_path):
    # Only the flb file present → market_panel tokens are None, flb still loads.
    pd.DataFrame({
        "market_id": ["a"], "entry_yes_price": [0.05], "market_type": ["event_long"],
        "net_pnl": [0.02], "net_pnl_real": [0.015], "entry_cost_real": [0.004],
        "resolved_at": ["2026-05-20"],
    }).to_csv(tmp_path / "flb_shadow_signals.csv", index=False)
    out = load_all_datasets_from_dir(str(tmp_path))
    assert out["market_panel_resolved"] is None
    assert out["market_panel_full"] is None
    assert out["flb_shadow_signals"] is not None
