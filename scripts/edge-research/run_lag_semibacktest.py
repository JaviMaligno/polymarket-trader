#!/usr/bin/env python3
"""Wire local data into the news_lag core for the lead-domain semi-backtest.

Reads _markets_active.csv (questions), _news_titles.csv (titles+times), _lag.csv
(5-min close series). Per market: entity-matched news event times -> bursts ->
continuation; aggregates lag_shape (does lag exist?) + the clustered continuation Verdict.
Not a unit test — an analysis runner (the news_lag logic is unit-tested separately).
"""
import csv
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from news_linkability import classify_market
from news_lag import detect_bursts, move, continuation, lag_shape, score_continuation

HERE = Path(__file__).resolve().parent / "datasets"


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
    for r in csv.DictReader((HERE / "_lag.csv").open(encoding="utf-8")):
        try:
            series[r["market_id"]].append((int(r["t"]), float(r["price"])))
        except (ValueError, KeyError):
            continue
    for mid in series:
        series[mid].sort()

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
            r = continuation(ser, bt)
            if r is not None:
                r["market_id"] = mid
                results.append(r)
                by_domain[me.domain]["bursts"] += 1

    print(f"markets with bursts: {n_mkts_with_bursts}  continuation observations: {len(results)}")
    sh = lag_shape(all5, all1, all4)
    print("LAG SHAPE (abs move, direction-free):")
    print(f"  5m={sh['abs_move_5m']:.4f}  1h={sh['abs_move_1h']:.4f}  4h={sh['abs_move_4h']:.4f}")
    print(f"  realised_by_5m={sh['realised_by_5m']:.2f}  realised_by_1h={sh['realised_by_1h']:.2f}")
    print("  (>0.8 by 5m => efficient/no lag; rising profile => lag exists)")
    print("by domain:", {d: dict(v) for d, v in by_domain.items()})

    v = score_continuation(results, floor=100)
    print("\nCONTINUATION VERDICT:")
    print(f"  status={v.status}  n={v.n}  edge_net={v.edge_net_pct}  gross={v.edge_insample_pct}")
    print(f"  boot_lo={v.class_metric.get('boot_lo'):.5f}  boot_hi={v.class_metric.get('boot_hi'):.5f}"
          f"  n_markets={v.class_metric.get('n_markets')}")
    print(f"  caveats={v.n_caveats}")


if __name__ == "__main__":
    main()
