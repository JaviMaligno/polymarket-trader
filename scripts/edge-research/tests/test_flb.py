import numpy as np, pandas as pd
import types
from validators.flb import FLBValidator


def _ctx(df, min_n_flb=30):
    return types.SimpleNamespace(datasets={"flb_shadow_signals": df},
                                 cost=0.005, computed_at="t", seed=7,
                                 min_n_flb=min_n_flb, flb_max_cost=0.01)


def _row(market_type, net_pnl_real, entry_cost_real):
    return {"market_id": "m", "entry_yes_price": 0.05, "market_type": market_type,
            "net_pnl": net_pnl_real, "net_pnl_real": net_pnl_real,
            "entry_cost_real": entry_cost_real, "resolved_at": "t"}


def _frame(rows):
    df = pd.DataFrame(rows)
    df["market_id"] = [f"m{i}" for i in range(len(df))]
    return df


def test_headline_is_tradeable_enterable_and_handles_empty():
    # No tradeable+enterable rows (the real 2026-06-05 situation) → headline inconclusive
    rows = [_row("event_long", -0.013, 0.004) for _ in range(54)]
    v = FLBValidator().run(_ctx(_frame(rows)))
    headline = v[0]
    assert headline.hypothesis_id == "H-INE-1"
    assert headline.class_metric["slice"].startswith("tradeable/enterable")
    assert headline.status == "inconclusive"     # n=0 below floor
    assert headline.n == 0


def test_negative_enterable_cohort_is_fail():
    rows = [_row("event_long", -0.013, 0.004) for _ in range(54)]
    v = FLBValidator().run(_ctx(_frame(rows)))
    el = [x for x in v if x.class_metric.get("slice", "").startswith("event_long/enterable")][0]
    assert el.n == 54
    assert el.status == "fail"
    assert el.edge_net_pct < 0


def test_positive_significant_enterable_cohort_passes():
    rng = np.random.default_rng(1)
    rows = [_row("crypto_daily", float(0.03 + rng.normal(0, 0.005)), 0.004) for _ in range(60)]
    v = FLBValidator().run(_ctx(_frame(rows)))
    headline = v[0]
    assert headline.status == "pass"
    assert headline.edge_net_pct > 0


def test_high_cost_rows_excluded_from_enterable():
    rows = [_row("crypto_daily", 0.05, 0.06) for _ in range(40)]   # cost 6% > 1%
    v = FLBValidator().run(_ctx(_frame(rows)))
    headline = v[0]
    assert headline.n == 0                # none enterable
    assert headline.status == "inconclusive"
