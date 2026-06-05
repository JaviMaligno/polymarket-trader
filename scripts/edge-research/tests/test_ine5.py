import numpy as np, pandas as pd, types
from validators.ine5 import TimeDecayExtremeBandValidator


def _ctx(df, ine5_min_n=40, cost=0.005):
    return types.SimpleNamespace(datasets={"market_panel_resolved": df},
                                 cost=cost, computed_at="t", seed=7,
                                 ine5_min_n=ine5_min_n, ine5_band=0.10,
                                 ine5_ttr_max_days=7.0)


def _rows(n, price, ttr, p_yes, seed):
    rng = np.random.default_rng(seed)
    return pd.DataFrame({
        "market_id": [f"m{seed}_{i}" for i in range(n)],
        "yes_price": np.full(n, price),
        "outcome_yes": (rng.uniform(size=n) < p_yes).astype(int),
        "market_type": ["event_short"] * n, "ttr_days": np.full(n, ttr),
        "market_score": [0.5] * n,
    })


def _band(verdicts, name):
    return [v for v in verdicts if v.class_metric.get("band") == name][0]


def test_overpriced_longshot_near_expiry_short_passes():
    # priced 0.10 but only 2% resolve YES near expiry → SHORT captures the gap
    df = _rows(200, 0.10, 3.0, 0.02, seed=1)
    v = TimeDecayExtremeBandValidator().run(_ctx(df))
    ls = _band(v, "longshot")
    assert ls.hypothesis_id == "H-INE-5"
    assert ls.n == 200
    assert ls.status == "pass"
    assert ls.edge_net_pct > 0


def test_fairly_priced_longshot_fails():
    # priced 0.10 and 10% resolve YES → SHORT edge ≈ -cost → fail
    df = _rows(200, 0.10, 3.0, 0.10, seed=2)
    v = TimeDecayExtremeBandValidator().run(_ctx(df))
    ls = _band(v, "longshot")
    assert ls.status == "fail"
    assert ls.edge_net_pct < 0


def test_high_ttr_markets_excluded():
    # all markets far from expiry (ttr 30d > 7d cap) → no enterable rows
    df = _rows(200, 0.10, 30.0, 0.02, seed=3)
    v = TimeDecayExtremeBandValidator().run(_ctx(df))
    ls = _band(v, "longshot")
    assert ls.n == 0
    assert ls.status == "inconclusive"


def test_longshot_verdict_carries_flat_cost_caveat():
    # The panel only has flat cost; the real-cost answer lives in H-INE-1.
    df = _rows(200, 0.10, 3.0, 0.02, seed=4)
    v = TimeDecayExtremeBandValidator().run(_ctx(df))
    ls = _band(v, "longshot")
    assert any("H-INE-1" in c for c in ls.n_caveats)


def test_favorite_band_emitted_and_uses_long_direction():
    # favorites priced 0.90 that mostly resolve YES (0.97) → LONG positive
    df = _rows(200, 0.90, 3.0, 0.97, seed=5)
    v = TimeDecayExtremeBandValidator().run(_ctx(df))
    fav = _band(v, "favorite")
    assert fav.class_metric["direction"] == 1
    assert fav.edge_net_pct > 0
