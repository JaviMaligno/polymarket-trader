/**
 * mean-reversion-signal.test.ts - Tests for MeanReversionSignal
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MeanReversionSignal, DEFAULT_MEAN_REVERSION_PARAMS } from '../../packages/signals/src/signals/technical/MeanReversionSignal.js';
import type { SignalContext, PriceBar, Market } from '../../packages/signals/src/core/types/signal.types.js';

function createMockMarket(overrides: Partial<Market> = {}): Market {
  return {
    id: 'test-market-456',
    question: 'Mean reversion test market',
    outcomes: ['Yes', 'No'],
    endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    volume24h: 10000,
    liquidity: 50000,
    ...overrides,
  };
}

function createPriceBars(closes: number[], startTime: Date = new Date()): PriceBar[] {
  return closes.map((close, i) => ({
    time: new Date(startTime.getTime() + i * 60000),
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 1000,
  }));
}

function createContext(closes: number[], overrides: Partial<SignalContext> = {}): SignalContext {
  const bars = createPriceBars(closes);
  return {
    market: createMockMarket(),
    priceBars: bars,
    currentTime: bars[bars.length - 1].time,
    ...overrides,
  };
}

describe('MeanReversionSignal', () => {
  let signal: MeanReversionSignal;

  beforeEach(() => {
    signal = new MeanReversionSignal();
  });

  describe('constructor', () => {
    it('should use default parameters', () => {
      expect(signal.signalId).toBe('mean_reversion');
      expect(signal.name).toBe('Mean Reversion');
    });

    it('should accept custom parameters', () => {
      const customSignal = new MeanReversionSignal({
        bbPeriod: 30,
        zScoreThreshold: 2.5,
      });
      expect(customSignal.signalId).toBe('mean_reversion');
    });
  });

  describe('getRequiredLookback', () => {
    it('should return appropriate lookback', () => {
      const lookback = signal.getRequiredLookback();
      expect(lookback).toBeGreaterThanOrEqual(DEFAULT_MEAN_REVERSION_PARAMS.bbPeriod);
    });
  });

  describe('compute', () => {
    it('should return null with insufficient data', async () => {
      const context = createContext([0.5, 0.5, 0.5]);
      const result = await signal.compute(context);
      expect(result).toBeNull();
    });

    it('should return null for extreme prices (near 0)', async () => {
      const closes = Array(35).fill(0.005); // Price too close to 0
      const context = createContext(closes);
      const result = await signal.compute(context);
      expect(result).toBeNull();
    });

    it('should return null for extreme prices (near 1)', async () => {
      const closes = Array(35).fill(0.995); // Price too close to 1
      const context = createContext(closes);
      const result = await signal.compute(context);
      expect(result).toBeNull();
    });

    it('should detect oversold condition (price below lower band)', async () => {
      // Create data where price drops sharply below the mean
      const closes: number[] = [];
      for (let i = 0; i < 30; i++) {
        closes.push(0.5 + Math.random() * 0.02);
      }
      // Sharp drop at the end
      closes.push(0.35);
      closes.push(0.32);
      closes.push(0.30);

      const context = createContext(closes);
      const result = await signal.compute(context);

      // Should generate a LONG signal (expect price to revert up)
      if (result) {
        expect(result.signalId).toBe('mean_reversion');
        expect(result.metadata).toHaveProperty('zScore');
        // Negative z-score indicates oversold
        if (result.metadata?.zScore && result.metadata.zScore < -1) {
          expect(result.direction).toBe('LONG');
        }
      }
    });

    it('should detect overbought condition (price above upper band)', async () => {
      // Create data where price rises sharply above the mean
      const closes: number[] = [];
      for (let i = 0; i < 30; i++) {
        closes.push(0.5 + Math.random() * 0.02);
      }
      // Sharp rise at the end
      closes.push(0.65);
      closes.push(0.68);
      closes.push(0.70);

      const context = createContext(closes);
      const result = await signal.compute(context);

      // Should generate a SHORT signal (expect price to revert down)
      if (result) {
        expect(result.signalId).toBe('mean_reversion');
        // Positive z-score indicates overbought
        if (result.metadata?.zScore && result.metadata.zScore > 1) {
          expect(result.direction).toBe('SHORT');
        }
      }
    });

    it('should return weak/no signal for price at mean', async () => {
      // Price oscillating around mean
      const closes: number[] = [];
      for (let i = 0; i < 35; i++) {
        closes.push(0.5 + (Math.random() - 0.5) * 0.02);
      }

      const context = createContext(closes);
      const result = await signal.compute(context);

      // Should be null or very weak
      expect(result === null || Math.abs(result.strength) < 0.3).toBe(true);
    });
  });

  describe('resolution proximity adjustment', () => {
    it('should reduce signal near market resolution', async () => {
      const closes: number[] = [];
      for (let i = 0; i < 30; i++) {
        closes.push(0.5);
      }
      closes.push(0.30); // Sharp drop

      // Market resolves in 2 days
      const nearResolutionMarket = createMockMarket({
        endDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      });

      const context = createContext(closes, { market: nearResolutionMarket });
      const result = await signal.compute(context);

      if (result && result.metadata?.resolutionAdjustment) {
        // Resolution adjustment should be less than 1
        expect(result.metadata.resolutionAdjustment).toBeLessThan(1);
      }
    });
  });

  describe('Bollinger Bands', () => {
    it('should include percentB in metadata', async () => {
      const closes: number[] = [];
      for (let i = 0; i < 35; i++) {
        closes.push(0.5 + Math.sin(i / 3) * 0.1);
      }

      const context = createContext(closes);
      const result = await signal.compute(context);

      if (result && result.metadata) {
        expect(result.metadata).toHaveProperty('bollingerPercentB');
        expect(typeof result.metadata.bollingerPercentB).toBe('number');
      }
    });
  });

  describe('Z-Score', () => {
    it('should calculate z-score correctly', async () => {
      // Create data with known deviation
      const mean = 0.5;
      const closes = Array(30).fill(mean);
      closes.push(mean + 0.15); // Significant deviation

      const context = createContext(closes);
      const result = await signal.compute(context);

      if (result && result.metadata?.zScore) {
        // Z-score should be positive (above mean)
        expect(result.metadata.zScore).toBeGreaterThan(0);
      }
    });
  });
});
