import types, pandas as pd
from validators.mm_live import MMLiveValidator


def _ctx(df):
    return types.SimpleNamespace(datasets={'mm_live_fills': df}, cost=0.005,
                                 computed_at='2026-06-17T00:00:00+00:00', n_bins=10, min_n=2, seed=7)


def test_live_retained_positive_passes():
    # 3 fills bid (side -1) a 0.40, mid sube a 0.45 → retained +0.05 c/u
    rows = [{'time': pd.Timestamp('2026-06-17', tz='UTC'), 'market_type': 'event_short',
             'token_id': 't', 'side': -1, 'fill_price': 0.40, 'fill_size': 20,
             'spread_at_placement': 0.02, 'mid_10s': 0.45, 'mid_60s': 0.45, 'mid_300s': 0.45} for _ in range(3)]
    df = pd.DataFrame(rows)
    out = MMLiveValidator().run(_ctx(df))
    cell = [v for v in out if v.class_metric.get('cohort') == 'headline:tradeable:10s'][0]
    assert cell.status == 'pass'
    assert cell.edge_net_pct > 0
