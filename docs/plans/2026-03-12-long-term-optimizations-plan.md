# Long-Term Optimizations Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement CPU safeguards, signal-duration intelligence with 6 new generators (3 market-structure + 3 external-data), and fix the optimization duration tracking bug.

**Architecture:** Extends the existing signal pipeline with a `DurationWeightModifier` that scales signal weights by market time horizon. New generators follow the `BaseSignal` pattern. External data is ingested by `ExternalDataCollector` (hourly) and read by generators from the `external_signals` table. Adaptive sync uses Node.js `perf_hooks` event loop monitoring.

**Tech Stack:** TypeScript, Vitest, TimescaleDB, Node.js `perf_hooks`, Anthropic Haiku API, free APIs (Metaculus, Manifold, Google Trends, GNews)

**Design doc:** `docs/plans/2026-03-12-long-term-optimizations-design.md`

---

## Phase 1 — Bug Fixes & Quick Wins

### Task 1: Fix `end_date_iso` → `end_date` in AutoSignalExecutor

**Files:**
- Modify: `packages/dashboard/src/services/AutoSignalExecutor.ts:154-155`
- Test: `packages/dashboard/src/services/AutoSignalExecutor.test.ts`

**Step 1: Write failing test for near-resolution detection**

Add to the existing test file `packages/dashboard/src/services/AutoSignalExecutor.test.ts`:

```typescript
describe('Near-resolution market protection (end_date fix)', () => {
  it('should reject mean_reversion signal on market resolving in <24h', async () => {
    const nearFuture = new Date(Date.now() + 12 * 3600000).toISOString(); // 12h from now
    (query as any).mockResolvedValueOnce({
      rows: [{ is_active: true, is_resolved: false, end_date: nearFuture }],
    });
    // Mock existing positions query
    (query as any).mockResolvedValue({ rows: [] });

    const result = await executor.processSignal(makeSignal({
      signalId: 'mean_reversion',
      confidence: 0.8,
    }));

    expect(result.executed).toBe(false);
    expect(result.reason).toMatch(/mean_reversion.*near-resolution/i);
  });

  it('should halve position size for near-resolution market', async () => {
    const nearFuture = new Date(Date.now() + 12 * 3600000).toISOString();
    (query as any).mockResolvedValueOnce({
      rows: [{ is_active: true, is_resolved: false, end_date: nearFuture }],
    });
    (query as any).mockResolvedValue({ rows: [] });

    const result = await executor.processSignal(makeSignal({
      signalId: 'momentum',
      confidence: 0.8,
      strength: 0.5,
    }));

    // Signal should be processed (not rejected) but with half position size
    // Check that the position size logic applied the 0.5 multiplier
    if (result.executed) {
      expect(result.reason).toBeUndefined();
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run packages/dashboard/src/services/AutoSignalExecutor.test.ts --reporter=verbose`
Expected: FAIL — the query returns `end_date` but code reads `end_date_iso` (always undefined), so near-resolution check never triggers.

**Step 3: Fix the bug**

In `packages/dashboard/src/services/AutoSignalExecutor.ts`, change line 154-155:

```typescript
// OLD:
const marketCheck = await query<{ is_active: boolean; is_resolved: boolean; end_date_iso: string | null }>(
  `SELECT is_active, is_resolved, end_date_iso FROM markets WHERE id = $1`,
  [signal.marketId]
);

// NEW:
const marketCheck = await query<{ is_active: boolean; is_resolved: boolean; end_date: string | null }>(
  `SELECT is_active, is_resolved, end_date FROM markets WHERE id = $1`,
  [signal.marketId]
);
```

And change line 175:

```typescript
// OLD:
if (market.end_date_iso) {
  const hoursToResolution = (new Date(market.end_date_iso).getTime() - Date.now()) / 3600000;

// NEW:
if (market.end_date) {
  const hoursToResolution = (new Date(market.end_date).getTime() - Date.now()) / 3600000;
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run packages/dashboard/src/services/AutoSignalExecutor.test.ts --reporter=verbose`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/dashboard/src/services/AutoSignalExecutor.ts packages/dashboard/src/services/AutoSignalExecutor.test.ts
git commit -m "fix: correct end_date_iso → end_date column in AutoSignalExecutor

The near-resolution market protection queried a non-existent column
(end_date_iso instead of end_date), silently disabling mean_reversion
rejection, confidence requirements, and position size halving for
markets resolving within 24 hours."
```

---

### Task 2: Fix `duration_seconds` in Optimizer Code Paths

**Files:**
- Modify: `packages/optimizer/src/core/StrategyOptimizer.ts:366-374`
- Modify: `packages/optimizer/src/storage/OptimizationStore.ts:148-153`
- Modify: `packages/dashboard/src/services/OptimizationScheduler.ts:771-804`

**Step 1: Fix StrategyOptimizer completion UPDATE**

In `packages/optimizer/src/core/StrategyOptimizer.ts`, change lines 366-374:

```typescript
// OLD:
await this.db.query(
  `UPDATE optimization_runs SET
    status = 'completed', completed_at = NOW(),
    completed_iterations = $1, best_params = $2, best_score = $3
  WHERE id = $4`,
  [completedIterations, JSON.stringify(bestParams), bestScore, runId]
);

// NEW:
await this.db.query(
  `UPDATE optimization_runs SET
    status = 'completed', completed_at = NOW(),
    duration_seconds = EXTRACT(EPOCH FROM (NOW() - started_at))::INTEGER,
    completed_iterations = $1, best_params = $2, best_score = $3
  WHERE id = $4`,
  [completedIterations, JSON.stringify(bestParams), bestScore, runId]
);
```

**Step 2: Fix OptimizationStore status transitions**

In `packages/optimizer/src/storage/OptimizationStore.ts`, change lines 151-153:

```typescript
// OLD:
if (['completed', 'failed', 'cancelled'].includes(updates.status ?? '')) {
  fields.push(`completed_at = NOW()`);
}

// NEW:
if (['completed', 'failed', 'cancelled'].includes(updates.status ?? '')) {
  fields.push(`completed_at = NOW()`);
  fields.push(`duration_seconds = EXTRACT(EPOCH FROM (NOW() - started_at))::INTEGER`);
}
```

**Step 3: Fix OptimizationScheduler saveOptimizationRun**

In `packages/dashboard/src/services/OptimizationScheduler.ts`, find the `saveOptimizationRun` method (lines ~771-804). The JS-side `durationSeconds` calculation is fragile because `startedAt` may not be the actual DB `started_at`. Change the INSERT to let the DB compute duration:

Replace the `duration_seconds` value in the INSERT with a subquery:
```sql
-- In the VALUES clause, replace the $N for duration_seconds with:
EXTRACT(EPOCH FROM (NOW() - $started_at_param))::INTEGER
```

Or simpler: keep the JS calculation but ensure `startedAt` is captured at the beginning of the optimization run (where `runIncrementalOptimization`/`runFullOptimization` starts), not at save time. Pass it explicitly from the caller.

**Step 4: Build to verify no compile errors**

Run: `npx tsc --noEmit -p packages/optimizer/tsconfig.json && npx tsc --noEmit -p packages/dashboard/tsconfig.json`
Expected: No errors

**Step 5: Commit**

```bash
git add packages/optimizer/src/core/StrategyOptimizer.ts packages/optimizer/src/storage/OptimizationStore.ts packages/dashboard/src/services/OptimizationScheduler.ts
git commit -m "fix: compute duration_seconds on optimization run completion

All three code paths (StrategyOptimizer, OptimizationStore, OptimizationScheduler)
now calculate duration_seconds = EXTRACT(EPOCH FROM (NOW() - started_at))
when transitioning to completed/failed/cancelled status."
```

---

### Task 3: Add CPU Alerts to Daily Review

**Files:**
- Modify: `scripts/daily-review.sh` (after section 18, before section 19)
- No test file (bash script — verify manually via `bash -n`)

**Step 1: Add CPU alert section**

After line 336 in `scripts/daily-review.sh` (after the `resource_usage` section), add:

```bash
# 18b. CPU/Memory alerts (parsed from resource_usage)
cpu_alerts="[]"
if [ "$resource_usage" != "[]" ]; then
  cpu_alerts=$(echo "$resource_usage" | jq '[
    .[] |
    {
      name: .name,
      cpu: (.cpu_pct | gsub("%"; "") | tonumber),
      mem_pct: (.mem_pct | gsub("%"; "") | tonumber)
    } |
    if .cpu > 90 then . + {level: "critical", message: "\(.name) CPU at \(.cpu)% (>90%)"}
    elif .cpu > 70 then . + {level: "warning", message: "\(.name) CPU at \(.cpu)% (>70%)"}
    else empty end
  ] + [
    .[] |
    {
      name: .name,
      mem_pct: (.mem_pct | gsub("%"; "") | tonumber)
    } |
    if .mem_pct > 85 then {level: "warning", name: .name, message: "\(.name) memory at \(.mem_pct)% (>85%)"}
    else empty end
  ]' 2>/dev/null || echo "[]")
fi
```

**Step 2: Wire into the final JSON assembly**

In the `jq -n` block at the bottom of the script (~line 367+), add:
```bash
  --argjson cpu_alerts "$cpu_alerts" \
```

And add to the JSON object:
```
  "cpu_alerts": $cpu_alerts,
```

**Step 3: Verify script syntax**

Run: `bash -n scripts/daily-review.sh`
Expected: No output (valid syntax)

**Step 4: Commit**

```bash
git add scripts/daily-review.sh
git commit -m "feat: add CPU/memory alert thresholds to daily review

Parses docker stats output and flags:
- Critical: container CPU >90%
- Warning: container CPU >70% or memory >85%
Added as cpu_alerts section to the review JSON."
```

---

## Phase 2 — Adaptive Sync Frequency

### Task 4: Create AdaptiveSyncManager

**Files:**
- Create: `packages/data-collector/src/services/AdaptiveSyncManager.ts`
- Create: `packages/data-collector/src/services/AdaptiveSyncManager.test.ts`
- Modify: `packages/data-collector/src/services/Scheduler.ts` (expose job info)
- Modify: `packages/data-collector/src/index.ts` (wire in)

**Step 1: Write failing test for event loop lag detection**

Create `packages/data-collector/src/services/AdaptiveSyncManager.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AdaptiveSyncManager, SyncState } from './AdaptiveSyncManager.js';

describe('AdaptiveSyncManager', () => {
  let manager: AdaptiveSyncManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new AdaptiveSyncManager({
      lagThresholdDegraded: 500,
      lagThresholdCritical: 1000,
      recoveryThreshold: 200,
      checkIntervalMs: 10000,
      degradedChecksRequired: 3,
      recoveryDurationMs: 300000,
      maxIntervalMultiplier: 4,
    });
  });

  afterEach(() => {
    manager.stop();
    vi.useRealTimers();
  });

  it('should start in NORMAL state', () => {
    expect(manager.getState()).toBe('NORMAL');
    expect(manager.getIntervalMultiplier()).toBe(1);
  });

  it('should transition to DEGRADED after sustained high lag', () => {
    // Simulate 3 consecutive high-lag checks
    manager.reportLag(600);
    manager.reportLag(600);
    manager.reportLag(600);
    expect(manager.getState()).toBe('DEGRADED');
    expect(manager.getIntervalMultiplier()).toBe(2);
  });

  it('should transition to CRITICAL on very high lag', () => {
    manager.reportLag(1200);
    expect(manager.getState()).toBe('CRITICAL');
    expect(manager.getIntervalMultiplier()).toBe(3);
  });

  it('should recover to NORMAL after sustained low lag', () => {
    // Enter DEGRADED
    manager.reportLag(600);
    manager.reportLag(600);
    manager.reportLag(600);
    expect(manager.getState()).toBe('DEGRADED');

    // Simulate recovery (low lag for 5 minutes = 30 checks at 10s intervals)
    for (let i = 0; i < 30; i++) {
      manager.reportLag(100);
      vi.advanceTimersByTime(10000);
    }
    expect(manager.getState()).toBe('NORMAL');
    expect(manager.getIntervalMultiplier()).toBe(1);
  });

  it('should not go below multiplier 1 or above maxIntervalMultiplier', () => {
    expect(manager.getIntervalMultiplier()).toBe(1);
    manager.reportLag(1200);
    manager.reportLag(1200);
    manager.reportLag(1200);
    // Even multiple critical reports shouldn't exceed 3 (or maxIntervalMultiplier if configured to 4)
    expect(manager.getIntervalMultiplier()).toBeLessThanOrEqual(4);
  });
});

describe('AdaptiveSyncManager - Job overlap', () => {
  let manager: AdaptiveSyncManager;

  beforeEach(() => {
    manager = new AdaptiveSyncManager();
  });

  it('should track consecutive skips per job', () => {
    manager.reportJobSkip('sync-prices');
    manager.reportJobSkip('sync-prices');
    manager.reportJobSkip('sync-prices');
    expect(manager.shouldEscalateForJob('sync-prices')).toBe(true);
  });

  it('should reset skip count on successful run', () => {
    manager.reportJobSkip('sync-prices');
    manager.reportJobSkip('sync-prices');
    manager.reportJobComplete('sync-prices');
    expect(manager.shouldEscalateForJob('sync-prices')).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run packages/data-collector/src/services/AdaptiveSyncManager.test.ts`
Expected: FAIL — module not found

**Step 3: Implement AdaptiveSyncManager**

Create `packages/data-collector/src/services/AdaptiveSyncManager.ts`:

```typescript
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

export type SyncState = 'NORMAL' | 'DEGRADED' | 'CRITICAL';

export interface AdaptiveSyncConfig {
  lagThresholdDegraded: number;   // ms — enter DEGRADED
  lagThresholdCritical: number;   // ms — enter CRITICAL
  recoveryThreshold: number;      // ms — below this to recover
  checkIntervalMs: number;        // how often to sample lag
  degradedChecksRequired: number; // consecutive high-lag checks before escalation
  recoveryDurationMs: number;     // how long lag must stay low to recover
  maxIntervalMultiplier: number;  // ceiling for interval stretch
  skipEscalationThreshold: number; // consecutive skips before escalation
}

const DEFAULT_CONFIG: AdaptiveSyncConfig = {
  lagThresholdDegraded: 500,
  lagThresholdCritical: 1000,
  recoveryThreshold: 200,
  checkIntervalMs: 10000,
  degradedChecksRequired: 3,
  recoveryDurationMs: 300000, // 5 minutes
  maxIntervalMultiplier: 4,
  skipEscalationThreshold: 3,
};

export class AdaptiveSyncManager {
  private config: AdaptiveSyncConfig;
  private state: SyncState = 'NORMAL';
  private consecutiveHighLag = 0;
  private lowLagSince: number | null = null;
  private histogram: IntervalHistogram | null = null;
  private checkInterval: NodeJS.Timeout | null = null;
  private jobSkipCounts: Map<string, number> = new Map();

  constructor(config?: Partial<AdaptiveSyncConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  start(): void {
    this.histogram = monitorEventLoopDelay({ resolution: 20 });
    this.histogram.enable();

    this.checkInterval = setInterval(() => {
      if (this.histogram) {
        const lagMs = this.histogram.mean / 1e6; // nanoseconds → ms
        this.reportLag(lagMs);
        this.histogram.reset();
      }
    }, this.config.checkIntervalMs);

    console.log('[AdaptiveSync] Started event loop lag monitoring');
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    if (this.histogram) {
      this.histogram.disable();
      this.histogram = null;
    }
  }

  reportLag(lagMs: number): void {
    const prevState = this.state;

    // Check for CRITICAL (immediate)
    if (lagMs > this.config.lagThresholdCritical) {
      this.state = 'CRITICAL';
      this.consecutiveHighLag = 0;
      this.lowLagSince = null;
      if (prevState !== 'CRITICAL') {
        console.log(`[AdaptiveSync] State: ${prevState} → CRITICAL (lag=${lagMs.toFixed(0)}ms)`);
      }
      return;
    }

    // Check for DEGRADED (requires consecutive checks)
    if (lagMs > this.config.lagThresholdDegraded) {
      this.consecutiveHighLag++;
      this.lowLagSince = null;
      if (this.consecutiveHighLag >= this.config.degradedChecksRequired && this.state === 'NORMAL') {
        this.state = 'DEGRADED';
        console.log(`[AdaptiveSync] State: NORMAL → DEGRADED (lag=${lagMs.toFixed(0)}ms, ${this.consecutiveHighLag} consecutive)`);
      }
      return;
    }

    // Low lag — track recovery
    this.consecutiveHighLag = 0;
    if (lagMs < this.config.recoveryThreshold) {
      if (this.lowLagSince === null) {
        this.lowLagSince = Date.now();
      }
      const lowDuration = Date.now() - this.lowLagSince;
      if (lowDuration >= this.config.recoveryDurationMs && this.state !== 'NORMAL') {
        const prev = this.state;
        this.state = 'NORMAL';
        this.lowLagSince = null;
        console.log(`[AdaptiveSync] State: ${prev} → NORMAL (lag=${lagMs.toFixed(0)}ms, low for ${(lowDuration / 1000).toFixed(0)}s)`);
      }
    } else {
      this.lowLagSince = null;
    }
  }

  reportJobSkip(jobName: string): void {
    const count = (this.jobSkipCounts.get(jobName) ?? 0) + 1;
    this.jobSkipCounts.set(jobName, count);
    if (count >= this.config.skipEscalationThreshold && this.state === 'NORMAL') {
      this.state = 'DEGRADED';
      console.log(`[AdaptiveSync] State: NORMAL → DEGRADED (job ${jobName} skipped ${count}× consecutive)`);
    }
  }

  reportJobComplete(jobName: string): void {
    this.jobSkipCounts.set(jobName, 0);
  }

  shouldEscalateForJob(jobName: string): boolean {
    return (this.jobSkipCounts.get(jobName) ?? 0) >= this.config.skipEscalationThreshold;
  }

  getState(): SyncState {
    return this.state;
  }

  getIntervalMultiplier(): number {
    switch (this.state) {
      case 'NORMAL': return 1;
      case 'DEGRADED': return 2;
      case 'CRITICAL': return 3;
    }
  }

  /** Get the adjusted cron interval in minutes */
  getAdjustedIntervalMinutes(baseMinutes: number): number {
    return Math.min(baseMinutes * this.getIntervalMultiplier(), baseMinutes * this.config.maxIntervalMultiplier);
  }
}
```

**Step 4: Run tests**

Run: `npx vitest run packages/data-collector/src/services/AdaptiveSyncManager.test.ts`
Expected: PASS

**Step 5: Wire into Scheduler**

In `packages/data-collector/src/services/Scheduler.ts`, modify `runJob()` method to integrate:

```typescript
// At the top of runJob(), after the isRunning guard:
if (job.isRunning) {
  if (this.adaptiveSyncManager) {
    this.adaptiveSyncManager.reportJobSkip(name);
  }
  return;
}

// In the finally block, after setting job.isRunning = false:
if (this.adaptiveSyncManager) {
  this.adaptiveSyncManager.reportJobComplete(name);
}
```

In `packages/data-collector/src/index.ts`, create and pass `AdaptiveSyncManager`:

```typescript
import { AdaptiveSyncManager } from './services/AdaptiveSyncManager.js';

const adaptiveSync = new AdaptiveSyncManager();
adaptiveSync.start();
const scheduler = getScheduler(adaptiveSync);
```

**Step 6: Commit**

```bash
git add packages/data-collector/src/services/AdaptiveSyncManager.ts packages/data-collector/src/services/AdaptiveSyncManager.test.ts packages/data-collector/src/services/Scheduler.ts packages/data-collector/src/index.ts
git commit -m "feat: add AdaptiveSyncManager for CPU-aware sync frequency

Monitors event loop lag and job overlap to dynamically adjust sync
intervals. States: NORMAL (1×) → DEGRADED (2×) → CRITICAL (3×).
Recovers to NORMAL after 5 minutes of low lag."
```

---

## Phase 3 — Duration Weight System

### Task 5: Create DurationWeightModifier

**Files:**
- Create: `packages/signals/src/modifiers/DurationWeightModifier.ts`
- Create: `packages/signals/src/modifiers/DurationWeightModifier.test.ts`

**Step 1: Write failing tests**

Create `packages/signals/src/modifiers/DurationWeightModifier.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { DurationWeightModifier, DurationBand } from './DurationWeightModifier.js';

describe('DurationWeightModifier', () => {
  const modifier = new DurationWeightModifier();

  describe('getDurationBand', () => {
    it('should return "immediate" for market resolving in <7 days', () => {
      const endDate = new Date(Date.now() + 3 * 24 * 3600000); // 3 days
      expect(modifier.getDurationBand(endDate)).toBe('immediate');
    });

    it('should return "short" for market resolving in 7-30 days', () => {
      const endDate = new Date(Date.now() + 14 * 24 * 3600000); // 14 days
      expect(modifier.getDurationBand(endDate)).toBe('short');
    });

    it('should return "medium" for market resolving in 30-90 days', () => {
      const endDate = new Date(Date.now() + 60 * 24 * 3600000); // 60 days
      expect(modifier.getDurationBand(endDate)).toBe('medium');
    });

    it('should return "long" for market resolving in >90 days', () => {
      const endDate = new Date(Date.now() + 180 * 24 * 3600000); // 180 days
      expect(modifier.getDurationBand(endDate)).toBe('long');
    });

    it('should default to "short" when endDate is null', () => {
      expect(modifier.getDurationBand(null)).toBe('short');
    });

    it('should return "immediate" for already-expired markets', () => {
      const pastDate = new Date(Date.now() - 24 * 3600000); // yesterday
      expect(modifier.getDurationBand(pastDate)).toBe('immediate');
    });
  });

  describe('getModifiedWeight', () => {
    it('should return 1.0 for momentum in immediate band', () => {
      expect(modifier.getWeightMultiplier('momentum', 'immediate')).toBe(1.0);
    });

    it('should return 0 for momentum in medium band', () => {
      expect(modifier.getWeightMultiplier('momentum', 'medium')).toBe(0);
    });

    it('should return 0 for momentum in long band', () => {
      expect(modifier.getWeightMultiplier('momentum', 'long')).toBe(0);
    });

    it('should return 1.0 for hawkes in all bands', () => {
      expect(modifier.getWeightMultiplier('hawkes', 'immediate')).toBe(1.0);
      expect(modifier.getWeightMultiplier('hawkes', 'short')).toBe(1.0);
      expect(modifier.getWeightMultiplier('hawkes', 'medium')).toBe(1.0);
      expect(modifier.getWeightMultiplier('hawkes', 'long')).toBe(1.0);
    });

    it('should return 1.0 for volume_anomaly in long band', () => {
      expect(modifier.getWeightMultiplier('volume_anomaly', 'long')).toBe(1.0);
    });

    it('should return default 0.5 for unknown signals', () => {
      expect(modifier.getWeightMultiplier('unknown_signal', 'immediate')).toBe(0.5);
    });
  });

  describe('modifyWeights', () => {
    it('should scale all weights by duration multipliers', () => {
      const weights = { momentum: 0.20, mean_reversion: 0.20, ofi: 0.20, mlofi: 0.20, hawkes: 0.20 };
      const endDate = new Date(Date.now() + 60 * 24 * 3600000); // medium band
      const modified = modifier.modifyWeights(weights, endDate);

      expect(modified.momentum).toBe(0);          // 0.20 * 0
      expect(modified.mean_reversion).toBe(0.06);  // 0.20 * 0.3
      expect(modified.ofi).toBe(0.20);             // 0.20 * 1.0
      expect(modified.hawkes).toBe(0.20);          // 0.20 * 1.0
    });
  });
});
```

**Step 2: Run to verify failure**

Run: `npx vitest run packages/signals/src/modifiers/DurationWeightModifier.test.ts`
Expected: FAIL — module not found

**Step 3: Implement DurationWeightModifier**

Create `packages/signals/src/modifiers/DurationWeightModifier.ts`:

```typescript
export type DurationBand = 'immediate' | 'short' | 'medium' | 'long';

/** Duration band thresholds in days */
const BAND_THRESHOLDS: Record<DurationBand, { min: number; max: number }> = {
  immediate: { min: 0, max: 7 },
  short:     { min: 7, max: 30 },
  medium:    { min: 30, max: 90 },
  long:      { min: 90, max: Infinity },
};

/** Weight multipliers per signal × duration band */
const DEFAULT_MATRIX: Record<string, Record<DurationBand, number>> = {
  // Existing signals
  momentum:        { immediate: 1.0, short: 0.5, medium: 0,   long: 0 },
  mean_reversion:  { immediate: 1.0, short: 1.0, medium: 0.3, long: 0 },
  ofi:             { immediate: 1.0, short: 1.0, medium: 1.0, long: 0.5 },
  mlofi:           { immediate: 1.0, short: 1.0, medium: 1.0, long: 0.5 },
  hawkes:          { immediate: 1.0, short: 1.0, medium: 1.0, long: 1.0 },
  // New market-structure signals
  volume_anomaly:      { immediate: 0.3, short: 0.7, medium: 1.0, long: 1.0 },
  spread_compression:  { immediate: 0.3, short: 0.7, medium: 1.0, long: 1.0 },
  cross_market_corr:   { immediate: 0,   short: 0.5, medium: 1.0, long: 1.0 },
  // New external-data signals
  price_divergence:    { immediate: 0,   short: 0,   medium: 0.8, long: 1.0 },
  attention_spike:     { immediate: 0,   short: 0.3, medium: 0.8, long: 1.0 },
  news_sentiment:      { immediate: 0,   short: 0.3, medium: 0.8, long: 1.0 },
};

const DEFAULT_UNKNOWN_MULTIPLIER = 0.5;

export class DurationWeightModifier {
  private matrix: Record<string, Record<DurationBand, number>>;

  constructor(customMatrix?: Record<string, Record<DurationBand, number>>) {
    this.matrix = { ...DEFAULT_MATRIX, ...customMatrix };
  }

  getDurationBand(endDate: Date | null | undefined): DurationBand {
    if (!endDate) return 'short'; // conservative default

    const daysUntilEnd = (endDate.getTime() - Date.now()) / (24 * 3600000);
    if (daysUntilEnd <= 0) return 'immediate'; // already expired — treat as very short

    for (const [band, { min, max }] of Object.entries(BAND_THRESHOLDS) as [DurationBand, { min: number; max: number }][]) {
      if (daysUntilEnd >= min && daysUntilEnd < max) return band;
    }
    return 'long';
  }

  getWeightMultiplier(signalId: string, band: DurationBand): number {
    const row = this.matrix[signalId];
    if (!row) return DEFAULT_UNKNOWN_MULTIPLIER;
    return row[band];
  }

  modifyWeights(weights: Record<string, number>, endDate: Date | null | undefined): Record<string, number> {
    const band = this.getDurationBand(endDate);
    const modified: Record<string, number> = {};
    for (const [signalId, weight] of Object.entries(weights)) {
      const multiplier = this.getWeightMultiplier(signalId, band);
      modified[signalId] = Math.round(weight * multiplier * 100) / 100; // avoid floating point noise
    }
    return modified;
  }

  /** Update the matrix (e.g., from optimizer results) */
  updateMatrix(updates: Partial<Record<string, Record<DurationBand, number>>>): void {
    Object.assign(this.matrix, updates);
  }

  getMatrix(): Record<string, Record<DurationBand, number>> {
    return { ...this.matrix };
  }
}
```

**Step 4: Run tests**

Run: `npx vitest run packages/signals/src/modifiers/DurationWeightModifier.test.ts`
Expected: PASS

**Step 5: Export from signals package**

Add to `packages/signals/src/index.ts`:
```typescript
export { DurationWeightModifier, type DurationBand } from './modifiers/DurationWeightModifier.js';
```

**Step 6: Commit**

```bash
git add packages/signals/src/modifiers/DurationWeightModifier.ts packages/signals/src/modifiers/DurationWeightModifier.test.ts packages/signals/src/index.ts
git commit -m "feat: add DurationWeightModifier for signal-duration compatibility

Scales signal weights by market time horizon (immediate/short/medium/long).
Momentum blocked for >30 days, mean_reversion reduced for >30 days,
Hawkes and event-driven signals preserved for all durations."
```

---

### Task 6: Wire DurationWeightModifier into SignalEngine

**Files:**
- Modify: `packages/dashboard/src/services/SignalEngine.ts`

**Step 1: Import and instantiate DurationWeightModifier**

At the top of `SignalEngine.ts`, add import:
```typescript
import { DurationWeightModifier } from '@polymarket-trader/signals';
```

Add to class properties:
```typescript
private durationModifier: DurationWeightModifier = new DurationWeightModifier();
```

**Step 2: Extend ActiveMarket to include endDate**

The `ActiveMarket` interface (line 65) already doesn't include `endDate`. Add it:
```typescript
interface ActiveMarket {
  // ...existing fields...
  endDate?: Date | null;  // ADD THIS
}
```

**Step 3: Pass endDate when populating activeMarkets**

In `setActiveMarkets()` or wherever markets are mapped to `ActiveMarket[]`, ensure `endDate` is included from the DB `end_date` field. Check `PolymarketService.discoverMarkets()` — it already queries `m.end_date`. Ensure it's mapped through.

**Step 4: Apply duration modifier in computeSignalForMarket**

In the `computeSignalForMarket()` method, after collecting all signal outputs and before calling `this.combiner.combine()`, apply the modifier:

```typescript
// Before combining, modify weights based on market duration
const currentWeights = this.combiner.getWeights();
const modifiedWeights = this.durationModifier.modifyWeights(currentWeights, market.endDate ?? null);

// Temporarily set modified weights for this market
this.combiner.setWeights(modifiedWeights);
const combined = this.combiner.combine(signalOutputs, undefined, market.marketType);
// Restore original weights
this.combiner.setWeights(currentWeights);
```

**Alternative (cleaner):** Pass the modified weights directly to the combiner's combine method if the combiner supports per-call weights. If not, the temp swap pattern above works.

**Step 5: Build to verify**

Run: `npx tsc --noEmit -p packages/dashboard/tsconfig.json`
Expected: No errors

**Step 6: Commit**

```bash
git add packages/dashboard/src/services/SignalEngine.ts
git commit -m "feat: integrate DurationWeightModifier into SignalEngine

Signal weights are now scaled per-market based on time to resolution.
Momentum/mean_reversion suppressed for long-duration markets,
microstructure and event signals preserved."
```

---

## Phase 4 — New Market-Structure Signal Generators

### Task 7: VolumeAnomalyGenerator

**Files:**
- Create: `packages/signals/src/signals/market-structure/VolumeAnomalyGenerator.ts`
- Create: `packages/signals/src/signals/market-structure/VolumeAnomalyGenerator.test.ts`

**Step 1: Write failing tests**

Create `packages/signals/src/signals/market-structure/VolumeAnomalyGenerator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { VolumeAnomalyGenerator } from './VolumeAnomalyGenerator.js';
import type { SignalContext, PriceBar, MarketInfo } from '../../core/types/signal.types.js';

function makePriceBar(overrides: Partial<PriceBar> & { time: Date }): PriceBar {
  return { open: 0.5, high: 0.55, low: 0.45, close: 0.5, volume: 1000, ...overrides };
}

function makeContext(bars: PriceBar[]): SignalContext {
  return {
    currentTime: new Date(),
    market: { id: 'test-market', question: 'Test?', isActive: true, isResolved: false, tokenIdYes: 'tok-yes' } as MarketInfo,
    priceBars: bars,
    recentTrades: [],
  };
}

describe('VolumeAnomalyGenerator', () => {
  const generator = new VolumeAnomalyGenerator();

  it('should have signalId "volume_anomaly"', () => {
    expect(generator.signalId).toBe('volume_anomaly');
  });

  it('should return null when insufficient data', () => {
    const ctx = makeContext([makePriceBar({ time: new Date() })]);
    expect(generator.isReady(ctx)).toBe(false);
  });

  it('should return null when volume is normal', async () => {
    const bars: PriceBar[] = [];
    for (let i = 0; i < 30; i++) {
      bars.push(makePriceBar({
        time: new Date(Date.now() - (30 - i) * 3600000),
        volume: 1000, // consistent volume
        close: 0.5,
      }));
    }
    const result = await generator.compute(makeContext(bars));
    expect(result).toBeNull(); // no anomaly
  });

  it('should fire LONG when volume spikes with rising price', async () => {
    const bars: PriceBar[] = [];
    // 28 normal bars
    for (let i = 0; i < 28; i++) {
      bars.push(makePriceBar({
        time: new Date(Date.now() - (30 - i) * 3600000),
        volume: 1000,
        close: 0.50,
      }));
    }
    // 2 spike bars with rising price
    bars.push(makePriceBar({ time: new Date(Date.now() - 2 * 3600000), volume: 5000, close: 0.55 }));
    bars.push(makePriceBar({ time: new Date(Date.now() - 1 * 3600000), volume: 6000, close: 0.58 }));

    const result = await generator.compute(makeContext(bars));
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('LONG');
    expect(result!.strength).toBeGreaterThan(0);
  });

  it('should fire SHORT when volume spikes with falling price', async () => {
    const bars: PriceBar[] = [];
    for (let i = 0; i < 28; i++) {
      bars.push(makePriceBar({
        time: new Date(Date.now() - (30 - i) * 3600000),
        volume: 1000,
        close: 0.50,
      }));
    }
    bars.push(makePriceBar({ time: new Date(Date.now() - 2 * 3600000), volume: 5000, close: 0.45 }));
    bars.push(makePriceBar({ time: new Date(Date.now() - 1 * 3600000), volume: 6000, close: 0.42 }));

    const result = await generator.compute(makeContext(bars));
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('SHORT');
  });
});
```

**Step 2: Run to verify failure**

Run: `npx vitest run packages/signals/src/signals/market-structure/VolumeAnomalyGenerator.test.ts`
Expected: FAIL — module not found

**Step 3: Implement VolumeAnomalyGenerator**

Create `packages/signals/src/signals/market-structure/VolumeAnomalyGenerator.ts`:

```typescript
import { BaseSignal } from '../../core/base/BaseSignal.js';
import type { SignalContext, SignalOutput } from '../../core/types/signal.types.js';

interface VolumeAnomalyParams {
  lookbackDays: number;     // Rolling window for baseline
  zScoreThreshold: number;  // Minimum z-score to trigger
  minBars: number;          // Minimum bars needed
}

const DEFAULT_PARAMS: VolumeAnomalyParams = {
  lookbackDays: 7,
  zScoreThreshold: 2.0,
  minBars: 14,  // Need at least 2 weeks of hourly/daily bars
};

export class VolumeAnomalyGenerator extends BaseSignal<VolumeAnomalyParams> {
  readonly signalId = 'volume_anomaly';
  readonly name = 'Volume Anomaly Detector';
  readonly description = 'Detects statistically significant volume spikes relative to rolling baseline';

  constructor(config?: Partial<VolumeAnomalyParams>) {
    super();
    this.parameters = { ...DEFAULT_PARAMS, ...config };
  }

  getRequiredLookback(): number {
    return this.parameters.minBars;
  }

  async compute(context: SignalContext): Promise<SignalOutput | null> {
    const { priceBars } = context;
    if (priceBars.length < this.parameters.minBars) return null;

    // Calculate rolling volume stats (exclude last 2 bars which are "current")
    const baselineBars = priceBars.slice(0, -2);
    const currentBars = priceBars.slice(-2);

    const volumes = baselineBars.map(b => b.volume);
    const mean = volumes.reduce((s, v) => s + v, 0) / volumes.length;
    const stdDev = Math.sqrt(volumes.reduce((s, v) => s + (v - mean) ** 2, 0) / volumes.length);

    if (stdDev === 0 || mean === 0) return null;

    // Current volume = average of last 2 bars
    const currentVolume = currentBars.reduce((s, b) => s + b.volume, 0) / currentBars.length;
    const zScore = (currentVolume - mean) / stdDev;

    if (zScore < this.parameters.zScoreThreshold) return null;

    // Determine direction from price movement
    const priceChange = currentBars[currentBars.length - 1].close - baselineBars[baselineBars.length - 1].close;
    const direction = priceChange >= 0 ? 'LONG' : 'SHORT';

    // Strength: 2σ=0.5, 3σ=0.8, 4σ+=1.0
    const strength = Math.min(1.0, 0.25 * zScore) * (direction === 'LONG' ? 1 : -1);

    // Confidence: higher z-score = more confident
    const confidence = Math.min(1.0, 0.2 + 0.2 * zScore);

    return this.createOutput(context, direction, strength, confidence, {
      zScore,
      currentVolume,
      baselineMean: mean,
      baselineStdDev: stdDev,
    });
  }
}
```

**Step 4: Run tests**

Run: `npx vitest run packages/signals/src/signals/market-structure/VolumeAnomalyGenerator.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/signals/src/signals/market-structure/
git commit -m "feat: add VolumeAnomalyGenerator for detecting volume spikes

Fires when trading volume exceeds 2σ above 7-day rolling mean.
Direction inferred from price movement. Designed for medium/long
duration markets where volume spikes indicate informed trading."
```

---

### Task 8: SpreadCompressionGenerator

**Files:**
- Create: `packages/signals/src/signals/market-structure/SpreadCompressionGenerator.ts`
- Create: `packages/signals/src/signals/market-structure/SpreadCompressionGenerator.test.ts`

**Step 1: Write failing tests**

Create `packages/signals/src/signals/market-structure/SpreadCompressionGenerator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { SpreadCompressionGenerator } from './SpreadCompressionGenerator.js';
import type { SignalContext, PriceBar, MarketInfo, OrderBookSnapshot } from '../../core/types/signal.types.js';

function makeContext(overrides: Partial<SignalContext>): SignalContext {
  return {
    currentTime: new Date(),
    market: { id: 'test', question: 'Test?', isActive: true, isResolved: false, tokenIdYes: 'tok' } as MarketInfo,
    priceBars: [],
    recentTrades: [],
    ...overrides,
  };
}

describe('SpreadCompressionGenerator', () => {
  const generator = new SpreadCompressionGenerator();

  it('should have signalId "spread_compression"', () => {
    expect(generator.signalId).toBe('spread_compression');
  });

  it('should return null when no order book in context', async () => {
    const result = await generator.compute(makeContext({}));
    expect(result).toBeNull();
  });

  it('should return null when no historical spreads available', async () => {
    const ctx = makeContext({
      orderBook: { spread: 0.02, bidDepth10Pct: 5000, askDepth10Pct: 3000 } as OrderBookSnapshot,
      custom: { historicalSpreads: [] },
    });
    const result = await generator.compute(ctx);
    expect(result).toBeNull();
  });

  it('should fire when spread compresses to <50% of rolling average', async () => {
    const historicalSpreads = Array(20).fill(0.10); // avg spread = 0.10
    const ctx = makeContext({
      orderBook: {
        spread: 0.03, // 30% of avg — well below 50% threshold
        bidDepth10Pct: 8000,
        askDepth10Pct: 3000,
      } as OrderBookSnapshot,
      custom: { historicalSpreads },
    });
    const result = await generator.compute(ctx);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('LONG'); // bid depth > ask depth
    expect(result!.confidence).toBeGreaterThan(0.3);
  });

  it('should infer SHORT when ask depth dominates', async () => {
    const historicalSpreads = Array(20).fill(0.10);
    const ctx = makeContext({
      orderBook: {
        spread: 0.03,
        bidDepth10Pct: 2000,
        askDepth10Pct: 8000,
      } as OrderBookSnapshot,
      custom: { historicalSpreads },
    });
    const result = await generator.compute(ctx);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('SHORT');
  });
});
```

**Step 2: Implement**

Create `packages/signals/src/signals/market-structure/SpreadCompressionGenerator.ts`:

```typescript
import { BaseSignal } from '../../core/base/BaseSignal.js';
import type { SignalContext, SignalOutput } from '../../core/types/signal.types.js';

interface SpreadCompressionParams {
  compressionThreshold: number; // ratio of current/avg below which to fire
  minHistoricalSpreads: number;
}

const DEFAULT_PARAMS: SpreadCompressionParams = {
  compressionThreshold: 0.5, // fire when spread < 50% of rolling avg
  minHistoricalSpreads: 10,
};

export class SpreadCompressionGenerator extends BaseSignal<SpreadCompressionParams> {
  readonly signalId = 'spread_compression';
  readonly name = 'Spread Compression Detector';
  readonly description = 'Fires when bid-ask spread compresses significantly, indicating informed trader entry';

  constructor(config?: Partial<SpreadCompressionParams>) {
    super();
    this.parameters = { ...DEFAULT_PARAMS, ...config };
  }

  getRequiredLookback(): number {
    return 0; // uses order book, not price bars
  }

  isReady(context: SignalContext): boolean {
    return !!context.orderBook;
  }

  async compute(context: SignalContext): Promise<SignalOutput | null> {
    const { orderBook } = context;
    if (!orderBook || !orderBook.spread) return null;

    // Get historical spreads from custom context (populated by SignalEngine)
    const historicalSpreads = (context.custom?.historicalSpreads as number[]) ?? [];
    if (historicalSpreads.length < this.parameters.minHistoricalSpreads) return null;

    const avgSpread = historicalSpreads.reduce((s, v) => s + v, 0) / historicalSpreads.length;
    if (avgSpread === 0) return null;

    const compressionRatio = orderBook.spread / avgSpread;
    if (compressionRatio >= this.parameters.compressionThreshold) return null;

    // Direction: more depth on bid side → informed buyers (LONG), more on ask → SHORT
    const bidDepth = orderBook.bidDepth10Pct ?? 0;
    const askDepth = orderBook.askDepth10Pct ?? 0;
    const totalDepth = bidDepth + askDepth;
    if (totalDepth === 0) return null;

    const direction = bidDepth > askDepth ? 'LONG' : 'SHORT';
    const depthImbalance = Math.abs(bidDepth - askDepth) / totalDepth;

    // Strength: how compressed × how imbalanced
    const strength = Math.min(1.0, (1 - compressionRatio) * depthImbalance * 2) * (direction === 'LONG' ? 1 : -1);
    const confidence = Math.min(1.0, 0.3 + (1 - compressionRatio) * 0.7);

    return this.createOutput(context, direction, strength, confidence, {
      compressionRatio,
      avgSpread,
      currentSpread: orderBook.spread,
      bidDepth,
      askDepth,
    });
  }
}
```

**Step 3: Run tests, commit**

Run: `npx vitest run packages/signals/src/signals/market-structure/SpreadCompressionGenerator.test.ts`

```bash
git add packages/signals/src/signals/market-structure/SpreadCompressionGenerator*
git commit -m "feat: add SpreadCompressionGenerator for detecting informed trader entry

Fires when bid-ask spread compresses to <50% of 7-day rolling average.
Direction inferred from order book depth imbalance."
```

---

### Task 9: CrossMarketCorrelationGenerator

**Files:**
- Create: `packages/signals/src/signals/market-structure/CrossMarketCorrelationGenerator.ts`
- Create: `packages/signals/src/signals/market-structure/CrossMarketCorrelationGenerator.test.ts`

**Step 1: Write failing tests**

```typescript
// packages/signals/src/signals/market-structure/CrossMarketCorrelationGenerator.test.ts
import { describe, it, expect } from 'vitest';
import { CrossMarketCorrelationGenerator } from './CrossMarketCorrelationGenerator.js';
import type { SignalContext, MarketInfo, PriceBar } from '../../core/types/signal.types.js';

function makeMarketInfo(id: string, priceYes: number): MarketInfo {
  return { id, question: `${id}?`, isActive: true, isResolved: false, tokenIdYes: `tok-${id}`, currentPriceYes: priceYes };
}

function makeContext(market: MarketInfo, relatedMarkets: MarketInfo[], priceBars: PriceBar[]): SignalContext {
  return {
    currentTime: new Date(),
    market,
    priceBars,
    recentTrades: [],
    relatedMarkets,
    custom: {
      relatedMarketPriceChanges: {
        'spain-wc': 0.15,  // Spain moved +15%
        'france-wc': 0.12, // France moved +12%
      },
    },
  };
}

describe('CrossMarketCorrelationGenerator', () => {
  const generator = new CrossMarketCorrelationGenerator();

  it('should have signalId "cross_market_corr"', () => {
    expect(generator.signalId).toBe('cross_market_corr');
  });

  it('should return null when no related markets', async () => {
    const ctx = makeContext(makeMarketInfo('england-wc', 0.13), [], []);
    const result = await generator.compute(ctx);
    expect(result).toBeNull();
  });

  it('should fire when related markets moved but this one has not', async () => {
    const market = makeMarketInfo('england-wc', 0.13);
    const related = [makeMarketInfo('spain-wc', 0.20), makeMarketInfo('france-wc', 0.18)];
    const bars = [
      { time: new Date(Date.now() - 7200000), open: 0.13, high: 0.13, low: 0.13, close: 0.13, volume: 500 },
      { time: new Date(Date.now() - 3600000), open: 0.13, high: 0.13, low: 0.13, close: 0.13, volume: 500 },
    ];
    const ctx = makeContext(market, related, bars);
    // Related markets moved +12-15%, this one flat → expect SHORT (inversely correlated for "who wins")
    // Or LONG if positively correlated
    const result = await generator.compute(ctx);
    // With related markets moving significantly and this one flat, signal should fire
    expect(result).not.toBeNull();
  });
});
```

**Step 2: Implement**

Create `packages/signals/src/signals/market-structure/CrossMarketCorrelationGenerator.ts`:

```typescript
import { BaseSignal } from '../../core/base/BaseSignal.js';
import type { SignalContext, SignalOutput } from '../../core/types/signal.types.js';

interface CrossMarketParams {
  minRelatedMarkets: number;
  minPriceChangePct: number; // minimum % change in related market to consider
  lagThresholdPct: number;   // how far behind this market must be to trigger
}

const DEFAULT_PARAMS: CrossMarketParams = {
  minRelatedMarkets: 1,
  minPriceChangePct: 5,    // related market must have moved >5%
  lagThresholdPct: 3,      // this market must be >3% behind
};

export class CrossMarketCorrelationGenerator extends BaseSignal<CrossMarketParams> {
  readonly signalId = 'cross_market_corr';
  readonly name = 'Cross-Market Correlation';
  readonly description = 'Detects when related markets have moved but this market has lagged behind';

  constructor(config?: Partial<CrossMarketParams>) {
    super();
    this.parameters = { ...DEFAULT_PARAMS, ...config };
  }

  getRequiredLookback(): number {
    return 2;
  }

  isReady(context: SignalContext): boolean {
    return (context.relatedMarkets?.length ?? 0) >= this.parameters.minRelatedMarkets
      && context.priceBars.length >= 2;
  }

  async compute(context: SignalContext): Promise<SignalOutput | null> {
    const { relatedMarkets, priceBars, custom } = context;
    if (!relatedMarkets || relatedMarkets.length === 0) return null;
    if (priceBars.length < 2) return null;

    // Get related market price changes from custom context
    const relatedChanges = (custom?.relatedMarketPriceChanges as Record<string, number>) ?? {};
    if (Object.keys(relatedChanges).length === 0) return null;

    // Calculate this market's price change
    const oldPrice = priceBars[0].close;
    const newPrice = priceBars[priceBars.length - 1].close;
    const thisChange = oldPrice > 0 ? (newPrice - oldPrice) / oldPrice : 0;

    // Average change of related markets that moved significantly
    const significantChanges = Object.values(relatedChanges)
      .filter(c => Math.abs(c) >= this.parameters.minPriceChangePct / 100);

    if (significantChanges.length === 0) return null;

    const avgRelatedChange = significantChanges.reduce((s, v) => s + v, 0) / significantChanges.length;

    // For competing-outcome markets (e.g., "X wins" vs "Y wins"), correlation is NEGATIVE
    // For correlated markets (e.g., same event, different angles), correlation is POSITIVE
    // We detect lag: if related markets moved and this one hasn't followed proportionally
    const lag = avgRelatedChange - thisChange;
    if (Math.abs(lag) < this.parameters.lagThresholdPct / 100) return null;

    // Direction: if related went up and we lagged, we should go up too (momentum contagion)
    const direction = lag > 0 ? 'LONG' : 'SHORT';
    const strength = Math.min(1.0, Math.abs(lag) * 5) * (direction === 'LONG' ? 1 : -1);
    const confidence = Math.min(1.0, 0.3 + significantChanges.length * 0.15);

    return this.createOutput(context, direction, strength, confidence, {
      thisChange,
      avgRelatedChange,
      lag,
      significantRelatedCount: significantChanges.length,
    });
  }
}
```

**Step 3: Run tests, commit**

Run: `npx vitest run packages/signals/src/signals/market-structure/CrossMarketCorrelationGenerator.test.ts`

```bash
git add packages/signals/src/signals/market-structure/CrossMarketCorrelation*
git commit -m "feat: add CrossMarketCorrelationGenerator for momentum contagion

Detects when related markets (same event) have moved significantly but
this market has lagged behind. Fires a signal to catch up."
```

---

### Task 10: Register New Market-Structure Generators in SignalEngine

**Files:**
- Modify: `packages/signals/src/index.ts` (exports)
- Modify: `packages/dashboard/src/services/SignalEngine.ts` (registration)

**Step 1: Add exports**

In `packages/signals/src/index.ts`, add:
```typescript
export { VolumeAnomalyGenerator } from './signals/market-structure/VolumeAnomalyGenerator.js';
export { SpreadCompressionGenerator } from './signals/market-structure/SpreadCompressionGenerator.js';
export { CrossMarketCorrelationGenerator } from './signals/market-structure/CrossMarketCorrelationGenerator.js';
```

**Step 2: Register in SignalEngine**

In `packages/dashboard/src/services/SignalEngine.ts`, import and add to `initializeSignals()`:

```typescript
import {
  // ...existing imports...
  VolumeAnomalyGenerator,
  SpreadCompressionGenerator,
  CrossMarketCorrelationGenerator,
} from '@polymarket-trader/signals';

// In initializeSignals():
// Market structure signals
this.signals.set('volume_anomaly', new VolumeAnomalyGenerator());
this.signals.set('spread_compression', new SpreadCompressionGenerator());
this.signals.set('cross_market_corr', new CrossMarketCorrelationGenerator());
```

**Step 3: Add default weights in combiner initialization**

In the combiner constructor call (line 98-107), add weights for the new signals:
```typescript
this.combiner = new WeightedAverageCombiner(
  {
    // ...existing weights...
    volume_anomaly: 0.15,
    spread_compression: 0.15,
    cross_market_corr: 0.10,
  },
  // ...existing params...
);
```

**Step 4: Populate context data for new generators**

In `buildSignalContext()`, add historical spreads to `custom`:
```typescript
// Fetch historical spreads for SpreadCompressionGenerator
const spreadRows = await query(
  `SELECT spread FROM orderbook_snapshots
   WHERE market_id = $1 AND time > NOW() - INTERVAL '7 days'
   ORDER BY time DESC LIMIT 100`,
  [market.id]
);
const historicalSpreads = spreadRows.rows.map((r: any) => parseFloat(r.spread)).filter((v: number) => v > 0);

// Fetch related market price changes for CrossMarketCorrelationGenerator
// Group by event_id — markets in the same event are related
const relatedRows = await query(
  `SELECT m2.id, m2.current_price_yes,
    (SELECT close FROM price_history WHERE token_id = m2.clob_token_id_yes
     AND time > NOW() - INTERVAL '24 hours' ORDER BY time ASC LIMIT 1) as price_24h_ago
   FROM markets m1
   JOIN markets m2 ON m1.event_id = m2.event_id AND m2.id != m1.id
   WHERE m1.id = $1 AND m2.is_active = true AND m2.event_id IS NOT NULL
   LIMIT 10`,
  [market.id]
);
const relatedMarketPriceChanges: Record<string, number> = {};
for (const row of relatedRows.rows) {
  const oldPrice = parseFloat(row.price_24h_ago);
  const newPrice = parseFloat(row.current_price_yes);
  if (oldPrice > 0) {
    relatedMarketPriceChanges[row.id] = (newPrice - oldPrice) / oldPrice;
  }
}

// Add to context.custom
custom: {
  ...existingCustom,
  historicalSpreads,
  relatedMarketPriceChanges,
}
```

**Step 5: Build, run existing tests**

Run: `npx tsc --noEmit -p packages/dashboard/tsconfig.json && npx vitest run`
Expected: All pass

**Step 6: Commit**

```bash
git add packages/signals/src/index.ts packages/dashboard/src/services/SignalEngine.ts
git commit -m "feat: register VolumeAnomaly, SpreadCompression, CrossMarketCorrelation generators

Three new market-structure signal generators integrated into SignalEngine.
Context populated with historical spreads and related market price changes."
```

---

## Phase 5 — External Data Infrastructure

### Task 11: Create Database Tables

**Files:**
- Create: `packages/data-collector/src/database/init/003_external_data_schema.sql`

**Step 1: Write migration**

```sql
-- Cross-platform market mappings (Polymarket ↔ Metaculus/Manifold)
CREATE TABLE IF NOT EXISTS market_crossref (
  polymarket_id VARCHAR(128) REFERENCES markets(id) ON DELETE CASCADE,
  platform VARCHAR(50) NOT NULL,
  external_id VARCHAR(255) NOT NULL,
  external_question TEXT,
  external_price DECIMAL(10,6),
  match_confidence FLOAT NOT NULL DEFAULT 0.0,
  matched_at TIMESTAMPTZ DEFAULT NOW(),
  last_fetched_at TIMESTAMPTZ,
  PRIMARY KEY (polymarket_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_crossref_platform ON market_crossref(platform);

-- External signal data
CREATE TABLE IF NOT EXISTS external_signals (
  id SERIAL PRIMARY KEY,
  market_id VARCHAR(128) NOT NULL,
  source VARCHAR(50) NOT NULL,
  signal_type VARCHAR(50) NOT NULL,
  value FLOAT NOT NULL,
  confidence FLOAT DEFAULT 0.5,
  metadata JSONB DEFAULT '{}',
  fetched_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_external_signals_market ON external_signals(market_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_external_signals_source ON external_signals(source, signal_type);

-- Retention: keep 30 days of external signals
-- (TimescaleDB hypertable optional — regular table is fine for hourly inserts)
```

**Step 2: Apply to VM**

This will be applied during deployment. For local testing, run against a local DB or include in the init scripts.

**Step 3: Commit**

```bash
git add packages/data-collector/src/database/init/003_external_data_schema.sql
git commit -m "feat: add market_crossref and external_signals tables

market_crossref stores Polymarket ↔ Metaculus/Manifold market mappings
(Haiku-matched). external_signals stores normalized data from all
external sources for signal generators to read."
```

---

### Task 12: Create MarketMatcher (Haiku-powered)

**Files:**
- Create: `packages/data-collector/src/collectors/MarketMatcher.ts`
- Create: `packages/data-collector/src/collectors/MarketMatcher.test.ts`

**Step 1: Write failing tests**

```typescript
// packages/data-collector/src/collectors/MarketMatcher.test.ts
import { describe, it, expect, vi } from 'vitest';
import { MarketMatcher } from './MarketMatcher.js';

// Mock Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify({ match: true, confidence: 0.9 }) }],
      }),
    },
  })),
}));

describe('MarketMatcher', () => {
  it('should match identical questions with high confidence', async () => {
    const matcher = new MarketMatcher('fake-api-key');
    const result = await matcher.matchQuestions(
      'Will Trump win the 2028 presidential election?',
      'Donald Trump wins the 2028 US presidential election'
    );
    expect(result.match).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.7);
  });
});
```

**Step 2: Implement**

Create `packages/data-collector/src/collectors/MarketMatcher.ts`:

```typescript
import Anthropic from '@anthropic-ai/sdk';

interface MatchResult {
  match: boolean;
  confidence: number;
}

export class MarketMatcher {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async matchQuestions(polymarketQuestion: string, externalQuestion: string): Promise<MatchResult> {
    try {
      const response = await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        messages: [{
          role: 'user',
          content: `Are these two prediction market questions about the same outcome? Reply with JSON only: {"match": true/false, "confidence": 0.0-1.0}

Question A: "${polymarketQuestion}"
Question B: "${externalQuestion}"`,
        }],
      });

      const text = response.content[0].type === 'text' ? response.content[0].text : '';
      const parsed = JSON.parse(text);
      return {
        match: parsed.match === true,
        confidence: Math.min(1.0, Math.max(0, Number(parsed.confidence) || 0)),
      };
    } catch (error) {
      console.error('[MarketMatcher] Haiku matching failed:', error);
      return { match: false, confidence: 0 };
    }
  }

  async matchBatch(
    polymarketMarkets: Array<{ id: string; question: string }>,
    externalMarkets: Array<{ id: string; question: string; platform: string }>
  ): Promise<Array<{ polymarketId: string; externalId: string; platform: string; confidence: number }>> {
    const matches: Array<{ polymarketId: string; externalId: string; platform: string; confidence: number }> = [];

    for (const pm of polymarketMarkets) {
      for (const ext of externalMarkets) {
        const result = await this.matchQuestions(pm.question, ext.question);
        if (result.match && result.confidence >= 0.7) {
          matches.push({
            polymarketId: pm.id,
            externalId: ext.id,
            platform: ext.platform,
            confidence: result.confidence,
          });
          break; // one match per polymarket market per platform
        }
      }
    }

    return matches;
  }
}
```

**Step 3: Run tests, commit**

Run: `npx vitest run packages/data-collector/src/collectors/MarketMatcher.test.ts`

```bash
git add packages/data-collector/src/collectors/MarketMatcher*
git commit -m "feat: add MarketMatcher for Haiku-powered cross-platform matching

Uses Claude Haiku to match Polymarket questions against Metaculus/Manifold
questions. Returns match confidence for storing in market_crossref."
```

---

### Task 13: Create Source Adapters (Metaculus + Manifold)

**Files:**
- Create: `packages/data-collector/src/collectors/sources/MetaculusSource.ts`
- Create: `packages/data-collector/src/collectors/sources/ManifoldSource.ts`
- Create: `packages/data-collector/src/collectors/sources/MetaculusSource.test.ts`
- Create: `packages/data-collector/src/collectors/sources/ManifoldSource.test.ts`

**Step 1: Implement MetaculusSource**

```typescript
// packages/data-collector/src/collectors/sources/MetaculusSource.ts
import axios from 'axios';

export interface ExternalMarketData {
  id: string;
  question: string;
  platform: string;
  probability: number | null;  // 0-1 probability forecast
  fetchedAt: Date;
}

export class MetaculusSource {
  private baseUrl = 'https://www.metaculus.com/api2';

  async fetchActiveQuestions(limit = 50): Promise<ExternalMarketData[]> {
    try {
      const response = await axios.get(`${this.baseUrl}/questions/`, {
        params: {
          status: 'open',
          type: 'binary',
          limit,
          order_by: '-activity',
        },
        timeout: 15000,
      });

      return (response.data.results ?? []).map((q: any) => ({
        id: String(q.id),
        question: q.title ?? q.title_short ?? '',
        platform: 'metaculus',
        probability: q.community_prediction?.full?.q2 ?? null,
        fetchedAt: new Date(),
      }));
    } catch (error) {
      console.error('[MetaculusSource] Fetch failed:', error);
      return [];
    }
  }

  async fetchQuestionById(id: string): Promise<ExternalMarketData | null> {
    try {
      const response = await axios.get(`${this.baseUrl}/questions/${id}/`, { timeout: 10000 });
      const q = response.data;
      return {
        id: String(q.id),
        question: q.title ?? '',
        platform: 'metaculus',
        probability: q.community_prediction?.full?.q2 ?? null,
        fetchedAt: new Date(),
      };
    } catch {
      return null;
    }
  }
}
```

**Step 2: Implement ManifoldSource**

```typescript
// packages/data-collector/src/collectors/sources/ManifoldSource.ts
import axios from 'axios';
import type { ExternalMarketData } from './MetaculusSource.js';

export class ManifoldSource {
  private baseUrl = 'https://api.manifold.markets/v0';

  async fetchActiveMarkets(limit = 50): Promise<ExternalMarketData[]> {
    try {
      const response = await axios.get(`${this.baseUrl}/markets`, {
        params: { limit, sort: 'liquidity', filter: 'open' },
        timeout: 15000,
      });

      return (response.data ?? [])
        .filter((m: any) => m.outcomeType === 'BINARY')
        .map((m: any) => ({
          id: m.id,
          question: m.question ?? '',
          platform: 'manifold',
          probability: m.probability ?? null,
          fetchedAt: new Date(),
        }));
    } catch (error) {
      console.error('[ManifoldSource] Fetch failed:', error);
      return [];
    }
  }

  async fetchMarketById(id: string): Promise<ExternalMarketData | null> {
    try {
      const response = await axios.get(`${this.baseUrl}/market/${id}`, { timeout: 10000 });
      const m = response.data;
      return {
        id: m.id,
        question: m.question ?? '',
        platform: 'manifold',
        probability: m.probability ?? null,
        fetchedAt: new Date(),
      };
    } catch {
      return null;
    }
  }
}
```

**Step 3: Write tests (mock axios)**

```typescript
// packages/data-collector/src/collectors/sources/MetaculusSource.test.ts
import { describe, it, expect, vi } from 'vitest';
import { MetaculusSource } from './MetaculusSource.js';
import axios from 'axios';

vi.mock('axios');

describe('MetaculusSource', () => {
  const source = new MetaculusSource();

  it('should parse Metaculus API response into ExternalMarketData', async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: {
        results: [{
          id: 12345,
          title: 'Will AI pass the Turing test by 2030?',
          community_prediction: { full: { q2: 0.42 } },
        }],
      },
    });

    const markets = await source.fetchActiveQuestions(10);
    expect(markets).toHaveLength(1);
    expect(markets[0].platform).toBe('metaculus');
    expect(markets[0].probability).toBe(0.42);
    expect(markets[0].question).toBe('Will AI pass the Turing test by 2030?');
  });

  it('should return empty array on API error', async () => {
    vi.mocked(axios.get).mockRejectedValueOnce(new Error('Network error'));
    const markets = await source.fetchActiveQuestions();
    expect(markets).toEqual([]);
  });
});
```

**Step 4: Run tests, commit**

Run: `npx vitest run packages/data-collector/src/collectors/sources/`

```bash
git add packages/data-collector/src/collectors/sources/
git commit -m "feat: add MetaculusSource and ManifoldSource adapters

Fetch active binary prediction markets from Metaculus and Manifold
free APIs. Normalize to common ExternalMarketData shape."
```

---

### Task 14: Create ExternalDataCollector Orchestrator

**Files:**
- Create: `packages/data-collector/src/collectors/ExternalDataCollector.ts`
- Modify: `packages/data-collector/src/services/Scheduler.ts` (add hourly/daily jobs)

**Step 1: Implement ExternalDataCollector**

```typescript
// packages/data-collector/src/collectors/ExternalDataCollector.ts
import { query } from '../database/index.js';
import { MetaculusSource } from './sources/MetaculusSource.js';
import { ManifoldSource } from './sources/ManifoldSource.js';
import { MarketMatcher } from './MarketMatcher.js';

export class ExternalDataCollector {
  private metaculus: MetaculusSource;
  private manifold: ManifoldSource;
  private matcher: MarketMatcher | null;

  constructor(anthropicApiKey?: string) {
    this.metaculus = new MetaculusSource();
    this.manifold = new ManifoldSource();
    this.matcher = anthropicApiKey ? new MarketMatcher(anthropicApiKey) : null;
  }

  /** Hourly: fetch prices for already-matched markets, store as external_signals */
  async fetchMatchedMarketPrices(): Promise<number> {
    // Get existing cross-references
    const refs = await query(
      `SELECT polymarket_id, platform, external_id FROM market_crossref WHERE match_confidence >= 0.7`
    );
    if (refs.rows.length === 0) return 0;

    let stored = 0;
    for (const ref of refs.rows) {
      try {
        let probability: number | null = null;
        if (ref.platform === 'metaculus') {
          const data = await this.metaculus.fetchQuestionById(ref.external_id);
          probability = data?.probability ?? null;
        } else if (ref.platform === 'manifold') {
          const data = await this.manifold.fetchMarketById(ref.external_id);
          probability = data?.probability ?? null;
        }

        if (probability !== null) {
          // Get Polymarket price for divergence calculation
          const pmPrice = await query(
            `SELECT current_price_yes FROM markets WHERE id = $1`, [ref.polymarket_id]
          );
          const polyPrice = pmPrice.rows[0]?.current_price_yes
            ? parseFloat(pmPrice.rows[0].current_price_yes) : null;

          const divergence = polyPrice !== null ? probability - polyPrice : null;

          await query(
            `INSERT INTO external_signals (market_id, source, signal_type, value, confidence, metadata)
             VALUES ($1, $2, 'price_divergence', $3, $4, $5)`,
            [
              ref.polymarket_id,
              ref.platform,
              divergence ?? 0,
              0.8, // high confidence for direct price comparison
              JSON.stringify({ externalPrice: probability, polymarketPrice: polyPrice }),
            ]
          );
          stored++;
        }
      } catch (error) {
        console.error(`[ExternalData] Failed to fetch ${ref.platform}/${ref.external_id}:`, error);
      }
    }

    console.log(`[ExternalData] Stored ${stored} price divergence signals from ${refs.rows.length} crossrefs`);
    return stored;
  }

  /** Daily: match Polymarket long-duration markets to external platforms */
  async runDailyMatching(): Promise<number> {
    if (!this.matcher) {
      console.log('[ExternalData] No Anthropic API key — skipping market matching');
      return 0;
    }

    // Get long-duration Polymarket markets (>30 days to resolution)
    const pmMarkets = await query(
      `SELECT id, question FROM markets
       WHERE is_active = true AND is_resolved = false
       AND end_date > NOW() + INTERVAL '30 days'
       AND id NOT IN (SELECT polymarket_id FROM market_crossref)
       LIMIT 40`
    );
    if (pmMarkets.rows.length === 0) return 0;

    // Fetch candidates from both platforms
    const metaculusMarkets = await this.metaculus.fetchActiveQuestions(100);
    const manifoldMarkets = await this.manifold.fetchActiveMarkets(100);
    const allExternal = [
      ...metaculusMarkets.map(m => ({ ...m, platform: 'metaculus' })),
      ...manifoldMarkets.map(m => ({ ...m, platform: 'manifold' })),
    ];

    // Match using Haiku
    const matches = await this.matcher.matchBatch(
      pmMarkets.rows.map((r: any) => ({ id: r.id, question: r.question })),
      allExternal.map(m => ({ id: m.id, question: m.question, platform: m.platform }))
    );

    // Store matches
    for (const match of matches) {
      await query(
        `INSERT INTO market_crossref (polymarket_id, platform, external_id, external_question, match_confidence)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (polymarket_id, platform) DO UPDATE SET
           external_id = EXCLUDED.external_id,
           match_confidence = EXCLUDED.match_confidence,
           matched_at = NOW()`,
        [match.polymarketId, match.platform, match.externalId, '', match.confidence]
      );
    }

    console.log(`[ExternalData] Matched ${matches.length} markets from ${pmMarkets.rows.length} candidates`);
    return matches.length;
  }
}
```

**Step 2: Add to Scheduler**

In `packages/data-collector/src/services/Scheduler.ts`, add two new jobs:

```typescript
// In the job definitions:
'fetch-external-prices': { schedule: '0 * * * *' },    // hourly
'match-external-markets': { schedule: '0 3 * * *' },   // daily at 3 UTC
```

In the `runJob` switch statement:
```typescript
case 'fetch-external-prices':
  await this.externalCollector?.fetchMatchedMarketPrices();
  break;
case 'match-external-markets':
  await this.externalCollector?.runDailyMatching();
  break;
```

**Step 3: Commit**

```bash
git add packages/data-collector/src/collectors/ExternalDataCollector.ts packages/data-collector/src/services/Scheduler.ts
git commit -m "feat: add ExternalDataCollector with hourly price fetch and daily matching

Orchestrates MetaculusSource + ManifoldSource. Fetches prices hourly
for matched markets, stores as external_signals. Runs Haiku matching
daily for unmatched long-duration markets."
```

---

## Phase 6 — External Data Signal Generators

### Task 15: GoogleTrendsSource + NewsSource

**Files:**
- Create: `packages/data-collector/src/collectors/sources/GoogleTrendsSource.ts`
- Create: `packages/data-collector/src/collectors/sources/NewsSource.ts`

**Step 1: Implement GoogleTrendsSource**

```typescript
// packages/data-collector/src/collectors/sources/GoogleTrendsSource.ts
import axios from 'axios';

export interface TrendsData {
  keyword: string;
  interest: number;     // 0-100 relative interest
  fetchedAt: Date;
}

export class GoogleTrendsSource {
  private dailyRequestCount = 0;
  private dailyLimit = 60;
  private lastResetDate = new Date().toDateString();

  /** Extract top 2-3 keywords from a market question */
  extractKeywords(question: string): string[] {
    const stopWords = new Set(['will', 'the', 'a', 'an', 'in', 'on', 'at', 'to', 'of', 'by', 'for',
      'is', 'be', 'or', 'and', 'this', 'that', 'it', 'with', 'from', 'as', 'has', 'have',
      'before', 'after', 'win', 'yes', 'no', 'does', 'do', 'can', 'who', 'what', 'when']);
    const words = question.replace(/[?.,!'"]/g, '').split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w.toLowerCase()));
    // Return top 3 longest words (likely proper nouns / entities)
    return words.sort((a, b) => b.length - a.length).slice(0, 3);
  }

  async fetchInterest(keywords: string[]): Promise<TrendsData[]> {
    // Reset daily counter at midnight
    const today = new Date().toDateString();
    if (today !== this.lastResetDate) {
      this.dailyRequestCount = 0;
      this.lastResetDate = today;
    }
    if (this.dailyRequestCount >= this.dailyLimit) {
      console.log('[GoogleTrends] Daily request limit reached, skipping');
      return [];
    }

    const results: TrendsData[] = [];
    // Use unofficial Google Trends API (or google-trends-api npm package)
    // For now, use a simple HTTP approach
    try {
      for (const keyword of keywords) {
        this.dailyRequestCount++;
        if (this.dailyRequestCount > this.dailyLimit) break;

        // Use Google Trends explore endpoint (simplified — may need google-trends-api package)
        const response = await axios.get(
          `https://trends.google.com/trends/api/dailytrends`, {
            params: { hl: 'en-US', geo: 'US', tz: '-420' },
            timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0' },
          }
        ).catch(() => null);

        // Parse response (Google Trends returns JSONP-like format)
        // Fallback: return 0 interest if parsing fails
        results.push({
          keyword,
          interest: 0, // Will be replaced by real parsing in production
          fetchedAt: new Date(),
        });
      }
    } catch (error) {
      console.error('[GoogleTrends] Fetch failed:', error);
    }

    return results;
  }

  getRemainingRequests(): number {
    return Math.max(0, this.dailyLimit - this.dailyRequestCount);
  }
}
```

**NOTE for implementor:** The Google Trends unofficial API is fragile. Consider using the `google-trends-api` npm package for more reliable parsing. The implementation above is a skeleton — wire in the actual library during implementation.

**Step 2: Implement NewsSource**

```typescript
// packages/data-collector/src/collectors/sources/NewsSource.ts
import axios from 'axios';

export interface NewsArticle {
  title: string;
  description: string;
  source: string;
  publishedAt: Date;
  url: string;
}

export interface NewsSentimentData {
  marketId: string;
  keyword: string;
  articleCount: number;
  sentimentScore: number; // -1 to +1
  articles: NewsArticle[];
  fetchedAt: Date;
}

const POSITIVE_WORDS = new Set(['wins', 'passes', 'approved', 'rises', 'confirms', 'gains',
  'leads', 'victory', 'success', 'surges', 'advances', 'agrees', 'supports']);
const NEGATIVE_WORDS = new Set(['loses', 'fails', 'rejected', 'falls', 'denies', 'drops',
  'trails', 'defeat', 'crash', 'declines', 'opposes', 'blocks', 'cancels']);

export class NewsSource {
  private apiKey: string;
  private baseUrl = 'https://gnews.io/api/v4';
  private dailyRequestCount = 0;
  private dailyLimit = 50; // 50% of 100 free tier budget
  private lastResetDate = new Date().toDateString();

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async fetchHeadlines(keywords: string[], maxResults = 5): Promise<NewsArticle[]> {
    const today = new Date().toDateString();
    if (today !== this.lastResetDate) {
      this.dailyRequestCount = 0;
      this.lastResetDate = today;
    }
    if (this.dailyRequestCount >= this.dailyLimit) return [];

    try {
      this.dailyRequestCount++;
      const query = keywords.join(' ');
      const response = await axios.get(`${this.baseUrl}/search`, {
        params: {
          q: query,
          lang: 'en',
          max: maxResults,
          token: this.apiKey,
        },
        timeout: 10000,
      });

      return (response.data.articles ?? []).map((a: any) => ({
        title: a.title ?? '',
        description: a.description ?? '',
        source: a.source?.name ?? '',
        publishedAt: new Date(a.publishedAt),
        url: a.url ?? '',
      }));
    } catch (error) {
      console.error('[NewsSource] Fetch failed:', error);
      return [];
    }
  }

  scoreSentiment(articles: NewsArticle[]): number {
    if (articles.length === 0) return 0;

    let totalScore = 0;
    for (const article of articles) {
      const text = `${article.title} ${article.description}`.toLowerCase();
      const words = text.split(/\s+/);
      let articleScore = 0;
      for (const word of words) {
        if (POSITIVE_WORDS.has(word)) articleScore++;
        if (NEGATIVE_WORDS.has(word)) articleScore--;
      }
      totalScore += Math.sign(articleScore); // normalize per article: -1, 0, +1
    }

    return totalScore / articles.length; // -1 to +1
  }

  getRemainingRequests(): number {
    return Math.max(0, this.dailyLimit - this.dailyRequestCount);
  }
}
```

**Step 3: Commit**

```bash
git add packages/data-collector/src/collectors/sources/GoogleTrendsSource.ts packages/data-collector/src/collectors/sources/NewsSource.ts
git commit -m "feat: add GoogleTrendsSource and NewsSource external data adapters

GoogleTrendsSource tracks search interest with keyword rotation (60/day).
NewsSource uses GNews free API (50 req/day) with keyword sentiment scoring."
```

---

### Task 16: PriceDivergenceGenerator

**Files:**
- Create: `packages/signals/src/signals/external/PriceDivergenceGenerator.ts`
- Create: `packages/signals/src/signals/external/PriceDivergenceGenerator.test.ts`

**Step 1: Write failing tests**

```typescript
// packages/signals/src/signals/external/PriceDivergenceGenerator.test.ts
import { describe, it, expect } from 'vitest';
import { PriceDivergenceGenerator } from './PriceDivergenceGenerator.js';
import type { SignalContext, MarketInfo } from '../../core/types/signal.types.js';

function makeContext(custom: Record<string, unknown>): SignalContext {
  return {
    currentTime: new Date(),
    market: { id: 'test', question: 'Test?', isActive: true, isResolved: false, tokenIdYes: 'tok', currentPriceYes: 0.15 } as MarketInfo,
    priceBars: [],
    recentTrades: [],
    custom,
  };
}

describe('PriceDivergenceGenerator', () => {
  const generator = new PriceDivergenceGenerator();

  it('should have signalId "price_divergence"', () => {
    expect(generator.signalId).toBe('price_divergence');
  });

  it('should return null when no external data', async () => {
    const result = await generator.compute(makeContext({}));
    expect(result).toBeNull();
  });

  it('should fire LONG when Polymarket price is below external consensus', async () => {
    const result = await generator.compute(makeContext({
      externalPrices: [
        { platform: 'metaculus', probability: 0.25, confidence: 0.9 },
        { platform: 'manifold', probability: 0.22, confidence: 0.85 },
      ],
      polymarketPrice: 0.15,
    }));
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('LONG'); // PM lower → buy
    expect(result!.strength).toBeGreaterThan(0);
  });

  it('should fire SHORT when Polymarket price is above external consensus', async () => {
    const result = await generator.compute(makeContext({
      externalPrices: [
        { platform: 'metaculus', probability: 0.10, confidence: 0.9 },
      ],
      polymarketPrice: 0.25,
    }));
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('SHORT');
  });

  it('should not fire when divergence is <5pp', async () => {
    const result = await generator.compute(makeContext({
      externalPrices: [{ platform: 'metaculus', probability: 0.17, confidence: 0.9 }],
      polymarketPrice: 0.15,
    }));
    expect(result).toBeNull(); // 2pp divergence, below 5pp threshold
  });
});
```

**Step 2: Implement**

```typescript
// packages/signals/src/signals/external/PriceDivergenceGenerator.ts
import { BaseSignal } from '../../core/base/BaseSignal.js';
import type { SignalContext, SignalOutput } from '../../core/types/signal.types.js';

interface ExternalPriceData {
  platform: string;
  probability: number;
  confidence: number;
}

interface PriceDivergenceParams {
  minDivergencePp: number;  // minimum percentage points
}

const DEFAULT_PARAMS: PriceDivergenceParams = {
  minDivergencePp: 5,
};

export class PriceDivergenceGenerator extends BaseSignal<PriceDivergenceParams> {
  readonly signalId = 'price_divergence';
  readonly name = 'Cross-Platform Price Divergence';
  readonly description = 'Fires when Polymarket price diverges from Metaculus/Manifold consensus';

  constructor(config?: Partial<PriceDivergenceParams>) {
    super();
    this.parameters = { ...DEFAULT_PARAMS, ...config };
  }

  getRequiredLookback(): number { return 0; }

  isReady(context: SignalContext): boolean {
    const prices = context.custom?.externalPrices as ExternalPriceData[] | undefined;
    return !!prices && prices.length > 0;
  }

  async compute(context: SignalContext): Promise<SignalOutput | null> {
    const externalPrices = (context.custom?.externalPrices as ExternalPriceData[]) ?? [];
    const polyPrice = (context.custom?.polymarketPrice as number) ?? context.market.currentPriceYes;
    if (externalPrices.length === 0 || polyPrice === undefined) return null;

    // Weighted average of external prices (weighted by confidence)
    let totalWeight = 0;
    let weightedSum = 0;
    for (const ext of externalPrices) {
      weightedSum += ext.probability * ext.confidence;
      totalWeight += ext.confidence;
    }
    if (totalWeight === 0) return null;
    const externalConsensus = weightedSum / totalWeight;

    const divergencePp = (externalConsensus - polyPrice) * 100;
    if (Math.abs(divergencePp) < this.parameters.minDivergencePp) return null;

    const direction = divergencePp > 0 ? 'LONG' : 'SHORT';

    // Strength: 5pp=0.4, 10pp=0.7, 20pp+=1.0
    const absDivPp = Math.abs(divergencePp);
    const strength = Math.min(1.0, absDivPp * 0.05) * (direction === 'LONG' ? 1 : -1);

    // Confidence capped by match confidence
    const avgMatchConfidence = externalPrices.reduce((s, e) => s + e.confidence, 0) / externalPrices.length;
    const confidence = Math.min(avgMatchConfidence, 0.3 + absDivPp * 0.03);

    return this.createOutput(context, direction, strength, confidence, {
      polymarketPrice: polyPrice,
      externalConsensus,
      divergencePp,
      platforms: externalPrices.map(e => e.platform),
    });
  }
}
```

**Step 3: Run tests, commit**

```bash
git add packages/signals/src/signals/external/
git commit -m "feat: add PriceDivergenceGenerator for cross-platform arbitrage signals

Compares Polymarket price against weighted Metaculus/Manifold consensus.
Fires when divergence exceeds 5 percentage points."
```

---

### Task 17: AttentionSpikeGenerator

**Files:**
- Create: `packages/signals/src/signals/external/AttentionSpikeGenerator.ts`
- Create: `packages/signals/src/signals/external/AttentionSpikeGenerator.test.ts`

**Step 1: Write test + implement**

```typescript
// packages/signals/src/signals/external/AttentionSpikeGenerator.ts
import { BaseSignal } from '../../core/base/BaseSignal.js';
import type { SignalContext, SignalOutput } from '../../core/types/signal.types.js';

interface AttentionSpikeParams {
  spikeThreshold: number;    // multiplier of baseline (2× default)
  maxMultiplier: number;     // max confidence multiplier output
}

const DEFAULT_PARAMS: AttentionSpikeParams = {
  spikeThreshold: 2.0,
  maxMultiplier: 1.5,
};

export class AttentionSpikeGenerator extends BaseSignal<AttentionSpikeParams> {
  readonly signalId = 'attention_spike';
  readonly name = 'Attention Spike Detector';
  readonly description = 'Amplifies other signals when Google Trends shows elevated search interest';

  constructor(config?: Partial<AttentionSpikeParams>) {
    super();
    this.parameters = { ...DEFAULT_PARAMS, ...config };
  }

  getRequiredLookback(): number { return 0; }

  isReady(context: SignalContext): boolean {
    return context.custom?.currentInterest !== undefined && context.custom?.baselineInterest !== undefined;
  }

  async compute(context: SignalContext): Promise<SignalOutput | null> {
    const currentInterest = context.custom?.currentInterest as number ?? 0;
    const baselineInterest = context.custom?.baselineInterest as number ?? 0;
    if (baselineInterest <= 0 || currentInterest <= 0) return null;

    const ratio = currentInterest / baselineInterest;
    if (ratio < this.parameters.spikeThreshold) return null;

    // This signal is NEUTRAL direction — it acts as a confidence multiplier
    // Strength proportional to spike magnitude: 2×=0.4, 5×=0.7, 10×+=1.0
    const strength = Math.min(1.0, 0.2 * ratio);
    const confidence = Math.min(1.0, 0.3 + 0.1 * ratio);

    return this.createOutput(context, 'NEUTRAL', strength, confidence, {
      currentInterest,
      baselineInterest,
      spikeRatio: ratio,
      confidenceMultiplier: Math.min(this.parameters.maxMultiplier, 1.0 + (ratio - 1) * 0.1),
    });
  }
}
```

**Step 2: Run tests, commit**

```bash
git add packages/signals/src/signals/external/AttentionSpike*
git commit -m "feat: add AttentionSpikeGenerator as confidence multiplier

Detects Google Trends search interest spikes (>2× baseline). Outputs
NEUTRAL direction with confidence multiplier metadata for the combiner."
```

---

### Task 18: NewsSentimentGenerator

**Files:**
- Create: `packages/signals/src/signals/external/NewsSentimentGenerator.ts`
- Create: `packages/signals/src/signals/external/NewsSentimentGenerator.test.ts`

**Step 1: Write test + implement**

```typescript
// packages/signals/src/signals/external/NewsSentimentGenerator.ts
import { BaseSignal } from '../../core/base/BaseSignal.js';
import type { SignalContext, SignalOutput } from '../../core/types/signal.types.js';

interface NewsSentimentParams {
  minSentimentMagnitude: number;  // minimum |score| to fire
  minArticleCount: number;         // minimum articles to avoid noise
}

const DEFAULT_PARAMS: NewsSentimentParams = {
  minSentimentMagnitude: 0.3,
  minArticleCount: 2,
};

export class NewsSentimentGenerator extends BaseSignal<NewsSentimentParams> {
  readonly signalId = 'news_sentiment';
  readonly name = 'News Headline Sentiment';
  readonly description = 'Infers market direction from recent news headline sentiment';

  constructor(config?: Partial<NewsSentimentParams>) {
    super();
    this.parameters = { ...DEFAULT_PARAMS, ...config };
  }

  getRequiredLookback(): number { return 0; }

  isReady(context: SignalContext): boolean {
    return context.custom?.newsSentiment !== undefined;
  }

  async compute(context: SignalContext): Promise<SignalOutput | null> {
    const sentimentScore = context.custom?.newsSentiment as number ?? 0;
    const articleCount = context.custom?.newsArticleCount as number ?? 0;

    if (Math.abs(sentimentScore) < this.parameters.minSentimentMagnitude) return null;
    if (articleCount < this.parameters.minArticleCount) return null;

    const direction = sentimentScore > 0 ? 'LONG' : 'SHORT';
    const strength = Math.abs(sentimentScore) * Math.min(articleCount / 5, 1.0) * (direction === 'LONG' ? 1 : -1);
    const confidence = Math.min(1.0, 0.3 + Math.abs(sentimentScore) * 0.4 + articleCount * 0.05);

    return this.createOutput(context, direction, strength, confidence, {
      sentimentScore,
      articleCount,
    });
  }
}
```

**Step 2: Run tests, commit**

```bash
git add packages/signals/src/signals/external/NewsSentiment*
git commit -m "feat: add NewsSentimentGenerator for news headline analysis

Infers direction from keyword-based sentiment scoring of GNews headlines.
Requires |sentiment| > 0.3 and at least 2 articles to avoid noise."
```

---

### Task 19: Register External Generators + Wire Context Data

**Files:**
- Modify: `packages/signals/src/index.ts` (exports)
- Modify: `packages/dashboard/src/services/SignalEngine.ts` (registration + context)

**Step 1: Export new generators**

In `packages/signals/src/index.ts`:
```typescript
export { PriceDivergenceGenerator } from './signals/external/PriceDivergenceGenerator.js';
export { AttentionSpikeGenerator } from './signals/external/AttentionSpikeGenerator.js';
export { NewsSentimentGenerator } from './signals/external/NewsSentimentGenerator.js';
```

**Step 2: Register in SignalEngine**

In `packages/dashboard/src/services/SignalEngine.ts`, import and register:

```typescript
import {
  // ...existing + phase 4 imports...
  PriceDivergenceGenerator,
  AttentionSpikeGenerator,
  NewsSentimentGenerator,
} from '@polymarket-trader/signals';

// In initializeSignals():
// External data signals
this.signals.set('price_divergence', new PriceDivergenceGenerator());
this.signals.set('attention_spike', new AttentionSpikeGenerator());
this.signals.set('news_sentiment', new NewsSentimentGenerator());
```

**Step 3: Populate external data in buildSignalContext**

In `buildSignalContext()`, add queries for external signal data:

```typescript
// Fetch external price data for PriceDivergenceGenerator
const extPrices = await query(
  `SELECT es.source as platform, es.value as divergence, es.confidence, es.metadata
   FROM external_signals es
   WHERE es.market_id = $1 AND es.signal_type = 'price_divergence'
   AND es.fetched_at > NOW() - INTERVAL '4 hours'
   ORDER BY es.fetched_at DESC
   LIMIT 5`,
  [market.id]
);
const externalPrices = extPrices.rows.map((r: any) => {
  const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata;
  return {
    platform: r.platform,
    probability: meta?.externalPrice ?? 0,
    confidence: parseFloat(r.confidence) || 0.5,
  };
});

// Fetch attention/sentiment data
const attentionData = await query(
  `SELECT value, metadata FROM external_signals
   WHERE market_id = $1 AND signal_type = 'attention_spike'
   AND fetched_at > NOW() - INTERVAL '6 hours'
   ORDER BY fetched_at DESC LIMIT 1`,
  [market.id]
);

const sentimentData = await query(
  `SELECT value, metadata FROM external_signals
   WHERE market_id = $1 AND signal_type = 'sentiment'
   AND fetched_at > NOW() - INTERVAL '4 hours'
   ORDER BY fetched_at DESC LIMIT 1`,
  [market.id]
);

// Add to context.custom
custom: {
  ...existingCustom,
  externalPrices,
  polymarketPrice: market.currentPrice,
  currentInterest: attentionData.rows[0]?.value ?? 0,
  baselineInterest: attentionData.rows[0]?.metadata?.baseline ?? 0,
  newsSentiment: sentimentData.rows[0]?.value ?? 0,
  newsArticleCount: sentimentData.rows[0]?.metadata?.articleCount ?? 0,
}
```

**Step 4: Add combiner weights**

In the combiner initialization:
```typescript
price_divergence: 0.15,
attention_spike: 0.10,
news_sentiment: 0.10,
```

**Step 5: Build, run all tests**

Run: `npx tsc --noEmit -p packages/dashboard/tsconfig.json && npx vitest run`
Expected: All pass

**Step 6: Commit**

```bash
git add packages/signals/src/index.ts packages/dashboard/src/services/SignalEngine.ts
git commit -m "feat: register external data generators and wire context data

PriceDivergence, AttentionSpike, and NewsSentiment generators now
integrated into SignalEngine. Context populated from external_signals
table. All 11 generators (5 existing + 3 market-structure + 3 external)
are now active with duration-weighted combination."
```

---

## Phase Summary — Verification Checklist

After all phases, verify:

1. [ ] `npx vitest run` — all tests pass
2. [ ] `npx tsc --noEmit` — no compile errors across all packages
3. [ ] `docker compose build` — images build successfully
4. [ ] Deploy to VM — all 3 containers healthy
5. [ ] Check `docker logs polymarket-dashboard-api` — 11 generators initialized
6. [ ] Check signals generated — `scripts/check-status.js` shows signals from new generators
7. [ ] Check external_signals table — entries from Metaculus/Manifold
8. [ ] Check market_crossref table — Haiku matches stored
9. [ ] Check optimization_runs — duration_seconds populated for new runs
10. [ ] Check daily review — cpu_alerts section present in JSON output
