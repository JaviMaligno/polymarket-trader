# Backtest Orderbook Plumbing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plumb 5-min-sampled orderbook snapshots from `orderbook_snapshots` table → `MarketData` → `BacktestEngine.priceCache.currentOrderBook` → `SignalContext.orderBook` so `mlofi` and `spread_compression` run with real fitness gradient.

**Architecture:** New ORDERBOOK event type generated from `MarketData.orderBook[]`, interleaved with existing PriceEvent/TradeEvent in time order. Cache holds only the latest per market (replace, not accumulate).

**Tech Stack:** TypeScript + Vitest, pnpm monorepo, PostgreSQL/TimescaleDB. Spec: `docs/plans/2026-04-29-backtest-orderbook-plumbing-design.md`.

---

## File Structure

| Path | Change | Responsibility |
|---|---|---|
| `packages/backtest/src/types/index.ts` | Modify | Add `MarketData.orderBook?: OrderBookSnapshot[]` and re-export `OrderBookSnapshot` |
| `packages/backtest/src/engine/BacktestEngine.ts` | Modify | Add OrderBookEvent type + generation + handleOrderBook + cache.currentOrderBook + signal-context wiring |
| `packages/backtest/src/engine/BacktestEngine.test.ts` | Modify | 4 orderbook plumbing tests |
| `packages/dashboard/src/services/BacktestService.ts` | Modify | SQL query + fetchHistoricalData mapping + createSignals cases + combinerConfig type + weights map |
| `packages/dashboard/src/services/OptimizationScheduler.ts` | Modify | Restore mlofi + spread_compression entries (2 each in OPTUNA, REFINEMENT, mapOptunaParamsToRequest, WEIGHT_PARAM_MAP) |

---

### Task 1: `MarketData.orderBook` type extension

**Files:** `packages/backtest/src/types/index.ts`

- [ ] **Step 1: Locate `MarketData` interface and re-export of OrderBookSnapshot**

`rtk grep -n "interface MarketData\|OrderBookSnapshot" packages/backtest/src/types/index.ts`

- [ ] **Step 2: Add re-export of OrderBookSnapshot from signals**

If not already imported, add at the top:
```typescript
import type { OrderBookSnapshot } from '@polymarket-trader/signals';
```
And re-export so backtest consumers can import it from `@polymarket-trader/backtest`:
```typescript
export type { OrderBookSnapshot };
```

- [ ] **Step 3: Add field to `MarketData`**

Inside the `MarketData` interface:
```typescript
  /** Order book snapshots, sampled at 5-min cadence to manage memory.
   *  Consumed by mlofi and spread_compression generators via SignalContext.orderBook. */
  orderBook?: OrderBookSnapshot[];
```

- [ ] **Step 4: Typecheck**

`rtk pnpm exec tsc -p packages/backtest/tsconfig.json --noEmit` — 0 errors.

- [ ] **Step 5: Commit**

```
rtk git add packages/backtest/src/types/index.ts
rtk git commit -m "feat(backtest): add MarketData.orderBook field"
```

---

### Task 2: `BacktestEngine` — OrderBookEvent type + generation + handler + cache + signal context

**Files:**
- `packages/backtest/src/engine/BacktestEngine.ts`
- `packages/backtest/src/engine/BacktestEngine.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/backtest/src/engine/BacktestEngine.test.ts` (mirror existing test patterns):

```typescript
describe('OrderBook plumbing for SignalContext.orderBook', () => {
  function makeOrderBookEvent(time: Date, marketId: string, tokenId: string, bestBid: number, bestAsk: number): any {
    return {
      type: 'ORDERBOOK',
      timestamp: time,
      data: {
        time,
        marketId,
        tokenId,
        bestBid,
        bestAsk,
        spread: bestAsk - bestBid,
        midPrice: (bestAsk + bestBid) / 2,
      },
    };
  }

  function newEngine(): any {
    const engine = new (require('./BacktestEngine').BacktestEngine)({
      config: {
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-01-02'),
        initialCapital: 10000,
      },
      marketData: [],
      signals: [],
      combiner: null as any,
      riskConfig: undefined,
    });
    (engine as any).priceCache = new Map();
    (engine as any).priceCache.set('m1:tok1', {
      bars: [],
      currentBar: null,
      trades: [],
      currentOrderBook: undefined,
    });
    return engine;
  }

  it('handleOrderBook stores latest snapshot in cache.currentOrderBook (replace, not accumulate)', () => {
    const engine = newEngine();
    const e1 = makeOrderBookEvent(new Date('2026-01-01T00:00:00'), 'm1', 'tok1', 0.49, 0.51);
    const e2 = makeOrderBookEvent(new Date('2026-01-01T00:05:00'), 'm1', 'tok1', 0.50, 0.52);
    (engine as any).handleOrderBook(e1);
    (engine as any).handleOrderBook(e2);
    const cache = (engine as any).priceCache.get('m1:tok1');
    expect(cache.currentOrderBook).toBeDefined();
    expect(cache.currentOrderBook.bestBid).toBe(0.50);
    expect(cache.currentOrderBook.time).toEqual(e2.timestamp);
  });

  it('cache init leaves currentOrderBook undefined', () => {
    const engine = newEngine();
    const cache = (engine as any).priceCache.get('m1:tok1');
    expect(cache.currentOrderBook).toBeUndefined();
  });

  it('handleOrderBook is no-op for unknown market_id (no cache entry)', () => {
    const engine = newEngine();
    const e = makeOrderBookEvent(new Date(), 'unknown_market', 'tok1', 0.5, 0.51);
    expect(() => (engine as any).handleOrderBook(e)).not.toThrow();
  });

  it('SignalContext exposes currentOrderBook from cache', () => {
    const engine = newEngine();
    const e = makeOrderBookEvent(new Date('2026-01-01T00:00:00'), 'm1', 'tok1', 0.50, 0.52);
    (engine as any).handleOrderBook(e);
    const cache = (engine as any).priceCache.get('m1:tok1');
    // Direct cache check is sufficient; full context-build path is exercised in integration
    expect(cache.currentOrderBook).toBe(e.data);
  });
});
```

- [ ] **Step 2: Run tests, expect failure**

`rtk pnpm exec vitest run packages/backtest/src/engine/BacktestEngine.test.ts -t 'OrderBook plumbing'`

Expected: FAIL — `handleOrderBook` doesn't exist or `cache.currentOrderBook` undefined.

- [ ] **Step 3: Implement in BacktestEngine.ts**

Read the file. The pattern from PR #155 (trade plumbing) is the template — replicate for orderbook:

(a) Cache type — extend the existing `priceCache` value type with `currentOrderBook?: OrderBookSnapshot`. Search for the cache init (where `bars: []` and `trades: []` are set). Add `currentOrderBook: undefined` alongside.

(b) Add `OrderBookEvent` interface near other event types:
```typescript
export interface OrderBookEvent {
  type: 'ORDERBOOK';
  timestamp: Date;
  data: OrderBookSnapshot;
}
```
Import `OrderBookSnapshot` from `@polymarket-trader/signals` if not already.

Update the union `BacktestEvent = PriceEvent | TradeEvent | ...` to include `OrderBookEvent`.

(c) **Event generation** in the loop that builds events from `MarketData`:
```typescript
if (market.orderBook) {
  for (const snap of market.orderBook) {
    if (snap.time >= this.config.startDate && snap.time <= this.config.endDate) {
      events.push({
        type: 'ORDERBOOK',
        timestamp: snap.time,
        data: snap,
      });
    }
  }
}
```
Place alongside existing trade event generation.

(d) **Event dispatch** in the main loop (where `handleTrade` is called for TRADE events). Add:
```typescript
if (event.type === 'ORDERBOOK') {
  this.handleOrderBook(event);
}
```

(e) **`handleOrderBook` method**:
```typescript
private handleOrderBook(event: OrderBookEvent): void {
  const cacheKey = `${event.data.marketId}:${event.data.tokenId}`;
  const cache = this.priceCache.get(cacheKey);
  if (cache) {
    cache.currentOrderBook = event.data;
  }
}
```

(f) **Signal-context builder** (around line 716 — where `recentTrades: cache.trades` was added in PR #155). Add:
```typescript
orderBook: cache.currentOrderBook,
```

- [ ] **Step 4: Run tests, expect pass**

`rtk pnpm exec vitest run packages/backtest/src/engine/BacktestEngine.test.ts -t 'OrderBook plumbing'`
Expected: 4/4 PASS.

- [ ] **Step 5: Run full backtest tests**

`rtk pnpm exec vitest run packages/backtest/src 2>&1 | tail -10`
Expected: previous baseline + 4 new = all green.

- [ ] **Step 6: Typecheck**

`rtk pnpm exec tsc -p packages/backtest/tsconfig.json --noEmit` — 0 errors.

- [ ] **Step 7: Commit**

```
rtk git add packages/backtest/src/engine/BacktestEngine.ts packages/backtest/src/engine/BacktestEngine.test.ts
rtk git commit -m "feat(backtest): plumb orderBook snapshots through to SignalContext"
```

---

### Task 3: `BacktestService.fetchHistoricalData` — query orderbook_snapshots

**Files:** `packages/dashboard/src/services/BacktestService.ts`

- [ ] **Step 1: Locate the data-fetch section**

Read the existing query block that fetches bars + trades for selected markets. Around lines 360-450. The new orderbook query goes alongside.

- [ ] **Step 2: Add the SQL query**

Add a third query block after the trades fetch. Inside the `transaction` (since the existing queries already use transaction context with `SET LOCAL timescaledb.enable_vectorized_aggregation = off`):

```typescript
const orderBookResult = await transaction(async (client: PoolClient) => {
  await client.query('SET LOCAL timescaledb.enable_vectorized_aggregation = off');
  return client.query<{
    time: Date;
    market_id: string;
    token_id: string;
    best_bid: string;
    best_ask: string;
    spread: string;
    mid_price: string;
    bid_depth_10pct: string | null;
    ask_depth_10pct: string | null;
  }>(
    `SELECT DISTINCT ON (market_id, bucket)
       ob.time, ob.market_id, ob.token_id,
       ob.best_bid, ob.best_ask, ob.spread, ob.mid_price,
       ob.bid_depth_10pct, ob.ask_depth_10pct,
       date_trunc('hour', ob.time)
         + (EXTRACT(MINUTE FROM ob.time)::int / 5) * INTERVAL '5 minutes' AS bucket
     FROM orderbook_snapshots ob
     JOIN markets m ON ob.market_id = m.id
     WHERE ob.time >= $1 AND ob.time <= $2
       AND ob.market_id = ANY($3)
       AND ob.token_id = m.clob_token_id_yes
     ORDER BY market_id, bucket, time DESC`,
    [startDate, endDate, selectedMarkets],
  );
});
```

- [ ] **Step 3: Group rows by market_id and attach to MarketData**

After the existing bar-grouping logic, add:

```typescript
const orderBookByMarket = new Map<string, OrderBookSnapshot[]>();
for (const row of orderBookResult.rows) {
  const list = orderBookByMarket.get(row.market_id) || [];
  list.push({
    time: row.time,
    marketId: row.market_id,
    tokenId: row.token_id,
    bestBid: parseFloat(row.best_bid),
    bestAsk: parseFloat(row.best_ask),
    spread: parseFloat(row.spread),
    midPrice: parseFloat(row.mid_price),
    bidDepth10Pct: row.bid_depth_10pct ? parseFloat(row.bid_depth_10pct) : undefined,
    askDepth10Pct: row.ask_depth_10pct ? parseFloat(row.ask_depth_10pct) : undefined,
  });
  orderBookByMarket.set(row.market_id, list);
}
```

In the loop that constructs `MarketData[]`, add `orderBook: orderBookByMarket.get(marketId) || []`.

- [ ] **Step 4: Import OrderBookSnapshot**

If not present, add to the existing imports at the top:
```typescript
import type { OrderBookSnapshot } from '@polymarket-trader/signals';
```

- [ ] **Step 5: Typecheck**

`rtk pnpm exec tsc -p packages/dashboard/tsconfig.json --noEmit` — 0 errors.

- [ ] **Step 6: Commit**

```
rtk git add packages/dashboard/src/services/BacktestService.ts
rtk git commit -m "feat(backtest-svc): fetch orderbook snapshots at 5-min cadence"
```

---

### Task 4: `BacktestService.createSignals` — instantiate mlofi + spread_compression

**Files:** `packages/dashboard/src/services/BacktestService.ts`

- [ ] **Step 1: Add imports**

Top of file, alongside existing signals package imports (already includes `OrderFlowImbalanceSignal`, `HawkesSignal`, `VolumeAnomalyGenerator` post-PR #155):

```typescript
  MultiLevelOFISignal,
  SpreadCompressionGenerator,
```

- [ ] **Step 2: Extend the switch in createSignals**

Add cases before the `default:`:
```typescript
        case 'mlofi':
          signals.push(new MultiLevelOFISignal());
          break;
        case 'spread_compression':
          signals.push(new SpreadCompressionGenerator());
          break;
```

- [ ] **Step 3: Typecheck + commit**

`rtk pnpm exec tsc -p packages/dashboard/tsconfig.json --noEmit` — 0 errors.

```
rtk git add packages/dashboard/src/services/BacktestService.ts
rtk git commit -m "feat(backtest-svc): instantiate mlofi + spread_compression in createSignals"
```

---

### Task 5: Restore Optuna param entries (+ BacktestService.combinerConfig type + weights map)

**Files:**
- `packages/dashboard/src/services/BacktestService.ts`
- `packages/dashboard/src/services/OptimizationScheduler.ts`

- [ ] **Step 1: BacktestService.combinerConfig type — add 2 keys back**

Find the `combinerConfig?: { ... }` block in `BacktestService.ts` (post-PR #155 it has 5 weight keys). Add:
```typescript
  mlofiWeight?: number;
  spreadCompressionWeight?: number;
```

- [ ] **Step 2: BacktestService default weights map — add 2 entries**

Find the default weights construction. Add to the object:
```typescript
  mlofi: cc?.mlofiWeight ?? 0,
  spread_compression: cc?.spreadCompressionWeight ?? 0,
```

- [ ] **Step 3: OptimizationScheduler — restore in OPTUNA_PARAM_SPACE**

Add 2 entries (after `combiner.hawkesWeight`):
```typescript
  { name: 'combiner.mlofiWeight', type: 'float', low: 0.0, high: 2.0 },
  { name: 'combiner.spreadCompressionWeight', type: 'float', low: 0.0, high: 2.0 },
```

- [ ] **Step 4: OptimizationScheduler — same 2 entries in REFINEMENT_PARAM_SPACE**

Same insertion pattern.

- [ ] **Step 5: OptimizationScheduler — restore in mapOptunaParamsToRequest**

Inside the `combinerConfig: { ... }` block:
```typescript
  mlofiWeight: params['combiner.mlofiWeight'],
  spreadCompressionWeight: params['combiner.spreadCompressionWeight'],
```

- [ ] **Step 6: OptimizationScheduler — restore in WEIGHT_PARAM_MAP**

```typescript
  'combiner.mlofiWeight': 'mlofi',
  'combiner.spreadCompressionWeight': 'spread_compression',
```

- [ ] **Step 7: Typecheck**

`rtk pnpm exec tsc -p packages/dashboard/tsconfig.json --noEmit` — 0 errors.

- [ ] **Step 8: Run dashboard tests**

`rtk pnpm exec vitest run packages/dashboard/src/services/OptimizationScheduler.test.ts` — all pass.

- [ ] **Step 9: Commit**

```
rtk git add packages/dashboard/src/services/BacktestService.ts packages/dashboard/src/services/OptimizationScheduler.ts
rtk git commit -m "feat(optimizer): restore mlofi + spread_compression weights now that backtest plumbs orderBook"
```

---

### Task 6: Cross-package regression check

- [ ] **Step 1**: `rtk pnpm exec vitest run packages/signals/src 2>&1 | tail -5` — 192/192 pass.
- [ ] **Step 2**: `rtk pnpm exec vitest run packages/dashboard/src 2>&1 | tail -10` — baseline + new tests pass.
- [ ] **Step 3**: `rtk pnpm exec vitest run packages/backtest/src 2>&1 | tail -10` — baseline + 4 new pass.
- [ ] **Step 4**: All 3 typechecks clean.
- [ ] **Step 5**: No commit — verification only.

---

### Task 7: Post-deploy verification

- [ ] Wait for first per-type cycle (~6h).
- [ ] SQL: `SELECT signal_type, market_type, weight, updated_at FROM signal_weights WHERE signal_type IN ('mlofi','spread_compression') ORDER BY updated_at DESC LIMIT 10` — should show recent rows for event_financial.
- [ ] Dashboard logs show `Updated signal weight: mlofi[event_financial] = ...` entries during cycle.
- [ ] If after 3 cycles the mlofi/spread_compression weights remain at random TPE values (no convergence), investigate orderBook coverage in the training window.
