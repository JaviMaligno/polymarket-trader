#!/usr/bin/env python3
"""
flb-subband-sweep.py

Does a CHEAPER spread sub-band recover a positive realistic-cost FLB edge?
Sweeps the entry-cost ceiling and, for each, reports the realistic-cost net
edge of the surviving resolved signals per market type, with a bootstrap CI
(the -100% wipeout tail breaks normality, so we resample rather than trust a t).

realistic_net = shadow_net + 0.0054 - (spread/2)/(1-yes)
A signal is "enterable" at ceiling c if its real entry cost <= c (book present).

Usage: python scripts/flb-subband-sweep.py [flb_resolved.csv]
CSV cols (no header): market_type, net_pnl, entry_yes_price, entry_spread
"""
import sys
import numpy as np

SHADOW_FLAT_COST = 0.0054
CSV = sys.argv[1] if len(sys.argv) > 1 else "flb_resolved.csv"
RNG = np.random.default_rng(0)
N_BOOT = 10000
CEILINGS = [0.0025, 0.005, 0.0075, 0.01, 0.015, 0.02, 0.05]


def load(path):
    rows = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            mtype, pnl_s, yes_s, spread_s = line.split(",")[:4]
            if spread_s == "":
                rows.append((mtype, float(pnl_s), float(yes_s), None))
            else:
                rows.append((mtype, float(pnl_s), float(yes_s), float(spread_s)))
    return rows


def real_cost(yes, spread):
    return (spread / 2.0) / (1.0 - yes)


def boot(net):
    if len(net) == 0:
        return (np.nan, np.nan, np.nan, np.nan)
    idx = RNG.integers(0, len(net), size=(N_BOOT, len(net)))
    means = net[idx].mean(axis=1)
    return (float(net.mean()), float(np.percentile(means, 5)),
            float(np.percentile(means, 95)), float((means > 0).mean()))


def main():
    rows = load(CSV)
    types = sorted(set(r[0] for r in rows))
    print("=" * 78)
    print("FLB cheaper-sub-band sweep — realistic net edge vs entry-cost ceiling")
    print("=" * 78)
    print(f"Bootstrap N={N_BOOT}, seed=0. 'wipe'=YES resolutions (net<-0.5). "
          f"P0=P(mean net>0).\n")

    for c in CEILINGS:
        print(f"--- ceiling = {c:.2%} entry cost " + "-" * 40)
        any_data = False
        for t in types:
            net = []
            wipes = 0
            for (mt, pnl, yes, spread) in rows:
                if mt != t or spread is None or spread <= 0:
                    continue
                if real_cost(yes, spread) > c:
                    continue
                rn = pnl + SHADOW_FLAT_COST - real_cost(yes, spread)
                net.append(rn)
                if rn < -0.5:
                    wipes += 1
            net = np.array(net)
            if len(net) == 0:
                continue
            any_data = True
            mean, lo, hi, p0 = boot(net)
            winrate = float((net > 0).mean())
            print(f"  {t:<16} n={len(net):>3} wipe={wipes:<2} "
                  f"mean={mean:+.4f} 90%CI[{lo:+.4f},{hi:+.4f}] "
                  f"P0={p0:.2f} win%={winrate:.0%}")
        # pooled across all types (the executor trades them together)
        netall = []
        for (mt, pnl, yes, spread) in rows:
            if spread is None or spread <= 0 or real_cost(yes, spread) > c:
                continue
            netall.append(pnl + SHADOW_FLAT_COST - real_cost(yes, spread))
        netall = np.array(netall)
        if len(netall):
            mean, lo, hi, p0 = boot(netall)
            print(f"  {'POOLED':<16} n={len(netall):>3}        "
                  f"mean={mean:+.4f} 90%CI[{lo:+.4f},{hi:+.4f}] P0={p0:.2f}")
        if not any_data:
            print("  (no enterable signals at this ceiling)")
    print("-" * 78)
    print("Read: if the tightest ceilings (0.25-0.5%) show mean>0 with P0 high and CI")
    print("clear of 0, a cheap sub-band has edge -> a real tradeable restriction.")
    print("If mean stays ~0 / P0~0.5 even at the cheapest spreads, the realistic edge")
    print("is not there. event_financial has NO enterable signals below ~5% cost.")


if __name__ == "__main__":
    main()
