import pandas as pd
from validators.mm_fine import MMFineValidator

class Ctx:
    def __init__(self, df):
        self.datasets = {"mm_fine_fills": df}
        self.computed_at = "2026-06-07T00:00:00Z"
        self.seed = 0

def _row(mt, maker_price, mid60, sign, size=10.0):
    return {"market_type": mt, "maker_price": maker_price, "mid_60s": mid60,
            "mid_10s": mid60, "mid_300s": mid60, "maker_sign": sign,
            "size": size, "mid_before": 0.5}

def test_positive_retained_spread_passes():
    # maker buys at 0.40 (sign +1), mid drifts to 0.405 -> retained = +1*(0.40-0.405) = -0.005?
    # No: retained should be maker_price - mid_after for a SELL-perspective; use the validator's sign.
    # Construct: sign +1, maker_price 0.41, mid_60s 0.40 -> retained = +1*(0.41-0.40)=+0.01 (>0)
    rows = [_row("event_financial", 0.41, 0.40, 1) for _ in range(300)]
    v = MMFineValidator()
    out = {f"{r.class_metric.get('cohort')}": r for r in v.run(Ctx(pd.DataFrame(rows)))}
    fin = next(r for r in v.run(Ctx(pd.DataFrame(rows))) if r.class_metric.get("cohort") == "event_financial:60s:all")
    assert fin.status == "pass"
    assert fin.edge_net_pct > 0

def test_below_floor_is_inconclusive():
    rows = [_row("event_financial", 0.41, 0.40, 1) for _ in range(10)]
    v = MMFineValidator()
    res = [r for r in v.run(Ctx(pd.DataFrame(rows))) if r.class_metric.get("cohort") == "event_financial:60s:all"]
    assert res[0].status == "inconclusive"
