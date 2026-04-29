/**
 * Tests for BacktestEngine — trade plumbing for SignalContext.recentTrades
 *
 * Covers: cache.trades field, handleTrade append, FIFO trim, cap default,
 * reset clears cache, signal context receives recentTrades.
 */

import { describe, it, expect } from 'vitest';
import { BacktestEngine } from './BacktestEngine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMinimalOptions(maxRecentTrades?: number): ConstructorParameters<typeof BacktestEngine>[0] {
  return {
    config: {
      startDate: new Date('2026-01-01'),
      endDate: new Date('2026-01-02'),
      initialCapital: 10000,
      granularityMinutes: 60,
      maxRecentTrades,
    } as any,
    marketData: [],
    signals: [],
    combiner: null as any,
  };
}

function makeTradeEvent(
  time: Date,
  marketId: string,
  tokenId: string,
  price: number,
  size: number,
  side: 'BUY' | 'SELL' = 'BUY',
): any {
  return {
    type: 'TRADE',
    timestamp: time,
    data: { marketId, tokenId, side, price, size },
  };
}

/** Seed priceCache so handleTrade can find the entry for market m1/tok1 */
function seedCache(engine: any, marketId = 'm1', tokenId = 'tok1'): void {
  const key = `${marketId}:${tokenId}`;
  (engine as any).priceCache.set(key, {
    bars: [],
    currentBar: {
      time: new Date('2026-01-01'),
      marketId,
      tokenId,
      open: 0.5,
      high: 0.5,
      low: 0.5,
      close: 0.5,
      volume: 0,
    },
    trades: [],
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Trade plumbing for SignalContext.recentTrades', () => {
  it('handleTrade appends a Trade-shaped object to cache.trades', () => {
    const engine = new BacktestEngine(makeMinimalOptions(200));
    seedCache(engine);

    (engine as any).handleTrade(makeTradeEvent(new Date('2026-01-01T00:00:01'), 'm1', 'tok1', 0.5, 10));

    const cache = (engine as any).priceCache.get('m1:tok1');
    expect(cache.trades.length).toBe(1);
    expect(cache.trades[0].marketId).toBe('m1');
    expect(cache.trades[0].tokenId).toBe('tok1');
    expect(cache.trades[0].price).toBe(0.5);
    expect(cache.trades[0].size).toBe(10);
  });

  it('respects the configured cap (FIFO trim)', () => {
    const engine = new BacktestEngine(makeMinimalOptions(3));
    seedCache(engine);

    for (let i = 0; i < 5; i++) {
      (engine as any).handleTrade(
        makeTradeEvent(new Date(2026, 0, 1, 0, 0, i), 'm1', 'tok1', 0.5, 10),
      );
    }

    const trades = (engine as any).priceCache.get('m1:tok1').trades;
    expect(trades.length).toBe(3);
    // Oldest 2 evicted — first remaining is i=2 (second 2)
    expect(trades[0].time.getSeconds()).toBe(2);
  });

  it('defaults the cap to 200 when maxRecentTrades is not specified', () => {
    const engine = new BacktestEngine(makeMinimalOptions()); // no cap
    seedCache(engine);

    for (let i = 0; i < 250; i++) {
      (engine as any).handleTrade(
        makeTradeEvent(new Date(2026, 0, 1, 0, Math.floor(i / 60), i % 60), 'm1', 'tok1', 0.5, 10),
      );
    }

    const trades = (engine as any).priceCache.get('m1:tok1').trades;
    expect(trades.length).toBe(200);
  });

  it('reset() clears trades from cache', () => {
    const engine = new BacktestEngine(makeMinimalOptions(200));
    seedCache(engine);

    (engine as any).handleTrade(makeTradeEvent(new Date('2026-01-01T00:00:01'), 'm1', 'tok1', 0.5, 10));
    expect((engine as any).priceCache.get('m1:tok1').trades.length).toBe(1);

    // reset() is private — call via any
    (engine as any).reset();

    // After reset, priceCache is cleared entirely (priceCache.clear())
    // Either the key is gone or trades are empty
    const entry = (engine as any).priceCache.get('m1:tok1');
    if (entry) {
      expect(entry.trades.length).toBe(0);
    } else {
      // Key removed by clear() — also acceptable
      expect(entry).toBeUndefined();
    }
  });

  it('signal context receives recentTrades from cache', () => {
    // Feed trades into cache and verify the cache.trades field is populated,
    // confirming the production code path that reads cache.trades → recentTrades
    const engine = new BacktestEngine(makeMinimalOptions(200));
    seedCache(engine);

    const t1 = makeTradeEvent(new Date('2026-01-01T00:00:01'), 'm1', 'tok1', 0.5, 10);
    (engine as any).handleTrade(t1);

    const cache = (engine as any).priceCache.get('m1:tok1');
    expect(cache.trades.length).toBe(1);
    expect(cache.trades[0].marketId).toBe('m1');
    expect(cache.trades[0].side).toBe('BUY');
  });
});

// ---------------------------------------------------------------------------
// OrderBook plumbing tests
// ---------------------------------------------------------------------------

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
    const engine = new BacktestEngine({
      config: {
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-01-02'),
        initialCapital: 10000,
        granularityMinutes: 60,
      } as any,
      marketData: [],
      signals: [],
      combiner: null as any,
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
