import { describe, it, expect, beforeEach } from 'vitest';
import { VolumeAnomalyGenerator } from './VolumeAnomalyGenerator.js';
import type { SignalContext, PriceBar, MarketInfo } from '../../core/types/signal.types.js';

function makeBar(close: number, volume: number, time?: Date): PriceBar {
  return {
    time: time ?? new Date(),
    open: close,
    high: close,
    low: close,
    close,
    volume,
  };
}

function makeContext(bars: PriceBar[]): SignalContext {
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
    priceBars: bars,
    recentTrades: [],
  };
}

describe('VolumeAnomalyGenerator', () => {
  let generator: VolumeAnomalyGenerator;

  beforeEach(() => {
    generator = new VolumeAnomalyGenerator();
  });

  it('has signalId === "volume_anomaly"', () => {
    expect(generator.signalId).toBe('volume_anomaly');
  });

  it('returns null when fewer than 14 bars', async () => {
    const bars = Array.from({ length: 13 }, (_, i) => makeBar(0.5, 100));
    const ctx = makeContext(bars);
    const result = await generator.compute(ctx);
    expect(result).toBeNull();
  });

  it('returns null when volume is consistent (no anomaly)', async () => {
    // 30 bars all with the same volume — stddev=0, so returns null
    const bars = Array.from({ length: 30 }, () => makeBar(0.5, 100));
    const ctx = makeContext(bars);
    const result = await generator.compute(ctx);
    expect(result).toBeNull();
  });

  it('fires LONG when volume spikes with rising price', async () => {
    // 28 normal bars with slight volume variation (90/110 alternating) so stddev > 0
    const bars: PriceBar[] = Array.from({ length: 28 }, (_, i) =>
      makeBar(0.50, i % 2 === 0 ? 90 : 110)
    );
    // 2 spike bars: higher close (rising) + very high volume
    bars.push(makeBar(0.60, 5000));
    bars.push(makeBar(0.65, 5000));

    const ctx = makeContext(bars);
    const result = await generator.compute(ctx);

    expect(result).not.toBeNull();
    expect(result!.direction).toBe('LONG');
    expect(result!.strength).toBeGreaterThan(0);
    expect(result!.confidence).toBeGreaterThan(0);
  });

  it('fires SHORT when volume spikes with falling price', async () => {
    // 28 normal bars with slight volume variation (90/110 alternating) so stddev > 0
    const bars: PriceBar[] = Array.from({ length: 28 }, (_, i) =>
      makeBar(0.50, i % 2 === 0 ? 90 : 110)
    );
    // 2 spike bars: lower close (falling) + very high volume
    bars.push(makeBar(0.40, 5000));
    bars.push(makeBar(0.35, 5000));

    const ctx = makeContext(bars);
    const result = await generator.compute(ctx);

    expect(result).not.toBeNull();
    expect(result!.direction).toBe('SHORT');
    expect(result!.strength).toBeLessThan(0);
  });

  it('strength scales with z-score', async () => {
    // Baseline alternating 800/1200 -> mean=1000, stddev=200
    // Moderate spike vol=1400 -> z=2.0 -> strength=0.5 (above threshold, below cap)
    // Large spike vol=1700 -> z=3.5 -> strength=0.875 (above threshold, below cap)
    const barsModerate: PriceBar[] = Array.from({ length: 28 }, (_, i) =>
      makeBar(0.50, i % 2 === 0 ? 800 : 1200)
    );
    barsModerate.push(makeBar(0.60, 1400));
    barsModerate.push(makeBar(0.62, 1400));

    // Large spike
    const barsLarge: PriceBar[] = Array.from({ length: 28 }, (_, i) =>
      makeBar(0.50, i % 2 === 0 ? 800 : 1200)
    );
    barsLarge.push(makeBar(0.60, 1700));
    barsLarge.push(makeBar(0.62, 1700));

    const ctxModerate = makeContext(barsModerate);
    const ctxLarge = makeContext(barsLarge);

    const resultModerate = await generator.compute(ctxModerate);
    const resultLarge = await generator.compute(ctxLarge);

    expect(resultModerate).not.toBeNull();
    expect(resultLarge).not.toBeNull();
    expect(Math.abs(resultLarge!.strength)).toBeGreaterThan(Math.abs(resultModerate!.strength));
  });
});
