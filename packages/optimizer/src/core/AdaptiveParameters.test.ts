/**
 * Tests for AdaptiveRegimeDetector
 */

import { describe, it, expect } from 'vitest';
import {
  AdaptiveRegimeDetector,
  createAdaptiveRegimeDetector,
  buildAdaptiveParameterSet,
} from './AdaptiveParameters.js';
import type { BacktestMetrics } from './ObjectiveFunctions.js';

// ============================================
// Helpers
// ============================================

function makeMetrics(overrides: Partial<BacktestMetrics> = {}): BacktestMetrics {
  return {
    totalReturn: 0.10,
    sharpeRatio: 1.2,
    maxDrawdown: -0.08,
    winRate: 0.55,
    profitFactor: 1.5,
    totalTrades: 40,
    averageTradeReturn: 0.004,
    volatility: 0.08,
    ...overrides,
  };
}

function generateTrendingPrices(start: number, trendPerStep: number, steps: number): number[] {
  const prices: number[] = [start];
  for (let i = 1; i < steps; i++) {
    prices.push(prices[i - 1] * (1 + trendPerStep + (Math.random() - 0.5) * 0.002));
  }
  return prices;
}

function generateVolatilePrices(start: number, vol: number, steps: number): number[] {
  const prices: number[] = [start];
  for (let i = 1; i < steps; i++) {
    prices.push(prices[i - 1] * (1 + (Math.random() - 0.5) * vol));
  }
  return prices;
}

// ============================================
// Tests
// ============================================

describe('AdaptiveRegimeDetector', () => {
  describe('creation', () => {
    it('should create with default config', () => {
      const detector = createAdaptiveRegimeDetector();
      expect(detector).toBeInstanceOf(AdaptiveRegimeDetector);
    });

    it('should accept custom config', () => {
      const detector = createAdaptiveRegimeDetector({
        volatilityLookback: 30,
        trendLookback: 15,
        volatilityThreshold: 0.03,
      });
      expect(detector.getConfig().volatilityLookback).toBe(30);
    });
  });

  describe('detect', () => {
    it('should return neutral for insufficient data', () => {
      const detector = createAdaptiveRegimeDetector({ volatilityLookback: 20 });
      const state = detector.detect([1, 2, 3]); // Too few points

      expect(state.current).toBe('neutral');
      expect(state.confidence).toBe(0.5);
    });

    it('should detect bull regime for uptrending prices', () => {
      const detector = createAdaptiveRegimeDetector({
        volatilityLookback: 20,
        trendLookback: 10,
        trendThreshold: 0.005,
        volatilityThreshold: 0.03,
        minRegimeConfidence: 0.3,
      });

      // Strong uptrend, low volatility
      const prices = generateTrendingPrices(100, 0.02, 30);
      const state = detector.detect(prices);

      expect(['bull_low_vol', 'bull_high_vol']).toContain(state.current);
      expect(state.confidence).toBeGreaterThan(0);
    });

    it('should detect bear regime for downtrending prices', () => {
      const detector = createAdaptiveRegimeDetector({
        volatilityLookback: 20,
        trendLookback: 10,
        trendThreshold: 0.005,
        volatilityThreshold: 0.03,
        minRegimeConfidence: 0.3,
      });

      // Strong downtrend
      const prices = generateTrendingPrices(100, -0.02, 30);
      const state = detector.detect(prices);

      expect(['bear_low_vol', 'bear_high_vol']).toContain(state.current);
    });

    it('should detect neutral for sideways market', () => {
      const detector = createAdaptiveRegimeDetector({
        volatilityLookback: 20,
        trendLookback: 10,
        trendThreshold: 0.01,
        volatilityThreshold: 0.03,
        minRegimeConfidence: 0.3,
      });

      // Sideways with low vol
      const prices: number[] = [];
      for (let i = 0; i < 30; i++) {
        prices.push(100 + Math.sin(i * 0.5) * 0.5);
      }

      const state = detector.detect(prices);

      expect(state.current).toBe('neutral');
    });

    it('should maintain regime history', () => {
      const detector = createAdaptiveRegimeDetector({
        volatilityLookback: 10,
        trendLookback: 5,
        minRegimeConfidence: 0.3,
      });

      // First detection
      const prices1 = generateTrendingPrices(100, 0.02, 20);
      detector.detect(prices1);

      // Second detection
      const prices2 = generateTrendingPrices(100, -0.02, 20);
      const state = detector.detect(prices2);

      expect(state.history.length).toBeGreaterThanOrEqual(1);
    });

    it('should calculate regime distribution', () => {
      const detector = createAdaptiveRegimeDetector({
        volatilityLookback: 10,
        trendLookback: 5,
        minRegimeConfidence: 0.1,
      });

      const prices = generateTrendingPrices(100, 0.01, 20);
      const state = detector.detect(prices);

      const dist = state.distribution;
      const totalDist = Object.values(dist).reduce((a, b) => a + b, 0);
      expect(totalDist).toBeCloseTo(1, 5); // Distribution sums to 1
    });
  });

  describe('getAdaptiveParams', () => {
    it('should return fallback when no regime params exist', () => {
      const detector = createAdaptiveRegimeDetector();
      const regimeParams = new Map();
      const fallback = { rsiPeriod: 14, stopLoss: 0.10 };

      const state = { current: 'bull_low_vol' as const, confidence: 0.9, duration: 5, history: [], distribution: {} as any };

      const params = detector.getAdaptiveParams(regimeParams, fallback, state);

      expect(params).toEqual(fallback);
    });

    it('should return regime-specific params when confident', () => {
      const detector = createAdaptiveRegimeDetector({
        minRegimeConfidence: 0.5,
        transitionSmoothing: 0, // No smoothing
      });

      const bullParams = { rsiPeriod: 10, stopLoss: 0.05 };
      const regimeParams = new Map();
      regimeParams.set('bull_low_vol', {
        regime: 'bull_low_vol',
        params: bullParams,
        metrics: null,
        sampleSize: 100,
        confidence: 0.8,
      });

      const fallback = { rsiPeriod: 14, stopLoss: 0.10 };
      const state = { current: 'bull_low_vol' as const, confidence: 0.8, duration: 10, history: [], distribution: {} as any };

      const params = detector.getAdaptiveParams(regimeParams, fallback, state);

      expect(params.rsiPeriod).toBe(10);
      expect(params.stopLoss).toBe(0.05);
    });

    it('should return fallback when confidence is too low', () => {
      const detector = createAdaptiveRegimeDetector({
        minRegimeConfidence: 0.8,
        transitionSmoothing: 0,
      });

      const regimeParams = new Map();
      regimeParams.set('bull_low_vol', {
        regime: 'bull_low_vol',
        params: { rsiPeriod: 10 },
        metrics: null,
        sampleSize: 100,
        confidence: 0.5,
      });

      const fallback = { rsiPeriod: 14 };
      const state = { current: 'bull_low_vol' as const, confidence: 0.3, duration: 1, history: [], distribution: {} as any };

      const params = detector.getAdaptiveParams(regimeParams, fallback, state);

      expect(params.rsiPeriod).toBe(14); // fallback
    });
  });

  describe('reset', () => {
    it('should clear all state', () => {
      const detector = createAdaptiveRegimeDetector();

      detector.detect(generateTrendingPrices(100, 0.02, 30));
      detector.reset();

      const state = detector.detect([1, 2, 3]);
      expect(state.current).toBe('neutral');
      expect(state.history.length).toBe(0);
    });
  });
});

describe('buildAdaptiveParameterSet', () => {
  it('should build parameter set from regime data', async () => {
    const regimeData = new Map();
    regimeData.set('bull_low_vol', { prices: generateTrendingPrices(100, 0.01, 50), sampleSize: 50 });
    regimeData.set('bear_low_vol', { prices: generateTrendingPrices(100, -0.01, 50), sampleSize: 50 });

    const optimizeForRegime = async () => ({
      params: { rsiPeriod: 14, stopLoss: 0.10 },
      metrics: makeMetrics({ sharpeRatio: 1.0 }),
    });

    const staticParams = { rsiPeriod: 14, stopLoss: 0.10 };
    const staticMetrics = makeMetrics({ sharpeRatio: 0.8 });

    const result = await buildAdaptiveParameterSet(
      regimeData, optimizeForRegime, staticParams, staticMetrics
    );

    expect(result.regimeParams.size).toBe(2);
    expect(result.fallbackParams).toEqual(staticParams);
    expect(result.transitionMatrix).toBeDefined();
    expect(result.assessment.recommendation).toBeTruthy();
  });

  it('should skip regimes with insufficient data', async () => {
    const regimeData = new Map();
    regimeData.set('bull_low_vol', { prices: [1, 2, 3], sampleSize: 3 }); // < 20
    regimeData.set('bear_low_vol', { prices: generateTrendingPrices(100, -0.01, 50), sampleSize: 50 });

    const optimizeForRegime = async () => ({
      params: { rsiPeriod: 14 },
      metrics: makeMetrics(),
    });

    const result = await buildAdaptiveParameterSet(
      regimeData, optimizeForRegime, { rsiPeriod: 14 }, makeMetrics()
    );

    // Only bear_low_vol should be included (bull_low_vol has too few data points)
    expect(result.regimeParams.size).toBe(1);
    expect(result.regimeParams.has('bear_low_vol')).toBe(true);
  });
});
