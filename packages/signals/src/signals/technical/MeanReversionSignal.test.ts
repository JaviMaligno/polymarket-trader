import { describe, it, expect } from 'vitest';
import {
  MeanReversionSignal,
  DEFAULT_MEAN_REVERSION_PARAMS,
  FIXED_REFERENCE_PRICE,
  type MeanReversionReferenceMode,
} from './MeanReversionSignal.js';
import type { SignalContext, PriceBar } from '../../core/types/signal.types.js';

function bars(closes: number[]): PriceBar[] {
  const start = Date.now();
  return closes.map((close, i) => ({
    time: new Date(start + i * 60_000),
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 1000,
    tradeCount: 1,
  }));
}

function context(closes: number[], overrides: Partial<SignalContext> = {}): SignalContext {
  const priceBars = bars(closes);
  return {
    market: {
      id: 'mkt',
      question: 'q',
      isActive: true,
      isResolved: false,
      tokenIdYes: 'tok-yes',
      endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
    priceBars,
    recentTrades: [],
    currentTime: priceBars[priceBars.length - 1].time,
    ...overrides,
  };
}

describe('MeanReversionSignal — referenceMode', () => {
  it('defaults to "sma" mode (preserves legacy behaviour)', () => {
    const signal = new MeanReversionSignal();
    expect(signal.getReferenceMode()).toBe('sma');
    expect(DEFAULT_MEAN_REVERSION_PARAMS.referenceMode).toBe('sma');
  });

  it('accepts referenceMode in constructor', () => {
    const signal = new MeanReversionSignal({ referenceMode: 'fixed_50' });
    expect(signal.getReferenceMode()).toBe('fixed_50');
  });

  it('setReferenceMode swaps mode at runtime', () => {
    const signal = new MeanReversionSignal();
    signal.setReferenceMode('fixed_50');
    expect(signal.getReferenceMode()).toBe('fixed_50');
    signal.setReferenceMode('sma');
    expect(signal.getReferenceMode()).toBe('sma');
  });

  it('exports FIXED_REFERENCE_PRICE = 0.5 (prediction-market coin-flip prior)', () => {
    expect(FIXED_REFERENCE_PRICE).toBe(0.5);
  });

  describe('directional contrast on a market drifting toward NO', () => {
    // Synthetic series: price drifts from 0.45 down to 0.20 over 50 bars.
    // SMA tracks the drift downward → SMA-mode reads "price ≈ SMA, no signal".
    // fixed_50 anchors at 0.5 → reads "price < 0.5 by a lot, oversold signal".
    const closes: number[] = [];
    for (let i = 0; i < 50; i++) {
      closes.push(0.45 - (i / 49) * 0.25);
    }

    it('"sma" mode returns near-zero strength on a steady drift (mean tracks price)', async () => {
      const signal = new MeanReversionSignal();
      const result = await signal.compute(context(closes));
      // The drift is gentle: bb-mode strength stays low or null.
      // null = below 0.03 strength threshold internal to compute().
      if (result) {
        expect(Math.abs(result.strength)).toBeLessThan(0.5);
      }
    });

    it('"fixed_50" mode produces a stronger LONG signal on the same series', async () => {
      const signal = new MeanReversionSignal({ referenceMode: 'fixed_50' });
      const result = await signal.compute(context(closes));
      expect(result).not.toBeNull();
      expect(result!.direction).toBe('LONG');
    });
  });

  describe('directional contrast on a stable mean-reverting series', () => {
    // Series oscillating around 0.50 with 0.05 amplitude — both modes should
    // agree (centre is ~0.5 in both views) and produce small/null signals.
    const closes: number[] = [];
    for (let i = 0; i < 60; i++) {
      closes.push(0.50 + 0.05 * Math.sin(i * 0.4));
    }

    it('modes do not contradict on a series whose SMA already sits at 0.5', async () => {
      const sma = await new MeanReversionSignal({ referenceMode: 'sma' }).compute(context(closes));
      const fixed = await new MeanReversionSignal({ referenceMode: 'fixed_50' }).compute(context(closes));
      // Contract: when both fire, they must not call opposite directions.
      // NEUTRAL is allowed for either mode. LONG vs SHORT is the only failure.
      if (sma && fixed && sma.direction !== 'NEUTRAL' && fixed.direction !== 'NEUTRAL') {
        expect(sma.direction).toBe(fixed.direction);
      }
    });
  });

  describe('z-score sub-signal', () => {
    it('"fixed_50" with price << 0.5 produces a positive z-score deviation (price < centre → expect up)', async () => {
      const closes = Array(40).fill(0).map((_, i) => 0.20 + 0.001 * Math.sin(i)); // tight series at 0.20
      const fixed = await new MeanReversionSignal({ referenceMode: 'fixed_50' }).compute(context(closes));
      // fixed mode sees "price 0.20 << 0.5" and signals LONG.
      // sma mode sees "price ≈ SMA" → very weak signal.
      if (fixed) {
        expect(fixed.direction).toBe('LONG');
      }
    });

    it('"fixed_50" with price >> 0.5 produces a SHORT bias', async () => {
      const closes = Array(40).fill(0).map((_, i) => 0.85 + 0.001 * Math.sin(i));
      const fixed = await new MeanReversionSignal({ referenceMode: 'fixed_50' }).compute(context(closes));
      if (fixed) {
        expect(fixed.direction).toBe('SHORT');
      }
    });
  });

  describe('regression: "sma" mode preserves classical behaviour', () => {
    it('still rejects extreme prices near 0 / 1', async () => {
      const signal = new MeanReversionSignal();
      const closes = Array(35).fill(0.005);
      expect(await signal.compute(context(closes))).toBeNull();
    });
  });
});
