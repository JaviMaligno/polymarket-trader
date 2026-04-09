# Design: Adaptive OOS Validation Gate

**Date:** 2026-04-09
**Status:** Approved
**Context:** Optimizer finds better params but OOS gate blocks deployment due to fixed thresholds

## Problem Statement

The OOS walkforward validation gate in `OptimizationScheduler` uses fixed absolute thresholds (`minOOSSharpe: 0.3`, `minOOSWinRate: 0.40`). When the system performs poorly (6% win rate), no parameter set can pass validation on recent data — even if the new params are significantly better than what's currently running. This creates a catch-22: the system can't improve because the gate demands performance it can only achieve after improving.

## Design: IS/OOS Consistency Test

Replace absolute thresholds with a **consistency test**: "Is the OOS performance consistent with the in-sample performance, or does it collapse (indicating overfitting)?"

The question shifts from "are these params good enough?" (absolute) to "are these params real?" (consistency). The optimizer already selected the best params — the gate only needs to confirm the result isn't overfit.

### Core Mechanism

```
decay_factor = percentile_25(historical OOS/IS ratios)

deploy if: OOS_sharpe >= IS_sharpe * decay_factor
```

The `decay_factor` is the 25th percentile of the empirical distribution of `OOS_score / IS_score` ratios from past optimization runs. This means: "accept degradation up to the level seen in 75% of past runs."

It adapts automatically:
- If the system improves and IS→OOS degradation shrinks, the factor rises (more permissive)
- If overfitting worsens, the factor drops (more restrictive)

### Cold Start

Until 10 runs with both `best_score` and `oos_score` exist, use `decay_factor = 0.3` (conservative default). After 10 runs, the empirical distribution takes over.

### Safety Floor (fixed, non-adaptive)

Absolute minimums that never adapt — red de seguridad against degenerate scenarios:

| Guard | Threshold | Rationale |
|---|---|---|
| `oosScore >= -1.0` | Reject severely negative OOS Sharpe | |
| `abs(drawdownOOS) <= 0.50` | Reject catastrophic drawdown | |
| `tradesOOS >= 20` | Minimum data for statistical signal | System produces ~135 trades/day, 4-day OOS ≈ 500 trades. 20 is well below normal but filters degenerate backtests |
| `IS_sharpe > 0` | Don't validate negative in-sample | If in-sample is negative, nothing to validate |

### Edge Cases

| Case | Behavior |
|---|---|
| IS_sharpe ≤ 0 | Don't deploy — nothing to validate |
| OOS has < 20 trades | Don't deploy — insufficient data |
| All historical ratios are negative | decay_factor = 0.3 (cold start fallback) |
| IS_sharpe very high (>5) | No special handling. decay_factor naturally demands proportionally high OOS. E.g., IS=5.0, factor=0.45 → needs OOS ≥ 2.25, which is extremely hard to achieve with real data |

## Changes

### Database

New column on `optimization_runs`:

```sql
ALTER TABLE optimization_runs ADD COLUMN oos_score double precision;
```

### `WALKFORWARD_CONFIG`

Remove as deploy gate. Keep `oosPeriodDays` and `trainingPeriodDays` for period definitions. Remove `minOOSSharpe`, `minOOSWinRate`, `minOOSTrades` (replaced by adaptive gate + safety floor).

### `validateOnOOS()` (line ~567-652)

Currently: runs OOS backtest, compares against fixed thresholds.

New behavior:
1. Run OOS backtest → get `oosScore` (Sharpe), `drawdownOOS`, `tradesOOS`
2. Apply safety floor (fixed guards above)
3. Compute `decayFactor` from historical runs
4. Compare `oosScore >= isScore * decayFactor`
5. Return passed/failed with reason

Signature change: receives `isScore` (the in-sample Sharpe of the candidate params).

### New function: `computeDecayFactor()`

```sql
SELECT best_score, oos_score FROM optimization_runs
WHERE status = 'completed' AND oos_score IS NOT NULL AND best_score > 0
ORDER BY created_at DESC LIMIT 30
```

Compute `ratio = oos_score / best_score` for each row. Return percentile 25 of the ratios. If fewer than 10 rows, return 0.3.

### `updateStrategy()` (line ~657)

Receives `oosScore` to pass through to `saveOptimizationRun()`.

### `saveOptimizationRun()` (line ~812)

Saves `oos_score` in the new column.

### `runIncrementalOptimization()` / `runFullOptimization()`

After getting the best result, pass `isScore = best.sharpe` to `validateOnOOS()`. Existing `best.sharpe > this.state.bestSharpe` check remains as pre-filter before OOS validation.

## What Does NOT Change

- `result.totalReturn < -0.1` → skip (line 665) — independent safety check
- `best.sharpe > this.state.bestSharpe` pre-filter in incremental/full optimization
- `updateStrategy()` internal logic for applying weights to `signal_weights` table
- `OptunaClient` or optimizer server — no changes
- `OPTUNA_PARAM_SPACE` / `REFINEMENT_PARAM_SPACE` — no changes

## Success Criteria

1. `oos_score` populated in `optimization_runs` for all new completed runs
2. `computeDecayFactor()` returns empirical percentile when ≥10 runs have OOS data
3. Optimizer applies params when OOS is consistent with IS (no more catch-22)
4. Safety floor prevents catastrophic deployments
5. Fixed `WALKFORWARD_CONFIG` thresholds no longer gate deployment
