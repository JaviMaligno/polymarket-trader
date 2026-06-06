# Trades Misattribution Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the raw `trades` table reflect real per-token executions by querying the data-api with `market=<conditionId>` and storing each trade under its true `asset`, so the live OFI/Hawkes signals stop computing on a misattributed global feed.

**Architecture:** Fix `ClobCollector` trade collection (query by market, store by asset, real dedup), add a unique dedup index, and purge the contaminated history on the VM. No signal-weight changes — OFI falls back to book-only/null and Hawkes clears its in-memory state on the deploy restart.

**Tech Stack:** TypeScript (Node), vitest, PostgreSQL/TimescaleDB.

**Spec:** `docs/superpowers/specs/2026-06-06-trades-misattribution-fix-design.md`. Read it for the root-cause evidence and blast-radius audit.

**Branch:** `fix-trades-misattribution` (already created off `main`).

**Background the implementer needs:**
- Root cause: `ClobCollector.fetchTrades(tokenId)` called `data-api/trades?asset_id=<tokenId>`, but the data-api IGNORES `asset_id` and returns a GLOBAL feed of recent trades across all markets; `syncTradesToDb` tagged every one with the queried token. Only `market=<conditionId>` filters correctly.
- A data-api trade object has these relevant fields: `asset` (the CLOB token id the trade belongs to), `side` (`BUY`/`SELL`), `price` (string), `size` (string), `timestamp` (unix **seconds**), `transactionHash`, `proxyWallet`, `outcome`, `conditionId`.
- `markets` columns: `id`, `condition_id`, `clob_token_id_yes`, `clob_token_id_no`, `tracking_status`, `market_score`.
- `trades` table: `id SERIAL`, PK `(time, id)`, columns `time, market_id, token_id, side, price, size, value_usd, fee, maker_address, taker_address, tx_hash, ...`. It is a TimescaleDB hypertable partitioned on `time` (so any unique index MUST include `time`).
- Test infra: `vitest`. Mock `../database/connection.js` (`query`), `../services/RateLimiter.js` (`getRateLimiter`), and `axios`. Run tests from `packages/data-collector`.

---

## Task 1: Fix `ClobCollector` trade collection (query by market, store by asset, real dedup)

The three trade methods are interdependent (changing `fetchTrades`'s parameter cascades), so they change together in one commit to keep the build green.

**Files:**
- Modify: `packages/data-collector/src/collectors/ClobCollector.ts` (`fetchTrades`, `syncTradesToDb`, `syncAllTrades`)
- Create: `packages/data-collector/src/collectors/ClobCollector.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/data-collector/src/collectors/ClobCollector.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../database/connection.js', () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock('../services/RateLimiter.js', () => ({
  getRateLimiter: () => ({ acquire: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock('axios', () => {
  const get = vi.fn();
  return { default: { get, create: () => ({ get }) } };
});

import axios from 'axios';
import { query } from '../database/connection.js';
import { ClobCollector } from './ClobCollector.js';

const YES = '11111111111111111111111111111111111111111111111111111111111111111111111111111';
const NO  = '22222222222222222222222222222222222222222222222222222222222222222222222222222';
const OTHER = '99999999999999999999999999999999999999999999999999999999999999999999999999999';
const COND = '0xcond';

function trade(asset: string, side: string, price: string, ts: number, tx: string) {
  return { asset, side, price, size: '10', timestamp: ts, transactionHash: tx, proxyWallet: '0xw' };
}

beforeEach(() => {
  vi.clearAllMocks();
  (query as any).mockResolvedValue({ rowCount: 0, rows: [] });
});

describe('ClobCollector.fetchTrades', () => {
  it('queries the data-api by market (conditionId), not asset_id', async () => {
    (axios.get as any).mockResolvedValue({ data: [] });
    const c = new ClobCollector();
    await c.fetchTrades(COND);
    const [, opts] = (axios.get as any).mock.calls[0];
    expect(opts.params.market).toBe(COND);
    expect(opts.params).not.toHaveProperty('asset_id');
  });
});

describe('ClobCollector.syncTradesToDb', () => {
  const market = { id: 'mkt1', condition_id: COND, clob_token_id_yes: YES, clob_token_id_no: NO };

  it('stores each trade under its real asset (token_id) with the market id', async () => {
    (axios.get as any).mockResolvedValue({ data: [
      trade(YES, 'BUY', '0.93', 1000, '0xa'),
      trade(NO, 'SELL', '0.07', 1001, '0xb'),
    ] });
    const c = new ClobCollector();
    await c.syncTradesToDb(market);
    const insertCall = (query as any).mock.calls.find((c0: any[]) => /INSERT INTO trades/.test(c0[0]));
    expect(insertCall).toBeTruthy();
    const params = insertCall[1] as any[];
    expect(params).toContain(YES);    // a row keyed by the YES asset
    expect(params).toContain(NO);     // a row keyed by the NO asset
    expect(params).toContain('mkt1'); // market id present
  });

  it('skips trades whose asset is neither of the market two tokens', async () => {
    (axios.get as any).mockResolvedValue({ data: [ trade(OTHER, 'BUY', '0.5', 1000, '0xc') ] });
    const c = new ClobCollector();
    const res = await c.syncTradesToDb(market);
    expect(res.inserted).toBe(0);
    const insertCall = (query as any).mock.calls.find((c0: any[]) => /INSERT INTO trades/.test(c0[0]));
    expect(insertCall).toBeFalsy(); // nothing to insert
  });

  it('inserts with ON CONFLICT on the dedup key', async () => {
    (axios.get as any).mockResolvedValue({ data: [ trade(YES, 'BUY', '0.93', 1000, '0xa') ] });
    const c = new ClobCollector();
    await c.syncTradesToDb(market);
    const insertCall = (query as any).mock.calls.find((c0: any[]) => /INSERT INTO trades/.test(c0[0]));
    expect(insertCall[0]).toMatch(/ON CONFLICT \(time, tx_hash, token_id, side, price, size\) DO NOTHING/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/data-collector && npx vitest run src/collectors/ClobCollector.test.ts`
Expected: FAIL — `syncTradesToDb` currently takes `(marketId, tokenId)` not a market object, `fetchTrades` sends `asset_id`, and the INSERT lacks the new ON CONFLICT target.

- [ ] **Step 3: Rewrite `fetchTrades`**

In `packages/data-collector/src/collectors/ClobCollector.ts`, replace the `fetchTrades` method with:

```typescript
  /**
   * Fetch recent trades for a MARKET from the Data API (public, no auth).
   * NOTE: the data-api ignores `asset_id` (returns a global feed); only `market`
   * (the conditionId) filters. Each returned trade carries its real `asset`.
   */
  async fetchTrades(conditionId: string): Promise<any[]> {
    await this.rateLimiter.acquire('data_trades');

    try {
      const response = await axios.get('https://data-api.polymarket.com/trades', {
        params: { market: conditionId, limit: '100' },
        timeout: 15000,
      });
      return Array.isArray(response.data) ? response.data : [];
    } catch (error: any) {
      if (error.response?.status === 404) {
        return [];
      }
      throw error;
    }
  }
```

- [ ] **Step 4: Rewrite `syncTradesToDb`**

Replace the `syncTradesToDb` method with a version that takes a market row, stores each trade under its real `asset`, guards to the market's two tokens, and uses the real ON CONFLICT target:

```typescript
  /**
   * Sync a market's trades to the DB. One `market=conditionId` query returns both
   * outcomes' trades; each is stored under its real `asset` (token_id). Guards to
   * the market's two known tokens. Dedupes via the unique (time, tx_hash, token_id,
   * side, price, size) index.
   */
  async syncTradesToDb(market: {
    id: string;
    condition_id: string;
    clob_token_id_yes: string;
    clob_token_id_no: string | null;
  }): Promise<{ inserted: number }> {
    const cacheKey = `trades:${market.id}`;
    const lastSync = this.lastSyncTimeCache.get(cacheKey);

    const trades = await this.fetchTrades(market.condition_id);
    if (trades.length === 0) {
      this.lastSyncTimeCache.set(cacheKey, new Date());
      return { inserted: 0 };
    }

    const validTokens = new Set(
      [market.clob_token_id_yes, market.clob_token_id_no].filter(Boolean) as string[]
    );

    // Keep only trades for THIS market's tokens, newer than the last sync.
    const newTrades = trades.filter((t: any) => {
      if (!validTokens.has(String(t.asset))) return false;
      if (lastSync) return new Date((t.timestamp || 0) * 1000) > lastSync;
      return true;
    });

    if (newTrades.length === 0) {
      this.lastSyncTimeCache.set(cacheKey, new Date());
      return { inserted: 0 };
    }

    const values: any[] = [];
    const placeholders: string[] = [];
    newTrades.forEach((t: any, idx: number) => {
      const baseIdx = idx * 8;
      placeholders.push(
        `($${baseIdx + 1}, $${baseIdx + 2}, $${baseIdx + 3}, $${baseIdx + 4}, $${baseIdx + 5}, $${baseIdx + 6}, $${baseIdx + 7}, $${baseIdx + 8})`
      );
      const tradeTime = new Date((t.timestamp || 0) * 1000);
      const side = (t.side || 'BUY').toUpperCase() === 'BUY' ? 'buy' : 'sell';
      values.push(
        tradeTime,                       // time
        market.id,                       // market_id
        String(t.asset),                 // token_id (the trade's REAL asset)
        side,                            // side
        parseFloat(t.price) || 0,        // price
        parseFloat(t.size) || 0,         // size
        t.proxyWallet || null,           // maker_address
        t.transactionHash || null,       // tx_hash
      );
    });

    try {
      const result = await query(
        `INSERT INTO trades (time, market_id, token_id, side, price, size, maker_address, tx_hash)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (time, tx_hash, token_id, side, price, size) DO NOTHING`,
        values
      );
      const inserted = result.rowCount || 0;
      this.lastSyncTimeCache.set(cacheKey, new Date());
      if (inserted > 0) {
        logger.debug({ marketId: market.id, inserted, total: newTrades.length }, 'Synced trades');
      }
      return { inserted };
    } catch (error) {
      logger.error({ error, marketId: market.id }, 'Error inserting trades');
      return { inserted: 0 };
    }
  }
```

- [ ] **Step 5: Rewrite `syncAllTrades`**

Replace the `syncAllTrades` method body's market query and loop with a per-market call (one `market=` query covers both tokens):

```typescript
  async syncAllTrades(): Promise<{ markets: number; totalInserted: number; errors: number }> {
    const marketsResult = await query(
      `SELECT id, condition_id, clob_token_id_yes, clob_token_id_no
       FROM markets
       WHERE tracking_status IN ('warming', 'active', 'cooling')
         AND condition_id IS NOT NULL
       ORDER BY market_score DESC NULLS LAST`
    );

    const markets = marketsResult.rows;
    let totalInserted = 0;
    let errors = 0;

    for (const market of markets) {
      try {
        const res = await this.syncTradesToDb(market);
        totalInserted += res.inserted;
      } catch (error) {
        logger.error({ error, marketId: market.id }, 'Error syncing trades');
        errors++;
      }
    }

    logger.info({ markets: markets.length, totalInserted, errors }, 'Trades synced');
    return { markets: markets.length, totalInserted, errors };
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/data-collector && npx vitest run src/collectors/ClobCollector.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Typecheck the package**

Run: `cd packages/data-collector && npx tsc --noEmit`
Expected: no errors. (If any other caller referenced the old `syncTradesToDb(marketId, tokenId)` signature, fix it — grep `syncTradesToDb` first; only `syncAllTrades` and the test should call it.)

- [ ] **Step 8: Commit**

```bash
git add packages/data-collector/src/collectors/ClobCollector.ts packages/data-collector/src/collectors/ClobCollector.test.ts
git commit -m "fix(data-collector): query trades by market=conditionId, store under real asset

The data-api ignores asset_id and returns a global feed; the collector was tagging
every trade with the queried token, corrupting the trades table. Query by market
(conditionId), store each trade under its real asset, guard to the market two tokens,
and dedupe via ON CONFLICT (time, tx_hash, token_id, side, price, size)."
```

---

## Task 2: Add the dedup unique index to the schema

**Files:**
- Modify: `packages/data-collector/src/database/init/001_schema.sql`

- [ ] **Step 1: Add the unique index after the trades indexes**

In `packages/data-collector/src/database/init/001_schema.sql`, immediately after the existing `idx_trades_taker` index (around line 174), add:

```sql
-- Dedup key for ON CONFLICT in ClobCollector.syncTradesToDb. Must include the
-- hypertable partition column (time). Rows with a NULL tx_hash are not deduped.
CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_dedup
  ON trades (time, tx_hash, token_id, side, price, size);
```

- [ ] **Step 2: Verify the SQL parses (no DB run needed here)**

Run: `node -e "const fs=require('fs');const s=fs.readFileSync('packages/data-collector/src/database/init/001_schema.sql','utf8');if(!/idx_trades_dedup/.test(s))throw new Error('missing index');console.log('ok')"`
Expected: prints `ok`. (Init SQL only runs on a fresh volume; the existing VM gets this index via the ops step in Task 3.)

- [ ] **Step 3: Commit**

```bash
git add packages/data-collector/src/database/init/001_schema.sql
git commit -m "fix(data-collector): add trades dedup unique index for fresh installs"
```

---

## Task 3: Deploy and one-time VM remediation (ops)

This task runs **after the PR merges and CI deploys the new data-collector image**. It is operational (no code). Order matters: deploy → truncate → index (the index must be built on the empty table; the contaminated table's duplicates would violate uniqueness).

- [ ] **Step 1: Confirm the new image is deployed**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b -- "cd /home/Usuario/polymarket-trader && git log --oneline -1 && docker compose -f docker-compose.gcp.yml ps"
```
Expected: the merge commit is present and `polymarket-data-collector` is `Up (healthy)`.

- [ ] **Step 2: Purge the contaminated history, then create the index**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b -- "docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c 'TRUNCATE trades;' -c 'CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_dedup ON trades (time, tx_hash, token_id, side, price, size);'"
```
Expected: `TRUNCATE TABLE` then `CREATE INDEX`.

- [ ] **Step 3: Wait for repopulation, then verify reconciliation**

Wait ~10 minutes for the trade-sync cron to repopulate, then run the reconciliation check (sampled trade prices for a token must cluster near that token's book, not span 0–1):

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b -- "docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"
WITH tk AS (
  SELECT t.token_id FROM trades t
  WHERE t.time>NOW()-INTERVAL '30 minutes'
    AND EXISTS (SELECT 1 FROM orderbook_snapshots o WHERE o.token_id=t.token_id AND o.time>NOW()-INTERVAL '30 minutes')
  GROUP BY t.token_id ORDER BY COUNT(*) DESC LIMIT 1)
SELECT t.price AS trade_price,
  (SELECT o.best_bid FROM orderbook_snapshots o WHERE o.token_id=t.token_id AND o.time<=t.time ORDER BY o.time DESC LIMIT 1) AS bid,
  (SELECT o.best_ask FROM orderbook_snapshots o WHERE o.token_id=t.token_id AND o.time<=t.time ORDER BY o.time DESC LIMIT 1) AS ask
FROM trades t JOIN tk ON tk.token_id=t.token_id
WHERE t.time>NOW()-INTERVAL '30 minutes' ORDER BY t.time DESC LIMIT 10;\""
```
Expected: every `trade_price` lies at or between `bid` and `ask` (within a few cents) for the token — NOT prices like 0.05 against a 0.93/0.94 book. If prices still span 0–1, the fix did not take — stop and investigate before declaring success.

---

## Task 4: Update memory

**Files:**
- Modify: `C:\Users\Usuario\.claude\projects\C--Users-Usuario-github-polymarket-trader\memory\MEMORY.md` (index line)
- Create: `C:\Users\Usuario\.claude\projects\C--Users-Usuario-github-polymarket-trader\memory\project_trades_misattribution_2026-06-06.md`

- [ ] **Step 1: Write the memory note**

Create `project_trades_misattribution_2026-06-06.md` recording: the root cause (data-api ignores `asset_id`, returns a global feed; collector tagged every trade with the queried token), the fix (query `market=conditionId`, store under `trade.asset`, dedup index, TRUNCATE), the blast radius (OFI + Hawkes were live on noise; MultiLevelOFI/VolumeAnomaly/backtest/paper_trades unaffected), and the **follow-up**: re-measure OFI/Hawkes edge with `scripts/p2-tstat.js` after several days of clean data, and **resume the parked H-MM-1** (`mm-spread-h-mm-1` branch) now that trade prices reconcile with the book. Add the PR number once merged. Follow the memory frontmatter format and link `[[project_p2_results_2026-05-11]]` and `[[next-levers-market-making-informational-edge-harness-automation]]`.

- [ ] **Step 2: Add the index pointer**

Add a one-line pointer under "Latest verified work" in `MEMORY.md`.

(No commit required — memory files persist as plain files.)

---

## Notes for the implementer

- Keep the `lastSyncTimeCache` map; only the key changes (per market, `trades:${market.id}`).
- Do NOT change OFI/Hawkes or any signal weights — the spec justifies why no gate is needed.
- The data-api `timestamp` is unix **seconds** (multiply by 1000 for `Date`), as the old code did.
- After Task 1, grep `syncTradesToDb` across the repo to confirm only `syncAllTrades` (and the test) call it; fix any other caller to the new single-argument signature.
- Final check before finishing the branch: `cd packages/data-collector && npx vitest run && npx tsc --noEmit` green, then use superpowers:finishing-a-development-branch (Option 2: push + PR). Tasks 3 and 4 happen after merge/deploy.
