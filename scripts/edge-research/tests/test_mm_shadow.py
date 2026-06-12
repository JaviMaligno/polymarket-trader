import pandas as pd
import types
from validators.mm_shadow import MMShadowValidator


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ctx(df, min_n=1):
    return types.SimpleNamespace(datasets={"mm_shadow_fills": df}, cost=0.005,
                                 computed_at="x", n_bins=10, min_n=200,
                                 mm_min_n=min_n, seed=7)


def _row(tt, side, bound, price, mid_after, market_type="event_financial", flags="", spread=0.04):
    return {"time": pd.Timestamp(tt, tz="UTC"), "token_id": "T", "market_id": "M",
            "market_type": market_type, "side": side, "bound": bound,
            "price": price, "size": 20, "queue_initial": 30,
            "spread_at_placement": spread, "vol_at_placement": 0.0, "flags": flags,
            "mid_10s": mid_after, "mid_60s": mid_after, "mid_300s": mid_after}


# ---------------------------------------------------------------------------
# Plan §Task 14 tests (3 required tests)
# ---------------------------------------------------------------------------

def test_profitable_bid_fill_passes():
    # bid fill (side=-1): maker bought at 0.48, mid then rose to 0.50
    # retained = -1 * (0.48 - 0.50) = +0.02 (profit)
    rows = [_row(f"2026-06-12T10:{i:02d}:00", -1, "trades", 0.48, 0.50) for i in range(60)]
    v = MMShadowValidator()
    out = v.run(_ctx(pd.DataFrame(rows)))
    fin = next(r for r in out if r.class_metric["cohort"] == "event_financial:60s:trades")
    assert fin.status == "pass"
    assert fin.edge_net_pct > 0


def test_adverse_ask_fill_fails():
    # ask fill (side=+1): maker sold at 0.48, mid then rose to 0.52
    # retained = +1 * (0.48 - 0.52) = -0.04 (loss)
    rows = [_row(f"2026-06-12T10:{i:02d}:00", 1, "trades", 0.48, 0.52) for i in range(60)]
    v = MMShadowValidator()
    out = v.run(_ctx(pd.DataFrame(rows)))
    fin = next(r for r in out if r.class_metric["cohort"] == "event_financial:60s:trades")
    assert fin.status == "fail"
    assert fin.edge_net_pct < 0


def test_flagged_fills_form_their_own_cohort():
    # Mix of plain fills and exit_improve-flagged fills; the flagged subset
    # must produce a dedicated "flag:exit_improve:*" cohort.
    rows = (
        [_row(f"2026-06-12T10:{i:02d}:00", -1, "trades", 0.48, 0.50) for i in range(30)] +
        [_row(f"2026-06-12T11:{i:02d}:00", -1, "trades", 0.49, 0.50, flags="exit_improve") for i in range(30)]
    )
    v = MMShadowValidator()
    labels = {r.class_metric["cohort"] for r in v.run(_ctx(pd.DataFrame(rows)))}
    assert "flag:exit_improve:60s:trades" in labels
