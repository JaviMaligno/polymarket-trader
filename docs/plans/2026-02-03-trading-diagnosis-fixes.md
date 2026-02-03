# Trading System Diagnosis & Fixes

**Date:** 2026-02-03
**Status:** Diagnosis complete, fixes pending
**Context:** System lost 21.6% ($2,159) in ~35 paper trades. All trades concentrated in 1 market, 100% LONG, win/loss counters broken, optimizer producing 0 signals.

## Findings Summary

### 1. CRITICAL: SignalEngine inverts SHORT signal strength

**File:** `packages/dashboard/src/services/SignalEngine.ts:457`

`Math.abs(output.strength)` converts negative strength (SHORT indicator) to positive, making all signals appear LONG. The direction field says 'short' but strength says 'long'.

**Fix:** Remove `Math.abs()`. Pass `output.strength` directly. Downstream code already handles negative values correctly.

### 2. CRITICAL: Optimizer parameters never reach backtest

**File:** `packages/dashboard/src/services/OptimizationScheduler.ts:227`

`runOptimization()` generates `minEdge`/`minConfidence` combinations but never passes them to `backtestService.runBacktest()`. Every backtest runs with identical defaults. The Python Optuna server (port 8000) is completely unused.

**Fix (phase 1):** Pass generated params to `runBacktest()` config. Remove unused Python optimizer service from docker-compose.
**Fix (phase 2):** Either integrate Optuna properly or replace with the scheduler's own search.

### 3. CRITICAL: Backtest default `onlyDirection: 'SHORT'`

**File:** `packages/backtest/src/index.ts:179`

Default config forces SHORT-only in backtests. Live system has no direction filter. Backtest results are irrelevant to live behavior.

**Fix:** Change default to `undefined` (both directions). If SHORT-only is desired, pass it explicitly.

### 4. HIGH: No signal deduplication / market concentration limit

**Files:**
- `packages/dashboard/src/services/AutoSignalExecutor.ts`
- `packages/dashboard/src/services/RiskManager.ts`

Same signal for same market can trigger multiple trades within seconds. No per-market position limit exists.

**Fix:**
- Add `processedSignals: Map<string, number>` to AutoSignalExecutor with market+direction key and timestamp. Skip signals for same market within 5-minute window.
- Add `maxPositionPerMarket` check in RiskManager (e.g., max 1 open position per market).

### 5. MEDIUM: Win/loss tracking broken

**Files:**
- `packages/dashboard/src/services/AutoSignalExecutor.ts:289,393`
- `packages/dashboard/src/api/routes.ts:1328,1387`

BUY increments `total_trades` but not win/loss counters. Some position close paths skip the win/loss UPDATE entirely. Two parallel trading code paths (API routes vs AutoSignalExecutor) with inconsistent counter logic.

**Fix:** Consolidate position close logic into single function. Increment `total_trades`, `winning_trades`, `losing_trades` all on position close only.

### 6. MEDIUM: Thresholds too permissive

**File:** `packages/dashboard/src/services/AutoSignalExecutor.ts`

`minConfidence: 0.40` and `minStrength: 0.05` let almost any signal through.

**Fix:** Increase to `minConfidence: 0.55`, `minStrength: 0.20`. Add signal filtering in SignalEngine before sending to automation.

## Implementation Order

1. Fix `Math.abs(strength)` in SignalEngine (1 line change)
2. Fix `onlyDirection: 'SHORT'` default in backtest config
3. Add signal deduplication in AutoSignalExecutor
4. Add per-market concentration limit in RiskManager
5. Fix win/loss counter logic
6. Increase thresholds
7. Pass optimizer params to backtest (or remove dead optimizer)
8. Remove Python optimizer from docker-compose if not integrating

## Files to Modify

- `packages/dashboard/src/services/SignalEngine.ts`
- `packages/backtest/src/index.ts`
- `packages/dashboard/src/services/AutoSignalExecutor.ts`
- `packages/dashboard/src/services/RiskManager.ts`
- `packages/dashboard/src/api/routes.ts`
- `docker-compose.gcp.yml` (remove optimizer if unused)
