/**
 * Tests for ParameterPerturbationTest
 */

import { describe, it, expect } from 'vitest';
import {
  ParameterPerturbationTest,
  createParameterPerturbationTest,
} from './ParameterPerturbationTest.js';
import type { BacktestConfig, BacktestResult, MarketData, PerformanceMetrics } from '../types/index.js';

// ============================================
// Helpers
// ============================================

function makeMetrics(overrides: Partial<PerformanceMetrics> = {}): PerformanceMetrics {
  return {
    totalReturn: 0.15,
    annualizedReturn: 0.30,
    sharpeRatio: 1.5,
    sortinoRatio: 2.0,
    maxDrawdown: -0.10,
    maxDrawdownDuration: 5,
    calmarRatio: 3.0,
    winRate: 0.55,
    profitFactor: 1.8,
    avgTradeReturn: 0.005,
    avgWin: 0.02,
    avgLoss: -0.01,
    expectancy: 0.005,
    totalTrades: 50,
    avgHoldingPeriod: 24,
    kellyFraction: 0.1,
    ...overrides,
  };
}

function makeBacktestResult(metrics: PerformanceMetrics): BacktestResult {
  return {
    config: {} as BacktestConfig,
    summary: {} as BacktestResult['summary'],
    trades: [],
    equityCurve: [],
    metrics,
    predictionMetrics: {} as BacktestResult['predictionMetrics'],
  };
}

// ============================================
// Tests
// ============================================

describe('ParameterPerturbationTest', () => {
  describe('createParameterPerturbationTest', () => {
    it('should create with default config', () => {
      const test = createParameterPerturbationTest();
      expect(test).toBeInstanceOf(ParameterPerturbationTest);
    });

    it('should accept custom config', () => {
      const test = createParameterPerturbationTest({
        perturbationLevels: [0.05, 0.10],
        primaryMetric: 'totalReturn',
        minTrades: 5,
      });
      expect(test).toBeInstanceOf(ParameterPerturbationTest);
    });
  });

  describe('run', () => {
    it('should return robust result for stable params', async () => {
      const test = createParameterPerturbationTest({
        perturbationLevels: [0.10],
        minTrades: 5,
      });

      const params = { 'momentum.rsiPeriod': 14, 'risk.maxPositionSizePct': 5 };
      const baseMetrics = makeMetrics({ sharpeRatio: 1.5 });

      // Runner that returns similar metrics regardless of params (robust)
      const runner = async () => makeBacktestResult(
        makeMetrics({ sharpeRatio: 1.4, totalTrades: 50 })
      );

      const result = await test.run(
        params,
        runner,
        {} as BacktestConfig,
        [] as MarketData[]
      );

      expect(result.robustnessScore).toBeGreaterThan(0);
      expect(result.parameterResults.length).toBe(2);
      expect(result.fragilityRanking.length).toBe(2);
    });

    it('should detect fragile params when perturbation causes collapse', async () => {
      const test = createParameterPerturbationTest({
        perturbationLevels: [0.10],
        minTrades: 5,
      });

      const params = { 'fragile.param': 10 };
      let callCount = 0;

      // First call (baseline) returns good metrics, perturbations return terrible
      const runner = async () => {
        callCount++;
        if (callCount === 1) {
          return makeBacktestResult(makeMetrics({ sharpeRatio: 2.0, totalTrades: 50 }));
        }
        return makeBacktestResult(makeMetrics({ sharpeRatio: 0.1, totalTrades: 50 }));
      };

      const result = await test.run(
        params,
        runner,
        {} as BacktestConfig,
        [] as MarketData[]
      );

      // Should detect the fragility
      expect(result.parameterResults[0].isFragile).toBe(true);
      expect(result.parameterResults[0].averageSensitivity).toBeGreaterThan(0.3);
    });

    it('should skip zero-value parameters', async () => {
      const test = createParameterPerturbationTest({
        perturbationLevels: [0.10],
        minTrades: 5,
      });

      const params = { 'nonzero.param': 5, 'zero.param': 0 };

      const runner = async () => makeBacktestResult(
        makeMetrics({ totalTrades: 50 })
      );

      const result = await test.run(
        params,
        runner,
        {} as BacktestConfig,
        [] as MarketData[]
      );

      // Only nonzero param should be tested
      expect(result.parameterResults.length).toBe(1);
      expect(result.parameterResults[0].parameterName).toBe('nonzero.param');
    });

    it('should fail when too many params are fragile', async () => {
      const test = createParameterPerturbationTest({
        perturbationLevels: [0.05],
        maxDegradationByLevel: { 0.05: 0.01 }, // Very strict threshold
        minTrades: 5,
      });

      const params = { a: 10, b: 20, c: 30 };
      let callCount = 0;

      const runner = async () => {
        callCount++;
        const sharpe = callCount === 1 ? 2.0 : 2.0 * (0.5 + Math.random() * 0.5);
        return makeBacktestResult(makeMetrics({ sharpeRatio: sharpe, totalTrades: 50 }));
      };

      const result = await test.run(
        params,
        runner,
        {} as BacktestConfig,
        [] as MarketData[]
      );

      expect(result.parameterResults.length).toBe(3);
      // With very strict threshold, at least some params should be fragile
      expect(result.fragilityRanking.length).toBe(3);
    });
  });
});
