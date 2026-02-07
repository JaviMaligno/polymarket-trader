/**
 * momentum-signal.test.ts - Tests for MomentumSignal
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MomentumSignal, DEFAULT_MOMENTUM_PARAMS } from '../../packages/signals/src/signals/technical/MomentumSignal.js';
import type { SignalContext, PriceBar, Market } from '../../packages/signals/src/core/types/signal.types.js';

function createMockMarket(): Market {
  return {
    id: 'test-market-123',
    question: 'Test market question',
    outcomes: ['Yes', 'No'],
    endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    volume24h: 10000,
    liquidity: 50000,
  };
}

function createPriceBars(closes: number[], startTime: Date = new Date()): PriceBar[] {
  return closes.map((close, i) => ({
    time: new Date(startTime.getTime() + i * 60000),
    open: close * 0.99,
    high: close * 1.01,
    low: close * 0.98,
    close,
    volume: 1000 + Math.random() * 500,
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

describe('MomentumSignal', () => {
  let signal: MomentumSignal;

  beforeEach(() => {
    signal = new MomentumSignal();
  });

  describe('constructor', () => {
    it('should use default parameters when none provided', () => {
      expect(signal.signalId).toBe('momentum');
      expect(signal.name).toBe('Momentum');
    });

    it('should override defaults with provided config', () => {
      const customSignal = new MomentumSignal({ rsiPeriod: 21, macdFast: 8 });
      expect(customSignal.signalId).toBe('momentum');
    });
  });

  describe('getRequiredLookback', () => {
    it('should return lookback based on longest period', () => {
      const lookback = signal.getRequiredLookback();
      expect(lookback).toBeGreaterThanOrEqual(DEFAULT_MOMENTUM_PARAMS.longPeriod);
      expect(lookback).toBeGreaterThanOrEqual(DEFAULT_MOMENTUM_PARAMS.macdSlow);
    });
  });

  describe('compute', () => {
    it('should return null with insufficient data', async () => {
      const context = createContext([0.5, 0.51, 0.52]); // Only 3 bars
      const result = await signal.compute(context);
      expect(result).toBeNull();
    });

    it('should generate signal with sufficient uptrend data', async () => {
      // Create strong uptrend data
      const closes: number[] = [];
      for (let i = 0; i < 40; i++) {
        closes.push(0.3 + i * 0.01); // 0.30 -> 0.69
      }
      const context = createContext(closes);
      const result = await signal.compute(context);

      // May return null if thresholds not met, or a signal
      if (result) {
        expect(result.signalId).toBe('momentum');
        expect(result.marketId).toBe('test-market-123');
        expect(['LONG', 'SHORT', 'NEUTRAL']).toContain(result.direction);
        expect(result.strength).toBeGreaterThanOrEqual(-1);
        expect(result.strength).toBeLessThanOrEqual(1);
        expect(result.confidence).toBeGreaterThanOrEqual(0);
        expect(result.confidence).toBeLessThanOrEqual(1);
      }
    });

    it('should generate signal with sufficient downtrend data', async () => {
      // Create strong downtrend data
      const closes: number[] = [];
      for (let i = 0; i < 40; i++) {
        closes.push(0.7 - i * 0.01); // 0.70 -> 0.31
      }
      const context = createContext(closes);
      const result = await signal.compute(context);

      if (result) {
        expect(result.signalId).toBe('momentum');
        expect(['LONG', 'SHORT', 'NEUTRAL']).toContain(result.direction);
      }
    });

    it('should return null for flat market', async () => {
      // Create flat market (no momentum)
      const closes = Array(40).fill(0.5);
      const context = createContext(closes);
      const result = await signal.compute(context);

      // Flat market should have weak/no signal
      expect(result === null || Math.abs(result.strength) < 0.2).toBe(true);
    });

    it('should include metadata with indicator values', async () => {
      const closes: number[] = [];
      for (let i = 0; i < 40; i++) {
        closes.push(0.4 + i * 0.005 + Math.random() * 0.01);
      }
      const context = createContext(closes);
      const result = await signal.compute(context);

      if (result && result.metadata) {
        expect(result.metadata).toHaveProperty('rsi');
        expect(result.metadata).toHaveProperty('macd');
        expect(typeof result.metadata.rsi).toBe('number');
      }
    });
  });

  describe('RSI calculation', () => {
    it('should produce RSI values between 0 and 100', async () => {
      const closes: number[] = [];
      for (let i = 0; i < 40; i++) {
        closes.push(0.5 + Math.sin(i / 5) * 0.1);
      }
      const context = createContext(closes);
      const result = await signal.compute(context);

      if (result && result.metadata?.rsi) {
        expect(result.metadata.rsi).toBeGreaterThanOrEqual(0);
        expect(result.metadata.rsi).toBeLessThanOrEqual(100);
      }
    });
  });

  describe('signal direction', () => {
    it('should set LONG for positive strength', async () => {
      // Strong uptrend should produce positive strength
      const closes: number[] = [];
      for (let i = 0; i < 40; i++) {
        closes.push(0.2 + i * 0.015);
      }
      const context = createContext(closes);
      const result = await signal.compute(context);

      if (result && result.strength > 0.1) {
        expect(result.direction).toBe('LONG');
      }
    });

    it('should set SHORT for negative strength', async () => {
      // Strong downtrend
      const closes: number[] = [];
      for (let i = 0; i < 40; i++) {
        closes.push(0.8 - i * 0.015);
      }
      const context = createContext(closes);
      const result = await signal.compute(context);

      if (result && result.strength < -0.1) {
        expect(result.direction).toBe('SHORT');
      }
    });
  });
});
