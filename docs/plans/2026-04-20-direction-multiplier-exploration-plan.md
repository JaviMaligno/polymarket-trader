# Direction Multiplier Exploration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable epsilon-greedy exploration of positive direction-multiplier values, widen learner range to `[-1.25, +1.0]`, and record per-trade multiplier provenance so the `DirectionMultiplierLearningService` can discover un-flip segments.

**Architecture:** New stateless `DirectionResolver` module sits between `SignalEngine` and `WeightedAverageCombiner`. It wraps the existing pure `resolveDirectionMultiplier()` and adds an exploration branch: on segment miss, roll a uniform random; if hit, sample a multiplier from `[min, max]`. A 5-min-cached circuit breaker reads recent exploration PnL from `paper_positions`. Two new columns (`applied_direction_multiplier`, `was_exploration`) propagate the applied multiplier through to closed trades so the learner can bucket them correctly.

**Tech Stack:** TypeScript, Vitest, PostgreSQL/TimescaleDB, existing monorepo packages (`packages/dashboard`, `packages/signals`, `packages/data-collector`).

**Spec:** [`docs/plans/2026-04-20-direction-multiplier-exploration-design.md`](./2026-04-20-direction-multiplier-exploration-design.md)

---

## Task 1: DB migration — init file + startup DDL

**Files:**
- Create: `packages/data-collector/src/database/init/017_direction_multiplier_exploration_columns.sql`
- Modify: `packages/dashboard/src/server.ts` (startup DDL block near existing `trading_config` creation)

- [ ] **Step 1: Create the init migration file**

Create `packages/data-collector/src/database/init/017_direction_multiplier_exploration_columns.sql`:

```sql
-- Direction multiplier exploration: per-trade multiplier provenance
-- Adds two columns to paper_positions so the learner can bucket trades
-- by the actual applied multiplier (not just the contemporaneous global).
ALTER TABLE paper_positions
  ADD COLUMN IF NOT EXISTS applied_direction_multiplier NUMERIC(5,3),
  ADD COLUMN IF NOT EXISTS was_exploration BOOLEAN NOT NULL DEFAULT false;
```

- [ ] **Step 2: Locate the startup DDL block in `server.ts`**

Run: `grep -n "CREATE TABLE IF NOT EXISTS trading_config" packages/dashboard/src/server.ts`

Expected output: a line number for the existing trading_config DDL.

- [ ] **Step 3: Add the same ALTER TABLE statement in the startup DDL block**

In `packages/dashboard/src/server.ts`, immediately after the `CREATE TABLE IF NOT EXISTS trading_config ...` execution, add:

```ts
await query(`
  ALTER TABLE paper_positions
    ADD COLUMN IF NOT EXISTS applied_direction_multiplier NUMERIC(5,3),
    ADD COLUMN IF NOT EXISTS was_exploration BOOLEAN NOT NULL DEFAULT false
`);
console.log('paper_positions direction exploration columns ensured');
```

- [ ] **Step 4: Verify the migration file is picked up**

Run: `ls packages/data-collector/src/database/init/ | tail -5`
Expected: `017_direction_multiplier_exploration_columns.sql` appears after `016_...`.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/data-collector/src/database/init/017_direction_multiplier_exploration_columns.sql packages/dashboard/src/server.ts
rtk git commit -m "migration: add applied_direction_multiplier and was_exploration to paper_positions"
```

---

## Task 2: Extend `PaperPosition` + update both INSERT sites

**Files:**
- Modify: `packages/dashboard/src/database/repositories.ts` (PaperPosition interface + `insert()` line ~341 + `openPositionAtomically()` line ~421)
- Modify: `packages/dashboard/src/database/repositories.test.ts`

- [ ] **Step 1: Write failing test for the new columns**

Add to `packages/dashboard/src/database/repositories.test.ts`:

```ts
describe('paperPositionsRepo — direction multiplier fields', () => {
  it('includes applied_direction_multiplier and was_exploration in INSERT', async () => {
    const querySpy = vi.spyOn(indexMod, 'query').mockResolvedValue({ rows: [], rowCount: 0 } as any);
    await paperPositionsRepo.insert({
      market_id: 'mkt1',
      token_id: 'tok1',
      side: 'long',
      size: 10,
      avg_entry_price: 0.5,
      current_price: 0.5,
      opened_at: new Date('2026-04-20T12:00:00Z'),
      applied_direction_multiplier: 0.75,
      was_exploration: true,
    });
    const sql = querySpy.mock.calls[0][0] as string;
    const params = querySpy.mock.calls[0][1] as unknown[];
    expect(sql).toContain('applied_direction_multiplier');
    expect(sql).toContain('was_exploration');
    expect(params).toContain(0.75);
    expect(params).toContain(true);
    querySpy.mockRestore();
  });

  it('defaults applied_direction_multiplier to null and was_exploration to false when omitted', async () => {
    const querySpy = vi.spyOn(indexMod, 'query').mockResolvedValue({ rows: [], rowCount: 0 } as any);
    await paperPositionsRepo.insert({
      market_id: 'mkt1', token_id: 'tok1', side: 'long', size: 10,
      avg_entry_price: 0.5, current_price: 0.5, opened_at: new Date(),
    });
    const params = querySpy.mock.calls[0][1] as unknown[];
    expect(params).toContain(null);
    expect(params).toContain(false);
    querySpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/dashboard && pnpm test repositories.test.ts -t "direction multiplier fields" 2>&1 | tail -20`
Expected: FAIL — "applied_direction_multiplier" not in SQL / params.

- [ ] **Step 3: Extend `PaperPosition` interface**

In `packages/dashboard/src/database/repositories.ts`, inside the `PaperPosition` interface (around line 310-335), add:

```ts
  applied_direction_multiplier?: number | null;
  was_exploration?: boolean;
```

- [ ] **Step 4: Update `insert()` (line ~341) INSERT statement**

Replace the `insert()` body in `packages/dashboard/src/database/repositories.ts`:

```ts
  async insert(position: PaperPosition): Promise<void> {
    await query(
      `INSERT INTO paper_positions
       (market_id, token_id, side, size, avg_entry_price, current_price,
        unrealized_pnl, unrealized_pnl_pct, realized_pnl, stop_loss, take_profit,
        opened_at, signal_type, metadata, market_score_at_entry, score_dimensions_at_entry,
        execution_mode, applied_direction_multiplier, was_exploration)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        position.market_id,
        position.token_id,
        position.side,
        position.size,
        position.avg_entry_price,
        position.current_price,
        position.unrealized_pnl,
        position.unrealized_pnl_pct,
        position.realized_pnl ?? 0,
        position.stop_loss,
        position.take_profit,
        position.opened_at,
        position.signal_type,
        JSON.stringify(position.metadata ?? {}),
        position.market_score_at_entry ?? null,
        position.score_dimensions_at_entry != null ? JSON.stringify(position.score_dimensions_at_entry) : null,
        position.execution_mode ?? 'paper',
        position.applied_direction_multiplier ?? null,
        position.was_exploration ?? false,
      ]
    );
  },
```

- [ ] **Step 5: Update `openPositionAtomically()` (line ~421) INSERT statement**

In the same file, replace the `INSERT INTO paper_positions` block inside `openPositionAtomically`:

```ts
        await client.query(
          `INSERT INTO paper_positions
           (market_id, token_id, side, size, avg_entry_price, current_price,
            unrealized_pnl, unrealized_pnl_pct, realized_pnl, stop_loss, take_profit,
            opened_at, signal_type, metadata, market_score_at_entry, score_dimensions_at_entry,
            execution_mode, applied_direction_multiplier, was_exploration)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
          [
            position.market_id, position.token_id, position.side, position.size,
            position.avg_entry_price, position.current_price,
            position.unrealized_pnl ?? 0, position.unrealized_pnl_pct ?? 0,
            0, position.stop_loss, position.take_profit, position.opened_at,
            position.signal_type, JSON.stringify(position.metadata ?? {}),
            position.market_score_at_entry ?? null,
            position.score_dimensions_at_entry != null ? JSON.stringify(position.score_dimensions_at_entry) : null,
            position.execution_mode ?? 'paper',
            position.applied_direction_multiplier ?? null,
            position.was_exploration ?? false,
          ]
        );
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/dashboard && pnpm test repositories.test.ts -t "direction multiplier fields" 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 7: Run the full repositories test suite to confirm no regressions**

Run: `cd packages/dashboard && pnpm test repositories.test.ts 2>&1 | tail -15`
Expected: all tests pass (pre-existing + the two new).

- [ ] **Step 8: Commit**

```bash
rtk git add packages/dashboard/src/database/repositories.ts packages/dashboard/src/database/repositories.test.ts
rtk git commit -m "feat(repo): persist applied_direction_multiplier and was_exploration on paper_positions inserts"
```

---

## Task 3: Extend `CombinedSignalOutput` + populate from combiner

**Files:**
- Modify: `packages/signals/src/core/types/signal.types.ts` (interface at line ~167)
- Modify: `packages/signals/src/combiners/WeightedAverageCombiner.ts` (output object at line ~188)
- Modify: `packages/signals/src/combiners/WeightedAverageCombiner.test.ts`

- [ ] **Step 1: Write failing test for the new field**

Add to `packages/signals/src/combiners/WeightedAverageCombiner.test.ts`:

```ts
describe('WeightedAverageCombiner — applied direction multiplier', () => {
  it('exposes applied multiplier in CombinedSignalOutput', () => {
    const combiner = new WeightedAverageCombiner(baseWeights(), params());
    combiner.setDirectionMultiplier(0.5, 'test-ctx');
    const signals = [buildSignal({ signalId: 'momentum', direction: 'long', strength: 0.6, confidence: 0.8 })];
    const result = combiner.combine(signals, undefined, 'event_long', 'test-ctx');
    expect(result).not.toBeNull();
    expect(result!.appliedDirectionMultiplier).toBe(0.5);
  });

  it('defaults appliedDirectionMultiplier to 1.0 when no context override', () => {
    const combiner = new WeightedAverageCombiner(baseWeights(), params());
    const signals = [buildSignal({ signalId: 'momentum', direction: 'long', strength: 0.6, confidence: 0.8 })];
    const result = combiner.combine(signals);
    expect(result).not.toBeNull();
    expect(result!.appliedDirectionMultiplier).toBe(1.0);
  });
});
```

(Assumes `baseWeights`, `params`, and `buildSignal` test helpers already exist in the file. If not, copy from existing tests in the same file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/signals && pnpm test WeightedAverageCombiner.test.ts -t "applied direction multiplier" 2>&1 | tail -20`
Expected: FAIL — `appliedDirectionMultiplier` is undefined.

- [ ] **Step 3: Extend `CombinedSignalOutput` interface**

In `packages/signals/src/core/types/signal.types.ts`, at the `CombinedSignalOutput` interface (around line 167-175), add:

```ts
export interface CombinedSignalOutput extends SignalOutput {
  /** Individual signals that contributed */
  componentSignals: SignalOutput[];

  /** Weights used in combination */
  weights: Record<string, number>;

  /** Multiplier applied to combined strength (post-flip value). Defaults to 1.0. */
  appliedDirectionMultiplier: number;

  /** Whether the multiplier came from epsilon-greedy exploration slot.
   *  False for segment hits, global fallback, and breaker-tripped fallback. */
  wasExploration?: boolean;
}
```

(Keep existing fields; only `appliedDirectionMultiplier` and optional `wasExploration` are new.)

- [ ] **Step 4: Populate `appliedDirectionMultiplier` in combiner output**

In `packages/signals/src/combiners/WeightedAverageCombiner.ts`, modify the `combinedOutput` object built around line 188. The `multiplier` local variable is already computed at line 162. Add the new field:

```ts
    const combinedOutput: CombinedSignalOutput = {
      signalId: 'combined',
      marketId: firstSignal.marketId,
      tokenId: firstSignal.tokenId,
      direction,
      strength,
      confidence,
      timestamp: now,
      ttlMs: Math.min(...usedSignals.map(s => s.signal.ttlMs)),
      componentSignals: usedSignals.map(s => s.signal),
      weights: this.getCurrentWeights(usedSignals),
      appliedDirectionMultiplier: multiplier,
      metadata: {
        combinerType: 'weighted_average',
        signalCount: usedSignals.length,
        conflictResolution: params.conflictResolution,
      },
    };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/signals && pnpm test WeightedAverageCombiner.test.ts -t "applied direction multiplier" 2>&1 | tail -20`
Expected: PASS for both new cases.

- [ ] **Step 6: Run the full combiner test suite**

Run: `cd packages/signals && pnpm test WeightedAverageCombiner.test.ts 2>&1 | tail -15`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
rtk git add packages/signals/src/core/types/signal.types.ts packages/signals/src/combiners/WeightedAverageCombiner.ts packages/signals/src/combiners/WeightedAverageCombiner.test.ts
rtk git commit -m "feat(combiner): expose appliedDirectionMultiplier on CombinedSignalOutput"
```

---

## Task 4: `DirectionResolver` — segment match path (happy path)

**Files:**
- Create: `packages/dashboard/src/services/DirectionResolver.ts`
- Create: `packages/dashboard/src/services/DirectionResolver.test.ts`

- [ ] **Step 1: Write failing test for the segment-match branch**

Create `packages/dashboard/src/services/DirectionResolver.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DirectionResolver } from './DirectionResolver.js';
import type { DirectionMultiplierPolicy } from './DirectionMultiplierPolicy.js';

const stubRepo = {
  getExplorationStats: vi.fn().mockResolvedValue({ count: 0, pnl: 0 }),
};

const stubConfig = {
  enabled: true,
  epsilon: 0.1,
  min: 0.0,
  max: 1.0,
  breakerMinTrades: 20,
  breakerWindowDays: 7,
  breakerMaxCumLoss: -150,
  breakerCacheTtlMs: 300_000,
};

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

describe('DirectionResolver — segment match', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns segment multiplier with reason=segment when a segment matches', async () => {
    const policy: DirectionMultiplierPolicy = {
      global: -1.0,
      minMultiplier: -1.25,
      maxMultiplier: 1.0,
      segments: [{
        id: 'event_financial-20to40-medium',
        multiplier: -1.25,
        marketTypes: ['event_financial'],
        priceRange: { min: 0.2, max: 0.4 },
        durationBands: ['medium'],
      }],
    };
    const resolver = new DirectionResolver({
      policyProvider: async () => policy,
      explorationConfig: stubConfig,
      rng: () => 0.5,  // would roll exploration if it got there
      paperPositionsRepo: stubRepo as any,
      logger,
    });

    const result = await resolver.resolve({
      marketType: 'event_financial',
      currentPrice: 0.3,
      endDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),  // medium duration
    });

    expect(result.multiplier).toBe(-1.25);
    expect(result.segmentId).toBe('event_financial-20to40-medium');
    expect(result.wasExploration).toBe(false);
    expect(result.reason).toBe('segment');
    expect(result.contextKey).toContain('event_financial');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/dashboard && pnpm test DirectionResolver.test.ts 2>&1 | tail -20`
Expected: FAIL — `DirectionResolver.js` cannot be resolved.

- [ ] **Step 3: Implement minimal `DirectionResolver`**

Create `packages/dashboard/src/services/DirectionResolver.ts`:

```ts
import {
  resolveDirectionMultiplier,
  type DirectionMultiplierContext,
  type DirectionMultiplierPolicy,
} from './DirectionMultiplierPolicy.js';

export type DirectionResolveReason = 'segment' | 'global' | 'exploration' | 'breaker_tripped';

export interface DirectionResolution {
  multiplier: number;
  contextKey: string;
  segmentId: string | null;
  wasExploration: boolean;
  reason: DirectionResolveReason;
}

export interface DirectionExplorationConfig {
  enabled: boolean;
  epsilon: number;
  min: number;
  max: number;
  breakerMinTrades: number;
  breakerWindowDays: number;
  breakerMaxCumLoss: number;
  breakerCacheTtlMs: number;
}

export interface DirectionResolverPaperPositionsRepo {
  getExplorationStats(windowDays: number): Promise<{ count: number; pnl: number }>;
}

interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
}

export interface DirectionResolverDeps {
  policyProvider: () => Promise<DirectionMultiplierPolicy>;
  explorationConfig: DirectionExplorationConfig;
  paperPositionsRepo: DirectionResolverPaperPositionsRepo;
  logger: Logger;
  rng?: () => number;
}

export class DirectionResolver {
  private readonly rng: () => number;

  constructor(private readonly deps: DirectionResolverDeps) {
    this.rng = deps.rng ?? Math.random;
  }

  async resolve(context: DirectionMultiplierContext): Promise<DirectionResolution> {
    const policy = await this.deps.policyProvider();
    const base = resolveDirectionMultiplier(policy, context);

    if (base.segmentId !== null) {
      return {
        multiplier: base.multiplier,
        contextKey: base.contextKey,
        segmentId: base.segmentId,
        wasExploration: false,
        reason: 'segment',
      };
    }

    // Segment miss — exploration and breaker branches added in later tasks.
    return {
      multiplier: policy.global,
      contextKey: base.contextKey,
      segmentId: null,
      wasExploration: false,
      reason: 'global',
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/dashboard && pnpm test DirectionResolver.test.ts 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/dashboard/src/services/DirectionResolver.ts packages/dashboard/src/services/DirectionResolver.test.ts
rtk git commit -m "feat: DirectionResolver skeleton with segment-match path"
```

---

## Task 5: `DirectionResolver` — exploration sampling branch

**Files:**
- Modify: `packages/dashboard/src/services/DirectionResolver.ts`
- Modify: `packages/dashboard/src/services/DirectionResolver.test.ts`

- [ ] **Step 1: Write failing test for exploration and non-exploration paths**

Add to `DirectionResolver.test.ts`:

```ts
describe('DirectionResolver — exploration sampling', () => {
  const policy: DirectionMultiplierPolicy = {
    global: -1.0, minMultiplier: -1.25, maxMultiplier: 1.0, segments: [],
  };
  const ctx = {
    marketType: 'event_long',
    currentPrice: 0.3,
    endDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
  };

  beforeEach(() => vi.clearAllMocks());

  it('returns global when segment misses and rng misses epsilon', async () => {
    const resolver = new DirectionResolver({
      policyProvider: async () => policy,
      explorationConfig: stubConfig,
      // First rng call is the epsilon roll; 0.5 > 0.1 epsilon → miss
      rng: () => 0.5,
      paperPositionsRepo: stubRepo as any,
      logger,
    });
    const result = await resolver.resolve(ctx);
    expect(result.multiplier).toBe(-1.0);
    expect(result.wasExploration).toBe(false);
    expect(result.reason).toBe('global');
  });

  it('samples uniformly from [min, max] when segment misses and rng hits epsilon', async () => {
    // 1st rng() = 0.05 → < 0.1 epsilon → hit.
    // 2nd rng() = 0.7 → sampled = 0 + 0.7 * (1 - 0) = 0.7
    const rngCalls = [0.05, 0.7];
    let i = 0;
    const resolver = new DirectionResolver({
      policyProvider: async () => policy,
      explorationConfig: stubConfig,
      rng: () => rngCalls[i++],
      paperPositionsRepo: stubRepo as any,
      logger,
    });
    const result = await resolver.resolve(ctx);
    expect(result.multiplier).toBeCloseTo(0.7, 5);
    expect(result.wasExploration).toBe(true);
    expect(result.reason).toBe('exploration');
    expect(result.segmentId).toBeNull();
  });

  it('returns global with reason=global when exploration is disabled, regardless of rng', async () => {
    const resolver = new DirectionResolver({
      policyProvider: async () => policy,
      explorationConfig: { ...stubConfig, enabled: false },
      rng: () => 0.0,  // would normally trigger exploration
      paperPositionsRepo: stubRepo as any,
      logger,
    });
    const result = await resolver.resolve(ctx);
    expect(result.multiplier).toBe(-1.0);
    expect(result.wasExploration).toBe(false);
    expect(result.reason).toBe('global');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/dashboard && pnpm test DirectionResolver.test.ts -t "exploration sampling" 2>&1 | tail -30`
Expected: FAIL — current implementation always returns global on segment miss.

- [ ] **Step 3: Extend `DirectionResolver.resolve()` with the exploration branch**

In `packages/dashboard/src/services/DirectionResolver.ts`, replace the "Segment miss" block:

```ts
    // Segment miss — consider exploration.
    if (!this.deps.explorationConfig.enabled) {
      return {
        multiplier: policy.global,
        contextKey: base.contextKey,
        segmentId: null,
        wasExploration: false,
        reason: 'global',
      };
    }

    const roll = this.rng();
    if (roll >= this.deps.explorationConfig.epsilon) {
      return {
        multiplier: policy.global,
        contextKey: base.contextKey,
        segmentId: null,
        wasExploration: false,
        reason: 'global',
      };
    }

    const { min, max } = this.deps.explorationConfig;
    const sampled = min + this.rng() * (max - min);
    return {
      multiplier: sampled,
      contextKey: base.contextKey,
      segmentId: null,
      wasExploration: true,
      reason: 'exploration',
    };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/dashboard && pnpm test DirectionResolver.test.ts 2>&1 | tail -20`
Expected: all 4 tests pass (segment + 3 exploration scenarios).

- [ ] **Step 5: Commit**

```bash
rtk git add packages/dashboard/src/services/DirectionResolver.ts packages/dashboard/src/services/DirectionResolver.test.ts
rtk git commit -m "feat(DirectionResolver): epsilon-greedy exploration on segment miss"
```

---

## Task 6: `DirectionResolver` — circuit breaker with TTL cache

**Files:**
- Modify: `packages/dashboard/src/services/DirectionResolver.ts`
- Modify: `packages/dashboard/src/services/DirectionResolver.test.ts`

- [ ] **Step 1: Write failing tests for breaker-tripped and cache behavior**

Add to `DirectionResolver.test.ts`:

```ts
describe('DirectionResolver — circuit breaker', () => {
  const policy: DirectionMultiplierPolicy = {
    global: -1.0, minMultiplier: -1.25, maxMultiplier: 1.0, segments: [],
  };
  const ctx = {
    marketType: 'event_long',
    currentPrice: 0.3,
    endDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
  };

  beforeEach(() => vi.clearAllMocks());

  it('returns global with reason=breaker_tripped when exploration losses exceed threshold', async () => {
    const repo = { getExplorationStats: vi.fn().mockResolvedValue({ count: 22, pnl: -172.45 }) };
    const resolver = new DirectionResolver({
      policyProvider: async () => policy,
      explorationConfig: stubConfig,
      rng: () => 0.05,  // would sample exploration otherwise
      paperPositionsRepo: repo as any,
      logger,
    });
    const result = await resolver.resolve(ctx);
    expect(result.reason).toBe('breaker_tripped');
    expect(result.wasExploration).toBe(false);
    expect(result.multiplier).toBe(-1.0);
  });

  it('does not trip when count below minTrades', async () => {
    const repo = { getExplorationStats: vi.fn().mockResolvedValue({ count: 19, pnl: -500 }) };
    const resolver = new DirectionResolver({
      policyProvider: async () => policy,
      explorationConfig: stubConfig,
      rng: () => 0.05,
      paperPositionsRepo: repo as any,
      logger,
    });
    const result = await resolver.resolve(ctx);
    // Should proceed to sampling, not breaker_tripped
    expect(result.reason).toBe('exploration');
  });

  it('caches breaker state and does not requery within TTL', async () => {
    const repo = { getExplorationStats: vi.fn().mockResolvedValue({ count: 22, pnl: -200 }) };
    const resolver = new DirectionResolver({
      policyProvider: async () => policy,
      explorationConfig: { ...stubConfig, breakerCacheTtlMs: 60_000 },
      rng: () => 0.05,
      paperPositionsRepo: repo as any,
      logger,
    });
    await resolver.resolve(ctx);
    await resolver.resolve(ctx);
    await resolver.resolve(ctx);
    expect(repo.getExplorationStats).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/dashboard && pnpm test DirectionResolver.test.ts -t "circuit breaker" 2>&1 | tail -30`
Expected: FAIL — breaker logic not yet implemented.

- [ ] **Step 3: Add breaker state + check to `DirectionResolver`**

In `packages/dashboard/src/services/DirectionResolver.ts`, add a private cache field to the class and a private method:

```ts
export class DirectionResolver {
  private readonly rng: () => number;
  private breakerCache: { tripped: boolean; fetchedAt: number; stats: { count: number; pnl: number } } | null = null;

  constructor(private readonly deps: DirectionResolverDeps) {
    this.rng = deps.rng ?? Math.random;
  }

  private async isBreakerTripped(): Promise<boolean> {
    const now = Date.now();
    if (this.breakerCache && now - this.breakerCache.fetchedAt < this.deps.explorationConfig.breakerCacheTtlMs) {
      return this.breakerCache.tripped;
    }
    const stats = await this.deps.paperPositionsRepo.getExplorationStats(
      this.deps.explorationConfig.breakerWindowDays,
    );
    const tripped =
      stats.count >= this.deps.explorationConfig.breakerMinTrades &&
      stats.pnl < this.deps.explorationConfig.breakerMaxCumLoss;
    this.breakerCache = { tripped, fetchedAt: now, stats };
    return tripped;
  }

  async resolve(context: DirectionMultiplierContext): Promise<DirectionResolution> {
    const policy = await this.deps.policyProvider();
    const base = resolveDirectionMultiplier(policy, context);

    if (base.segmentId !== null) {
      return {
        multiplier: base.multiplier,
        contextKey: base.contextKey,
        segmentId: base.segmentId,
        wasExploration: false,
        reason: 'segment',
      };
    }

    if (!this.deps.explorationConfig.enabled) {
      return {
        multiplier: policy.global,
        contextKey: base.contextKey,
        segmentId: null,
        wasExploration: false,
        reason: 'global',
      };
    }

    if (await this.isBreakerTripped()) {
      return {
        multiplier: policy.global,
        contextKey: base.contextKey,
        segmentId: null,
        wasExploration: false,
        reason: 'breaker_tripped',
      };
    }

    const roll = this.rng();
    if (roll >= this.deps.explorationConfig.epsilon) {
      return {
        multiplier: policy.global,
        contextKey: base.contextKey,
        segmentId: null,
        wasExploration: false,
        reason: 'global',
      };
    }

    const { min, max } = this.deps.explorationConfig;
    const sampled = min + this.rng() * (max - min);
    return {
      multiplier: sampled,
      contextKey: base.contextKey,
      segmentId: null,
      wasExploration: true,
      reason: 'exploration',
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/dashboard && pnpm test DirectionResolver.test.ts 2>&1 | tail -20`
Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/dashboard/src/services/DirectionResolver.ts packages/dashboard/src/services/DirectionResolver.test.ts
rtk git commit -m "feat(DirectionResolver): TTL-cached circuit breaker on exploration PnL"
```

---

## Task 7: Add `getExplorationStats` to paperPositionsRepo + `trading_config` status write

**Files:**
- Modify: `packages/dashboard/src/database/repositories.ts` (add `getExplorationStats` method)
- Modify: `packages/dashboard/src/services/DirectionResolver.ts` (write status on trip)
- Modify: `packages/dashboard/src/services/DirectionResolver.test.ts`

- [ ] **Step 1: Write failing test for status-write on trip**

Add to `DirectionResolver.test.ts`:

```ts
describe('DirectionResolver — breaker status write', () => {
  const policy: DirectionMultiplierPolicy = {
    global: -1.0, minMultiplier: -1.25, maxMultiplier: 1.0, segments: [],
  };
  const ctx = {
    marketType: 'event_long',
    currentPrice: 0.3,
    endDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
  };

  beforeEach(() => vi.clearAllMocks());

  it('writes status=tripped to trading_config when breaker first trips', async () => {
    const repo = { getExplorationStats: vi.fn().mockResolvedValue({ count: 22, pnl: -172.45 }) };
    const setConfig = vi.fn().mockResolvedValue(undefined);
    const resolver = new DirectionResolver({
      policyProvider: async () => policy,
      explorationConfig: stubConfig,
      rng: () => 0.05,
      paperPositionsRepo: repo as any,
      logger,
      setTradingConfig: setConfig,
    });
    await resolver.resolve(ctx);
    expect(setConfig).toHaveBeenCalledWith(
      'direction_exploration_status',
      expect.objectContaining({
        state: 'tripped',
        exploreCount: 22,
        explorePnl: -172.45,
        thresholdTrades: 20,
        thresholdLoss: -150,
      }),
      expect.any(String),
    );
  });

  it('writes status=active when breaker un-trips after previously tripped', async () => {
    // First call: tripped. Second call (after cache expires): no longer tripped.
    const repo = {
      getExplorationStats: vi.fn()
        .mockResolvedValueOnce({ count: 22, pnl: -172 })
        .mockResolvedValueOnce({ count: 8, pnl: -30 }),
    };
    const setConfig = vi.fn().mockResolvedValue(undefined);
    const resolver = new DirectionResolver({
      policyProvider: async () => policy,
      explorationConfig: { ...stubConfig, breakerCacheTtlMs: 0 },  // disable cache for test
      rng: () => 0.05,
      paperPositionsRepo: repo as any,
      logger,
      setTradingConfig: setConfig,
    });
    await resolver.resolve(ctx);
    await resolver.resolve(ctx);
    const calls = setConfig.mock.calls.map(c => c[1].state);
    expect(calls).toEqual(['tripped', 'active']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/dashboard && pnpm test DirectionResolver.test.ts -t "breaker status write" 2>&1 | tail -30`
Expected: FAIL — `setTradingConfig` not accepted in deps.

- [ ] **Step 3: Add `setTradingConfig` to deps and wire into breaker transitions**

In `packages/dashboard/src/services/DirectionResolver.ts`, extend `DirectionResolverDeps` and update the class:

```ts
export interface DirectionResolverDeps {
  policyProvider: () => Promise<DirectionMultiplierPolicy>;
  explorationConfig: DirectionExplorationConfig;
  paperPositionsRepo: DirectionResolverPaperPositionsRepo;
  logger: Logger;
  rng?: () => number;
  setTradingConfig?: (key: string, value: unknown, changeReason: string) => Promise<void>;
}
```

Modify `isBreakerTripped` to detect transitions and call `setTradingConfig`:

```ts
  private async isBreakerTripped(): Promise<boolean> {
    const now = Date.now();
    if (this.breakerCache && now - this.breakerCache.fetchedAt < this.deps.explorationConfig.breakerCacheTtlMs) {
      return this.breakerCache.tripped;
    }
    const stats = await this.deps.paperPositionsRepo.getExplorationStats(
      this.deps.explorationConfig.breakerWindowDays,
    );
    const tripped =
      stats.count >= this.deps.explorationConfig.breakerMinTrades &&
      stats.pnl < this.deps.explorationConfig.breakerMaxCumLoss;

    const prevTripped = this.breakerCache?.tripped ?? null;
    this.breakerCache = { tripped, fetchedAt: now, stats };

    if (this.deps.setTradingConfig && (prevTripped === null || prevTripped !== tripped)) {
      const status = {
        state: tripped ? 'tripped' : 'active',
        transitionAt: new Date(now).toISOString(),
        exploreCount: stats.count,
        explorePnl: stats.pnl,
        thresholdTrades: this.deps.explorationConfig.breakerMinTrades,
        thresholdLoss: this.deps.explorationConfig.breakerMaxCumLoss,
      };
      try {
        await this.deps.setTradingConfig(
          'direction_exploration_status',
          status,
          `Direction exploration breaker ${status.state}`,
        );
      } catch (err) {
        this.deps.logger.warn({ err }, 'Failed to persist direction_exploration_status');
      }
    }

    return tripped;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/dashboard && pnpm test DirectionResolver.test.ts 2>&1 | tail -20`
Expected: all 9 tests pass.

- [ ] **Step 5: Add `getExplorationStats` method to `paperPositionsRepo`**

In `packages/dashboard/src/database/repositories.ts`, inside the `paperPositionsRepo` object, add:

```ts
  async getExplorationStats(windowDays: number): Promise<{ count: number; pnl: number }> {
    const result = await query<{ count: string; pnl: string | null }>(
      `SELECT COUNT(*) AS count, COALESCE(SUM(realized_pnl), 0) AS pnl
       FROM paper_positions
       WHERE was_exploration = true
         AND closed_at >= NOW() - ($1 || ' days')::interval
         AND realized_pnl IS NOT NULL`,
      [String(windowDays)],
    );
    const row = result.rows[0];
    return {
      count: Number(row.count ?? 0),
      pnl: Number(row.pnl ?? 0),
    };
  },
```

- [ ] **Step 6: Commit**

```bash
rtk git add packages/dashboard/src/database/repositories.ts packages/dashboard/src/services/DirectionResolver.ts packages/dashboard/src/services/DirectionResolver.test.ts
rtk git commit -m "feat(DirectionResolver): persist breaker state to trading_config on transitions"
```

---

## Task 8: `DirectionMultiplierLearningService` — widen range + new buckets

**Files:**
- Modify: `packages/dashboard/src/services/DirectionMultiplierLearningService.ts` (DEFAULT_CONFIG around line 66, bucketing around line 80)
- Modify: `packages/dashboard/src/services/DirectionMultiplierLearningService.test.ts`

- [ ] **Step 1: Write failing tests for new buckets and range**

Add to `packages/dashboard/src/services/DirectionMultiplierLearningService.test.ts`:

```ts
import { bucketDirectionMultiplier } from './DirectionMultiplierLearningService.js';
// ^ If not currently exported, export it in Step 3.

describe('DirectionMultiplierLearningService — widened buckets', () => {
  it.each([
    [-1.25, 'strong_negative'],
    [-0.5,  'strong_negative'],
    [-0.49, 'near_zero'],
    [0.0,   'near_zero'],
    [0.24,  'near_zero'],
    [0.25,  'weak_positive'],
    [0.5,   'weak_positive'],
    [0.74,  'weak_positive'],
    [0.75,  'strong_positive'],
    [1.0,   'strong_positive'],
  ])('buckets %f as %s', (mult, expected) => {
    expect(bucketDirectionMultiplier(mult)).toBe(expected);
  });

  it('DEFAULT_CONFIG permits multipliers up to +1.0', () => {
    const { DEFAULT_CONFIG } = require('./DirectionMultiplierLearningService.js');
    expect(DEFAULT_CONFIG.maxMultiplier).toBe(1.0);
    expect(DEFAULT_CONFIG.maxPositiveMultiplier).toBe(1.0);
    expect(DEFAULT_CONFIG.minMultiplier).toBe(-1.25);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/dashboard && pnpm test DirectionMultiplierLearningService.test.ts -t "widened buckets" 2>&1 | tail -20`
Expected: FAIL — bucket logic still uses old thresholds, config still capped at 0.1.

- [ ] **Step 3: Update `DEFAULT_CONFIG`, `bucketDirectionMultiplier`, and export the bucket function**

In `packages/dashboard/src/services/DirectionMultiplierLearningService.ts`:

(a) Replace the `DEFAULT_CONFIG` block around line 66:

```ts
const DEFAULT_CONFIG: DirectionMultiplierLearningConfig = {
  enabled: true,
  evaluationIntervalMs: 6 * 60 * 60 * 1000,
  lookbackDays: 30,
  minSegmentTrades: 24,
  minCandidateTrades: 8,
  minImprovementPerTrade: 0.75,
  minWinRateLift: 0.08,
  maxSegments: 8,
  minMultiplier: -1.25,
  maxMultiplier: 1.0,
  maxPositiveMultiplier: 1.0,
};

export { DEFAULT_CONFIG };
```

(b) Replace `bucketDirectionMultiplier` around line 80 and export it:

```ts
export function bucketDirectionMultiplier(multiplier: number): string {
  if (multiplier <= -0.5) return 'strong_negative';
  if (multiplier < 0.25)  return 'near_zero';
  if (multiplier < 0.75)  return 'weak_positive';
  return 'strong_positive';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/dashboard && pnpm test DirectionMultiplierLearningService.test.ts 2>&1 | tail -15`
Expected: all tests pass (pre-existing + new bucket tests).

- [ ] **Step 5: Commit**

```bash
rtk git add packages/dashboard/src/services/DirectionMultiplierLearningService.ts packages/dashboard/src/services/DirectionMultiplierLearningService.test.ts
rtk git commit -m "feat(learner): widen direction multiplier range to [-1.25, +1.0] with new bucket set"
```

---

## Task 9: `DirectionMultiplierLearningService` — prefer per-trade multiplier in learner query

**Files:**
- Modify: `packages/dashboard/src/services/DirectionMultiplierLearningService.ts` (query at line ~293)
- Modify: `packages/dashboard/src/services/DirectionMultiplierLearningService.test.ts`

- [ ] **Step 1: Write failing integration-style test for the query COALESCE ordering**

Add to `DirectionMultiplierLearningService.test.ts`:

```ts
describe('DirectionMultiplierLearningService — query COALESCE', () => {
  it('learner query prefers pp.applied_direction_multiplier over signal_weights_history', async () => {
    // Inspect the SQL text the service would run — we do not need a live DB.
    // The service uses `query` from index.js; we stub it and assert the SQL contains
    // the COALESCE in the required order.
    const indexMod = await import('../database/index.js');
    const querySpy = vi.spyOn(indexMod, 'query').mockResolvedValue({ rows: [] } as any);
    const signalWeightsMod = await import('../database/repositories.js');
    vi.spyOn(signalWeightsMod.signalWeightsRepo, 'get').mockResolvedValue({ weight: -1.0 } as any);

    const { DirectionMultiplierLearningService } = await import('./DirectionMultiplierLearningService.js');
    const svc = new DirectionMultiplierLearningService();
    await svc.evaluate();

    const sqlExecuted = querySpy.mock.calls.map(c => c[0] as string).join('\n');
    expect(sqlExecuted).toMatch(/COALESCE\s*\(\s*pp\.applied_direction_multiplier\s*,\s*dm\.weight\s*,\s*\$2\s*\)/i);
    querySpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/dashboard && pnpm test DirectionMultiplierLearningService.test.ts -t "query COALESCE" 2>&1 | tail -25`
Expected: FAIL — SQL does not contain `pp.applied_direction_multiplier`.

- [ ] **Step 3: Update the learner query**

In `packages/dashboard/src/services/DirectionMultiplierLearningService.ts`, inside `evaluate()`, locate the SQL template around line 279 and replace the `COALESCE(dm.weight, $2) AS direction_multiplier` line:

```ts
       `SELECT
          COALESCE(m.market_type, 'unknown') AS market_type,
          CASE
            WHEN pp.side = 'long' THEN pp.avg_entry_price
            ELSE 1 - pp.avg_entry_price
          END AS yes_entry_price,
          CASE
            WHEN m.end_date IS NULL THEN 'medium'
            WHEN m.end_date - pp.opened_at <= INTERVAL '1 day' THEN 'intraday'
            WHEN m.end_date - pp.opened_at <= INTERVAL '7 days' THEN 'short'
            WHEN m.end_date - pp.opened_at <= INTERVAL '30 days' THEN 'medium'
            ELSE 'long'
          END AS duration_band,
          COALESCE(pp.realized_pnl, 0) AS realized_pnl,
          COALESCE(pp.applied_direction_multiplier, dm.weight, $2) AS direction_multiplier
        FROM paper_positions pp
        JOIN markets m ON m.id = pp.market_id
        LEFT JOIN LATERAL (
          SELECT swh.weight
          FROM signal_weights_history swh
          WHERE swh.signal_type = 'direction_multiplier'
            AND swh.time <= pp.opened_at
          ORDER BY swh.time DESC
          LIMIT 1
        ) dm ON TRUE
        WHERE pp.closed_at IS NOT NULL
          AND pp.opened_at >= NOW() - INTERVAL '1 day' * $1`,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/dashboard && pnpm test DirectionMultiplierLearningService.test.ts 2>&1 | tail -15`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/dashboard/src/services/DirectionMultiplierLearningService.ts packages/dashboard/src/services/DirectionMultiplierLearningService.test.ts
rtk git commit -m "fix(learner): prefer per-trade applied_direction_multiplier via COALESCE"
```

---

## Task 10: Wire `DirectionResolver` into `SignalEngine`

**Files:**
- Modify: `packages/dashboard/src/services/SignalEngine.ts` (around lines 21, 283-291, 449-483)
- Modify: `packages/dashboard/src/services/SignalEngine.test.ts` (if it exists) or add new coverage

- [ ] **Step 1: Write failing test that verifies SignalEngine uses DirectionResolver and consolidates metadata**

If `SignalEngine.test.ts` doesn't exist, create minimal coverage at `packages/dashboard/src/services/SignalEngine.test.ts`. Else append:

```ts
import { describe, it, expect, vi } from 'vitest';

describe('SignalEngine — DirectionResolver integration', () => {
  it('passes resolver multiplier to combiner and exposes wasExploration + metadata.direction on output', async () => {
    // Minimal boot: mock combiner.combine to return a stub CombinedSignalOutput.
    // Use a fake DirectionResolver that returns a deterministic exploration result.
    const fakeResolver = {
      resolve: vi.fn().mockResolvedValue({
        multiplier: 0.6,
        contextKey: 'event_long-20to40-medium',
        segmentId: null,
        wasExploration: true,
        reason: 'exploration',
      }),
    };
    const stubCombined = {
      signalId: 'combined',
      marketId: 'mkt1',
      tokenId: 'tok1',
      direction: 'long' as const,
      strength: 0.3,
      confidence: 0.6,
      timestamp: new Date(),
      ttlMs: 60_000,
      componentSignals: [],
      weights: {},
      appliedDirectionMultiplier: 0.6,
      metadata: { combinerType: 'weighted_average' },
    };
    const combinerMock = {
      getWeights: () => ({}),
      setWeights: () => {},
      setDirectionMultiplier: vi.fn(),
      setDirectionMultipliers: vi.fn(),
      combine: vi.fn().mockReturnValue(stubCombined),
    };

    // Full SignalEngine boot is heavy. Test the enrichment helper directly.
    // Extract enrichCombined(output, resolution) into a named export below.
    const { enrichCombinedWithDirection } = await import('./SignalEngine.js');
    const enriched = enrichCombinedWithDirection(stubCombined as any, {
      multiplier: 0.6,
      contextKey: 'event_long-20to40-medium',
      segmentId: null,
      wasExploration: true,
      reason: 'exploration',
    });

    expect(enriched.appliedDirectionMultiplier).toBe(0.6);
    expect(enriched.wasExploration).toBe(true);
    expect(enriched.metadata).toMatchObject({
      direction: {
        contextKey: 'event_long-20to40-medium',
        segmentId: 'global',
        reason: 'exploration',
      },
    });
    expect(enriched.metadata).not.toHaveProperty('directionMultiplier');
    expect(enriched.metadata).not.toHaveProperty('directionContextKey');
    expect(enriched.metadata).not.toHaveProperty('directionPolicySegmentId');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/dashboard && pnpm test SignalEngine.test.ts -t "DirectionResolver integration" 2>&1 | tail -25`
Expected: FAIL — `enrichCombinedWithDirection` not exported.

- [ ] **Step 3: Add `DirectionResolver` import, optional dep, and enrichment helper to `SignalEngine.ts`**

In `packages/dashboard/src/services/SignalEngine.ts`:

(a) Remove the existing `resolveDirectionMultiplier` import at line 21 if it is no longer used inline; replace with:

```ts
import type { DirectionResolver, DirectionResolution } from './DirectionResolver.js';
```

(Keep `sanitizeDirectionMultiplierPolicy` and policy-loading imports; only the pure resolver function is replaced.)

(b) Export a helper that consolidates metadata (keeps this testable in isolation):

```ts
export function enrichCombinedWithDirection<T extends {
  metadata?: Record<string, unknown>;
}>(combined: T, resolution: DirectionResolution): T & {
  appliedDirectionMultiplier: number;
  wasExploration: boolean;
} {
  const { directionMultiplier: _a, directionContextKey: _b, directionPolicySegmentId: _c, ...restMeta } = (combined.metadata ?? {}) as Record<string, unknown>;
  return {
    ...combined,
    appliedDirectionMultiplier: resolution.multiplier,
    wasExploration: resolution.wasExploration,
    metadata: {
      ...restMeta,
      direction: {
        contextKey: resolution.contextKey,
        segmentId: resolution.segmentId ?? 'global',
        reason: resolution.reason,
      },
    },
  };
}
```

(c) Accept `directionResolver` as a **required** field in the SignalEngine constructor / initializer. Find the existing constructor / `initializeSignalEngine` function and add:

```ts
// Add to the class:
private readonly directionResolver: DirectionResolver;
```

And in the constructor or `initializeSignalEngine` options:

```ts
// In config type:
export interface SignalEngineConfig {
  // ... existing
  directionResolver: DirectionResolver;  // required
}
```

Any existing SignalEngine tests that constructed the engine without a resolver need to be updated to pass a stub (e.g., `{ resolve: async () => ({ multiplier: -1.0, contextKey: 'stub', segmentId: null, wasExploration: false, reason: 'global' }) }`). The legacy synchronous `resolveDirectionMultiplier` call is removed from `SignalEngine.ts` entirely — all direction resolution goes through the resolver.

(d) Replace the synchronous direction resolution at lines 449-458 with an async call:

```ts
    const directionResolution = await this.directionResolver.resolve({
      marketType: market.marketType,
      currentPrice: market.currentPrice,
      endDate: market.endDate,
      question: market.question,
    });

    this.combiner.setDirectionMultiplier(
      directionResolution.multiplier,
      directionResolution.contextKey,
    );
```

(e) Replace the metadata write at lines 478-483 with the enrichment helper:

```ts
    const confidenceCap = this.computeBayesianConfidenceCap(context.priceBars);
    combined.confidence *= confidenceCap;
    const enriched = enrichCombinedWithDirection(combined, directionResolution);
    // Return enriched, not combined
```

Update subsequent references in the same function body from `combined.` to `enriched.` where relevant (e.g., final return value, logging). Verify all call sites read from `enriched` onward.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/dashboard && pnpm test SignalEngine.test.ts -t "DirectionResolver integration" 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Wire `DirectionResolver` in `server.ts`**

In `packages/dashboard/src/server.ts`, around the existing SignalEngine initialization (near line 286), instantiate a resolver and pass it:

```ts
import { DirectionResolver } from './services/DirectionResolver.js';
import { tradingConfigRepo, paperPositionsRepo } from './database/repositories.js';

// Earlier, build a cached policy provider
let cachedPolicy: { data: DirectionMultiplierPolicy; fetchedAt: number } | null = null;
const POLICY_TTL_MS = 60_000;
const policyProvider = async (): Promise<DirectionMultiplierPolicy> => {
  const now = Date.now();
  if (cachedPolicy && now - cachedPolicy.fetchedAt < POLICY_TTL_MS) return cachedPolicy.data;
  const entry = await tradingConfigRepo.get('direction_multiplier_policy');
  const data = sanitizeDirectionMultiplierPolicy(entry?.value as DirectionMultiplierPolicy | undefined ?? DEFAULT_DIRECTION_MULTIPLIER_POLICY);
  cachedPolicy = { data, fetchedAt: now };
  return data;
};

const directionResolver = new DirectionResolver({
  policyProvider,
  paperPositionsRepo,
  logger,
  setTradingConfig: (key, value, reason) => tradingConfigRepo.set(key, value, reason),
  explorationConfig: {
    enabled: process.env.ENABLE_DIRECTION_EXPLORATION !== 'false',
    epsilon: parseFloat(process.env.DIRECTION_EXPLORATION_EPSILON ?? '0.10'),
    min: parseFloat(process.env.DIRECTION_EXPLORATION_MIN ?? '0.0'),
    max: parseFloat(process.env.DIRECTION_EXPLORATION_MAX ?? '1.0'),
    breakerMinTrades: parseInt(process.env.DIRECTION_EXPLORATION_BREAKER_MIN_TRADES ?? '20', 10),
    breakerWindowDays: parseInt(process.env.DIRECTION_EXPLORATION_BREAKER_WINDOW_DAYS ?? '7', 10),
    breakerMaxCumLoss: parseFloat(process.env.DIRECTION_EXPLORATION_BREAKER_MAX_CUM_LOSS ?? '-150'),
    breakerCacheTtlMs: 300_000,
  },
});

// Existing initializeSignalEngine call — add directionResolver to options
const signalEngine = initializeSignalEngine({
  enabled: true,
  computeIntervalMs: parseInt(process.env.SIGNAL_INTERVAL_MS || '60000', 10),
  maxMarketsPerCycle: parseInt(process.env.MAX_SIGNAL_MARKETS || '15', 10),
  minPriceBars: 3,
  minCombinedConfidence: optimizedParams.minCombinedConfidence,
  minCombinedStrength: optimizedParams.minCombinedStrength,
  directionResolver,
});
```

- [ ] **Step 6: Run the full SignalEngine test suite**

Run: `cd packages/dashboard && pnpm test SignalEngine 2>&1 | tail -15`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
rtk git add packages/dashboard/src/services/SignalEngine.ts packages/dashboard/src/services/SignalEngine.test.ts packages/dashboard/src/server.ts
rtk git commit -m "feat: wire DirectionResolver into SignalEngine and consolidate metadata.direction"
```

---

## Task 11: Propagate `appliedDirectionMultiplier` + `wasExploration` through `AutoSignalExecutor`

**Files:**
- Modify: `packages/dashboard/src/services/AutoSignalExecutor.ts`
- Modify: `packages/dashboard/src/services/AutoSignalExecutor.test.ts`

- [ ] **Step 1: Write failing test**

Add to `packages/dashboard/src/services/AutoSignalExecutor.test.ts`:

```ts
describe('AutoSignalExecutor — direction multiplier propagation', () => {
  it('passes appliedDirectionMultiplier and wasExploration to paperPositionsRepo', async () => {
    const openSpy = vi.spyOn(paperPositionsRepo, 'openPositionAtomically')
      .mockResolvedValue({ opened: true });
    // Construct a signal with the new fields
    const signal = buildCombinedSignal({
      direction: 'long',
      strength: 0.4,
      confidence: 0.7,
      appliedDirectionMultiplier: 0.75,
      wasExploration: true,
    });
    const executor = buildExecutor();
    await executor.executeSignal(signal);
    expect(openSpy).toHaveBeenCalledTimes(1);
    const positionArg = openSpy.mock.calls[0][0];
    expect(positionArg.applied_direction_multiplier).toBe(0.75);
    expect(positionArg.was_exploration).toBe(true);
    openSpy.mockRestore();
  });

  it('defaults both fields to null/false when signal omits them', async () => {
    const openSpy = vi.spyOn(paperPositionsRepo, 'openPositionAtomically')
      .mockResolvedValue({ opened: true });
    const signal = buildCombinedSignal({ direction: 'long', strength: 0.4, confidence: 0.7 });
    const executor = buildExecutor();
    await executor.executeSignal(signal);
    const positionArg = openSpy.mock.calls[0][0];
    expect(positionArg.applied_direction_multiplier ?? null).toBeNull();
    expect(positionArg.was_exploration ?? false).toBe(false);
    openSpy.mockRestore();
  });
});
```

(Reuse `buildCombinedSignal` / `buildExecutor` helpers already present in the file. If those helpers don't accept the new fields, widen their signatures first.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/dashboard && pnpm test AutoSignalExecutor.test.ts -t "direction multiplier propagation" 2>&1 | tail -20`
Expected: FAIL — the two position fields are not populated.

- [ ] **Step 3: Populate the fields in `AutoSignalExecutor`**

In `packages/dashboard/src/services/AutoSignalExecutor.ts`, locate the position-construction block before `paperPositionsRepo.openPositionAtomically(...)`. Add the two fields to the object literal:

```ts
    const position: PaperPosition = {
      // ... existing
      applied_direction_multiplier: signal.appliedDirectionMultiplier ?? null,
      was_exploration: signal.wasExploration ?? false,
    };
    const result = await paperPositionsRepo.openPositionAtomically(position, cost, fee);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/dashboard && pnpm test AutoSignalExecutor.test.ts -t "direction multiplier propagation" 2>&1 | tail -15`
Expected: PASS.

- [ ] **Step 5: Run the full executor suite to confirm no regressions**

Run: `cd packages/dashboard && pnpm test AutoSignalExecutor 2>&1 | tail -15`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
rtk git add packages/dashboard/src/services/AutoSignalExecutor.ts packages/dashboard/src/services/AutoSignalExecutor.test.ts
rtk git commit -m "feat(executor): propagate appliedDirectionMultiplier and wasExploration to paper_positions"
```

---

## Task 12: Env vars in `docker-compose.gcp.yml`

**Files:**
- Modify: `docker-compose.gcp.yml` (dashboard-api service `environment:` block)

- [ ] **Step 1: Add env vars to the dashboard-api service**

In `docker-compose.gcp.yml`, under `services.dashboard-api.environment`, append:

```yaml
      - ENABLE_DIRECTION_EXPLORATION=true
      - DIRECTION_EXPLORATION_EPSILON=0.10
      - DIRECTION_EXPLORATION_MIN=0.0
      - DIRECTION_EXPLORATION_MAX=1.0
      - DIRECTION_EXPLORATION_BREAKER_MIN_TRADES=20
      - DIRECTION_EXPLORATION_BREAKER_WINDOW_DAYS=7
      - DIRECTION_EXPLORATION_BREAKER_MAX_CUM_LOSS=-150
```

- [ ] **Step 2: Verify YAML is valid**

Run: `rtk git diff docker-compose.gcp.yml`
Expected: only the new lines in the dashboard-api environment section; no indentation drift.

- [ ] **Step 3: Commit**

```bash
rtk git add docker-compose.gcp.yml
rtk git commit -m "chore: add direction exploration env vars to dashboard-api service"
```

---

## Task 13: End-to-end integration test — exploration branch hitting persistence

**Files:**
- Create: `packages/dashboard/src/services/__tests__/DirectionExploration.integration.test.ts`

- [ ] **Step 1: Write the integration test**

Create the file with contents:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DirectionResolver } from '../DirectionResolver.js';
import { enrichCombinedWithDirection } from '../SignalEngine.js';
import type { DirectionMultiplierPolicy } from '../DirectionMultiplierPolicy.js';

describe('Direction exploration — end-to-end integration', () => {
  const policy: DirectionMultiplierPolicy = {
    global: -1.0, minMultiplier: -1.25, maxMultiplier: 1.0, segments: [],
  };
  const ctx = {
    marketType: 'event_long',
    currentPrice: 0.3,
    endDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
  };
  const stubRepo = {
    getExplorationStats: vi.fn().mockResolvedValue({ count: 5, pnl: 0 }),
    openPositionAtomically: vi.fn().mockResolvedValue({ opened: true }),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  beforeEach(() => vi.clearAllMocks());

  it('an exploration resolution ends up persisted with was_exploration=true', async () => {
    const resolver = new DirectionResolver({
      policyProvider: async () => policy,
      explorationConfig: {
        enabled: true, epsilon: 1.0, min: 0.0, max: 1.0,
        breakerMinTrades: 20, breakerWindowDays: 7, breakerMaxCumLoss: -150, breakerCacheTtlMs: 300_000,
      },
      rng: (() => { let i = 0; const vals = [0.0, 0.6]; return () => vals[i++ % 2]; })(),
      paperPositionsRepo: stubRepo as any,
      logger,
    });

    const resolution = await resolver.resolve(ctx);
    expect(resolution.wasExploration).toBe(true);
    expect(resolution.multiplier).toBeCloseTo(0.6, 5);

    // Simulate combiner producing a combined output with appliedDirectionMultiplier set
    const combined = {
      signalId: 'combined', marketId: 'mkt1', tokenId: 'tok1',
      direction: 'long' as const, strength: 0.3, confidence: 0.7,
      timestamp: new Date(), ttlMs: 60_000, componentSignals: [], weights: {},
      appliedDirectionMultiplier: resolution.multiplier, metadata: {},
    };
    const enriched = enrichCombinedWithDirection(combined, resolution);
    expect(enriched.wasExploration).toBe(true);
    expect(enriched.appliedDirectionMultiplier).toBeCloseTo(0.6, 5);

    // Simulate executor building the PaperPosition payload
    const positionPayload = {
      market_id: 'mkt1', token_id: 'tok1', side: 'long' as const, size: 10,
      avg_entry_price: 0.3, current_price: 0.3,
      opened_at: new Date(),
      applied_direction_multiplier: enriched.appliedDirectionMultiplier,
      was_exploration: enriched.wasExploration,
    };
    await stubRepo.openPositionAtomically(positionPayload, 3.0, 0.01);
    expect(stubRepo.openPositionAtomically).toHaveBeenCalledWith(
      expect.objectContaining({
        applied_direction_multiplier: expect.closeTo(0.6, 5),
        was_exploration: true,
      }),
      3.0, 0.01,
    );
  });

  it('breaker-tripped resolution persists with was_exploration=false and multiplier=global', async () => {
    stubRepo.getExplorationStats = vi.fn().mockResolvedValue({ count: 25, pnl: -200 });
    const resolver = new DirectionResolver({
      policyProvider: async () => policy,
      explorationConfig: {
        enabled: true, epsilon: 1.0, min: 0.0, max: 1.0,
        breakerMinTrades: 20, breakerWindowDays: 7, breakerMaxCumLoss: -150, breakerCacheTtlMs: 300_000,
      },
      rng: () => 0.0,  // would trigger exploration otherwise
      paperPositionsRepo: stubRepo as any,
      logger,
    });
    const resolution = await resolver.resolve(ctx);
    expect(resolution.reason).toBe('breaker_tripped');
    expect(resolution.wasExploration).toBe(false);
    expect(resolution.multiplier).toBe(-1.0);
  });
});
```

- [ ] **Step 2: Run test**

Run: `cd packages/dashboard && pnpm test DirectionExploration.integration 2>&1 | tail -20`
Expected: PASS (both tests).

- [ ] **Step 3: Run the whole dashboard test suite to confirm no regressions**

Run: `cd packages/dashboard && pnpm test 2>&1 | tail -15`
Expected: all tests pass except the known pre-existing `OptimizationScheduler.test.ts` Vite resolution failure (documented in recent daily reviews).

- [ ] **Step 4: Commit**

```bash
rtk git add packages/dashboard/src/services/__tests__/DirectionExploration.integration.test.ts
rtk git commit -m "test: integration coverage for direction exploration resolution to persistence"
```

---

## Final Verification

- [ ] **Step 1: Run the full monorepo test suite**

Run: `pnpm -r test 2>&1 | tail -25`
Expected: all packages pass (except the known pre-existing failure noted above).

- [ ] **Step 2: Run type check**

Run: `pnpm -r build 2>&1 | tail -15`
Expected: no TypeScript errors.

- [ ] **Step 3: Inspect the git log**

Run: `rtk git log --oneline -15`
Expected: 13 commits corresponding to the tasks above, in order.

- [ ] **Step 4: Push branch and open PR**

```bash
rtk git push -u origin HEAD
rtk gh pr create --title "feat: direction multiplier exploration (widen learner + epsilon-greedy)" --body "See docs/plans/2026-04-20-direction-multiplier-exploration-design.md for motivation and design. Implements docs/plans/2026-04-20-direction-multiplier-exploration-plan.md."
```
