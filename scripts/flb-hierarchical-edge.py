#!/usr/bin/env python3
"""
flb-hierarchical-edge.py

Hierarchical (partial-pooling) Bayesian estimate of the per-trade FLB net edge
per market type, from forward `flb_shadow_signals` resolutions.

Why: the tradeable cohort (crypto_daily / event_financial / event_short) has too
few resolved signals (n=5, all event_financial) to verdict on its own, while
event_long has 128. Fully pooling them is the documented false-confidence trap;
treating them as independent throws away the structural evidence that the
favorite-longshot bias appears in every event type with similar monotonic
calibration. Partial pooling is the principled middle: each type's estimate
borrows from the others to the degree the data say they're similar.

Model (eight-schools / Normal-Normal):
    ybar_j ~ Normal(theta_j, se_j^2)          # group sample mean
    theta_j ~ Normal(mu, tau^2)               # types drawn from a population
    mu  ~ flat ;  tau ~ HalfNormal(0, s_tau)  # s_tau = pooling-strength prior

HONESTY CHOICES (read these):
 1. se_j uses a POOLED per-trade variance, NOT each type's own sample sd. The
    -100% wipeout tail (~1 in 27) is structural and has NOT yet occurred in the
    5 event_financial trades, so event_financial's own sd is optimistically
    small. Using the pooled sd (dominated by event_long, which HAS wipeouts)
    stops 5 lucky draws from claiming false precision.
 2. Types with 0 resolutions (crypto_daily, event_short) contribute no
    likelihood; their theta is a pure population prediction N(mu, tau^2) — i.e.
    "we are extrapolating from other types", made explicit.
 3. tau (between-type heterogeneity) is barely identified with only 2 data-
    bearing groups, so we report 3 tau-priors (tight/medium/loose) to show how
    much the answer rests on the similarity assumption rather than data.

Integration is a deterministic 2-D grid over (mu, tau) — no RNG, fully
reproducible. Per-type theta posteriors are exact grid-weighted normal mixtures.

Usage:  python scripts/flb-hierarchical-edge.py [flb_resolved.csv]
CSV cols (no header): market_type, net_pnl, entry_yes_price, hold_days
"""
import sys
import numpy as np

COST_HURDLE = 0.01          # build gate: avg_net >= +1% per trade
SHADOW_FLAT_COST = 0.0054   # the flat entry cost baked into flb_shadow_signals.net_pnl
MAX_ENTRY_COST = 0.01       # executor flb_0d ceiling (FLB_MAX_ENTRY_COST_PCT=1.0%)
TRADEABLE = {"crypto_daily", "event_financial", "event_short"}
CSV = sys.argv[1] if len(sys.argv) > 1 else "flb_resolved.csv"


def load(path):
    """Read rows, re-cost net_pnl with the REAL per-signal half-spread, and keep
    only signals the live executor would actually enter (flb_0d: cost<=1%, book
    present). Returns (types, realistic_net) for survivors + a drop report."""
    types, net, dropped = [], [], {}
    kept_by_type, seen_by_type = {}, {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            mtype, pnl_s, yes_s, spread_s = line.split(",")[:4]
            seen_by_type[mtype] = seen_by_type.get(mtype, 0) + 1
            stored_net = float(pnl_s)
            yes = float(yes_s)
            if spread_s == "":          # no book / un-priceable -> executor rejects
                dropped[mtype] = dropped.get(mtype, 0) + 1
                continue
            spread = float(spread_s)
            no_mid = 1.0 - yes
            real_cost = (spread / 2.0) / no_mid           # = entry_cost_pct fraction
            if spread <= 0 or real_cost > MAX_ENTRY_COST: # flb_0d ceiling
                dropped[mtype] = dropped.get(mtype, 0) + 1
                continue
            # add back the flat cost the shadow subtracted, charge the real one
            realistic_net = stored_net + SHADOW_FLAT_COST - real_cost
            types.append(mtype)
            net.append(realistic_net)
            kept_by_type[mtype] = kept_by_type.get(mtype, 0) + 1
    return np.array(types), np.array(net), seen_by_type, kept_by_type, dropped


def normpdf_log(x, mu, sd):
    return -0.5 * np.log(2 * np.pi * sd * sd) - 0.5 * ((x - mu) / sd) ** 2


def grid_posterior(ybar, se, mu_grid, tau_grid, s_tau, have_data):
    """Return joint posterior P(mu,tau) on the grid (normalised)."""
    MU, TAU = np.meshgrid(mu_grid, tau_grid, indexing="ij")
    logp = np.zeros_like(MU)
    # likelihood from data-bearing groups: ybar_j ~ N(mu, se_j^2 + tau^2)
    for j in range(len(ybar)):
        if not have_data[j]:
            continue
        sd = np.sqrt(se[j] ** 2 + TAU ** 2)
        logp += normpdf_log(ybar[j], MU, sd)
    # tau ~ HalfNormal(0, s_tau); mu ~ flat
    logp += -0.5 * (TAU / s_tau) ** 2
    logp -= logp.max()
    post = np.exp(logp)
    post /= post.sum()
    return post


def theta_posterior(ybar_j, se_j, has_data, mu_grid, tau_grid, post, theta_grid):
    """Exact grid-weighted mixture posterior for one theta_j over theta_grid."""
    dens = np.zeros_like(theta_grid)
    for i, mu in enumerate(mu_grid):
        for k, tau in enumerate(tau_grid):
            w = post[i, k]
            if w == 0:
                continue
            if has_data:
                prec = 1.0 / se_j ** 2 + 1.0 / tau ** 2
                m = (ybar_j / se_j ** 2 + mu / tau ** 2) / prec
                s = np.sqrt(1.0 / prec)
            else:
                m, s = mu, tau
            dens += w * np.exp(normpdf_log(theta_grid, m, s))
    dens /= dens.sum()
    return dens


def summarise(theta_grid, dens):
    mean = np.sum(theta_grid * dens)
    cdf = np.cumsum(dens)
    q = lambda p: theta_grid[np.searchsorted(cdf, p)]
    p_gt0 = np.sum(dens[theta_grid > 0])
    p_gt_hurdle = np.sum(dens[theta_grid > COST_HURDLE])
    return mean, q(0.05), q(0.95), p_gt0, p_gt_hurdle


def main():
    types, pnl, seen, kept, dropped = load(CSV)
    order = ["crypto_daily", "event_financial", "event_short", "event_long"]
    n = {t: int(np.sum(types == t)) for t in order}
    ybar = {t: (float(np.mean(pnl[types == t])) if n[t] > 0 else 0.0) for t in order}

    print("=" * 72)
    print("FLB hierarchical edge — REALISTIC per-signal spread cost + executor filter")
    print("=" * 72)
    print(f"Re-cost: realistic_net = shadow_net + {SHADOW_FLAT_COST} - (spread/2)/(1-yes)")
    print(f"Executor filter (flb_0d): keep only signals with real entry cost <= {MAX_ENTRY_COST:.0%}\n")
    print(f"{'type':<18}{'seen':>6}{'kept':>6}{'dropped':>9}")
    for t in order:
        print(f"{t:<18}{seen.get(t,0):>6}{kept.get(t,0):>6}{dropped.get(t,0):>9}")
    if len(pnl) == 0:
        print("\nNO signals survive the realistic-cost entry filter. The executor would")
        print("have entered none of the resolved tradeable signals. No edge to estimate.")
        return

    sd_pool = float(np.std(pnl, ddof=1)) if len(pnl) > 1 else 0.1316
    se = {t: (sd_pool / np.sqrt(n[t]) if n[t] > 0 else np.inf) for t in order}
    have = {t: n[t] > 0 for t in order}

    print(f"\nSurvivors: {len(pnl)}   pooled per-trade sd: {sd_pool:.4f}")
    print(f"Build hurdle: realistic net edge > {COST_HURDLE:.0%}/trade\n")
    print(f"{'type':<18}{'n':>4}{'real mean':>11}{'se(pooled)':>12}")
    for t in order:
        se_disp = f"{se[t]:.4f}" if np.isfinite(se[t]) else "  inf"
        print(f"{t:<18}{n[t]:>4}{ybar[t]:>11.4f}{se_disp:>12}")
    print()

    mu_grid = np.linspace(-0.10, 0.20, 601)
    tau_grid = np.linspace(1e-4, 0.20, 400)
    theta_grid = np.linspace(-0.30, 0.40, 1401)

    ybar_a = np.array([ybar[t] for t in order])
    se_a = np.array([se[t] for t in order])
    have_a = np.array([have[t] for t in order])

    for label, s_tau in [("tight  N+(0,0.02)", 0.02),
                         ("medium N+(0,0.05)", 0.05),
                         ("loose  N+(0,0.10)", 0.10)]:
        post = grid_posterior(ybar_a, se_a, mu_grid, tau_grid, s_tau, have_a)
        # population mu posterior
        mu_marg = post.sum(axis=1)
        mu_mean = np.sum(mu_grid * mu_marg)
        mu_cdf = np.cumsum(mu_marg)
        mu_lo = mu_grid[np.searchsorted(mu_cdf, 0.05)]
        mu_hi = mu_grid[np.searchsorted(mu_cdf, 0.95)]
        # tau posterior mean (how much heterogeneity the data+prior support)
        tau_marg = post.sum(axis=0)
        tau_mean = np.sum(tau_grid * tau_marg)

        print("-" * 72)
        print(f"tau prior = {label}   (pooling strength)")
        print(f"  population mu (typical type edge): mean {mu_mean:+.4f}  "
              f"90% CrI [{mu_lo:+.4f}, {mu_hi:+.4f}]   posterior-mean tau {tau_mean:.4f}")
        for t in order:
            j = order.index(t)
            dens = theta_posterior(ybar[t], se[t], have[t], mu_grid, tau_grid, post, theta_grid)
            mean, lo, hi, pg0, pgh = summarise(theta_grid, dens)
            if have[t]:
                shrink = np.sum([post[i, k] * (tau_grid[k] ** 2 / (tau_grid[k] ** 2 + se[t] ** 2))
                                 for i in range(len(mu_grid)) for k in range(len(tau_grid))])
                shr = f"keeps {shrink:.0%} own data"
            else:
                shr = "prior-only (no data)"
            tag = "TRADEABLE" if t in TRADEABLE else "ref"
            print(f"  [{tag:<9}] {t:<16} edge {mean:+.4f}  90% CrI [{lo:+.4f},{hi:+.4f}]  "
                  f"P(>0)={pg0:.2f} P(>1%)={pgh:.2f}  {shr}")
        # tradeable predictive: a NEW tradeable-type trade ~ N(mu, tau^2)
        pred = np.zeros_like(theta_grid)
        for i, mu in enumerate(mu_grid):
            for k, tau in enumerate(tau_grid):
                w = post[i, k]
                if w:
                    pred += w * np.exp(normpdf_log(theta_grid, mu, tau))
        pred /= pred.sum()
        m, lo, hi, pg0, pgh = summarise(theta_grid, pred)
        print(f"  => TRADEABLE predictive (new type): edge {m:+.4f}  90% CrI [{lo:+.4f},{hi:+.4f}]  "
              f"P(>0)={pg0:.2f}  P(>1%)={pgh:.2f}")
    print("-" * 72)
    print("Reading it: mu is the partial-pooled 'typical type' edge (event_long-dominated).")
    print("event_financial shrinks toward mu; crypto_daily/event_short are prior-only.")
    print("Compare P(>0)/P(>1%) and CrI width across tau priors: the wider they move,")
    print("the more the verdict rests on the cross-type-similarity ASSUMPTION, not data.")


if __name__ == "__main__":
    main()
