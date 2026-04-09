# Adaptive OOS Validation Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fixed OOS thresholds with an IS/OOS consistency test using an empirical decay factor, so the optimizer can apply params that are genuinely better than current, even when absolute performance is poor.

**Architecture:** Single file change (`OptimizationScheduler.ts`) + DB migration. The `validateOnOOS()` method receives the IS Sharpe, computes a decay factor from historical OOS/IS ratios (p25), and gates on `OOS >= IS * decay_factor` instead of fixed thresholds. OOS scores are persisted to `optimization_runs.oos_score` for the historical distribution.

**Tech Stack:** TypeScript, PostgreSQL, Vitest

**Spec:** `docs/plans/2026-04-09-adaptive-oos-gate-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `packages/data-collector/src/database/init/014_oos_score_column.sql` | Add `oos_score` column to `optimization_runs` |
| Modify | `packages/dashboard/src/services/OptimizationScheduler.ts` | All logic changes: WALKFORWARD_CONFIG cleanup, validateOnOOS rewrite, computeDecayFactor, OOS score persistence |
| Create | `packages/dashboard/src/services/OptimizationScheduler.oos.test.ts` | Tests for computeDecayFactor and adaptive gate logic |

---

### Task 1: Database Migration

**Files:**
- Create: `packages/data-collector/src/database/init/014_oos_score_column.sql`

- [ ] **Step 1: Create migration file**

```sql
-- Migration 014: Add oos_score column to optimization_runs
--
-- Stores the out-of-sample Sharpe ratio for each optimization run.
-- Used by the adaptive OOS gate to compute the empirical decay factor
-- (p25 of historical OOS/IS ratios).

ALTER TABLE optimization_runs ADD COLUMN IF NOT EXISTS oos_score double precision;
```

- [ ] **Step 2: Apply migration on VM**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c 'ALTER TABLE optimization_runs ADD COLUMN IF NOT EXISTS oos_score double precision;'"
```

Expected: `ALTER TABLE`

- [ ] **Step 3: Verify column exists**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c '\d optimization_runs' | grep oos_score"
```

Expected: `oos_score | double precision`

- [ ] **Step 4: Commit**

```bash
git add packages/data-collector/src/database/init/014_oos_score_column.sql
git commit -m "feat: add oos_score column to optimization_runs for adaptive gate"
```

---

### Task 2: Tests for computeDecayFactor and adaptive gate

**Files:**
- Create: `packages/dashboard/src/services/OptimizationScheduler.oos.test.ts`

- [ ] **Step 1: Write tests**

```typescript
import { describe, it, expect } from 'vitest';

/**
 * Standalone computeDecayFactor for testing — mirrors the implementation.
 * Takes array of { bestScore, oosScore } rows, returns p25 of ratios.
 */
function computeDecayFactor(
  rows: Array<{ bestScore: number; oosScore: number }>,
  coldStartDefault = 0.3,
  minRows = 10,
): number {
  if (rows.length < minRows) return coldStartDefault;

  const ratios = rows
    .filter(r => r.bestScore > 0)
    .map(r => r.oosScore / r.bestScore)
    .sort((a, b) => a - b);

  if (ratios.length < minRows) return coldStartDefault;

  const idx = Math.floor(ratios.length * 0.25);
  return ratios[idx];
}

/**
 * Standalone adaptive OOS gate for testing — mirrors the implementation.
 */
function shouldDeploy(
  isScore: number,
  oosScore: number,
  drawdownOOS: number,
  tradesOOS: number,
  decayFactor: number,
): { passed: boolean; reason?: string } {
  // Safety floor
  if (isScore <= 0) return { passed: false, reason: 'IS Sharpe <= 0' };
  if (tradesOOS < 20) return { passed: false, reason: `Trades ${tradesOOS} < 20` };
  if (oosScore < -1.0) return { passed: false, reason: `OOS Sharpe ${oosScore} < -1.0` };
  if (Math.abs(drawdownOOS) > 0.50) return { passed: false, reason: `Drawdown ${drawdownOOS} > 50%` };

  // Adaptive gate
  const threshold = isScore * decayFactor;
  if (oosScore >= threshold) return { passed: true };
  return { passed: false, reason: `OOS ${oosScore.toFixed(3)} < IS ${isScore.toFixed(3)} * decay ${decayFactor.toFixed(3)} = ${threshold.toFixed(3)}` };
}

describe('computeDecayFactor', () => {
  it('returns cold start default when fewer than 10 rows', () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({ bestScore: 1.0, oosScore: 0.5 }));
    expect(computeDecayFactor(rows)).toBe(0.3);
  });

  it('returns p25 of ratios when enough data', () => {
    // 12 rows with ratios: [0.1, 0.2, 0.3, 0.4, 0.5, 0.5, 0.6, 0.7, 0.8, 0.8, 0.9, 1.0]
    const ratios = [0.1, 0.2, 0.3, 0.4, 0.5, 0.5, 0.6, 0.7, 0.8, 0.8, 0.9, 1.0];
    const rows = ratios.map(r => ({ bestScore: 1.0, oosScore: r }));
    // p25 index = floor(12 * 0.25) = 3 → ratios[3] = 0.4
    expect(computeDecayFactor(rows)).toBe(0.4);
  });

  it('filters out rows with bestScore <= 0', () => {
    const goodRows = Array.from({ length: 10 }, () => ({ bestScore: 1.0, oosScore: 0.6 }));
    const badRows = [{ bestScore: 0, oosScore: 0.5 }, { bestScore: -1, oosScore: 0.3 }];
    expect(computeDecayFactor([...goodRows, ...badRows])).toBe(0.6);
  });

  it('returns cold start when all bestScores are <= 0', () => {
    const rows = Array.from({ length: 15 }, () => ({ bestScore: -0.5, oosScore: 0.1 }));
    expect(computeDecayFactor(rows)).toBe(0.3);
  });

  it('handles negative OOS/IS ratios correctly', () => {
    // Some runs overfitted (negative OOS), some were consistent
    const rows = [
      ...Array.from({ length: 5 }, () => ({ bestScore: 1.0, oosScore: -0.5 })),  // ratio -0.5
      ...Array.from({ length: 5 }, () => ({ bestScore: 1.0, oosScore: 0.8 })),   // ratio 0.8
      ...Array.from({ length: 2 }, () => ({ bestScore: 1.0, oosScore: 0.3 })),   // ratio 0.3
    ];
    // sorted ratios: [-0.5, -0.5, -0.5, -0.5, -0.5, 0.3, 0.3, 0.8, 0.8, 0.8, 0.8, 0.8]
    // p25 index = floor(12 * 0.25) = 3 → -0.5
    expect(computeDecayFactor(rows)).toBe(-0.5);
  });
});

describe('shouldDeploy (adaptive OOS gate)', () => {
  const defaultDecay = 0.3;

  it('rejects when IS Sharpe <= 0', () => {
    const result = shouldDeploy(0, 0.5, 0.1, 50, defaultDecay);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('IS Sharpe <= 0');
  });

  it('rejects when trades < 20', () => {
    const result = shouldDeploy(1.0, 0.5, 0.1, 15, defaultDecay);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('Trades 15 < 20');
  });

  it('rejects when OOS Sharpe < -1.0', () => {
    const result = shouldDeploy(1.0, -1.5, 0.1, 50, defaultDecay);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('OOS Sharpe');
  });

  it('rejects when drawdown > 50%', () => {
    const result = shouldDeploy(1.0, 0.5, -0.55, 50, defaultDecay);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('Drawdown');
  });

  it('passes when OOS >= IS * decay', () => {
    // IS=1.0, decay=0.3, threshold=0.3, OOS=0.4 → pass
    const result = shouldDeploy(1.0, 0.4, 0.1, 50, 0.3);
    expect(result.passed).toBe(true);
  });

  it('rejects when OOS < IS * decay', () => {
    // IS=1.0, decay=0.5, threshold=0.5, OOS=0.3 → fail
    const result = shouldDeploy(1.0, 0.3, 0.1, 50, 0.5);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('OOS 0.300 < IS 1.000 * decay 0.500');
  });

  it('handles high IS Sharpe naturally (no special case)', () => {
    // IS=5.0, decay=0.45, threshold=2.25, OOS=2.0 → fail (naturally strict)
    const result = shouldDeploy(5.0, 2.0, 0.1, 50, 0.45);
    expect(result.passed).toBe(false);
  });

  it('works with negative decay factor', () => {
    // decay=-0.5, IS=1.0, threshold=-0.5 → even slightly negative OOS passes
    const result = shouldDeploy(1.0, -0.3, 0.1, 50, -0.5);
    expect(result.passed).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd /c/Users/Usuario/GitHub/polymarket-trader && npx vitest run packages/dashboard/src/services/OptimizationScheduler.oos.test.ts`
Expected: All 13 tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/dashboard/src/services/OptimizationScheduler.oos.test.ts
git commit -m "test: add tests for adaptive OOS gate and computeDecayFactor"
```

---

### Task 3: Implement adaptive OOS gate

**Files:**
- Modify: `packages/dashboard/src/services/OptimizationScheduler.ts`

This task has 4 sub-changes in the same file. Apply them all, then test and commit.

- [ ] **Step 1: Replace WALKFORWARD_CONFIG**

Replace lines 83-98:

```typescript
const WALKFORWARD_CONFIG = {
  /** Total data period in days */
  totalPeriodDays: 14,
  /** Out-of-sample validation period in days */
  oosPeriodDays: 4,
  /** Training period in days (totalPeriodDays - oosPeriodDays) */
  trainingPeriodDays: 10,
  /** Minimum Sharpe ratio on OOS data to approve deployment */
  minOOSSharpe: 0.0,
  /** Maximum drawdown on OOS data */
  maxOOSDrawdown: 0.25,
  /** Minimum trades on OOS period */
  minOOSTrades: 5,
  /** Minimum win rate on OOS period */
  minOOSWinRate: 0.15,
};
```

With:

```typescript
const WALKFORWARD_CONFIG = {
  /** Total data period in days */
  totalPeriodDays: 14,
  /** Out-of-sample validation period in days */
  oosPeriodDays: 4,
  /** Training period in days (totalPeriodDays - oosPeriodDays) */
  trainingPeriodDays: 10,
};

// Adaptive OOS gate: safety floor (fixed, non-adaptive)
const OOS_SAFETY_FLOOR = {
  /** Minimum OOS Sharpe — reject severely negative */
  minSharpe: -1.0,
  /** Maximum OOS drawdown — reject catastrophic */
  maxDrawdown: 0.50,
  /** Minimum trades in OOS for statistical signal */
  minTrades: 20,
};

// Decay factor cold start: used when fewer than 10 runs have OOS data
const DECAY_FACTOR_COLD_START = 0.3;
const DECAY_FACTOR_MIN_ROWS = 10;
```

- [ ] **Step 2: Rewrite `validateOnOOS` to accept `isScore` and use adaptive gate**

Replace the entire `validateOnOOS` method (lines 569-652) with:

```typescript
  private async validateOnOOS(params: Record<string, any>, isScore: number): Promise<OOSValidationResult> {
    // Gate: don't validate negative in-sample
    if (isScore <= 0) {
      return { passed: false, sharpeOOS: 0, drawdownOOS: 0, tradesOOS: 0, winRateOOS: 0, reason: 'IS Sharpe <= 0, nothing to validate' };
    }

    const now = new Date();
    const oosEndDate = now;
    const oosStartDate = new Date(now.getTime() - WALKFORWARD_CONFIG.oosPeriodDays * 24 * 60 * 60 * 1000);

    console.log(`[OptimizationScheduler] Running OOS validation from ${oosStartDate.toISOString().slice(0, 10)} to ${oosEndDate.toISOString().slice(0, 10)} (IS Sharpe: ${isScore.toFixed(3)})`);

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
        return { passed: false, sharpeOOS: 0, drawdownOOS: 1, tradesOOS: 0, winRateOOS: 0, reason: 'Backtest failed to produce results' };
      }

      const metrics = backtest.result.metrics;
      const trades = backtest.result.trades?.length || 0;
      const oosScore = metrics.sharpeRatio || 0;
      const drawdown = Math.abs(metrics.maxDrawdown || 0);

      // Safety floor checks
      if (trades < OOS_SAFETY_FLOOR.minTrades) {
        return { passed: false, sharpeOOS: oosScore, drawdownOOS: metrics.maxDrawdown, tradesOOS: trades, winRateOOS: metrics.winRate, reason: `Trades ${trades} < ${OOS_SAFETY_FLOOR.minTrades}` };
      }
      if (oosScore < OOS_SAFETY_FLOOR.minSharpe) {
        return { passed: false, sharpeOOS: oosScore, drawdownOOS: metrics.maxDrawdown, tradesOOS: trades, winRateOOS: metrics.winRate, reason: `OOS Sharpe ${oosScore.toFixed(3)} < ${OOS_SAFETY_FLOOR.minSharpe}` };
      }
      if (drawdown > OOS_SAFETY_FLOOR.maxDrawdown) {
        return { passed: false, sharpeOOS: oosScore, drawdownOOS: metrics.maxDrawdown, tradesOOS: trades, winRateOOS: metrics.winRate, reason: `Drawdown ${(drawdown * 100).toFixed(1)}% > ${OOS_SAFETY_FLOOR.maxDrawdown * 100}%` };
      }

      // Adaptive consistency gate
      const decayFactor = await this.computeDecayFactor();
      const threshold = isScore * decayFactor;
      const passed = oosScore >= threshold;

      let reason: string | undefined;
      if (!passed) {
        reason = `OOS ${oosScore.toFixed(3)} < IS ${isScore.toFixed(3)} * decay ${decayFactor.toFixed(3)} = ${threshold.toFixed(3)}`;
      }

      console.log(`[OptimizationScheduler] OOS validation: Sharpe=${oosScore.toFixed(3)}, decay=${decayFactor.toFixed(3)}, threshold=${threshold.toFixed(3)}, ${passed ? 'PASSED' : 'FAILED'}`);

      return { passed, sharpeOOS: oosScore, drawdownOOS: metrics.maxDrawdown, tradesOOS: trades, winRateOOS: metrics.winRate, reason };
    } catch (error) {
      console.error('[OptimizationScheduler] OOS validation failed:', error);
      return { passed: false, sharpeOOS: 0, drawdownOOS: 1, tradesOOS: 0, winRateOOS: 0, reason: `Validation error: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
```

- [ ] **Step 3: Add `computeDecayFactor` method**

Add this method right after `validateOnOOS`:

```typescript
  /**
   * Compute adaptive decay factor from historical OOS/IS ratios.
   * Returns the 25th percentile of ratios, or cold-start default if insufficient data.
   */
  private async computeDecayFactor(): Promise<number> {
    if (!isDatabaseConfigured()) return DECAY_FACTOR_COLD_START;

    try {
      const result = await query<{ best_score: number; oos_score: number }>(`
        SELECT best_score, oos_score FROM optimization_runs
        WHERE status = 'completed' AND oos_score IS NOT NULL AND best_score > 0
        ORDER BY created_at DESC LIMIT 30
      `);

      if (result.rows.length < DECAY_FACTOR_MIN_ROWS) {
        console.log(`[OptimizationScheduler] Decay factor: cold start (${result.rows.length}/${DECAY_FACTOR_MIN_ROWS} rows)`);
        return DECAY_FACTOR_COLD_START;
      }

      const ratios = result.rows
        .map(r => r.oos_score / r.best_score)
        .sort((a, b) => a - b);

      const idx = Math.floor(ratios.length * 0.25);
      const factor = ratios[idx];
      console.log(`[OptimizationScheduler] Decay factor: ${factor.toFixed(3)} (p25 of ${ratios.length} ratios)`);
      return factor;
    } catch (error) {
      console.error('[OptimizationScheduler] Failed to compute decay factor:', error);
      return DECAY_FACTOR_COLD_START;
    }
  }
```

- [ ] **Step 4: Update `updateStrategy` to pass `isScore` and persist OOS score**

In `updateStrategy` (line ~657), change the call to `validateOnOOS` from:

```typescript
    const oosResult = await this.validateOnOOS(result.params);
```

To:

```typescript
    const oosResult = await this.validateOnOOS(result.params, result.sharpe);

    // Persist OOS score for decay factor history (even if gate failed)
    if (isDatabaseConfigured()) {
      try {
        await query(`
          UPDATE optimization_runs SET oos_score = $1
          WHERE status = 'completed' AND oos_score IS NULL
          ORDER BY completed_at DESC LIMIT 1
        `, [oosResult.sharpeOOS]);
      } catch (err) {
        console.error('[OptimizationScheduler] Failed to persist OOS score:', err);
      }
    }
```

- [ ] **Step 5: Run all tests**

Run: `cd /c/Users/Usuario/GitHub/polymarket-trader && npx vitest run`
Expected: All tests pass (530+ existing + 13 new)

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/src/services/OptimizationScheduler.ts
git commit -m "feat: adaptive OOS validation gate with empirical decay factor

Replace fixed OOS thresholds (minOOSSharpe, minOOSWinRate) with an
IS/OOS consistency test. Deploy if OOS_sharpe >= IS_sharpe * decay_factor,
where decay_factor is the p25 of historical OOS/IS ratios. Safety floor
prevents catastrophic deployments. Cold start default 0.3."
```

---

### Task 4: Deploy and Verify

- [ ] **Step 1: Push**

```bash
gh auth switch --user JaviMaligno
git push origin main
```

- [ ] **Step 2: Deploy to VM**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="cd /home/Usuario/polymarket-trader && git pull && docker compose -f docker-compose.gcp.yml up -d --force-recreate dashboard-api"
```

- [ ] **Step 3: Verify logs show adaptive gate**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker logs polymarket-dashboard-api 2>&1 | grep -i 'decay\|adaptive\|OOS validation' | tail -5"
```

Expected: Log line with `Decay factor: cold start` (first run won't have history yet) or `Decay factor: X.XXX`.

- [ ] **Step 4: Verify OOS score column populated after next optimization cycle**

Wait for next optimization run (~6h), then:

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c 'SELECT best_score, oos_score, created_at FROM optimization_runs WHERE status = '\''completed'\'' ORDER BY created_at DESC LIMIT 3;'"
```

Expected: Most recent run has `oos_score` populated (not NULL).
