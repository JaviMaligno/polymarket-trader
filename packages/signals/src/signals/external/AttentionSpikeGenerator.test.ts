import { describe, it, expect, beforeEach } from 'vitest';
import { AttentionSpikeGenerator } from './AttentionSpikeGenerator.js';
import type { SignalContext, MarketInfo } from '../../core/types/signal.types.js';

function makeContext(
  currentInterest: number | undefined,
  baselineInterest: number | undefined
): SignalContext {
  const market: MarketInfo = {
    id: 'market-1',
    question: 'Test market?',
    isActive: true,
    isResolved: false,
    tokenIdYes: 'token-yes-1',
  };
  return {
    currentTime: new Date(),
    market,
    priceBars: [],
    recentTrades: [],
    custom: {
      ...(currentInterest !== undefined ? { currentInterest } : {}),
      ...(baselineInterest !== undefined ? { baselineInterest } : {}),
    },
  };
}

describe('AttentionSpikeGenerator', () => {
  let generator: AttentionSpikeGenerator;

  beforeEach(() => {
    generator = new AttentionSpikeGenerator();
  });

  it('has signalId === "attention_spike"', () => {
    expect(generator.signalId).toBe('attention_spike');
  });

  it('returns null when currentInterest is 0', async () => {
    const ctx = makeContext(0, 100);
    const result = await generator.compute(ctx);
    expect(result).toBeNull();
  });

  it('returns null when baselineInterest is 0', async () => {
    const ctx = makeContext(200, 0);
    const result = await generator.compute(ctx);
    expect(result).toBeNull();
  });

  it('returns null when currentInterest is missing', async () => {
    const ctx = makeContext(undefined, 100);
    const result = await generator.compute(ctx);
    expect(result).toBeNull();
  });

  it('returns null when baselineInterest is missing', async () => {
    const ctx = makeContext(200, undefined);
    const result = await generator.compute(ctx);
    expect(result).toBeNull();
  });

  it('returns null when ratio < spikeThreshold (current=150, baseline=100 → ratio=1.5 < 2.0)', async () => {
    const ctx = makeContext(150, 100);
    const result = await generator.compute(ctx);
    expect(result).toBeNull();
  });

  it('fires NEUTRAL when ratio >= 2.0 (current=200, baseline=100)', async () => {
    const ctx = makeContext(200, 100);
    const result = await generator.compute(ctx);

    expect(result).not.toBeNull();
    expect(result!.direction).toBe('NEUTRAL');
    expect(result!.strength).toBeGreaterThan(0);
    expect(result!.confidence).toBeGreaterThan(0);
  });

  it('strength scales with ratio (higher ratio = higher strength)', async () => {
    const ctxLow = makeContext(200, 100);  // ratio=2
    const ctxHigh = makeContext(400, 100); // ratio=4

    const resultLow = await generator.compute(ctxLow);
    const resultHigh = await generator.compute(ctxHigh);

    expect(resultLow).not.toBeNull();
    expect(resultHigh).not.toBeNull();
    expect(resultHigh!.strength).toBeGreaterThan(resultLow!.strength);
  });

  it('strength = min(1.0, 0.2 * ratio): ratio=2 → 0.4, ratio=5 → 1.0', async () => {
    const ctx2 = makeContext(200, 100); // ratio=2 → strength=0.4
    const ctx5 = makeContext(500, 100); // ratio=5 → strength=1.0

    const r2 = await generator.compute(ctx2);
    const r5 = await generator.compute(ctx5);

    expect(r2!.strength).toBeCloseTo(0.4, 5);
    expect(r5!.strength).toBeCloseTo(1.0, 5);
  });

  it('metadata contains confidenceMultiplier', async () => {
    const ctx = makeContext(200, 100); // ratio=2
    const result = await generator.compute(ctx);

    expect(result).not.toBeNull();
    expect(result!.metadata).toBeDefined();
    expect(result!.metadata!.confidenceMultiplier).toBeDefined();
    expect(typeof result!.metadata!.confidenceMultiplier).toBe('number');
  });

  it('metadata contains spikeRatio, currentInterest, baselineInterest', async () => {
    const ctx = makeContext(200, 100);
    const result = await generator.compute(ctx);

    expect(result!.metadata!.spikeRatio).toBeCloseTo(2.0, 5);
    expect(result!.metadata!.currentInterest).toBe(200);
    expect(result!.metadata!.baselineInterest).toBe(100);
  });

  it('getRequiredLookback returns 0', () => {
    expect(generator.getRequiredLookback()).toBe(0);
  });

  it('isReady returns true when both currentInterest and baselineInterest are present', () => {
    const ctx = makeContext(200, 100);
    expect(generator.isReady(ctx)).toBe(true);
  });

  it('isReady returns false when currentInterest is missing', () => {
    expect(generator.isReady(makeContext(undefined, 100))).toBe(false);
  });

  it('isReady returns false when baselineInterest is missing', () => {
    expect(generator.isReady(makeContext(200, undefined))).toBe(false);
  });
});
