# Backtest orderbook plumbing — Design (mlofi + spread_compression)

**Status**: Active 2026-04-29.
**Branch**: `feat/backtest-orderbook-plumbing`.
**Closes**: 2 of the 6 remaining deferred generators from `project_backtest_signal_coverage.md` (mlofi, spread_compression).

## Goal

Plumb order-book snapshots through `BacktestService` → `BacktestEngine` → `SignalContext.orderBook` so `mlofi` and `spread_compression` generators run with non-null context. After PR #155 these were dropped from the optimizer param space because the backtest path didn't deliver orderBook. This restores them.

## Empirical foundations

- `orderbook_snapshots` table (5s native cadence per tracked market, 60-day retention as of 2026-04-29).
- 95-100% coverage of shadow markets per the 2026-04-29 audit.
- `OrderBookSnapshot` type in signals package has `bestBid, bestAsk, spread, midPrice, bidDepth10Pct?, askDepth10Pct?`. No multi-level levels — `MultiLevelOFISignal.computeFromBasicBook` is the fallback path when only best bid/ask are available.

## Memory budget

Loading raw 5s snapshots for a 14-day training window:
- 14 days × 24 h × 60 min × 12 (5s) × 50 markets ≈ 12 M rows ≈ 1 GB. **Not feasible.**

Sample at 5-minute resolution (matches `price_history` snapshot cadence):
- 14 days × 288 (5-min) × 50 markets ≈ 200 K rows × ~80 bytes ≈ 16 MB. **Feasible.**

5-minute sampling means generators see the latest book state at each 5-minute boundary. mlofi/spread_compression already operate on best-bid/best-ask + spread aggregate metrics, so 5-min snapshots capture the same information that bars do at the same cadence.

## Architecture

### 1. `MarketData` type extended

`packages/backtest/src/types/index.ts`:

```typescript
export interface MarketData {
  // ... existing fields ...
  bars: HistoricalBar[];
  trades: HistoricalTrade[];
  orderBook?: OrderBookSnapshot[];  // NEW: 5-min sampled book snapshots
}
```

`OrderBookSnapshot` is re-exported from the signals package (already typed identically).

### 2. `BacktestService.fetchHistoricalData` — query orderbook_snapshots

After fetching bars + trades, add a third query block that picks one snapshot per market per 5-minute bucket:

```sql
SELECT DISTINCT ON (market_id, bucket)
  ob.time, ob.market_id, ob.token_id,
  ob.best_bid, ob.best_ask, ob.spread, ob.mid_price,
  ob.bid_depth_10pct, ob.ask_depth_10pct,
  date_trunc('hour', ob.time)
    + (EXTRACT(MINUTE FROM ob.time)::int / 5) * INTERVAL '5 minutes' AS bucket
FROM orderbook_snapshots ob
JOIN markets m ON ob.market_id = m.id
WHERE ob.time >= $1 AND ob.time <= $2
  AND ob.market_id = ANY($3)  -- selectedMarkets from earlier query
  AND ob.token_id = m.clob_token_id_yes
ORDER BY market_id, bucket, time DESC
```

The `DISTINCT ON (market_id, bucket)` keeps the most recent snapshot in each 5-min window. Re-uses `selectedMarkets` from the existing top-markets query — no schema changes, no new index.

Map rows to `OrderBookSnapshot[]` and attach to each `MarketData.orderBook`.

### 3. `BacktestEngine` — orderbook event stream + cache

Mirrors the existing pattern for bars and trades (post-PR #155):

- **Event generation** (current code generates `PriceEvent` from bars + `TradeEvent` from trades): add `OrderBookEvent` generation from `market.orderBook`. Push into the same time-ordered event stream.
- **`handleOrderBook(event: OrderBookEvent)`**: set `cache.currentOrderBook = event.data` (replace, not accumulate — only the latest matters).
- **`priceCache` type**: add `currentOrderBook?: OrderBookSnapshot`.
- **Cache init**: `currentOrderBook: undefined`.
- **Signal-context builder**: pass `orderBook: cache.currentOrderBook` instead of `undefined`.
- **`reset()`**: `priceCache.clear()` already wipes everything — no per-entry change needed.

`OrderBookEvent` shape:

```typescript
interface OrderBookEvent extends BacktestEvent {
  type: 'ORDERBOOK';
  data: OrderBookSnapshot;
}
```

### 4. `BacktestService.createSignals` — instantiate mlofi + spread_compression

Add cases mirroring PR #155's pattern:

```typescript
case 'mlofi':
  signals.push(new MultiLevelOFISignal());
  break;
case 'spread_compression':
  signals.push(new SpreadCompressionGenerator());
  break;
```

### 5. Restore Optuna param entries

PR #155 dropped these. Now restore in:
- `OptimizationScheduler.OPTUNA_PARAM_SPACE` — add `combiner.mlofiWeight` and `combiner.spreadCompressionWeight` (low: 0.0, high: 2.0).
- `OptimizationScheduler.REFINEMENT_PARAM_SPACE` — same.
- `OptimizationScheduler.mapOptunaParamsToRequest.combinerConfig` — same 2 keys.
- `OptimizationScheduler.WEIGHT_PARAM_MAP` — `'combiner.mlofiWeight': 'mlofi'` and `'combiner.spreadCompressionWeight': 'spread_compression'`.
- `BacktestService.combinerConfig` type — `mlofiWeight?: number; spreadCompressionWeight?: number;`.
- `BacktestService` default weights map — `mlofi: cc?.mlofiWeight ?? 0; spread_compression: cc?.spreadCompressionWeight ?? 0`.

### 6. SQL migration NOT needed

The `init/027_*.sql` (PR #155) deleted per-type rows for these 6 generators. Going forward, when Optuna writes a winning trial via `WEIGHT_PARAM_MAP`, `signalWeightsRepo.updatePerType` UPSERTs new rows for mlofi and spread_compression. No schema action needed.

## Tests

### `BacktestEngine.test.ts`

- **OrderBookEvent accumulates only latest in cache**: feed 3 events for same market, assert `cache.currentOrderBook.time === third.time`.
- **`SignalContext.orderBook` populated**: assert non-undefined after one ORDERBOOK event.
- **No event → undefined**: cache init leaves `currentOrderBook` undefined; signal context shows `orderBook: undefined`.
- **`reset()` clears via priceCache.clear()**: existing test pattern; orderBook gone with the cache entry.

### `BacktestService.createSignals` (extend existing test or add new)

- `signalTypes = ['mlofi', 'spread_compression']` returns 2 instances.

### `BacktestService.fetchHistoricalData` (light coverage; full SQL exercised in integration smoke)

Skip dedicated test for the SQL — production data gives empirical coverage faster than mocked DB tests. Reasonable for a query-only change.

## Acceptance criteria

(a) **Per-task**: TDD red→green for each task; `pnpm tsc --noEmit` clean across signals/dashboard/backtest.

(b) **Post-deploy 6h** (next per-type cycle): SQL `SELECT signal_type, market_type, weight, updated_at FROM signal_weights WHERE signal_type IN ('mlofi', 'spread_compression') ORDER BY updated_at DESC LIMIT 10` shows recent rows for `event_financial` (the only type that passes OOS today). Confirms Optuna is writing mlofi/spread_compression weights again.

(c) **Post-deploy 7d**: variance of mlofi/spread_compression weights between cycles trends downward (TPE convergence with real fitness gradient).

(d) **No regression**: backtest cycle wall-clock does not regress >2× on e2-micro VM. Memory stays under 200 MB.

## Out of scope

- The remaining 4 deferred generators (cross_market_corr, price_divergence, attention_spike, news_sentiment) — separate spec each.
- Multi-level orderbook (top-N bids/asks) — current `OrderBookSnapshot` is best-only. mlofi runs in `computeFromBasicBook` mode. Restoring full multi-level needs `OrderBookSnapshot` type extension + ClobCollector schema update. Future work.

## Files touched

| Path | Change | Purpose |
|---|---|---|
| `packages/backtest/src/types/index.ts` | Modify | Add `MarketData.orderBook?: OrderBookSnapshot[]` |
| `packages/backtest/src/engine/BacktestEngine.ts` | Modify | OrderBookEvent gen + handleOrderBook + cache.currentOrderBook + signal context |
| `packages/backtest/src/engine/BacktestEngine.test.ts` | Modify | 4 orderbook plumbing tests |
| `packages/dashboard/src/services/BacktestService.ts` | Modify | SQL query + fetchHistoricalData mapping + createSignals cases + combinerConfig type + weights map |
| `packages/dashboard/src/services/OptimizationScheduler.ts` | Modify | Restore 2 entries in OPTUNA + REFINEMENT spaces, mapOptunaParamsToRequest, WEIGHT_PARAM_MAP |

No SQL migration. No env vars. No frontend.

## Risks

- **5-min sampling vs 5s production cadence**: orderbook generators see less granular history than live. For mlofi/spread_compression which work on best-bid/best-ask aggregates, this is acceptable — the 5-min snapshot captures the state at that boundary. For more granular OFI tick-level analytics this would matter; not relevant here.
- **DISTINCT ON SQL compatibility**: TimescaleDB supports it. Verify on first deploy.
- **Memory budget at 50+ markets × longer windows**: spec assumes 14-day window. If WALKFORWARD_CONFIG.totalPeriodDays grows, re-evaluate.
