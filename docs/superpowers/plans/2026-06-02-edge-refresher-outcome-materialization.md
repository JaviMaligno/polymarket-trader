# EdgeCapacityRefresher Outcome Materialization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the `EdgeCapacityRefresher` 600s timeout on `event_short`/`event_long` by precomputing each prediction's 4h-forward outcome once into a dedicated table that the nightly refresher reads instead of the per-row correlated `price_history` subquery.

**Architecture:** A new hypertable `generator_prediction_outcomes` is filled incrementally by an hourly job (`materializePredictionOutcomes`, in `MarketPerformanceTracker.ts`, mirroring `resolveShadowTrades`) that seeks the 4h-forward YES price on hot/uncompressed data. The refresher's `buildPerTypeSQL` is rewritten to read only this table — no `generator_predictions` heap-fetch, no `price_history` seek, no `random()` sampling. A one-shot backfill script fills the initial 7-day window.

**Tech Stack:** TypeScript, TimescaleDB (hypertables, compression, retention), `pg` via `query()` helper, vitest, node-cron.

**Spec:** `docs/superpowers/specs/2026-06-02-edge-refresher-outcome-materialization-design.md`

---

## File Structure

- **Create** `packages/data-collector/src/database/init/035_generator_prediction_outcomes.sql` — schema (hypertable + index + compression + retention).
- **Modify** `packages/data-collector/src/services/MarketPerformanceTracker.ts` — add `materializePredictionOutcomes()`.
- **Modify** `packages/data-collector/src/services/MarketPerformanceTracker.test.ts` — tests for the new function.
- **Modify** `packages/data-collector/src/services/Scheduler.ts` — register the hourly cron + runJob case + handler + import.
- **Modify** `packages/data-collector/src/services/Scheduler.test.ts` — assert the cron is registered + dispatched.
- **Modify** `packages/data-collector/src/services/EdgeCapacityRefresher.ts` — rewrite `buildPerTypeSQL`; drop `sampleSize`; `resolveEdgeRefreshConfig` returns only `perTypeTimeoutMs`.
- **Modify** `packages/data-collector/src/services/EdgeCapacityRefresher.test.ts` — update SQL-shape assertions; drop sampleSize assertions.
- **Create** `scripts/backfill-prediction-outcomes.js` — one-shot offline backfill.

Note on naming: `MarketPerformanceTracker.test.ts` may not exist yet. If it does not, create it with the vitest scaffold shown in Task 2 Step 1.

---

## Task 1: Migration — `generator_prediction_outcomes` schema

**Files:**
- Create: `packages/data-collector/src/database/init/035_generator_prediction_outcomes.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- Materialized 4h-forward outcomes for generator_predictions.
--
-- Root cause (daily-review #297, EXPLAIN ANALYZE 2026-06-02): the nightly
-- EdgeCapacityRefresher recomputed a correlated price_history forward-seek per
-- sampled prediction on every run, over compressed chunks → event_short/
-- event_long exceeded the 600s cap. This table precomputes y1 (the YES price at
-- prediction_time + horizon) ONCE, when the prediction matures, so the refresher
-- reads a small purpose-built table instead. See
-- docs/superpowers/specs/2026-06-02-edge-refresher-outcome-materialization-design.md
--
-- Denormalizes signal_id/direction/y0/market_type from generator_predictions.
-- These are immutable at signal time (cold duplication, no divergence risk).
-- market_type is stored frozen — exact parity with the refresher's current
-- WHERE generator_predictions.market_type filter.

CREATE TABLE IF NOT EXISTS generator_prediction_outcomes (
    prediction_id    BIGINT NOT NULL,
    prediction_time  TIMESTAMPTZ NOT NULL,
    market_id        VARCHAR(128) NOT NULL,
    market_type      VARCHAR(32),
    signal_id        VARCHAR(50) NOT NULL,
    direction        VARCHAR(8)  NOT NULL,
    y0               NUMERIC(10,6) NOT NULL,
    y1               NUMERIC(10,6),
    horizon_hours    INT NOT NULL DEFAULT 4,
    no_forward_price BOOLEAN NOT NULL DEFAULT FALSE,
    computed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- PK includes prediction_time: TimescaleDB requires the partition column in
    -- every unique constraint. Mirrors generator_predictions' (time, id) PK.
    PRIMARY KEY (prediction_time, prediction_id, horizon_hours)
);

SELECT create_hypertable('generator_prediction_outcomes', 'prediction_time',
    chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);

-- Serves the refresher's WHERE market_type=$1 AND direction IN(...) AND
-- prediction_time >= NOW()-7d filter directly (index-covering, no heap-fetch).
CREATE INDEX IF NOT EXISTS idx_gpo_type_dir_time
    ON generator_prediction_outcomes (market_type, direction, prediction_time DESC);

ALTER TABLE generator_prediction_outcomes SET (timescaledb.compress_after = '3 days');
SELECT add_retention_policy('generator_prediction_outcomes', INTERVAL '14 days', if_not_exists => TRUE);
```

- [ ] **Step 2: Verify SQL parses against the local pattern**

This file is pure SQL run by `init/*.sql` on a fresh volume only. There is no unit test; correctness is validated by Task 6 (manual VM apply) and by the function tests that mock `query`. Confirm the statement ordering matches sibling files (`030_generator_predictions.sql`): `CREATE TABLE` → `create_hypertable` → indexes → compression → retention.

Run: `node -e "const fs=require('fs');const s=fs.readFileSync('packages/data-collector/src/database/init/035_generator_prediction_outcomes.sql','utf8');if(!s.includes('create_hypertable'))process.exit(1);console.log('ok')"`
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add packages/data-collector/src/database/init/035_generator_prediction_outcomes.sql
git commit -m "feat(edge-refresher): add generator_prediction_outcomes schema (migration 035)"
```

---

## Task 2: `materializePredictionOutcomes()` — the incremental job

**Files:**
- Modify: `packages/data-collector/src/services/MarketPerformanceTracker.ts`
- Test: `packages/data-collector/src/services/MarketPerformanceTracker.test.ts`

- [ ] **Step 1: Write the failing tests**

If `MarketPerformanceTracker.test.ts` does not exist, create it with this content. If it exists, append the new `describe` block.

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../database/connection.js', () => ({
  query: vi.fn(),
}));

import { materializePredictionOutcomes } from './MarketPerformanceTracker.js';
import { query } from '../database/connection.js';

describe('materializePredictionOutcomes', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('materializes a matured prediction with a forward price', async () => {
    const inserts: any[][] = [];
    (query as any).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM generator_predictions g')) {
        return { rows: [{
          id: '101', time: new Date('2026-06-02T00:00:00Z'), market_id: 'm1',
          market_type: 'event_short', signal_id: 'momentum', direction: 'long',
          yes_price_at_signal: '0.40', age_hours: '6',
        }]};
      }
      if (sql.includes('FROM price_history')) {
        return { rows: [{ close: 0.47 }] };
      }
      if (sql.startsWith('INSERT INTO generator_prediction_outcomes')) {
        inserts.push(params ?? []);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await materializePredictionOutcomes();
    expect(res.materialized).toBe(1);
    expect(res.noPrice).toBe(0);
    // params: prediction_id, prediction_time, market_id, market_type,
    //         signal_id, direction, y0, y1, horizon_hours, no_forward_price
    expect(inserts).toHaveLength(1);
    expect(inserts[0][0]).toBe('101');
    expect(inserts[0][7]).toBe(0.47);          // y1
    expect(inserts[0][9]).toBe(false);         // no_forward_price
  });

  it('marks no_forward_price=true when matured >8h with no forward price', async () => {
    const inserts: any[][] = [];
    (query as any).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM generator_predictions g')) {
        return { rows: [{
          id: '102', time: new Date('2026-06-01T00:00:00Z'), market_id: 'm2',
          market_type: 'event_long', signal_id: 'ofi', direction: 'short',
          yes_price_at_signal: '0.30', age_hours: '20',
        }]};
      }
      if (sql.includes('FROM price_history')) return { rows: [] }; // no forward price
      if (sql.startsWith('INSERT INTO generator_prediction_outcomes')) {
        inserts.push(params ?? []);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await materializePredictionOutcomes();
    expect(res.materialized).toBe(0);
    expect(res.noPrice).toBe(1);
    expect(inserts[0][7]).toBe(null);          // y1
    expect(inserts[0][9]).toBe(true);          // no_forward_price
  });

  it('skips a matured-but-young prediction (<8h) with no price yet (retried later)', async () => {
    const inserts: any[][] = [];
    (query as any).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM generator_predictions g')) {
        return { rows: [{
          id: '103', time: new Date('2026-06-02T06:00:00Z'), market_id: 'm3',
          market_type: 'event_short', signal_id: 'hawkes', direction: 'long',
          yes_price_at_signal: '0.50', age_hours: '6',
        }]};
      }
      if (sql.includes('FROM price_history')) return { rows: [] }; // no price yet
      if (sql.startsWith('INSERT INTO generator_prediction_outcomes')) {
        inserts.push(params ?? []);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await materializePredictionOutcomes();
    expect(res.materialized).toBe(0);
    expect(res.noPrice).toBe(0);
    expect(inserts).toHaveLength(0);           // nothing written → retried next run
  });

  it('a failing forward-seek does not abort the batch', async () => {
    let inserts = 0;
    (query as any).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM generator_predictions g')) {
        return { rows: [
          { id: '201', time: new Date('2026-06-02T00:00:00Z'), market_id: 'mA', market_type: 'event_short', signal_id: 's', direction: 'long', yes_price_at_signal: '0.4', age_hours: '6' },
          { id: '202', time: new Date('2026-06-02T00:00:00Z'), market_id: 'mB', market_type: 'event_short', signal_id: 's', direction: 'long', yes_price_at_signal: '0.4', age_hours: '6' },
        ]};
      }
      if (sql.includes('FROM price_history')) {
        throw new Error('simulated seek failure');
      }
      if (sql.startsWith('INSERT INTO generator_prediction_outcomes')) { inserts++; return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    });
    await expect(materializePredictionOutcomes()).resolves.toBeDefined();
    expect(inserts).toBe(0); // both seeks failed, none inserted, no throw
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/data-collector && rtk vitest run src/services/MarketPerformanceTracker.test.ts`
Expected: FAIL — `materializePredictionOutcomes is not a function` / not exported.

- [ ] **Step 3: Implement `materializePredictionOutcomes`**

Add to `packages/data-collector/src/services/MarketPerformanceTracker.ts` (after `resolveShadowTrades`, before `updateShadowCategoryPerformance`):

```typescript
/**
 * Phase 5 / daily-review #297: materialize the 4h-forward outcome (y1) per
 * generator_prediction ONCE, when it matures, into generator_prediction_outcomes.
 * The nightly EdgeCapacityRefresher then reads that table instead of recomputing
 * a correlated price_history seek per sampled row over compressed chunks (the
 * >600s timeout root cause). Idempotent via NOT EXISTS; runs hourly on hot data.
 *
 * Maturity rule:
 *  - age < horizon+1h         → not selected (too young to have a forward price).
 *  - horizon+1h ≤ age < 8h, no price → left unwritten, retried next run (price
 *                              may arrive late after a transient collector gap).
 *  - age ≥ 8h, no price       → written with y1=NULL, no_forward_price=true
 *                              (processed; never retried — market stopped quoting/resolved).
 *  - price found              → written with y1, no_forward_price=false.
 */
export async function materializePredictionOutcomes(
  opts: { horizonHours?: number } = {},
): Promise<{ materialized: number; noPrice: number }> {
  const horizon = opts.horizonHours ?? 4;

  const pending = await query<{
    id: string;
    time: Date;
    market_id: string;
    market_type: string | null;
    signal_id: string;
    direction: string;
    yes_price_at_signal: string;
    age_hours: string;
  }>(
    `SELECT g.id, g.time, g.market_id, g.market_type, g.signal_id, g.direction,
            g.yes_price_at_signal,
            EXTRACT(EPOCH FROM (NOW() - g.time)) / 3600.0 AS age_hours
     FROM generator_predictions g
     WHERE g.time >= NOW() - INTERVAL '8 days'
       AND g.time <  NOW() - INTERVAL '${horizon + 1} hours'
       AND g.direction IN ('long','short')
       AND NOT EXISTS (
         SELECT 1 FROM generator_prediction_outcomes o
         WHERE o.prediction_id = g.id AND o.horizon_hours = $1
       )`,
    [horizon],
  );

  if (pending.rows.length === 0) {
    return { materialized: 0, noPrice: 0 };
  }

  logger.info({ count: pending.rows.length, horizon }, 'Materializing prediction outcomes');

  let materialized = 0;
  let noPrice = 0;

  for (const row of pending.rows) {
    try {
      const fwd = await query<{ close: number }>(
        `SELECT close::float AS close FROM price_history
         WHERE market_id = $1
           AND time >= $2::timestamptz + INTERVAL '${horizon} hours'
           AND time <  $2::timestamptz + INTERVAL '${horizon + 1} hours'
         ORDER BY time ASC LIMIT 1`,
        [row.market_id, row.time],
      );

      const y1 = fwd.rows.length > 0 ? Number(fwd.rows[0].close) : null;
      const ageHours = Number(row.age_hours);

      if (y1 === null && ageHours < 8) {
        // Too young to give up; leave unwritten so the next run retries.
        continue;
      }

      await query(
        `INSERT INTO generator_prediction_outcomes
           (prediction_id, prediction_time, market_id, market_type, signal_id,
            direction, y0, y1, horizon_hours, no_forward_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (prediction_time, prediction_id, horizon_hours) DO NOTHING`,
        [row.id, row.time, row.market_id, row.market_type, row.signal_id,
         row.direction, Number(row.yes_price_at_signal), y1, horizon, y1 === null],
      );

      if (y1 === null) noPrice++; else materialized++;
    } catch (err) {
      logger.warn({ predictionId: row.id, err: (err as Error).message },
        'materializePredictionOutcomes: row failed (non-fatal)');
    }
  }

  logger.info({ materialized, noPrice }, 'Prediction outcomes materialized');
  return { materialized, noPrice };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/data-collector && rtk vitest run src/services/MarketPerformanceTracker.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/data-collector/src/services/MarketPerformanceTracker.ts packages/data-collector/src/services/MarketPerformanceTracker.test.ts
git commit -m "feat(edge-refresher): materializePredictionOutcomes incremental job"
```

---

## Task 3: Register the hourly cron in `Scheduler.ts`

**Files:**
- Modify: `packages/data-collector/src/services/Scheduler.ts` (import ~line 15; defineJob block ~line 108-121; runJob switch ~line 255-279; handlers ~line 521-555)
- Test: `packages/data-collector/src/services/Scheduler.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `Scheduler.test.ts`. The existing mock of `../database/connection.js` already covers `query`. Add a mock for the new function on `MarketPerformanceTracker`. Add near the top imports if not present:

```typescript
vi.mock('./MarketPerformanceTracker.js', () => ({
  updateCategoryPriors: vi.fn().mockResolvedValue(undefined),
  updateShadowCategoryPerformance: vi.fn().mockResolvedValue(undefined),
  resolveShadowTrades: vi.fn().mockResolvedValue(undefined),
  materializePredictionOutcomes: vi.fn().mockResolvedValue({ materialized: 0, noPrice: 0 }),
}));
```

Then add the test:

```typescript
import { materializePredictionOutcomes } from './MarketPerformanceTracker.js';

describe('Scheduler — materialize-prediction-outcomes cron', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('runJob("materialize-prediction-outcomes") invokes materializePredictionOutcomes', async () => {
    const scheduler = new Scheduler();
    await scheduler.runJob('materialize-prediction-outcomes');
    expect(materializePredictionOutcomes).toHaveBeenCalledTimes(1);
  });

  it('registers the job at hourly :15', () => {
    const scheduler = new Scheduler();
    const job = (scheduler as any).jobs.get('materialize-prediction-outcomes');
    expect(job).toBeDefined();
    expect(job.schedule).toBe('15 * * * *');
  });
});
```

Note: the job registry is `this.jobs` (a `Map<string, {name, schedule, task, ...}>` populated by `defineJob` at line 127-139), so `(scheduler as any).jobs.get('materialize-prediction-outcomes').schedule` is the correct access path.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/data-collector && rtk vitest run src/services/Scheduler.test.ts`
Expected: FAIL — job not registered / `materializePredictionOutcomes` not called (falls through to default handler).

- [ ] **Step 3: Implement — import, defineJob, runJob case, handler**

3a. Add to the `MarketPerformanceTracker` import (~line 15, alongside `resolveShadowTrades`):

```typescript
  materializePredictionOutcomes,
```

3b. Add a `defineJob` line in the registration block (after line 119, the `refresh-edge-capacity` line):

```typescript
    // daily-review #297: materialize 4h-forward outcomes hourly so the nightly
    // refresher reads a precomputed table instead of a per-row price_history
    // seek. :15 to avoid colliding with the :00/:30 jobs.
    this.defineJob('materialize-prediction-outcomes', '15 * * * *', this.materializePredictionOutcomes.bind(this));
```

3c. Add a case in the `runJob` switch (after the `refresh-edge-capacity` case at line 273). The #224 lesson: a job with no switch case fires but silently no-ops.

```typescript
        case 'materialize-prediction-outcomes':
          await this.materializePredictionOutcomes();
          break;
```

3d. Add the private handler (near `refreshEdgeCapacity` at ~line 533):

```typescript
  /**
   * daily-review #297: incremental materialization of generator_prediction_outcomes.
   * Hourly at :15. Cheap (only matured-in-last-hour predictions on hot data).
   */
  private async materializePredictionOutcomes(): Promise<void> {
    await materializePredictionOutcomes();
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/data-collector && rtk vitest run src/services/Scheduler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/data-collector/src/services/Scheduler.ts packages/data-collector/src/services/Scheduler.test.ts
git commit -m "feat(edge-refresher): hourly materialize-prediction-outcomes cron + runJob case"
```

---

## Task 4: Rewrite `buildPerTypeSQL` to read outcomes; drop sampling

**Files:**
- Modify: `packages/data-collector/src/services/EdgeCapacityRefresher.ts` (`buildPerTypeSQL` ~line 145-205; `measureCellsForType` ~line 215; `refreshEdgeCapacity` `sampleSize` plumbing ~line 344-440; `resolveEdgeRefreshConfig` ~line 331)
- Test: `packages/data-collector/src/services/EdgeCapacityRefresher.test.ts`

- [ ] **Step 1: Update the failing tests (new SQL shape, no sampling)**

In `EdgeCapacityRefresher.test.ts`:

4a. Replace the `resolveEdgeRefreshConfig` describe block (lines 14-41) with one that expects only `perTypeTimeoutMs`:

```typescript
describe('resolveEdgeRefreshConfig (env-overridable per-type timeout backstop)', () => {
  it('empty env → default timeout 600s', () => {
    expect(resolveEdgeRefreshConfig({})).toEqual({ perTypeTimeoutMs: 600_000 });
  });
  it('valid env value is honored', () => {
    expect(resolveEdgeRefreshConfig({ EDGE_REFRESH_PER_TYPE_TIMEOUT_MS: '900000' }))
      .toEqual({ perTypeTimeoutMs: 900_000 });
  });
  it('invalid env values fall back to default', () => {
    expect(resolveEdgeRefreshConfig({ EDGE_REFRESH_PER_TYPE_TIMEOUT_MS: '0' }).perTypeTimeoutMs).toBe(600_000);
    expect(resolveEdgeRefreshConfig({ EDGE_REFRESH_PER_TYPE_TIMEOUT_MS: 'abc' }).perTypeTimeoutMs).toBe(600_000);
  });
});
```

4b. In the integration block, every mock branch that matches `sql.includes('FROM generator_predictions')` for the PER-TYPE query must change to `sql.includes('FROM generator_prediction_outcomes')`. Update these branches in the tests at lines 136, 173, 202, 224, 238, 276, 302, 321. (The `SELECT DISTINCT market_type` branch stays as-is — it still reads `markets`.)

4c. Replace the two SQL-shape tests (lines 190-229) with:

```typescript
  it('per-type SQL reads generator_prediction_outcomes with window + horizon filter, no price_history, no random()', async () => {
    const capturedSql: string[] = [];
    (query as any).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('SELECT DISTINCT market_type')) {
        return { rows: [{ market_type: 'event_long' }] };
      }
      if (typeof sql === 'string') capturedSql.push(sql);
      return { rows: [], rowCount: 0 };
    });

    await refreshEdgeCapacity({ windowDays: 3, horizonHours: 6, minN: 100 });

    const stmt = capturedSql.find(s => s.includes('FROM generator_prediction_outcomes'));
    expect(stmt).toBeDefined();
    expect(stmt).toContain("INTERVAL '3 days'");
    expect(stmt).toContain('horizon_hours = 6');
    expect(stmt).toContain('y1 IS NOT NULL');
    expect(stmt).not.toContain('price_history');
    expect(stmt).not.toContain('random()');
    expect(stmt).not.toContain('FROM generator_predictions g');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/data-collector && rtk vitest run src/services/EdgeCapacityRefresher.test.ts`
Expected: FAIL — SQL still contains `price_history`/`random()`; `resolveEdgeRefreshConfig` still returns `sampleSize`.

- [ ] **Step 3: Rewrite `buildPerTypeSQL`**

Replace the entire `buildPerTypeSQL` function (lines 145-205) with:

```typescript
/**
 * Build the t-stat SQL for a single market_type, reading the precomputed
 * generator_prediction_outcomes table (daily-review #297). No price_history
 * seek, no sampling — the table is small and index-served by
 * idx_gpo_type_dir_time. gross_edge uses y0/y1 already present per row.
 *
 * `${marketType}` is NOT interpolated — it binds through $1. Only numeric
 * server-controlled values (windowDays, horizonHours) interpolate.
 */
function buildPerTypeSQL(marketType: string, windowDays: number, horizonHours: number): string {
  return `
    WITH edges AS (
      SELECT signal_id, market_type, direction,
             CASE WHEN direction='long' THEN y1 - y0 ELSE y0 - y1 END AS gross_edge
      FROM generator_prediction_outcomes
      WHERE prediction_time >= NOW() - INTERVAL '${windowDays} days'
        AND market_type = $1
        AND direction IN ('long','short')
        AND horizon_hours = ${horizonHours}
        AND y1 IS NOT NULL
    )
    SELECT
      signal_id, market_type, direction,
      COUNT(*)::int AS n,
      (AVG(gross_edge) * 100)::float AS gross_pct,
      CASE WHEN STDDEV(gross_edge) > 0 THEN
        (AVG(gross_edge) * SQRT(COUNT(*)) / STDDEV(gross_edge))::float
      END AS t_gross
    FROM edges
    GROUP BY 1, 2, 3
  `;
}
```

- [ ] **Step 4: Update `measureCellsForType` and `refreshEdgeCapacity` to drop sampleSize**

4a. In `measureCellsForType` (line 215), remove the `sampleSize` parameter and update the `buildPerTypeSQL` call:

```typescript
async function measureCellsForType(
  marketType: string,
  windowDays: number,
  horizonHours: number,
  timeoutMs: number,
): Promise<Cell[] | null> {
  const sql = buildPerTypeSQL(marketType, windowDays, horizonHours);
  // ... rest unchanged (Promise.race timeout, row mapping) ...
```

4b. In `RefreshOptions` (line 67-84), remove the `sampleSize?: number;` field and its comment block (lines 74-78).

4c. In `refreshEdgeCapacity` (line 344): remove the `sampleSize` const (line 353) and update the `measureCellsForType` call (line 388) and the `persistCellsToHistory` call. `persistCellsToHistory` currently takes `sampleSize` and writes it to `generator_edge.sample_size`. Pass `null` (the column is nullable; sampling is gone). Update the `source` default string (line 364-365) to drop `(sample N=...)`:

```typescript
  const source = options.source ??
    `EdgeCapacityRefresher cron ${new Date().toISOString().slice(0, 10)} (full)`;
```

Update the call (line 388):

```typescript
    const cells = await measureCellsForType(marketType, windowDays, horizonHours, perTypeTimeoutMs);
```

Update the `persistCellsToHistory` call (line 405-407) — pass `null` for the sampleSize arg:

```typescript
    await persistCellsToHistory(
      cells, rtForType, windowDays, horizonHours, null, source, minN,
    ).catch((err) => {
```

4d. Rewrite `resolveEdgeRefreshConfig` (lines 331-342) to return only the timeout:

```typescript
export function resolveEdgeRefreshConfig(
  env: Record<string, string | undefined> = process.env,
): { perTypeTimeoutMs: number } {
  const posIntOr = (raw: string | undefined, def: number): number => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
  };
  return {
    perTypeTimeoutMs: posIntOr(env.EDGE_REFRESH_PER_TYPE_TIMEOUT_MS, 600_000),
  };
}
```

4e. Update the `refreshEdgeCapacity` destructure of options to drop `sampleSize` (line 353 area). Remove the line `const sampleSize = options.sampleSize ?? 10000;` and the long comment above `perTypeTimeoutMs` referencing sampleSize; keep `const perTypeTimeoutMs = options.perTypeTimeoutMs ?? 600_000;`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/data-collector && rtk vitest run src/services/EdgeCapacityRefresher.test.ts`
Expected: PASS. (`computeEdgeCapacity`/`getLatestEdgePerCell`/persistence tests unchanged and still green.)

- [ ] **Step 6: Update `Scheduler.refreshEdgeCapacity` caller (sampleSize removed)**

In `Scheduler.ts` `refreshEdgeCapacity` handler (~line 533-555): `resolveEdgeRefreshConfig()` now returns only `{ perTypeTimeoutMs }`. Update the destructure and the `refreshEdgeCapacity({...})` call to no longer pass `sampleSize`:

```typescript
    const { perTypeTimeoutMs } = resolveEdgeRefreshConfig();
    const allowedTypes = parseAllowedMarketTypes(process.env.EDGE_REFRESH_ALLOWED_TYPES);
    await refreshEdgeCapacity({
      windowDays: 7,
      horizonHours: 4,
      defaultRtCost: 0.01,
      minN: 50,
      perTypeTimeoutMs,
      allowedTypes,
    });
```

Update the `Scheduler.test.ts` mock of `resolveEdgeRefreshConfig` (line 14) to return `{ perTypeTimeoutMs: 600_000 }` (drop `sampleSize`).

- [ ] **Step 7: Run the full data-collector suite**

Run: `cd packages/data-collector && rtk vitest run src/services/EdgeCapacityRefresher.test.ts src/services/Scheduler.test.ts src/services/MarketPerformanceTracker.test.ts`
Expected: PASS across all three.

- [ ] **Step 8: Typecheck**

Run: `cd packages/data-collector && rtk tsc --noEmit`
Expected: no errors (catches any missed `sampleSize` reference).

- [ ] **Step 9: Commit**

```bash
git add packages/data-collector/src/services/EdgeCapacityRefresher.ts packages/data-collector/src/services/EdgeCapacityRefresher.test.ts packages/data-collector/src/services/Scheduler.ts packages/data-collector/src/services/Scheduler.test.ts
git commit -m "feat(edge-refresher): read generator_prediction_outcomes; drop price_history seek + sampling"
```

---

## Task 5: One-shot backfill script

**Files:**
- Create: `scripts/backfill-prediction-outcomes.js`

- [ ] **Step 1: Write the script**

Mirrors the `materializePredictionOutcomes` SQL but without the 8-day floor (covers the full 7-day window the refresher reads) and without a per-row maturity skip (all rows are old enough at backfill time). Plain Node + `pg`, like sibling scripts.

```javascript
#!/usr/bin/env node
/**
 * One-shot backfill for generator_prediction_outcomes (daily-review #297).
 *
 * Run ONCE on the VM after deploying the materialization job + creating the
 * table, to fill the initial 7-day window the EdgeCapacityRefresher reads.
 * This pass touches compressed price_history chunks (expensive), so it runs
 * offline without the cron's 600s cap. The hourly job keeps the table current
 * thereafter.
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 DATABASE_URL="postgres://..." \
 *     node scripts/backfill-prediction-outcomes.js [--window-days 8] [--horizon 4]
 */
const { Pool } = require('pg');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function main() {
  const windowDays = parseInt(arg('window-days', '8'), 10);
  const horizon = parseInt(arg('horizon', '4'), 10);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const pending = await pool.query(
    `SELECT g.id, g.time, g.market_id, g.market_type, g.signal_id, g.direction,
            g.yes_price_at_signal
     FROM generator_predictions g
     WHERE g.time >= NOW() - INTERVAL '${windowDays} days'
       AND g.time <  NOW() - INTERVAL '${horizon + 1} hours'
       AND g.direction IN ('long','short')
       AND NOT EXISTS (
         SELECT 1 FROM generator_prediction_outcomes o
         WHERE o.prediction_id = g.id AND o.horizon_hours = $1
       )`,
    [horizon],
  );

  console.log(`Backfilling ${pending.rows.length} predictions (window ${windowDays}d, horizon ${horizon}h)`);
  let materialized = 0, noPrice = 0, errors = 0;

  for (const row of pending.rows) {
    try {
      const fwd = await pool.query(
        `SELECT close::float AS close FROM price_history
         WHERE market_id = $1
           AND time >= $2::timestamptz + INTERVAL '${horizon} hours'
           AND time <  $2::timestamptz + INTERVAL '${horizon + 1} hours'
         ORDER BY time ASC LIMIT 1`,
        [row.market_id, row.time],
      );
      const y1 = fwd.rows.length > 0 ? Number(fwd.rows[0].close) : null;
      await pool.query(
        `INSERT INTO generator_prediction_outcomes
           (prediction_id, prediction_time, market_id, market_type, signal_id,
            direction, y0, y1, horizon_hours, no_forward_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (prediction_time, prediction_id, horizon_hours) DO NOTHING`,
        [row.id, row.time, row.market_id, row.market_type, row.signal_id,
         row.direction, Number(row.yes_price_at_signal), y1, horizon, y1 === null],
      );
      if (y1 === null) noPrice++; else materialized++;
      if ((materialized + noPrice) % 5000 === 0) {
        console.log(`  ... ${materialized + noPrice}/${pending.rows.length}`);
      }
    } catch (e) {
      errors++;
      if (errors <= 10) console.error(`  row ${row.id} failed: ${e.message}`);
    }
  }

  console.log(`Done: materialized=${materialized} noPrice=${noPrice} errors=${errors}`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Lint-check (syntax only — no DB locally)**

Run: `node --check scripts/backfill-prediction-outcomes.js`
Expected: no output (valid syntax).

- [ ] **Step 3: Commit**

```bash
git add scripts/backfill-prediction-outcomes.js
git commit -m "feat(edge-refresher): one-shot backfill-prediction-outcomes script"
```

---

## Task 6: Deploy + verify on VM (manual, post-merge)

**Not code — operational. Do after the PR merges and CI builds the data-collector image.**

- [ ] **Step 1: Create the table + index manually on the VM** (init SQL only runs on a fresh volume)

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command \
  "docker cp - polymarket-timescaledb:/tmp/035.sql < /home/Usuario/polymarket-trader/packages/data-collector/src/database/init/035_generator_prediction_outcomes.sql 2>/dev/null; \
   docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -f /tmp/035.sql"
```

If `docker cp -` is awkward, `git pull` on the VM first, then `docker cp` the file path. Expected: `CREATE TABLE`, `create_hypertable`, `CREATE INDEX`, `ALTER TABLE`, retention policy added.

- [ ] **Step 2: Pull the new image + restart data-collector**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command \
  "cd /home/Usuario/polymarket-trader && git pull && docker compose -f docker-compose.gcp.yml pull data-collector && docker compose -f docker-compose.gcp.yml up -d --remove-orphans"
```

- [ ] **Step 3: Run the backfill**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command \
  "docker exec polymarket-data-collector sh -c 'DATABASE_URL=\"\$DATABASE_URL\" node /app/scripts/backfill-prediction-outcomes.js --window-days 8 --horizon 4'"
```
(If `scripts/` is not bundled into the data-collector image, copy it in first via `docker cp`, or run the equivalent from the host with the container `DATABASE_URL`.) Expected: `Done: materialized=<n> noPrice=<m> errors=<small>`.

- [ ] **Step 4: Sanity-check the table is populated per type**

```sql
SELECT market_type, COUNT(*) n, COUNT(*) FILTER (WHERE y1 IS NOT NULL) with_y1
FROM generator_prediction_outcomes
WHERE prediction_time >= NOW() - INTERVAL '7 days'
GROUP BY 1 ORDER BY 1;
```
Expected: all 4 active types present with `with_y1 > 0` (event_short the largest).

- [ ] **Step 5: Time the refresher end-to-end** (the binding lesson from #297 — measure the WHOLE query, not a sub-part)

```sql
\timing on
-- run the rewritten buildPerTypeSQL for event_short manually:
WITH edges AS (
  SELECT signal_id, market_type, direction,
         CASE WHEN direction='long' THEN y1 - y0 ELSE y0 - y1 END AS gross_edge
  FROM generator_prediction_outcomes
  WHERE prediction_time >= NOW() - INTERVAL '7 days'
    AND market_type = 'event_short' AND direction IN ('long','short')
    AND horizon_hours = 4 AND y1 IS NOT NULL
)
SELECT signal_id, COUNT(*), AVG(gross_edge)*100,
       AVG(gross_edge)*SQRT(COUNT(*))/NULLIF(STDDEV(gross_edge),0)
FROM edges GROUP BY 1;
```
Expected: well under 1s.

- [ ] **Step 6: Carry-over verification (next 02:30 UTC cron)**

The morning after deploy, in the daily-autoreview session, run:
```sql
SELECT market_type, MAX(measured_at), NOW()-MAX(measured_at) staleness
FROM generator_edge GROUP BY 1 ORDER BY 2 DESC;
```
Expected: all 4 types (incl. event_short, event_long) < 24h stale. Also confirm the cron log shows no `TIMEOUT` and the full refresher run < 60s. Update the ⏰ memory item with the verdict.

---

## Self-Review notes (completed)

- **Spec coverage:** schema (Task 1), materialization job + maturity/no-price rules (Task 2), hourly cron + runJob case (Task 3), refresher rewrite + sampling removal (Task 4), backfill (Task 5), deploy/verify incl. end-to-end timing (Task 6). All spec sections mapped.
- **Type consistency:** `materializePredictionOutcomes(): {materialized, noPrice}` used identically in Task 2 (def), Task 3 (mock/handler). `buildPerTypeSQL(marketType, windowDays, horizonHours)` 3-arg signature consistent across Task 4 def + `measureCellsForType` call. `resolveEdgeRefreshConfig(): {perTypeTimeoutMs}` consistent in Task 4d def + Task 6 Scheduler caller + Scheduler.test mock.
- **No placeholders:** every code step shows full code; SQL shape assertions name exact strings.
- **Known fragility:** Task 3's `vi.mock('./MarketPerformanceTracker.js')` is module-wide — it must export every symbol `Scheduler.ts` imports from that module (listed in the mock) or unrelated Scheduler tests break. Task 6 notes the `scripts/` image-bundling caveat.
```
