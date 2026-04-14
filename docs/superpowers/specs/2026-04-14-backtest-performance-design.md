# Backtest Performance Optimizations

**Date:** 2026-04-14
**Status:** Approved

## Problem

Each optimizer trial takes ~7 min on the e2-micro VM (0.25 vCPU). 15 incremental trials = 105 min per run. The bottleneck is algorithmic (not CPU): signals recompute indicators over 1693-bar arrays every tick, and data is reloaded from DB per trial.

## Optimizations

### 1. Signal bar window slice

**Where:** `BacktestEngine`, where `SignalContext.priceBars` is constructed for each `signal.compute()` call.

**Current:** `priceBars: [...cache.bars, cache.currentBar]` — copies entire bar history (up to 1693 bars) every call. Each indicator (RSI, MACD, Bollinger) then iterates the full array.

**Fix:** Slice to last 100 bars:
```typescript
const MAX_LOOKBACK = 100;
const allBars = [...cache.bars, cache.currentBar];
priceBars: allBars.length > MAX_LOOKBACK ? allBars.slice(-MAX_LOOKBACK) : allBars
```

**Why 100:** Largest indicator lookback in codebase: Hurst filter (50 bars). MACD signal line needs 35. 100 gives 2x margin. All backtest-active signals (momentum, mean_reversion) use max 35.

**Impact:** ~4.5 min → ~1 min signal computation (1693→100 elements per compute call, 241 ticks × 20 markets × 2 signals).

**Files:** `packages/dashboard/src/services/BacktestEngine.ts`

### 2. Data loading cache across trials

**Where:** `OptimizationScheduler` trial loop + `BacktestService.runBacktest()`.

**Current:** Each trial calls `BacktestService.fetchHistoricalData()` — 2 DB queries (market selection + full price history). 15 trials over the same training period = 15× identical queries.

**Fix:**
- New method `BacktestService.preloadData(startDate, endDate)` that executes the 2 queries once and returns parsed `MarketData[]`.
- `runBacktest()` accepts optional `preloadedData?: MarketData[]`. If present, skips DB queries.
- `OptimizationScheduler.runOptunaOptimization()` calls `preloadData()` once before the trial loop, passes result to each `runBacktest()`.

**Impact:** 15 DB round-trips → 1. Saves ~1 min per 15-trial run (90s per query × 14 eliminated).

**Files:** `packages/dashboard/src/services/BacktestService.ts`, `packages/dashboard/src/services/OptimizationScheduler.ts`

### 3. Render keep-alive ping

**Where:** `OptimizationScheduler.start()`.

**Current:** Optuna server on Render free tier sleeps after 15 min. First call per run has 30-60s cold start. Runs happen every 6h → always cold.

**Fix:** `setInterval(() => optunaClient.ping(), 4 * 60 * 1000)` in `start()`, cleared in `stop()`.

**Impact:** 30-60s saved per run. Trivial implementation (5 lines).

**Files:** `packages/dashboard/src/services/OptimizationScheduler.ts`

## Expected Result

| Metric | Before | After |
|--------|--------|-------|
| Signal computation | ~4.5 min/trial | ~1 min/trial |
| Data loading | ~90s/trial | ~90s total (1 query) |
| Render cold start | 30-60s/run | 0 |
| **Per trial** | **~7 min** | **~2-3 min** |
| **15-trial run** | **~105 min** | **~35-45 min** |

## Non-Goals

- Moving backtest to Render (future work if A is insufficient)
- Incremental indicator caching (future work if slice window is insufficient)
- Parallelizing trials (blocked by 0.25 vCPU single-core)
- Reducing training period or trial count
