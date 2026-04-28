# Per-Type Optimizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `WeightedAverageCombiner.typeWeights` DB-backed and per-type optimized. Schema extends `signal_weights` with `market_type` column; OptimizationScheduler runs Optuna once per market_type, writing per-type rows. Replaces hardcoded `DEFAULT_TYPE_WEIGHTS` with empirically-optimized values.

**Architecture:** Per-type rows in `signal_weights` table (PK becomes `(signal_type, market_type)`, sentinel `'__global__'` preserves legacy global rows). SignalEngine loads per-type weights into combiner via `setTypeWeights()` at startup and on sync interval. OptimizationScheduler iterates over 5 market_types per cycle, each filtered to its type's data; `state.bestSharpe` becomes `Record<string, number>` (per-type peaks). Param space expanded to 11 active generators.

**Tech Stack:** TypeScript + Vitest, pnpm monorepo, PostgreSQL/TimescaleDB. Spec: `docs/plans/2026-04-28-per-type-optimizer-design.md`.

---

## File Structure

| Path | Change | Responsibility |
|---|---|---|
| `packages/data-collector/src/database/init/025_signal_weights_per_type.sql` | Create | Schema migration for fresh deploys (ALTER TABLE + bootstrap 55 rows). |
| `packages/dashboard/src/server.ts` | Modify | Run same migration as post-init hook for existing VM (around line 200, near scorer_weights migration). |
| `packages/dashboard/src/database/repositories.ts` | Modify (signalWeightsRepo, lines 149-222) | Add `getAllPerType()` and `updatePerType()` methods. |
| `packages/signals/src/combiners/WeightedAverageCombiner.ts` | Modify (constructor, line 124) | Remove `DEFAULT_TYPE_WEIGHTS` init in constructor (`this.typeWeights = {}`). Keep the constant as dead code for one release for rollback safety. |
| `packages/signals/src/combiners/WeightedAverageCombiner.test.ts` | Modify | Add test that an empty typeWeights at construction falls back to `this.weights` legacy branch. |
| `packages/dashboard/src/services/SignalEngine.ts` | Modify (setupCombiner + sync interval) | Call `signalWeightsRepo.getAllPerType()` and `combiner.setTypeWeights(map)` at startup and every 5 min sync. |
| `packages/dashboard/src/services/BacktestService.ts:316-365` | Modify (`fetchHistoricalData`) | Accept optional `marketType` parameter; filter top-markets query by `markets.market_type` when provided. |
| `packages/dashboard/src/services/OptimizationScheduler.ts` | Modify (significant refactor) | Per-type loop in `runIncrementalOptimization` and `runFullOptimization`; per-type `state.bestSharpe` map; per-type Optuna study names; param space expansion to 11 generators; `updateStrategy(best, marketType)` writes per-type rows. |
| `packages/dashboard/src/services/OptimizationScheduler.test.ts` (or equivalent) | Modify | New tests for per-type loop, market_type filter passed to BacktestService, per-type `bestSharpePerType` ratchet, `updatePerType` written to repo. |

No new files outside the SQL migration. No env vars. No docker-compose changes. No frontend changes.

---

### Task 1: Schema migration SQL

Create the standalone init file (for fresh deploys) and reference it from server.ts (for existing VM). Idempotent.

**Files:**
- Create: `packages/data-collector/src/database/init/025_signal_weights_per_type.sql`

- [ ] **Step 1: Write the migration file**

Create `packages/data-collector/src/database/init/025_signal_weights_per_type.sql` with this content:

```sql
-- 025_signal_weights_per_type.sql
-- Extends signal_weights to support per-market-type rows. Existing rows become
-- market_type='__global__'; per-type rows added below as bootstrap.

ALTER TABLE signal_weights
  ADD COLUMN IF NOT EXISTS market_type VARCHAR(32) NOT NULL DEFAULT '__global__';

-- Defensive PK swap: discover existing PK name dynamically.
DO $$
DECLARE pkey_name TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signal_weights_pkey_per_type') THEN
    RETURN;
  END IF;

  SELECT conname INTO pkey_name
  FROM pg_constraint
  WHERE conrelid = 'signal_weights'::regclass AND contype = 'p';

  IF pkey_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE signal_weights DROP CONSTRAINT %I', pkey_name);
  END IF;

  ALTER TABLE signal_weights
    ADD CONSTRAINT signal_weights_pkey_per_type PRIMARY KEY (signal_type, market_type);
END $$;

-- Bootstrap 55 per-type rows from current DEFAULT_TYPE_WEIGHTS hardcoded values.
INSERT INTO signal_weights (signal_type, weight, market_type, updated_at) VALUES
  -- crypto_intraday
  ('momentum',           -0.3, 'crypto_intraday', NOW()),
  ('mean_reversion',      0.5, 'crypto_intraday', NOW()),
  ('ofi',                 0.5, 'crypto_intraday', NOW()),
  ('mlofi',               0.5, 'crypto_intraday', NOW()),
  ('hawkes',              0.4, 'crypto_intraday', NOW()),
  ('volume_anomaly',      0.0, 'crypto_intraday', NOW()),
  ('spread_compression',  0.0, 'crypto_intraday', NOW()),
  ('cross_market_corr',   0.0, 'crypto_intraday', NOW()),
  ('price_divergence',    0.0, 'crypto_intraday', NOW()),
  ('attention_spike',     0.0, 'crypto_intraday', NOW()),
  ('news_sentiment',      0.0, 'crypto_intraday', NOW()),
  -- crypto_daily
  ('momentum',           -0.3, 'crypto_daily', NOW()),
  ('mean_reversion',      0.6, 'crypto_daily', NOW()),
  ('ofi',                 0.4, 'crypto_daily', NOW()),
  ('mlofi',               0.4, 'crypto_daily', NOW()),
  ('hawkes',              0.3, 'crypto_daily', NOW()),
  ('volume_anomaly',      0.0, 'crypto_daily', NOW()),
  ('spread_compression',  0.0, 'crypto_daily', NOW()),
  ('cross_market_corr',   0.0, 'crypto_daily', NOW()),
  ('price_divergence',    0.0, 'crypto_daily', NOW()),
  ('attention_spike',     0.0, 'crypto_daily', NOW()),
  ('news_sentiment',      0.0, 'crypto_daily', NOW()),
  -- event_financial
  ('momentum',           -0.3, 'event_financial', NOW()),
  ('mean_reversion',      0.6, 'event_financial', NOW()),
  ('ofi',                 0.4, 'event_financial', NOW()),
  ('mlofi',               0.4, 'event_financial', NOW()),
  ('hawkes',              0.3, 'event_financial', NOW()),
  ('volume_anomaly',      0.0, 'event_financial', NOW()),
  ('spread_compression',  0.0, 'event_financial', NOW()),
  ('cross_market_corr',   0.0, 'event_financial', NOW()),
  ('price_divergence',    0.0, 'event_financial', NOW()),
  ('attention_spike',     0.0, 'event_financial', NOW()),
  ('news_sentiment',      0.0, 'event_financial', NOW()),
  -- event_short
  ('momentum',           -0.4, 'event_short', NOW()),
  ('mean_reversion',      0.6, 'event_short', NOW()),
  ('ofi',                 0.3, 'event_short', NOW()),
  ('mlofi',               0.3, 'event_short', NOW()),
  ('hawkes',              0.2, 'event_short', NOW()),
  ('volume_anomaly',      0.0, 'event_short', NOW()),
  ('spread_compression',  0.0, 'event_short', NOW()),
  ('cross_market_corr',   0.0, 'event_short', NOW()),
  ('price_divergence',    0.0, 'event_short', NOW()),
  ('attention_spike',     0.0, 'event_short', NOW()),
  ('news_sentiment',      0.0, 'event_short', NOW()),
  -- event_long
  ('momentum',           -0.4, 'event_long', NOW()),
  ('mean_reversion',      0.6, 'event_long', NOW()),
  ('ofi',                 0.2, 'event_long', NOW()),
  ('mlofi',               0.2, 'event_long', NOW()),
  ('hawkes',              0.1, 'event_long', NOW()),
  ('volume_anomaly',      0.0, 'event_long', NOW()),
  ('spread_compression',  0.0, 'event_long', NOW()),
  ('cross_market_corr',   0.0, 'event_long', NOW()),
  ('price_divergence',    0.0, 'event_long', NOW()),
  ('attention_spike',     0.0, 'event_long', NOW()),
  ('news_sentiment',      0.0, 'event_long', NOW())
ON CONFLICT (signal_type, market_type) DO NOTHING;
```

55 INSERT rows total (5 types × 11 generators). The hardcoded values match the `DEFAULT_TYPE_WEIGHTS` constant in `WeightedAverageCombiner.ts:97-104` exactly for the 5 listed generators per type, and 0 for the 6 unlisted.

- [ ] **Step 2: Verify the file is syntactically valid**

```bash
docker run --rm -v "$(pwd)/packages/data-collector/src/database/init/025_signal_weights_per_type.sql:/sql:ro" timescale/timescaledb:latest-pg15 psql --set ON_ERROR_STOP=1 -c "BEGIN; CREATE TEMP TABLE signal_weights (signal_type VARCHAR(50) PRIMARY KEY, weight DOUBLE PRECISION NOT NULL, updated_at TIMESTAMPTZ); \i /sql ROLLBACK;" 2>&1 | tail -3
```

Note: this requires the migration to work on a clean schema. Since the migration uses `ADD COLUMN IF NOT EXISTS` and a defensive PK drop, it should work. If the docker setup is too cumbersome, skip this step and rely on Step 4 (in-place test on the VM during deploy verification).

Expected: no SQL syntax errors. Specific output less important than absence of errors.

- [ ] **Step 3: Commit**

```bash
git add packages/data-collector/src/database/init/025_signal_weights_per_type.sql
git commit -m "chore(db): migration to add market_type to signal_weights"
```

---

### Task 2: Post-init startup hook in server.ts

The init/*.sql file only runs on fresh volume init. The production VM has an existing DB volume — needs the same migration applied via `dashboard/server.ts` startup hook (precedent: scorer_weights from PR #125, around line 200).

**Files:**
- Modify: `packages/dashboard/src/server.ts` (find the existing block of post-init ALTER TABLEs around line 160-220, append the migration there)

- [ ] **Step 1: Locate the existing migration block**

Open `packages/dashboard/src/server.ts` and find the area around line 160-220 where ALTER TABLE migrations are applied (search for `ALTER TABLE` to find the block). The pattern: a `try { await query(\`ALTER TABLE ...\`); }` per migration.

- [ ] **Step 2: Append the per-type migration**

Insert this block after the last existing ALTER TABLE block (look for the `scorer_weights` migration and place this after it; if the scorer_weights migration is not present, place after any migration that touches `markets` or `paper_positions`):

```typescript
// Migration: extend signal_weights with per-market-type column.
// Reads bootstrap rows from DEFAULT_TYPE_WEIGHTS values to seed per-type weights.
// See docs/plans/2026-04-28-per-type-optimizer-design.md.
try {
  await query(`
    ALTER TABLE signal_weights
      ADD COLUMN IF NOT EXISTS market_type VARCHAR(32) NOT NULL DEFAULT '__global__';
  `);
  await query(`
    DO $$
    DECLARE pkey_name TEXT;
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signal_weights_pkey_per_type') THEN
        RETURN;
      END IF;

      SELECT conname INTO pkey_name
      FROM pg_constraint
      WHERE conrelid = 'signal_weights'::regclass AND contype = 'p';

      IF pkey_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE signal_weights DROP CONSTRAINT %I', pkey_name);
      END IF;

      ALTER TABLE signal_weights
        ADD CONSTRAINT signal_weights_pkey_per_type PRIMARY KEY (signal_type, market_type);
    END $$;
  `);
  // Bootstrap 55 per-type rows. Identical to init/025_signal_weights_per_type.sql.
  await query(`
    INSERT INTO signal_weights (signal_type, weight, market_type, updated_at) VALUES
      ('momentum', -0.3, 'crypto_intraday', NOW()),
      ('mean_reversion', 0.5, 'crypto_intraday', NOW()),
      ('ofi', 0.5, 'crypto_intraday', NOW()),
      ('mlofi', 0.5, 'crypto_intraday', NOW()),
      ('hawkes', 0.4, 'crypto_intraday', NOW()),
      ('volume_anomaly', 0.0, 'crypto_intraday', NOW()),
      ('spread_compression', 0.0, 'crypto_intraday', NOW()),
      ('cross_market_corr', 0.0, 'crypto_intraday', NOW()),
      ('price_divergence', 0.0, 'crypto_intraday', NOW()),
      ('attention_spike', 0.0, 'crypto_intraday', NOW()),
      ('news_sentiment', 0.0, 'crypto_intraday', NOW()),
      ('momentum', -0.3, 'crypto_daily', NOW()),
      ('mean_reversion', 0.6, 'crypto_daily', NOW()),
      ('ofi', 0.4, 'crypto_daily', NOW()),
      ('mlofi', 0.4, 'crypto_daily', NOW()),
      ('hawkes', 0.3, 'crypto_daily', NOW()),
      ('volume_anomaly', 0.0, 'crypto_daily', NOW()),
      ('spread_compression', 0.0, 'crypto_daily', NOW()),
      ('cross_market_corr', 0.0, 'crypto_daily', NOW()),
      ('price_divergence', 0.0, 'crypto_daily', NOW()),
      ('attention_spike', 0.0, 'crypto_daily', NOW()),
      ('news_sentiment', 0.0, 'crypto_daily', NOW()),
      ('momentum', -0.3, 'event_financial', NOW()),
      ('mean_reversion', 0.6, 'event_financial', NOW()),
      ('ofi', 0.4, 'event_financial', NOW()),
      ('mlofi', 0.4, 'event_financial', NOW()),
      ('hawkes', 0.3, 'event_financial', NOW()),
      ('volume_anomaly', 0.0, 'event_financial', NOW()),
      ('spread_compression', 0.0, 'event_financial', NOW()),
      ('cross_market_corr', 0.0, 'event_financial', NOW()),
      ('price_divergence', 0.0, 'event_financial', NOW()),
      ('attention_spike', 0.0, 'event_financial', NOW()),
      ('news_sentiment', 0.0, 'event_financial', NOW()),
      ('momentum', -0.4, 'event_short', NOW()),
      ('mean_reversion', 0.6, 'event_short', NOW()),
      ('ofi', 0.3, 'event_short', NOW()),
      ('mlofi', 0.3, 'event_short', NOW()),
      ('hawkes', 0.2, 'event_short', NOW()),
      ('volume_anomaly', 0.0, 'event_short', NOW()),
      ('spread_compression', 0.0, 'event_short', NOW()),
      ('cross_market_corr', 0.0, 'event_short', NOW()),
      ('price_divergence', 0.0, 'event_short', NOW()),
      ('attention_spike', 0.0, 'event_short', NOW()),
      ('news_sentiment', 0.0, 'event_short', NOW()),
      ('momentum', -0.4, 'event_long', NOW()),
      ('mean_reversion', 0.6, 'event_long', NOW()),
      ('ofi', 0.2, 'event_long', NOW()),
      ('mlofi', 0.2, 'event_long', NOW()),
      ('hawkes', 0.1, 'event_long', NOW()),
      ('volume_anomaly', 0.0, 'event_long', NOW()),
      ('spread_compression', 0.0, 'event_long', NOW()),
      ('cross_market_corr', 0.0, 'event_long', NOW()),
      ('price_divergence', 0.0, 'event_long', NOW()),
      ('attention_spike', 0.0, 'event_long', NOW()),
      ('news_sentiment', 0.0, 'event_long', NOW())
    ON CONFLICT (signal_type, market_type) DO NOTHING;
  `);
  console.log('[server] signal_weights per-type schema migration applied');
} catch (err) {
  console.error('[server] signal_weights per-type migration failed:', err);
  throw err; // halt startup on migration failure
}
```

- [ ] **Step 3: Type check**

```bash
pnpm exec tsc -p packages/dashboard/tsconfig.json --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/dashboard/src/server.ts
git commit -m "feat(server): post-init hook applies signal_weights per-type migration"
```

---

### Task 3: signalWeightsRepo per-type methods

Add `getAllPerType()` and `updatePerType()` to the existing repo.

**Files:**
- Modify: `packages/dashboard/src/database/repositories.ts` (signalWeightsRepo at line 149-222)

- [ ] **Step 1: Add the new methods**

Open `packages/dashboard/src/database/repositories.ts`. The `signalWeightsRepo` object currently has `getAll`, `get`, `update`, `getHistory`. Add these two new methods inside the object literal, between `update` and `getHistory`:

```typescript
  /**
   * Get all per-type weights, grouped by market_type. Excludes '__global__' rows.
   * Returns { market_type → { signal_type → weight } }.
   */
  async getAllPerType(): Promise<Record<string, Record<string, number>>> {
    const result = await query<{ signal_type: string; market_type: string; weight: number }>(
      `SELECT signal_type, market_type, weight
       FROM signal_weights
       WHERE market_type != '__global__'`
    );
    const map: Record<string, Record<string, number>> = {};
    for (const row of result.rows) {
      if (!map[row.market_type]) map[row.market_type] = {};
      map[row.market_type][row.signal_type] = Number(row.weight);
    }
    return map;
  },

  /**
   * UPSERT a per-type weight row. Used by OptimizationScheduler.updateStrategy.
   * History insert is intentionally skipped in this PR (signal_weights_history
   * lacks a market_type column; tracked as separate follow-up).
   */
  async updatePerType(
    signalType: string,
    marketType: string,
    weight: number,
    reason: string
  ): Promise<void> {
    await query(
      `INSERT INTO signal_weights (signal_type, market_type, weight, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (signal_type, market_type)
       DO UPDATE SET weight = EXCLUDED.weight, updated_at = EXCLUDED.updated_at`,
      [signalType, marketType, weight]
    );
    console.log(`[signalWeightsRepo] updatePerType ${signalType}@${marketType} = ${weight} (${reason})`);
  },
```

- [ ] **Step 2: Type check**

```bash
pnpm exec tsc -p packages/dashboard/tsconfig.json --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/dashboard/src/database/repositories.ts
git commit -m "feat(repo): add signalWeightsRepo per-type methods"
```

---

### Task 4: WeightedAverageCombiner — empty typeWeights at construction

Constructor stops auto-populating `typeWeights` from the hardcoded `DEFAULT_TYPE_WEIGHTS` constant. Callers (SignalEngine in Task 5) populate it via `setTypeWeights()` from DB.

**Files:**
- Modify: `packages/signals/src/combiners/WeightedAverageCombiner.ts` (constructor, line 124)
- Modify: `packages/signals/src/combiners/WeightedAverageCombiner.test.ts` (add a regression test)

- [ ] **Step 1: Write the failing test**

Append to `packages/signals/src/combiners/WeightedAverageCombiner.test.ts` at the end of the file:

```typescript
describe('WeightedAverageCombiner — empty typeWeights at construction', () => {
  it('does NOT auto-populate from DEFAULT_TYPE_WEIGHTS; caller must setTypeWeights', () => {
    // Setup: combiner constructed with global weights only (this.weights set via setWeights).
    // No setTypeWeights call. typeWeights should be empty, so combine() with a known
    // marketType falls through to this.weights (legacy global path).
    const combiner = new WeightedAverageCombiner(
      { momentum: 1, mean_reversion: 1 },
      { minCombinedStrength: 0.01, minCombinedConfidence: 0.01 }
    );
    combiner.setDirectionMultiplier(1);

    const signal = buildSignal({
      signalId: 'momentum',
      direction: 'long',
      strength: 0.5,
      confidence: 0.8,
    });

    // With marketType='event_financial' and no per-type entry, lookup falls
    // through to this.weights (legacy global). this.weights has momentum=1,
    // so the signal contributes via that branch.
    const result = combiner.combine([signal], undefined, 'event_financial');

    expect(result).not.toBeNull();
    expect(result!.direction).toBe('LONG');
    // Strength is non-zero — confirming the signal was NOT silenced as it
    // would be if typeWeights had been auto-populated with hardcoded
    // event_financial values that listed momentum at -0.3 (would flip
    // to SHORT or yield different magnitude).
    expect(result!.strength).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm exec vitest run packages/signals/src/combiners/WeightedAverageCombiner.test.ts -t 'empty typeWeights at construction'
```

Expected: FAIL. Pre-fix, the constructor populates `this.typeWeights` from `DEFAULT_TYPE_WEIGHTS`, so `combine()` with `marketType='event_financial'` uses the per-type values (which include `momentum: -0.3`). With the negative weight and `setDirectionMultiplier(1)`, the result direction may be SHORT or strength may have a different sign.

If the test PASSES before the fix: there's something different about the combiner's behavior than expected; investigate before continuing.

- [ ] **Step 3: Apply the fix**

In `packages/signals/src/combiners/WeightedAverageCombiner.ts`, find the constructor (around line 118-132). Specifically, replace line 124:

```typescript
// Before:
this.typeWeights = { ...DEFAULT_TYPE_WEIGHTS };

// After:
// Per-type weights are populated externally via setTypeWeights() — typically
// from DB in SignalEngine.setupCombiner(). DEFAULT_TYPE_WEIGHTS constant is
// kept in this file as dead code for one release cycle (rollback safety).
this.typeWeights = {};
```

- [ ] **Step 4: Run all combiner tests to verify**

```bash
pnpm exec vitest run packages/signals/src/combiners/WeightedAverageCombiner.test.ts
```

Expected: ALL pass — the new test plus all preexisting tests. Some preexisting tests (like the direction-context test at line 44) may have relied on the auto-populated typeWeights and need updating to call `setTypeWeights()` explicitly. Inspect any failures and update the test setup to call `setTypeWeights({...})` with appropriate values.

If a preexisting test fails because it relied on the auto-populated typeWeights, fix the test by adding the `setTypeWeights` call right after the constructor — DO NOT revert the production code.

- [ ] **Step 5: Type check**

```bash
pnpm exec tsc -p packages/signals/tsconfig.json --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/signals/src/combiners/WeightedAverageCombiner.ts packages/signals/src/combiners/WeightedAverageCombiner.test.ts
git commit -m "feat(combiner): empty typeWeights at construction; caller injects via setTypeWeights"
```

---

### Task 5: SignalEngine — sync per-type weights from DB

Call `signalWeightsRepo.getAllPerType()` at startup and on the existing sync interval. Pass the returned map to `combiner.setTypeWeights()`.

**Files:**
- Modify: `packages/dashboard/src/services/SignalEngine.ts` (the existing weight-sync code, find via grep `signalWeightsRepo.getAll` / `setWeights`).

- [ ] **Step 1: Locate the sync code**

In `packages/dashboard/src/services/SignalEngine.ts`, find the section where `signalWeightsRepo.getAll()` is called and the resulting weights are passed to `combiner.setWeights()`. There should be one location at startup (in `setupCombiner` or similar) and one in a periodic sync handler. Both need parallel calls for the per-type map.

- [ ] **Step 2: Add per-type sync at startup**

Right after the existing `combiner.setWeights(weightMap)` call (around line 301 per spec), insert:

```typescript
// Sync per-type weights from DB. Fills combiner.typeWeights, which is the
// authoritative source for runtime weight lookup on known market types.
try {
  const perTypeWeights = await signalWeightsRepo.getAllPerType();
  this.combiner.setTypeWeights(perTypeWeights);
  console.log(
    `[SignalEngine] Synced typeWeights from database: ${Object.keys(perTypeWeights).length} types`
  );
} catch (err) {
  console.error('[SignalEngine] Failed to sync per-type weights:', err);
  // Continue with empty typeWeights; combiner falls back to this.weights.
}
```

- [ ] **Step 3: Add per-type sync to the periodic handler**

Find the periodic sync function (every `syncWeightsIntervalMs`, default 5 min). It currently calls `signalWeightsRepo.getAll()` and `setWeights()`. Add the same per-type block there, immediately after the existing setWeights call:

```typescript
try {
  const perTypeWeights = await signalWeightsRepo.getAllPerType();
  this.combiner.setTypeWeights(perTypeWeights);
} catch (err) {
  console.error('[SignalEngine] Failed to sync per-type weights:', err);
}
```

- [ ] **Step 4: Type check**

```bash
pnpm exec tsc -p packages/dashboard/tsconfig.json --noEmit
```

Expected: no errors.

- [ ] **Step 5: Run dashboard tests**

```bash
pnpm exec vitest run packages/dashboard/src/services/SignalEngine.test.ts
```

Expected: existing tests pass. (No new test required for this task — Task 4's combiner test confirms the wiring works; integration smoke in Task 9 confirms the runtime path.)

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/src/services/SignalEngine.ts
git commit -m "feat(engine): sync per-type weights from DB at startup and 5min interval"
```

---

### Task 6: BacktestService — optional marketType filter

Add an optional `marketType` parameter to `fetchHistoricalData`. When provided, the inner top-markets query filters by `markets.market_type`. Backwards compat preserved (existing callers without `marketType` get unfiltered data).

**Files:**
- Modify: `packages/dashboard/src/services/BacktestService.ts` (the `fetchHistoricalData` method at line 316-365)

- [ ] **Step 1: Update the signature**

Change:

```typescript
async fetchHistoricalData(
  startDate: Date,
  endDate: Date,
  marketIds?: string[]
): Promise<MarketData[]> {
```

to:

```typescript
async fetchHistoricalData(
  startDate: Date,
  endDate: Date,
  marketIds?: string[],
  marketType?: string,
): Promise<MarketData[]> {
```

- [ ] **Step 2: Wire the filter into the SQL**

In the body of `fetchHistoricalData` (around lines 333-353 where `topMarketsQuery` is built), the existing logic branches on `marketIds`. Extend both branches to include the market_type filter when provided. The simplest approach is to build the filter clause separately:

Replace lines 333-353 with:

```typescript
const marketTypeFilter = marketType ? 'AND m.market_type = $TYPE_PARAM' : '';

let topMarketsQuery: string;
let topMarketsParams: (Date | string[] | string)[];

if (marketIds && marketIds.length > 0) {
  topMarketsQuery = `
    SELECT ph.market_id FROM price_history ph
    JOIN markets m ON ph.market_id = m.id
    WHERE ph.time >= $1 AND ph.time <= $2
      AND ph.market_id = ANY($3)
      AND ph.token_id = m.clob_token_id_yes
      ${marketTypeFilter}
    GROUP BY ph.market_id HAVING COUNT(*) >= 35
    ORDER BY COUNT(*) DESC LIMIT 20
  `.replace('$TYPE_PARAM', marketType ? '$4' : '');
  topMarketsParams = marketType
    ? [startDate, endDate, marketIds, marketType]
    : [startDate, endDate, marketIds];
} else {
  topMarketsQuery = `
    SELECT ph.market_id FROM price_history ph
    JOIN markets m ON ph.market_id = m.id
    WHERE ph.time >= $1 AND ph.time <= $2
      AND ph.token_id = m.clob_token_id_yes
      ${marketTypeFilter}
    GROUP BY ph.market_id HAVING COUNT(*) >= 35
    ORDER BY COUNT(*) DESC LIMIT 20
  `.replace('$TYPE_PARAM', marketType ? '$3' : '');
  topMarketsParams = marketType
    ? [startDate, endDate, marketType]
    : [startDate, endDate];
}
```

The `.replace('$TYPE_PARAM', ...)` substitutes the actual parameter index after the conditional logic determines which slot the marketType binding occupies. This avoids two completely-separate SQL strings.

- [ ] **Step 3: Type check**

```bash
pnpm exec tsc -p packages/dashboard/tsconfig.json --noEmit
```

Expected: no errors.

- [ ] **Step 4: Run BacktestService tests**

```bash
pnpm exec vitest run packages/dashboard/src/services/BacktestService.test.ts 2>&1 | tail -10
```

Expected: existing tests pass (the new param is optional with backwards-compat default behavior). If no test file exists for BacktestService, that's also fine — backwards compat is verified by the dashboard suite passing.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/services/BacktestService.ts
git commit -m "feat(backtest): optional marketType filter in fetchHistoricalData"
```

---

### Task 7: OptimizationScheduler — per-type loop refactor

Convert `runIncrementalOptimization()` and `runFullOptimization()` to iterate over the 5 market_types. Each iteration is an isolated Optuna study filtered to that type. `state.bestSharpe` becomes `Record<string, number>` (per-type peaks).

**Files:**
- Modify: `packages/dashboard/src/services/OptimizationScheduler.ts` (significant)

- [ ] **Step 1: Add the MARKET_TYPES constant**

Near the top of the file, with other constants:

```typescript
// Market types covered by per-type optimization. Mirrors DEFAULT_TYPE_WEIGHTS keys
// in WeightedAverageCombiner.ts and the bootstrap rows in init/025_*.sql.
const MARKET_TYPES = ['crypto_intraday', 'crypto_daily', 'event_financial', 'event_short', 'event_long'] as const;
type MarketType = typeof MARKET_TYPES[number];
```

- [ ] **Step 2: Convert state.bestSharpe to per-type**

Find the state interface and initial value (around lines 145-160):

```typescript
// Before:
bestSharpe: number;
// ... and:
bestSharpe: 0,

// After:
bestSharpePerType: Record<string, number>;
// ... and:
bestSharpePerType: {},
```

Update any other references to `state.bestSharpe` in the file (search via grep) to use `state.bestSharpePerType[marketType]` with a fallback to 0 (`?? 0`). Locations to fix include the comparison in `runIncrementalOptimization` and `runFullOptimization` (lines 294 and 322 per spec).

- [ ] **Step 3: Refactor runIncrementalOptimization to per-type loop**

Replace the existing `runIncrementalOptimization` body (lines 281-307 per spec) with:

```typescript
private async runIncrementalOptimization(): Promise<void> {
  console.log('[OptimizationScheduler] Starting incremental optimization (per-type)...');
  this.state.currentRunType = 'incremental';

  try {
    for (const marketType of MARKET_TYPES) {
      console.log(`[OptimizationScheduler] === ${marketType} ===`);
      try {
        const results = await this.runOptimization(this.incrementalIterations, 'incremental', marketType);
        if (results.length === 0) {
          console.log(`[OptimizationScheduler] No results for ${marketType}, skipping`);
          continue;
        }

        const best = results.reduce((a, b) => a.sharpe > b.sharpe ? a : b);

        // Always run OOS validation and persist score (feeds decay factor history)
        await this.runOOSAndPersist(best, marketType);

        const priorBest = this.state.bestSharpePerType[marketType] ?? 0;
        if (best.sharpe >= priorBest) {
          console.log(`[OptimizationScheduler] ${marketType}: better params Sharpe ${best.sharpe.toFixed(2)} vs ${priorBest.toFixed(2)}`);
          await this.updateStrategy(best, marketType);
        }
      } catch (err) {
        console.error(`[OptimizationScheduler] ${marketType} failed:`, err);
        // Continue to next type
      }
    }

    this.state.lastIncrementalAt = new Date();
    console.log('[OptimizationScheduler] Incremental optimization completed (all types)');
  } catch (error) {
    console.error('[OptimizationScheduler] Incremental orchestration failed:', error);
  } finally {
    this.state.currentRunType = 'idle';
    await this.saveState();
  }
}
```

Apply the equivalent refactor to `runFullOptimization` (the structure is identical except `'incremental'` → `'full'` and uses `this.fullIterations`).

- [ ] **Step 4: Update runOptimization to accept marketType**

Change the signature of `runOptimization` to take a `marketType` parameter:

```typescript
private async runOptimization(
  iterations: number,
  type: 'incremental' | 'full',
  marketType: string,
): Promise<OptimizationResult[]>
```

Pass `marketType` through to:
- `BacktestService.fetchHistoricalData(startDate, endDate, undefined, marketType)` for preloaded data.
- `runBacktest(request, preloadedData)` — the request itself doesn't need marketType (preloaded data is already filtered).
- The Optuna study creation call: change study_name to include `marketType`. Find the existing `client.createOptimizer(...)` call; the study_name parameter should become e.g. `incremental-${dateStr}-${marketType}` or `full-${dateStr}-${marketType}`.

- [ ] **Step 5: Update runOOSAndPersist to accept marketType**

The OOS validation runs a separate backtest on the OOS window. Pass `marketType` through similarly. The signature becomes:

```typescript
private async runOOSAndPersist(
  best: OptimizationResult,
  marketType: string,
): Promise<void>
```

The OOS BacktestService.fetchHistoricalData call (within runOOSAndPersist) gets `marketType` as the 4th argument too.

- [ ] **Step 6: Type check**

```bash
pnpm exec tsc -p packages/dashboard/tsconfig.json --noEmit
```

Expected: no errors. If errors mention `bestSharpe` not found or wrong type, find any remaining references and update.

- [ ] **Step 7: Commit**

```bash
git add packages/dashboard/src/services/OptimizationScheduler.ts
git commit -m "feat(optimizer): per-type loop with per-type bestSharpe ratchet"
```

---

### Task 8: OptimizationScheduler — param space expansion + updateStrategy per-type

Extend `OPTUNA_PARAM_SPACE` and `REFINEMENT_PARAM_SPACE` to cover all 11 active generators. Update `updateStrategy` to write per-type rows via `signalWeightsRepo.updatePerType()`.

**Files:**
- Modify: `packages/dashboard/src/services/OptimizationScheduler.ts` (continued)

- [ ] **Step 1: Extend OPTUNA_PARAM_SPACE**

Find `OPTUNA_PARAM_SPACE` at line 39. After the existing 5 generator weight entries, append the 6 missing ones:

```typescript
// Existing entries kept:
{ name: 'combiner.momentumWeight', type: 'float', low: -1.5, high: 1.5 },
{ name: 'combiner.meanReversionWeight', type: 'float', low: 0.0, high: 2.0 },
{ name: 'combiner.ofiWeight', type: 'float', low: 0.0, high: 2.0 },
{ name: 'combiner.mlofiWeight', type: 'float', low: 0.0, high: 2.0 },
{ name: 'combiner.hawkesWeight', type: 'float', low: 0.0, high: 2.0 },

// NEW 6 entries (matching the unlisted generators in DEFAULT_TYPE_WEIGHTS):
{ name: 'combiner.volumeAnomalyWeight', type: 'float', low: 0.0, high: 2.0 },
{ name: 'combiner.spreadCompressionWeight', type: 'float', low: 0.0, high: 2.0 },
{ name: 'combiner.crossMarketCorrWeight', type: 'float', low: 0.0, high: 2.0 },
{ name: 'combiner.priceDivergenceWeight', type: 'float', low: 0.0, high: 2.0 },
{ name: 'combiner.attentionSpikeWeight', type: 'float', low: 0.0, high: 2.0 },
{ name: 'combiner.newsSentimentWeight', type: 'float', low: 0.0, high: 2.0 },
```

Apply the same 6 additions to `REFINEMENT_PARAM_SPACE` (around line 69).

- [ ] **Step 2: Update mapOptunaParamsToRequest**

Find `mapOptunaParamsToRequest` (line 470 per the earlier exploration). The function currently maps a few specific generator weights to combinerConfig fields. Extend it to map all 11. The existing pattern:

```typescript
combinerConfig: {
  momentumWeight: params['combiner.momentumWeight'],
  meanReversionWeight: params['combiner.meanReversionWeight'],
  ...
}
```

becomes:

```typescript
combinerConfig: {
  momentumWeight: params['combiner.momentumWeight'],
  meanReversionWeight: params['combiner.meanReversionWeight'],
  ofiWeight: params['combiner.ofiWeight'],
  mlofiWeight: params['combiner.mlofiWeight'],
  hawkesWeight: params['combiner.hawkesWeight'],
  volumeAnomalyWeight: params['combiner.volumeAnomalyWeight'],
  spreadCompressionWeight: params['combiner.spreadCompressionWeight'],
  crossMarketCorrWeight: params['combiner.crossMarketCorrWeight'],
  priceDivergenceWeight: params['combiner.priceDivergenceWeight'],
  attentionSpikeWeight: params['combiner.attentionSpikeWeight'],
  newsSentimentWeight: params['combiner.newsSentimentWeight'],
  minCombinedConfidence: params['combiner.minCombinedConfidence'],
  minCombinedStrength: params['combiner.minCombinedStrength'],
  onlyDirection: params['combiner.onlyDirection'],
},
```

If `BacktestService` does not already accept these new combiner fields, add them to the type definition for `BacktestRequest.combinerConfig` in BacktestService.ts and pass them through to the combiner constructor in the backtest's combiner setup. Look for the existing pattern in BacktestService where `combinerConfig.momentumWeight` is consumed and add parallel cases for each new key.

- [ ] **Step 3: Update updateStrategy to write per-type rows**

Find `updateStrategy` (line 755 per earlier read). Change the signature:

```typescript
// Before:
private async updateStrategy(result: OptimizationResult): Promise<void>

// After:
private async updateStrategy(result: OptimizationResult, marketType: string): Promise<void>
```

In the body, find the loop that calls `signalWeightsRepo.update(signalType, weight, ...)` (around line 827-839 per earlier read). Replace the call:

```typescript
// Before:
await signalWeightsRepo.update(signalType, weight, `optimization-${new Date().toISOString().slice(0, 10)}`);

// After:
await signalWeightsRepo.updatePerType(
  signalType,
  marketType,
  weight,
  `optimization-${new Date().toISOString().slice(0, 10)}-${marketType}`
);
```

Update `state.bestSharpePerType[marketType] = result.sharpe` (line 783 per earlier read; replace the existing `state.bestSharpe = result.sharpe`).

The `direction_multiplier` enforcement and `consensus_discount_floor` rows stay in the legacy `update()` path (they remain global, not per-type).

- [ ] **Step 4: Type check**

```bash
pnpm exec tsc -p packages/dashboard/tsconfig.json --noEmit
```

Expected: no errors. If errors mention missing properties on `combinerConfig`, add them to the BacktestService type definition.

- [ ] **Step 5: Run dashboard tests**

```bash
pnpm exec vitest run packages/dashboard/src/services
```

Expected: most tests pass. Some `OptimizationScheduler` tests may fail if they assert on the old single `bestSharpe` field or call methods with the old signatures — fix the test setup to match the new per-type signatures.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/src/services/OptimizationScheduler.ts packages/dashboard/src/services/BacktestService.ts
git commit -m "feat(optimizer): expand param space to 11 generators; per-type updateStrategy"
```

---

### Task 9: Full test + typecheck gate

Cross-package regression check before merge.

**Files:** None modified.

- [ ] **Step 1: Run signals package full suite**

```bash
pnpm exec vitest run packages/signals/src
```

Expected: all pass. ~191 tests + the new combiner test.

- [ ] **Step 2: Run dashboard package full suite**

```bash
pnpm exec vitest run packages/dashboard/src
```

Expected: all pass. May take 10-15 min on slow CI; locally ~5 min. Skipped tests count should match pre-change baseline.

- [ ] **Step 3: Typecheck both packages**

```bash
pnpm exec tsc -p packages/signals/tsconfig.json --noEmit && \
pnpm exec tsc -p packages/dashboard/tsconfig.json --noEmit
```

Expected: zero errors from either.

- [ ] **Step 4: No commit needed** — verification only.

---

### Task 10: Post-deploy smoke verification on VM

Runs after merge and CI deploy. Confirms the runtime behavior matches the design.

**Files:** None modified.

- [ ] **Step 1: Confirm deploy reached the VM**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command "cd /home/Usuario/polymarket-trader && git log --oneline -3"
```

Expected: top commit is the merged PR's squashed commit on main. If VM is behind, follow the deploy-recovery flow in the daily-autoreview-analysis skill (manual `git pull && docker compose pull && docker compose up -d`).

- [ ] **Step 2: Verify schema migration applied**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command "docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"SELECT COUNT(*) AS per_type_rows FROM signal_weights WHERE market_type != '__global__';\""
```

Expected: `per_type_rows >= 55` (5 types × 11 generators bootstrap). If 0, the post-init hook didn't run or failed silently — check dashboard logs.

- [ ] **Step 3: Verify SignalEngine startup sync log**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command "docker compose -f /home/Usuario/polymarket-trader/docker-compose.gcp.yml logs --since 10m dashboard-api 2>&1 | grep 'Synced typeWeights'"
```

Expected: a log line `[SignalEngine] Synced typeWeights from database: 5 types`. If 0 types, the migration did not produce per-type rows; investigate.

- [ ] **Step 4: Wait for first per-type optimizer cycle (within 6h post-deploy)**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command "docker compose -f /home/Usuario/polymarket-trader/docker-compose.gcp.yml logs --since 6h dashboard-api 2>&1 | grep -E '\\[OptimizationScheduler\\] === (crypto_intraday|crypto_daily|event_financial|event_short|event_long) ==='"
```

Expected: 5 log lines (one per market_type) indicating the per-type loop iterated. After incremental_cron `0 */6 * * *` fires, this should be visible.

- [ ] **Step 5: Verify at least one type's per-type rows updated**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command "docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"SELECT market_type, MAX(updated_at)::timestamp(0) AS last_updated FROM signal_weights WHERE market_type != '__global__' GROUP BY market_type ORDER BY last_updated DESC;\""
```

Expected (within 24h): at least one market_type's `last_updated` is later than the deploy timestamp, indicating the optimizer wrote new values for that type. If all rows still have the bootstrap timestamp, either no run completed, all OOS gates failed, or no run improved on `bestSharpePerType[type]`.

- [ ] **Step 6: No commit needed** — verification only.

---

## Self-Review Notes

**Spec coverage:**
- Schema (Section "Architecture", "Components") → Tasks 1, 2.
- signalWeightsRepo methods (Section "Components / repositories.ts") → Task 3.
- Combiner constructor change (Section "Components / WeightedAverageCombiner.ts") → Task 4.
- SignalEngine sync (Section "Components / SignalEngine.ts") → Task 5.
- BacktestService filter (Section "Components / BacktestService.ts") → Task 6.
- OptimizationScheduler refactor (Section "Components / OptimizationScheduler.ts") → Tasks 7, 8.
- Bootstrap values (Section "Bootstrap Values") → Tasks 1, 2 (literal values copied).
- Data flow cases (Section "Data Flow") → covered by Tasks 4, 5, 7 implementations.
- Migration / Deploy (Section "Migration / Deploy") → Tasks 1, 2, 10.
- Out of scope (Section "Out of Scope") → respected throughout (no per-type thresholds, no signal_weights_history changes, no fitness function change).
- Error handling (Section "Error Handling") → covered by try/catch in Tasks 5, 7.
- Testing (Section "Testing") → covered by Tasks 4, 9, 10.
- Success criteria (Section "Success Criteria") → covered by Task 10 smoke checks.

**Type consistency:**
- `MarketType` literal type defined in Task 7, used in Tasks 7, 8.
- `signalWeightsRepo.getAllPerType()` return type `Record<string, Record<string, number>>` consistent across Tasks 3, 5.
- `signalWeightsRepo.updatePerType(signalType, marketType, weight, reason)` signature consistent across Tasks 3, 8.
- `state.bestSharpePerType: Record<string, number>` consistent across Tasks 7, 8.
- `runOptimization(iterations, type, marketType)` signature consistent across Tasks 7, 8.
- `runOOSAndPersist(best, marketType)` signature consistent across Tasks 7, 8.

**No placeholders detected.** All steps have concrete code blocks, exact commands, and explicit expected outputs.
