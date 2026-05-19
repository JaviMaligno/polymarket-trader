# Data-Collector Sync Optimization — CPU Fix

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix critical CPU usage (data-collector 400%, timescaledb 210%) caused by syncing all 52K+ Polymarket markets individually every 5 minutes.

**Architecture:** Limit GammaCollector sync to top markets by volume (not the entire catalog), batch SQL upserts instead of individual INSERTs, remove redundant double-sync in upsertEvent(), and reduce sync frequency for market/event discovery.

**Tech Stack:** TypeScript, PostgreSQL, node-cron

---

## Context

The data-collector has two kinds of sync:
1. **Market/event discovery** (`GammaCollector.syncMarketsToDb/syncEventsToDb`) — fetches from Gamma REST API, populates `markets`/`events` tables
2. **Price tracking** (`ClobCollector.updateAllMarketPrices`) — updates prices for tracked markets via CLOB API

Problem: #1 fetches ALL ~52K active markets (529 API pages) and upserts each individually (~108K SQL queries). On e2-micro (0.25 vCPU), this never completes. TimescaleDB autovacuum can't keep up → everything stalls.

ClobCollector already has `MAX_TRACKED_MARKETS` limiting price sync. GammaCollector has no such limit.

### Key Files

| File | Key Methods | Lines |
|------|-------------|-------|
| `packages/data-collector/src/collectors/GammaCollector.ts` | `syncMarketsToDb()` (200-260), `syncEventsToDb()` (265-322), `upsertMarket()` (327-398), `upsertEvent()` (403-480) |
| `packages/data-collector/src/services/Scheduler.ts` | `runInitialSync()` (196-222), cron defs (28-42), `syncMarkets()` (227-231), `syncEvents()` (236-240) |
| `packages/data-collector/src/collectors/ClobCollector.ts` | `updateAllMarketPrices()` (639-722), `MAX_TRACKED_MARKETS` (line 13) |

---

## Task 1: Add MAX_SYNC_PAGES limit to GammaCollector

Limit how many pages of markets/events we fetch from Gamma API. Top markets by volume come first, so 10 pages (1000 markets) is more than enough for the 50 we actually trade.

**Files:**
- Modify: `packages/data-collector/src/collectors/GammaCollector.ts:81-130` (fetchAllMarkets), `:135-178` (fetchAllEvents), `:200-260` (syncMarketsToDb), `:265-322` (syncEventsToDb)

**Step 1: Add config constant**

At the top of `GammaCollector.ts`, after existing imports/constants:

```typescript
const MAX_SYNC_PAGES = parseInt(process.env.MAX_SYNC_PAGES || '10', 10);
```

**Step 2: Add page limit to syncMarketsToDb()**

In `syncMarketsToDb()` (line ~200), add a page counter to the while loop. The loop currently runs until no more results. Add:

```typescript
let pageCount = 0;
// Inside the while loop, after processing a page:
pageCount++;
if (pageCount >= MAX_SYNC_PAGES) {
  console.log(`[GammaCollector] Reached MAX_SYNC_PAGES (${MAX_SYNC_PAGES}), stopping market sync`);
  break;
}
```

**Step 3: Add page limit to syncEventsToDb()**

Same pattern in `syncEventsToDb()` (line ~265):

```typescript
let pageCount = 0;
// Inside the while loop:
pageCount++;
if (pageCount >= MAX_SYNC_PAGES) {
  console.log(`[GammaCollector] Reached MAX_SYNC_PAGES (${MAX_SYNC_PAGES}), stopping event sync`);
  break;
}
```

**Step 4: Commit**

```bash
git add packages/data-collector/src/collectors/GammaCollector.ts
git commit -m "fix: limit market/event sync to MAX_SYNC_PAGES (default 10)

Syncing all 52K+ markets from Gamma API overwhelms the e2-micro VM.
Limit to 10 pages (1000 markets) — more than enough for the 50 we trade."
```

---

## Task 2: Batch upserts instead of individual INSERTs

Currently each market is upserted individually (1 SQL query per market). Batch into multi-row VALUES to reduce DB round-trips from ~1000 to ~10.

**Files:**
- Modify: `packages/data-collector/src/collectors/GammaCollector.ts:200-260` (syncMarketsToDb), `:265-322` (syncEventsToDb)

**Step 1: Create batchUpsertMarkets() method**

Add after `upsertMarket()` method:

```typescript
async batchUpsertMarkets(markets: any[]): Promise<{ inserted: number; updated: number }> {
  if (markets.length === 0) return { inserted: 0, updated: 0 };

  let inserted = 0;
  let updated = 0;

  // Process in batches of 100
  const BATCH_SIZE = 100;
  for (let i = 0; i < markets.length; i += BATCH_SIZE) {
    const batch = markets.slice(i, i + BATCH_SIZE);
    const values: any[] = [];
    const placeholders: string[] = [];

    batch.forEach((market, idx) => {
      const offset = idx * 18;
      // Parse CLOB token IDs
      let clobYes = market.clobTokenIds;
      let clobNo: string | null = null;
      if (typeof clobYes === 'string') {
        try {
          const parsed = JSON.parse(clobYes);
          clobYes = parsed[0] || market.clobTokenIds;
          clobNo = parsed[1] || null;
        } catch { /* keep as-is */ }
      }

      // Parse outcome prices
      let priceYes = market.outcomePrices ? null : (market.bestAsk || null);
      let priceNo: number | null = null;
      if (market.outcomePrices) {
        try {
          const prices = JSON.parse(market.outcomePrices);
          priceYes = parseFloat(prices[0]) || null;
          priceNo = parseFloat(prices[1]) || null;
        } catch { /* keep nulls */ }
      }

      const category = this.inferCategoryFromQuestion
        ? (this as any).constructor.inferCategoryFromQuestion?.(market.question)
        : null;

      values.push(
        market.id, clobYes, clobNo, market.conditionId || null,
        market.question, market.description || null,
        category || market.category || null,
        market.endDate || null,
        priceYes, priceNo,
        parseFloat(market.spread) || null,
        parseFloat(market.volume24hr) || null,
        parseFloat(market.liquidity) || null,
        parseFloat(market.bestBid) || null,
        parseFloat(market.bestAsk) || null,
        parseFloat(market.lastTradePrice) || null,
        market.active !== false,
        market.resolved === true
      );
      placeholders.push(
        `($${offset+1},$${offset+2},$${offset+3},$${offset+4},$${offset+5},$${offset+6},$${offset+7},$${offset+8},$${offset+9},$${offset+10},$${offset+11},$${offset+12},$${offset+13},$${offset+14},$${offset+15},$${offset+16},$${offset+17},$${offset+18})`
      );
    });

    const result = await this.db.query(`
      INSERT INTO markets (id, clob_token_id_yes, clob_token_id_no, condition_id,
        question, description, category, end_date,
        current_price_yes, current_price_no, spread, volume_24h, liquidity,
        best_bid, best_ask, last_trade_price, is_active, is_resolved)
      VALUES ${placeholders.join(',')}
      ON CONFLICT (id) DO UPDATE SET
        current_price_yes = EXCLUDED.current_price_yes,
        current_price_no = EXCLUDED.current_price_no,
        spread = EXCLUDED.spread,
        volume_24h = EXCLUDED.volume_24h,
        liquidity = EXCLUDED.liquidity,
        best_bid = EXCLUDED.best_bid,
        best_ask = EXCLUDED.best_ask,
        last_trade_price = EXCLUDED.last_trade_price,
        updated_at = NOW()
    `, values);

    // Approximate: can't distinguish insert vs update in multi-row, count total
    updated += batch.length;
  }

  return { inserted, updated };
}
```

**Step 2: Update syncMarketsToDb() to collect and batch**

Replace the per-market upsert loop (lines 230-241) with:
1. Collect all markets from the page into an array
2. Call `batchUpsertMarkets()` for the whole page at once

```typescript
// Instead of: for (const market of markets) { await this.upsertMarket(market); }
const result = await this.batchUpsertMarkets(markets);
inserted += result.inserted;
updated += result.updated;
```

**Step 3: Commit**

```bash
git add packages/data-collector/src/collectors/GammaCollector.ts
git commit -m "perf: batch market upserts (100 per query instead of 1)

Reduces DB round-trips from ~1000 to ~10 per sync cycle."
```

---

## Task 3: Remove double-sync of markets inside upsertEvent()

`upsertEvent()` (lines 443-456) loops through `event.markets` and calls `upsertMarket()` for each one, plus an additional `UPDATE markets SET event_id`. This duplicates the work of `syncMarketsToDb()`.

**Files:**
- Modify: `packages/data-collector/src/collectors/GammaCollector.ts:443-456`

**Step 1: Replace nested market upserts with event_id-only update**

Replace lines 443-456 with a single batch UPDATE that only sets event_id:

```typescript
// Instead of looping upsertMarket() + UPDATE for each market:
if (event.markets && event.markets.length > 0) {
  const marketIds = event.markets.map((m: any) => m.id).filter(Boolean);
  if (marketIds.length > 0) {
    await this.db.query(
      `UPDATE markets SET event_id = $1 WHERE id = ANY($2::varchar[])`,
      [event.id, marketIds]
    );
  }
}
```

**Step 2: Commit**

```bash
git add packages/data-collector/src/collectors/GammaCollector.ts
git commit -m "fix: remove double-sync of markets in upsertEvent()

upsertEvent() was calling upsertMarket() for each event's markets,
duplicating the work of syncMarketsToDb(). Now only sets event_id."
```

---

## Task 4: Reduce sync frequency for market/event discovery

Market discovery doesn't need to run every 5/10 minutes. New markets appear slowly. Hourly is plenty.

**Files:**
- Modify: `packages/data-collector/src/services/Scheduler.ts:32-33`

**Step 1: Change cron schedules**

```typescript
// Line 32: sync-markets from */5 to hourly
'sync-markets': '17 * * * *',      // Every hour at :17
// Line 33: sync-events from */10 to every 2 hours
'sync-events': '47 */2 * * *',     // Every 2 hours at :47
```

Use offset minutes (17, 47) to avoid stacking with other jobs that run at :00/:05.

**Step 2: Commit**

```bash
git add packages/data-collector/src/services/Scheduler.ts
git commit -m "perf: reduce market/event sync frequency to hourly/2h

Market discovery doesn't need 5-minute frequency. New markets appear
slowly. Reduces sustained DB load on e2-micro."
```

---

## Task 5: Add timeout to runInitialSync()

Currently `runInitialSync()` (line 196) runs all sync jobs sequentially on startup with no timeout. If market sync takes 1h+, the whole system is blocked.

**Files:**
- Modify: `packages/data-collector/src/services/Scheduler.ts:196-222`

**Step 1: Add per-job timeout wrapper**

```typescript
private async withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T | null> {
  const timeout = new Promise<null>((resolve) => {
    setTimeout(() => {
      console.warn(`[Scheduler] ${label} timed out after ${ms / 1000}s`);
      resolve(null);
    }, ms);
  });
  return Promise.race([promise, timeout]);
}
```

**Step 2: Wrap each initial sync call**

```typescript
// In runInitialSync(), wrap each call:
await this.withTimeout(this.syncEvents(), 120_000, 'Initial sync-events');
await this.withTimeout(this.syncMarkets(), 120_000, 'Initial sync-markets');
await this.withTimeout(this.syncPrices(), 60_000, 'Initial sync-prices');
// ... etc
```

**Step 3: Commit**

```bash
git add packages/data-collector/src/services/Scheduler.ts
git commit -m "fix: add 2-minute timeout to initial sync jobs

Prevents startup from blocking for hours if Gamma API is slow or
returning too many results."
```

---

## Task 6: Deploy and verify

**Step 1: Push to main**

```bash
git push origin main
```

**Step 2: Wait for CI/CD deploy**

```bash
gh run list --limit 3 --json name,status,conclusion
```

**Step 3: Verify CPU dropped on VM**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b -- 'docker stats --no-stream'
```

Expected: data-collector <50% CPU, timescaledb <100% CPU.

**Step 4: Verify signals are flowing**

```bash
curl -s http://34.148.24.147:3001/api/automation/status | jq '.data.executor.dailyTrades'
```

---

## Task 7: Merge PR #29 and close PR #28

PR #29 is a superset of #28 (includes backtest exports fix + capital invariant fix). Both are verified correct.

**Step 1: Merge PR #29**

```bash
gh pr merge 29 --squash
```

**Step 2: Close PR #28 as superseded**

```bash
gh pr close 28 --comment "Superseded by #29 which includes this fix plus the capital invariant correction."
```

**Step 3: Close stale PRs from yesterday if already fixed**

```bash
# PR #25 (BacktestService vectorization) — we already fixed this differently in main
gh pr close 25 --comment "Fixed in main via SET LOCAL timescaledb.enable_vectorized_aggregation = off (commit 76d7526)"
```
