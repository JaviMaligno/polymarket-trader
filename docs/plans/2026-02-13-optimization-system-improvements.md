# Optimization System Improvements

## Overview

This document outlines improvements to the trading strategy optimization system to address overfitting, exploration, deployment safety, and resource usage.

## Problems Identified

### Critical Issues
1. **Very few iterations** (5-10) - TPE needs 50-100+ for 12 parameters
2. **Short backtest period** (7 days) - Easy to overfit
3. **No out-of-sample validation** - Direct deployment without testing
4. **Permissive parameter ranges** - `minConfidence` as low as 0.1
5. **Single objective (Sharpe)** - Can be gamed with few trades

### Design Issues
6. Limited parameter space (12 of ~45)
7. Aggressive auto-deployment (5% improvement triggers deploy)
8. No walk-forward validation
9. ValidationService unused
10. No feature importance analysis

---

## Solution 1: Avoid Overfitting

### Walk-Forward Validation

```
┌─────────────────────────────────────────────────────────────┐
│                    HISTORICAL DATA (30 days)                 │
├─────────────┬─────────────┬─────────────┬───────────────────┤
│  Fold 1     │  Fold 2     │  Fold 3     │  Fold 4 (OOS)     │
│  Train      │  Train      │  Train      │  Validation       │
│  (7 days)   │  (7 days)   │  (7 days)   │  (7 days)         │
└─────────────┴─────────────┴─────────────┴───────────────────┘
```

### Changes

**File: `packages/dashboard/src/services/OptimizationScheduler.ts`**

1. Extend data period from 7 to 30 days
2. Split into 3 training folds + 1 validation fold
3. Only deploy if parameters work on OOS fold
4. Add variance penalty across folds

**File: `packages/optimizer/src/core/ObjectiveFunctions.ts`**

Update constraints:
```typescript
constraints: {
  minTrades: 15,           // Up from 10
  maxDrawdown: 0.20,       // Down from 0.25
  minWinRate: 0.45,        // Up from 0.40
  maxSharpeVariance: 0.5,  // NEW
}
```

**File: `packages/dashboard/src/services/OptimizationScheduler.ts`**

More conservative parameter ranges:
```typescript
// Current: low: 0.1, high: 0.6
// Proposed:
{ name: 'combiner.minCombinedConfidence', low: 0.25, high: 0.65 }
{ name: 'combiner.minCombinedStrength', low: 0.20, high: 0.60 }
```

---

## Solution 2: Better Exploration

### Two-Phase Optimization

**Phase 1: Wide Exploration (weekly)**
- 50 iterations with LEAN_PARAMETER_SPACE (15 params)
- Covers combiner, risk, and signal parameters

**Phase 2: Local Refinement (every 6h)**
- 15 iterations around best parameters
- Only 8 most sensitive parameters
- Reduced range: ±20% of current value

### Changes

**File: `packages/dashboard/src/services/OptimizationScheduler.ts`**

```typescript
// Current
private incrementalIterations = 5;
private fullIterations = 10;

// Proposed
private incrementalIterations = 15;
private fullIterations = 50;
private fullIntervalHours = 168;  // Weekly
```

**New refinement parameter space:**
```typescript
const REFINEMENT_PARAM_SPACE: ParameterDef[] = [
  'combiner.minCombinedConfidence',
  'combiner.minCombinedStrength',
  'combiner.momentumWeight',
  'combiner.meanReversionWeight',
  'risk.maxPositionSizePct',
  'risk.stopLossPct',
  'momentum.rsiPeriod',
  'meanReversion.zScoreThreshold',
];
```

**Increase startup trials:**
```typescript
nStartupTrials: Math.ceil(iterations * 0.3)  // 30% random exploration
```

---

## Solution 3: Better Deployment

### Deployment Pipeline with Gates

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  Optimizer  │───▶│  Validation │───▶│   Shadow    │───▶│  Production │
│  finds      │    │  OOS Test   │    │   Period    │    │   Deploy    │
│  candidate  │    │  (7 days)   │    │  (24-48h)   │    │             │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
```

### Gate 1: Out-of-Sample Validation

**New file: `packages/dashboard/src/services/DeploymentValidator.ts`**

```typescript
interface ValidationResult {
  passed: boolean;
  sharpeOOS: number;
  drawdownOOS: number;
  tradesOOS: number;
  winRateOOS: number;
  reason?: string;
}

async function validateCandidate(params: Record<string, any>): Promise<ValidationResult> {
  const oosResult = await backtestService.runBacktest({
    startDate: getOOSStartDate(),  // Last 7 days not used in training
    endDate: new Date().toISOString(),
    ...mapParamsToRequest(params)
  });

  const passed = (
    oosResult.metrics.sharpeRatio >= 0.3 &&
    oosResult.metrics.maxDrawdown <= 0.20 &&
    oosResult.trades.length >= 10 &&
    oosResult.metrics.winRate >= 0.40
  );

  return {
    passed,
    sharpeOOS: oosResult.metrics.sharpeRatio,
    drawdownOOS: oosResult.metrics.maxDrawdown,
    tradesOOS: oosResult.trades.length,
    winRateOOS: oosResult.metrics.winRate,
    reason: passed ? undefined : 'Failed OOS validation thresholds'
  };
}
```

### Gate 2: Shadow Period

```typescript
interface ShadowCandidate {
  params: Record<string, any>;
  startedAt: Date;
  virtualTrades: Trade[];
  actualTrades: Trade[];
  status: 'shadow' | 'promoted' | 'rejected';
}

class ShadowTracker {
  private candidates: Map<string, ShadowCandidate> = new Map();

  async startShadow(params: Record<string, any>): Promise<string>;
  async recordVirtualTrade(candidateId: string, trade: Trade): Promise<void>;
  async evaluateShadow(candidateId: string): Promise<'promote' | 'reject' | 'continue'>;
}
```

### Automatic Rollback

```typescript
// If drawdown > 15% within 24h of deployment
if (currentDrawdown > 0.15 && hoursSinceDeploy < 24) {
  await rollbackToPreviousParams();
  state.deploymentStatus = 'rolled_back';
  notifyAdmin('Automatic rollback triggered');
}
```

---

## Solution 4: Performance & Resources

### 1. Price Data Cache

**New file: `packages/dashboard/src/services/BacktestDataCache.ts`**

```typescript
class BacktestDataCache {
  private priceCache: Map<string, HistoricalBar[]> = new Map();
  private cacheExpiry: number = 30 * 60 * 1000; // 30 min

  async getPriceBars(marketId: string, start: Date, end: Date): Promise<HistoricalBar[]>;
  clearExpired(): void;
  getMemoryUsage(): number;
}
```

### 2. Batch Processing with Delays

```typescript
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 30000;  // 30s between batches

for (let batch = 0; batch < Math.ceil(iterations / BATCH_SIZE); batch++) {
  for (let i = 0; i < BATCH_SIZE; i++) {
    await runSingleTrial();
    await sleep(backtestDelayMs);  // 5s between trials
  }

  if (batch < totalBatches - 1) {
    global.gc?.();
    await sleep(BATCH_DELAY_MS);
  }
}
```

### 3. Reduced Market Count for Optimization

```typescript
const OPTIMIZATION_MARKET_COUNT = 10;  // vs 20 in production
```

### 4. Adaptive Granularity

```typescript
function getOptimalGranularity(periodDays: number): number {
  if (periodDays <= 7) return 60;   // 1h
  if (periodDays <= 14) return 120; // 2h
  return 240;                        // 4h
}
```

### 5. Nighttime Optimization

```typescript
private shouldRunFull(now: Date): boolean {
  const hour = now.getUTCHours();
  const isNighttime = hour >= 2 && hour <= 6;  // 2-6 UTC
  return this.shouldRunFullBySchedule(now) && isNighttime;
}
```

### 6. VM Health Monitoring

**New: Health alerts during optimization**

```typescript
interface VMHealthCheck {
  memoryUsagePct: number;
  cpuUsagePct: number;
  isHealthy: boolean;
}

async function checkVMHealth(): Promise<VMHealthCheck> {
  const memUsage = process.memoryUsage();
  const memoryPct = memUsage.heapUsed / memUsage.heapTotal;

  return {
    memoryUsagePct: memoryPct * 100,
    cpuUsagePct: await getCPUUsage(),
    isHealthy: memoryPct < 0.85  // Pause if >85% memory
  };
}

// In optimization loop:
if (!(await checkVMHealth()).isHealthy) {
  console.warn('[Optimizer] VM under pressure, pausing optimization');
  await sleep(60000);  // 1 min pause
  global.gc?.();
}
```

### Resource Estimates

| Metric | Current | Proposed | Improvement |
|--------|---------|----------|-------------|
| Data per backtest | ~200k bars | ~80k bars | -60% |
| Time per trial | ~45s | ~20s | -55% |
| Full optimization | N/A (10 trials) | 50 trials × 20s = 17 min | Feasible |
| Peak RAM | >800MB | ~500MB | -37% |

---

## Implementation Order

1. **Phase 1: Anti-Overfitting** (Priority)
   - Extend backtest period to 30 days
   - Implement walk-forward validation
   - Update parameter ranges
   - Add OOS validation gate

2. **Phase 2: Better Exploration**
   - Increase iterations (15/50)
   - Implement two-phase optimization
   - Add REFINEMENT_PARAM_SPACE

3. **Phase 3: Safe Deployment**
   - Create DeploymentValidator
   - Implement shadow period tracking
   - Add automatic rollback

4. **Phase 4: Resource Optimization**
   - Implement BacktestDataCache
   - Add batch processing with delays
   - Add VM health monitoring
   - Configure nighttime optimization

---

## Files to Modify

| File | Changes |
|------|---------|
| `packages/dashboard/src/services/OptimizationScheduler.ts` | Main changes: iterations, periods, validation |
| `packages/optimizer/src/core/ObjectiveFunctions.ts` | Stricter constraints |
| `packages/optimizer/src/core/ParameterSpace.ts` | Add REFINEMENT_PARAM_SPACE |
| `packages/dashboard/src/services/BacktestService.ts` | Add caching, reduce markets |

## New Files

| File | Purpose |
|------|---------|
| `packages/dashboard/src/services/DeploymentValidator.ts` | OOS validation + shadow tracking |
| `packages/dashboard/src/services/BacktestDataCache.ts` | Price data caching |
| `packages/dashboard/src/utils/vmHealth.ts` | VM monitoring utilities |

---

## Success Criteria

1. **Overfitting**: Parameters that pass OOS validation should have >60% correlation between backtest and live performance
2. **Exploration**: Best Sharpe should improve by >20% after implementing better exploration
3. **Deployment**: Zero rollbacks due to parameter failures in first month
4. **Resources**: Full optimization completes in <20 minutes without VM issues

---

## Monitoring Requirements

- Weekly review of optimization logs
- Alert if VM memory >85% during optimization
- Track OOS validation pass rate
- Compare backtest vs live performance monthly
