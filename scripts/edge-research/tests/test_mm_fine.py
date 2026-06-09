import pandas as pd
import types
from validators.mm_fine import MMFineValidator

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ctx(df, min_n=1):
    return types.SimpleNamespace(datasets={"mm_fine_fills": df}, cost=0.005,
                                 computed_at="x", n_bins=10, min_n=200,
                                 mm_min_n=min_n, seed=7)


def _row(tt, maker_sign, size, touch_size, maker_price, mid_after,
         market_type="event_financial", token_id="T"):
    mid_before = 0.50
    price = 0.40 if maker_sign == -1 else 0.60
    return {
        "market_id": "0xabc", "market_type": market_type, "token_id": token_id,
        "time": pd.Timestamp(tt, tz="UTC"), "size": size, "price": price,
        "best_bid": 0.49, "best_ask": 0.51, "mid_before": mid_before,
        "mid_10s": mid_after, "mid_60s": mid_after, "mid_300s": mid_after,
        "maker_price": maker_price, "maker_sign": maker_sign,
        "best_bid_size": touch_size, "best_ask_size": touch_size,
    }


def _cohort(v, ctx, name):
    return next(r for r in v.run(ctx) if r.class_metric.get("cohort") == name)


# ---------------------------------------------------------------------------
# Sign-convention tests (updated from old suite to use new cohort names).
#
# The new validator emits cohorts with `:front` or `:back` suffix.
# These tests use front-bound (size_ahead starts at 0) so every adverse
# trade triggers a fill; the cohort name is `...:front`.
#
# The old Ctx + _row helpers have been replaced by the new helpers above
# (old helpers lacked token_id/time/best_bid_size/best_ask_size required
# by the queue-reactive walk).
# ---------------------------------------------------------------------------

# Sign convention (see mm_fine_fills.sql): retained = maker_sign*(maker_price - mid_after).
#   sign +1 = ask-lift, maker SOLD at maker_price  -> profit when maker_price > mid_after (sold high, mid fell)
#   sign -1 = bid-hit,  maker BOUGHT at maker_price -> profit when mid_after > maker_price (bought low, mid rose)


def _front_ctx(rows, min_n=1):
    """Build a context with enough rows to clear the mm_min_n floor."""
    return _ctx(pd.DataFrame(rows), min_n=min_n)


def test_profitable_ask_lift_passes():
    # ask-lift: maker SOLD at 0.41, mid then fell to 0.40 -> retained +1*(0.41-0.40)=+0.01 (profit)
    # Use touch_size=1 so front-bound fills immediately on each trade.
    rows = [_row(f"2026-06-09T10:{i:02d}:00", 1, 10, 1, 0.41, 0.40) for i in range(60)]
    v = MMFineValidator()
    fin = _cohort(v, _front_ctx(rows), "event_financial:60s:all:front")
    assert fin.status == "pass"
    assert fin.edge_net_pct > 0


def test_adverse_fill_fails():
    # ask-lift gone wrong: maker SOLD at 0.40, mid then ROSE to 0.41 -> retained +1*(0.40-0.41)=-0.01 (loss).
    # Guards against a re-inversion of the retained-spread sign.
    rows = [_row(f"2026-06-09T10:{i:02d}:00", 1, 10, 1, 0.40, 0.41) for i in range(60)]
    v = MMFineValidator()
    fin = _cohort(v, _front_ctx(rows), "event_financial:60s:all:front")
    assert fin.status == "fail"
    assert fin.edge_net_pct < 0


def test_profitable_bid_hit_passes():
    # bid-hit: maker BOUGHT at 0.40, mid then rose to 0.41 -> retained -1*(0.40-0.41)=+0.01 (profit)
    rows = [_row(f"2026-06-09T10:{i:02d}:00", -1, 10, 1, 0.40, 0.41) for i in range(60)]
    v = MMFineValidator()
    fin = _cohort(v, _front_ctx(rows), "event_financial:60s:all:front")
    assert fin.status == "pass"
    assert fin.edge_net_pct > 0


def test_adverse_bid_hit_fails():
    # bid-hit gone wrong: maker BOUGHT at 0.49 (bid), mid then FELL to 0.45 -> retained -1*(0.49-0.45)=-0.04 (loss).
    # Guards against adverse bid-hit polarity inversion.
    rows = [_row(f"2026-06-09T10:{i:02d}:00", -1, 10, 1, 0.49, 0.45) for i in range(60)]
    v = MMFineValidator()
    fin = _cohort(v, _front_ctx(rows), "event_financial:60s:all:front")
    assert fin.status == "fail"
    assert fin.edge_net_pct < 0


def test_below_floor_is_inconclusive():
    # With mm_min_n=200 and only 10 rows -> inconclusive.
    rows = [_row(f"2026-06-09T10:{i:02d}:00", 1, 10, 1, 0.41, 0.40) for i in range(10)]
    v = MMFineValidator()
    res = [r for r in v.run(_ctx(pd.DataFrame(rows), min_n=200))
           if r.class_metric.get("cohort") == "event_financial:60s:all:front"]
    assert res[0].status == "inconclusive"


# ---------------------------------------------------------------------------
# New queue-reactive walk tests
# ---------------------------------------------------------------------------

def test_front_bound_fills_every_adverse_trade():
    df = pd.DataFrame([
        _row("2026-06-09T10:00:00", -1, 10, 1000, 0.49, 0.50),
        _row("2026-06-09T10:00:01", -1, 10, 1000, 0.49, 0.50),
        _row("2026-06-09T10:00:02", -1, 10, 1000, 0.49, 0.50),
    ])
    out = MMFineValidator().run(_ctx(df))
    front = [v for v in out if v.class_metric["cohort"] == "event_financial:10s:all:front"]
    assert len(front) == 1
    assert front[0].n == 3


def test_back_bound_waits_for_queue_to_clear():
    # touch_size=1000, trade_size=10 — queue never clears in 3 trades (need 100 trades).
    df = pd.DataFrame([
        _row("2026-06-09T10:00:00", -1, 10, 1000, 0.49, 0.50),
        _row("2026-06-09T10:00:01", -1, 10, 1000, 0.49, 0.50),
        _row("2026-06-09T10:00:02", -1, 10, 1000, 0.49, 0.50),
    ])
    out = MMFineValidator().run(_ctx(df))
    back = [v for v in out if v.class_metric["cohort"] == "event_financial:10s:all:back"]
    assert len(back) == 1
    assert back[0].n == 0


def test_back_bound_fills_after_volume_exceeds_queue():
    # touch_size=20, trade_size=25 -> first trade exceeds queue, fills immediately.
    df = pd.DataFrame([_row("2026-06-09T10:00:00", -1, 25, 20, 0.49, 0.50)])
    out = MMFineValidator().run(_ctx(df))
    back = [v for v in out if v.class_metric["cohort"] == "event_financial:10s:all:back"]
    assert back[0].n == 1


def test_emits_front_and_back_size_split_cohorts():
    df = pd.DataFrame([_row("2026-06-09T10:00:00", -1, 10, 5, 0.49, 0.50)])
    labels = {v.class_metric["cohort"] for v in MMFineValidator().run(_ctx(df))}
    for bound in ("front", "back"):
        for size in ("all", "large"):
            assert f"event_financial:10s:{size}:{bound}" in labels
