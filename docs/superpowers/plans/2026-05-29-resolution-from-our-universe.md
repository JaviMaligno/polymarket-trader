# Resolution Detection From Our Universe — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the firehose-based resolution sync with a targeted job that resolves our own unresolved-ended markets by querying Gamma per-id, and remove the untradeable `crypto_intraday` type from the allowlist.

**Architecture:** A new `GammaCollector.resolveOurMarkets()` selects our `end_date < NOW() AND NOT is_resolved` markets (consumers + tradeable first), fetches their outcomes from Gamma in id-batches with `closed=true`, and writes `is_resolved/resolution_outcome/resolved_at`. A new `markets.last_resolution_check` column throttles markets Gamma can't yet resolve. The existing `resolveShadowTrades` (type-agnostic) then scores the newly-resolved shadow trades unchanged.

**Tech Stack:** TypeScript, Node, axios, node-postgres (`query` from `database/connection.js`), Vitest, TimescaleDB. Spec: `docs/superpowers/specs/2026-05-29-resolution-from-our-universe-design.md`.

---

## Plan-time verification (do first, no commit)

- [ ] **Confirm Gamma multi-id batch returns multiple rows.** Run locally:

```bash
curl -s "https://gamma-api.polymarket.com/markets?id=1651554&id=1651555&closed=true" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const d=JSON.parse(s);console.log("rows:",Array.isArray(d)?d.length:"non-array")})'
```

Expected: `rows: 1` or `2` (≥1 confirms the batch param works). If it returns 0 for known-closed ids, fall back to per-id `GET /markets/{id}` in Task 3 (the `fetchMarket` method already does this) and set `RESOLUTION_BATCH_SIZE=1` semantics. Note the outcome in the Task 3 implementation comment.

---

## Task 1: Extract `parseResolutionOutcome` pure function

**Files:**
- Modify: `packages/data-collector/src/collectors/GammaCollector.ts` (extract from the inline block at ~lines 210-221)
- Test: `packages/data-collector/src/collectors/GammaCollector.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/data-collector/src/collectors/GammaCollector.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseResolutionOutcome } from './GammaCollector.js';

describe('parseResolutionOutcome', () => {
  it('YES outcome ["1","0"] → yes', () => {
    expect(parseResolutionOutcome('["1", "0"]')).toBe('yes');
  });
  it('NO outcome ["0","1"] → no', () => {
    expect(parseResolutionOutcome('["0", "1"]')).toBe('no');
  });
  it('near-1 yes price ≥0.99 → yes', () => {
    expect(parseResolutionOutcome('["0.995", "0.005"]')).toBe('yes');
  });
  it('near-0 yes price ≤0.01 → no', () => {
    expect(parseResolutionOutcome('["0.004", "0.996"]')).toBe('no');
  });
  it('50-50 / invalid → null', () => {
    expect(parseResolutionOutcome('["0.5", "0.5"]')).toBe(null);
  });
  it('empty array → null', () => {
    expect(parseResolutionOutcome('[]')).toBe(null);
  });
  it('malformed JSON → null', () => {
    expect(parseResolutionOutcome('not json')).toBe(null);
  });
  it('null/undefined → null', () => {
    expect(parseResolutionOutcome(null)).toBe(null);
    expect(parseResolutionOutcome(undefined)).toBe(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @polymarket-trader/data-collector exec vitest run src/collectors/GammaCollector.test.ts`
Expected: FAIL — `parseResolutionOutcome` is not exported / not a function.

- [ ] **Step 3: Add the exported function**

In `GammaCollector.ts`, after the imports/consts block (before `class GammaCollector`), add:

```ts
/**
 * Parse Gamma `outcomePrices` (JSON string like '["1","0"]') into a resolution
 * outcome. YES price ≥0.99 → 'yes', ≤0.01 → 'no', otherwise (50-50, invalid,
 * malformed) → null. MarketPerformanceTracker treats any non-'yes' as 0.0 PnL,
 * so we only mark clean yes/no resolutions.
 */
export function parseResolutionOutcome(outcomePrices: string | null | undefined): 'yes' | 'no' | null {
  try {
    const prices = JSON.parse(outcomePrices || '[]');
    const yesPrice = prices[0] != null ? parseFloat(prices[0]) : null;
    if (yesPrice === null || isNaN(yesPrice)) return null;
    if (yesPrice >= 0.99) return 'yes';
    if (yesPrice <= 0.01) return 'no';
    return null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @polymarket-trader/data-collector exec vitest run src/collectors/GammaCollector.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/data-collector/src/collectors/GammaCollector.ts packages/data-collector/src/collectors/GammaCollector.test.ts
git commit -m "refactor(gamma): extract parseResolutionOutcome pure fn with tests"
```

---

## Task 2: Add `markets.last_resolution_check` column

**Files:**
- Create: `packages/data-collector/src/database/init/033_markets_last_resolution_check.sql`

- [ ] **Step 1: Write the migration**

Create `packages/data-collector/src/database/init/033_markets_last_resolution_check.sql`:

```sql
-- Throttle column for resolution detection (resolveOurMarkets). Markets Gamma
-- cannot yet resolve (not closed, delisted) get their last_resolution_check
-- bumped so they don't consume the per-run budget every cron cycle.
-- NOTE: init SQL only runs on FIRST volume init. The running VM gets this column
-- via the idempotent ALTER in GammaCollector.resolveOurMarkets() and the manual
-- ALTER in the deploy task. This file covers fresh installs.
ALTER TABLE markets ADD COLUMN IF NOT EXISTS last_resolution_check TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_markets_resolution_backlog
  ON markets (end_date)
  WHERE COALESCE(is_resolved, false) = false;
```

- [ ] **Step 2: Verify SQL parses (syntax sanity)**

Run: `node -e "const s=require('fs').readFileSync('packages/data-collector/src/database/init/033_markets_last_resolution_check.sql','utf8'); if(!/ADD COLUMN IF NOT EXISTS last_resolution_check/.test(s)) throw new Error('missing column'); console.log('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add packages/data-collector/src/database/init/033_markets_last_resolution_check.sql
git commit -m "feat(db): add markets.last_resolution_check for resolution throttle"
```

---

## Task 3: Implement `resolveOurMarkets`

**Files:**
- Modify: `packages/data-collector/src/collectors/GammaCollector.ts`
- Test: `packages/data-collector/src/collectors/GammaCollector.test.ts`

- [ ] **Step 1: Write the failing tests (append to existing test file)**

Add to `GammaCollector.test.ts`. This mocks `query` and the collector's axios client:

```ts
import { vi, beforeEach } from 'vitest';

vi.mock('../database/connection.js', () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

import { query } from '../database/connection.js';
import { GammaCollector } from './GammaCollector.js';

describe('resolveOurMarkets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.RESOLUTION_BUDGET_PER_RUN;
    delete process.env.RESOLUTION_BATCH_SIZE;
    delete process.env.RESOLUTION_RECHECK_HOURS;
  });

  it('selects unresolved ended markets with the throttle + priority + budget', async () => {
    (query as any).mockResolvedValue({ rows: [] }); // ALTER, then SELECT returns no ids
    const c = new GammaCollector();
    await c.resolveOurMarkets();

    // First call is the idempotent ALTER; second is the SELECT.
    const selectSql = (query as any).mock.calls[1][0] as string;
    expect(selectSql).toMatch(/end_date < NOW\(\)/);
    expect(selectSql).toMatch(/NOT COALESCE\(m\.is_resolved, false\)/);
    expect(selectSql).toMatch(/last_resolution_check/);
    expect(selectSql).toMatch(/ORDER BY/);
    expect(selectSql).toMatch(/LIMIT/);
  });

  it('resolves returned closed markets and bumps absent ids', async () => {
    const c = new GammaCollector();
    // ALTER (call 0), SELECT (call 1) returns 2 ids
    (query as any)
      .mockResolvedValueOnce({ rows: [] })                       // ALTER
      .mockResolvedValueOnce({ rows: [{ id: 'A' }, { id: 'B' }] }) // SELECT
      .mockResolvedValue({ rows: [] });                          // all UPDATEs

    // Gamma returns only A as closed (B still open → absent).
    // client is a private instance property; assign a mock directly.
    (c as any).client = {
      get: vi.fn().mockResolvedValue({
        data: [{ id: 'A', outcomePrices: '["1","0"]', closedTime: '2026-05-12 08:41:05+00' }],
      }),
    };

    const res = await c.resolveOurMarkets();
    expect(res.resolved).toBe(1);

    const calls = (query as any).mock.calls.map((c: any[]) => c[0] as string);
    // A resolved via idempotent UPDATE
    const updateA = (query as any).mock.calls.find((c: any[]) =>
      /UPDATE markets SET is_resolved=true/.test(c[0]) && c[1] && c[1][2] === 'A');
    expect(updateA).toBeTruthy();
    expect(updateA[1][0]).toBe('yes');
    expect(/COALESCE\(is_resolved,false\) ?= ?false/.test(updateA[0])).toBe(true);
    // B absent → throttle bump
    const bumpB = (query as any).mock.calls.find((c: any[]) =>
      /SET last_resolution_check = NOW\(\)/.test(c[0]) && c[1] && c[1][0] === 'B');
    expect(bumpB).toBeTruthy();
  });

  it('network failure on a batch does not throttle (no last_resolution_check bump)', async () => {
    const c = new GammaCollector();
    (query as any)
      .mockResolvedValueOnce({ rows: [] })                       // ALTER
      .mockResolvedValueOnce({ rows: [{ id: 'A' }] })            // SELECT
      .mockResolvedValue({ rows: [] });
    (c as any).client = { get: vi.fn().mockRejectedValue(new Error('ECONNRESET')) };

    const res = await c.resolveOurMarkets();
    expect(res.resolved).toBe(0);
    const anyBump = (query as any).mock.calls.some((c: any[]) =>
      /SET last_resolution_check = NOW\(\)/.test(c[0]));
    expect(anyBump).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @polymarket-trader/data-collector exec vitest run src/collectors/GammaCollector.test.ts`
Expected: FAIL — `resolveOurMarkets` is not a method.

- [ ] **Step 3: Add env consts and the method**

In `GammaCollector.ts`, add near the top consts (after `MAX_SYNC_PAGES`):

```ts
const RESOLUTION_BUDGET_PER_RUN = parseInt(process.env.RESOLUTION_BUDGET_PER_RUN || '500', 10);
const RESOLUTION_BATCH_SIZE = parseInt(process.env.RESOLUTION_BATCH_SIZE || '20', 10);
const RESOLUTION_RECHECK_HOURS = parseInt(process.env.RESOLUTION_RECHECK_HOURS || '24', 10);
```

Add this method to the `GammaCollector` class (replaces reliance on the global scan; leave `syncResolvedMarketsToDb` in place for now — Task 4 redirects the scheduler, Task 4 Step 5 removes the old body):

```ts
/**
 * Resolve OUR ended-but-unresolved markets by querying Gamma per-id, instead of
 * scanning Polymarket's global closed feed (which the 5-min crypto firehose
 * starves — see docs/superpowers/specs/2026-05-29-resolution-from-our-universe-design.md).
 * Consumers (shadow_trades / market_panel) and tradeable types are resolved first.
 */
async resolveOurMarkets(): Promise<{ resolved: number; checked: number }> {
  // Idempotent schema guard (init SQL only runs on first volume init).
  await query(`ALTER TABLE markets ADD COLUMN IF NOT EXISTS last_resolution_check TIMESTAMPTZ`);

  const sel = await query<{ id: string }>(
    `
    SELECT m.id
    FROM markets m
    WHERE m.end_date < NOW()
      AND NOT COALESCE(m.is_resolved, false)
      AND (m.last_resolution_check IS NULL
           OR m.last_resolution_check < NOW() - ($1 || ' hours')::interval)
    ORDER BY
      (EXISTS (SELECT 1 FROM shadow_trades s WHERE s.market_id = m.id AND s.resolved_at IS NULL)) DESC,
      (EXISTS (SELECT 1 FROM market_panel mp WHERE mp.market_id = m.id AND mp.resolved_at IS NULL)) DESC,
      (m.market_type IN ('crypto_daily','event_financial','event_short')) DESC,
      m.end_date DESC
    LIMIT $2
    `,
    [String(RESOLUTION_RECHECK_HOURS), RESOLUTION_BUDGET_PER_RUN]
  );

  const ids = sel.rows.map((r) => String(r.id));
  if (ids.length === 0) {
    logger.info('No unresolved-ended markets in budget window');
    return { resolved: 0, checked: 0 };
  }

  let resolved = 0;
  for (let i = 0; i < ids.length; i += RESOLUTION_BATCH_SIZE) {
    const chunk = ids.slice(i, i + RESOLUTION_BATCH_SIZE);
    await this.rateLimiter.acquire('gamma_markets');

    let rows: any[] = [];
    try {
      const params = new URLSearchParams();
      for (const id of chunk) params.append('id', id);
      params.append('closed', 'true');
      const response = await this.client.get<any[]>('/markets', { params });
      rows = response.data || [];
    } catch (err: any) {
      // Transient — do NOT throttle; retry next run.
      logger.error({ err: err.message || String(err), chunkSize: chunk.length }, 'Resolution batch fetch failed');
      continue;
    }

    const returned = new Set<string>();
    for (const m of rows) {
      returned.add(String(m.id));
      const outcome = parseResolutionOutcome(m.outcomePrices);
      if (outcome === null) {
        await this.bumpResolutionCheck(String(m.id)); // 50-50 / invalid — don't re-query hourly
        continue;
      }
      const resolvedAt = m.closedTime
        ? new Date(String(m.closedTime).replace(' ', 'T').replace('+00', 'Z'))
        : new Date();
      try {
        await query(
          `UPDATE markets SET is_resolved=true, resolution_outcome=$1, resolved_at=$2,
                  is_active=false, updated_at=NOW()
           WHERE id=$3 AND COALESCE(is_resolved,false)=false`,
          [outcome, resolvedAt, m.id]
        );
        resolved++;
      } catch (err: any) {
        logger.warn({ err: err.message || String(err), marketId: m.id }, 'Failed to mark market resolved');
      }
    }
    // Requested-but-absent (still open) → throttle.
    for (const id of chunk) {
      if (!returned.has(id)) await this.bumpResolutionCheck(id);
    }
  }

  logger.info({ resolved, checked: ids.length }, 'Finished resolving our markets');
  return { resolved, checked: ids.length };
}

private async bumpResolutionCheck(id: string): Promise<void> {
  try {
    await query(`UPDATE markets SET last_resolution_check = NOW() WHERE id = $1`, [id]);
  } catch (err: any) {
    logger.warn({ err: err.message || String(err), marketId: id }, 'Failed to bump last_resolution_check');
  }
}
```

> If plan-time verification showed the multi-id batch returns 0 rows, set `RESOLUTION_BATCH_SIZE` default to `1` and replace the batch `client.get('/markets', {params})` with a per-id loop using the existing `fetchMarket(id)` (which calls `/markets/{id}` and returns the single market or null). Keep the rest identical.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @polymarket-trader/data-collector exec vitest run src/collectors/GammaCollector.test.ts`
Expected: PASS — all `parseResolutionOutcome` + `resolveOurMarkets` tests.

- [ ] **Step 5: Commit**

```bash
git add packages/data-collector/src/collectors/GammaCollector.ts packages/data-collector/src/collectors/GammaCollector.test.ts
git commit -m "feat(gamma): resolveOurMarkets — targeted per-id resolution from our universe"
```

---

## Task 4: Wire `resolveOurMarkets` into the Scheduler; remove the global scan

**Files:**
- Modify: `packages/data-collector/src/services/Scheduler.ts:383-387`
- Modify: `packages/data-collector/src/collectors/GammaCollector.ts` (remove old `syncResolvedMarketsToDb` body)
- Test: `packages/data-collector/src/services/Scheduler.test.ts`

- [ ] **Step 1: Write the failing test (assert scheduler calls resolveOurMarkets)**

Inspect `Scheduler.test.ts` for the existing mocking style of `getGammaCollector`. Add a test that the `sync-resolved-markets` handler calls `resolveOurMarkets`. If `Scheduler.test.ts` does not already mock the collector, add:

```ts
it('sync-resolved-markets calls resolveOurMarkets', async () => {
  const resolveOurMarkets = vi.fn().mockResolvedValue({ resolved: 0, checked: 0 });
  vi.spyOn(gammaModule, 'getGammaCollector').mockReturnValue({ resolveOurMarkets } as any);
  const scheduler = new Scheduler();
  await (scheduler as any).syncResolvedMarkets();
  expect(resolveOurMarkets).toHaveBeenCalled();
});
```

(Match the existing import alias for the gamma module in this test file; if none exists, `import * as gammaModule from '../collectors/GammaCollector.js'`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @polymarket-trader/data-collector exec vitest run src/services/Scheduler.test.ts`
Expected: FAIL — handler still calls `syncResolvedMarketsToDb`.

- [ ] **Step 3: Redirect the scheduler handler**

In `Scheduler.ts`, replace the body of `syncResolvedMarkets` (lines 383-387):

```ts
  private async syncResolvedMarkets(): Promise<void> {
    const collector = getGammaCollector();
    const result = await collector.resolveOurMarkets();
    logger.info({ resolved: result.resolved, checked: result.checked }, 'Resolved our markets');
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @polymarket-trader/data-collector exec vitest run src/services/Scheduler.test.ts`
Expected: PASS.

- [ ] **Step 5: Remove the dead global-scan method**

In `GammaCollector.ts`, delete `syncResolvedMarketsToDb` (the whole method, ~lines 160-266) now that nothing calls it. Verify no other references:

Run: `grep -rn "syncResolvedMarketsToDb" packages/`
Expected: no matches.

- [ ] **Step 6: Full data-collector test + typecheck**

Run: `pnpm --filter @polymarket-trader/data-collector exec vitest run && pnpm --filter @polymarket-trader/data-collector build`
Expected: all tests PASS, build succeeds (no TS errors from the removed method / `next_cursor` types).

- [ ] **Step 7: Commit**

```bash
git add packages/data-collector/src/services/Scheduler.ts packages/data-collector/src/services/Scheduler.test.ts packages/data-collector/src/collectors/GammaCollector.ts
git commit -m "feat(scheduler): drive resolution from resolveOurMarkets; drop global scan"
```

---

## Task 5: Remove `crypto_intraday` from the allowlist

**Files:**
- Modify: `docker-compose.gcp.yml:78` and `:320`
- Modify: `scripts/coverage-alerts.js`
- Modify: `scripts/coverage-alerts.test.js`
- Modify: `scripts/daily-review.sh` (the `allowed_market_types` fallback literal)

- [ ] **Step 1: Update the coverage-alerts test first (TDD — default no longer includes intraday)**

In `scripts/coverage-alerts.test.js`, change the `defaults` test expectation so `DEFAULT_ALLOWED_MARKET_TYPES` no longer contains `crypto_intraday`. Add an explicit assertion:

```js
{
  name: 'DEFAULT_ALLOWED_MARKET_TYPES excludes untradeable crypto_intraday',
  fn: () => {
    assert.ok(!DEFAULT_ALLOWED_MARKET_TYPES.includes('crypto_intraday'));
    assert.deepEqual(DEFAULT_ALLOWED_MARKET_TYPES, ['crypto_daily', 'event_financial', 'event_short']);
  },
},
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/coverage-alerts.test.js`
Expected: FAIL — default still includes `crypto_intraday`.

- [ ] **Step 3: Update the default constant**

In `scripts/coverage-alerts.js`:

```js
const DEFAULT_ALLOWED_MARKET_TYPES = ['crypto_daily', 'event_financial', 'event_short'];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/coverage-alerts.test.js`
Expected: PASS (all cases, including the new one).

- [ ] **Step 5: Update compose and the gather fallback**

In `docker-compose.gcp.yml`, both occurrences (lines 78 and 320):

```yaml
      ALLOWED_MARKET_TYPES: "crypto_daily,event_financial,event_short"
```

In `scripts/daily-review.sh`, the fallback literal:

```bash
allowed_market_types='["crypto_daily","event_financial","event_short"]'
```

- [ ] **Step 6: Commit**

```bash
git add docker-compose.gcp.yml scripts/coverage-alerts.js scripts/coverage-alerts.test.js scripts/daily-review.sh
git commit -m "chore(config): drop untradeable crypto_intraday from ALLOWED_MARKET_TYPES"
```

---

## Task 6: Deploy + verify on the VM

**Files:** none (operational). Requires `gh auth switch --user JaviMaligno` before any push.

- [ ] **Step 1: Open the PR** (implement on branch `feat/resolution-from-our-universe`)

```bash
gh auth switch --user JaviMaligno
git push -u origin feat/resolution-from-our-universe
gh pr create --base main \
  --title "feat: resolution detection from our universe + drop crypto_intraday" \
  --body "Implements docs/superpowers/specs/2026-05-29-resolution-from-our-universe-design.md. Replaces the firehose-based resolution sync (MAX_SYNC_PAGES=10) with resolveOurMarkets (targeted per-id), adds markets.last_resolution_check throttle, removes crypto_intraday from ALLOWED_MARKET_TYPES."
```

- [ ] **Step 2: After merge + CI deploy, apply the column on the running VM** (init SQL won't run on the existing volume)

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b -- \
  "docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"ALTER TABLE markets ADD COLUMN IF NOT EXISTS last_resolution_check TIMESTAMPTZ;\""
```

Expected: `ALTER TABLE`.

- [ ] **Step 3: Confirm the VM is on the merged commit and containers healthy**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b -- "cd /home/Usuario/polymarket-trader && git log --oneline -1 && docker compose -f docker-compose.gcp.yml ps"
```

Expected: HEAD = merge commit; containers Up.

- [ ] **Step 4: Verify ALLOWED_MARKET_TYPES no longer includes crypto_intraday**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b -- "docker exec polymarket-dashboard-api printenv ALLOWED_MARKET_TYPES"
```

Expected: `crypto_daily,event_financial,event_short`.

- [ ] **Step 5: After the next `sync-resolved-markets` run (hourly :33), confirm resolution counts climb**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b -- \
  "docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"SELECT market_type, COUNT(*) FILTER (WHERE is_resolved) resolved, COUNT(*) FILTER (WHERE last_resolution_check IS NOT NULL) checked FROM markets WHERE market_type IS NOT NULL GROUP BY 1 ORDER BY 1;\""
```

Expected: `resolved` and/or `checked` materially higher than the 2026-05-29 baseline (crypto_daily 33, event_financial 136, event_short 4198) for the tradeable types.

- [ ] **Step 6: Confirm shadow trades start resolving for the tradeable types**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b -- \
  "docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"SELECT m.market_type, COUNT(*) FILTER (WHERE s.resolved_at IS NOT NULL) resolved FROM shadow_trades s JOIN markets m ON m.id=s.market_id WHERE m.market_type IN ('crypto_daily','event_financial','event_short') GROUP BY 1;\""
```

Expected: non-zero `resolved` for at least one tradeable type (baseline was 0). Full backlog drain takes multiple cron cycles under the budget — note progress, don't expect 100% on the first run.

---

## Self-review notes

- **Spec coverage:** targeted resolution job (Tasks 1,3,4), `last_resolution_check` throttle (Tasks 2,3), priority ordering (Task 3 SELECT), env tunables (Task 3), crypto_intraday removal (Task 5), deploy + backlog-drain verification (Task 6). Error handling (transient-no-throttle, absent-throttle, 50-50, per-market catch) is in Task 3 Step 3 code and covered by the network-failure test.
- **Batch-cardinality risk** is gated by the plan-time verification with an explicit fallback.
- **Schema-on-existing-volume gotcha** handled three ways: idempotent ALTER in `resolveOurMarkets`, init SQL for fresh installs (Task 2), manual ALTER on deploy (Task 6 Step 2).
- The `market_panel.resolved_at` column exists (verified 2026-05-29: `market_panel` has `resolved_at`). The `shadow_trades.resolved_at` and `markets.is_resolved/resolution_outcome/end_date` columns are all in use by current code.
