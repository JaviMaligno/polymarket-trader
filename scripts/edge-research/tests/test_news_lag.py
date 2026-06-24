import numpy as np
from news_lag import (
    detect_bursts, price_at, move, continuation, lag_shape, score_continuation,
)

H = 3600


# ---------- burst detector ----------

def test_no_burst_on_flat_low_rate():
    # one event per hour for a day -> no 1h window reaches min_count=3
    ev = [i * H for i in range(24)]
    assert detect_bursts(ev) == []


def test_single_spike_is_one_burst():
    base = [i * H for i in range(24)]          # day of low chatter
    spike = [100 * H + i * 60 for i in range(6)]  # 6 events in 5 min, much later
    bursts = detect_bursts(base + spike)
    assert len(bursts) == 1
    assert bursts[0] == 100 * H


def test_two_separated_spikes_are_two_bursts():
    s1 = [100 * H + i * 60 for i in range(5)]
    s2 = [200 * H + i * 60 for i in range(5)]
    bursts = detect_bursts(s1 + s2)
    assert len(bursts) == 2


def test_spike_below_min_count_is_none():
    ev = [i * H for i in range(24)] + [100 * H, 100 * H + 60]  # only 2 clustered
    assert detect_bursts(ev) == []


# ---------- price window ----------

def _series():
    # (t, price) every 5 min for 5h starting at 0
    return [(i * 300, 0.50) for i in range(60)]


def test_price_at_lookup_and_before_start():
    s = [(0, 0.5), (300, 0.6), (600, 0.7)]
    assert price_at(s, 0) == 0.5
    assert price_at(s, 450) == 0.6
    assert price_at(s, 10_000) == 0.7
    assert price_at(s, -1) is None


def test_move_signed():
    s = [(0, 0.5), (300, 0.6), (600, 0.7)]
    assert abs(move(s, 0, 600) - 0.2) < 1e-9
    assert move(s, -5, 100) is None


# ---------- continuation ----------

def _drift(start=0.50, step=0.01, n=120):
    return [(i * 300, start + i * step * 0.0) for i in range(n)]  # placeholder flat


def test_continuation_up_drift_positive_edge():
    # price rises 0.50 -> 0.60 over first 15m, then keeps rising to 0.70 by +4h
    s = [(0, 0.50), (300, 0.55), (900, 0.60),
         (900 + 7200, 0.66), (900 + 14400, 0.70)]
    r = continuation(s, 0, react_win=900, hold_win=14400, cost=0.0054)
    assert r["direction"] == 1
    assert r["nascent_move"] > 0
    assert r["continuation_move"] > 0
    assert r["edge_net"] > 0


def test_continuation_instant_reprice_is_efficient_negative_edge():
    # jumps to 0.60 by 15m then FLAT -> no continuation, edge = -cost
    s = [(0, 0.50), (900, 0.60)] + [(900 + i * 300, 0.60) for i in range(1, 60)]
    r = continuation(s, 0, react_win=900, hold_win=14400, cost=0.0054)
    assert r["direction"] == 1
    assert abs(r["continuation_move"]) < 1e-9
    assert r["edge_net"] < 0


def test_continuation_skips_tiny_nascent_move():
    s = [(0, 0.50), (900, 0.5005)] + [(900 + i * 300, 0.5005) for i in range(1, 60)]
    assert continuation(s, 0, eps=0.005) is None


# ---------- lag shape ----------

def test_lag_shape_instant_is_efficient():
    sh = lag_shape([0.10] * 5, [0.10] * 5, [0.10] * 5)
    assert sh["realised_by_5m"] > 0.95  # full move already by 5m -> efficient


def test_lag_shape_gradual_is_rising():
    sh = lag_shape([0.02] * 5, [0.06] * 5, [0.10] * 5)
    assert sh["realised_by_5m"] < 0.5 < sh["realised_by_1h"]


# ---------- scorer ----------

def test_score_positive_spread_across_markets_passes():
    results = [{"market_id": f"m{i%20}", "edge_net": 0.03,
                "continuation_move": 0.0354} for i in range(120)]
    v = score_continuation(results, floor=100)
    assert v.hypothesis_id == "H-INE-3"
    assert v.n == 120
    assert v.edge_net_pct > 0
    assert v.status == "pass"


def test_score_all_zero_fails():
    results = [{"market_id": f"m{i%20}", "edge_net": -0.0054,
                "continuation_move": 0.0} for i in range(120)]
    v = score_continuation(results, floor=100)
    assert v.status == "fail"


def test_score_below_floor_inconclusive():
    results = [{"market_id": "m0", "edge_net": 0.03, "continuation_move": 0.0354}
               for _ in range(10)]
    v = score_continuation(results, floor=100)
    assert v.status == "inconclusive"
