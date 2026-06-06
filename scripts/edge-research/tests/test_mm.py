import numpy as np, pandas as pd, types
from validators.mm import MMSpreadValidator


def _ctx(df, mm_min_n=200, mm_maker_fee=0.0):
    return types.SimpleNamespace(datasets={"mm_trade_spreads": df},
                                 cost=0.005, computed_at="t", seed=7,
                                 mm_min_n=mm_min_n, mm_maker_fee=mm_maker_fee)


def _rows(n, market_type, real_half, eff_half, seed):
    rng = np.random.default_rng(seed)
    return pd.DataFrame({
        "market_id": [f"m{seed}_{i}" for i in range(n)],
        "market_type": [market_type] * n,
        "token_id": [f"tk{seed}"] * n,
        "time": ["2026-06-04T10:00:00Z"] * n,
        "size": np.full(n, 100.0),
        "eff_half": np.full(n, eff_half),
        "real_half": real_half + rng.normal(0, 0.001, n),
        "impact_half": np.full(n, eff_half) - real_half,
    })


def _cohort(verdicts, name):
    return [v for v in verdicts if v.class_metric.get("cohort") == name][0]


def test_positive_retained_spread_passes_and_exposes_decomposition():
    df = _rows(300, "crypto_intraday", real_half=0.004, eff_half=0.012, seed=1)
    v = MMSpreadValidator().run(_ctx(df))
    head = _cohort(v, "headline:tradeable")
    assert head.hypothesis_id == "H-MM-1"
    assert head.hclass == "market_making"
    assert head.status == "pass"
    assert head.edge_net_pct > 0
    assert abs(head.class_metric["eff_half"] - 0.012) < 1e-3
    assert abs(head.class_metric["impact_half"] - 0.008) < 1e-3


def test_adverse_selection_eats_spread_fails():
    df = _rows(300, "crypto_intraday", real_half=-0.002, eff_half=0.010, seed=2)
    v = MMSpreadValidator().run(_ctx(df))
    head = _cohort(v, "headline:tradeable")
    assert head.status == "fail"
    assert head.edge_net_pct < 0


def test_below_floor_inconclusive():
    df = _rows(50, "crypto_intraday", real_half=0.004, eff_half=0.012, seed=3)
    v = MMSpreadValidator().run(_ctx(df))
    head = _cohort(v, "headline:tradeable")
    assert head.status == "inconclusive"
    assert head.n == 50


def test_event_long_emitted_as_own_cohort_not_in_headline():
    df = pd.concat([
        _rows(300, "crypto_intraday", real_half=0.004, eff_half=0.012, seed=4),
        _rows(300, "event_long", real_half=0.004, eff_half=0.012, seed=5),
    ], ignore_index=True)
    v = MMSpreadValidator().run(_ctx(df))
    head = _cohort(v, "headline:tradeable")
    el = _cohort(v, "event_long")
    assert head.n == 300
    assert el.n == 300
    assert el.class_metric["cohort"] == "event_long"


def test_caveats_present_on_every_verdict():
    df = _rows(300, "crypto_intraday", real_half=0.004, eff_half=0.012, seed=6)
    v = MMSpreadValidator().run(_ctx(df))
    for verdict in v:
        assert any("passive-maker proxy" in c for c in verdict.n_caveats)
