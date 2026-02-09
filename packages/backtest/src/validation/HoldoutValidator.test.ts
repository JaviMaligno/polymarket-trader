/**
 * Tests for HoldoutValidator
 */

import { describe, it, expect } from 'vitest';
import {
  HoldoutValidator,
  createHoldoutValidator,
} from './HoldoutValidator.js';
import type { BacktestConfig, BacktestResult, MarketData, PerformanceMetrics } from '../types/index.js';

// ============================================
// Helpers
// ============================================

function makeMetrics(overrides: Partial<PerformanceMetrics> = {}): PerformanceMetrics {
  return {
    totalReturn: 0.12,
    annualizedReturn: 0.24,
    sharpeRatio: 1.3,
    sortinoRatio: 1.8,
    maxDrawdown: -0.09,
    maxDrawdownDuration: 5,
    calmarRatio: 2.7,
    winRate: 0.55,
    profitFactor: 1.6,
    avgTradeReturn: 0.004,
    avgWin: 0.02,
    avgLoss: -0.01,
    expectancy: 0.004,
    totalTrades: 40,
    avgHoldingPeriod: 20,
    kellyFraction: 0.09,
    ...overrides,
  };
}

function makeResult(overrides: Partial<PerformanceMetrics> = {}): BacktestResult {
  const trades = new Array(overrides.totalTrades ?? 40).fill(null).map((_, i) => ({
    id: `t${i}`,
    marketId: 'm1', tokenId: 'tk1', marketQuestion: 'Q?',
    side: 'LONG' as const,
    entryPrice: 0.5, exitPrice: 0.52, size: 10,
    pnl: 0.2, pnlPct: 4, fees: 0.01,
    entryTime: new Date(), exitTime: new Date(),
    holdingPeriodMs: 86400000,
    signals: ['momentum'], marketResolved: false,
  }));
  return {
    config: {} as BacktestConfig,
    summary: {} as BacktestResult['summary'],
    trades,
    equityCurve: [],
    metrics: makeMetrics(overrides),
    predictionMetrics: {} as BacktestResult['predictionMetrics'],
  };
}

// ============================================
// Tests
// ============================================

describe('HoldoutValidator', () => {
  describe('createHoldoutValidator', () => {
    it('should create with default config (20% holdout)', () => {
      const hv = createHoldoutValidator();
      expect(hv).toBeInstanceOf(HoldoutValidator);
    });

    it('should accept custom config', () => {
      const hv = createHoldoutValidator({
        holdoutFraction: 0.3,
        minHoldoutDays: 14,
        minHoldoutSharpe: 0.5,
      });
      expect(hv).toBeInstanceOf(HoldoutValidator);
    });
  });

  describe('createSplit', () => {
    it('should split data with correct proportions', () => {
      const hv = createHoldoutValidator({ holdoutFraction: 0.2 });
      const start = new Date('2024-01-01');
      const end = new Date('2025-01-01'); // 366 days

      const split = hv.createSplit(start, end);

      // ~80% train, ~20% holdout
      expect(split.holdoutDays).toBeCloseTo(366 * 0.2, -1);
      expect(split.trainValDays).toBeCloseTo(366 * 0.8, -1);

      // Holdout should be at the end
      expect(split.holdout.end.getTime()).toBe(end.getTime());
      expect(split.trainVal.start.getTime()).toBe(start.getTime());
    });

    it('should throw if holdout period is too short', () => {
      const hv = createHoldoutValidator({
        holdoutFraction: 0.1,
        minHoldoutDays: 60,
      });

      // 90 days * 0.1 = 9 days holdout, below 60-day minimum
      expect(() => hv.createSplit(
        new Date('2024-01-01'),
        new Date('2024-04-01')
      )).toThrow('below minimum');
    });
  });

  describe('validate', () => {
    it('should pass when holdout performs well', async () => {
      const hv = createHoldoutValidator({
        holdoutFraction: 0.2,
        minHoldoutDays: 10,
        minHoldoutTrades: 5,
        minHoldoutSharpe: 0,
        maxDegradation: 0.5,
      });

      const start = new Date('2024-01-01');
      const end = new Date('2024-12-31');

      // Consistent performance
      const backtestRunner = async () => makeResult({
        sharpeRatio: 1.0, totalReturn: 0.10, totalTrades: 30,
      });
      const paramOptimizer = async () => ({ rsiPeriod: 14 });
      const baseConfig = {
        initialCapital: 10000, feeRate: 0.002, granularityMinutes: 60,
        slippage: { model: 'fixed' as const }, risk: {} as any,
      };

      const result = await hv.validate(
        start, end, [] as MarketData[],
        backtestRunner, paramOptimizer, baseConfig
      );

      expect(result.holdoutMetrics.sharpeRatio).toBe(1.0);
      expect(result.degradation.average).toBe(0);
      expect(result.confidence.level).toBe('high');
      expect(result.passed).toBe(true);
    });

    it('should fail when holdout has negative returns', async () => {
      const hv = createHoldoutValidator({
        holdoutFraction: 0.2,
        minHoldoutDays: 10,
        minHoldoutTrades: 5,
      });

      const start = new Date('2024-01-01');
      const end = new Date('2024-12-31');

      let callIdx = 0;
      const backtestRunner = async () => {
        callIdx++;
        // 1st call: trainVal (good), 2nd call: holdout (bad)
        if (callIdx === 1) {
          return makeResult({ sharpeRatio: 2.0, totalReturn: 0.30, totalTrades: 50 });
        }
        return makeResult({ sharpeRatio: -0.5, totalReturn: -0.10, totalTrades: 20 });
      };
      const paramOptimizer = async () => ({ rsiPeriod: 14 });

      const result = await hv.validate(
        start, end, [] as MarketData[],
        backtestRunner, paramOptimizer,
        { initialCapital: 10000, feeRate: 0.002, granularityMinutes: 60, slippage: { model: 'fixed' as const }, risk: {} as any }
      );

      expect(result.holdoutMetrics.totalReturn).toBe(-0.10);
      expect(result.passed).toBe(false);
      expect(result.failureReasons.length).toBeGreaterThan(0);
    });

    it('should report confidence levels correctly', async () => {
      const hv = createHoldoutValidator({
        holdoutFraction: 0.2,
        minHoldoutDays: 10,
        minHoldoutTrades: 5,
      });

      const start = new Date('2024-01-01');
      const end = new Date('2024-12-31');

      // Weak performance: low Sharpe, low win rate, few trades
      const backtestRunner = async () => makeResult({
        sharpeRatio: 0.2, totalReturn: 0.01, winRate: 0.45, totalTrades: 12,
      });
      const paramOptimizer = async () => ({ rsiPeriod: 14 });

      const result = await hv.validate(
        start, end, [] as MarketData[],
        backtestRunner, paramOptimizer,
        { initialCapital: 10000, feeRate: 0.002, granularityMinutes: 60, slippage: { model: 'fixed' as const }, risk: {} as any }
      );

      // With low Sharpe (0.2), low winRate (<0.5), and few trades (<15):
      // score = 0.25 + 0.15 + 0.25 + 0 + 0 = 0.65 → moderate
      expect(['low', 'moderate']).toContain(result.confidence.level);
      expect(result.confidence.reasons.length).toBeGreaterThan(0);
    });
  });
});
