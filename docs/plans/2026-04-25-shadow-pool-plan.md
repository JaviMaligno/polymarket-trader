# Shadow Pool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the market tracking pool into a live lane (operates trades, restricted to `ALLOWED_MARKET_TYPES`) and a shadow lane (observes via `shadow_trades`, all other types), to break the closed loop trapping crypto markets in cold and end the 96h trade drought.

**Architecture:** Lane membership is derived dynamically per rotator query from the existing `markets.market_type` column and the `ALLOWED_MARKET_TYPES` env var — no schema change, no startup hook, no realignment job. `MarketRotator.rotate()` becomes `rotate(lane)`; new `rotateAll()` orchestrates both lanes per scheduler tick. ClobCollector / SignalEngine / AutoSignalExecutor get zero code change because the existing market-type gate at `AutoSignalExecutor.ts:462-481` already routes non-allowed signals to `shadow_trades`. The daily auto-review report and prompt are extended to surface promotion recommendations when shadow performance crosses thresholds.

**Tech Stack:** TypeScript + Node.js, Vitest, PostgreSQL/TimescaleDB, pino logging, pnpm monorepo, docker-compose. Spec: `docs/plans/2026-04-25-shadow-pool-design.md`.

---

## File Structure

| Path | Change | Responsibility |
|---|---|---|
| `packages/data-collector/src/services/MarketRotator.ts` | Modify | Lane-aware rotation: parse ALLOWED env, two configs, `rotate(lane)`, `rotateAll()`. |
| `packages/data-collector/src/services/MarketRotator.test.ts` | Modify | Cover lane filtering, config separation, `rotateAll()` orchestration. |
| `packages/data-collector/src/services/Scheduler.ts` | Modify (single line) | Call `rotateAll()` instead of `rotate()`. |
| `docker-compose.gcp.yml` | Modify | Add `ALLOWED_MARKET_TYPES` and `MAX_SHADOW_MARKETS` to `data-collector` container env. |
| `scripts/daily-review.sh` | Modify | Replace `shadow_summary` aggregation with richer per-type 30-day metrics (win rate, stddev, Sharpe). |
| `scripts/daily-review-prompt.md` | Modify | Add explicit promotion-recommendation block with thresholds. |

No new files. No schema migrations. No new packages.

---

### Task 1: `parseAllowedMarketTypes` helper

A pure function for parsing the env var. Isolating it makes the env-handling logic testable without instantiating the rotator.

**Files:**
- Modify: `packages/data-collector/src/services/MarketRotator.ts`
- Test: `packages/data-collector/src/services/MarketRotator.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `MarketRotator.test.ts`, in a new `describe` block before the existing `describe('MarketRotator', ...)`:

```typescript
import { parseAllowedMarketTypes } from './MarketRotator.js';

describe('parseAllowedMarketTypes', () => {
  it('returns empty array when env is undefined', () => {
    expect(parseAllowedMarketTypes(undefined)).toEqual([]);
  });

  it('returns empty array when env is empty string', () => {
    expect(parseAllowedMarketTypes('')).toEqual([]);
  });

  it('parses single value', () => {
    expect(parseAllowedMarketTypes('crypto_intraday')).toEqual(['crypto_intraday']);
  });

  it('parses comma-separated values', () => {
    expect(parseAllowedMarketTypes('crypto_intraday,crypto_daily,event_short')).toEqual([
      'crypto_intraday',
      'crypto_daily',
      'event_short',
    ]);
  });

  it('trims whitespace around values', () => {
    expect(parseAllowedMarketTypes(' crypto_intraday , event_short ')).toEqual([
      'crypto_intraday',
      'event_short',
    ]);
  });

  it('drops empty entries from trailing or duplicate commas', () => {
    expect(parseAllowedMarketTypes('crypto_intraday,,event_short,')).toEqual([
      'crypto_intraday',
      'event_short',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/data-collector && pnpm exec vitest run src/services/MarketRotator.test.ts -t 'parseAllowedMarketTypes'
```

Expected: FAIL with `Cannot find module './MarketRotator.js'` import error or `parseAllowedMarketTypes is not a function`.

- [ ] **Step 3: Implement the helper**

In `MarketRotator.ts`, immediately after the existing `MIN_CANDIDATE_SCORE` export (around line 6):

```typescript
/**
 * Parse the ALLOWED_MARKET_TYPES env value into a clean array.
 * Empty / undefined / whitespace-only entries are dropped.
 * An empty result means "no allowlist configured" — the live lane interprets
 * this as unrestricted (backward-compat) and the shadow lane as empty.
 */
export function parseAllowedMarketTypes(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/data-collector && pnpm exec vitest run src/services/MarketRotator.test.ts -t 'parseAllowedMarketTypes'
```

Expected: PASS, 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/data-collector/src/services/MarketRotator.ts packages/data-collector/src/services/MarketRotator.test.ts
git commit -m "feat(rotator): add parseAllowedMarketTypes helper"
```

---

### Task 2: Constructor takes `liveConfig` and `shadowConfig`

Adds the two-config pattern without changing rotation behavior yet. Existing tests use only the first arg, so they keep passing.

**Files:**
- Modify: `packages/data-collector/src/services/MarketRotator.ts`
- Test: `packages/data-collector/src/services/MarketRotator.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside the `describe('MarketRotator', ...)` block, after the existing `beforeEach`:

```typescript
describe('constructor', () => {
  it('accepts a separate shadow config with its own maxTracked', () => {
    const r = new MarketRotator(
      { maxTracked: 40 },
      { maxTracked: 7 },
    );
    // We assert via the public-only side: shadow rotation pulls 7 candidates max,
    // live pulls 40. Without invoking rotate yet, just verify construction succeeds
    // and exposes the expected shape via getter.
    expect(r.getLiveMaxTracked()).toBe(40);
    expect(r.getShadowMaxTracked()).toBe(7);
  });

  it('shadow config defaults maxTracked from MAX_SHADOW_MARKETS env', () => {
    vi.stubEnv('MAX_SHADOW_MARKETS', '15');
    const r = new MarketRotator();
    expect(r.getShadowMaxTracked()).toBe(15);
    vi.unstubAllEnvs();
  });

  it('shadow config defaults maxTracked to 10 when env unset', () => {
    vi.unstubAllEnvs();
    const r = new MarketRotator();
    expect(r.getShadowMaxTracked()).toBe(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/data-collector && pnpm exec vitest run src/services/MarketRotator.test.ts -t 'constructor'
```

Expected: FAIL with `r.getLiveMaxTracked is not a function`.

- [ ] **Step 3: Refactor the class**

In `MarketRotator.ts`, replace the existing `private config` field, constructor, and update internal references. Specifically replace lines 54–59 (`export class MarketRotator { private config ... constructor ... }`) with:

```typescript
export class MarketRotator {
  private liveConfig: RotationConfig;
  private shadowConfig: RotationConfig;
  private allowedTypes: string[];
  // The "active" config used by helper methods that read this.config.
  // Mutated by rotate(lane) — safe because rotateAll runs lanes sequentially.
  private config: RotationConfig;

  constructor(
    liveConfig: Partial<RotationConfig> = {},
    shadowConfig: Partial<RotationConfig> = {},
  ) {
    this.liveConfig = { ...DEFAULT_CONFIG, ...liveConfig };
    this.shadowConfig = {
      ...DEFAULT_CONFIG,
      maxTracked: parseInt(process.env.MAX_SHADOW_MARKETS || '10', 10),
      ...shadowConfig,
    };
    this.allowedTypes = parseAllowedMarketTypes(process.env.ALLOWED_MARKET_TYPES);
    // Default to live config so any helper called without going through rotate()
    // (e.g. existing tests of selectDemotions/selectPromotions) keep behaving as
    // they did pre-refactor.
    this.config = this.liveConfig;
  }

  getLiveMaxTracked(): number {
    return this.liveConfig.maxTracked;
  }

  getShadowMaxTracked(): number {
    return this.shadowConfig.maxTracked;
  }
```

(The helper methods below — `isExtremePrice`, `selectDemotions`, etc. — keep reading `this.config` unchanged.)

- [ ] **Step 4: Run all rotator tests to verify the refactor is non-breaking**

```bash
cd packages/data-collector && pnpm exec vitest run src/services/MarketRotator.test.ts
```

Expected: PASS, including the 3 new constructor tests and all preexisting tests.

- [ ] **Step 5: Commit**

```bash
git add packages/data-collector/src/services/MarketRotator.ts packages/data-collector/src/services/MarketRotator.test.ts
git commit -m "feat(rotator): split config into live and shadow"
```

---

### Task 3: `buildLaneClause` builder (lane-derived SQL fragment)

The lane filter is encoded as a SQL fragment. Isolating it as a method makes the SQL-construction logic testable without spinning up the whole rotator.

**Files:**
- Modify: `packages/data-collector/src/services/MarketRotator.ts`
- Test: `packages/data-collector/src/services/MarketRotator.test.ts`

- [ ] **Step 1: Write the failing test**

Append a new `describe` inside `describe('MarketRotator', ...)`:

```typescript
describe('buildLaneClause', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('live lane with empty allowed → "TRUE" (unrestricted, no param)', () => {
    const r = new MarketRotator();
    const clause = r.buildLaneClause('live', 5);
    expect(clause).toEqual({ sql: 'TRUE', param: null });
  });

  it('shadow lane with empty allowed → "FALSE" (matches nothing, no param)', () => {
    const r = new MarketRotator();
    const clause = r.buildLaneClause('shadow', 5);
    expect(clause).toEqual({ sql: 'FALSE', param: null });
  });

  it('live lane with allowed types → ANY clause with param at given index', () => {
    vi.stubEnv('ALLOWED_MARKET_TYPES', 'crypto_intraday,event_short');
    const r = new MarketRotator();
    const clause = r.buildLaneClause('live', 2);
    expect(clause.sql).toBe('market_type = ANY($2::text[])');
    expect(clause.param).toEqual(['crypto_intraday', 'event_short']);
  });

  it('shadow lane with allowed types → NOT IN clause that also catches NULL', () => {
    vi.stubEnv('ALLOWED_MARKET_TYPES', 'crypto_intraday,event_short');
    const r = new MarketRotator();
    const clause = r.buildLaneClause('shadow', 3);
    expect(clause.sql).toBe('(market_type IS NULL OR NOT (market_type = ANY($3::text[])))');
    expect(clause.param).toEqual(['crypto_intraday', 'event_short']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/data-collector && pnpm exec vitest run src/services/MarketRotator.test.ts -t 'buildLaneClause'
```

Expected: FAIL with `r.buildLaneClause is not a function`.

- [ ] **Step 3: Implement**

In `MarketRotator.ts`, add this method to the `MarketRotator` class (place it after `getShadowMaxTracked`):

```typescript
/**
 * Build the SQL fragment that restricts a query to a lane.
 * Returns:
 *   - { sql: 'TRUE', param: null } when the live lane has no allowlist (backward-compat unrestricted).
 *   - { sql: 'FALSE', param: null } when the shadow lane has no non-allowed types to observe.
 *   - { sql: 'market_type = ANY($N::text[])', param: [...] } for live with allowlist.
 *   - { sql: '(market_type IS NULL OR NOT (...))', param: [...] } for shadow with allowlist.
 *
 * The returned `param` (when non-null) must be passed at position `paramIndex` in the query parameters.
 */
buildLaneClause(
  lane: 'live' | 'shadow',
  paramIndex: number,
): { sql: string; param: string[] | null } {
  if (this.allowedTypes.length === 0) {
    return { sql: lane === 'live' ? 'TRUE' : 'FALSE', param: null };
  }
  if (lane === 'live') {
    return {
      sql: `market_type = ANY($${paramIndex}::text[])`,
      param: this.allowedTypes,
    };
  }
  return {
    sql: `(market_type IS NULL OR NOT (market_type = ANY($${paramIndex}::text[])))`,
    param: this.allowedTypes,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/data-collector && pnpm exec vitest run src/services/MarketRotator.test.ts -t 'buildLaneClause'
```

Expected: PASS, 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/data-collector/src/services/MarketRotator.ts packages/data-collector/src/services/MarketRotator.test.ts
git commit -m "feat(rotator): add buildLaneClause for lane-filtered SQL"
```

---

### Task 4: Refactor `rotate()` to `rotate(lane)`, swap config + apply lane clause to both queries

This is the core surgery. The body of `rotate()` stays largely the same; the two SQL queries (tracked at L199, candidates at L262) gain the lane clause; `this.config` is set at the top to the lane's config.

**Files:**
- Modify: `packages/data-collector/src/services/MarketRotator.ts`
- Modify: `packages/data-collector/src/services/MarketRotator.test.ts`

- [ ] **Step 1: Update existing `rotate()` test callers to pass `'live'`**

In `MarketRotator.test.ts`, replace the three call sites:
- Line ~428: `const result = await rotator.rotate();` → `const result = await rotator.rotate('live');`
- Line ~463: `await rotator.rotate();` → `await rotator.rotate('live');`
- Line ~497: `const result = await rotator.rotate();` → `const result = await rotator.rotate('live');`

- [ ] **Step 2: Write the failing tests for lane filtering**

Append a new `describe` inside `describe('MarketRotator', ...)`:

```typescript
describe('rotate(lane) — lane filtering applied to SQL', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('live lane query includes lane clause and array param when ALLOWED set', async () => {
    vi.stubEnv('ALLOWED_MARKET_TYPES', 'crypto_intraday,event_short');
    const r = new MarketRotator();

    let trackedSql: string | null = null;
    let trackedParams: unknown[] | null = null;
    let candidateSql: string | null = null;
    let candidateParams: unknown[] | null = null;

    mockedQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('tracking_status IN')) {
        trackedSql = sql;
        trackedParams = params ?? null;
        return { rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] };
      }
      if (typeof sql === 'string' && sql.includes("tracking_status = 'cold'")) {
        candidateSql = sql;
        candidateParams = params ?? null;
        return { rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] };
      }
      return { rows: [], command: 'UPDATE', rowCount: 0, oid: 0, fields: [] };
    });

    await r.rotate('live');

    expect(trackedSql).toMatch(/market_type = ANY\(\$\d+::text\[\]\)/);
    expect(trackedParams).toEqual([['crypto_intraday', 'event_short']]);
    expect(candidateSql).toMatch(/market_type = ANY\(\$\d+::text\[\]\)/);
    expect(candidateParams).toEqual([MIN_CANDIDATE_SCORE, ['crypto_intraday', 'event_short']]);
  });

  it('shadow lane query uses NOT-IN form including NULL', async () => {
    vi.stubEnv('ALLOWED_MARKET_TYPES', 'crypto_intraday,event_short');
    const r = new MarketRotator();

    let trackedSql: string | null = null;
    let candidateSql: string | null = null;

    mockedQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('tracking_status IN')) {
        trackedSql = sql;
        return { rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] };
      }
      if (typeof sql === 'string' && sql.includes("tracking_status = 'cold'")) {
        candidateSql = sql;
        return { rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] };
      }
      return { rows: [], command: 'UPDATE', rowCount: 0, oid: 0, fields: [] };
    });

    await r.rotate('shadow');

    expect(trackedSql).toMatch(/market_type IS NULL OR NOT \(market_type = ANY/);
    expect(candidateSql).toMatch(/market_type IS NULL OR NOT \(market_type = ANY/);
  });

  it('with empty ALLOWED, live runs unrestricted (TRUE clause), shadow returns no candidates (FALSE clause)', async () => {
    vi.unstubAllEnvs();
    const r = new MarketRotator();

    let trackedSqlLive: string | null = null;
    let trackedSqlShadow: string | null = null;

    mockedQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('tracking_status IN')) {
        if (trackedSqlLive === null) trackedSqlLive = sql;
        else trackedSqlShadow = sql;
        return { rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] };
      }
      return { rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] };
    });

    await r.rotate('live');
    await r.rotate('shadow');

    expect(trackedSqlLive).toMatch(/AND TRUE/);
    expect(trackedSqlShadow).toMatch(/AND FALSE/);
  });

  it('uses shadow config maxTracked for emergency-fill threshold check on shadow lane', async () => {
    vi.stubEnv('ALLOWED_MARKET_TYPES', 'crypto_intraday');
    // Shadow config: maxTracked=10, emergencyFillThreshold default 20.
    // With shadow active count below threshold, expect emergency mode (no demotions).
    const r = new MarketRotator(undefined, { maxTracked: 10 });

    // 5 active shadow markets — well below emergencyFillThreshold=20
    const trackedRows = Array.from({ length: 5 }, (_, i) =>
      makeMarket({ id: `shadow-${i}`, market_score: 0.1, tracking_status: 'active', has_open_positions: false, bars_24h: 10 })
    );
    const candidateRows = Array.from({ length: 20 }, (_, i) =>
      makeMarket({ id: `cold-${i}`, market_score: 0.5 + i * 0.01, tracking_status: 'cold' })
    );

    mockedQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('tracking_status IN')) {
        return { rows: trackedRows, command: 'SELECT', rowCount: trackedRows.length, oid: 0, fields: [] };
      }
      if (typeof sql === 'string' && sql.includes("tracking_status = 'cold'")) {
        return { rows: candidateRows, command: 'SELECT', rowCount: candidateRows.length, oid: 0, fields: [] };
      }
      return { rows: [], command: 'UPDATE', rowCount: 0, oid: 0, fields: [] };
    });

    const result = await r.rotate('shadow');
    expect(result.demoted).toBe(0); // emergency mode skips demotions
    expect(result.newWarming).toBeGreaterThan(0); // emergency-fill flows new warming
  });
});
```

- [ ] **Step 3: Run new tests to verify they fail**

```bash
cd packages/data-collector && pnpm exec vitest run src/services/MarketRotator.test.ts -t 'rotate\(lane\)'
```

Expected: FAIL — current `rotate()` takes no argument and queries don't include lane clauses.

- [ ] **Step 4: Refactor `rotate` body**

In `MarketRotator.ts`, change the `rotate()` signature and body. Replace lines 189–214 (the signature and the `tracked` query) with:

```typescript
async rotate(lane: 'live' | 'shadow'): Promise<RotationResult> {
  // Switch the active config to the lane's config. Helper methods (selectDemotions,
  // selectPromotions, selectWarmingDemotions, computeNewWarmingSlots, isEmergencyFill)
  // read this.config; setting it here keeps them lane-aware without changing
  // their signatures. Safe because rotateAll() invokes lanes sequentially.
  this.config = lane === 'live' ? this.liveConfig : this.shadowConfig;

  const result: RotationResult = {
    promoted: 0,
    demoted: 0,
    newWarming: 0,
    coolingExpired: 0,
    warmingDemoted: 0,
  };

  // Step 1: Fetch tracked markets restricted to the requested lane.
  const trackedLane = this.buildLaneClause(lane, 1);
  const trackedParams = trackedLane.param === null ? [] : [trackedLane.param];
  const trackedRes = await query<MarketRow>(
    `SELECT m.id, m.market_score, m.tracking_status,
            m.tracking_status_changed_at, m.current_price_yes,
            EXISTS(
              SELECT 1 FROM paper_positions pp
              WHERE pp.market_id = m.condition_id
                AND pp.closed_at IS NULL
            ) as has_open_positions,
            (
              SELECT COUNT(*) FROM price_history ph
              WHERE ph.token_id = m.clob_token_id_yes
                AND ph.time > NOW() - INTERVAL '24 hours'
            ) as bars_24h
     FROM markets m
     WHERE m.tracking_status IN ('warming', 'active', 'cooling')
       AND ${trackedLane.sql}`,
    trackedParams,
  );
```

The rest of the method body up to the candidate query stays the same (steps 2, 2b, 3, emergency check, etc.).

Then replace the candidate query block (lines 262–274 in the original) with:

```typescript
  // Step 4: Fetch cold candidates for demotion comparison and warming fill,
  // restricted to the requested lane.
  const candidateLane = this.buildLaneClause(lane, 2);
  const candidateParams: unknown[] = [MIN_CANDIDATE_SCORE];
  if (candidateLane.param !== null) candidateParams.push(candidateLane.param);

  const candidateRes = await query<MarketRow>(
    `SELECT id, market_score, tracking_status, tracking_status_changed_at,
            current_price_yes, false as has_open_positions, 0 as bars_24h
     FROM markets
     WHERE tracking_status = 'cold'
       AND is_active = true AND is_resolved = false
       AND clob_token_id_yes IS NOT NULL
       AND market_score >= $1
       AND (current_price_yes IS NULL OR (current_price_yes >= 0.05 AND current_price_yes <= 0.95))
       AND ${candidateLane.sql}
     ORDER BY market_score DESC
     LIMIT 50`,
    candidateParams,
  );
```

Update the closing log line to include the lane:

```typescript
  logger.info(
    {
      lane,
      promoted: result.promoted,
      demoted: result.demoted,
      newWarming: result.newWarming,
      coolingExpired: result.coolingExpired,
      warmingDemoted: result.warmingDemoted,
      activeCount: active.length + result.promoted - result.demoted,
      emergency,
    },
    'Market rotation complete',
  );
```

- [ ] **Step 5: Run the full rotator test suite**

```bash
cd packages/data-collector && pnpm exec vitest run src/services/MarketRotator.test.ts
```

Expected: PASS — both the 4 new lane-filtering tests and all preexisting tests (the 3 `rotate('live')` cases keep working with the legacy callers updated in Step 1).

- [ ] **Step 6: Commit**

```bash
git add packages/data-collector/src/services/MarketRotator.ts packages/data-collector/src/services/MarketRotator.test.ts
git commit -m "feat(rotator): rotate(lane) with parameterized SQL filter"
```

---

### Task 5: `rotateAll()` orchestrator

Single public entry point. Calls `rotate('live')` then `rotate('shadow')` sequentially. Returns both results.

**Files:**
- Modify: `packages/data-collector/src/services/MarketRotator.ts`
- Test: `packages/data-collector/src/services/MarketRotator.test.ts`

- [ ] **Step 1: Write the failing test**

Append a new `describe` inside `describe('MarketRotator', ...)`:

```typescript
describe('rotateAll', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns separate live and shadow results', async () => {
    vi.stubEnv('ALLOWED_MARKET_TYPES', 'crypto_intraday');
    const r = new MarketRotator();

    mockedQuery.mockResolvedValue({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] });

    const result = await r.rotateAll();
    expect(result).toHaveProperty('live');
    expect(result).toHaveProperty('shadow');
    expect(result.live).toMatchObject({ promoted: expect.any(Number), demoted: expect.any(Number) });
    expect(result.shadow).toMatchObject({ promoted: expect.any(Number), demoted: expect.any(Number) });
  });

  it('runs lanes sequentially: live first, then shadow', async () => {
    vi.stubEnv('ALLOWED_MARKET_TYPES', 'crypto_intraday');
    const r = new MarketRotator();

    const sqlsSeen: string[] = [];
    mockedQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('tracking_status IN')) {
        sqlsSeen.push(sql);
      }
      return { rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] };
    });

    await r.rotateAll();

    expect(sqlsSeen).toHaveLength(2);
    // First call is live (uses ANY directly).
    expect(sqlsSeen[0]).toMatch(/AND market_type = ANY/);
    // Second call is shadow (uses IS NULL OR NOT).
    expect(sqlsSeen[1]).toMatch(/AND \(market_type IS NULL OR NOT/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/data-collector && pnpm exec vitest run src/services/MarketRotator.test.ts -t 'rotateAll'
```

Expected: FAIL with `r.rotateAll is not a function`.

- [ ] **Step 3: Implement**

In `MarketRotator.ts`, add this method to the `MarketRotator` class (after `rotate(lane)`):

```typescript
/**
 * Run rotation for both lanes sequentially. Live lane operates on
 * ALLOWED_MARKET_TYPES; shadow lane operates on the complement (plus NULL).
 * Sequential because parallelism here yields no measurable benefit and would
 * complicate lock contention on the markets table.
 */
async rotateAll(): Promise<{ live: RotationResult; shadow: RotationResult }> {
  const live = await this.rotate('live');
  const shadow = await this.rotate('shadow');
  return { live, shadow };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/data-collector && pnpm exec vitest run src/services/MarketRotator.test.ts -t 'rotateAll'
```

Expected: PASS, 2 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/data-collector/src/services/MarketRotator.ts packages/data-collector/src/services/MarketRotator.test.ts
git commit -m "feat(rotator): add rotateAll orchestrator"
```

---

### Task 6: Wire `Scheduler` to call `rotateAll()`

Single-line behavior change with a slightly extended log payload.

**Files:**
- Modify: `packages/data-collector/src/services/Scheduler.ts:344-350`

- [ ] **Step 1: Update the call site**

In `Scheduler.ts`, replace lines 344–350:

```typescript
    // Rotate tracked markets based on scores
    try {
      const rotateResult = await this.marketRotator.rotate();
      logger.info(rotateResult, 'Market rotation complete');
    } catch (err) {
      logger.error({ err }, 'Market rotation failed');
    }
```

with:

```typescript
    // Rotate tracked markets based on scores — both live and shadow lanes
    try {
      const rotateResult = await this.marketRotator.rotateAll();
      logger.info(rotateResult, 'Market rotation complete (both lanes)');
    } catch (err) {
      logger.error({ err }, 'Market rotation failed');
    }
```

- [ ] **Step 2: Run the existing scheduler tests to confirm no regression**

```bash
cd packages/data-collector && pnpm exec vitest run src/services/Scheduler.test.ts
```

Expected: PASS. (The Scheduler tests, per the existing `Scheduler.test.ts`, do not deeply assert on rotator output — they check that `UPDATE markets` is invoked twice. The change in this task does not affect that assertion.)

- [ ] **Step 3: Commit**

```bash
git add packages/data-collector/src/services/Scheduler.ts
git commit -m "feat(scheduler): invoke rotateAll for live + shadow lanes"
```

---

### Task 7: Add `ALLOWED_MARKET_TYPES` and `MAX_SHADOW_MARKETS` to data-collector container env

The rotator now lives in data-collector and reads `ALLOWED_MARKET_TYPES`. Without this, both production rotators would behave as if the allowlist were empty (live unrestricted, shadow empty) — the very deadlock we're fixing.

**Files:**
- Modify: `docker-compose.gcp.yml:65-86`

- [ ] **Step 1: Add the env vars**

In `docker-compose.gcp.yml`, the `data-collector` service env block (around lines 69–84). After the existing `MAX_TRACKED_MARKETS: "35"` line, append:

```yaml
      ALLOWED_MARKET_TYPES: "crypto_intraday,crypto_daily,event_financial,event_short"
      MAX_SHADOW_MARKETS: "10"
```

The result for that service's `environment:` block should now include both vars alongside the existing ones. The value of `ALLOWED_MARKET_TYPES` MUST match the dashboard's value at line 160 — they are the operational invariant from the spec.

- [ ] **Step 2: Verify the YAML parses**

```bash
docker compose -f docker-compose.gcp.yml config --quiet
```

Expected: exit 0, no output. Any output means YAML/structural error — fix before proceeding.

- [ ] **Step 3: Verify the values are exposed to the rendered config**

```bash
docker compose -f docker-compose.gcp.yml config | grep -E 'ALLOWED_MARKET_TYPES|MAX_SHADOW_MARKETS' | sort -u
```

Expected output (two lines, identical values for both services):

```
      ALLOWED_MARKET_TYPES: crypto_intraday,crypto_daily,event_financial,event_short
      MAX_SHADOW_MARKETS: "10"
```

(Three matches if the dashboard already had ALLOWED_MARKET_TYPES — which it does.)

- [ ] **Step 4: Commit**

```bash
git add docker-compose.gcp.yml
git commit -m "chore(deploy): wire ALLOWED_MARKET_TYPES + MAX_SHADOW_MARKETS to data-collector"
```

---

### Task 8: Replace `shadow_summary` SQL in `daily-review.sh`

Existing query (lines 523–532) returns total/resolved/avg_pnl per market_type with no time window. Replace with a 30-day window plus win rate, stddev, and Sharpe. The new fields enable the promotion logic added in Task 9.

**Files:**
- Modify: `scripts/daily-review.sh:523-532`

- [ ] **Step 1: Replace the query**

In `scripts/daily-review.sh`, replace the `shadow_summary` block (currently lines 523–532) with:

```bash
shadow_summary=$(query_json "
  SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM (
    SELECT market_type,
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE resolved_at IS NOT NULL) AS resolved,
           ROUND(AVG(theoretical_pnl) FILTER (WHERE resolved_at IS NOT NULL)::numeric, 4) AS avg_pnl,
           ROUND(
             (COUNT(*) FILTER (WHERE resolved_at IS NOT NULL AND theoretical_pnl > 0)::numeric
               / NULLIF(COUNT(*) FILTER (WHERE resolved_at IS NOT NULL), 0))::numeric,
             3
           ) AS win_rate,
           ROUND(STDDEV(theoretical_pnl) FILTER (WHERE resolved_at IS NOT NULL)::numeric, 4) AS pnl_stddev,
           ROUND(
             CASE WHEN STDDEV(theoretical_pnl) FILTER (WHERE resolved_at IS NOT NULL) > 0
               THEN AVG(theoretical_pnl) FILTER (WHERE resolved_at IS NOT NULL)
                    / STDDEV(theoretical_pnl) FILTER (WHERE resolved_at IS NOT NULL)
               ELSE 0 END::numeric,
             3
           ) AS sharpe
    FROM shadow_trades
    WHERE time >= NOW() - INTERVAL '30 days'
    GROUP BY market_type
  ) t;
")
```

- [ ] **Step 2: Verify the script still parses (bash syntax check)**

```bash
bash -n scripts/daily-review.sh
```

Expected: exit 0, no output.

- [ ] **Step 3: Verify the SQL is valid Postgres against the actual VM database**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command "docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM ( SELECT market_type, COUNT(*) AS total, COUNT(*) FILTER (WHERE resolved_at IS NOT NULL) AS resolved, ROUND(AVG(theoretical_pnl) FILTER (WHERE resolved_at IS NOT NULL)::numeric, 4) AS avg_pnl, ROUND((COUNT(*) FILTER (WHERE resolved_at IS NOT NULL AND theoretical_pnl > 0)::numeric / NULLIF(COUNT(*) FILTER (WHERE resolved_at IS NOT NULL), 0))::numeric, 3) AS win_rate, ROUND(STDDEV(theoretical_pnl) FILTER (WHERE resolved_at IS NOT NULL)::numeric, 4) AS pnl_stddev, ROUND(CASE WHEN STDDEV(theoretical_pnl) FILTER (WHERE resolved_at IS NOT NULL) > 0 THEN AVG(theoretical_pnl) FILTER (WHERE resolved_at IS NOT NULL) / STDDEV(theoretical_pnl) FILTER (WHERE resolved_at IS NOT NULL) ELSE 0 END::numeric, 3) AS sharpe FROM shadow_trades WHERE time >= NOW() - INTERVAL '30 days' GROUP BY market_type ) t;\""
```

Expected: a JSON array with one object per market_type that has shadow_trades rows in the last 30 days. Fields present: `market_type`, `total`, `resolved`, `avg_pnl`, `win_rate`, `pnl_stddev`, `sharpe`.

- [ ] **Step 4: Commit**

```bash
git add scripts/daily-review.sh
git commit -m "feat(daily-review): richer shadow_summary with win rate and Sharpe"
```

---

### Task 9: Add promotion-recommendation block to `daily-review-prompt.md`

Tells Claude (the daily auto-review consumer) how to interpret the new shadow_summary fields and when to surface a promotion recommendation. Pure documentation change.

**Files:**
- Modify: `scripts/daily-review-prompt.md` — append a subsection to the existing "Market Type Execution Gate" section.

- [ ] **Step 1: Append the new subsection**

In `scripts/daily-review-prompt.md`, locate the existing line "**JSON sections to use:**" (around line 120) and the three bullets that follow. Right after the bullet ending with `shadow_summary: blocked signals recorded as shadow trades`, append a new blank line and the following block:

```markdown

### Shadow → Live promotion recommendation

`shadow_summary` is now per-`market_type` over a 30-day window with fields: `total`, `resolved`, `avg_pnl`, `win_rate`, `pnl_stddev`, `sharpe`.

For each `market_type` row in `shadow_summary`, evaluate against ALL of:

- `resolved >= 50` (sufficient sample size to draw a conclusion)
- `sharpe >= 0.20` (positive risk-adjusted edge)
- `win_rate >= 0.50`
- The market_type is NOT already in the live `ALLOWED_MARKET_TYPES` list (`crypto_intraday,crypto_daily,event_financial,event_short`)

If all four hold, include a recommendation in the issue body:

> **Promotion candidate:** `<market_type>`. Over 30 days of shadow data: N=<resolved> resolved, win_rate=<win_rate>, Sharpe=<sharpe>, avg_pnl=<avg_pnl>. Consider adding to `ALLOWED_MARKET_TYPES` on the next deploy.

Do NOT auto-create a PR for the env change — promotion is a manual decision tied to a deploy. The recommendation is informational only.

Conversely, for any `market_type` that IS currently in `ALLOWED_MARKET_TYPES` and shows live performance over the same 30 days that contradicts the prior shadow signal (e.g. live Sharpe < 0 while shadow was > 0.20), flag it under "Possible regression — review allowlist for `<market_type>`".

The thresholds (50 resolved trades, Sharpe 0.20, win_rate 0.50) are starting points, not an optimized policy. Tune by observation when this recommendation has been running for ≥4 weekly reviews.
```

- [ ] **Step 2: Verify the markdown renders cleanly**

```bash
grep -n "Shadow → Live promotion recommendation" scripts/daily-review-prompt.md
```

Expected: exactly one match.

- [ ] **Step 3: Commit**

```bash
git add scripts/daily-review-prompt.md
git commit -m "feat(daily-review): promotion recommendation logic in prompt"
```

---

### Task 10: Full test suite + build sanity check

A single gate before deploy. Catches anything missed by the per-task tests, especially type errors that ripple across packages.

**Files:** none modified.

- [ ] **Step 1: Run the data-collector tests in full**

```bash
cd packages/data-collector && rtk pnpm exec vitest run
```

Expected: all green.

- [ ] **Step 2: Run a typecheck on the data-collector package**

```bash
cd packages/data-collector && rtk pnpm exec tsc --noEmit
```

Expected: no output, exit 0.

- [ ] **Step 3: Run dashboard tests as a regression net (no dashboard files were modified, but Scheduler/Rotator are imported indirectly)**

```bash
cd packages/dashboard && rtk pnpm exec vitest run
```

Expected: all green.

- [ ] **Step 4: Run the dashboard typecheck**

```bash
cd packages/dashboard && rtk pnpm exec tsc --noEmit
```

Expected: no output, exit 0.

- [ ] **Step 5: No commit needed** — verification only.

---

### Task 11: Post-deploy smoke verification (manual, on the GCP VM)

Runs after CI deploys the merged branch to the VM. Confirms the four success criteria from the spec.

**Files:** none modified.

- [ ] **Step 1: Wait for CI deploy to settle (~5 min after merge)**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command "docker compose -f /home/Usuario/polymarket-trader/docker-compose.gcp.yml ps"
```

Expected: data-collector and dashboard-api containers `Up` and `healthy`. Check `git log --oneline -3` on the VM matches the merged commit.

- [ ] **Step 2: Verify both lanes are rotating**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command "docker compose -f /home/Usuario/polymarket-trader/docker-compose.gcp.yml logs --since 10m data-collector 2>&1 | grep 'Market rotation complete'"
```

Expected: at least one log line with the `lane:'live'` field and one with `lane:'shadow'` within the past 10 minutes.

- [ ] **Step 3: Success criterion #1 — live pool composition**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command "docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"SELECT market_type, COUNT(*) FROM markets WHERE tracking_status='active' AND market_type IN ('crypto_intraday','crypto_daily','event_short','event_financial') GROUP BY market_type ORDER BY 2 DESC;\""
```

Expected (within 6 hours of deploy): total ≥ 5 across the four allowed types.

- [ ] **Step 4: Success criterion #2 — crypto price_history flowing**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command "docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"SELECT COUNT(*) FROM price_history WHERE market_id IN (SELECT id FROM markets WHERE market_type LIKE 'crypto_%') AND time > NOW() - INTERVAL '1 hour';\""
```

Expected (within 6 hours of deploy): COUNT > 0.

- [ ] **Step 5: Success criterion #3 — shadow_trades still flowing**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command "docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"SELECT COUNT(*) FROM shadow_trades WHERE time > NOW() - INTERVAL '24 hours';\""
```

Expected: COUNT ≥ pre-deploy 24h baseline (record the pre-deploy value before merging for comparison).

- [ ] **Step 6: Success criterion #4 — trade drought ended**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command "docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"SELECT MAX(opened_at), EXTRACT(EPOCH FROM (NOW() - MAX(opened_at)))/3600 AS hours_since_last FROM paper_positions;\""
```

Expected (within 24 hours of deploy): `hours_since_last` < 6.

- [ ] **Step 7: If any criterion fails by the deadline, follow the rollback path from the spec**

```bash
git revert <merge-commit-sha> --no-edit
git push origin main
```

CI redeploys; the rotator returns to single-pool behavior. No data migration to undo.
