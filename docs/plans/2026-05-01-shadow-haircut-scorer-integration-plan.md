# Shadow Haircut Scorer Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `shadowExpectedValue` dimension (weight 0.05) to `MarketScorer` fed by a new `category_performance_shadow` table, computed from `shadow_trades` resolved with empirical haircut 0.33. Live `category_performance` and `typeExpectedValue` remain untouched (purely additive).

**Architecture:** Two parallel writers in `computeMarketPriors()`: existing `updateCategoryPriors` (live) + new `updateShadowCategoryPerformance` (shadow with haircut applied). MarketScorer loads both per-type metric maps and contributes them to the composite score. All other dimensions are rescaled by `0.95` so weights still sum to 1.0.

**Tech Stack:** TypeScript + Vitest, pnpm monorepo. PostgreSQL/TimescaleDB. Spec: `docs/plans/2026-05-01-shadow-haircut-scorer-integration-design.md`.

---

## File Structure

| Path | Change | Responsibility |
|---|---|---|
| `packages/data-collector/src/database/init/029_category_performance_shadow.sql` | Create | Idempotent `CREATE TABLE IF NOT EXISTS` for new table |
| `packages/dashboard/src/services/bootstrapShadowCategoryPerformance.ts` | Create | Runtime startup helper that runs the same `CREATE TABLE IF NOT EXISTS` so existing VM volumes get the new table without re-init |
| `packages/dashboard/src/services/bootstrapShadowCategoryPerformance.test.ts` | Create | Unit test for the SQL string |
| `packages/dashboard/src/server.ts` | Modify (alongside other startup hooks) | Wire the new bootstrap call inside the existing `if (dbHealth.connected)` block |
| `packages/data-collector/src/services/MarketScorer.ts` | Modify | New `shadowExpectedValue` static method; `WEIGHTS` rescaled (×0.95 for the 7 existing, +0.05 for shadow); `ScoreDimensions` interface extended; `compositeScore` adds the new dimension; `loadCategoryMetrics` replaced by `loadAllCategoryMetrics` returning both maps; `scoreAllMarkets` passes shadow EV through both passes; `loadWeights` includes shadowExpectedValue in returned ScorerWeights |
| `packages/data-collector/src/services/MarketScorer.test.ts` | Modify | New tests for `shadowExpectedValue`, `WEIGHTS` total = 1.0, two-source `compositeScore` |
| `packages/data-collector/src/services/MarketPerformanceTracker.ts` | Modify | New exported function `updateShadowCategoryPerformance()`. `updateCategoryPriors()` is **untouched** |
| `packages/data-collector/src/services/MarketPerformanceTracker.test.ts` | Modify | New tests for `updateShadowCategoryPerformance` (haircut applied, env override, MIN_N gate) |
| `packages/data-collector/src/services/Scheduler.ts` | Modify | Inside `computeMarketPriors()`, add `await updateShadowCategoryPerformance()` after the existing `updateCategoryPriors()` call |
| `scripts/daily-review-prompt.md` | Modify | Append a "Shadow haircut validation" section that explains the implied-haircut query and the alert thresholds |

No DB migrations beyond the new table. No env vars in docker-compose changed by default. `SHADOW_HAIRCUT` and `CATEGORY_MIN_SHADOW_N` are env-tunable but use defaults.

---

### Task 1: Migration 029 + runtime bootstrap helper

**Files:**
- Create: `packages/data-collector/src/database/init/029_category_performance_shadow.sql`
- Create: `packages/dashboard/src/services/bootstrapShadowCategoryPerformance.ts`
- Create: `packages/dashboard/src/services/bootstrapShadowCategoryPerformance.test.ts`

- [ ] **Step 1: Write the migration**

Create `packages/data-collector/src/database/init/029_category_performance_shadow.sql` with this exact content:

```sql
-- Mirrors category_performance schema but stores shadow-derived metrics with
-- an applied haircut. See docs/plans/2026-05-01-shadow-haircut-scorer-integration-design.md.

CREATE TABLE IF NOT EXISTS category_performance_shadow (
  market_type     VARCHAR(20)  PRIMARY KEY,
  win_rate        DOUBLE PRECISION,
  avg_pnl         DOUBLE PRECISION,
  sharpe_ratio    DOUBLE PRECISION,
  n_trades        INTEGER NOT NULL DEFAULT 0,
  prior           DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  haircut_applied DOUBLE PRECISION NOT NULL DEFAULT 0.33,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
```

- [ ] **Step 2: Write failing test for bootstrap helper**

Create `packages/dashboard/src/services/bootstrapShadowCategoryPerformance.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../database/index.js', () => ({
  query: vi.fn(),
}));

import { query } from '../database/index.js';
import { bootstrapShadowCategoryPerformanceTable } from './bootstrapShadowCategoryPerformance.js';

describe('bootstrapShadowCategoryPerformanceTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('issues a CREATE TABLE IF NOT EXISTS for category_performance_shadow', async () => {
    (query as any).mockResolvedValueOnce({ rows: [] });
    await bootstrapShadowCategoryPerformanceTable();
    expect(query).toHaveBeenCalledTimes(1);
    const sql = (query as any).mock.calls[0][0] as string;
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS category_performance_shadow/);
    expect(sql).toMatch(/PRIMARY KEY/);
    expect(sql).toMatch(/haircut_applied DOUBLE PRECISION NOT NULL DEFAULT 0\.33/);
    expect(sql).toMatch(/sharpe_ratio DOUBLE PRECISION/);
  });
});
```

- [ ] **Step 3: Run test, verify it FAILS**

```bash
cd packages/dashboard
pnpm test bootstrapShadowCategoryPerformance.test.ts
```

Expected: FAIL — module `./bootstrapShadowCategoryPerformance.js` not found.

- [ ] **Step 4: Implement the helper**

Create `packages/dashboard/src/services/bootstrapShadowCategoryPerformance.ts`:

```typescript
import { query } from '../database/index.js';

/**
 * Idempotent runtime creation of the category_performance_shadow table.
 *
 * init/029_category_performance_shadow.sql only fires on first volume
 * creation. Production deployments need this helper at startup so the
 * table appears without a database wipe. Mirrors the PR #163 pattern
 * for bootstrapDirectionMultiplierRows.
 */
export async function bootstrapShadowCategoryPerformanceTable(): Promise<void> {
  await query(
    `CREATE TABLE IF NOT EXISTS category_performance_shadow (
       market_type     VARCHAR(20)  PRIMARY KEY,
       win_rate        DOUBLE PRECISION,
       avg_pnl         DOUBLE PRECISION,
       sharpe_ratio    DOUBLE PRECISION,
       n_trades        INTEGER NOT NULL DEFAULT 0,
       prior           DOUBLE PRECISION NOT NULL DEFAULT 1.0,
       haircut_applied DOUBLE PRECISION NOT NULL DEFAULT 0.33,
       updated_at      TIMESTAMPTZ DEFAULT NOW()
     )`,
  );
}
```

- [ ] **Step 5: Run test, verify it PASSES**

```bash
cd packages/dashboard
pnpm test bootstrapShadowCategoryPerformance.test.ts
```

Expected: 1 test passes.

- [ ] **Step 6: Type-check**

```bash
cd packages/dashboard
pnpm tsc --noEmit
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
rtk git add packages/data-collector/src/database/init/029_category_performance_shadow.sql \
            packages/dashboard/src/services/bootstrapShadowCategoryPerformance.ts \
            packages/dashboard/src/services/bootstrapShadowCategoryPerformance.test.ts
rtk git commit -m "feat(db): category_performance_shadow table + idempotent runtime bootstrap (029)"
```

---

### Task 2: Wire runtime bootstrap into server.ts startup

**Files:**
- Modify: `packages/dashboard/src/server.ts` (alongside `bootstrapDirectionMultiplierRows` call)

- [ ] **Step 1: Locate the existing bootstrap pattern**

```bash
rtk grep -n "bootstrapDirectionMultiplierRows" packages/dashboard/src/server.ts
```

Expected: matches around line 34 (import) and line ~430 (call inside the `if (dbHealth.connected)` block).

- [ ] **Step 2: Add import**

In `packages/dashboard/src/server.ts`, add the import next to the existing `bootstrapDirectionMultiplierRows` import:

```typescript
import { bootstrapShadowCategoryPerformanceTable } from './services/bootstrapShadowCategoryPerformance.js';
```

- [ ] **Step 3: Add the bootstrap call**

In the same file, locate the `try { await bootstrapDirectionMultiplierRows(); ...` block. Immediately after that block (still inside the `if (dbHealth.connected)` gate), add:

```typescript
try {
  await bootstrapShadowCategoryPerformanceTable();
  console.log('[server] category_performance_shadow table ensured');
} catch (err) {
  console.error('[server] Failed to bootstrap category_performance_shadow:', err);
}
```

- [ ] **Step 4: Type-check**

```bash
cd packages/dashboard
pnpm tsc --noEmit
```

Expected: clean.

- [ ] **Step 5: Run all dashboard tests**

```bash
cd packages/dashboard
pnpm test
```

Expected: all tests pass; baseline +1 from Task 1.

- [ ] **Step 6: Commit**

```bash
rtk git add packages/dashboard/src/server.ts
rtk git commit -m "feat(server): wire bootstrapShadowCategoryPerformanceTable into startup"
```

---

### Task 3: `MarketScorer.shadowExpectedValue` static method

**Files:**
- Modify: `packages/data-collector/src/services/MarketScorer.ts` (add method, update `ScoreDimensions` interface)
- Modify: `packages/data-collector/src/services/MarketScorer.test.ts` (add tests)

- [ ] **Step 1: Write failing tests**

Append to `packages/data-collector/src/services/MarketScorer.test.ts`:

```typescript
describe('MarketScorer.shadowExpectedValue', () => {
  it('returns 0.5 (neutral) when sharpe is null', () => {
    expect(MarketScorer.shadowExpectedValue(null, 100)).toBe(0.5);
  });

  it('returns 0.5 (neutral) when nTrades < MIN_N (5)', () => {
    expect(MarketScorer.shadowExpectedValue(0.7, 4)).toBe(0.5);
    expect(MarketScorer.shadowExpectedValue(0.7, 5)).not.toBe(0.5);
  });

  it('mirrors typeExpectedValue formula for the same inputs', () => {
    // Identical shrinkage and mapping: expect identical output.
    const sharpe = 0.5;
    const n = 100;
    expect(MarketScorer.shadowExpectedValue(sharpe, n))
      .toBeCloseTo(MarketScorer.typeExpectedValue(sharpe, n), 6);
  });

  it('clamps to [0, 1]', () => {
    expect(MarketScorer.shadowExpectedValue(10, 100)).toBe(1);
    expect(MarketScorer.shadowExpectedValue(-10, 100)).toBe(0);
  });

  it('honors K override', () => {
    const sharpe = 0.5;
    const n = 100;
    const default_K = MarketScorer.shadowExpectedValue(sharpe, n);
    const high_K = MarketScorer.shadowExpectedValue(sharpe, n, 1000);
    // Higher K shrinks more aggressively → output closer to 0.5.
    expect(Math.abs(high_K - 0.5)).toBeLessThan(Math.abs(default_K - 0.5));
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
cd packages/data-collector
pnpm test MarketScorer.test.ts -- -t "shadowExpectedValue"
```

Expected: 5 tests fail — `MarketScorer.shadowExpectedValue is not a function`.

- [ ] **Step 3: Add method to MarketScorer.ts**

In `packages/data-collector/src/services/MarketScorer.ts`, immediately after the existing `typeExpectedValue` static method (~line 210), add:

```typescript
/**
 * Shadow Expected Value dimension.
 *
 * Reads the haircut-adjusted shadow Sharpe (effectiveSharpe = raw_shadow_Sharpe × SHADOW_HAIRCUT,
 * applied by the writer in MarketPerformanceTracker.updateShadowCategoryPerformance).
 * Returns 0.5 (neutral) when shadow data is insufficient (sharpe null or n_trades below MIN_N).
 *
 * Identical formula to typeExpectedValue — the only difference is the data source. Reusing the
 * same shrinkage and clamp mapping keeps both dimensions on a comparable [0, 1] scale, so the
 * weighted sum in compositeScore behaves predictably.
 */
static shadowExpectedValue(
  effectiveSharpe: number | null,
  nTrades: number,
  K: number = SCORER_SHRINKAGE_K,
  MIN_N: number = 5,
): number {
  if (!Number.isFinite(K)) K = SCORER_SHRINKAGE_K;
  if (effectiveSharpe === null || nTrades < MIN_N) return 0.5;
  const shrunk = (effectiveSharpe * nTrades) / (nTrades + K);
  return clamp01((shrunk + 1) / 1.5);
}
```

- [ ] **Step 4: Extend `ScoreDimensions` interface**

In the same file (~line 27), update the interface:

```typescript
export interface ScoreDimensions {
  tradeability: number;
  liquidity: number;
  volatility: number | null;
  ttr: number;
  dataQuality: number | null;
  typeExpectedValue: number;
  realizedVolatility: number | null;
  shadowExpectedValue: number;       // NEW — always present (0.5 neutral default)
}
```

- [ ] **Step 5: Run tests, verify PASS**

```bash
cd packages/data-collector
pnpm test MarketScorer.test.ts -- -t "shadowExpectedValue"
```

Expected: 5 tests pass. tsc still clean (run `pnpm tsc --noEmit` to confirm).

- [ ] **Step 6: Commit**

```bash
rtk git add packages/data-collector/src/services/MarketScorer.ts \
            packages/data-collector/src/services/MarketScorer.test.ts
rtk git commit -m "feat(scorer): add shadowExpectedValue static method + ScoreDimensions field"
```

---

### Task 4: Rescale `WEIGHTS` and add `shadowExpectedValue: 0.05`

**Files:**
- Modify: `packages/data-collector/src/services/MarketScorer.ts` (`WEIGHTS` constant, `ScorerWeights` interface)
- Modify: `packages/data-collector/src/services/MarketScorer.test.ts` (weights invariant test, update existing tests that reference WEIGHTS values)

- [ ] **Step 1: Write failing weights-invariant test**

Append to `packages/data-collector/src/services/MarketScorer.test.ts`:

```typescript
describe('MarketScorer.WEIGHTS', () => {
  it('all weight values sum to 1.0 (within float tolerance)', () => {
    const total = Object.values(WEIGHTS).reduce((sum, w) => sum + w, 0);
    expect(total).toBeCloseTo(1.0, 6);
  });

  it('shadowExpectedValue weight is 0.05', () => {
    expect(WEIGHTS.shadowExpectedValue).toBe(0.05);
  });

  it('typeExpectedValue weight is 0.1615 (rescaled from 0.17 by 0.95)', () => {
    expect(WEIGHTS.typeExpectedValue).toBeCloseTo(0.1615, 6);
  });
});
```

You will need to import `WEIGHTS` at the top of the test file if it's not already imported:

```typescript
import { MarketScorer, WEIGHTS } from './MarketScorer.js';
```

- [ ] **Step 2: Run, verify FAIL**

```bash
cd packages/data-collector
pnpm test MarketScorer.test.ts -- -t "WEIGHTS"
```

Expected: at least the "shadowExpectedValue weight is 0.05" test fails because `WEIGHTS.shadowExpectedValue` is undefined; the sum test currently passes because old WEIGHTS sum to 1.0 already.

- [ ] **Step 3: Update `WEIGHTS` constant**

In `packages/data-collector/src/services/MarketScorer.ts` (~line 7), replace the `WEIGHTS` object with:

```typescript
export const WEIGHTS = {
  tradeability:        0.1995,  // 0.21 × 0.95
  liquidity:           0.1615,  // 0.17 × 0.95
  volatility:          0.1425,  // 0.15 × 0.95
  ttr:                 0.0760,  // 0.08 × 0.95
  dataQuality:         0.0950,  // 0.10 × 0.95
  typeExpectedValue:   0.1615,  // 0.17 × 0.95
  realizedVolatility:  0.1140,  // 0.12 × 0.95
  shadowExpectedValue: 0.0500,  // NEW
} as const;
// Total: 1.0000
```

- [ ] **Step 4: Update `ScorerWeights` interface**

In the same file (~line 37), add the field to the interface:

```typescript
export interface ScorerWeights {
  tradeability: number;
  liquidity: number;
  volatility: number;
  ttr: number;
  dataQuality: number;
  typeExpectedValue: number;
  realizedVolatility: number;
  shadowExpectedValue: number;     // NEW
}
```

- [ ] **Step 5: Update `loadWeights` fallback**

Still in the same file (~line 343, the `weights = row ? { ... } : { ...WEIGHTS }` block), the per-type DB rows do NOT have a `shadow_expected_value` column. Add the field with a fallback to the WEIGHTS default in BOTH branches of the ternary. The branch that constructs from `row` becomes:

```typescript
weights = row
  ? {
      tradeability:        Number(row.tradeability),
      liquidity:           Number(row.liquidity),
      volatility:          Number(row.volatility),
      ttr:                 Number(row.ttr),
      dataQuality:         Number(row.data_quality),
      typeExpectedValue:   row.type_expected_value !== null
        ? Number(row.type_expected_value)
        : WEIGHTS.typeExpectedValue,
      realizedVolatility:  row.realized_volatility !== null
        ? Number(row.realized_volatility)
        : WEIGHTS.realizedVolatility,
      shadowExpectedValue: WEIGHTS.shadowExpectedValue,  // NEW — always WEIGHTS default; per-type DB override out of scope
    }
  : { ...WEIGHTS };
```

(The `else` branch `{ ...WEIGHTS }` already includes shadowExpectedValue once the `WEIGHTS` constant is updated.)

- [ ] **Step 6: Run all MarketScorer tests**

```bash
cd packages/data-collector
pnpm test MarketScorer.test.ts
```

Expected: all WEIGHTS tests pass; existing tests should also pass — they don't assert specific weight values directly, they verify behavioural outputs of `compositeScore` and the per-dimension methods. If any existing test asserts a specific WEIGHTS value (e.g. `WEIGHTS.tradeability === 0.21`), update it to the rescaled value (`0.1995`) or to be agnostic of the absolute value.

- [ ] **Step 7: Type-check**

```bash
cd packages/data-collector
pnpm tsc --noEmit
```

Expected: clean. Any tsc error here likely means a downstream consumer destructures `ScorerWeights` and is missing the new field — fix by adding it.

- [ ] **Step 8: Commit**

```bash
rtk git add packages/data-collector/src/services/MarketScorer.ts \
            packages/data-collector/src/services/MarketScorer.test.ts
rtk git commit -m "feat(scorer): rescale WEIGHTS + add shadowExpectedValue=0.05; loadWeights fallback"
```

---

### Task 5: `compositeScore` integrates `shadowExpectedValue` dimension

**Files:**
- Modify: `packages/data-collector/src/services/MarketScorer.ts` (`compositeScore` method)
- Modify: `packages/data-collector/src/services/MarketScorer.test.ts`

- [ ] **Step 1: Write failing test for compositeScore with shadow dim**

Append to `packages/data-collector/src/services/MarketScorer.test.ts`:

```typescript
describe('MarketScorer.compositeScore — shadowExpectedValue integration', () => {
  // All other dims at neutral 0.5 to isolate the shadow contribution.
  const neutralDims = {
    tradeability: 0.5,
    liquidity: 0.5,
    volatility: 0.5,
    ttr: 0.5,
    dataQuality: 0.5,
    typeExpectedValue: 0.5,
    realizedVolatility: 0.5,
  };

  it('shadowEV neutral (0.5) → composite is 0.5 (all dims neutral)', () => {
    const score = MarketScorer.compositeScore({
      ...neutralDims,
      shadowExpectedValue: 0.5,
    });
    expect(score).toBeCloseTo(0.5, 6);
  });

  it('shadowEV at 1.0 lifts composite by 0.025 (= 0.05 × 0.5)', () => {
    const score = MarketScorer.compositeScore({
      ...neutralDims,
      shadowExpectedValue: 1.0,
    });
    expect(score).toBeCloseTo(0.525, 6);
  });

  it('shadowEV at 0.0 drags composite by 0.025', () => {
    const score = MarketScorer.compositeScore({
      ...neutralDims,
      shadowExpectedValue: 0.0,
    });
    expect(score).toBeCloseTo(0.475, 6);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
cd packages/data-collector
pnpm test MarketScorer.test.ts -- -t "shadowExpectedValue integration"
```

Expected: 3 tests fail because `compositeScore` does not yet add `shadowExpectedValue` to the weighted sum.

- [ ] **Step 3: Add the dimension to `compositeScore`**

In `packages/data-collector/src/services/MarketScorer.ts`, in the `compositeScore` method (~line 238), find the `// Always-present dimensions` block and add `shadowExpectedValue` next to `typeExpectedValue`:

```typescript
// Always-present dimensions
weightedSum += dims.tradeability * weights.tradeability;
totalWeight += weights.tradeability;

weightedSum += dims.liquidity * weights.liquidity;
totalWeight += weights.liquidity;

weightedSum += dims.ttr * weights.ttr;
totalWeight += weights.ttr;

weightedSum += dims.typeExpectedValue * weights.typeExpectedValue;
totalWeight += weights.typeExpectedValue;

// NEW — shadowExpectedValue is always present (returns 0.5 neutral when missing data)
weightedSum += dims.shadowExpectedValue * weights.shadowExpectedValue;
totalWeight += weights.shadowExpectedValue;
```

- [ ] **Step 4: Run tests, verify PASS**

```bash
cd packages/data-collector
pnpm test MarketScorer.test.ts
```

Expected: 3 new tests pass + every existing test still passes. The full file (`pnpm test`) should also pass.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/data-collector/src/services/MarketScorer.ts \
            packages/data-collector/src/services/MarketScorer.test.ts
rtk git commit -m "feat(scorer): include shadowExpectedValue in compositeScore weighted sum"
```

---

### Task 6: `loadAllCategoryMetrics` replaces single-source loader

**Files:**
- Modify: `packages/data-collector/src/services/MarketScorer.ts` (replace `loadCategoryMetrics`, update callers)
- Modify: `packages/data-collector/src/services/MarketScorer.test.ts`

- [ ] **Step 1: Write failing test**

Append to `packages/data-collector/src/services/MarketScorer.test.ts` (after the other describes, before the closing of the file):

```typescript
import { query } from '../database/connection.js';
vi.mock('../database/connection.js', () => ({
  query: vi.fn(),
}));

describe('MarketScorer.loadAllCategoryMetrics', () => {
  beforeEach(() => {
    (query as any).mockReset();
  });

  it('returns parallel maps for live and shadow', async () => {
    (query as any)
      .mockResolvedValueOnce({  // live
        rows: [
          { market_type: 'event_short', sharpe_ratio: '0.13', n_trades: '419' },
          { market_type: 'event_long', sharpe_ratio: '0.17', n_trades: '1317' },
        ],
      })
      .mockResolvedValueOnce({  // shadow
        rows: [
          { market_type: 'event_short', sharpe_ratio: '0.67', n_trades: '444' },
        ],
      });

    const { live, shadow } = await MarketScorer.loadAllCategoryMetrics();

    expect(live.get('event_short')).toEqual({ sharpe: 0.13, n: 419 });
    expect(live.get('event_long')).toEqual({ sharpe: 0.17, n: 1317 });
    expect(shadow.get('event_short')).toEqual({ sharpe: 0.67, n: 444 });
    expect(shadow.size).toBe(1);
  });

  it('returns empty maps on DB error (graceful degradation)', async () => {
    (query as any).mockRejectedValueOnce(new Error('DB down'));
    const { live, shadow } = await MarketScorer.loadAllCategoryMetrics();
    expect(live.size).toBe(0);
    expect(shadow.size).toBe(0);
  });
});
```

If `vi.mock('../database/connection.js', ...)` is already declared at the top of the test file because of other tests, **don't** redeclare. Otherwise add it once at the top.

- [ ] **Step 2: Run, verify FAIL**

```bash
cd packages/data-collector
pnpm test MarketScorer.test.ts -- -t "loadAllCategoryMetrics"
```

Expected: 2 tests fail — `MarketScorer.loadAllCategoryMetrics is not a function`.

- [ ] **Step 3: Replace `loadCategoryMetrics` with `loadAllCategoryMetrics`**

In `packages/data-collector/src/services/MarketScorer.ts`, replace the existing `loadCategoryMetrics` static method (~line 361) with:

```typescript
/**
 * Load both live and shadow category metrics in parallel.
 * Returned numerics are coerced from pg strings.
 * Falls back to empty maps on any error (table missing, DB down, etc.).
 *
 * Live source: category_performance (existing).
 * Shadow source: category_performance_shadow (new in this PR; sharpe_ratio is
 * already haircut-adjusted by the writer).
 */
static async loadAllCategoryMetrics(): Promise<{
  live: Map<string, { sharpe: number | null; n: number }>;
  shadow: Map<string, { sharpe: number | null; n: number }>;
}> {
  const empty = {
    live: new Map<string, { sharpe: number | null; n: number }>(),
    shadow: new Map<string, { sharpe: number | null; n: number }>(),
  };
  try {
    const [liveResult, shadowResult] = await Promise.all([
      query<{ market_type: string; sharpe_ratio: number | string | null; n_trades: number | string }>(
        `SELECT market_type, sharpe_ratio, n_trades FROM category_performance`,
      ),
      query<{ market_type: string; sharpe_ratio: number | string | null; n_trades: number | string }>(
        `SELECT market_type, sharpe_ratio, n_trades FROM category_performance_shadow`,
      ),
    ]);
    const live = new Map<string, { sharpe: number | null; n: number }>();
    for (const r of liveResult.rows) {
      live.set(r.market_type, {
        sharpe: r.sharpe_ratio !== null ? Number(r.sharpe_ratio) : null,
        n: Number(r.n_trades),
      });
    }
    const shadow = new Map<string, { sharpe: number | null; n: number }>();
    for (const r of shadowResult.rows) {
      shadow.set(r.market_type, {
        sharpe: r.sharpe_ratio !== null ? Number(r.sharpe_ratio) : null,
        n: Number(r.n_trades),
      });
    }
    return { live, shadow };
  } catch {
    return empty;
  }
}
```

The old single-source `loadCategoryMetrics` is removed. The only caller is `scoreAllMarkets`, updated in Task 7.

- [ ] **Step 4: Run tests, verify PASS**

```bash
cd packages/data-collector
pnpm test MarketScorer.test.ts -- -t "loadAllCategoryMetrics"
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/data-collector/src/services/MarketScorer.ts \
            packages/data-collector/src/services/MarketScorer.test.ts
rtk git commit -m "feat(scorer): replace loadCategoryMetrics with loadAllCategoryMetrics (live + shadow)"
```

---

### Task 7: `scoreAllMarkets` integration — pass shadowEV through both passes

**Files:**
- Modify: `packages/data-collector/src/services/MarketScorer.ts` (`scoreAllMarkets`, both passes' dimension construction)

- [ ] **Step 1: Update Pass 1 (cold candidates per-type loop)**

In `packages/data-collector/src/services/MarketScorer.ts`, replace the `const categoryMetrics = await MarketScorer.loadCategoryMetrics();` line (~line 407) with:

```typescript
const { live: liveMetrics, shadow: shadowMetrics } = await MarketScorer.loadAllCategoryMetrics();
```

Then, inside the per-type loop where `metrics = categoryMetrics.get(marketType)` was used to compute `typeEV`, replace with:

```typescript
const liveRow = liveMetrics.get(marketType);
const shadowRow = shadowMetrics.get(marketType);
const typeEV = MarketScorer.typeExpectedValue(
  liveRow?.sharpe ?? null,
  liveRow?.n ?? 0,
);
const shadowEV = MarketScorer.shadowExpectedValue(
  shadowRow?.sharpe ?? null,
  shadowRow?.n ?? 0,
);
```

In the inner `rows.map((row) => { ... })` block where the `compositeScore` is called and the `EnrichUpdate` is constructed, add `shadowExpectedValue: shadowEV` to BOTH the `compositeScore` argument and the returned `EnrichUpdate` object:

```typescript
const score = MarketScorer.compositeScore({
  tradeability,
  liquidity,
  volatility: null,
  ttr,
  dataQuality: null,
  typeExpectedValue: typeEV,
  realizedVolatility,
  shadowExpectedValue: shadowEV,  // NEW
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
```

The `EnrichUpdate` interface should also be extended (see Step 3).

- [ ] **Step 2: Update Pass 2 (enrich tracked markets)**

Find the second invocation of `MarketScorer.typeExpectedValue` (~line 609) and apply the same pattern: read `shadowMetrics`, compute `shadowEV`, pass into `compositeScore` and `EnrichUpdate`. Same code shape as Step 1, just inside the Pass 2 block.

In the same loop's null-marketType fallback (where `categoryMetrics.get(null)` would have returned undefined), use `shadowEV = MarketScorer.shadowExpectedValue(null, 0)` (returns 0.5 neutral).

- [ ] **Step 3: Extend `EnrichUpdate` interface**

In the same file (~line 47), update the interface:

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
  realizedVolatility: number | null;
  shadowExpectedValue: number;       // NEW
  currentPriceYes: number | null;
  volume24h: number | null;
  marketType: string | null;
}
```

- [ ] **Step 4: Update `batchUpdateScores` and `batchUpdateScoresForType` if they reference the dim**

```bash
rtk grep -n "shadowExpectedValue\|typeExpectedValue" packages/data-collector/src/services/MarketScorer.ts | tail -20
```

The `batchUpdateScores` SQL writes a `score_dimensions` JSON blob (probably) or persists individual dim columns. If it persists individual columns (`type_expected_value`, etc.) into `markets` or `score_history`, the spec acknowledges this is **not part of this plan** — `shadowExpectedValue` is an in-memory dim only, not persisted as a markets column. The composite `score` already incorporates it via Step 1/2.

If you find that `batchUpdateScores*` references `dim.shadowExpectedValue` and tries to persist it to a column that doesn't exist, leave the persistence path unchanged (don't add a new markets column for shadowEV). Just ensure that the dim flows through `compositeScore` correctly, which is what we tested in Task 5.

- [ ] **Step 5: Type-check**

```bash
cd packages/data-collector
pnpm tsc --noEmit
```

Expected: clean.

- [ ] **Step 6: Run full MarketScorer tests**

```bash
cd packages/data-collector
pnpm test MarketScorer.test.ts
```

Expected: all tests pass (tests added in Tasks 3-6 plus existing ones).

- [ ] **Step 7: Commit**

```bash
rtk git add packages/data-collector/src/services/MarketScorer.ts
rtk git commit -m "feat(scorer): wire shadowExpectedValue through scoreAllMarkets passes 1 and 2"
```

---

### Task 8: `MarketPerformanceTracker.updateShadowCategoryPerformance` writer

**Files:**
- Modify: `packages/data-collector/src/services/MarketPerformanceTracker.ts`
- Modify: `packages/data-collector/src/services/MarketPerformanceTracker.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/data-collector/src/services/MarketPerformanceTracker.test.ts`:

```typescript
import { vi, beforeEach, afterEach } from 'vitest';

vi.mock('../database/connection.js', () => ({
  query: vi.fn(),
}));

import { query } from '../database/connection.js';
import { updateShadowCategoryPerformance } from './MarketPerformanceTracker.js';

describe('updateShadowCategoryPerformance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SHADOW_HAIRCUT;
    delete process.env.CATEGORY_MIN_SHADOW_N;
  });
  afterEach(() => {
    delete process.env.SHADOW_HAIRCUT;
    delete process.env.CATEGORY_MIN_SHADOW_N;
  });

  it('applies default haircut 0.33 to raw shadow Sharpe before upsert', async () => {
    (query as any)
      .mockResolvedValueOnce({  // SELECT
        rows: [
          { market_type: 'event_short', n_trades: '444', win_rate: '0.5',
            avg_pnl: '383', raw_sharpe: '2.03' },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });  // INSERT … ON CONFLICT

    await updateShadowCategoryPerformance();

    // Two queries fired: SELECT + INSERT
    expect(query).toHaveBeenCalledTimes(2);
    const insertCall = (query as any).mock.calls[1];
    const insertSql = insertCall[0] as string;
    const insertParams = insertCall[1] as unknown[];
    expect(insertSql).toMatch(/INSERT INTO category_performance_shadow/);
    expect(insertSql).toMatch(/ON CONFLICT \(market_type\) DO UPDATE/);
    // The 4th param is the haircut-adjusted Sharpe (raw 2.03 * 0.33 = 0.6699).
    // Param order must be (market_type, win_rate, avg_pnl, sharpe_ratio, n_trades, prior, haircut_applied).
    expect(insertParams[0]).toBe('event_short');
    expect(insertParams[3]).toBeCloseTo(2.03 * 0.33, 4);
    expect(insertParams[4]).toBe(444);
    expect(insertParams[6]).toBeCloseTo(0.33, 4);  // haircut_applied
  });

  it('skips upsert when n_trades < CATEGORY_MIN_SHADOW_N (default 30)', async () => {
    (query as any).mockResolvedValueOnce({
      rows: [
        { market_type: 'crypto_intraday', n_trades: '20', win_rate: '0.5',
          avg_pnl: '5', raw_sharpe: '0.4' },
      ],
    });
    await updateShadowCategoryPerformance();
    // Only the SELECT fired; no INSERT.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('honors SHADOW_HAIRCUT env var override', async () => {
    process.env.SHADOW_HAIRCUT = '0.5';
    (query as any)
      .mockResolvedValueOnce({
        rows: [
          { market_type: 'event_short', n_trades: '444', win_rate: '0.5',
            avg_pnl: '383', raw_sharpe: '2.0' },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    await updateShadowCategoryPerformance();

    const insertCall = (query as any).mock.calls[1];
    const insertParams = insertCall[1] as unknown[];
    expect(insertParams[3]).toBeCloseTo(2.0 * 0.5, 4);   // sharpe_ratio = 1.0
    expect(insertParams[6]).toBeCloseTo(0.5, 4);          // haircut_applied
  });

  it('honors CATEGORY_MIN_SHADOW_N env var override', async () => {
    process.env.CATEGORY_MIN_SHADOW_N = '10';
    (query as any)
      .mockResolvedValueOnce({
        rows: [
          { market_type: 'event_short', n_trades: '15', win_rate: '0.5',
            avg_pnl: '50', raw_sharpe: '0.4' },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    await updateShadowCategoryPerformance();

    // With env override 10, n=15 passes — INSERT should fire.
    expect(query).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
cd packages/data-collector
pnpm test MarketPerformanceTracker.test.ts -- -t "updateShadowCategoryPerformance"
```

Expected: 4 tests fail because the function does not exist yet.

- [ ] **Step 3: Implement `updateShadowCategoryPerformance`**

In `packages/data-collector/src/services/MarketPerformanceTracker.ts`, append after the existing `updateCategoryPriors` and `resolveShadowTrades` exports (right before the file ends at line 102, or wherever the file structure suggests):

```typescript
export async function updateShadowCategoryPerformance(): Promise<void> {
  const haircut = parseFloat(process.env.SHADOW_HAIRCUT ?? '0.33');
  const minN = parseInt(process.env.CATEGORY_MIN_SHADOW_N ?? '30', 10);

  if (!Number.isFinite(haircut)) {
    logger.warn({ haircut: process.env.SHADOW_HAIRCUT }, 'Invalid SHADOW_HAIRCUT, falling back to 0.33');
  }
  const effectiveHaircut = Number.isFinite(haircut) ? haircut : 0.33;

  const result = await query<{
    market_type: string;
    n_trades: string;
    win_rate: string;
    avg_pnl: string;
    raw_sharpe: string;
  }>(`
    SELECT market_type,
           COUNT(*)::text AS n_trades,
           AVG(CASE WHEN theoretical_pnl > 0 THEN 1.0 ELSE 0.0 END)::text AS win_rate,
           AVG(theoretical_pnl)::text AS avg_pnl,
           CASE WHEN STDDEV(theoretical_pnl) > 0
                THEN (AVG(theoretical_pnl) / STDDEV(theoretical_pnl))::text
                ELSE '0' END AS raw_sharpe
    FROM shadow_trades
    WHERE resolved_at IS NOT NULL
      AND theoretical_pnl IS NOT NULL
    GROUP BY market_type
  `);

  logger.info({ categories: result.rows.length, haircut: effectiveHaircut, minN },
    'Computing shadow category performance');

  for (const row of result.rows) {
    const nTrades = parseInt(row.n_trades, 10);
    if (nTrades < minN) {
      logger.debug({ market_type: row.market_type, nTrades, minN }, 'Skipping shadow category (below MIN_N)');
      continue;
    }
    const rawSharpe = parseFloat(row.raw_sharpe);
    const effectiveSharpe = rawSharpe * effectiveHaircut;
    const prior = computePrior(effectiveSharpe);

    await query(
      `INSERT INTO category_performance_shadow
         (market_type, win_rate, avg_pnl, sharpe_ratio, n_trades, prior, haircut_applied, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (market_type) DO UPDATE SET
         win_rate = $2, avg_pnl = $3, sharpe_ratio = $4, n_trades = $5,
         prior = $6, haircut_applied = $7, updated_at = NOW()`,
      [row.market_type, parseFloat(row.win_rate), parseFloat(row.avg_pnl),
       effectiveSharpe, nTrades, prior, effectiveHaircut],
    );

    logger.info({ market_type: row.market_type, nTrades,
                  raw_sharpe: rawSharpe.toFixed(3), effective_sharpe: effectiveSharpe.toFixed(3),
                  haircut: effectiveHaircut, prior: prior.toFixed(3) },
      'Updated shadow category performance');
  }
}
```

- [ ] **Step 4: Run tests, verify PASS**

```bash
cd packages/data-collector
pnpm test MarketPerformanceTracker.test.ts -- -t "updateShadowCategoryPerformance"
```

Expected: 4 tests pass. The pre-existing `computePrior` tests still pass (no change to that pure function).

- [ ] **Step 5: Type-check**

```bash
cd packages/data-collector
pnpm tsc --noEmit
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
rtk git add packages/data-collector/src/services/MarketPerformanceTracker.ts \
            packages/data-collector/src/services/MarketPerformanceTracker.test.ts
rtk git commit -m "feat(market-perf): updateShadowCategoryPerformance with haircut + MIN_N gate"
```

---

### Task 9: Wire `updateShadowCategoryPerformance` into Scheduler

**Files:**
- Modify: `packages/data-collector/src/services/Scheduler.ts`

- [ ] **Step 1: Locate the existing call**

```bash
rtk grep -n "updateCategoryPriors\|resolveShadowTrades\|computeMarketPriors" packages/data-collector/src/services/Scheduler.ts | head -10
```

Expected: matches around lines 12 (import) and 504-506 (calls inside `computeMarketPriors`).

- [ ] **Step 2: Update import**

In `packages/data-collector/src/services/Scheduler.ts` line 12, extend the import to include the new function:

```typescript
import {
  updateCategoryPriors,
  resolveShadowTrades,
  updateShadowCategoryPerformance,
} from './MarketPerformanceTracker.js';
```

- [ ] **Step 3: Add the call**

Around line 504 (inside `computeMarketPriors`), insert the new call between the existing two:

```typescript
private async computeMarketPriors(): Promise<void> {
  await updateCategoryPriors();
  await updateShadowCategoryPerformance();   // NEW
  await resolveShadowTrades();
}
```

- [ ] **Step 4: Type-check**

```bash
cd packages/data-collector
pnpm tsc --noEmit
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/data-collector/src/services/Scheduler.ts
rtk git commit -m "feat(scheduler): wire updateShadowCategoryPerformance into daily computeMarketPriors"
```

---

### Task 10: Daily review prompt — shadow validation section

**Files:**
- Modify: `scripts/daily-review-prompt.md`

- [ ] **Step 1: Find a stable insertion point**

```bash
rtk grep -n "category_performance\|shadow" scripts/daily-review-prompt.md | head -10
```

Identify the most natural section to extend (likely near the existing scoring or shadow-related rules). If there is no obvious section, append a new one at the end of the prompt under a `## Shadow haircut validation` heading.

- [ ] **Step 2: Add the validation section**

Insert this section verbatim:

```markdown
## Shadow haircut validation (post-PR scoring change)

A shadow-derived dimension `shadowExpectedValue` (weight 0.05) was added to the
MarketScorer composite. The shadow Sharpe is haircut-adjusted at write time
(`SHADOW_HAIRCUT`, default 0.33) by `updateShadowCategoryPerformance`. Verify the
haircut is well-calibrated.

```sql
SELECT cp.market_type,
       cp.sharpe_ratio AS live_sharpe,
       cp.n_trades AS live_n,
       cps.sharpe_ratio AS shadow_effective_sharpe,
       cps.n_trades AS shadow_n,
       cps.haircut_applied,
       -- Implied haircut: if live is the realised target, what would the
       -- haircut have to be for shadow_effective to match?
       CASE
         WHEN cp.n_trades >= 30 AND cps.n_trades >= 30 AND cps.sharpe_ratio != 0
         THEN ROUND(
           (cp.sharpe_ratio / NULLIF(cps.sharpe_ratio / cps.haircut_applied, 0))::numeric,
           3
         )
         ELSE NULL
       END AS implied_haircut
FROM category_performance cp
LEFT JOIN category_performance_shadow cps ON cps.market_type = cp.market_type
ORDER BY cp.market_type;
```

Interpretation rules:
- **Both sides have ≥ 30 trades**: `implied_haircut` should be in `[0.15, 0.55]` (≈ 0.33 ± 0.20). Outside that band → flag for per-type haircut consideration (out of scope; follow-up PR).
- **Shadow only**: the only evidence is theoretical. Note in the review.
- **Sign disagreement** (live positive vs shadow negative or vice versa): flag for human review — likely regime divergence.
```

- [ ] **Step 3: Commit**

```bash
rtk git add scripts/daily-review-prompt.md
rtk git commit -m "docs(daily-review): add shadow haircut validation section"
```

---

### Task 11: Integration smoke + full type-check + test sweep

**Files:**
- None (verification only)

- [ ] **Step 1: Per-package tsc**

```bash
cd packages/data-collector && pnpm tsc --noEmit
cd ../dashboard && pnpm tsc --noEmit
```

Expected: clean for both.

- [ ] **Step 2: Full vitest sweep**

```bash
cd ../..
npx vitest run packages
```

Expected: every test file passes; total tests should be `prior_baseline + N_new_tests`. If any unrelated test fails, investigate before proceeding.

- [ ] **Step 3: Verify regression — original `loadCategoryMetrics` not referenced anywhere**

```bash
rtk grep -nE "loadCategoryMetrics\b" packages
```

Expected: zero matches. The single original caller (`scoreAllMarkets`) was updated in Task 7; no stale references.

- [ ] **Step 4: Verify the WEIGHTS sum invariant holds**

```bash
cd packages/data-collector
pnpm test MarketScorer.test.ts -- -t "WEIGHTS"
```

Expected: PASS — total = 1.0 within float tolerance.

- [ ] **Step 5: No commit needed (verification only)**

---

### Task 12: Push branch + open PR + final reviewer subagent

- [ ] **Step 1: Confirm git auth**

```bash
rtk gh auth status
```

If active account is not `JaviMaligno`, switch:

```bash
rtk gh auth switch --user JaviMaligno
```

- [ ] **Step 2: Push branch**

```bash
rtk git push -u origin feat/shadow-haircut-scorer-integration
```

- [ ] **Step 3: Create PR**

```bash
rtk gh pr create --title "feat(scorer): shadow as additive dimension via category_performance_shadow + haircut" \
  --body-file - <<'EOF'
## Summary

Adds a `shadowExpectedValue` dimension to `MarketScorer` (weight 0.05) fed by a new `category_performance_shadow` table. Shadow Sharpe is haircut-adjusted at write time (`SHADOW_HAIRCUT`, default 0.33). Live `category_performance` and `typeExpectedValue` are **untouched**.

Spec: `docs/plans/2026-05-01-shadow-haircut-scorer-integration-design.md`
Plan: `docs/plans/2026-05-01-shadow-haircut-scorer-integration-plan.md`

## Why

`event_short` has shadow Sharpe +2.03 (n=444 resolved, 88.5% WR) but `category_performance.sharpe_ratio` of +0.13 (n=419 historic live, mostly pre-fix). The scorer reads only live data, so event_short's shadow validation never reaches the score. Result: 14 cold candidates, only 2 promoted to active.

The shadow/live gap is structural (early exits, risk gates, sizing), not just fees. Fee subtraction moves Sharpe in the 4th decimal — measured. Adding shadow as a separate downweighted dim is more rigorous than a multiplicative haircut on the combined Sharpe.

## Pre-computed impact

| type | composite contribution before | after | Δ |
|---|---|---|---|
| event_short | 0.127 | 0.171 | +0.044 |
| event_financial | 0.138 | 0.131 | -0.007 |

Spread flip: event_short was 0.011 below event_financial in scoring contribution; now 0.040 above. Sufficient to enter rotator's top-50.

## Architecture

```
computeMarketPriors() (daily 02:45 UTC)
  ├── updateCategoryPriors()              ← UNCHANGED
  ├── updateShadowCategoryPerformance()   ← NEW
  └── resolveShadowTrades()               ← unchanged

MarketScorer.scoreAllMarkets()
  ├── loadAllCategoryMetrics() → { live, shadow }
  └── compositeScore({ ..., shadowExpectedValue: shadowEV }) ← +0.05 weight
```

## Constants & env vars

- `SHADOW_HAIRCUT` (default 0.33, env-tunable) — applied at write time, persisted as `haircut_applied` per row.
- `CATEGORY_MIN_SHADOW_N` (default 30, env-tunable) — gate below which shadow rows are not upserted.
- `WEIGHTS.shadowExpectedValue = 0.05` — fixed in code; changing is a deliberate scoring decision.

## Validation

- Daily review query (`scripts/daily-review-prompt.md`) computes `implied_haircut` per type. Alert if outside `[0.15, 0.55]`.
- Post-deploy: confirm event_short active count rises from 2 toward 5+ within 48h.
- After 1 week: review implied_haircut trends; consider per-type override PR if needed.

## Test plan

- [x] `pnpm tsc --noEmit` clean per package
- [x] Full vitest sweep passes (existing baseline + new tests)
- [x] `WEIGHTS` sum to 1.0 invariant
- [x] `shadowExpectedValue` mirrors `typeExpectedValue` formula
- [x] `compositeScore` integrates shadow weight correctly
- [x] `loadAllCategoryMetrics` returns parallel maps; graceful degradation on DB error
- [x] `updateShadowCategoryPerformance` applies haircut, honors env overrides, gates by MIN_N
- [ ] Post-deploy: `category_performance_shadow` rows appear after first 02:45 UTC run
- [ ] Post-deploy: event_short composite contribution rises as predicted

## Files touched

```
packages/data-collector/src/database/init/029_category_performance_shadow.sql       [new]
packages/dashboard/src/services/bootstrapShadowCategoryPerformance.ts                [new]
packages/dashboard/src/services/bootstrapShadowCategoryPerformance.test.ts           [new]
packages/dashboard/src/server.ts                                                     [+bootstrap call]
packages/data-collector/src/services/MarketScorer.ts                                 [+shadowExpectedValue, rescaled WEIGHTS, loadAllCategoryMetrics, scoreAllMarkets passes]
packages/data-collector/src/services/MarketScorer.test.ts                            [+tests]
packages/data-collector/src/services/MarketPerformanceTracker.ts                     [+updateShadowCategoryPerformance]
packages/data-collector/src/services/MarketPerformanceTracker.test.ts                [+tests]
packages/data-collector/src/services/Scheduler.ts                                    [+wire call]
scripts/daily-review-prompt.md                                                       [+validation section]
```

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

- [ ] **Step 4: Wait for CI**

```bash
until rtk gh pr checks $(rtk gh pr view --json number --jq '.number') 2>&1 | grep -qE "Passed|FAIL"; do sleep 15; done
rtk gh pr checks $(rtk gh pr view --json number --jq '.number')
```

Expected: all checks pass.

- [ ] **Step 5: (If subagent-driven plan) dispatch final code reviewer**

If executing this plan via `superpowers:subagent-driven-development`, dispatch the final code reviewer agent with `BASE_SHA = git merge-base origin/main HEAD` and `HEAD_SHA = HEAD`. Address any blocking findings before merge.

- [ ] **Step 6: Merge**

```bash
rtk gh pr merge $(rtk gh pr view --json number --jq '.number') --squash --delete-branch
```

- [ ] **Step 7: Confirm Deploy to GCP fired automatically**

```bash
rtk gh run list --workflow="Deploy to GCP" --limit 1 --json conclusion,status,headSha
```

Expected: a new run on the squash commit, status `queued` or `in_progress`. Wait for it; if it hangs on health check or e2-micro saturation, see `memory/project_billing_incident_2026-05-01.md` for recovery steps (cancel + manual `docker compose pull && up`).

---

## Self-review checklist (post-merge)

- [ ] On VM: `git log --oneline -1` shows the merge commit at HEAD.
- [ ] `docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c "\\d category_performance_shadow"` returns the new schema.
- [ ] After first daily 02:45 UTC run: `SELECT * FROM category_performance_shadow ORDER BY market_type;` returns ≥ 1 row (event_short and/or event_long).
- [ ] After ~30 min following the daily run: `SELECT m.market_type, COUNT(*) FROM markets m WHERE m.tracking_status='active' GROUP BY m.market_type ORDER BY m.market_type;` shows event_short count rising vs pre-deploy snapshot.
- [ ] Run the daily review query (Task 10 §SQL); `implied_haircut` for event_short, when both sides ≥ 30 trades, lands in `[0.15, 0.55]`.
