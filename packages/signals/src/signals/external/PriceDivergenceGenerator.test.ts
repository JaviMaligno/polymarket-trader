import { describe, it, expect, beforeEach } from 'vitest';
import { PriceDivergenceGenerator } from './PriceDivergenceGenerator.js';
import type { SignalContext, MarketInfo } from '../../core/types/signal.types.js';

function makeContext(
  polymarketPrice: number | undefined,
  externalPrices: Array<{ platform: string; probability: number; confidence: number }> | undefined,
  overrides: Partial<MarketInfo> = {}
): SignalContext {
  const market: MarketInfo = {
    id: 'market-1',
    question: 'Test market?',
    isActive: true,
    isResolved: false,
    tokenIdYes: 'token-yes-1',
    currentPriceYes: polymarketPrice,
    ...overrides,
  };
  return {
    currentTime: new Date(),
    market,
    priceBars: [],
    recentTrades: [],
    custom: {
      ...(polymarketPrice !== undefined ? { polymarketPrice } : {}),
      ...(externalPrices !== undefined ? { externalPrices } : {}),
    },
  };
}

describe('PriceDivergenceGenerator', () => {
  let generator: PriceDivergenceGenerator;

  beforeEach(() => {
    generator = new PriceDivergenceGenerator();
  });

  it('has signalId === "price_divergence"', () => {
    expect(generator.signalId).toBe('price_divergence');
  });

  it('returns null when no external prices in custom', async () => {
    const ctx = makeContext(0.50, undefined);
    const result = await generator.compute(ctx);
    expect(result).toBeNull();
  });

  it('returns null when external prices array is empty', async () => {
    const ctx = makeContext(0.50, []);
    const result = await generator.compute(ctx);
    expect(result).toBeNull();
  });

  it('returns null when divergence is below minDivergencePp (5pp)', async () => {
    // PM=0.50, ext=0.53 → divergence=3pp < 5pp threshold
    const ctx = makeContext(0.50, [
      { platform: 'metaculus', probability: 0.53, confidence: 1.0 },
    ]);
    const result = await generator.compute(ctx);
    expect(result).toBeNull();
  });

  it('fires LONG when Polymarket is 10pp below external consensus', async () => {
    // PM=0.15, ext=[{prob:0.25, conf:0.9}] → divergence=+10pp → LONG
    const ctx = makeContext(0.15, [
      { platform: 'metaculus', probability: 0.25, confidence: 0.9 },
    ]);
    const result = await generator.compute(ctx);

    expect(result).not.toBeNull();
    expect(result!.direction).toBe('LONG');
    expect(result!.strength).toBeGreaterThan(0);
    expect(result!.confidence).toBeGreaterThan(0);
    // strength = min(1.0, 10 * 0.05) * 1 = 0.5
    expect(result!.strength).toBeCloseTo(0.5, 5);
  });

  it('fires SHORT when Polymarket is 10pp above consensus', async () => {
    // PM=0.60, ext=[{prob:0.50, conf:1.0}] → divergence=-10pp → SHORT
    const ctx = makeContext(0.60, [
      { platform: 'manifold', probability: 0.50, confidence: 1.0 },
    ]);
    const result = await generator.compute(ctx);

    expect(result).not.toBeNull();
    expect(result!.direction).toBe('SHORT');
    expect(result!.strength).toBeLessThan(0);
    // strength = min(1.0, 10 * 0.05) * -1 = -0.5
    expect(result!.strength).toBeCloseTo(-0.5, 5);
  });

  it('confidence is capped by match confidence formula', async () => {
    // PM=0.15, ext=[{prob:0.25, conf:0.5}] → divergence=10pp
    // avgMatchConfidence = 0.5, cap = 0.3 + 10*0.03 = 0.6 → confidence = min(0.5, 0.6) = 0.5
    const ctx = makeContext(0.15, [
      { platform: 'metaculus', probability: 0.25, confidence: 0.5 },
    ]);
    const result = await generator.compute(ctx);

    expect(result).not.toBeNull();
    expect(result!.confidence).toBeCloseTo(0.5, 5);
  });

  it('confidence is capped when match confidence exceeds divergence cap', async () => {
    // PM=0.15, ext=[{prob:0.20, conf:0.99}] → divergence=5pp
    // avgMatchConfidence=0.99, cap=0.3+5*0.03=0.45 → confidence=min(0.99,0.45)=0.45
    const ctx = makeContext(0.15, [
      { platform: 'metaculus', probability: 0.20, confidence: 0.99 },
    ]);
    const result = await generator.compute(ctx);

    expect(result).not.toBeNull();
    expect(result!.confidence).toBeCloseTo(0.45, 5);
  });

  it('uses weighted average when multiple external prices are provided', async () => {
    // PM=0.40, ext=[{prob:0.60, conf:1.0}, {prob:0.80, conf:1.0}]
    // weightedAvg = (0.60*1 + 0.80*1) / 2 = 0.70 → divergence=+30pp → LONG
    const ctx = makeContext(0.40, [
      { platform: 'metaculus', probability: 0.60, confidence: 1.0 },
      { platform: 'manifold', probability: 0.80, confidence: 1.0 },
    ]);
    const result = await generator.compute(ctx);

    expect(result).not.toBeNull();
    expect(result!.direction).toBe('LONG');
    // strength = min(1.0, 30*0.05) = 1.0
    expect(result!.strength).toBeCloseTo(1.0, 5);
  });

  it('falls back to context.market.currentPriceYes when polymarketPrice absent from custom', async () => {
    // No polymarketPrice in custom, but market.currentPriceYes=0.20
    // ext=[{prob:0.30, conf:1.0}] → divergence=+10pp → LONG
    const market: MarketInfo = {
      id: 'market-1',
      question: 'Test?',
      isActive: true,
      isResolved: false,
      tokenIdYes: 'token-yes-1',
      currentPriceYes: 0.20,
    };
    const ctx: SignalContext = {
      currentTime: new Date(),
      market,
      priceBars: [],
      recentTrades: [],
      custom: {
        externalPrices: [{ platform: 'metaculus', probability: 0.30, confidence: 1.0 }],
        // no polymarketPrice key
      },
    };
    const result = await generator.compute(ctx);

    expect(result).not.toBeNull();
    expect(result!.direction).toBe('LONG');
  });

  it('returns null when totalWeight is zero', async () => {
    // All confidences are 0 → totalWeight=0
    const ctx = makeContext(0.50, [
      { platform: 'metaculus', probability: 0.70, confidence: 0 },
    ]);
    const result = await generator.compute(ctx);
    expect(result).toBeNull();
  });

  it('getRequiredLookback returns 0', () => {
    expect(generator.getRequiredLookback()).toBe(0);
  });

  it('isReady returns true when externalPrices has entries', () => {
    const ctx = makeContext(0.50, [
      { platform: 'metaculus', probability: 0.60, confidence: 0.9 },
    ]);
    expect(generator.isReady(ctx)).toBe(true);
  });

  it('isReady returns false when externalPrices is empty or missing', () => {
    expect(generator.isReady(makeContext(0.50, []))).toBe(false);
    expect(generator.isReady(makeContext(0.50, undefined))).toBe(false);
  });
});
