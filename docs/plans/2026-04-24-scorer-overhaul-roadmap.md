# Scorer Overhaul — Roadmap

**Date:** 2026-04-24
**Status:** Sub-project A in design; B and C deferred until A's effect is measured.

## Context

The `MarketScorer` composite score is used to rank all markets for tracking (which enter warming/active via `MarketRotator`). The `ScorerWeightOptimizer` cron (Mondays 03:17 UTC) tunes the composite weights against realized PnL via random search with Pearson correlation as the objective. The optimizer has been running correctly (last persistent run 2026-04-20, 1826 trades), but its reported best Pearson is **-0.04** — meaning no combination of the current dimension weights produces a score that predicts PnL.

This document captures the empirical investigation that led to a per-type redesign and the sequencing of work.

## Empirical investigation summary

Query set ran against production DB on 2026-04-24, 1829 closed trades with `score_dimensions_at_entry` populated, all post-reset (reset #12 on 2026-04-07).

### Global correlations of scorer dimensions with realized PnL

| Dimension | Pearson | Spearman |
|---|---|---|
| `tradeability` | -0.080 | +0.035 |
| `liquidity` | +0.001 | +0.063 |
| `ttr` | -0.050 | -0.101 |
| `volatility` | NULL at entry | — |
| `dataQuality` | NULL at entry | — |

`volatility` and `dataQuality` are never persisted at entry (only computed for tracked markets during Pass 2 scoring). The three dimensions that are persisted have near-zero global correlation.

### Per-market-type correlations

| market_type | n | tradeability | liquidity | ttr |
|---|---|---|---|---|
| event_long | 1290 | -0.039 | +0.049 | -0.075 |
| event_short | 386 | -0.179 | -0.074 | +0.014 |
| event_financial | 147 | +0.149 | +0.168 | -0.217 |

Key insight: the sign of each dimension's effect on PnL **varies by market type**. event_financial rewards tradeability and liquidity positively; event_short penalizes tradeability. Pooling all types into a global optimization averages these away. A per-type weight vector is the structural correction.

### Entry price bucket performance

For reference (interpretation below):

| avg_entry_price | n | avg_pnl | win_pct |
|---|---|---|---|
| 0–20% | 665 | +$66.21 | 24.5% |
| 20–40% | 359 | +$37.12 | 46.2% |
| 40–60% | 148 | −$7.08 | 13.5% |
| 60–80% | 319 | −$16.34 | 2.5% |
| 80–100% | 436 | −$3.63 | 3.9% |

Initial hypothesis: the `tradeabilityScore` (symmetric U-shape around 0.50) is wrong, because empirical PnL is asymmetric in `avg_entry_price`. On closer inspection, this was a misread. `avg_entry_price` is the token-price we paid (Yes price for LONG, No price for SHORT). The asymmetry means **buying cheap tokens wins regardless of side** — a signal already captured at execution via `direction_multiplier = -1`. At market selection time we only see the Yes price, and both "Yes price low" (cheap Yes for LONG) and "Yes price high" (cheap No for SHORT) are equally attractive. The current symmetric U-shape reflects this correctly. No change required.

### Category-level performance (already in DB)

| market_type | n | avg_pnl | sharpe_per_trade | current `prior` |
|---|---|---|---|---|
| event_financial | 159 | +$34.50 | 0.27 | 1.13 |
| event_short | 419 | +$33.08 | 0.13 | 1.06 |
| event_long | 1317 | +$22.53 | 0.17 | 1.09 |
| crypto_intraday | 7 | +$4.29 | 0.32 | 1.15 |
| crypto_daily | 4 | −$6.04 | −1.02 | 1.00 |

Type-level PnL differs by ~50% between best and worst tradeable types. This signal is the strongest predictor we have access to at scoring time. It is encoded in `category_performance.prior`, but `prior` is applied as a multiplier clustered in a narrow range (1.00–1.15), so its practical influence on market ranking is minimal.

## Corrected diagnosis

The scorer's underperformance comes from two compounding issues:

1. **Type-level signal is underweighted.** `prior` carries the strongest predictive information but its multiplicative effect is small relative to dimension variance.
2. **Dimension effects are type-specific and cancel in aggregation.** Optimizing a single global weight vector across types that have opposite-sign correlations produces -0.04 as a best-case.

The scorer's *shape* (tradeability curve, liquidity log-volume, TTR decay) is roughly correct. The *weighting* and *per-type handling* is the structural problem.

## Decomposition

Three sub-projects, each its own spec / plan / implementation cycle. Numbered by intended execution order.

### Sub-project A: Per-type weights + `typeExpectedValue` dimension

Status: **in design** (see [2026-04-24-scorer-per-type-weights-design.md](./2026-04-24-scorer-per-type-weights-design.md)).

Two coupled changes delivered together:

1. **New dimension `typeExpectedValue`**: shrunk-Sharpe of the market's type, mapped to [0,1]. Wider range than the current `prior` multiplier (≈0.50–0.83 vs 1.00–1.15), letting the optimizer allocate meaningful weight.
2. **Per-type scoring weights**: `scorer_weights` table gains a `market_type` column; optimizer runs once per eligible type on that type's trade subset; `MarketScorer.loadWeights(marketType)` resolves per-type row with fallback to the global (NULL) row.

Why coupled: either change alone provides partial benefit, and per-type weights are the mechanism that lets `typeExpectedValue` carry different weight per type (event_financial may weight it heavily, event_long less if its type signal is noisier).

Expected impact: global Pearson moves from -0.04 to positive within 2 weeks of having retrained per-type weights. crypto markets enter warming organically via `typeExpectedValue ≈ 0.72`, removing the need for an explicit diversity quota.

### Sub-project B: New features

Status: **queued** behind A.

Candidate features to investigate, each requiring its own data path (compute, persist in `score_dimensions_at_entry`, measure correlation):

- **Realized volatility** of the last N price bars at entry.
- **Bid-ask spread** at entry (already in `markets.spread` but not in dims).
- **Signal confidence/strength** aggregates from the signal engine at entry.
- **Consensus among signal generators** (how many agreed on direction).

Each feature lands as its own PR once A is stable. Keep each addition small: calculate, persist, observe correlation over 2+ weeks before committing it to the composite.

### Sub-project C: Deferred / conditional

Status: **conditional on A's result**.

- If A brings Pearson to >+0.10, no further structural work is obviously required — focus shifts to B.
- If A plateaus below +0.10, consider alternative objectives (Spearman, top-quantile selection PnL) or formula changes (non-linear composition).
- The "diversity quota" for `MarketRotator` explored earlier this week is shelved — expected to become redundant once A lands.

## Rejected alternatives (documented for future reference)

- **Asymmetric tradeability curve**: rejected after realizing the asymmetry observed in `avg_entry_price` reflects a token-price-regardless-of-side effect that the execution layer (direction multiplier) already handles. Market selection correctly sees both extremes as tradeable.
- **Raw `entry_price` as direct scorer dimension**: same reason — the information is already captured downstream at execution.
- **Quota-driven market-type allocation in rotator**: shelved. Forcing diversity without evidence of profit contradicts the first-principles goal. A correctly calibrated scorer should produce the right diversity automatically.

## Sequencing

1. Ship Sub-project A. Wait 2 weeks for optimizer to retrain on new feature.
2. Measure (queries in A's success-metric section).
3. If metrics hit gate (Pearson > 0), proceed to B. Otherwise, investigate C.
4. Each feature in B: add, measure for 2 weeks, keep or drop.

Out of scope for this roadmap: any change to the signal engine, direction multiplier, or execution pipeline.
