#!/usr/bin/env python3
"""H-INE-3 Sub-project B — news-lag validator (price-continuation core).

Does the market UNDERreact to a news burst (the initial move continues = a lag we can
capture)? Measured as a semi-backtest on existing 4s price history — no resolution needed:
the underreaction is the post-burst mark-to-market drift in the nascent-move direction.
Sentiment/hybrid arms + hold-to-resolution PnL are Sub-project C, gated on lag existing.

Spec: docs/superpowers/specs/2026-06-23-h-ine-3-lag-validator-design.md
"""
from __future__ import annotations
from bisect import bisect_right
import numpy as np

from verdict import Verdict
from validators.base import bootstrap_ci


# ---------- burst detector ----------

def detect_bursts(event_times, baseline_win=86400, spike_win=3600,
                  min_ratio=3.0, min_count=3) -> list[int]:
    """A burst at t = a spike_win window with >=min_count events AND a rate
    >=min_ratio x the trailing baseline_win rate. De-duplicated within spike_win."""
    ev = sorted(int(x) for x in event_times)
    bursts: list[int] = []
    last = None
    for e in ev:
        cnt = sum(1 for x in ev if e <= x < e + spike_win)
        base = sum(1 for x in ev if e - baseline_win <= x < e)
        base_rate = (base if base > 0 else 1) / baseline_win
        if cnt >= min_count and (cnt / spike_win) >= min_ratio * base_rate:
            if last is None or e - last >= spike_win:
                bursts.append(e)
                last = e
    return bursts


# ---------- price window ----------

def price_at(series, t):
    """Last price at/before t. series = sorted [(t_unix, price)]. None if t < first."""
    if not series:
        return None
    ts = [s[0] for s in series]
    i = bisect_right(ts, int(t)) - 1
    if i < 0:
        return None
    return series[i][1]


def move(series, t0, dt):
    a = price_at(series, t0)
    b = price_at(series, t0 + dt)
    if a is None or b is None:
        return None
    return b - a


# ---------- continuation signal ----------

def continuation(series, burst_t, react_win=900, hold_win=14400,
                 cost=0.0054, eps=0.005):
    """Direction = sign of nascent move over [burst, burst+react_win]; entry there;
    edge = further signed move over the hold window in that direction, minus one-way cost.
    Returns None if windows fall outside the series or the nascent move is < eps."""
    p0 = price_at(series, burst_t)
    p_react = price_at(series, burst_t + react_win)
    if p0 is None or p_react is None:
        return None
    nascent = p_react - p0
    if abs(nascent) < eps:
        return None
    direction = 1 if nascent > 0 else -1
    entry = p_react
    p_hold = price_at(series, burst_t + react_win + hold_win)
    if p_hold is None:
        return None
    cont = (p_hold - entry) * direction
    return {"direction": direction, "entry_price": entry, "nascent_move": nascent,
            "continuation_move": cont, "edge_net": cont - cost}


# ---------- lag-shape diagnostic (does lag exist, direction-free) ----------

def lag_shape(moves_5m, moves_1h, moves_4h) -> dict:
    def amean(xs):
        xs = [abs(x) for x in xs if x is not None]
        return float(np.mean(xs)) if xs else 0.0
    m5, m1, m4 = amean(moves_5m), amean(moves_1h), amean(moves_4h)
    denom = m4 if m4 > 1e-9 else 1e-9
    return {"abs_move_5m": m5, "abs_move_1h": m1, "abs_move_4h": m4,
            "realised_by_5m": m5 / denom, "realised_by_1h": m1 / denom}


# ---------- scorer (clustered by market) ----------

def score_continuation(results, cost_model="one_way_0.54pct", floor=100,
                       seed=0, n_boot=1000, computed_at="t") -> Verdict:
    """results: list of {market_id, edge_net, continuation_move}. Block-bootstrap CI
    by market_id (one market's bursts are not independent)."""
    rows = [r for r in results if r is not None]
    n = len(rows)
    if n == 0:
        return Verdict("H-INE-3", "inefficiency", 0, None, None, None,
                       "semi_backtest", {"slice": "continuation"}, cost_model,
                       "inconclusive", ["no_bursts"], computed_at)
    edges = np.array([r["edge_net"] for r in rows], dtype=float)
    gross = np.array([r["continuation_move"] for r in rows], dtype=float)
    mean_net = float(edges.mean())

    # block bootstrap by market
    by_mkt: dict = {}
    for r in rows:
        by_mkt.setdefault(r["market_id"], []).append(r["edge_net"])
    mkts = list(by_mkt.values())
    rng = np.random.default_rng(seed)
    if len(mkts) >= 2:
        boots = []
        for _ in range(n_boot):
            pick = rng.integers(0, len(mkts), size=len(mkts))
            vals = [v for idx in pick for v in mkts[idx]]
            boots.append(np.mean(vals))
        lo = float(np.percentile(boots, 2.5))
        hi = float(np.percentile(boots, 97.5))
    else:
        lo, hi = bootstrap_ci(edges, n_boot=n_boot, seed=seed)

    status = "pass" if (mean_net > 0 and lo > 0 and n >= floor) else (
        "fail" if n >= floor else "inconclusive")
    caveats = [] if n >= floor else [f"n_bursts<{floor}"]
    if len(mkts) < 5:
        caveats.append(f"few_market_clusters={len(mkts)}")
    return Verdict("H-INE-3", "inefficiency", n, mean_net, float(gross.mean()),
                   None, "semi_backtest",
                   {"slice": "continuation", "boot_lo": lo, "boot_hi": hi,
                    "n_markets": len(mkts)},
                   cost_model, status, caveats, computed_at)
