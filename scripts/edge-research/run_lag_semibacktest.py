#!/usr/bin/env python3
"""Wire local data into the news_lag core for the lead-domain semi-backtest.

Reads _markets_active.csv (questions), _news_titles.csv (titles+times), _lag.csv
(5-min close series). Per market: entity-matched news event times -> bursts ->
continuation; aggregates lag_shape (does lag exist?) + the clustered continuation Verdict.
Not a unit test — an analysis runner (the news_lag logic is unit-tested separately).
"""
import csv
from bisect import bisect_right
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from news_linkability import classify_market
from news_lag import detect_bursts, move, continuation, lag_shape, score_continuation

HERE = Path(__file__).resolve().parent / "datasets"


def spread_at(spread_series, t):
    """Last spread at/before t. spread_series = sorted [(t, spread)]."""
    if not spread_series:
        return None
    ts = [s[0] for s in spread_series]
    i = bisect_right(ts, int(t)) - 1
    return spread_series[i][1] if i >= 0 else None


def _epoch(ts: str) -> int:
    # "2026-06-23 13:00:01+00" -> unix seconds
    ts = ts.strip().replace(" ", "T")
    if ts.endswith("+00"):
        ts = ts[:-3] + "+00:00"
    return int(datetime.fromisoformat(ts).replace(tzinfo=timezone.utc).timestamp()) \
        if "+" not in ts[10:] else int(datetime.fromisoformat(ts).timestamp())


def main():
    markets = {r["id"]: r for r in csv.DictReader((HERE / "_markets_active.csv").open(encoding="utf-8"))}
    news = list(csv.DictReader((HERE / "_news_titles.csv").open(encoding="utf-8")))
    news_lc = [(_epoch(n["time"]), n["title"].lower()) for n in news]

    series = defaultdict(list)
    spreads = defaultdict(list)
    for r in csv.DictReader((HERE / "_lag.csv").open(encoding="utf-8")):
        try:
            series[r["market_id"]].append((int(r["t"]), float(r["price"])))
        except (ValueError, KeyError):
            continue
        try:
            spreads[r["market_id"]].append((int(r["t"]), float(r["spread"])))
        except (ValueError, KeyError, TypeError):
            pass
    for mid in series:
        series[mid].sort()
    for mid in spreads:
        spreads[mid].sort()

    results, all5, all1, all4 = [], [], [], []
    n_mkts_with_bursts = 0
    by_domain = defaultdict(lambda: {"markets": 0, "bursts": 0})

    for mid, ser in series.items():
        mkt = markets.get(mid)
        if not mkt:
            continue
        me = classify_market(mkt["question"])
        if me.domain == "other" or not me.entities:
            continue
        terms = [e.lower() for e in me.entities]
        ev = [t for (t, title) in news_lc if all(term in title for term in terms)]
        if len(ev) < 3:
            continue
        bursts = detect_bursts(ev)
        if not bursts:
            continue
        n_mkts_with_bursts += 1
        by_domain[me.domain]["markets"] += 1
        for bt in bursts:
            # lag-shape diagnostic (direction-free abs moves)
            for dt, acc in ((300, all5), (3600, all1), (14400, all4)):
                m = move(ser, bt, dt)
                if m is not None:
                    acc.append(m)
            r = continuation(ser, bt, cost=0.0)  # gross; apply real cost below
            if r is not None:
                entry_t = bt + 900
                sp = spread_at(spreads[mid], entry_t)
                # round-trip cost vs mid ~= one full spread (cross half each way).
                # fall back to flat 0.0054 if no spread sample.
                rt_cost = sp if (sp is not None and sp > 0) else 0.0054
                # live CLOB book probe 2026-06-23: macro/liquid ~0.1-0.2% spread,
                # commodity-threshold/longshot ~7-19% (Gold 0.40 -> 19%). Calibrated cost.
                calib = {"macro_fed": 0.002, "commodity": 0.07,
                         "geopolitical": 0.03, "crypto_price": 0.01}.get(me.domain, 0.0054)
                r["market_id"] = mid
                r["domain"] = me.domain
                r["spread"] = sp
                r["edge_net"] = r["continuation_move"] - 0.0054        # flat (orig)
                r["edge_net_real"] = r["continuation_move"] - calib    # calibrated real spread
                results.append(r)
                by_domain[me.domain]["bursts"] += 1

    print(f"markets with bursts: {n_mkts_with_bursts}  continuation observations: {len(results)}")
    sh = lag_shape(all5, all1, all4)
    print("LAG SHAPE (abs move, direction-free):")
    print(f"  5m={sh['abs_move_5m']:.4f}  1h={sh['abs_move_1h']:.4f}  4h={sh['abs_move_4h']:.4f}")
    print(f"  realised_by_5m={sh['realised_by_5m']:.2f}  realised_by_1h={sh['realised_by_1h']:.2f}")
    print("  (>0.8 by 5m => efficient/no lag; rising profile => lag exists)")
    print("by domain:", {d: dict(v) for d, v in by_domain.items()})

    spr = sorted(r["spread"] for r in results if r.get("spread") is not None)
    if spr:
        med = spr[len(spr) // 2]
        print(f"\nreal spread per burst: median={med:.4f}  min={spr[0]:.4f}  max={spr[-1]:.4f}"
              f"  (vs flat cost 0.0054)")

    v = score_continuation(results, floor=100)
    print("\nCONTINUATION VERDICT (FLAT cost 0.54%):")
    print(f"  status={v.status}  n={v.n}  edge_net={v.edge_net_pct:.5f}  gross={v.edge_insample_pct:.5f}")
    print(f"  boot_lo={v.class_metric.get('boot_lo'):.5f}  boot_hi={v.class_metric.get('boot_hi'):.5f}"
          f"  n_markets={v.class_metric.get('n_markets')}")

    print("\nreal-cost edge BY DOMAIN (mean edge_net_real):")
    for d in ("macro_fed", "commodity", "geopolitical", "crypto_price"):
        sub = [r["edge_net_real"] for r in results if r.get("domain") == d]
        if sub:
            print(f"  {d:13s} n={len(sub):3d}  mean={sum(sub)/len(sub):+.4f}")

    for r in results:
        r["edge_net"] = r["edge_net_real"]
    vr = score_continuation(results, floor=100)
    print("\nCONTINUATION VERDICT (REAL per-market spread):")
    print(f"  status={vr.status}  n={vr.n}  edge_net={vr.edge_net_pct:.5f}  gross={vr.edge_insample_pct:.5f}")
    print(f"  boot_lo={vr.class_metric.get('boot_lo'):.5f}  boot_hi={vr.class_metric.get('boot_hi'):.5f}")
    print("  >>> the real-cost edge is the decisive gate (feedback_realistic_costs)")


if __name__ == "__main__":
    main()
