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

Status: A shipped 2026-04-24 (PR #125 + #126); B.1 in design.

Decomposed into four parallel sub-projects after brainstorming. Each lands as its own spec / plan / PR. They do not block each other except where noted.

**B.1 — Realized volatility as scorer dim** — *in design*
- Spec: [2026-04-24-realized-volatility-design.md](./2026-04-24-realized-volatility-design.md).
- Extends `ScoreDimensions` with a nullable `realizedVolatility` dim fed by a 15-min compute job over `price_history`. Reuses all A infrastructure (per-type weights, optimizer loop, backfill pattern).

**B.2 — Signal-generator consensus** — *queued*
- Requires `SignalEngine` instrumentation to expose per-generator outputs pre-combine. New `consensus` dim measures how many generators agreed on direction.
- Heavier than B.1 because it touches the signal layer, not just the scorer. Queue after B.1 lands so we do not mix signal-layer churn with scorer dim churn during measurement.

**B.3 — Signal confidence/strength analysis** — *parallelizable with B.1 or B.2*
- Different layer: signal confidence/strength is a per-trade feature, not a per-market feature. Does not plug into MarketScorer.
- Capture `signal.confidence` and `signal.strength` at position-open in `paper_positions.metadata` (or a sibling column), run correlation analysis against realized PnL, and feed results back into the combiner thresholds (`minCombinedConfidence`, `minCombinedStrength`) or signal weights — not the market scorer.
- Its own spec / plan; does not share code paths with B.1/B.2 so can run concurrently.

**B.4 — Bid-ask spread as scorer dim** — *deferred*
- Pre-check on 2026-04-24 (n=1829 closed trades, post-reset): spread has Pearson -0.025 with PnL globally and is moderately collinear with liquidity (-0.26). Marginal signal over liquidity judged insufficient to justify the added dim.
- Not dropped forever — revisit if B.2 or another source suggests spread matters more than current measurement shows, or if we want to capture time-of-entry spread explicitly (current check uses current spread, which is an approximation).

Each feature is additive. A's infrastructure tolerates null dims gracefully; adding a feature that turns out non-predictive costs only a slightly larger hyperparameter search space for the optimizer. Dropping a feature later is a one-line code revert plus leaving harmless schema columns.

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

Originally: "Ship A, wait 2 weeks, then B." Revised after shipping A: waiting is passive time-for-data-accumulation, not a development-gate. B can be built in parallel with A's OOS observation. A's infrastructure is additive — B's features extend the same dim set without invalidating A's results, and a non-predictive feature just receives weight ~0 from the optimizer.

Current plan:

1. A shipped 2026-04-24. Infrastructure validated (global Pearson in-sample +0.408). OOS measurement proceeds continuously in the background via weekly retrains.
2. B.1 (realized volatility) in design immediately. Ships as a standalone PR that plugs into A's infrastructure.
3. B.2 (signal consensus) queued behind B.1 — same scorer, but signal-layer changes increase risk. Sequence it so we do not mix dim-churn with signal-layer-churn during measurement.
4. B.3 (signal confidence analysis) can run in parallel with B.1 or B.2 — different code paths (no shared files).
5. B.4 (spread) deferred until empirical conditions change.

Each sub-project still follows spec → plan → implementation per its own cycle. Measurement: 2+ weeks per feature to accumulate enough OOS trades for an honest correlation read. Features that show weight ~0 in the optimizer after two full training cycles can be removed to simplify the search space.

Out of scope for this roadmap: any change to the signal engine, direction multiplier, or execution pipeline.
