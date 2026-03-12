import { describe, it, expect, beforeEach } from 'vitest';
import { CrossMarketCorrelationGenerator } from './CrossMarketCorrelationGenerator.js';
import type { SignalContext, PriceBar, MarketInfo } from '../../core/types/signal.types.js';

function makeBar(close: number, time?: Date): PriceBar {
  return {
    time: time ?? new Date(),
    open: close,
    high: close,
    low: close,
    close,
    volume: 100,
  };
}

function makeMarket(id: string, currentPriceYes?: number): MarketInfo {
  return {
    id,
    question: `Test market ${id}?`,
    isActive: true,
    isResolved: false,
    tokenIdYes: `token-yes-${id}`,
    currentPriceYes,
  };
}

function makeContext(
  bars: PriceBar[],
  relatedMarkets?: MarketInfo[],
  relatedMarketPriceChanges?: Record<string, number>
): SignalContext {
  return {
    currentTime: new Date(),
    market: makeMarket('market-1'),
    priceBars: bars,
    recentTrades: [],
    relatedMarkets,
    custom: relatedMarketPriceChanges != null
      ? { relatedMarketPriceChanges }
      : undefined,
  };
}

describe('CrossMarketCorrelationGenerator', () => {
  let generator: CrossMarketCorrelationGenerator;

  beforeEach(() => {
    generator = new CrossMarketCorrelationGenerator();
  });

  it('has signalId === "cross_market_corr"', () => {
    expect(generator.signalId).toBe('cross_market_corr');
  });

  it('returns null when no related markets', async () => {
    const bars = [makeBar(0.50), makeBar(0.50)];
    const ctx = makeContext(bars, [], { 'market-2': 0.10 });
    const result = await generator.compute(ctx);
    expect(result).toBeNull();
  });

  it('returns null when no relatedMarketPriceChanges in custom', async () => {
    const bars = [makeBar(0.50), makeBar(0.50)];
    const related = [makeMarket('market-2', 0.60)];
    const ctx = makeContext(bars, related, undefined);
    const result = await generator.compute(ctx);
    expect(result).toBeNull();
  });

  it('returns null when related changes are below threshold (<5%)', async () => {
    const bars = [makeBar(0.50), makeBar(0.50)];
    const related = [makeMarket('market-2', 0.52)];
    // +3% change — below the 5% minPriceChangePct threshold
    const ctx = makeContext(bars, related, { 'market-2': 0.03 });
    const result = await generator.compute(ctx);
    expect(result).toBeNull();
  });

  it('fires LONG when related markets moved +10% and this one was flat', async () => {
    // This market: flat (0% change)
    const bars = [makeBar(0.50), makeBar(0.50)];
    const related = [makeMarket('market-2', 0.60)];
    // avgRelatedChange = +10%, thisChange = 0%, lag = +10% → LONG
    const ctx = makeContext(bars, related, { 'market-2': 0.10 });
    const result = await generator.compute(ctx);

    expect(result).not.toBeNull();
    expect(result!.direction).toBe('LONG');
    expect(result!.strength).toBeGreaterThan(0);
    expect(result!.confidence).toBeGreaterThan(0);
  });

  it('fires SHORT when related markets moved -10% and this one was flat', async () => {
    // This market: flat (0% change)
    const bars = [makeBar(0.50), makeBar(0.50)];
    const related = [makeMarket('market-2', 0.40)];
    // avgRelatedChange = -10%, thisChange = 0%, lag = -10% → SHORT
    const ctx = makeContext(bars, related, { 'market-2': -0.10 });
    const result = await generator.compute(ctx);

    expect(result).not.toBeNull();
    expect(result!.direction).toBe('SHORT');
    expect(result!.strength).toBeLessThan(0);
    expect(result!.confidence).toBeGreaterThan(0);
  });

  it('returns null when this market already tracked the related movement (no lag)', async () => {
    // This market also moved +10%: firstBar=0.50, lastBar=0.55
    const bars = [makeBar(0.50), makeBar(0.55)];
    const related = [makeMarket('market-2', 0.60)];
    // avgRelatedChange = +10%, thisChange = +10%, lag = 0% → below lagThresholdPct (3%)
    const ctx = makeContext(bars, related, { 'market-2': 0.10 });
    const result = await generator.compute(ctx);
    expect(result).toBeNull();
  });
});
