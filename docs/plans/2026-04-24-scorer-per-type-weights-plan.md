# Scorer Per-Type Weights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `MarketScorer` predict PnL per market type — add a `typeExpectedValue` dimension sourced from `category_performance`, and split `scorer_weights` so `ScorerWeightOptimizer` trains per type.

**Architecture:** New dimension + schema column + sentinel `'__global__'` fallback row. Runtime ALTER TABLE idempotent migration at dashboard startup. MarketScorer caches per-type weights with 5-min TTL. ScorerWeightOptimizer loops over types, skipping those with <MIN_TRADES and always refreshing the global row.

**Tech Stack:** TypeScript, vitest, PostgreSQL (TimescaleDB), node-cron (existing scheduler).

**Spec:** `docs/plans/2026-04-24-scorer-per-type-weights-design.md`
**Roadmap:** `docs/plans/2026-04-24-scorer-overhaul-roadmap.md`

---

## File Structure

**Modified:**
- `packages/data-collector/src/services/MarketScorer.ts` — add dimension + per-type weight loading + Pass 1/2 updates
- `packages/data-collector/src/services/MarketScorer.test.ts` — unit tests
- `packages/data-collector/src/services/ScorerWeightOptimizer.ts` — per-type loop
- `packages/data-collector/src/services/ScorerWeightOptimizer.test.ts` — unit tests
- `packages/dashboard/src/services/AutoSignalExecutor.ts:836` — include typeExpectedValue in entry dimensions capture
- `packages/dashboard/src/server.ts` — idempotent ALTER TABLE at startup

**Created:**
- `packages/data-collector/src/database/init/018_scorer_per_type_weights.sql` — schema for fresh DB init
- `scripts/trigger-scorer-optimization.ts` — manual one-shot optimizer trigger

**Existing, unchanged but read:**
- `packages/data-collector/src/database/init/007_scorer_weights.sql`
- `packages/data-collector/src/database/init/008_category_performance.sql`

---

## Task 1: Extend ScoreDimensions / ScorerWeights types + update DEFAULT

**Files:**
- Modify: `packages/data-collector/src/services/MarketScorer.ts:7-34`
- Test: `packages/data-collector/src/services/MarketScorer.test.ts`

- [ ] **Step 1: Write failing tests for new types**

Add to `MarketScorer.test.ts`:

```typescript
import { WEIGHTS, type ScoreDimensions, type ScorerWeights } from './MarketScorer.js';

describe('ScoreDimensions shape', () => {
  it('includes typeExpectedValue field', () => {
    const dims: ScoreDimensions = {
      tradeability: 1, liquidity: 0.5, volatility: null,
      ttr: 0.5, dataQuality: null, typeExpectedValue: 0.75,
    };
    expect(dims.typeExpectedValue).toBe(0.75);
  });
});

describe('WEIGHTS default', () => {
  it('has typeExpectedValue non-zero', () => {
    expect(WEIGHTS.typeExpectedValue).toBeGreaterThan(0);
  });
  it('all weights sum to 1.0', () => {
    const sum = WEIGHTS.tradeability + WEIGHTS.liquidity + WEIGHTS.volatility +
                WEIGHTS.ttr + WEIGHTS.dataQuality + WEIGHTS.typeExpectedValue;
    expect(sum).toBeCloseTo(1.0, 5);
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `cd /c/Users/Usuario/GitHub/polymarket-trader && npx vitest run packages/data-collector/src/services/MarketScorer.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: two new tests FAIL with "typeExpectedValue is not a property".

- [ ] **Step 3: Extend types and default**

In `MarketScorer.ts`, replace lines 7-34 with:

```typescript
export const WEIGHTS = {
  tradeability:      0.25,
  liquidity:         0.20,
  volatility:        0.15,
  ttr:               0.10,
  dataQuality:       0.10,
  typeExpectedValue: 0.20,
} as const;

export const MAX_VOLUME_REF = 30_000_000;

const BATCH_SIZE = 500;

export interface ScoreDimensions {
  tradeability: number;
  liquidity: number;
  volatility: number | null;
  ttr: number;
  dataQuality: number | null;
  typeExpectedValue: number;
}

export interface ScorerWeights {
  tradeability: number;
  liquidity: number;
  volatility: number;
  ttr: number;
  dataQuality: number;
  typeExpectedValue: number;
}
```

- [ ] **Step 4: Run tests, verify pass (and check for TS errors in other files)**

Run: `npx vitest run packages/data-collector/src/services/MarketScorer.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: new tests PASS. Some existing tests that literal-construct `ScoreDimensions` or `ScorerWeights` may break — fix them by adding `typeExpectedValue: 0` or `typeExpectedValue: 0.20` as appropriate. Run until all green.

Also run: `cd /c/Users/Usuario/GitHub/polymarket-trader && npx tsc -p packages/data-collector --noEmit 2>&1 | tail -20`
Expected: no type errors, or only errors in files edited in later tasks.

- [ ] **Step 5: Commit**

```bash
git add packages/data-collector/src/services/MarketScorer.ts packages/data-collector/src/services/MarketScorer.test.ts
git commit -m "feat(scorer): add typeExpectedValue to ScoreDimensions and ScorerWeights

New dimension captures shrunk-Sharpe of the market type — first-class
feature replacing the near-flat category_performance.prior multiplier.
Default weight 0.20 (redistributed from other dims to preserve sum=1.0)."
```

---

## Task 2: Implement `typeExpectedValue()` helper

**Files:**
- Modify: `packages/data-collector/src/services/MarketScorer.ts`
- Test: `packages/data-collector/src/services/MarketScorer.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `MarketScorer.test.ts`:

```typescript
import { MarketScorer } from './MarketScorer.js';

describe('MarketScorer.typeExpectedValue', () => {
  it('returns 0.5 when sharpe is null', () => {
    expect(MarketScorer.typeExpectedValue(null, 100)).toBe(0.5);
  });
  it('returns 0.5 when n < MIN_N (5)', () => {
    expect(MarketScorer.typeExpectedValue(0.32, 4)).toBe(0.5);
  });
  it('computes shrunk Sharpe mapped to [0,1] (event_financial real data)', () => {
    // sharpe=0.27, n=159, K=20: shrunk = 0.27*159/179 = 0.2397
    // mapped = (0.2397 + 1) / 1.5 = 0.8265
    expect(MarketScorer.typeExpectedValue(0.27, 159)).toBeCloseTo(0.8265, 3);
  });
  it('clamps above 1.0 (unrealistic high Sharpe)', () => {
    // sharpe=5, n=1000: shrunk ≈ 4.9 — mapped = 5.9/1.5 = 3.93 → clamp 1.0
    expect(MarketScorer.typeExpectedValue(5, 1000)).toBe(1.0);
  });
  it('clamps at 0.0 (very negative shrunk)', () => {
    // sharpe=-2, n=100: shrunk ≈ -1.67 — mapped = -0.67/1.5 ≈ -0.44 → clamp 0
    expect(MarketScorer.typeExpectedValue(-2, 100)).toBe(0);
  });
  it('MIN_N boundary — n=5 computes, n=4 neutral', () => {
    expect(MarketScorer.typeExpectedValue(0.5, 4)).toBe(0.5);   // neutral
    expect(MarketScorer.typeExpectedValue(0.5, 5)).not.toBe(0.5); // computed
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `npx vitest run packages/data-collector/src/services/MarketScorer.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: 6 tests FAIL with "MarketScorer.typeExpectedValue is not a function".

- [ ] **Step 3: Implement the helper**

In `MarketScorer.ts`, inside the `MarketScorer` class (near other static helpers like `tradeabilityScore`), add:

```typescript
  /**
   * Map shrunk Sharpe of a market type to [0, 1] using Beta-Binomial-style
   * shrinkage. Returns 0.5 (neutral) for types with too few trades or missing
   * sharpe. The (shrunk + 1) / 1.5 mapping was sized for typical [-1, +0.5]
   * Sharpe range; recalibrate if the observed spread stays < 0.10 after a
   * training cycle. Env: SCORER_SHRINKAGE_K overrides the default K=20.
   */
  static typeExpectedValue(
    sharpe: number | null,
    nTrades: number,
    K: number = Number(process.env.SCORER_SHRINKAGE_K ?? 20),
    MIN_N: number = 5,
  ): number {
    if (sharpe === null || nTrades < MIN_N) return 0.5;
    const shrunk = (sharpe * nTrades) / (nTrades + K);
    return clamp01((shrunk + 1) / 1.5);
  }
```

(`clamp01` already exists at line 60 of `MarketScorer.ts`.)

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run packages/data-collector/src/services/MarketScorer.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: all 6 new tests PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add packages/data-collector/src/services/MarketScorer.ts packages/data-collector/src/services/MarketScorer.test.ts
git commit -m "feat(scorer): implement typeExpectedValue helper

Shrunk Sharpe (James-Stein style) of the market type mapped to [0,1].
K=20 shrinkage constant (env SCORER_SHRINKAGE_K), MIN_N=5 below which
we return a neutral 0.5. Clamped to [0, 1] so extreme sharpes don't
blow up the composite score."
```

---

## Task 3: Update `compositeScore()` to include new dimension

**Files:**
- Modify: `packages/data-collector/src/services/MarketScorer.ts` (the `compositeScore` method)
- Test: `packages/data-collector/src/services/MarketScorer.test.ts`

- [ ] **Step 1: Write failing test**

Add to `MarketScorer.test.ts`:

```typescript
describe('MarketScorer.compositeScore with typeExpectedValue', () => {
  it('includes typeExpectedValue contribution in composite', () => {
    const dims: ScoreDimensions = {
      tradeability: 1, liquidity: 1, volatility: null,
      ttr: 1, dataQuality: null, typeExpectedValue: 1,
    };
    const weights: ScorerWeights = {
      tradeability: 0.25, liquidity: 0.20, volatility: 0.15,
      ttr: 0.10, dataQuality: 0.10, typeExpectedValue: 0.20,
    };
    // All non-null dims at 1 (tradeability, liquidity, ttr, typeExpectedValue)
    // weighted by their share of (0.25+0.20+0.10+0.20) = 0.75, normalized → 1.0
    const score = MarketScorer.compositeScore(dims, weights);
    expect(score).toBeCloseTo(1.0, 3);
  });

  it('typeExpectedValue at 0 drops score by its weight share', () => {
    const dims: ScoreDimensions = {
      tradeability: 1, liquidity: 1, volatility: null,
      ttr: 1, dataQuality: null, typeExpectedValue: 0,
    };
    const weights: ScorerWeights = {
      tradeability: 0.25, liquidity: 0.20, volatility: 0.15,
      ttr: 0.10, dataQuality: 0.10, typeExpectedValue: 0.20,
    };
    // Non-null weighted sum = 0.25+0.20+0.10+0 (for typeEV=0) = 0.55
    // Normalized by non-null weight-sum (0.25+0.20+0.10+0.20) = 0.75
    // score = 0.55 / 0.75 ≈ 0.733
    const score = MarketScorer.compositeScore(dims, weights);
    expect(score).toBeCloseTo(0.733, 2);
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `npx vitest run packages/data-collector/src/services/MarketScorer.test.ts --reporter=verbose 2>&1 | tail -15`
Expected: 2 new tests FAIL (score computed without typeExpectedValue contribution).

- [ ] **Step 3: Update `compositeScore()`**

Find `compositeScore` in `MarketScorer.ts` and add the new dimension to both the weighted sum and the normalization. The exact edit depends on the current implementation — read it first. The change pattern:

```typescript
  static compositeScore(dims: ScoreDimensions, weights: ScorerWeights): number {
    let sum = 0;
    let totalWeight = 0;

    sum += weights.tradeability * dims.tradeability;      totalWeight += weights.tradeability;
    sum += weights.liquidity * dims.liquidity;            totalWeight += weights.liquidity;
    if (dims.volatility !== null) {
      sum += weights.volatility * dims.volatility;        totalWeight += weights.volatility;
    }
    sum += weights.ttr * dims.ttr;                        totalWeight += weights.ttr;
    if (dims.dataQuality !== null) {
      sum += weights.dataQuality * dims.dataQuality;      totalWeight += weights.dataQuality;
    }
    // NEW: typeExpectedValue is never null (typeExpectedValue() returns 0.5 as neutral)
    sum += weights.typeExpectedValue * dims.typeExpectedValue;
    totalWeight += weights.typeExpectedValue;

    return totalWeight > 0 ? sum / totalWeight : 0;
  }
```

If the existing implementation uses a different style, adapt the edit to match while preserving the contract: `typeExpectedValue` always contributes (it's never null).

- [ ] **Step 4: Run tests, verify all pass**

Run: `npx vitest run packages/data-collector/src/services/MarketScorer.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: all tests PASS including both new ones. No regressions.

- [ ] **Step 5: Commit**

```bash
git add packages/data-collector/src/services/MarketScorer.ts packages/data-collector/src/services/MarketScorer.test.ts
git commit -m "feat(scorer): compositeScore weights typeExpectedValue

Dimension contributes unconditionally (helper returns 0.5 neutral rather
than null for missing data) so it is always in the normalization."
```

---

## Task 4: Runtime ALTER TABLE migration in server startup

**Files:**
- Modify: `packages/dashboard/src/server.ts` (around line 189 where existing `ALTER TABLE IF NOT EXISTS` pattern lives)
- Create: `packages/data-collector/src/database/init/018_scorer_per_type_weights.sql` — for fresh DB init only

- [ ] **Step 1: Create init SQL for fresh DB installs**

Create `packages/data-collector/src/database/init/018_scorer_per_type_weights.sql`:

```sql
-- Per-type scorer weights + new typeExpectedValue dimension.
-- Sentinel '__global__' marks the fallback row used when no per-type row exists
-- or when a per-type row has n_trades below MIN_TRADES.
ALTER TABLE scorer_weights
  ADD COLUMN IF NOT EXISTS market_type VARCHAR(32) NOT NULL DEFAULT '__global__';
ALTER TABLE scorer_weights
  ADD COLUMN IF NOT EXISTS type_expected_value FLOAT NOT NULL DEFAULT 0;

-- UNIQUE(market_type): one row per type + one '__global__' row.
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniq_scorer_weights_market_type'
  ) THEN
    ALTER TABLE scorer_weights
      ADD CONSTRAINT uniq_scorer_weights_market_type UNIQUE (market_type);
  END IF;
END $do$;
```

- [ ] **Step 2: Add equivalent idempotent migration to server.ts startup**

In `packages/dashboard/src/server.ts`, near the existing `ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS ...` block (around line 190), add:

```typescript
      // Ensure scorer_weights supports per-type weights and typeExpectedValue dim.
      // See docs/plans/2026-04-24-scorer-per-type-weights-design.md.
      await query(`
        ALTER TABLE scorer_weights
          ADD COLUMN IF NOT EXISTS market_type VARCHAR(32) NOT NULL DEFAULT '__global__';
      `);
      await query(`
        ALTER TABLE scorer_weights
          ADD COLUMN IF NOT EXISTS type_expected_value FLOAT NOT NULL DEFAULT 0;
      `);
      await query(`
        DO $do$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'uniq_scorer_weights_market_type'
          ) THEN
            ALTER TABLE scorer_weights
              ADD CONSTRAINT uniq_scorer_weights_market_type UNIQUE (market_type);
          END IF;
        END $do$;
      `);
      console.log('scorer_weights per-type columns ensured');
```

- [ ] **Step 3: Verify migration idempotency (locally if test DB available, else visual)**

If a local test DB is available:

```bash
psql "$TEST_DATABASE_URL" -c "CREATE TABLE IF NOT EXISTS scorer_weights (id SERIAL PRIMARY KEY, tradeability FLOAT, liquidity FLOAT, volatility FLOAT, ttr FLOAT, data_quality FLOAT, n_trades INT, n_trials INT, best_value FLOAT, updated_at TIMESTAMPTZ);"
psql "$TEST_DATABASE_URL" -f packages/data-collector/src/database/init/018_scorer_per_type_weights.sql
psql "$TEST_DATABASE_URL" -f packages/data-collector/src/database/init/018_scorer_per_type_weights.sql  # second run
psql "$TEST_DATABASE_URL" -c "\d scorer_weights"
```
Expected: second run produces no errors, columns present, constraint present.

If no local DB available, skip and defer verification to the post-deploy step.

- [ ] **Step 4: Run dashboard unit+integration tests to catch regressions**

Run: `cd /c/Users/Usuario/GitHub/polymarket-trader && npx vitest run packages/dashboard/src/server.ts --reporter=verbose 2>&1 | tail -10` (if server.ts has tests; otherwise skip).
Run: `npx vitest run packages/dashboard 2>&1 | tail -20`
Expected: no new failures.

- [ ] **Step 5: Commit**

```bash
git add packages/data-collector/src/database/init/018_scorer_per_type_weights.sql packages/dashboard/src/server.ts
git commit -m "feat(scorer): runtime migration for per-type scorer_weights

Adds market_type (sentinel '__global__' default) + type_expected_value
columns and UNIQUE(market_type) via idempotent ALTER TABLE at dashboard
startup. Matching init SQL (018_*) created for fresh DB installs."
```

---

## Task 5: Implement `loadCategoryMetrics()` helper in MarketScorer

**Files:**
- Modify: `packages/data-collector/src/services/MarketScorer.ts`
- Test: `packages/data-collector/src/services/MarketScorer.test.ts`

- [ ] **Step 1: Write failing test**

Add to `MarketScorer.test.ts`:

```typescript
import { query } from '../database/connection.js';
vi.mock('../database/connection.js', () => ({
  query: vi.fn(),
}));

describe('MarketScorer.loadCategoryMetrics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads a Map keyed by market_type', async () => {
    (query as any).mockResolvedValue({
      rows: [
        { market_type: 'event_financial', sharpe_ratio: 0.27, n_trades: 159 },
        { market_type: 'event_long',      sharpe_ratio: 0.17, n_trades: 1317 },
      ],
    });
    const map = await MarketScorer.loadCategoryMetrics();
    expect(map.get('event_financial')).toEqual({ sharpe: 0.27, n: 159 });
    expect(map.get('event_long')).toEqual({ sharpe: 0.17, n: 1317 });
  });

  it('returns empty Map when table is empty', async () => {
    (query as any).mockResolvedValue({ rows: [] });
    const map = await MarketScorer.loadCategoryMetrics();
    expect(map.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `npx vitest run packages/data-collector/src/services/MarketScorer.test.ts --reporter=verbose 2>&1 | tail -15`
Expected: 2 new tests FAIL with "is not a function".

- [ ] **Step 3: Implement helper**

Add to `MarketScorer` class (near other static helpers):

```typescript
  /**
   * Load current category_performance keyed by market_type.
   * Used once per scoring run to compute typeExpectedValue per market.
   */
  static async loadCategoryMetrics(): Promise<Map<string, { sharpe: number | null; n: number }>> {
    const result = await query<{ market_type: string; sharpe_ratio: number | null; n_trades: number | string }>(
      `SELECT market_type, sharpe_ratio, n_trades FROM category_performance`,
    );
    const map = new Map<string, { sharpe: number | null; n: number }>();
    for (const r of result.rows) {
      map.set(r.market_type, {
        sharpe: r.sharpe_ratio !== null ? Number(r.sharpe_ratio) : null,
        n: Number(r.n_trades),
      });
    }
    return map;
  }
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run packages/data-collector/src/services/MarketScorer.test.ts --reporter=verbose 2>&1 | tail -15`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/data-collector/src/services/MarketScorer.ts packages/data-collector/src/services/MarketScorer.test.ts
git commit -m "feat(scorer): add loadCategoryMetrics helper

Returns a Map<marketType, {sharpe, n}> from category_performance,
consumed by Pass 1 and Pass 2 to compute typeExpectedValue per market."
```

---

## Task 6: Refactor `loadWeights(marketType)` with cache + fallback

**Files:**
- Modify: `packages/data-collector/src/services/MarketScorer.ts`
- Test: `packages/data-collector/src/services/MarketScorer.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `MarketScorer.test.ts`:

```typescript
describe('MarketScorer.loadWeights per-type', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MarketScorer.clearWeightsCache(); // helper we'll add in step 3
  });

  it('returns per-type weights when row has enough trades', async () => {
    (query as any).mockResolvedValue({
      rows: [
        { market_type: 'event_financial', tradeability: 0.4, liquidity: 0.2,
          volatility: 0.1, ttr: 0.1, data_quality: 0.1, type_expected_value: 0.1,
          n_trades: 100 },
        { market_type: '__global__', tradeability: 0.25, liquidity: 0.20,
          volatility: 0.15, ttr: 0.10, data_quality: 0.10, type_expected_value: 0.20,
          n_trades: 1800 },
      ],
    });
    const w = await MarketScorer.loadWeights('event_financial');
    expect(w.tradeability).toBeCloseTo(0.4);
  });

  it('falls back to global when per-type n_trades < MIN_TRADES_FOR_PER_TYPE (30)', async () => {
    (query as any).mockResolvedValue({
      rows: [
        { market_type: 'crypto_intraday', tradeability: 0.5, liquidity: 0.1,
          volatility: 0.1, ttr: 0.1, data_quality: 0.1, type_expected_value: 0.1,
          n_trades: 7 },
        { market_type: '__global__', tradeability: 0.25, liquidity: 0.20,
          volatility: 0.15, ttr: 0.10, data_quality: 0.10, type_expected_value: 0.20,
          n_trades: 1800 },
      ],
    });
    const w = await MarketScorer.loadWeights('crypto_intraday');
    expect(w.tradeability).toBeCloseTo(0.25);  // global, not per-type
  });

  it('falls back to global when per-type row missing', async () => {
    (query as any).mockResolvedValue({
      rows: [
        { market_type: '__global__', tradeability: 0.25, liquidity: 0.20,
          volatility: 0.15, ttr: 0.10, data_quality: 0.10, type_expected_value: 0.20,
          n_trades: 1800 },
      ],
    });
    const w = await MarketScorer.loadWeights('unknown_type');
    expect(w.tradeability).toBeCloseTo(0.25);
  });

  it('caches per type — second call in TTL does not re-query', async () => {
    (query as any).mockResolvedValue({
      rows: [
        { market_type: '__global__', tradeability: 0.25, liquidity: 0.20,
          volatility: 0.15, ttr: 0.10, data_quality: 0.10, type_expected_value: 0.20,
          n_trades: 1800 },
      ],
    });
    await MarketScorer.loadWeights('event_long');
    await MarketScorer.loadWeights('event_long');
    expect((query as any).mock.calls.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `npx vitest run packages/data-collector/src/services/MarketScorer.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: new tests FAIL (signature mismatch or no cache).

- [ ] **Step 3: Refactor `loadWeights` + add cache**

In `MarketScorer.ts`, replace the existing `static async loadWeights(): Promise<ScorerWeights>` with:

```typescript
  private static readonly GLOBAL_MARKET_TYPE = '__global__';
  private static readonly MIN_TRADES_FOR_PER_TYPE = 30;
  private static readonly WEIGHTS_CACHE_TTL_MS = 5 * 60 * 1000;

  private static weightsCache = new Map<string, { weights: ScorerWeights; loadedAt: number }>();

  /** Test hook: wipe the in-memory cache. */
  static clearWeightsCache(): void {
    MarketScorer.weightsCache.clear();
  }

  /**
   * Load the composite weights for the given market type. Falls back to the
   * '__global__' sentinel row if: (a) no per-type row exists, (b) the per-type
   * row's n_trades is below MIN_TRADES_FOR_PER_TYPE. TTL-cached for 5 minutes;
   * no explicit invalidation (a freshly retrained per-type row is picked up
   * within at most one TTL, well under the hourly scoring cadence).
   */
  static async loadWeights(marketType: string | null = null): Promise<ScorerWeights> {
    const key = marketType ?? MarketScorer.GLOBAL_MARKET_TYPE;
    const cached = MarketScorer.weightsCache.get(key);
    if (cached && Date.now() - cached.loadedAt < MarketScorer.WEIGHTS_CACHE_TTL_MS) {
      return cached.weights;
    }

    const result = await query<{
      market_type: string;
      tradeability: string | number;
      liquidity: string | number;
      volatility: string | number;
      ttr: string | number;
      data_quality: string | number;
      type_expected_value: string | number;
      n_trades: number | null;
    }>(
      `SELECT market_type, tradeability, liquidity, volatility, ttr,
              data_quality, type_expected_value, n_trades
       FROM scorer_weights
       WHERE market_type IN ($1, $2)`,
      [key, MarketScorer.GLOBAL_MARKET_TYPE],
    );

    const perType = result.rows.find(
      r => r.market_type === marketType && (r.n_trades ?? 0) >= MarketScorer.MIN_TRADES_FOR_PER_TYPE,
    );
    const globalRow = result.rows.find(r => r.market_type === MarketScorer.GLOBAL_MARKET_TYPE);
    const row = perType ?? globalRow;

    const weights: ScorerWeights = row
      ? {
          tradeability:      Number(row.tradeability),
          liquidity:         Number(row.liquidity),
          volatility:        Number(row.volatility),
          ttr:               Number(row.ttr),
          dataQuality:       Number(row.data_quality),
          typeExpectedValue: Number(row.type_expected_value),
        }
      : { ...WEIGHTS };

    MarketScorer.weightsCache.set(key, { weights, loadedAt: Date.now() });
    return weights;
  }
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run packages/data-collector/src/services/MarketScorer.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: all tests PASS including the 4 new ones. Pre-existing tests that called `loadWeights()` with no args continue to work (default null → fetches global).

- [ ] **Step 5: Commit**

```bash
git add packages/data-collector/src/services/MarketScorer.ts packages/data-collector/src/services/MarketScorer.test.ts
git commit -m "feat(scorer): per-type loadWeights with cache + fallback

loadWeights(marketType) prefers the per-type scorer_weights row when it
has >= MIN_TRADES_FOR_PER_TYPE (30) trained trades, otherwise falls back
to the '__global__' row. TTL cache (5 min) keyed by market_type."
```

---

## Task 7: Refactor Pass 1 `scoreAllMarkets()` to use per-type weights + typeExpectedValue

**Files:**
- Modify: `packages/data-collector/src/services/MarketScorer.ts` (the `scoreAllMarkets` method)
- Test: `packages/data-collector/src/services/MarketScorer.test.ts`

- [ ] **Step 1: Write failing integration-style test**

Add to `MarketScorer.test.ts`:

```typescript
describe('MarketScorer.scoreAllMarkets Pass 1 per-type', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MarketScorer.clearWeightsCache();
  });

  it('issues one UPDATE per distinct market_type plus a NULL-type fallback', async () => {
    // Setup: three types + NULL, plus per-type weights rows + global
    (query as any).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('SELECT DISTINCT market_type')) {
        return { rows: [{ market_type: 'event_long' }, { market_type: 'event_financial' }] };
      }
      if (typeof sql === 'string' && sql.includes('FROM category_performance')) {
        return { rows: [
          { market_type: 'event_long',      sharpe_ratio: 0.17, n_trades: 1317 },
          { market_type: 'event_financial', sharpe_ratio: 0.27, n_trades: 159 },
        ] };
      }
      if (typeof sql === 'string' && sql.includes('FROM scorer_weights')) {
        return { rows: [{ market_type: '__global__', tradeability: 0.25, liquidity: 0.20,
          volatility: 0.15, ttr: 0.10, data_quality: 0.10, type_expected_value: 0.20,
          n_trades: 1800 }] };
      }
      if (typeof sql === 'string' && sql.includes('SELECT condition_id')) {
        return { rows: [] }; // Pass 1 cold candidates — empty for this test
      }
      return { rows: [], rowCount: 0 };
    });
    const scorer = new MarketScorer();
    await scorer.scoreAllMarkets();
    const updateCalls = (query as any).mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].trim().startsWith('UPDATE markets'),
    );
    // 2 per-type + 1 fallback = 3
    expect(updateCalls.length).toBeGreaterThanOrEqual(3);
  });
});
```

(Adapt the assertion to the real existing Pass 1 SQL structure — run step 2 to see the failure first.)

- [ ] **Step 2: Run tests, verify failure**

Run: `npx vitest run packages/data-collector/src/services/MarketScorer.test.ts --reporter=verbose 2>&1 | tail -15`
Expected: test FAILS (current code issues a single UPDATE, not per-type).

- [ ] **Step 3: Refactor `scoreAllMarkets` Pass 1**

Read current `scoreAllMarkets()` first. Replace the monolithic Pass 1 UPDATE with a per-type loop + fallback.

Outline (adapt to existing style and variable names):

```typescript
  async scoreAllMarkets(): Promise<{ scored: number; enriched: number }> {
    const categoryMetrics = await MarketScorer.loadCategoryMetrics();

    // Discover all market_types present in markets (excluding NULL, handled separately)
    const typesResult = await query<{ market_type: string }>(
      `SELECT DISTINCT market_type FROM markets WHERE market_type IS NOT NULL`,
    );

    let totalScored = 0;
    for (const { market_type } of typesResult.rows) {
      const weights = await MarketScorer.loadWeights(market_type);
      const metric = categoryMetrics.get(market_type);
      const typeEV = MarketScorer.typeExpectedValue(
        metric?.sharpe ?? null,
        metric?.n ?? 0,
      );

      // Per-type UPDATE. The typeEV literal is interpolated safely (it's a clamped numeric).
      const res = await query(`
        UPDATE markets SET market_score = (
          ${weights.tradeability} * <tradeability CASE>
          + ${weights.liquidity}  * <liquidity CASE>
          + ${weights.ttr}        * <ttr CASE>
          + ${weights.typeExpectedValue} * ${typeEV}
        )
        WHERE market_type = $1
          AND is_active = true AND is_resolved = false
          AND clob_token_id_yes IS NOT NULL
          AND tracking_status NOT IN ('warming', 'active', 'cooling')
      `, [market_type]);
      totalScored += res.rowCount ?? 0;
    }

    // Fallback for markets with NULL market_type — use global weights + neutral 0.5 typeEV
    const globalWeights = await MarketScorer.loadWeights(null);
    const fallbackRes = await query(`
      UPDATE markets SET market_score = (
        ${globalWeights.tradeability} * <tradeability CASE>
        + ${globalWeights.liquidity}  * <liquidity CASE>
        + ${globalWeights.ttr}        * <ttr CASE>
        + ${globalWeights.typeExpectedValue} * 0.5
      )
      WHERE market_type IS NULL
        AND is_active = true AND is_resolved = false
        AND clob_token_id_yes IS NOT NULL
        AND tracking_status NOT IN ('warming', 'active', 'cooling')
    `);
    totalScored += fallbackRes.rowCount ?? 0;

    // ... existing Pass 2 (tracked markets, JS-side) continues — modified in Task 8 ...
  }
```

Replace `<tradeability CASE>`, `<liquidity CASE>`, `<ttr CASE>` with the existing CASE expressions from the current Pass 1 SQL (do not re-derive them — copy verbatim). Also normalize by non-null weight sum if the current formula does that.

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run packages/data-collector/src/services/MarketScorer.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: new test PASS, all pre-existing Pass 1 tests still PASS (may need to adjust mocks for the DISTINCT market_type query).

- [ ] **Step 5: Commit**

```bash
git add packages/data-collector/src/services/MarketScorer.ts packages/data-collector/src/services/MarketScorer.test.ts
git commit -m "feat(scorer): Pass 1 per-type UPDATEs with typeExpectedValue

scoreAllMarkets() now iterates distinct market_types, loading per-type
weights and injecting the type-specific typeExpectedValue as a numeric
literal. Markets with NULL market_type get a fallback UPDATE using
global weights and neutral 0.5 typeEV."
```

---

## Task 8: Update Pass 2 (tracked markets) to use per-type weights + typeExpectedValue

**Files:**
- Modify: `packages/data-collector/src/services/MarketScorer.ts` (Pass 2 section of `scoreAllMarkets`)
- Modify: same file — extend `EnrichUpdate` interface to carry `typeExpectedValue`
- Modify: `batchUpdateScores` and `writeScoreHistory` to persist the new field if applicable
- Test: `packages/data-collector/src/services/MarketScorer.test.ts`

- [ ] **Step 1: Extend `EnrichUpdate` type**

In `MarketScorer.ts`, find `export interface EnrichUpdate` (around line 36) and add `typeExpectedValue: number` to the interface. No test change needed — TS catches consumers.

- [ ] **Step 2: Write failing test for Pass 2 per-type**

Add to `MarketScorer.test.ts`:

```typescript
describe('MarketScorer.scoreAllMarkets Pass 2 per-type', () => {
  beforeEach(() => { vi.clearAllMocks(); MarketScorer.clearWeightsCache(); });

  it('uses per-type weights for each tracked market', async () => {
    // Two tracked markets of different types
    (query as any).mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT DISTINCT market_type')) return { rows: [] };
      if (sql.includes('FROM category_performance')) return {
        rows: [
          { market_type: 'event_financial', sharpe_ratio: 0.27, n_trades: 159 },
          { market_type: 'event_long',      sharpe_ratio: 0.17, n_trades: 1317 },
        ],
      };
      if (sql.includes('FROM scorer_weights')) return { rows: [
        { market_type: '__global__', tradeability: 0.25, liquidity: 0.20,
          volatility: 0.15, ttr: 0.10, data_quality: 0.10, type_expected_value: 0.20,
          n_trades: 1800 },
      ]};
      if (sql.includes('SELECT m.condition_id,\n             m.tracking_status')) return {
        rows: [
          { condition_id: 'A', tracking_status: 'active', current_price_yes: '0.30',
            volume_24h: '1000', spread: null, end_date: new Date().toISOString(),
            market_type: 'event_financial', stddev: '0.05', informative_bars: '20', total_bars: '24' },
        ],
      };
      return { rows: [], rowCount: 0 };
    });
    const scorer = new MarketScorer();
    await scorer.scoreAllMarkets();
    // Assert no exception; batchUpdateScores called with enrichUpdates carrying typeExpectedValue
    const updateCalls = (query as any).mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('UPDATE markets')
    );
    expect(updateCalls.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run tests, verify failure**

Run: `npx vitest run packages/data-collector/src/services/MarketScorer.test.ts --reporter=verbose 2>&1 | tail -15`
Expected: FAIL — TS errors on missing `typeExpectedValue` in EnrichUpdate constructions inside Pass 2.

- [ ] **Step 4: Update Pass 2 loop**

In the Pass 2 section (where `trackedResult.rows` iterates), add typeExpectedValue to every `EnrichUpdate` construction, and use per-type weights:

```typescript
    const categoryMetrics = await MarketScorer.loadCategoryMetrics();

    // ... existing tracked query ...

    const enrichUpdates: EnrichUpdate[] = [];
    for (const row of trackedResult.rows) {
      const weights = await MarketScorer.loadWeights(row.market_type ?? null);
      const metric = categoryMetrics.get(row.market_type ?? '');
      const typeEV = MarketScorer.typeExpectedValue(metric?.sharpe ?? null, metric?.n ?? 0);

      const tradeability = MarketScorer.tradeabilityScore(/* existing inputs */);
      const liquidity    = MarketScorer.liquidityScore(/* existing inputs */);
      const ttr          = MarketScorer.ttrScore(/* existing inputs */);
      const volatility   = /* existing computation */;
      const dataQuality  = /* existing computation */;

      const dims: ScoreDimensions = { tradeability, liquidity, volatility, ttr, dataQuality, typeExpectedValue: typeEV };
      const score = MarketScorer.compositeScore(dims, weights);

      enrichUpdates.push({
        conditionId:       row.condition_id,
        trackingStatus:    row.tracking_status,
        score,
        tradeability,
        liquidity,
        ttr,
        volatility,
        dataQuality,
        typeExpectedValue: typeEV,
        currentPriceYes:   row.current_price_yes !== null ? Number(row.current_price_yes) : null,
        volume24h:         row.volume_24h !== null ? Number(row.volume_24h) : null,
        marketType:        row.market_type ?? null,
      });
    }
```

Adapt the `/* existing */` parts to match the code you read. The important changes: (a) per-row `loadWeights(row.market_type)`, (b) compute `typeEV` from categoryMetrics, (c) include in `dims` + `EnrichUpdate`.

- [ ] **Step 5: Update `batchUpdateScores` to persist typeExpectedValue (if markets table gets the dim stored)**

Decision: `markets.market_score` stores the final composite — no per-dimension column in markets. `batchUpdateScores` does not need to persist typeExpectedValue directly. The dimension only appears in `EnrichUpdate` for downstream use in `writeScoreHistory`.

Update `writeScoreHistory` to include `typeExpectedValue` as part of the snapshot if the `market_score_history` table has a JSONB dims column. If it has discrete columns per dim, add a migration for `type_expected_value FLOAT` in that table too. Run this check by reading `006_score_history.sql`:

Read `packages/data-collector/src/database/init/006_score_history.sql` and choose:
- If JSONB: include `typeExpectedValue` in the object.
- If discrete columns: add `ALTER TABLE market_score_history ADD COLUMN IF NOT EXISTS type_expected_value FLOAT` in the same startup block in `server.ts` as Task 4, and adjust the INSERT in `writeScoreHistory`.

- [ ] **Step 6: Run tests, verify pass**

Run: `npx vitest run packages/data-collector/src/services/MarketScorer.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: all tests PASS.

Also run: `npx tsc -p packages/data-collector --noEmit 2>&1 | tail -10`
Expected: no TS errors.

- [ ] **Step 7: Commit**

```bash
git add packages/data-collector/src/services/MarketScorer.ts packages/data-collector/src/services/MarketScorer.test.ts packages/dashboard/src/server.ts packages/data-collector/src/database/init/*.sql
git commit -m "feat(scorer): Pass 2 per-type weights + typeExpectedValue

EnrichUpdate carries the new dimension; Pass 2 loop loads per-type
weights (cached) and uses category_performance to compute typeEV per
market. market_score_history extended as needed."
```

---

## Task 9: Extend `AutoSignalExecutor` to capture `typeExpectedValue` at position open

**Files:**
- Modify: `packages/dashboard/src/services/AutoSignalExecutor.ts:836-842`

- [ ] **Step 1: Inspect current code and surrounding imports**

Read `AutoSignalExecutor.ts` around line 830-845. Note which package MarketScorer helpers are imported from (this file is in the dashboard package; the MarketScorer helpers live in data-collector). Options:
- Import `MarketScorer.typeExpectedValue` from `@polymarket-trader/data-collector` (if workspace-linked).
- Replicate the helper in the dashboard package to avoid cross-package coupling.

Prefer the import path already used for `computeTradeability`, `computeLiquidity`, `computeTtr`. Follow whatever pattern exists.

- [ ] **Step 2: Add a failing test**

Add a test next to existing executor tests (or create a new test block in an existing test file that exercises position-open):

```typescript
it('captures typeExpectedValue in score_dimensions_at_entry', async () => {
  // setup: category_performance mock returns { event_financial: { sharpe: 0.27, n: 159 } }
  // open a position on a market of type event_financial
  // assert: paperPositionsRepo.create called with score_dimensions_at_entry.typeExpectedValue close to 0.827
});
```

(The exact test skeleton depends on existing test infrastructure. If this is hard to test in isolation, defer to post-deploy verification and skip this step — note in commit message.)

- [ ] **Step 3: Update the dimension capture block**

In `AutoSignalExecutor.ts:836`, expand the query at line 822 to also fetch `market_type`, and populate `typeExpectedValue`:

```typescript
      const mktResult = await query<{
        market_score: string | null;
        current_price_yes: string | null;
        volume_24h: string | null;
        spread: string | null;
        end_date: string | null;
        market_type: string | null;   // NEW
      }>(
        `SELECT market_score, current_price_yes, volume_24h, spread, end_date, market_type
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

        // Look up category metrics for typeExpectedValue
        let typeEV = 0.5;
        if (m.market_type) {
          const cpResult = await query<{ sharpe_ratio: number | null; n_trades: number }>(
            `SELECT sharpe_ratio, n_trades FROM category_performance WHERE market_type = $1`,
            [m.market_type],
          );
          if (cpResult.rows.length > 0) {
            const cp = cpResult.rows[0];
            typeEV = MarketScorer.typeExpectedValue(
              cp.sharpe_ratio !== null ? Number(cp.sharpe_ratio) : null,
              Number(cp.n_trades),
            );
          }
        }

        scoreDimensionsAtEntry = {
          tradeability:      computeTradeability(price),
          liquidity:         computeLiquidity(vol, sprd),
          ttr:               computeTtr(endDate),
          volatility:        null,
          dataQuality:       null,
          typeExpectedValue: typeEV,   // NEW
        };
      }
```

If `MarketScorer` is not importable from the dashboard package, inline the formula (same as step 3 of Task 2) as a local helper in `AutoSignalExecutor.ts`.

- [ ] **Step 4: Run executor tests**

Run: `npx vitest run packages/dashboard/src/services/AutoSignalExecutor --reporter=verbose 2>&1 | tail -20`
Expected: no regressions. If the test added in Step 2 is present, it passes.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/services/AutoSignalExecutor.ts
git commit -m "feat(executor): capture typeExpectedValue at position open

When recording score_dimensions_at_entry on a new paper position, look up
the market's category_performance row and compute typeExpectedValue via
the same shrunk-Sharpe formula MarketScorer uses. Ensures new trades
contribute the full feature set to ScorerWeightOptimizer training."
```

---

## Task 10: Refactor `ScorerWeightOptimizer` to loop over types + filter training data

**Files:**
- Modify: `packages/data-collector/src/services/ScorerWeightOptimizer.ts`
- Test: `packages/data-collector/src/services/ScorerWeightOptimizer.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `ScorerWeightOptimizer.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { query } from '../database/connection.js';
import { optimizeScorerWeights } from './ScorerWeightOptimizer.js';

vi.mock('../database/connection.js', () => ({ query: vi.fn() }));

describe('optimizeScorerWeights per-type', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skips types with fewer than MIN_TRADES trades', async () => {
    (query as any).mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT DISTINCT market_type FROM markets')) {
        return { rows: [{ market_type: 'crypto_daily' }] };
      }
      if (sql.includes('FROM paper_positions pp')) {
        return { rows: [] }; // no trades for crypto_daily
      }
      if (sql.startsWith('INSERT INTO scorer_weights')) {
        return { rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    await optimizeScorerWeights();
    const inserts = (query as any).mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].startsWith('INSERT INTO scorer_weights'),
    );
    // Only the '__global__' row gets inserted (crypto_daily skipped)
    expect(inserts.every((c: any[]) => c[1][0] === '__global__')).toBe(true);
  });

  it('runs optimization per eligible type and writes a global row', async () => {
    (query as any).mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT DISTINCT market_type FROM markets')) {
        return { rows: [{ market_type: 'event_long' }, { market_type: 'event_financial' }] };
      }
      if (sql.includes('FROM paper_positions pp')) {
        // return 50 synthetic trades each call
        return { rows: Array.from({ length: 50 }, () => ({
          score_dimensions_at_entry: { tradeability: 0.5, liquidity: 0.5, ttr: 0.5, typeExpectedValue: 0.7 },
          realized_pnl: '10',
        }))};
      }
      return { rowCount: 1, rows: [] };
    });
    await optimizeScorerWeights();
    const inserts = (query as any).mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].startsWith('INSERT INTO scorer_weights'),
    );
    const marketTypes = inserts.map((c: any[]) => c[1][0]).sort();
    expect(marketTypes).toEqual(['__global__', 'event_financial', 'event_long']);
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `npx vitest run packages/data-collector/src/services/ScorerWeightOptimizer.test.ts --reporter=verbose 2>&1 | tail -15`
Expected: FAIL (current optimizer loads all trades once, writes single row).

- [ ] **Step 3: Refactor `optimizeScorerWeights`**

Replace `ScorerWeightOptimizer.ts` main function (currently at lines 102-141 plus helpers). Full rewrite of `optimizeScorerWeights` and adjacent helpers:

```typescript
const GLOBAL_MARKET_TYPE = '__global__';

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
       AND pp.realized_pnl IS NOT NULL
       AND ($1::text IS NULL OR m.market_type = $1)
       AND pp.closed_at >= (SELECT last_reset_at FROM paper_account ORDER BY id LIMIT 1)`,
    [marketType],
  );
  return result.rows.map((r) => ({
    dims: {
      tradeability:      r.score_dimensions_at_entry.tradeability      ?? 0,
      liquidity:         r.score_dimensions_at_entry.liquidity         ?? 0,
      volatility:        r.score_dimensions_at_entry.volatility        ?? null,
      ttr:               r.score_dimensions_at_entry.ttr               ?? 0,
      dataQuality:       r.score_dimensions_at_entry.dataQuality       ?? null,
      typeExpectedValue: r.score_dimensions_at_entry.typeExpectedValue ?? 0.5,
    },
    pnl: parseFloat(r.realized_pnl),
  }));
}

async function saveWeights(
  weights: ScorerWeights,
  marketType: string,
  meta: { nTrades: number; nTrials: number; bestValue: number },
): Promise<void> {
  await query(
    `INSERT INTO scorer_weights
       (market_type, tradeability, liquidity, volatility, ttr, data_quality,
        type_expected_value, n_trades, n_trials, best_value, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
     ON CONFLICT (market_type) DO UPDATE SET
       tradeability        = EXCLUDED.tradeability,
       liquidity           = EXCLUDED.liquidity,
       volatility          = EXCLUDED.volatility,
       ttr                 = EXCLUDED.ttr,
       data_quality        = EXCLUDED.data_quality,
       type_expected_value = EXCLUDED.type_expected_value,
       n_trades            = EXCLUDED.n_trades,
       n_trials            = EXCLUDED.n_trials,
       best_value          = EXCLUDED.best_value,
       updated_at          = NOW()`,
    [marketType, weights.tradeability, weights.liquidity, weights.volatility,
     weights.ttr, weights.dataQuality, weights.typeExpectedValue,
     meta.nTrades, meta.nTrials, meta.bestValue],
  );
}

function runRandomSearch(trades: ClosedTrade[]): { weights: ScorerWeights; bestValue: number } {
  let bestValue = -Infinity;
  let bestWeights: ScorerWeights = { ...WEIGHTS };
  for (let i = 0; i < N_TRIALS; i++) {
    const candidate = randomWeights();
    const value = computeObjective(candidate, trades);
    if (value > bestValue) {
      bestValue = value;
      bestWeights = candidate;
    }
  }
  // Normalize the 4 optimized dims (tradeability, liquidity, ttr, typeExpectedValue)
  // to sum to (1 - volatility - dataQuality) so loadWeights doesn't warn.
  const optimizableSum = bestWeights.tradeability + bestWeights.liquidity +
                         bestWeights.ttr + bestWeights.typeExpectedValue;
  const targetSum = 1 - WEIGHTS.volatility - WEIGHTS.dataQuality;
  if (optimizableSum > 0) {
    const scale = targetSum / optimizableSum;
    bestWeights = {
      ...bestWeights,
      tradeability:      bestWeights.tradeability      * scale,
      liquidity:         bestWeights.liquidity         * scale,
      ttr:               bestWeights.ttr               * scale,
      typeExpectedValue: bestWeights.typeExpectedValue * scale,
    };
  }
  return { weights: bestWeights, bestValue };
}

export async function optimizeScorerWeights(): Promise<void> {
  const knownTypesRes = await query<{ market_type: string }>(
    `SELECT DISTINCT market_type FROM markets WHERE market_type IS NOT NULL`,
  );

  for (const { market_type } of knownTypesRes.rows) {
    const trades = await loadClosedTrades(market_type);
    logger.info({ marketType: market_type, n: trades.length }, 'Loaded trades for type');
    if (trades.length < MIN_TRADES) {
      logger.info({ marketType: market_type, n: trades.length, required: MIN_TRADES },
        'Insufficient trades — skipping type');
      continue;
    }
    const { weights, bestValue } = runRandomSearch(trades);
    await saveWeights(weights, market_type,
      { nTrades: trades.length, nTrials: N_TRIALS, bestValue });
    logger.info({ marketType: market_type, bestValue, weights }, 'Type optimization complete');
  }

  // Always refresh the global ('__global__') row from pooled data
  const globalTrades = await loadClosedTrades(null);
  if (globalTrades.length >= MIN_TRADES) {
    const { weights, bestValue } = runRandomSearch(globalTrades);
    await saveWeights(weights, GLOBAL_MARKET_TYPE,
      { nTrades: globalTrades.length, nTrials: N_TRIALS, bestValue });
    logger.info({ bestValue, weights }, 'Global optimization complete');
  }
}
```

Update `randomWeights()` to sample `typeExpectedValue` too:

```typescript
function randomWeights(): ScorerWeights {
  const r = () => Math.random() * 0.6 + 0.05;
  return {
    tradeability:      r(),
    liquidity:         r(),
    volatility:        WEIGHTS.volatility,
    ttr:               r(),
    dataQuality:       WEIGHTS.dataQuality,
    typeExpectedValue: r(),   // NEW
  };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run packages/data-collector/src/services/ScorerWeightOptimizer.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: all tests PASS (2 new + existing).

- [ ] **Step 5: Commit**

```bash
git add packages/data-collector/src/services/ScorerWeightOptimizer.ts packages/data-collector/src/services/ScorerWeightOptimizer.test.ts
git commit -m "feat(optimizer): train scorer_weights per market type

optimizeScorerWeights() now loops over distinct market_types from the
markets table. Each type with >= MIN_TRADES post-reset trades gets an
UPSERT into scorer_weights (ON CONFLICT market_type). The global
('__global__') row is always refreshed from the pooled dataset.
loadClosedTrades filters by jsonb 'typeExpectedValue' key so pre-backfill
trades (without the feature) are naturally excluded."
```

---

## Task 11: Historical backfill of `typeExpectedValue` on post-reset trades

**Files:**
- Modify: `packages/dashboard/src/server.ts` (startup block that already has ALTER TABLE migrations)

- [ ] **Step 1: Write the backfill query as a startup task**

In `server.ts`, alongside the Task 4 ALTER TABLE block, add the backfill UPDATE. Guard against re-running unnecessarily by checking whether any post-reset trade is missing the field:

```typescript
      // One-shot backfill: add typeExpectedValue to score_dimensions_at_entry for
      // post-reset trades. Idempotent — running twice overwrites with the current
      // value (cheap) but the outer EXISTS check skips re-running when there is
      // nothing left to do.
      const missing = await query<{ n: string }>(`
        SELECT COUNT(*) as n FROM paper_positions pp
        WHERE pp.closed_at IS NOT NULL
          AND pp.score_dimensions_at_entry IS NOT NULL
          AND NOT (pp.score_dimensions_at_entry ? 'typeExpectedValue')
          AND pp.closed_at >= (SELECT last_reset_at FROM paper_account ORDER BY id LIMIT 1)
      `);
      if (Number(missing.rows[0]?.n ?? 0) > 0) {
        console.log(`Backfilling typeExpectedValue for ${missing.rows[0].n} trades...`);
        await query(`
          UPDATE paper_positions pp
          SET score_dimensions_at_entry = score_dimensions_at_entry ||
            jsonb_build_object('typeExpectedValue',
              CASE
                WHEN cp.n_trades IS NULL OR cp.n_trades < 5 OR cp.sharpe_ratio IS NULL THEN 0.5
                ELSE GREATEST(0.0, LEAST(1.0,
                  ((cp.sharpe_ratio * cp.n_trades / (cp.n_trades + 20.0)) + 1.0) / 1.5
                ))
              END
            )
          FROM markets m
          LEFT JOIN category_performance cp ON cp.market_type = m.market_type
          WHERE m.id = pp.market_id
            AND pp.closed_at IS NOT NULL
            AND pp.score_dimensions_at_entry IS NOT NULL
            AND NOT (pp.score_dimensions_at_entry ? 'typeExpectedValue')
            AND pp.closed_at >= (SELECT last_reset_at FROM paper_account ORDER BY id LIMIT 1)
        `);
        console.log('Backfill complete');
      } else {
        console.log('typeExpectedValue backfill not needed');
      }
```

- [ ] **Step 2: Commit (no test — integration verified at deploy)**

```bash
git add packages/dashboard/src/server.ts
git commit -m "feat(scorer): backfill typeExpectedValue on post-reset trades

Idempotent one-shot UPDATE at dashboard startup adds the
typeExpectedValue key to score_dimensions_at_entry for ~1829 post-reset
trades with the new feature missing. Formula mirrors runtime semantics
bit-for-bit (0.5 neutral when n_trades < 5 or sharpe is null). Guarded
by a COUNT(*) check so second startup is cheap."
```

---

## Task 12: Manual trigger script

**Files:**
- Create: `scripts/trigger-scorer-optimization.ts`

- [ ] **Step 1: Create the script**

Write `scripts/trigger-scorer-optimization.ts`:

```typescript
#!/usr/bin/env tsx
/**
 * One-shot: run ScorerWeightOptimizer immediately, bypassing the weekly cron.
 * Usage:
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 DATABASE_URL='postgres://...' \
 *     tsx scripts/trigger-scorer-optimization.ts
 */
import 'dotenv/config';
import { optimizeScorerWeights } from '../packages/data-collector/src/services/ScorerWeightOptimizer.js';
import { initializeDatabase, closeDatabase } from '../packages/data-collector/src/database/connection.js';

async function main() {
  await initializeDatabase();
  console.log('Running optimizeScorerWeights...');
  await optimizeScorerWeights();
  console.log('Done.');
  await closeDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

(If the data-collector package doesn't export `closeDatabase`, adjust to whatever the existing script patterns use.)

- [ ] **Step 2: Verify script syntax**

Run: `npx tsc --noEmit scripts/trigger-scorer-optimization.ts 2>&1 | tail -5`
Expected: no type errors. If module resolution fails due to `.js` extension in TS-only context, adjust to match the existing convention in other scripts in `scripts/`.

- [ ] **Step 3: Commit**

```bash
git add scripts/trigger-scorer-optimization.ts
git commit -m "tools: script to trigger ScorerWeightOptimizer on demand

Avoids waiting until next Monday 03:17 UTC for the first post-deploy
per-type training pass. Invoked via tsx against the VM DB URL."
```

---

## Task 13: Deploy + verification checklist

- [ ] **Step 1: Merge to main via PR**

Open PR, describe the changes, reference design + roadmap. On merge, CI builds + deploys data-collector and dashboard images.

- [ ] **Step 2: Confirm deploy landed**

```bash
rtk gh run list --workflow=deploy-gcp.yml --limit=1
gcloud compute ssh polymarket-vm --zone=us-east1-b --command "cd /home/Usuario/polymarket-trader && git log --oneline -1"
```

Expected: run succeeded, VM HEAD matches the merged commit.

- [ ] **Step 3: Verify schema migrations applied**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command 'docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c "\d scorer_weights"'
```

Expected: `market_type VARCHAR(32) NOT NULL DEFAULT '__global__'` and `type_expected_value FLOAT NOT NULL DEFAULT 0` present; UNIQUE constraint `uniq_scorer_weights_market_type` listed.

- [ ] **Step 4: Verify backfill ran**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command 'docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c "SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE score_dimensions_at_entry ? '"'"'typeExpectedValue'"'"') AS with_feature FROM paper_positions WHERE closed_at IS NOT NULL AND score_dimensions_at_entry IS NOT NULL AND closed_at >= (SELECT last_reset_at FROM paper_account ORDER BY id LIMIT 1);"'
```

Expected: `with_feature` equals `total` (~1829).

- [ ] **Step 5: Trigger optimizer manually**

On the VM:

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command \
  "cd /home/Usuario/polymarket-trader && NODE_TLS_REJECT_UNAUTHORIZED=0 npx tsx scripts/trigger-scorer-optimization.ts"
```

Expected: logs show per-type optimization for event_long / event_short / event_financial, global row also refreshed, no errors.

- [ ] **Step 6: Verify `scorer_weights` has per-type rows**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command \
  'docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c "SELECT market_type, n_trades, ROUND(best_value::numeric, 4) as best, updated_at FROM scorer_weights ORDER BY market_type;"'
```

Expected: at least 4 rows: `__global__`, `event_financial`, `event_long`, `event_short`. crypto_daily and crypto_intraday skipped (n < 30).

- [ ] **Step 7: Re-run Pearson analysis**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command \
  'docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c "WITH t AS (SELECT pp.market_score_at_entry AS s, pp.realized_pnl AS pnl, m.market_type FROM paper_positions pp JOIN markets m ON m.id = pp.market_id WHERE pp.closed_at IS NOT NULL AND pp.market_score_at_entry IS NOT NULL AND pp.realized_pnl IS NOT NULL) SELECT COALESCE(market_type, '"'"'NULL'"'"') AS type, COUNT(*) as n, ROUND(CORR(s, pnl)::numeric, 4) as pearson FROM t GROUP BY market_type ORDER BY n DESC;"'
```

Note: the global Pearson above is against `market_score_at_entry`, which predates this change. Real gate is measured on trades opened AFTER the deploy. Run again at T+2w and T+30d for the success gate.

- [ ] **Step 8: Verify rotator pool composition starts shifting within 24h**

After 24h since deploy, run:

```sql
SELECT market_type, tracking_status, COUNT(*)
FROM markets
WHERE tracking_status IN ('warming', 'active', 'cooling')
GROUP BY market_type, tracking_status
ORDER BY market_type;
```

Expected: non-zero count for at least one non-event_long type (event_financial or crypto_intraday). If after 7 days the pool still shows >90% event_long, revisit the tradability interpretation and consider the quota design from the earlier brainstorm as fallback.

---

## Self-Review Checklist

After all tasks are complete, verify:

- [ ] **Spec coverage**: each bullet under "Design details" in the spec maps to at least one Task:
  - `typeExpectedValue` dimension → Tasks 1, 2, 3 ✓
  - Schema migration (market_type, type_expected_value, UNIQUE) → Task 4 ✓
  - Historical backfill → Task 11 ✓
  - MarketScorer type changes → Task 1 ✓
  - `loadCategoryMetrics`, `loadWeights(type)`, cache → Tasks 5, 6 ✓
  - Pass 1 per-type UPDATEs → Task 7 ✓
  - Pass 2 per-type weights → Task 8 ✓
  - `EnrichUpdate` + `market_score_history` → Task 8 ✓
  - `AutoSignalExecutor` captures new dim at open → Task 9 ✓
  - `ScorerWeightOptimizer` per-type loop → Task 10 ✓
  - Manual trigger script → Task 12 ✓
  - Deploy verification → Task 13 ✓

- [ ] **Rollback**: Task 13 does not destroy the ability to roll back. The rollback sequence in the spec (DELETE WHERE market_type != '__global__'; optional UPDATE type_expected_value=0) works against the deployed schema.

- [ ] **Tests are real**: each task has tests that assert the specific behavior changed, not mock mechanics.

- [ ] **No placeholders**: the plan has `<tradeability CASE>`-style markers in Task 7 step 3; those are pointers to copy existing SQL verbatim from MarketScorer.ts. Not placeholder content to be invented — the engineer copies the real CASE expressions. Tolerable.
