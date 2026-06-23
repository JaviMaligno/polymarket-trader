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
    # The CSV path produces the DB-path tokens plus the CSV-only mm_trade_spreads
    # token (None here, since no mm_trade_spreads.csv was written).
    assert set(out) == {"market_panel_resolved", "market_panel_full",
                        "flb_shadow_signals", "mm_trade_spreads", "mm_fine_fills",
                        "mm_gaps", "mm_shadow_fills", "mm_live_fills",
                        "conditional_events"}
    assert out["mm_trade_spreads"] is None
    assert out["mm_fine_fills"] is None
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


def test_load_from_dir_reads_mm_trade_spreads(tmp_path):
    pd.DataFrame({
        "market_id": ["a", "b"],
        "market_type": ["crypto_intraday", "event_long"],
        "token_id": ["t1", "t2"],
        "time": ["2026-06-04T10:00:00Z", "2026-06-04T10:05:00Z"],
        "size": [100.0, 50.0],
        "eff_half": [0.012, 0.020],
        "real_half": [0.004, -0.001],
        "impact_half": [0.008, 0.021],
    }).to_csv(tmp_path / "mm_trade_spreads.csv", index=False)
    out = load_all_datasets_from_dir(str(tmp_path))
    mm = out["mm_trade_spreads"]
    assert mm is not None
    assert len(mm) == 2
    assert set(["market_type", "real_half", "eff_half", "impact_half", "size"]).issubset(mm.columns)
    assert abs(float(mm.iloc[0]["real_half"]) - 0.004) < 1e-9


def test_load_from_dir_mm_fine_fills_mixed_timestamp_formats(tmp_path):
    # Regression: Postgres COPY drops the fractional part when a timestamp's
    # microseconds are 0, so the `time` column mixes "…:40.956+00" and "…:03+00".
    # The loader must parse both (format='ISO8601'); inferring one format from
    # row 0 threw on the first whole-second row and silently mapped the dataset to
    # None — which blocked H-MM-3 on a non-empty export forever.
    pd.DataFrame({
        "market_id": ["0xabc", "0xabc"],
        "market_type": ["event_financial", "event_financial"],
        "token_id": ["t1", "t1"],
        "time": ["2026-06-08 09:49:40.956+00", "2026-06-08 14:23:03+00"],
        "size": [838.0, 100.0], "price": [0.12, 0.50],
        "best_bid": [0.10, 0.49], "best_ask": [0.12, 0.51],
        "mid_before": [0.11, 0.50], "mid_10s": [0.115, 0.50],
        "mid_60s": [0.115, 0.50], "mid_300s": [0.12, 0.50],
        "maker_price": [0.10, 0.51], "maker_sign": [-1, 1],
        "best_bid_size": [500.0, 250.0],
        "best_ask_size": [400.0, 300.0],
    }).to_csv(tmp_path / "mm_fine_fills.csv", index=False)
    out = load_all_datasets_from_dir(str(tmp_path))
    assert out["mm_fine_fills"] is not None
    assert len(out["mm_fine_fills"]) == 2
    assert {"best_bid_size", "best_ask_size"}.issubset(out["mm_fine_fills"].columns)


def test_load_from_dir_mm_missing_maps_to_none(tmp_path):
    pd.DataFrame({
        "market_id": ["m1"], "snapshot_at": ["2026-05-19"], "end_date": ["2026-05-29"],
        "yes_price": [0.10], "market_type": ["event_long"], "market_score": [0.5],
        "outcome_yes": [1],
    }).to_csv(tmp_path / "market_panel.csv", index=False)
    out = load_all_datasets_from_dir(str(tmp_path))
    assert out["mm_trade_spreads"] is None
    assert out["market_panel_resolved"] is not None


def test_load_from_dir_mm_gaps(tmp_path):
    pd.DataFrame({
        "gap_start": ["2026-06-10 12:00:00.5+00", "2026-06-10 13:00:00+00"],
        "gap_end": ["2026-06-10 12:00:02+00", "2026-06-10 13:00:01.25+00"],
    }).to_csv(tmp_path / "mm_gaps.csv", index=False)
    out = load_all_datasets_from_dir(str(tmp_path))
    assert out["mm_gaps"] is not None
    assert len(out["mm_gaps"]) == 2
    assert str(out["mm_gaps"]["gap_start"].dtype).startswith("datetime64")


def test_load_from_dir_mm_gaps_missing_maps_to_none(tmp_path):
    out = load_all_datasets_from_dir(str(tmp_path))
    assert out["mm_gaps"] is None


import pathlib

def test_conditional_events_loaded_from_dir(tmp_path):
    pd.DataFrame({
        "pair_id": ["p0", "p1"],
        "relation": ["implies_yes", "implies_no"],
        "market_type_b": ["event_short", "event_financial"],
        "t_a": ["2026-01-01T00:00:00+00", "2026-01-02T00:00:00+00"],
        "outcome_a": [1, 1],
        "entry_offset": ["1h", "1d"],
        "b_entry_price": [0.60, 0.30],
        "b_implied_value": [1, 0],
        "b_outcome": [1, 0],
        "b_resolved_at": ["2026-01-08T00:00:00+00", "2026-01-09T00:00:00+00"],
        "hold_days": [7.0, 7.0],
    }).to_csv(tmp_path / "conditional_events.csv", index=False)
    out = load_all_datasets_from_dir(str(tmp_path))
    df = out["conditional_events"]
    assert df is not None and len(df) == 2
    assert str(df["t_a"].dt.tz) == "UTC"

def test_conditional_events_missing_maps_to_none(tmp_path):
    out = load_all_datasets_from_dir(str(tmp_path))
    assert out["conditional_events"] is None
