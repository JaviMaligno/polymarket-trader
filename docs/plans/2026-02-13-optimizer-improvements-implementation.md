# Optimizer Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve the trading strategy optimizer to prevent overfitting, enable better exploration, ensure safe deployment, and optimize resource usage on e2-micro VM.

**Architecture:** Four-phase improvement: (1) Walk-forward validation with conservative parameter ranges, (2) Two-phase optimization with more iterations, (3) Deployment pipeline with OOS validation and shadow period, (4) Resource optimization with caching and health monitoring.

**Tech Stack:** TypeScript, Node.js, PostgreSQL/TimescaleDB, Optuna (Python server)

**Worktree:** `C:\Users\Usuario\GitHub\polymarket-trader\.worktrees\optimizer-improvements`

---

## Phase 1: Anti-Overfitting

### Task 1.1: Update Parameter Ranges to Conservative Values

**Files:**
- Modify: `packages/dashboard/src/services/OptimizationScheduler.ts:36-53`

**Step 1: Update OPTUNA_PARAM_SPACE with conservative ranges**

Find the `OPTUNA_PARAM_SPACE` constant and update these ranges:

```typescript
const OPTUNA_PARAM_SPACE: ParameterDef[] = [
  // Combiner thresholds - MORE CONSERVATIVE
  { name: 'combiner.minCombinedConfidence', type: 'float', low: 0.25, high: 0.65 },
  { name: 'combiner.minCombinedStrength', type: 'float', low: 0.20, high: 0.60 },
  { name: 'combiner.onlyDirection', type: 'categorical', choices: [null, 'LONG', 'SHORT'] },
  { name: 'combiner.momentumWeight', type: 'float', low: 0.2, high: 1.5 },
  { name: 'combiner.meanReversionWeight', type: 'float', low: 0.2, high: 1.5 },
  // Risk - slightly tighter
  { name: 'risk.maxPositionSizePct', type: 'float', low: 3.0, high: 15.0 },
  { name: 'risk.maxPositions', type: 'int', low: 5, high: 15 },
  { name: 'risk.stopLossPct', type: 'float', low: 8.0, high: 30.0 },
  { name: 'risk.takeProfitPct', type: 'float', low: 15.0, high: 80.0 },
  // Momentum signal
  { name: 'momentum.rsiPeriod', type: 'int', low: 10, high: 21 },
  // Mean reversion signal
  { name: 'meanReversion.bollingerPeriod', type: 'int', low: 15, high: 30 },
  { name: 'meanReversion.zScoreThreshold', type: 'float', low: 1.5, high: 2.5 },
];
```

**Step 2: Build and verify no TypeScript errors**

Run:
```bash
cd /c/Users/Usuario/GitHub/polymarket-trader/.worktrees/optimizer-improvements
pnpm --filter @polymarket-trader/dashboard build
```

Expected: Build succeeds with no errors

**Step 3: Commit**

```bash
git add packages/dashboard/src/services/OptimizationScheduler.ts
git commit -m "feat(optimizer): use conservative parameter ranges to reduce overfitting"
```

---

### Task 1.2: Extend Backtest Period and Add OOS Validation Config

**Files:**
- Modify: `packages/dashboard/src/services/OptimizationScheduler.ts`

**Step 1: Add configuration constants for walk-forward validation**

Add after the `OPTUNA_PARAM_SPACE` definition (around line 55):

```typescript
// Walk-forward validation configuration
const WALKFORWARD_CONFIG = {
  /** Total data period in days */
  totalPeriodDays: 30,
  /** Out-of-sample validation period in days */
  oosPeriodDays: 7,
  /** Training period in days (totalPeriodDays - oosPeriodDays) */
  trainingPeriodDays: 23,
  /** Minimum Sharpe ratio on OOS data to approve deployment */
  minOOSSharpe: 0.3,
  /** Maximum drawdown on OOS data */
  maxOOSDrawdown: 0.20,
  /** Minimum trades on OOS period */
  minOOSTrades: 10,
  /** Minimum win rate on OOS period */
  minOOSWinRate: 0.40,
};
```

**Step 2: Build to verify**

Run:
```bash
pnpm --filter @polymarket-trader/dashboard build
```

Expected: Build succeeds

**Step 3: Commit**

```bash
git add packages/dashboard/src/services/OptimizationScheduler.ts
git commit -m "feat(optimizer): add walk-forward validation configuration"
```

---

### Task 1.3: Implement OOS Validation Method

**Files:**
- Modify: `packages/dashboard/src/services/OptimizationScheduler.ts`

**Step 1: Add validation result interface**

Add after `WALKFORWARD_CONFIG`:

```typescript
interface OOSValidationResult {
  passed: boolean;
  sharpeOOS: number;
  drawdownOOS: number;
  tradesOOS: number;
  winRateOOS: number;
  reason?: string;
}
```

**Step 2: Add validateOnOOS method to OptimizationScheduler class**

Add this method inside the class (before `updateStrategy`):

```typescript
  /**
   * Validate parameters on out-of-sample data
   */
  private async validateOnOOS(params: Record<string, any>): Promise<OOSValidationResult> {
    const now = new Date();
    // OOS period: last 7 days (data NOT used in training)
    const oosEndDate = now;
    const oosStartDate = new Date(now.getTime() - WALKFORWARD_CONFIG.oosPeriodDays * 24 * 60 * 60 * 1000);

    console.log(`[OptimizationScheduler] Running OOS validation from ${oosStartDate.toISOString().slice(0,10)} to ${oosEndDate.toISOString().slice(0,10)}`);

    try {
      const request = this.optunaClient
        ? this.mapOptunaParamsToRequest(params, oosStartDate, oosEndDate)
        : {
            startDate: oosStartDate.toISOString(),
            endDate: oosEndDate.toISOString(),
            initialCapital: 10000,
            signalTypes: ['momentum', 'mean_reversion'],
            riskConfig: { maxPositionSizePct: 10, maxExposurePct: 50 },
            signalFilters: {
              minStrength: params.minEdge ?? params['combiner.minCombinedStrength'] ?? 0.2,
              minConfidence: params.minConfidence ?? params['combiner.minCombinedConfidence'] ?? 0.3,
            },
          };

      const backtest = await this.backtestService.runBacktest(request);

      if (!backtest.result || !backtest.result.metrics) {
        return {
          passed: false,
          sharpeOOS: 0,
          drawdownOOS: 1,
          tradesOOS: 0,
          winRateOOS: 0,
          reason: 'Backtest failed to produce results',
        };
      }

      const metrics = backtest.result.metrics;
      const trades = backtest.result.trades?.length || 0;

      const passed = (
        metrics.sharpeRatio >= WALKFORWARD_CONFIG.minOOSSharpe &&
        Math.abs(metrics.maxDrawdown) <= WALKFORWARD_CONFIG.maxOOSDrawdown &&
        trades >= WALKFORWARD_CONFIG.minOOSTrades &&
        metrics.winRate >= WALKFORWARD_CONFIG.minOOSWinRate
      );

      let reason: string | undefined;
      if (!passed) {
        const failures: string[] = [];
        if (metrics.sharpeRatio < WALKFORWARD_CONFIG.minOOSSharpe) {
          failures.push(`Sharpe ${metrics.sharpeRatio.toFixed(2)} < ${WALKFORWARD_CONFIG.minOOSSharpe}`);
        }
        if (Math.abs(metrics.maxDrawdown) > WALKFORWARD_CONFIG.maxOOSDrawdown) {
          failures.push(`Drawdown ${(Math.abs(metrics.maxDrawdown) * 100).toFixed(1)}% > ${WALKFORWARD_CONFIG.maxOOSDrawdown * 100}%`);
        }
        if (trades < WALKFORWARD_CONFIG.minOOSTrades) {
          failures.push(`Trades ${trades} < ${WALKFORWARD_CONFIG.minOOSTrades}`);
        }
        if (metrics.winRate < WALKFORWARD_CONFIG.minOOSWinRate) {
          failures.push(`WinRate ${(metrics.winRate * 100).toFixed(1)}% < ${WALKFORWARD_CONFIG.minOOSWinRate * 100}%`);
        }
        reason = failures.join(', ');
      }

      return {
        passed,
        sharpeOOS: metrics.sharpeRatio,
        drawdownOOS: metrics.maxDrawdown,
        tradesOOS: trades,
        winRateOOS: metrics.winRate,
        reason,
      };
    } catch (error) {
      console.error('[OptimizationScheduler] OOS validation failed:', error);
      return {
        passed: false,
        sharpeOOS: 0,
        drawdownOOS: 1,
        tradesOOS: 0,
        winRateOOS: 0,
        reason: `Validation error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
```

**Step 3: Build to verify**

Run:
```bash
pnpm --filter @polymarket-trader/dashboard build
```

Expected: Build succeeds

**Step 4: Commit**

```bash
git add packages/dashboard/src/services/OptimizationScheduler.ts
git commit -m "feat(optimizer): implement OOS validation method"
```

---

### Task 1.4: Integrate OOS Validation into Deployment

**Files:**
- Modify: `packages/dashboard/src/services/OptimizationScheduler.ts`

**Step 1: Update updateStrategy method to use OOS validation**

Find the `updateStrategy` method and replace it with:

```typescript
  private async updateStrategy(result: OptimizationResult): Promise<void> {
    // Basic sanity checks
    if (result.sharpe > 8) {
      console.log(`[OptimizationScheduler] Extremely high Sharpe ${result.sharpe.toFixed(2)}, proceeding with caution`);
    }
    if (result.trades < 5) {
      console.log(`[OptimizationScheduler] Few trades (${result.trades}), allowing for paper trading`);
    }
    if (result.totalReturn < -0.1) {
      console.log(`[OptimizationScheduler] Negative return (${(result.totalReturn * 100).toFixed(1)}%), skipping deployment`);
      return;
    }

    // OOS Validation Gate
    console.log('[OptimizationScheduler] Running OOS validation before deployment...');
    const oosResult = await this.validateOnOOS(result.params);

    if (!oosResult.passed) {
      console.log(`[OptimizationScheduler] OOS validation FAILED: ${oosResult.reason}`);
      console.log(`[OptimizationScheduler] OOS metrics: Sharpe=${oosResult.sharpeOOS.toFixed(2)}, DD=${(oosResult.drawdownOOS * 100).toFixed(1)}%, Trades=${oosResult.tradesOOS}, WR=${(oosResult.winRateOOS * 100).toFixed(1)}%`);
      return;
    }

    console.log(`[OptimizationScheduler] OOS validation PASSED: Sharpe=${oosResult.sharpeOOS.toFixed(2)}, Trades=${oosResult.tradesOOS}`);
    console.log('[OptimizationScheduler] Deploying optimized strategy...');

    // Update local state
    this.state.bestParams = result.params;
    this.state.bestSharpe = result.sharpe;

    // Save to DB
    if (isDatabaseConfigured()) {
      try {
        await query(`
          UPDATE optimization_runs
          SET best_params = $1, best_score = $2, completed_at = NOW(), status = 'completed'
          WHERE status = 'running'
        `, [JSON.stringify(result.params), result.sharpe]);
      } catch (error) {
        console.error('[OptimizationScheduler] Failed to update optimization_runs:', error);
      }
    }

    // Extract minEdge/minConfidence (works for both Optuna and grid params)
    const minEdge = result.params['combiner.minCombinedStrength']
      ?? result.params.minEdge
      ?? DEFAULT_BEST_PARAMS.minEdge;
    const minConfidence = result.params['combiner.minCombinedConfidence']
      ?? result.params.minConfidence
      ?? DEFAULT_BEST_PARAMS.minConfidence;

    // Update active strategy via API
    try {
      const strategiesRes = await fetch(`${this.dashboardApiUrl}/api/strategies`);
      if (!strategiesRes.ok) {
        console.log('[OptimizationScheduler] Could not fetch strategies');
        return;
      }

      const strategiesData = await strategiesRes.json() as { data?: { strategies?: Array<{ id: string; status: string }> } };
      const strategies = strategiesData.data?.strategies || [];

      for (const strategy of strategies) {
        if (strategy.status === 'running') {
          await fetch(`${this.dashboardApiUrl}/api/strategies/${strategy.id}/stop`, { method: 'POST' });
        }
      }

      const createRes = await fetch(`${this.dashboardApiUrl}/api/strategies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'combo',
          name: `auto-opt-${new Date().toISOString().slice(0, 10)}`,
          minEdge,
          minConfidence,
          disableFilters: true,
        }),
      });

      if (createRes.ok) {
        const createData = await createRes.json() as { data?: { id?: string } };
        const strategyId = createData.data?.id;

        if (strategyId) {
          await fetch(`${this.dashboardApiUrl}/api/strategies/${strategyId}/start`, { method: 'POST' });
          console.log(`[OptimizationScheduler] Created and started strategy: ${strategyId}`);

          // Update executor runtime thresholds
          try {
            getTradingAutomation().getExecutor().updateConfig({
              minStrength: minEdge,
              minConfidence,
            });
            console.log(`[OptimizationScheduler] Updated executor: minStrength=${minEdge}, minConfidence=${minConfidence}`);
          } catch (err) {
            console.error('[OptimizationScheduler] Failed to update executor:', err);
          }
        }
      }
    } catch (error) {
      console.error('[OptimizationScheduler] Failed to update strategy:', error);
    }
  }
```

**Step 2: Build to verify**

Run:
```bash
pnpm --filter @polymarket-trader/dashboard build
```

Expected: Build succeeds

**Step 3: Commit**

```bash
git add packages/dashboard/src/services/OptimizationScheduler.ts
git commit -m "feat(optimizer): integrate OOS validation gate before deployment"
```

---

### Task 1.5: Update Training Period to Exclude OOS Data

**Files:**
- Modify: `packages/dashboard/src/services/OptimizationScheduler.ts`

**Step 1: Update runOptunaOptimization to use training period only**

Find the lines that set `startDate` and `endDate` in `runOptunaOptimization` (around line 255):

```typescript
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);
```

Replace with:

```typescript
    // Use training period only (exclude OOS period for honest validation)
    const now = new Date();
    const endDate = new Date(now.getTime() - WALKFORWARD_CONFIG.oosPeriodDays * 24 * 60 * 60 * 1000);
    const startDate = new Date(endDate.getTime() - WALKFORWARD_CONFIG.trainingPeriodDays * 24 * 60 * 60 * 1000);

    console.log(`[OptimizationScheduler] Training period: ${startDate.toISOString().slice(0,10)} to ${endDate.toISOString().slice(0,10)} (${WALKFORWARD_CONFIG.trainingPeriodDays} days)`);
```

**Step 2: Update runGridOptimization similarly**

Find the lines in `runGridOptimization`:

```typescript
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);
```

Replace with:

```typescript
    // Use training period only (exclude OOS period)
    const now = new Date();
    const endDate = new Date(now.getTime() - WALKFORWARD_CONFIG.oosPeriodDays * 24 * 60 * 60 * 1000);
    const startDate = new Date(endDate.getTime() - WALKFORWARD_CONFIG.trainingPeriodDays * 24 * 60 * 60 * 1000);
```

**Step 3: Build to verify**

Run:
```bash
pnpm --filter @polymarket-trader/dashboard build
```

Expected: Build succeeds

**Step 4: Commit**

```bash
git add packages/dashboard/src/services/OptimizationScheduler.ts
git commit -m "feat(optimizer): use training period that excludes OOS data"
```

---

## Phase 2: Better Exploration

### Task 2.1: Increase Iteration Counts

**Files:**
- Modify: `packages/dashboard/src/services/OptimizationScheduler.ts`

**Step 1: Update iteration and schedule configuration**

Find these lines (around line 87-92):

```typescript
  // Schedule configuration
  private incrementalIntervalHours = 6;
  private fullIntervalHours = 24;
  private incrementalIterations = 5;
  private fullIterations = 10;
  private backtestDelayMs = 5000;
```

Replace with:

```typescript
  // Schedule configuration
  private incrementalIntervalHours = 6;
  private fullIntervalHours = 168;  // Weekly instead of daily
  private incrementalIterations = 15;  // 3x more for better local search
  private fullIterations = 50;  // 5x more for proper exploration
  private backtestDelayMs = 5000;
```

**Step 2: Build to verify**

Run:
```bash
pnpm --filter @polymarket-trader/dashboard build
```

Expected: Build succeeds

**Step 3: Commit**

```bash
git add packages/dashboard/src/services/OptimizationScheduler.ts
git commit -m "feat(optimizer): increase iterations (15 incremental, 50 full) and make full weekly"
```

---

### Task 2.2: Add Refinement Parameter Space

**Files:**
- Modify: `packages/dashboard/src/services/OptimizationScheduler.ts`

**Step 1: Add refinement parameter space constant**

Add after `OPTUNA_PARAM_SPACE`:

```typescript
/**
 * Reduced parameter space for incremental refinement
 * Only the 8 most impactful parameters
 */
const REFINEMENT_PARAM_SPACE: ParameterDef[] = [
  { name: 'combiner.minCombinedConfidence', type: 'float', low: 0.25, high: 0.65 },
  { name: 'combiner.minCombinedStrength', type: 'float', low: 0.20, high: 0.60 },
  { name: 'combiner.momentumWeight', type: 'float', low: 0.2, high: 1.5 },
  { name: 'combiner.meanReversionWeight', type: 'float', low: 0.2, high: 1.5 },
  { name: 'risk.maxPositionSizePct', type: 'float', low: 3.0, high: 15.0 },
  { name: 'risk.stopLossPct', type: 'float', low: 8.0, high: 30.0 },
  { name: 'momentum.rsiPeriod', type: 'int', low: 10, high: 21 },
  { name: 'meanReversion.zScoreThreshold', type: 'float', low: 1.5, high: 2.5 },
];
```

**Step 2: Build to verify**

Run:
```bash
pnpm --filter @polymarket-trader/dashboard build
```

Expected: Build succeeds

**Step 3: Commit**

```bash
git add packages/dashboard/src/services/OptimizationScheduler.ts
git commit -m "feat(optimizer): add refinement parameter space (8 most impactful params)"
```

---

### Task 2.3: Use Refinement Space for Incremental Optimization

**Files:**
- Modify: `packages/dashboard/src/services/OptimizationScheduler.ts`

**Step 1: Update runOptunaOptimization to accept parameter space**

Find the method signature and add a parameter:

```typescript
  private async runOptunaOptimization(iterations: number, type: string, paramSpace?: ParameterDef[]): Promise<OptimizationResult[]> {
```

**Step 2: Use the parameter space in optimizer creation**

Find the line that creates the optimizer (around line 246):

```typescript
    const optimizerId = await client.createOptimizer(
      `${type}-${new Date().toISOString().slice(0, 10)}`,
      OPTUNA_PARAM_SPACE,
      { sampler: 'tpe', nStartupTrials: Math.min(3, iterations) }
    );
```

Replace with:

```typescript
    const effectiveParamSpace = paramSpace ?? OPTUNA_PARAM_SPACE;
    const nStartupTrials = Math.ceil(iterations * 0.3);  // 30% random exploration

    const optimizerId = await client.createOptimizer(
      `${type}-${new Date().toISOString().slice(0, 10)}`,
      effectiveParamSpace,
      { sampler: 'tpe', nStartupTrials }
    );

    console.log(`[OptimizationScheduler] Using ${effectiveParamSpace.length} parameters, ${nStartupTrials} startup trials`);
```

**Step 3: Update runOptimization to pass appropriate space**

Find the `runOptimization` method and update it:

```typescript
  private async runOptimization(iterations: number, type: 'incremental' | 'full'): Promise<OptimizationResult[]> {
    if (this.optunaClient) {
      // Use refinement space for incremental, full space for full optimization
      const paramSpace = type === 'incremental' ? REFINEMENT_PARAM_SPACE : OPTUNA_PARAM_SPACE;
      return this.runOptunaOptimization(iterations, type, paramSpace);
    }
    return this.runGridOptimization(iterations, type);
  }
```

**Step 4: Build to verify**

Run:
```bash
pnpm --filter @polymarket-trader/dashboard build
```

Expected: Build succeeds

**Step 5: Commit**

```bash
git add packages/dashboard/src/services/OptimizationScheduler.ts
git commit -m "feat(optimizer): use refinement space for incremental, full space for full optimization"
```

---

## Phase 3: Resource Optimization

### Task 3.1: Add VM Health Check Utility

**Files:**
- Create: `packages/dashboard/src/utils/vmHealth.ts`

**Step 1: Create the vmHealth utility file**

```typescript
/**
 * VM Health Monitoring Utilities
 *
 * Monitors memory and CPU usage to prevent VM overload during optimization.
 */

export interface VMHealthStatus {
  memoryUsagePct: number;
  heapUsedMB: number;
  heapTotalMB: number;
  isHealthy: boolean;
  shouldPause: boolean;
}

const MEMORY_WARNING_THRESHOLD = 0.75;  // 75%
const MEMORY_CRITICAL_THRESHOLD = 0.85; // 85%

/**
 * Check current VM health status
 */
export function checkVMHealth(): VMHealthStatus {
  const memUsage = process.memoryUsage();
  const heapUsedMB = memUsage.heapUsed / (1024 * 1024);
  const heapTotalMB = memUsage.heapTotal / (1024 * 1024);
  const memoryUsagePct = memUsage.heapUsed / memUsage.heapTotal;

  return {
    memoryUsagePct: memoryUsagePct * 100,
    heapUsedMB,
    heapTotalMB,
    isHealthy: memoryUsagePct < MEMORY_WARNING_THRESHOLD,
    shouldPause: memoryUsagePct >= MEMORY_CRITICAL_THRESHOLD,
  };
}

/**
 * Try to free memory via garbage collection
 */
export function tryFreeMemory(): void {
  if (global.gc) {
    global.gc();
    console.log('[VMHealth] Forced garbage collection');
  }
}

/**
 * Log current health status
 */
export function logHealthStatus(status: VMHealthStatus): void {
  const level = status.shouldPause ? 'CRITICAL' : status.isHealthy ? 'OK' : 'WARNING';
  console.log(`[VMHealth] ${level}: Memory ${status.memoryUsagePct.toFixed(1)}% (${status.heapUsedMB.toFixed(0)}MB / ${status.heapTotalMB.toFixed(0)}MB)`);
}
```

**Step 2: Build to verify**

Run:
```bash
pnpm --filter @polymarket-trader/dashboard build
```

Expected: Build succeeds

**Step 3: Commit**

```bash
git add packages/dashboard/src/utils/vmHealth.ts
git commit -m "feat(optimizer): add VM health monitoring utility"
```

---

### Task 3.2: Integrate Health Checks into Optimization Loop

**Files:**
- Modify: `packages/dashboard/src/services/OptimizationScheduler.ts`

**Step 1: Add import for vmHealth**

Add at the top of the file with other imports:

```typescript
import { checkVMHealth, tryFreeMemory, logHealthStatus } from '../utils/vmHealth.js';
```

**Step 2: Add batch configuration constants**

Add after `WALKFORWARD_CONFIG`:

```typescript
// Batch processing configuration for resource management
const BATCH_CONFIG = {
  /** Number of trials per batch */
  batchSize: 5,
  /** Delay between batches in ms */
  batchDelayMs: 30000,
  /** Pause duration when VM is under pressure */
  healthPauseMs: 60000,
};
```

**Step 3: Update the optimization loop in runOptunaOptimization**

Find the `for` loop in `runOptunaOptimization` and wrap it with batch processing:

Replace the loop section (from `for (let i = 0; i < iterations; i++)`) with:

```typescript
    try {
      for (let i = 0; i < iterations; i++) {
        // Health check at start of each batch
        if (i % BATCH_CONFIG.batchSize === 0) {
          const health = checkVMHealth();
          logHealthStatus(health);

          if (health.shouldPause) {
            console.log(`[OptimizationScheduler] VM under pressure, pausing for ${BATCH_CONFIG.healthPauseMs / 1000}s...`);
            tryFreeMemory();
            await new Promise(r => setTimeout(r, BATCH_CONFIG.healthPauseMs));
          } else if (i > 0) {
            // Batch delay between batches (not before first)
            console.log(`[OptimizationScheduler] Batch complete, waiting ${BATCH_CONFIG.batchDelayMs / 1000}s...`);
            tryFreeMemory();
            await new Promise(r => setTimeout(r, BATCH_CONFIG.batchDelayMs));
          }
        }

        if (i > 0 && i % BATCH_CONFIG.batchSize !== 0) {
          await new Promise(r => setTimeout(r, this.backtestDelayMs));
        }

        try {
          // 1. Get suggestion from Optuna
          const { trialId, params } = await client.suggest(optimizerId);
          console.log(`[OptimizationScheduler] Trial ${i + 1}/${iterations} (id=${trialId}):`, JSON.stringify(params));

          // 2. Map Optuna params → BacktestRequest
          const request = this.mapOptunaParamsToRequest(params, startDate, endDate);

          // 3. Run backtest
          const backtest = await this.backtestService.runBacktest(request);

          if (backtest.result && backtest.result.metrics) {
            const sharpe = backtest.result.metrics.sharpeRatio || 0;
            const totalReturn = backtest.result.metrics.totalReturn || 0;
            const trades = backtest.result.trades?.length || 0;

            // 4. Report score to Optuna
            await client.report(optimizerId, trialId, sharpe, {
              totalReturn,
              trades,
              maxDrawdown: backtest.result.metrics.maxDrawdown || 0,
            });

            results.push({ params, sharpe, totalReturn, trades });
            console.log(`[OptimizationScheduler] Trial ${i + 1} done: Sharpe=${sharpe.toFixed(2)}, Return=${(totalReturn * 100).toFixed(1)}%, Trades=${trades}`);
          }
        } catch (error) {
          console.error(`[OptimizationScheduler] Trial ${i + 1} failed:`, error);
        }
      }
```

**Step 4: Build to verify**

Run:
```bash
pnpm --filter @polymarket-trader/dashboard build
```

Expected: Build succeeds

**Step 5: Commit**

```bash
git add packages/dashboard/src/services/OptimizationScheduler.ts
git commit -m "feat(optimizer): add batch processing with health checks to prevent VM overload"
```

---

### Task 3.3: Add Nighttime Optimization Preference

**Files:**
- Modify: `packages/dashboard/src/services/OptimizationScheduler.ts`

**Step 1: Update shouldRunFull to prefer nighttime**

Find the `shouldRunFull` method and replace it:

```typescript
  private shouldRunFull(now: Date): boolean {
    if (!this.state.lastFullAt) return true;

    const hoursSince = (now.getTime() - this.state.lastFullAt.getTime()) / (1000 * 60 * 60);
    if (hoursSince < this.fullIntervalHours) {
      return false;
    }

    // Prefer nighttime (2-6 UTC) for full optimization to reduce load during active trading
    const hour = now.getUTCHours();
    const isNighttime = hour >= 2 && hour <= 6;

    if (!isNighttime && hoursSince < this.fullIntervalHours + 12) {
      // If not nighttime and we haven't waited too long, defer to nighttime
      return false;
    }

    return true;
  }
```

**Step 2: Build to verify**

Run:
```bash
pnpm --filter @polymarket-trader/dashboard build
```

Expected: Build succeeds

**Step 3: Commit**

```bash
git add packages/dashboard/src/services/OptimizationScheduler.ts
git commit -m "feat(optimizer): prefer nighttime for full optimization to reduce load"
```

---

## Phase 4: Final Integration

### Task 4.1: Update ObjectiveFunctions Constraints

**Files:**
- Modify: `packages/optimizer/src/core/ObjectiveFunctions.ts`

**Step 1: Update default objective config with stricter constraints**

Find `getDefaultObjectiveConfig` function and update it:

```typescript
export function getDefaultObjectiveConfig(): ObjectiveConfig {
  return {
    name: 'composite',
    compositeWeights: DEFAULT_COMPOSITE_WEIGHTS,
    constraints: {
      maxDrawdown: 0.20,    // Stricter: was 0.25
      minWinRate: 0.45,     // Stricter: was 0.40
      minProfitFactor: 1.1, // NEW: require profitable
    },
    minTrades: 15,          // Stricter: was 10
    maxAllowedDrawdown: 0.35, // Stricter: was 0.5
  };
}
```

**Step 2: Build to verify**

Run:
```bash
pnpm --filter @polymarket-trader/optimizer build
```

Expected: Build succeeds

**Step 3: Commit**

```bash
git add packages/optimizer/src/core/ObjectiveFunctions.ts
git commit -m "feat(optimizer): tighten objective function constraints"
```

---

### Task 4.2: Build and Verify All Packages

**Step 1: Full build**

Run:
```bash
cd /c/Users/Usuario/GitHub/polymarket-trader/.worktrees/optimizer-improvements
pnpm build
```

Expected: All 6 packages build successfully

**Step 2: Commit any remaining changes**

```bash
git status
# If clean, proceed. Otherwise:
git add -A
git commit -m "chore: final cleanup"
```

---

### Task 4.3: Create Summary Commit

**Step 1: View all commits in feature branch**

```bash
git log --oneline main..HEAD
```

**Step 2: Push branch to remote**

```bash
git push -u origin feature/optimizer-improvements
```

---

## Verification Checklist

After implementation, verify:

1. [ ] `pnpm build` passes for all packages
2. [ ] Parameter ranges are conservative (minConfidence >= 0.25)
3. [ ] Training uses 23 days, OOS uses 7 days
4. [ ] Iterations increased (15 incremental, 50 full)
5. [ ] OOS validation gate blocks bad params
6. [ ] Batch processing with health checks works
7. [ ] Nighttime preference for full optimization

---

## Deployment Notes

After merging to main:

1. Rebuild Docker image: `docker-compose -f docker-compose.gcp.yml build dashboard-api`
2. Push to GCP VM
3. Restart dashboard-api container
4. Monitor first optimization run via logs
5. Check VM memory usage during optimization
