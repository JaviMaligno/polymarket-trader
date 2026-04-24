# Realized Volatility (Sub-project B.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `realizedVolatility` as a nullable scorer dimension fed by a 15-min compute job, so `ScorerWeightOptimizer` learns how recent market volatility affects PnL.

**Architecture:** SQL aggregation job (15-min cron on VM) computes stddev of first-differences of close prices over 24h of `price_history` per Yes-token, stores raw in `markets.realized_volatility_24h` + `realized_volatility_bar_count`. MarketScorer Pass 1/2 and AutoSignalExecutor map raw → [0,1] via `REALIZED_VOL_REF` env. Optimizer gets `realizedVolatility` as a 5th optimizable dim with nullable handling. Historical backfill at dashboard startup. Reuses all Sub-project A infrastructure (per-type weights, optimizer loop, JSONB key filter, null-dim handling in `compositeScore`).

**Tech Stack:** TypeScript, vitest, PostgreSQL (TimescaleDB), node-cron.

**Spec:** `docs/plans/2026-04-24-realized-volatility-design.md`
**Roadmap:** `docs/plans/2026-04-24-scorer-overhaul-roadmap.md`

---

## File Structure

**Modified:**
- `packages/data-collector/src/services/MarketScorer.ts` — add `realizedVolatility` to types + WEIGHTS, add `mapRealizedVolatility` helper, extend `compositeScore` for nullable contribution, extend Pass 1 and Pass 2 queries + dim construction.
- `packages/data-collector/src/services/MarketScorer.test.ts` — unit tests.
- `packages/data-collector/src/services/ScorerWeightOptimizer.ts` — extend `randomWeights`, `loadClosedTrades` filter, `saveWeights` INSERT + ON CONFLICT SET, post-search normalization.
- `packages/data-collector/src/services/ScorerWeightOptimizer.test.ts` — unit tests.
- `packages/data-collector/src/services/Scheduler.ts` — register `compute-realized-volatility` cron + add method.
- `packages/dashboard/src/services/AutoSignalExecutor.ts` — extend market metadata query + include `realizedVolatility` in `score_dimensions_at_entry`.
- `packages/dashboard/src/server.ts` — 3 new idempotent ALTER TABLE blocks + historical backfill block at startup.

**Created:**
- `packages/data-collector/src/database/init/020_realized_volatility_markets.sql`
- `packages/data-collector/src/database/init/021_realized_volatility_scorer_weights.sql`
- `packages/data-collector/src/database/init/022_realized_volatility_score_history.sql`

---

## Task 1: Extend types + WEIGHTS redistribution

**Files:**
- Modify: `packages/data-collector/src/services/MarketScorer.ts` — WEIGHTS constant + ScoreDimensions + ScorerWeights interfaces.
- Test: `packages/data-collector/src/services/MarketScorer.test.ts`.

- [ ] **Step 1: Write failing tests**

Add to `MarketScorer.test.ts`:

```typescript
describe('ScoreDimensions shape — realizedVolatility', () => {
  it('includes realizedVolatility as nullable', () => {
    const dims: ScoreDimensions = {
      tradeability: 1, liquidity: 0.5, volatility: null,
      ttr: 0.5, dataQuality: null, typeExpectedValue: 0.75,
      realizedVolatility: 0.6,
    };
    expect(dims.realizedVolatility).toBe(0.6);

    const dimsNull: ScoreDimensions = {
      tradeability: 1, liquidity: 0.5, volatility: null,
      ttr: 0.5, dataQuality: null, typeExpectedValue: 0.75,
      realizedVolatility: null,
    };
    expect(dimsNull.realizedVolatility).toBeNull();
  });
});

describe('WEIGHTS — realizedVolatility', () => {
  it('has realizedVolatility non-zero', () => {
    expect(WEIGHTS.realizedVolatility).toBeGreaterThan(0);
  });
  it('all weights still sum to 1.0', () => {
    const sum = WEIGHTS.tradeability + WEIGHTS.liquidity + WEIGHTS.volatility +
                WEIGHTS.ttr + WEIGHTS.dataQuality + WEIGHTS.typeExpectedValue +
                WEIGHTS.realizedVolatility;
    expect(sum).toBeCloseTo(1.0, 5);
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `cd /c/Users/Usuario/GitHub/polymarket-trader && npx vitest run packages/data-collector/src/services/MarketScorer.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: the new tests FAIL with "realizedVolatility is not a property" or similar.

- [ ] **Step 3: Extend types + redistribute WEIGHTS**

Replace the `WEIGHTS` constant and the two interfaces in `MarketScorer.ts`:

```typescript
export const WEIGHTS = {
  tradeability:       0.21,
  liquidity:          0.17,
  volatility:         0.15,
  ttr:                0.08,
  dataQuality:        0.10,
  typeExpectedValue:  0.17,
  realizedVolatility: 0.12,
} as const;

export interface ScoreDimensions {
  tradeability: number;
  liquidity: number;
  volatility: number | null;
  ttr: number;
  dataQuality: number | null;
  typeExpectedValue: number;
  realizedVolatility: number | null;
}

export interface ScorerWeights {
  tradeability: number;
  liquidity: number;
  volatility: number;
  ttr: number;
  dataQuality: number;
  typeExpectedValue: number;
  realizedVolatility: number;
}
```

- [ ] **Step 4: Fix pre-existing test breakage + verify all pass**

Run: `npx vitest run packages/data-collector/src/services/MarketScorer.test.ts --reporter=verbose 2>&1 | tail -30`

Expected failures: tests that literal-construct `ScoreDimensions` or `ScorerWeights` without `realizedVolatility`. For each: add `realizedVolatility: null` (to preserve the test's intent of isolating other dims) OR `realizedVolatility: <appropriate value>` for tests that exercise scoring formulas with weight 0.12.

Specifically, the expected numeric composite values in tests where all-dims-at-1 will change because the denominator (non-null weight sum) now includes 0.12 more. Recompute using the formula:
`composite = weighted_sum / non_null_weight_sum`.

Run: `npx tsc -p packages/data-collector --noEmit 2>&1 | tail -20`
Expected: no TS errors in MarketScorer.ts itself.

- [ ] **Step 5: Commit**

```bash
git add packages/data-collector/src/services/MarketScorer.ts packages/data-collector/src/services/MarketScorer.test.ts
git commit -m "feat(scorer): add realizedVolatility nullable dim to types + WEIGHTS

New nullable dimension. Default weight 0.12 (redistributed from other
optimizable dims). Nullable contract follows volatility/dataQuality,
not typeExpectedValue — 'no data' is not imputed as neutral because
there is no well-defined neutral value for realized volatility."
```

---

## Task 2: Implement `mapRealizedVolatility` helper + extend compositeScore

**Files:**
- Modify: `packages/data-collector/src/services/MarketScorer.ts`.
- Test: `packages/data-collector/src/services/MarketScorer.test.ts`.

- [ ] **Step 1: Write failing tests for helper**

Add to `MarketScorer.test.ts`:

```typescript
describe('MarketScorer.mapRealizedVolatility', () => {
  it('returns null when raw is null', () => {
    expect(MarketScorer.mapRealizedVolatility(null, 100)).toBeNull();
  });
  it('returns null when barCount is null', () => {
    expect(MarketScorer.mapRealizedVolatility(0.02, null)).toBeNull();
  });
  it('returns null when barCount < 5', () => {
    expect(MarketScorer.mapRealizedVolatility(0.02, 4)).toBeNull();
  });
  it('maps raw vol 0.02 with default VOL_REF=0.02 to 1.0', () => {
    expect(MarketScorer.mapRealizedVolatility(0.02, 10)).toBe(1.0);
  });
  it('maps raw vol 0.01 with default VOL_REF=0.02 to 0.5', () => {
    expect(MarketScorer.mapRealizedVolatility(0.01, 10)).toBeCloseTo(0.5, 5);
  });
  it('clamps above 1.0 (very volatile market)', () => {
    expect(MarketScorer.mapRealizedVolatility(0.08, 10)).toBe(1.0);
  });
  it('clamps at 0.0 (never negative)', () => {
    // stddev is non-negative by definition, but defense-in-depth
    expect(MarketScorer.mapRealizedVolatility(-0.01, 10)).toBe(0);
  });
  it('barCount boundary — 5 computes, 4 is null', () => {
    expect(MarketScorer.mapRealizedVolatility(0.01, 4)).toBeNull();
    expect(MarketScorer.mapRealizedVolatility(0.01, 5)).toBeCloseTo(0.5, 5);
  });
});
```

Add compositeScore tests for the new nullable dim:

```typescript
describe('MarketScorer.compositeScore with realizedVolatility', () => {
  it('includes realizedVolatility contribution when non-null', () => {
    const dims: ScoreDimensions = {
      tradeability: 1, liquidity: 1, volatility: null,
      ttr: 1, dataQuality: null, typeExpectedValue: 1, realizedVolatility: 1,
    };
    const weights: ScorerWeights = {
      tradeability: 0.21, liquidity: 0.17, volatility: 0.15,
      ttr: 0.08, dataQuality: 0.10, typeExpectedValue: 0.17, realizedVolatility: 0.12,
    };
    // Non-null dims all at 1: trd+liq+ttr+typeEV+realizedVol = 0.21+0.17+0.08+0.17+0.12 = 0.75
    // Weighted sum = 0.75, totalWeight = 0.75 → 1.0
    expect(MarketScorer.compositeScore(dims, weights)).toBeCloseTo(1.0, 3);
  });

  it('skips realizedVolatility when null (renormalizes)', () => {
    const dims: ScoreDimensions = {
      tradeability: 1, liquidity: 1, volatility: null,
      ttr: 1, dataQuality: null, typeExpectedValue: 1, realizedVolatility: null,
    };
    const weights: ScorerWeights = {
      tradeability: 0.21, liquidity: 0.17, volatility: 0.15,
      ttr: 0.08, dataQuality: 0.10, typeExpectedValue: 0.17, realizedVolatility: 0.12,
    };
    // Non-null weighted sum = 0.21+0.17+0.08+0.17 = 0.63
    // Normalized by same 0.63 = 1.0
    expect(MarketScorer.compositeScore(dims, weights)).toBeCloseTo(1.0, 3);
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `npx vitest run packages/data-collector/src/services/MarketScorer.test.ts --reporter=verbose 2>&1 | tail -25`
Expected: new tests FAIL (`mapRealizedVolatility is not a function`, composite missing contribution, etc.).

- [ ] **Step 3: Implement helper + extend compositeScore**

In `MarketScorer.ts`, near other static helpers (next to `typeExpectedValue`), add:

```typescript
  /**
   * Map raw realized volatility (stddev of Δp over 24h window) to [0, 1].
   * Returns null when insufficient data (barCount < 5) — consistent with the
   * nullable contract of volatility/dataQuality. Env: REALIZED_VOL_REF
   * overrides the default VOL_REF=0.02 (a raw vol of 2 percentage points
   * maps to 1.0 on the normalized scale).
   */
  static mapRealizedVolatility(
    raw: number | null,
    barCount: number | null,
    VOL_REF: number = Number(process.env.REALIZED_VOL_REF ?? 0.02),
  ): number | null {
    if (raw === null || barCount === null || barCount < 5) return null;
    if (!Number.isFinite(VOL_REF) || VOL_REF <= 0) {
      VOL_REF = 0.02; // defensive fallback for misconfigured env
    }
    return clamp01(raw / VOL_REF);
  }
```

Also update `compositeScore` — add the realizedVolatility contribution block after typeExpectedValue (following the existing nullable pattern of volatility/dataQuality):

Find the existing `compositeScore` method. Add after the typeExpectedValue contribution:

```typescript
    if (dims.realizedVolatility !== null) {
      sum += weights.realizedVolatility * dims.realizedVolatility;
      totalWeight += weights.realizedVolatility;
    }
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run packages/data-collector/src/services/MarketScorer.test.ts --reporter=verbose 2>&1 | tail -25`
Expected: all new tests pass. Pre-existing tests may need score values recomputed (the normalization denominator changed when realizedVolatility is present).

- [ ] **Step 5: Commit**

```bash
git add packages/data-collector/src/services/MarketScorer.ts packages/data-collector/src/services/MarketScorer.test.ts
git commit -m "feat(scorer): mapRealizedVolatility helper + composite nullable handling

Pure helper maps raw stddev to [0,1] via VOL_REF (default 0.02, env
REALIZED_VOL_REF). Returns null for barCount < 5. compositeScore
treats realizedVolatility as nullable with same renormalization
pattern as volatility and dataQuality."
```

---

## Task 3: Schema migrations (3 tables) + init SQLs + runtime ALTERs

**Files:**
- Create: `packages/data-collector/src/database/init/020_realized_volatility_markets.sql`
- Create: `packages/data-collector/src/database/init/021_realized_volatility_scorer_weights.sql`
- Create: `packages/data-collector/src/database/init/022_realized_volatility_score_history.sql`
- Modify: `packages/dashboard/src/server.ts` — add 3 runtime ALTER blocks near the existing Sub-project A migrations (around line 198).

- [ ] **Step 1: Create init SQLs**

Create `packages/data-collector/src/database/init/020_realized_volatility_markets.sql`:

```sql
-- Realized volatility storage on markets (Sub-project B.1).
-- raw stddev of first-differences of close prices over 24h + bar count quality signal.
ALTER TABLE markets
  ADD COLUMN IF NOT EXISTS realized_volatility_24h FLOAT,
  ADD COLUMN IF NOT EXISTS realized_volatility_bar_count SMALLINT;
```

Create `packages/data-collector/src/database/init/021_realized_volatility_scorer_weights.sql`:

```sql
-- scorer_weights gains realized_volatility column so ScorerWeightOptimizer
-- can persist the per-type weight for the new dim.
ALTER TABLE scorer_weights
  ADD COLUMN IF NOT EXISTS realized_volatility FLOAT NOT NULL DEFAULT 0;
```

Create `packages/data-collector/src/database/init/022_realized_volatility_score_history.sql`:

```sql
-- market_score_history gains score_realized_volatility column for snapshot persistence.
ALTER TABLE market_score_history
  ADD COLUMN IF NOT EXISTS score_realized_volatility FLOAT;
```

- [ ] **Step 2: Add runtime ALTER blocks to server.ts**

In `packages/dashboard/src/server.ts`, find the existing "scorer_weights per-type columns ensured" block (from Sub-project A, around line 198-220). Add AFTER that block:

```typescript
      // Sub-project B.1: realized volatility columns + scoring/history columns.
      // See docs/plans/2026-04-24-realized-volatility-design.md.
      await query(`
        ALTER TABLE markets
          ADD COLUMN IF NOT EXISTS realized_volatility_24h FLOAT,
          ADD COLUMN IF NOT EXISTS realized_volatility_bar_count SMALLINT;
      `);
      await query(`
        ALTER TABLE scorer_weights
          ADD COLUMN IF NOT EXISTS realized_volatility FLOAT NOT NULL DEFAULT 0;
      `);
      await query(`
        ALTER TABLE market_score_history
          ADD COLUMN IF NOT EXISTS score_realized_volatility FLOAT;
      `);
      console.log('realized_volatility columns ensured on markets / scorer_weights / market_score_history');
```

- [ ] **Step 3: TypeScript compile check**

Run: `npx tsc -p packages/dashboard --noEmit 2>&1 | tail -10`
Expected: no new TS errors.

- [ ] **Step 4: Run dashboard test suite for regressions**

Run: `npx vitest run packages/dashboard --reporter=verbose 2>&1 | tail -15`
Expected: no new failures.

- [ ] **Step 5: Commit**

```bash
git add packages/data-collector/src/database/init/020_realized_volatility_markets.sql \
        packages/data-collector/src/database/init/021_realized_volatility_scorer_weights.sql \
        packages/data-collector/src/database/init/022_realized_volatility_score_history.sql \
        packages/dashboard/src/server.ts
git commit -m "feat(scorer): schema migrations for realized volatility

Three idempotent ADD COLUMN IF NOT EXISTS at dashboard startup:
- markets.realized_volatility_24h + realized_volatility_bar_count
  (raw storage + quality signal, both nullable)
- scorer_weights.realized_volatility NOT NULL DEFAULT 0 (optimizer
  output, default 0 keeps legacy rows working until re-optimized)
- market_score_history.score_realized_volatility (nullable snapshot)

Matching init SQL files 020-022 for fresh DB installs."
```

---

## Task 4: Compute job in Scheduler

**Files:**
- Modify: `packages/data-collector/src/services/Scheduler.ts` — register new cron + add method.
- Test: if the Scheduler has tests, add a light handler unit test; otherwise skip and rely on integration/deploy verification.

- [ ] **Step 1: Write a light unit test for the compute handler**

Check if `packages/data-collector/src/services/Scheduler.test.ts` exists. If not, create minimal coverage as a new file. If it exists, extend it.

Add this test (create file if needed):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../database/connection.js', () => ({
  query: vi.fn(),
}));

import { query } from '../database/connection.js';
import { computeRealizedVolatility } from './Scheduler.js';

describe('computeRealizedVolatility', () => {
  beforeEach(() => vi.clearAllMocks());

  it('executes the UPDATE and the NULL-out UPDATE without throwing', async () => {
    (query as unknown as import('vitest').Mock).mockResolvedValue({ rowCount: 10, rows: [] });
    await expect(computeRealizedVolatility()).resolves.not.toThrow();
    // Two UPDATE statements issued: set vols + null out stale
    const updateCalls = (query as unknown as import('vitest').Mock).mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].trim().startsWith('UPDATE markets'),
    );
    expect(updateCalls.length).toBe(2);
  });

  it('swallows DB errors and does not abort the scheduler', async () => {
    (query as unknown as import('vitest').Mock).mockRejectedValue(new Error('db down'));
    await expect(computeRealizedVolatility()).resolves.not.toThrow();
  });
});
```

If `Scheduler.test.ts` exists but has a different structure, follow its convention. This test requires `computeRealizedVolatility` to be exported — we will export it as a standalone function rather than a class method so it is easy to unit-test.

- [ ] **Step 2: Run tests, verify failure**

Run: `npx vitest run packages/data-collector/src/services/Scheduler --reporter=verbose 2>&1 | tail -15`
Expected: FAIL with "computeRealizedVolatility is not exported" or similar.

- [ ] **Step 3: Implement the compute function + register the cron**

Open `packages/data-collector/src/services/Scheduler.ts`.

Add at module level (near the other helper functions or top-level exports):

```typescript
import { query } from '../database/connection.js';

/**
 * Compute realized volatility (stddev of first differences of close prices
 * over the last 24h) for every token that has enough bars, and null out
 * vols for tokens whose recent data has aged out. Sub-project B.1.
 */
export async function computeRealizedVolatility(): Promise<void> {
  try {
    const start = Date.now();
    const result = await query(`
      UPDATE markets m
      SET realized_volatility_24h = s.vol,
          realized_volatility_bar_count = s.n_bars
      FROM (
        SELECT token_id,
               STDDEV_POP(d) AS vol,
               COUNT(d) AS n_bars
        FROM (
          SELECT token_id,
                 close - LAG(close) OVER (PARTITION BY token_id ORDER BY time) AS d
          FROM price_history
          WHERE time > NOW() - INTERVAL '24 hours'
        ) diffs
        GROUP BY token_id
        HAVING COUNT(d) >= 5
      ) s
      WHERE s.token_id = m.clob_token_id_yes
    `);

    // Null out markets that no longer have qualifying recent data.
    const nullResult = await query(`
      UPDATE markets
      SET realized_volatility_24h = NULL, realized_volatility_bar_count = NULL
      WHERE realized_volatility_24h IS NOT NULL
        AND clob_token_id_yes NOT IN (
          SELECT token_id FROM price_history
          WHERE time > NOW() - INTERVAL '24 hours'
          GROUP BY token_id
          HAVING COUNT(*) >= 6
        )
    `);

    logger.info({
      duration_ms: Date.now() - start,
      updated: result.rowCount ?? 0,
      nulled: nullResult.rowCount ?? 0,
    }, 'Realized volatility computed');
  } catch (err) {
    logger.error({ err }, 'Realized volatility compute failed — skipping this cycle');
  }
}
```

Then, inside the Scheduler class constructor (near the other `this.defineJob(...)` calls), add:

```typescript
    this.defineJob('compute-realized-volatility', '*/15 * * * *', computeRealizedVolatility);  // Every 15 min
```

If the scheduler's `runJob` switch-case requires a handler entry, add the corresponding case. Look at how `optimize-scorer-weights` or another job is wired and mirror the pattern.

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run packages/data-collector/src/services/Scheduler --reporter=verbose 2>&1 | tail -15`
Expected: new tests pass, no regressions elsewhere.

Run: `npx tsc -p packages/data-collector --noEmit 2>&1 | tail -10`
Expected: no new TS errors.

- [ ] **Step 5: Commit**

```bash
git add packages/data-collector/src/services/Scheduler.ts packages/data-collector/src/services/Scheduler.test.ts
git commit -m "feat(scorer): 15-min compute-realized-volatility cron

New scheduler job computes STDDEV_POP(Δp) over 24h of price_history
per token, stores raw + bar_count on markets. Second UPDATE nulls out
tokens whose recent data aged out. Wrapped in try/catch so a transient
DB error does not propagate to the scheduler."
```

---

## Task 5: Pass 1 reads realized_volatility_24h + computes mapped dim

**Files:**
- Modify: `packages/data-collector/src/services/MarketScorer.ts` — Pass 1 candidate query + per-type loop.
- Test: `packages/data-collector/src/services/MarketScorer.test.ts`.

- [ ] **Step 1: Write failing test**

Add to `MarketScorer.test.ts`:

```typescript
describe('MarketScorer.scoreAllMarkets Pass 1 — realizedVolatility propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MarketScorer.clearWeightsCache();
  });

  it('reads realized_volatility_24h from candidates + passes mapped value to compositeScore', async () => {
    const captured: Array<{ sql: string; params: unknown[] | undefined }> = [];
    (query as unknown as Mock).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.trim().startsWith('UPDATE markets')) {
        captured.push({ sql, params });
      }
      if (typeof sql === 'string' && sql.includes('FROM category_performance')) {
        return { rows: [] };
      }
      if (typeof sql === 'string' && sql.includes('FROM scorer_weights')) {
        return {
          rows: [{
            market_type: '__global__', tradeability: 0.21, liquidity: 0.17,
            volatility: 0.15, ttr: 0.08, data_quality: 0.10,
            type_expected_value: 0.17, realized_volatility: 0.12, n_trades: 1800,
          }],
        };
      }
      if (typeof sql === 'string' && sql.includes('SELECT condition_id')) {
        // One cold candidate with known inputs for deterministic score
        return {
          rows: [{
            condition_id: 'mkt-A', current_price_yes: '0.5', volume_24h: '30000000',
            spread: '0.01', end_date: new Date(Date.now() + 30 * 86400000).toISOString(),
            market_type: 'event_long',
            realized_volatility_24h: 0.02, realized_volatility_bar_count: 20,
          }],
        };
      }
      if (typeof sql === 'string' && sql.includes("tracking_status IN")) return { rows: [] };
      return { rows: [], rowCount: 0 };
    });
    const scorer = new MarketScorer();
    await scorer.scoreAllMarkets();

    // First captured UPDATE should have marketType='event_long' and a score that reflects
    // realizedVolatility=1.0 (raw 0.02 / VOL_REF 0.02 = 1.0).
    expect(captured.length).toBeGreaterThan(0);
    const updateCall = captured.find(c => (c.params?.[0] as string) === 'event_long');
    expect(updateCall).toBeDefined();
    // The score param is index 2 (after marketType, conditionId).
    const score = updateCall!.params![2] as number;
    // All non-null dims at 1 (tradeability=1, liquidity=1 with 30M vol = MAX_VOLUME_REF, ttr=1,
    // typeEV=0.5 since categoryMetrics has no event_long row, realizedVol=1).
    // Non-null weighted sum = 0.21 + 0.17 + 0.08 + 0.17*0.5 + 0.12 = 0.645
    // Normalized by (0.21+0.17+0.08+0.17+0.12) = 0.75
    // Score = 0.645 / 0.75 ≈ 0.86
    expect(score).toBeCloseTo(0.86, 2);
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `npx vitest run packages/data-collector/src/services/MarketScorer.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — score does not match because Pass 1 does not yet read realized_volatility_24h.

- [ ] **Step 3: Extend Pass 1**

In `MarketScorer.ts`:

First, extend `Pass1CandidateRow` interface to include the new columns:

```typescript
interface Pass1CandidateRow {
  condition_id: string;
  current_price_yes: number | null;
  volume_24h: number | null;
  spread: number | null;
  end_date: string | null;
  market_type: string | null;
  realized_volatility_24h: number | string | null;   // NEW
  realized_volatility_bar_count: number | null;       // NEW
}
```

Update the Pass 1 candidate SELECT query to include the two new columns:

```typescript
    const pass1Candidates = await query<Pass1CandidateRow>(`
      SELECT condition_id,
             current_price_yes,
             volume_24h,
             spread,
             end_date,
             market_type,
             realized_volatility_24h,
             realized_volatility_bar_count
      FROM markets
      WHERE is_active = true AND is_resolved = false
        AND clob_token_id_yes IS NOT NULL
        AND tracking_status NOT IN ('warming', 'active', 'cooling')
    `);
```

Inside the per-type loop where `updates` is built, add the `realizedVolatility` computation:

```typescript
      const updates = rows.map((row) => {
        const tradeability = MarketScorer.tradeabilityScore(
          row.current_price_yes != null ? Number(row.current_price_yes) : null,
        );
        const liquidity = MarketScorer.liquidityScore(
          row.volume_24h != null ? Number(row.volume_24h) : null,
          row.spread != null ? Number(row.spread) : null,
        );
        const ttr = MarketScorer.ttrScore(
          row.end_date ? new Date(row.end_date) : null,
        );
        const realizedVolatility = MarketScorer.mapRealizedVolatility(
          row.realized_volatility_24h != null ? Number(row.realized_volatility_24h) : null,
          row.realized_volatility_bar_count,
        );
        const score = MarketScorer.compositeScore({
          tradeability,
          liquidity,
          volatility: null,
          ttr,
          dataQuality: null,
          typeExpectedValue: typeEV,
          realizedVolatility,
        }, weights);

        return {
          conditionId: row.condition_id,
          trackingStatus: 'cold',
          score,
          tradeability,
          liquidity,
          ttr,
          volatility: null,
          dataQuality: null,
          typeExpectedValue: typeEV,
          realizedVolatility,
          currentPriceYes: row.current_price_yes != null ? Number(row.current_price_yes) : null,
          volume24h: row.volume_24h != null ? Number(row.volume_24h) : null,
          marketType: row.market_type ?? null,
        } satisfies EnrichUpdate;
      });
```

Do the same for the NULL market_type fallback block — add the realizedVolatility computation and include it in the satisfies EnrichUpdate object.

Also extend the `EnrichUpdate` interface to include `realizedVolatility: number | null`:

```typescript
export interface EnrichUpdate {
  conditionId: string;
  trackingStatus: string;
  score: number;
  tradeability: number;
  liquidity: number;
  ttr: number;
  volatility: number | null;
  dataQuality: number | null;
  typeExpectedValue: number;
  realizedVolatility: number | null;  // NEW
  currentPriceYes: number | null;
  volume24h: number | null;
  marketType: string | null;
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run packages/data-collector/src/services/MarketScorer.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: all pass.

Run: `npx tsc -p packages/data-collector --noEmit 2>&1 | tail -10`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/data-collector/src/services/MarketScorer.ts packages/data-collector/src/services/MarketScorer.test.ts
git commit -m "feat(scorer): Pass 1 consumes markets.realized_volatility_24h

Candidate SELECT now fetches realized_volatility_24h + bar_count.
Per-type loop maps raw → [0,1] via mapRealizedVolatility and feeds
into compositeScore as a nullable dim. Fallback NULL-market_type
branch updated the same way. EnrichUpdate interface extended."
```

---

## Task 6: Pass 2 reads realized_volatility_24h + propagates dim + persists in score_history

**Files:**
- Modify: `packages/data-collector/src/services/MarketScorer.ts` — Pass 2 tracked query + batch update + writeScoreHistory.
- Test: `packages/data-collector/src/services/MarketScorer.test.ts`.

- [ ] **Step 1: Write failing test**

Add to `MarketScorer.test.ts`:

```typescript
describe('MarketScorer.scoreAllMarkets Pass 2 — realizedVolatility propagation', () => {
  beforeEach(() => { vi.clearAllMocks(); MarketScorer.clearWeightsCache(); });

  it('tracked markets score using realized_volatility from the same query', async () => {
    (query as unknown as Mock).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('FROM category_performance')) {
        return { rows: [{ market_type: 'event_financial', sharpe_ratio: 0.27, n_trades: 159 }] };
      }
      if (typeof sql === 'string' && sql.includes('FROM scorer_weights')) {
        return {
          rows: [{
            market_type: '__global__', tradeability: 0.21, liquidity: 0.17,
            volatility: 0.15, ttr: 0.08, data_quality: 0.10,
            type_expected_value: 0.17, realized_volatility: 0.12, n_trades: 1800,
          }],
        };
      }
      if (typeof sql === 'string' && sql.includes('SELECT condition_id')) return { rows: [] };
      if (typeof sql === 'string' && sql.includes("tracking_status IN")) {
        return {
          rows: [{
            condition_id: 'active-mkt', tracking_status: 'active',
            current_price_yes: '0.5', volume_24h: '30000000', spread: '0.01',
            end_date: new Date(Date.now() + 30 * 86400000).toISOString(),
            market_type: 'event_financial',
            stddev: '0.05', informative_bars: '20', total_bars: '24',
            realized_volatility_24h: 0.02, realized_volatility_bar_count: 20,
          }],
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const scorer = new MarketScorer();
    await scorer.scoreAllMarkets();

    // Verify writeScoreHistory / batchUpdateScores receives realizedVolatility=1.0
    // (raw 0.02 / VOL_REF 0.02). Assertion shape depends on how the test catches it —
    // easiest is to look at the batch UPDATE params and confirm a score was computed.
    const updateCalls = (query as unknown as Mock).mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).trim().startsWith('UPDATE markets')
    );
    expect(updateCalls.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `npx vitest run packages/data-collector/src/services/MarketScorer.test.ts --reporter=verbose 2>&1 | tail -15`
Expected: FAIL — Pass 2 query does not yet include realized_volatility_24h.

- [ ] **Step 3: Extend Pass 2 query + loop + writeScoreHistory**

In `MarketScorer.ts`, find the Pass 2 `trackedResult` query. Extend its SELECT to include the two new columns and its TS result shape:

```typescript
    const trackedResult = await query<{
      condition_id: string;
      tracking_status: string;
      current_price_yes: number | string | null;
      volume_24h: number | string | null;
      spread: number | string | null;
      end_date: string | null;
      market_type: string | null;
      stddev: number | string | null;
      informative_bars: number | string;
      total_bars: number | string;
      realized_volatility_24h: number | string | null;    // NEW
      realized_volatility_bar_count: number | null;        // NEW
    }>(`
      SELECT m.condition_id,
             m.tracking_status,
             m.current_price_yes,
             m.volume_24h,
             m.spread,
             m.end_date,
             m.market_type,
             agg.stddev,
             agg.informative_bars,
             agg.total_bars,
             m.realized_volatility_24h,
             m.realized_volatility_bar_count
      FROM markets m
      ...
    `);
```

(Keep the existing FROM clauses, joins, and filters for the tracked query. Only the SELECT projection and result type change.)

Inside the Pass 2 loop that builds `enrichUpdates`, compute and include realizedVolatility:

```typescript
    for (const row of trackedRows) {
      const weights = await MarketScorer.loadWeights(row.market_type ?? null);
      const metric = categoryMetrics.get(row.market_type ?? '');
      const typeEV = MarketScorer.typeExpectedValue(
        metric?.sharpe ?? null,
        metric?.n ?? 0,
      );

      const tradeability = MarketScorer.tradeabilityScore(
        row.current_price_yes != null ? Number(row.current_price_yes) : null,
      );
      const liquidity = MarketScorer.liquidityScore(
        row.volume_24h != null ? Number(row.volume_24h) : null,
        row.spread != null ? Number(row.spread) : null,
      );
      const ttr = MarketScorer.ttrScore(
        row.end_date ? new Date(row.end_date) : null,
      );
      // existing volatility and dataQuality computations preserved
      const volatility = ... ; // keep existing logic
      const dataQuality = ... ; // keep existing logic
      const realizedVolatility = MarketScorer.mapRealizedVolatility(
        row.realized_volatility_24h != null ? Number(row.realized_volatility_24h) : null,
        row.realized_volatility_bar_count,
      );

      const dims: ScoreDimensions = {
        tradeability, liquidity, volatility, ttr, dataQuality,
        typeExpectedValue: typeEV,
        realizedVolatility,
      };
      const score = MarketScorer.compositeScore(dims, weights);

      enrichUpdates.push({
        conditionId: row.condition_id,
        trackingStatus: row.tracking_status,
        score,
        tradeability, liquidity, ttr, volatility, dataQuality,
        typeExpectedValue: typeEV,
        realizedVolatility,
        currentPriceYes: row.current_price_yes !== null ? Number(row.current_price_yes) : null,
        volume24h: row.volume_24h !== null ? Number(row.volume_24h) : null,
        marketType: row.market_type ?? null,
      });
    }
```

Keep the existing inputs for volatility/dataQuality computations verbatim.

Update `writeScoreHistory` INSERT: find the current INSERT column list (which added `score_type_expected_value` at position ~10 during Sub-project A). Add `score_realized_volatility` after it:

```typescript
  private async writeScoreHistory(enrichUpdates: EnrichUpdate[]): Promise<void> {
    if (enrichUpdates.length === 0) return;
    try {
      for (let i = 0; i < enrichUpdates.length; i += BATCH_SIZE) {
        const batch = enrichUpdates.slice(i, i + BATCH_SIZE);
        const values = batch
          .map((u, idx) => {
            const base = idx * 13;  // 13 columns per row (was 12, +1 for realizedVolatility)
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}, NOW())`;
          })
          .join(', ');
        const params = batch.flatMap((u) => [
          u.conditionId,
          u.trackingStatus,
          u.score,
          u.tradeability,
          u.liquidity,
          u.ttr,
          u.volatility,
          u.dataQuality,
          u.typeExpectedValue,
          u.realizedVolatility,      // NEW
          u.currentPriceYes,
          u.volume24h,
          u.marketType,
        ]);
        await query(
          `INSERT INTO market_score_history
             (condition_id, tracking_status, score, score_tradeability, score_liquidity,
              score_ttr, score_volatility, score_data_quality, score_type_expected_value,
              score_realized_volatility,
              current_price_yes, volume_24h, market_type, time)
           VALUES ${values}`,
          params,
        );
      }
    } catch (err) {
      logger.warn({ err }, 'writeScoreHistory failed — non-critical');
    }
  }
```

(Adjust the base stride to reflect the actual column count of the existing code. The exact stride depends on what A's version ended up with — recount non-time columns.)

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run packages/data-collector/src/services/MarketScorer.test.ts --reporter=verbose 2>&1 | tail -25`
Expected: all pass.

Run: `npx tsc -p packages/data-collector --noEmit 2>&1 | tail -10`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/data-collector/src/services/MarketScorer.ts packages/data-collector/src/services/MarketScorer.test.ts
git commit -m "feat(scorer): Pass 2 + writeScoreHistory carry realizedVolatility

Pass 2 tracked query SELECTs realized_volatility_24h + bar_count.
Per-row dim built via mapRealizedVolatility. EnrichUpdate propagates
the field. writeScoreHistory INSERT extended to persist
score_realized_volatility."
```

---

## Task 7: AutoSignalExecutor captures realizedVolatility at position open

**Files:**
- Modify: `packages/dashboard/src/services/AutoSignalExecutor.ts` — around lines 815-845 (the market metadata lookup + score_dimensions_at_entry build).

- [ ] **Step 1: Inspect existing pattern**

Read the current block. The file already has local helpers `computeTradeability`, `computeLiquidity`, `computeTtr`, `typeExpectedValueLocal`. Add a matching local helper for the mapping (same rationale: avoid cross-package import that pulls data-collector into dashboard).

- [ ] **Step 2: Add local helper + extend metadata query + include in dims**

Near the existing local helpers (e.g. after `typeExpectedValueLocal`), add:

```typescript
/** Mirrors MarketScorer.mapRealizedVolatility. Returns null when barCount < 5. */
function mapRealizedVolatilityLocal(raw: number | null, barCount: number | null): number | null {
  const VOL_REF = Number(process.env.REALIZED_VOL_REF ?? 0.02);
  const ref = Number.isFinite(VOL_REF) && VOL_REF > 0 ? VOL_REF : 0.02;
  if (raw === null || barCount === null || barCount < 5) return null;
  return Math.min(1, Math.max(0, raw / ref));
}
```

Extend the market metadata query and the dim construction:

```typescript
      const mktResult = await query<{
        market_score: string | null;
        current_price_yes: string | null;
        volume_24h: string | null;
        spread: string | null;
        end_date: string | null;
        market_type: string | null;
        realized_volatility_24h: number | string | null;   // NEW
        realized_volatility_bar_count: number | null;      // NEW
      }>(
        `SELECT market_score, current_price_yes, volume_24h, spread, end_date, market_type,
                realized_volatility_24h, realized_volatility_bar_count
         FROM   markets
         WHERE  id = $1`,
        [signal.marketId],
      );
      if (mktResult.rows.length > 0) {
        const m = mktResult.rows[0];
        marketScoreAtEntry = m.market_score != null ? Number(m.market_score) : null;

        const price = m.current_price_yes != null ? Number(m.current_price_yes) : null;
        const vol   = m.volume_24h != null ? Number(m.volume_24h) : null;
        const sprd  = m.spread != null ? Number(m.spread) : null;
        const endDate = m.end_date ? new Date(m.end_date) : null;

        // existing typeEV capture block (keep as-is)
        let typeEV = 0.5;
        if (m.market_type) { /* ... existing try/catch category_performance lookup ... */ }

        const realizedVolatility = mapRealizedVolatilityLocal(
          m.realized_volatility_24h !== null ? Number(m.realized_volatility_24h) : null,
          m.realized_volatility_bar_count,
        );

        scoreDimensionsAtEntry = {
          tradeability:      computeTradeability(price),
          liquidity:         computeLiquidity(vol, sprd),
          ttr:               computeTtr(endDate),
          volatility:        null,
          dataQuality:       null,
          typeExpectedValue: typeEV,
          realizedVolatility,   // NEW
        };
      }
```

- [ ] **Step 3: Compile + test check**

Run: `npx tsc -p packages/dashboard --noEmit 2>&1 | tail -10`
Expected: no new TS errors.

Run: `npx vitest run packages/dashboard/src/services/AutoSignalExecutor --reporter=verbose 2>&1 | tail -15`
Expected: no regressions.

- [ ] **Step 4: Commit**

```bash
git add packages/dashboard/src/services/AutoSignalExecutor.ts
git commit -m "feat(executor): capture realizedVolatility at position open

Extends market metadata query to fetch realized_volatility_24h +
bar_count, maps to [0,1] via mapRealizedVolatilityLocal (same formula
as MarketScorer.mapRealizedVolatility, duplicated per the cross-package
isolation pattern already used for typeExpectedValueLocal)."
```

---

## Task 8: ScorerWeightOptimizer — randomWeights + loadClosedTrades filter + saveWeights + normalization

**Files:**
- Modify: `packages/data-collector/src/services/ScorerWeightOptimizer.ts`.
- Test: `packages/data-collector/src/services/ScorerWeightOptimizer.test.ts`.

- [ ] **Step 1: Write failing tests**

Add to `ScorerWeightOptimizer.test.ts`:

```typescript
describe('optimizeScorerWeights — realizedVolatility', () => {
  beforeEach(() => vi.clearAllMocks());

  it('randomWeights samples realizedVolatility in [0.05, 0.65]', () => {
    // randomWeights is internal; test via a proxy: many calls
    // The easiest approach is to export randomWeights (if not already).
    // If randomWeights is not exported, skip this test and rely on the downstream effect.
  });

  it('saveWeights INSERT includes realized_volatility column and param', async () => {
    const captured: Array<{ sql: string; params: unknown[] }> = [];
    (query as unknown as Mock).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.startsWith('INSERT INTO scorer_weights')) {
        captured.push({ sql, params: params ?? [] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT DISTINCT market_type FROM markets')) {
        return { rows: [{ market_type: 'event_long' }] };
      }
      if (typeof sql === 'string' && sql.includes('FROM paper_positions pp')) {
        return {
          rows: Array.from({ length: 50 }, () => ({
            score_dimensions_at_entry: {
              tradeability: 0.5, liquidity: 0.5, ttr: 0.5,
              typeExpectedValue: 0.7, realizedVolatility: 0.4,
            },
            realized_pnl: '10',
          })),
        };
      }
      return { rowCount: 1, rows: [] };
    });

    await optimizeScorerWeights();

    // Per-type + global INSERT(s) should include the new column.
    expect(captured.length).toBeGreaterThan(0);
    for (const c of captured) {
      expect(c.sql).toContain('realized_volatility');
      expect(c.sql).toContain('EXCLUDED.realized_volatility');
    }
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `npx vitest run packages/data-collector/src/services/ScorerWeightOptimizer.test.ts --reporter=verbose 2>&1 | tail -15`
Expected: FAIL — INSERT does not include the column yet.

- [ ] **Step 3: Extend optimizer code**

In `ScorerWeightOptimizer.ts`:

**Update `randomWeights`** to sample the new dim:

```typescript
function randomWeights(): ScorerWeights {
  const r = () => Math.random() * 0.6 + 0.05;
  return {
    tradeability:       r(),
    liquidity:          r(),
    volatility:         WEIGHTS.volatility,
    ttr:                r(),
    dataQuality:        WEIGHTS.dataQuality,
    typeExpectedValue:  r(),
    realizedVolatility: r(),   // NEW — 5th optimizable dim
  };
}
```

**Update `runRandomSearch` normalization** — the optimizable sum now has 5 terms:

```typescript
  const optimizableSum = bestWeights.tradeability + bestWeights.liquidity +
                         bestWeights.ttr + bestWeights.typeExpectedValue +
                         bestWeights.realizedVolatility;
  const targetSum = 1 - WEIGHTS.volatility - WEIGHTS.dataQuality; // 0.75
  if (optimizableSum > 0) {
    const scale = targetSum / optimizableSum;
    bestWeights = {
      ...bestWeights,
      tradeability:       bestWeights.tradeability       * scale,
      liquidity:          bestWeights.liquidity          * scale,
      ttr:                bestWeights.ttr                * scale,
      typeExpectedValue:  bestWeights.typeExpectedValue  * scale,
      realizedVolatility: bestWeights.realizedVolatility * scale,   // NEW
    };
  }
```

**Update `loadClosedTrades`** — extend the JSONB key filter to require the new key, and extract with null fallback:

```typescript
async function loadClosedTrades(marketType: string | null): Promise<ClosedTrade[]> {
  const result = await query<{
    score_dimensions_at_entry: Record<string, number | null>;
    realized_pnl: string;
  }>(
    `SELECT pp.score_dimensions_at_entry, pp.realized_pnl
     FROM paper_positions pp
     LEFT JOIN markets m ON m.id = pp.market_id
     WHERE pp.closed_at IS NOT NULL
       AND pp.score_dimensions_at_entry IS NOT NULL
       AND pp.score_dimensions_at_entry ? 'typeExpectedValue'
       AND pp.score_dimensions_at_entry ? 'realizedVolatility'
       AND pp.realized_pnl IS NOT NULL
       AND ($1::text IS NULL OR m.market_type = $1)
       AND pp.closed_at >= (SELECT last_reset_at FROM paper_account ORDER BY id LIMIT 1)`,
    [marketType],
  );
  return result.rows.map((r) => {
    const d = r.score_dimensions_at_entry;
    return {
      dims: {
        tradeability:       d.tradeability       ?? 0,
        liquidity:          d.liquidity          ?? 0,
        volatility:         d.volatility         ?? null,
        ttr:                d.ttr                ?? 0,
        dataQuality:        d.dataQuality        ?? null,
        typeExpectedValue:  d.typeExpectedValue  ?? 0.5,
        realizedVolatility: d.realizedVolatility ?? null,   // NEW: null is the nullable contract
      },
      pnl: parseFloat(r.realized_pnl),
    };
  });
}
```

**Update `saveWeights`** — extend INSERT column list + ON CONFLICT SET + params:

```typescript
async function saveWeights(
  weights: ScorerWeights,
  marketType: string,
  meta: { nTrades: number; nTrials: number; bestValue: number },
): Promise<void> {
  await query(
    `INSERT INTO scorer_weights
       (market_type, tradeability, liquidity, volatility, ttr, data_quality,
        type_expected_value, realized_volatility,
        n_trades, n_trials, best_value, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
     ON CONFLICT (market_type) DO UPDATE SET
       tradeability        = EXCLUDED.tradeability,
       liquidity           = EXCLUDED.liquidity,
       volatility          = EXCLUDED.volatility,
       ttr                 = EXCLUDED.ttr,
       data_quality        = EXCLUDED.data_quality,
       type_expected_value = EXCLUDED.type_expected_value,
       realized_volatility = EXCLUDED.realized_volatility,
       n_trades            = EXCLUDED.n_trades,
       n_trials            = EXCLUDED.n_trials,
       best_value          = EXCLUDED.best_value,
       updated_at          = NOW()`,
    [marketType, weights.tradeability, weights.liquidity, weights.volatility,
     weights.ttr, weights.dataQuality, weights.typeExpectedValue, weights.realizedVolatility,
     meta.nTrades, meta.nTrials, meta.bestValue],
  );
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run packages/data-collector/src/services/ScorerWeightOptimizer.test.ts --reporter=verbose 2>&1 | tail -15`
Expected: pass.

Run: `npx tsc -p packages/data-collector --noEmit 2>&1 | tail -10`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/data-collector/src/services/ScorerWeightOptimizer.ts packages/data-collector/src/services/ScorerWeightOptimizer.test.ts
git commit -m "feat(optimizer): realizedVolatility in random search + save path

randomWeights samples realizedVolatility in [0.05, 0.65]. Post-search
normalization scales all 5 optimizable dims to sum to 0.75.
loadClosedTrades requires the new JSONB key so pre-backfill trades
are naturally excluded. saveWeights INSERT + ON CONFLICT both include
the realized_volatility column."
```

---

## Task 9: Historical backfill at dashboard startup

**Files:**
- Modify: `packages/dashboard/src/server.ts` — add backfill block right after the typeExpectedValue backfill block.

- [ ] **Step 1: Add the backfill block**

In `server.ts`, locate the "typeExpectedValue backfill complete" log line (from Sub-project A). Add AFTER it:

```typescript
      // Sub-project B.1: backfill realizedVolatility on post-reset trades.
      const missingRvRes = await query<{ n: string }>(`
        SELECT COUNT(*) as n FROM paper_positions pp
        WHERE pp.closed_at IS NOT NULL
          AND pp.score_dimensions_at_entry IS NOT NULL
          AND NOT (pp.score_dimensions_at_entry ? 'realizedVolatility')
          AND pp.closed_at >= (SELECT last_reset_at FROM paper_account ORDER BY id LIMIT 1)
      `);
      const missingRvCount = Number(missingRvRes.rows[0]?.n ?? 0);
      if (missingRvCount > 0) {
        console.log(`Backfilling realizedVolatility for ${missingRvCount} trades...`);
        await query(`
          UPDATE paper_positions pp
          SET score_dimensions_at_entry = score_dimensions_at_entry || jsonb_build_object(
            'realizedVolatility',
            (SELECT CASE WHEN COUNT(d) < 5 THEN NULL::FLOAT
                          ELSE LEAST(1.0, GREATEST(0.0, STDDEV_POP(d) / 0.02)) END
             FROM (SELECT close - LAG(close) OVER (ORDER BY time) AS d
                   FROM price_history ph
                   WHERE ph.token_id = (SELECT clob_token_id_yes FROM markets WHERE id = pp.market_id)
                     AND ph.time BETWEEN pp.opened_at - INTERVAL '24 hours' AND pp.opened_at) diffs)
          )
          WHERE pp.closed_at IS NOT NULL
            AND pp.score_dimensions_at_entry IS NOT NULL
            AND NOT (pp.score_dimensions_at_entry ? 'realizedVolatility')
            AND pp.closed_at >= (SELECT last_reset_at FROM paper_account ORDER BY id LIMIT 1)
        `);
        console.log('realizedVolatility backfill complete');
      } else {
        console.log('realizedVolatility backfill not needed');
      }
```

- [ ] **Step 2: TypeScript + dashboard test regression check**

Run: `npx tsc -p packages/dashboard --noEmit 2>&1 | tail -10`
Expected: no new TS errors.

Run: `npx vitest run packages/dashboard --reporter=verbose 2>&1 | tail -15`
Expected: no regressions.

- [ ] **Step 3: Commit**

```bash
git add packages/dashboard/src/server.ts
git commit -m "feat(scorer): backfill realizedVolatility on post-reset trades

Idempotent one-shot UPDATE at dashboard startup. For each post-reset
trade missing the realizedVolatility key, compute stddev of first
differences of close prices over the 24h pre-opened_at window and
apply the same mapping as runtime (clamp01(raw / 0.02)). Trades
whose pre-open window falls outside price_history retention (30 days)
get NULL, which is the correct nullable-contract behavior.

Uses a scalar correlated subquery rather than LATERAL for cross-version
portability."
```

---

## Task 10: Deploy + post-deploy verification

- [ ] **Step 1: Merge to main via PR**

Open PR, describe the changes, reference spec + roadmap. On merge, CI builds + deploys both images.

- [ ] **Step 2: Confirm deploy succeeded**

```bash
rtk gh run list --workflow=deploy-gcp.yml --limit=2
```
Expected: latest run is ok. VM HEAD matches the merged SHA:
```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command "cd /home/Usuario/polymarket-trader && git log --oneline -1"
```

- [ ] **Step 3: Verify the three schema additions landed**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command \
  'docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c "\d markets" | grep -E "realized_volatility|bar_count"'
gcloud compute ssh polymarket-vm --zone=us-east1-b --command \
  'docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c "\d scorer_weights" | grep realized_volatility'
gcloud compute ssh polymarket-vm --zone=us-east1-b --command \
  'docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c "\d market_score_history" | grep score_realized_volatility'
```
Expected: all three greps return matching rows.

- [ ] **Step 4: Verify compute-realized-volatility job ran + initial distribution**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command \
  'docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c "SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE realized_volatility_24h IS NOT NULL) AS with_vol, ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY realized_volatility_24h)::numeric, 5) AS p50, ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY realized_volatility_24h)::numeric, 5) AS p95 FROM markets;"'
```
Expected: `with_vol > 0` (job has run at least once), sensible p50/p95. If `with_vol = 0`, wait 15 min for the next cron tick and re-run.

- [ ] **Step 5: Verify backfill populated historical trades**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command \
  'docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c "SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE score_dimensions_at_entry ? '"'"'realizedVolatility'"'"') AS with_feature, COUNT(*) FILTER (WHERE (score_dimensions_at_entry->>'"'"'realizedVolatility'"'"')::text = '"'"'null'"'"') AS explicit_null FROM paper_positions WHERE closed_at IS NOT NULL AND score_dimensions_at_entry IS NOT NULL AND closed_at >= (SELECT last_reset_at FROM paper_account ORDER BY id LIMIT 1);"'
```
Expected: `with_feature = total`. Some `explicit_null` is acceptable (trades whose 24h-pre-open window fell outside retention).

- [ ] **Step 6: Trigger optimizer manually**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command \
  'cd /home/Usuario/polymarket-trader && docker exec -e DATABASE_URL=postgres://polymarket:polymarket_prod@timescaledb:5432/polymarket_trading?sslmode=disable polymarket-data-collector node -e "
const { optimizeScorerWeights } = require(\"/app/dist/services/ScorerWeightOptimizer.js\");
(async () => { await optimizeScorerWeights(); console.log(\"done\"); process.exit(0); })().catch(e => { console.error(e); process.exit(1); });
"'
```
Expected: logs per type with `bestValue` floats; `Global optimization complete` at the end.

- [ ] **Step 7: Verify scorer_weights rows carry the new weight**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command \
  'docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c "SELECT market_type, n_trades, ROUND(best_value::numeric, 4) AS pearson, ROUND(realized_volatility::numeric, 3) AS rv_weight FROM scorer_weights ORDER BY market_type;"'
```
Expected: `rv_weight` column is populated (non-default-0 for at least the global row).

- [ ] **Step 8: Real PnL sanity + rotator composition check**

```bash
# Real PnL + inversions (must remain 0 inversions)
gcloud compute ssh polymarket-vm --zone=us-east1-b --command \
  'docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c "SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE ABS(avg_entry_price + current_price - 1.0) < 0.05 AND EXTRACT(EPOCH FROM (closed_at - opened_at)) < 1800) AS inverted FROM paper_positions WHERE closed_at >= (SELECT last_reset_at FROM paper_account ORDER BY id LIMIT 1) AND realized_pnl IS NOT NULL;"'
```
Expected: `inverted = 0`. Non-zero → stop and escalate (price-inversion regression).

- [ ] **Step 9: Monitor over next 24h**

Watch the daily auto-review the morning after deploy. Confirm:
- No new container restarts attributable to this PR.
- Compute-realized-volatility job logs are clean.
- Rotator pool composition evolves as realizedVolatility starts weighting.

If all post-deploy checks pass, the feature is live. Success-metric OOS evaluation runs over the following 2 weeks via the weekly optimizer retrain.

---

## Self-Review

**1. Spec coverage:**

| Spec section | Task(s) |
|---|---|
| 1. Estimator (first-differences formula) | T4 (compute job SQL implements it) |
| 2. Window + quality filter (24h, ≥5 bars) | T4 (HAVING COUNT(d) ≥ 5) |
| 3. Schema (markets + scorer_weights + market_score_history) | T3 (all three tables + init SQLs + runtime ALTERs) |
| 4. Compute job (15-min cron) | T4 |
| 5. Mapping raw → [0,1] (VOL_REF) | T2 (mapRealizedVolatility) |
| 6. Nullable handling | T1 (type) + T2 (composite) |
| 7. AutoSignalExecutor capture | T7 |
| 8. Historical backfill | T9 |
| 9. Optimizer updates (randomWeights, loadClosedTrades, saveWeights, N_TRIALS) | T8 |
| 10. Default weight allocation | T1 (WEIGHTS redistribution) |
| 11. Success metrics | T10 (manual verification queries, 2-week / 1-month OOS observation) |
| 12. Rollback | Documented in spec; no code in plan (code revert is the path) |

All spec sections covered.

**2. Placeholder scan:**

- No "TBD" or "TODO" in the plan.
- Task 5 step 3's Pass 2 section uses `/* existing volatility/dataQuality logic */` comments pointing to code that already exists — acceptable because the engineer reads the file and keeps it verbatim, matching the pattern used in Sub-project A's plan.
- Task 6 writeScoreHistory stride "base = idx * 13" explicitly notes "Adjust the base stride to reflect the actual column count". This is a known implementation detail that depends on post-T8 code state; the plan directs the engineer to recount. Acceptable.

**3. Type consistency:**

- `realizedVolatility: number | null` consistently used across `ScoreDimensions`, `EnrichUpdate`, JSONB persistence.
- `realizedVolatility: number` (non-null) on `ScorerWeights` because weights are always populated (default 0 via schema).
- `mapRealizedVolatility` signature consistent between MarketScorer (static method) and AutoSignalExecutor (local function).
- Column names `realized_volatility_24h`, `realized_volatility_bar_count` (markets), `realized_volatility` (scorer_weights), `score_realized_volatility` (market_score_history) consistent across init SQLs, runtime ALTERs, and code.

All consistent.

---
