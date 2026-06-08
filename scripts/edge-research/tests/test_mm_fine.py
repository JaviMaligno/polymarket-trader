import pandas as pd
from validators.mm_fine import MMFineValidator

class Ctx:
    def __init__(self, df):
        self.datasets = {"mm_fine_fills": df}
        self.computed_at = "2026-06-07T00:00:00Z"
        self.seed = 0

def _row(mt, maker_price, mid_after, sign, size=10.0):
    return {"market_type": mt, "maker_price": maker_price, "mid_60s": mid_after,
            "mid_10s": mid_after, "mid_300s": mid_after, "maker_sign": sign,
            "size": size, "mid_before": 0.5}

# Sign convention (see mm_fine_fills.sql): retained = maker_sign*(maker_price - mid_after).
#   sign +1 = ask-lift, maker SOLD at maker_price  -> profit when maker_price > mid_after (sold high, mid fell)
#   sign -1 = bid-hit,  maker BOUGHT at maker_price -> profit when mid_after > maker_price (bought low, mid rose)

def _cohort(v, ctx, name):
    return next(r for r in v.run(ctx) if r.class_metric.get("cohort") == name)

def test_profitable_ask_lift_passes():
    # ask-lift: maker SOLD at 0.41, mid then fell to 0.40 -> retained +1*(0.41-0.40)=+0.01 (profit)
    rows = [_row("event_financial", 0.41, 0.40, 1) for _ in range(300)]
    v = MMFineValidator()
    fin = _cohort(v, Ctx(pd.DataFrame(rows)), "event_financial:60s:all")
    assert fin.status == "pass"
    assert fin.edge_net_pct > 0

def test_adverse_fill_fails():
    # ask-lift gone wrong: maker SOLD at 0.40, mid then ROSE to 0.41 -> retained +1*(0.40-0.41)=-0.01 (loss).
    # Guards against a re-inversion of the retained-spread sign: if the formula flipped,
    # this adverse scenario would wrongly report a profit and the test would fail.
    rows = [_row("event_financial", 0.40, 0.41, 1) for _ in range(300)]
    v = MMFineValidator()
    fin = _cohort(v, Ctx(pd.DataFrame(rows)), "event_financial:60s:all")
    assert fin.status == "fail"
    assert fin.edge_net_pct < 0

def test_profitable_bid_hit_passes():
    # bid-hit: maker BOUGHT at 0.40, mid then rose to 0.41 -> retained -1*(0.40-0.41)=+0.01 (profit)
    rows = [_row("event_financial", 0.40, 0.41, -1) for _ in range(300)]
    v = MMFineValidator()
    fin = _cohort(v, Ctx(pd.DataFrame(rows)), "event_financial:60s:all")
    assert fin.status == "pass"
    assert fin.edge_net_pct > 0

def test_below_floor_is_inconclusive():
    rows = [_row("event_financial", 0.41, 0.40, 1) for _ in range(10)]
    v = MMFineValidator()
    res = [r for r in v.run(Ctx(pd.DataFrame(rows))) if r.class_metric.get("cohort") == "event_financial:60s:all"]
    assert res[0].status == "inconclusive"
