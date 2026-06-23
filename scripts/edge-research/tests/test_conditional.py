import numpy as np, pandas as pd, types
from validators.conditional import ConditionalValidator


def _ctx(df, min_n=3, cond_cost=0.0054):
    return types.SimpleNamespace(datasets={"conditional_events": df},
                                 cost=0.005, computed_at="t", seed=7,
                                 min_n=min_n, cond_cost=cond_cost)


def _ev(relation, b_entry_price, b_implied_value, b_outcome,
        market_type_b="event_short", entry_offset="1h"):
    return {"pair_id": "p", "relation": relation, "market_type_b": market_type_b,
            "t_a": pd.Timestamp("2026-01-01", tz="UTC"), "outcome_a": 1,
            "entry_offset": entry_offset, "b_entry_price": b_entry_price,
            "b_implied_value": b_implied_value, "b_outcome": b_outcome,
            "b_resolved_at": pd.Timestamp("2026-01-08", tz="UTC"), "hold_days": 7.0}


def _frame(rows):
    df = pd.DataFrame(rows)
    df["pair_id"] = [f"p{i}" for i in range(len(df))]
    return df


def test_headline_long_stale_b_is_profitable_and_passes():
    rows = [_ev("implies_yes", 0.60, 1, 1) for _ in range(50)]
    v = ConditionalValidator().run(_ctx(_frame(rows)))
    headline = [x for x in v if x.class_metric["slice"] == "headline"][0]
    assert headline.hypothesis_id == "H-INE-4"
    assert headline.n == 50
    assert headline.edge_insample_pct > 0.39 and headline.edge_insample_pct < 0.41
    assert headline.edge_net_pct > 0
    assert headline.status == "pass"


def test_short_direction_uses_correct_sign():
    rows = [_ev("implies_no", 0.30, 0, 0) for _ in range(50)]
    v = ConditionalValidator().run(_ctx(_frame(rows)))
    headline = [x for x in v if x.class_metric["slice"] == "headline"][0]
    assert abs(headline.edge_insample_pct - 0.30) < 1e-6
    assert headline.status == "pass"


def test_efficient_b_no_staleness_fails_on_cost():
    rows = [_ev("implies_yes", 1.0, 1, 1) for _ in range(50)]
    v = ConditionalValidator().run(_ctx(_frame(rows)))
    headline = [x for x in v if x.class_metric["slice"] == "headline"][0]
    assert headline.edge_net_pct < 0
    assert headline.status == "fail"


def test_below_floor_is_inconclusive():
    rows = [_ev("implies_yes", 0.60, 1, 1) for _ in range(2)]
    v = ConditionalValidator().run(_ctx(_frame(rows), min_n=200))
    headline = [x for x in v if x.class_metric["slice"] == "headline"][0]
    assert headline.status == "inconclusive"
    assert headline.n == 2
