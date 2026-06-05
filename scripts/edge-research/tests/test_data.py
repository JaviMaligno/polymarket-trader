import pandas as pd
from data import shape_panel

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
