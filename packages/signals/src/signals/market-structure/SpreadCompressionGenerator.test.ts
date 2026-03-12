import { describe, it, expect, beforeEach } from 'vitest';
import { SpreadCompressionGenerator } from './SpreadCompressionGenerator.js';
import type {
  SignalContext,
  MarketInfo,
  OrderBookSnapshot,
} from '../../core/types/signal.types.js';

function makeMarket(): MarketInfo {
  return {
    id: 'market-1',
    question: 'Test market?',
    isActive: true,
    isResolved: false,
    tokenIdYes: 'token-yes-1',
  };
}

function makeOrderBook(
  spread: number,
  bidDepth10Pct = 1000,
  askDepth10Pct = 500
): OrderBookSnapshot {
  return {
    time: new Date(),
    marketId: 'market-1',
    tokenId: 'token-yes-1',
    bestBid: 0.49,
    bestAsk: 0.49 + spread,
    spread,
    midPrice: 0.49 + spread / 2,
    bidDepth10Pct,
    askDepth10Pct,
  };
}

function makeContext(
  orderBook?: OrderBookSnapshot,
  historicalSpreads?: number[]
): SignalContext {
  return {
    currentTime: new Date(),
    market: makeMarket(),
    priceBars: [],
    recentTrades: [],
    orderBook,
    custom: historicalSpreads !== undefined ? { historicalSpreads } : undefined,
  };
}

/** Build 10+ historical spreads averaging `avg`, then return a context with a compressed current spread */
function makeCompressedContext(
  avgSpread: number,
  currentSpread: number,
  bidDepth10Pct = 1000,
  askDepth10Pct = 500
): SignalContext {
  const historicalSpreads = Array.from({ length: 10 }, () => avgSpread);
  return {
    currentTime: new Date(),
    market: makeMarket(),
    priceBars: [],
    recentTrades: [],
    orderBook: makeOrderBook(currentSpread, bidDepth10Pct, askDepth10Pct),
    custom: { historicalSpreads },
  };
}

describe('SpreadCompressionGenerator', () => {
  let generator: SpreadCompressionGenerator;

  beforeEach(() => {
    generator = new SpreadCompressionGenerator();
  });

  it('has signalId === "spread_compression"', () => {
    expect(generator.signalId).toBe('spread_compression');
  });

  it('returns null when no orderBook in context', async () => {
    const ctx = makeContext(undefined, [0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02]);
    const result = await generator.compute(ctx);
    expect(result).toBeNull();
  });

  it('returns null when no historicalSpreads in custom', async () => {
    const ctx = makeContext(makeOrderBook(0.01), undefined);
    const result = await generator.compute(ctx);
    expect(result).toBeNull();
  });

  it('returns null when fewer than minHistoricalSpreads (10)', async () => {
    const ctx = makeContext(makeOrderBook(0.01), [0.02, 0.02, 0.02]);
    const result = await generator.compute(ctx);
    expect(result).toBeNull();
  });

  it('fires LONG when spread compresses to <50% of avg AND bid depth > ask depth', async () => {
    // avgSpread = 0.02, currentSpread = 0.005 → compressionRatio = 0.25 < 0.5
    // bidDepth > askDepth → LONG
    const ctx = makeCompressedContext(0.02, 0.005, 1000, 500);
    const result = await generator.compute(ctx);

    expect(result).not.toBeNull();
    expect(result!.direction).toBe('LONG');
    expect(result!.strength).toBeGreaterThan(0);
    expect(result!.confidence).toBeGreaterThan(0.3);
  });

  it('fires SHORT when spread compresses AND ask depth > bid depth', async () => {
    // avgSpread = 0.02, currentSpread = 0.005 → compressionRatio = 0.25 < 0.5
    // askDepth > bidDepth → SHORT
    const ctx = makeCompressedContext(0.02, 0.005, 500, 1000);
    const result = await generator.compute(ctx);

    expect(result).not.toBeNull();
    expect(result!.direction).toBe('SHORT');
    expect(result!.strength).toBeLessThan(0);
  });

  it('returns null when spread is at normal levels (ratio >= threshold)', async () => {
    // avgSpread = 0.02, currentSpread = 0.018 → compressionRatio = 0.9 >= 0.5
    const ctx = makeCompressedContext(0.02, 0.018, 1000, 500);
    const result = await generator.compute(ctx);
    expect(result).toBeNull();
  });
});
