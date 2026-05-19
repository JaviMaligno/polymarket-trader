# Price Inversion Fix — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stop storing No token prices in `price_history`, fix the SignalEngine to only read Yes token prices, and clean up corrupted data.

**Architecture:** Three ingestion paths write to `price_history`: ClobCollector (api source), ClobCollector snapshots, and DataCollectorService (collector source). Snapshots are correct (Yes-only). The other two write both Yes and No tokens. The SignalEngine reads by `market_id` without token filtering, mixing both token prices into signals. Fix all writers + add defense-in-depth filter on the reader.

**Tech Stack:** TypeScript, PostgreSQL/TimescaleDB, Vitest

---

## Context for the Implementer

### The Bug
`price_history` stores both Yes and No token prices under the same `market_id`. Since No price ~ 1 - Yes price, the SignalEngine sees wild oscillations (e.g., 0.85 -> 0.15 -> 0.85) every few seconds. This corrupts ALL signals and produces phantom PnL.

### The Invariant (from CLAUDE.md)
> "price_history: Only stores Yes token prices. No token price = 1 - Yes price."

### Affected Markets
29 of ~40 tracked markets. ~$15k phantom PnL in last 7 days.

### Three Ingestion Paths

| Path | File | Method | Lines | Source col | Bug? |
|------|------|--------|-------|-----------|------|
| CLOB API bars | `packages/data-collector/src/collectors/ClobCollector.ts` | `syncAllMarketsPriceHistory()` | 565-625 | (none/NULL) | YES - syncs both tokens |
| Snapshots | Same file | `snapshotCurrentPricesToHistory()` | 720-770 | `'snapshot'` | NO - Yes only |
| Dashboard collector | `packages/dashboard/src/services/DataCollectorService.ts` | `saveSnapshot()` | 133-182 | `'collector'` | YES - saves all tokens |

### Reader
| Path | File | Method | Lines | Bug? |
|------|------|--------|-------|------|
| Signal generation | `packages/dashboard/src/services/SignalEngine.ts` | (inline query) | 463-469 | YES - no token_id filter |

---

## Task 1: Fix ClobCollector — Remove No Token Sync

**Files:**
- Modify: `packages/data-collector/src/collectors/ClobCollector.ts:591-620`

**Step 1: Remove the No token sync block**

In `syncAllMarketsPriceHistory()`, delete the block that syncs the No token (lines ~601-609). The code currently looks like:

```typescript
// Sync YES token
const yesResult = await this.syncPriceHistoryToDb(
  market.id,
  market.clob_token_id_yes,
  60
);

// Sync NO token if exists   <-- DELETE THIS BLOCK
if (market.clob_token_id_no) {
  const noResult = await this.syncPriceHistoryToDb(
    market.id,
    market.clob_token_id_no,
    60
  );
}
```

Remove the entire `if (market.clob_token_id_no)` block and any references to `noResult` in the totals aggregation below it.

**Step 2: Verify the data-collector builds**

Run: `cd packages/data-collector && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add packages/data-collector/src/collectors/ClobCollector.ts
git commit -m "fix: remove No token price sync from ClobCollector"
```

---

## Task 2: Fix PolymarketService — Filter to Yes Token Only

**Files:**
- Modify: `packages/dashboard/src/services/PolymarketService.ts:564-587`

**Step 1: Filter the pollMarkets loop to only push Yes token prices**

The loop iterates over `updatedMarket.tokenIds` (both Yes and No). Change it to only process index 0 (Yes token) or filter by outcome name.

Current code (lines 564-587):
```typescript
for (let i = 0; i < updatedMarket.tokenIds.length; i++) {
  const price: PolymarketPrice = {
    marketId: updatedMarket.id,
    tokenId: updatedMarket.tokenIds[i],
    outcome: updatedMarket.outcomes[i],
    price: updatedMarket.outcomePrices[i],
    // ...
  };
  this.prices.set(`${marketId}:${price.tokenId}`, price);
  this.emit('price', price);
  priceUpdates.push({ ... });
}
```

**Fix approach**: The `outcomes` array is `['Yes', 'No']` for binary markets. Only push to `priceUpdates` when the outcome is `'Yes'`. Still emit price events for both (the in-memory price map may be used elsewhere), but only record Yes prices to the DB.

```typescript
for (let i = 0; i < updatedMarket.tokenIds.length; i++) {
  const price: PolymarketPrice = {
    marketId: updatedMarket.id,
    tokenId: updatedMarket.tokenIds[i],
    outcome: updatedMarket.outcomes[i],
    price: updatedMarket.outcomePrices[i],
    // ...
  };
  this.prices.set(`${marketId}:${price.tokenId}`, price);
  this.emit('price', price);

  // Only record Yes token prices to price_history (No = 1 - Yes, redundant)
  if (updatedMarket.outcomes[i] === 'Yes') {
    priceUpdates.push({ ... });
  }
}
```

**Important**: Verify the exact outcome string. Search the codebase for how `outcomes` is set — it might be `'Yes'`/`'No'` or something else. Check `PolymarketService.ts` where `outcomes` is populated from the API response.

**Step 2: Verify dashboard builds**

Run: `cd packages/dashboard && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add packages/dashboard/src/services/PolymarketService.ts
git commit -m "fix: only record Yes token prices to price_history from poll loop"
```

---

## Task 3: Fix SignalEngine — Add token_id Filter (Defense in Depth)

**Files:**
- Modify: `packages/dashboard/src/services/SignalEngine.ts:463-469`

**Step 1: Add token_id filter to the price_history query**

Current query (lines 463-469):
```sql
SELECT time, open, high, low, close, volume, bid, ask, source
FROM price_history
WHERE market_id = $1
ORDER BY time DESC
LIMIT 100
```

Change to join with markets table to filter by Yes token:
```sql
SELECT ph.time, ph.open, ph.high, ph.low, ph.close, ph.volume, ph.bid, ph.ask, ph.source
FROM price_history ph
JOIN markets m ON ph.market_id = m.condition_id
WHERE ph.market_id = $1
  AND ph.token_id = m.clob_token_id_yes
ORDER BY ph.time DESC
LIMIT 100
```

**Alternative** (if the market object is already available with `clob_token_id_yes`): pass it as `$2` parameter to avoid the JOIN.

Check what `market` object properties are available at the call site. If `market.clob_token_id_yes` exists, use:
```sql
SELECT time, open, high, low, close, volume, bid, ask, source
FROM price_history
WHERE market_id = $1 AND token_id = $2
ORDER BY time DESC
LIMIT 100
```
with params `[market.id, market.clob_token_id_yes]`.

**Step 2: Verify there are no other price_history read queries without token filtering**

Run: `grep -rn "FROM price_history" packages/dashboard/src/ packages/data-collector/src/`

For each match, verify it either:
- Filters by `token_id`, OR
- Is used for aggregation where mixing tokens is expected (unlikely), OR
- Needs the same fix

**Step 3: Verify dashboard builds**

Run: `cd packages/dashboard && npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add packages/dashboard/src/services/SignalEngine.ts
git commit -m "fix: filter price_history by Yes token_id in SignalEngine"
```

---

## Task 4: Fix Any Other price_history Readers

**Files:**
- Depends on Task 3 Step 2 findings

**Step 1: Apply the same token_id filter to any other query found**

Common locations to check:
- `StopLossService.ts` — reads prices for exit decisions
- `AutoSignalExecutor.ts` — reads current prices
- `PositionClosingService.ts` — gets exit price
- Backtesting code in `packages/backtest/`
- Any dashboard API endpoint that returns price data

For each: add `AND token_id = <yes_token_id>` or join with markets table.

**Step 2: Build and commit**

```bash
npx tsc --noEmit  # from relevant package
git add <modified files>
git commit -m "fix: filter price_history by Yes token in all read paths"
```

---

## Task 5: Run Tests

**Step 1: Run unit tests**

Run: `cd packages/dashboard && npx vitest run`
Expected: All tests pass

**Step 2: Run data-collector tests (if any)**

Run: `cd packages/data-collector && npx vitest run 2>/dev/null || echo "No tests"`

**Step 3: Fix any failures**

If tests fail due to the changes, fix them. The most likely failures:
- Tests that mock price_history queries may need updated SQL
- Tests that assert on No token price data being present

**Step 4: Commit fixes**

```bash
git add <files>
git commit -m "fix: update tests for Yes-only price_history"
```

---

## Task 6: Data Cleanup on VM

**Step 1: SSH to VM and delete No token rows**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b
```

```sql
-- First: count how many rows will be deleted
SELECT COUNT(*) AS no_token_rows
FROM price_history ph
JOIN markets m ON ph.market_id = m.condition_id
WHERE ph.token_id = m.clob_token_id_no;

-- Delete No token rows
DELETE FROM price_history ph
USING markets m
WHERE ph.market_id = m.condition_id
  AND ph.token_id = m.clob_token_id_no;

-- Verify: check for remaining inversions (should return 0)
SELECT COUNT(*) FROM (
  SELECT ph1.market_id
  FROM price_history ph1
  JOIN price_history ph2 ON ph1.market_id = ph2.market_id
    AND ph2.time BETWEEN ph1.time AND ph1.time + INTERVAL '60 seconds'
    AND ph2.time > ph1.time
  WHERE ph1.time > NOW() - INTERVAL '6 hours'
    AND ABS(ph1.close + ph2.close - 1.0) < 0.05
  LIMIT 1
) x;
```

**Step 2: Also clean up 'collector' source No token rows**

The dashboard's DataCollectorService uses a different token_id mapping. Check:
```sql
-- Find rows where token_id is NOT the Yes token for that market
SELECT COUNT(*) AS non_yes_rows
FROM price_history ph
JOIN markets m ON ph.market_id = m.condition_id
WHERE ph.token_id != m.clob_token_id_yes
  AND m.clob_token_id_yes IS NOT NULL;
```

Delete those too if count > 0.

---

## Task 7: Account Reset

**Step 1: Reset account since PnL is unreliable**

After deploying the fix and cleaning data:

```sql
-- Record current state before reset
SELECT current_capital, available_capital, total_realized_pnl, peak_equity
FROM paper_account WHERE id = 1;

-- Close all open positions (they were opened on corrupt signals)
UPDATE paper_positions SET closed_at = NOW(), size = 0
WHERE closed_at IS NULL;

-- Reset account
UPDATE paper_account SET
  current_capital = 10000,
  available_capital = 10000,
  total_realized_pnl = 0,
  total_fees_paid = 0,
  total_trades = 0,
  winning_trades = 0,
  losing_trades = 0,
  max_drawdown = 0,
  peak_equity = 10000,
  updated_at = NOW()
WHERE id = 1;
```

**Step 2: Update CLAUDE.md with reset info**

Add to the "Account Reset History" section in `scripts/daily-review-prompt.md`:
```
- **2026-03-26**: Price inversion reset. price_history stored both Yes and No token prices,
  corrupting all signals and producing phantom PnL. Cleaned data + reset to $10,000.
```

**Step 3: Update memory file `project_account_resets.md`**

---

## Task 8: Deploy and Verify

**Step 1: Push branch, create PR**

```bash
git push -u origin fix/price-inversion
gh pr create --title "fix: stop storing No token prices in price_history" \
  --body-file pr-body.md --label "daily-review"
```

**Step 2: Deploy to VM**

Either wait for CI/CD (if fixed) or deploy manually:
```bash
# Build locally
cd packages/data-collector && npx tsc
cd packages/dashboard && npx tsc

# Copy to VM
gcloud compute scp dist/ polymarket-vm:/tmp/fix-build/ --zone=us-east1-b
# OR use docker build + push
```

**Step 3: Verify fix on VM**

Wait 10 minutes for new data to accumulate, then:

```sql
-- Should return 0: no more inversions
SELECT COUNT(*)
FROM price_history ph1
JOIN price_history ph2 ON ph1.market_id = ph2.market_id
  AND ph2.time BETWEEN ph1.time AND ph1.time + INTERVAL '60 seconds'
  AND ph2.time > ph1.time
WHERE ph1.time > NOW() - INTERVAL '10 minutes'
  AND ABS(ph1.close + ph2.close - 1.0) < 0.05;

-- Should show only Yes token prices
SELECT DISTINCT ph.token_id, m.clob_token_id_yes, m.clob_token_id_no,
  CASE WHEN ph.token_id = m.clob_token_id_yes THEN 'YES' ELSE 'NO' END as token_type
FROM price_history ph
JOIN markets m ON ph.market_id = m.condition_id
WHERE ph.time > NOW() - INTERVAL '10 minutes';
```

Expected: Only `YES` in `token_type` column.

---

## Post-Fix: Remaining Items (separate PRs/sessions)

These are NOT part of this plan but should be done next:

1. **CI/CD fix**: Change `GH_TOKEN` in `daily-trade-review-claude.yml` from `${{ github.token }}` to `${{ secrets.MERGE_PAT }}`
2. **Optuna fix**: Remove `OPTIMIZER_URL` from docker-compose.gcp.yml or expose port 5432 on 0.0.0.0
3. **Reviewer prompt**: Already updated in this session (scripts/daily-review-prompt.md)
