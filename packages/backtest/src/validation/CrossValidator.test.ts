/**
 * Tests for CrossValidator
 */

import { describe, it, expect } from 'vitest';
import {
  CrossValidator,
  createCrossValidator,
} from './CrossValidator.js';
import type { BacktestConfig, BacktestResult, MarketData, PerformanceMetrics } from '../types/index.js';

// ============================================
// Helpers
// ============================================

function makeMetrics(overrides: Partial<PerformanceMetrics> = {}): PerformanceMetrics {
  return {
    totalReturn: 0.10,
    annualizedReturn: 0.20,
    sharpeRatio: 1.2,
    sortinoRatio: 1.5,
    maxDrawdown: -0.08,
    maxDrawdownDuration: 5,
    calmarRatio: 2.5,
    winRate: 0.55,
    profitFactor: 1.5,
    avgTradeReturn: 0.004,
    avgWin: 0.02,
    avgLoss: -0.01,
    expectancy: 0.004,
    totalTrades: 30,
    avgHoldingPeriod: 20,
    kellyFraction: 0.08,
    ...overrides,
  };
}

function makeResult(overrides: Partial<PerformanceMetrics> = {}): BacktestResult {
  return {
    config: {} as BacktestConfig,
    summary: {} as BacktestResult['summary'],
    trades: new Array(30).fill(null).map((_, i) => ({
      id: `t${i}`,
      marketId: 'm1',
      tokenId: 'tk1',
      marketQuestion: 'Q?',
      side: 'LONG' as const,
      entryPrice: 0.5,
      exitPrice: 0.52,
      size: 10,
      pnl: 0.2,
      pnlPct: 4,
      fees: 0.01,
      entryTime: new Date(),
      exitTime: new Date(),
      holdingPeriodMs: 86400000,
      signals: ['momentum'],
      marketResolved: false,
    })),
    equityCurve: [],
    metrics: makeMetrics(overrides),
    predictionMetrics: {} as BacktestResult['predictionMetrics'],
  };
}

// ============================================
// Tests
// ============================================

describe('CrossValidator', () => {
  describe('createCrossValidator', () => {
    it('should create with default config (5 folds)', () => {
      const cv = createCrossValidator();
      expect(cv).toBeInstanceOf(CrossValidator);
    });

    it('should accept custom config', () => {
      const cv = createCrossValidator({
        nFolds: 3,
        purgeGapDays: 5,
        embargoDays: 2,
      });
      expect(cv).toBeInstanceOf(CrossValidator);
    });
  });

  describe('generateFolds', () => {
    it('should generate correct number of folds', () => {
      const cv = createCrossValidator({ nFolds: 5 });
      const start = new Date('2024-01-01');
      const end = new Date('2024-12-31');
      const folds = cv.generateFolds(start, end);

      expect(folds.length).toBe(5);
    });

    it('should not overlap test sets', () => {
      const cv = createCrossValidator({ nFolds: 4, purgeGapDays: 0, embargoDays: 0 });
      const start = new Date('2024-01-01');
      const end = new Date('2024-12-31');
      const folds = cv.generateFolds(start, end);

      // Test sets should be sequential and non-overlapping
      for (let i = 1; i < folds.length; i++) {
        expect(folds[i].testStart.getTime()).toBeGreaterThanOrEqual(
          folds[i - 1].testEnd.getTime()
        );
      }
    });

    it('should have purge gap between train and test', () => {
      const cv = createCrossValidator({ nFolds: 3, purgeGapDays: 5 });
      const start = new Date('2024-01-01');
      const end = new Date('2024-12-31');
      const folds = cv.generateFolds(start, end);

      for (const fold of folds) {
        // Training should not overlap with test period
        // Training can be before OR after the test set (largest contiguous segment)
        const trainBeforeTest = fold.trainEnd.getTime() <= fold.testStart.getTime();
        const trainAfterTest = fold.trainStart.getTime() >= fold.testEnd.getTime();
        expect(trainBeforeTest || trainAfterTest).toBe(true);
      }
    });

    it('should handle short periods gracefully', () => {
      const cv = createCrossValidator({ nFolds: 10 });
      const start = new Date('2024-01-01');
      const end = new Date('2024-02-01'); // Only 31 days
      const folds = cv.generateFolds(start, end);

      // Should still produce folds, even if small
      expect(folds.length).toBeGreaterThan(0);
      expect(folds.length).toBeLessThanOrEqual(10);
    });
  });

  describe('validate', () => {
    it('should run full cross-validation and return results', async () => {
      const cv = createCrossValidator({ nFolds: 3, minTradesPerFold: 1 });

      const start = new Date('2024-01-01');
      const end = new Date('2024-12-31');

      const backtestRunner = async () => makeResult({ sharpeRatio: 1.0, totalReturn: 0.05 });
      const paramOptimizer = async () => ({ rsiPeriod: 14 });
      const baseConfig = {
        initialCapital: 10000,
        feeRate: 0.002,
        granularityMinutes: 60,
        slippage: { model: 'fixed' as const, fixedSlippage: 0.005 },
        risk: {} as any,
      };

      const result = await cv.validate(
        start, end,
        [] as MarketData[],
        backtestRunner,
        paramOptimizer,
        baseConfig
      );

      expect(result.folds.length).toBe(3);
      expect(result.aggregate.totalFolds).toBe(3);
      expect(result.aggregate.meanTestSharpe).toBe(1.0);
      expect(result.generalization).toBeDefined();
      expect(result.generalization.overfitScore).toBeDefined();
    });

    it('should detect overfitting when train >> test', async () => {
      const cv = createCrossValidator({ nFolds: 3, minTradesPerFold: 1 });
      const start = new Date('2024-01-01');
      const end = new Date('2024-12-31');

      // For each fold, backtestRunner is called twice: 1st for train, 2nd for test
      let callCount = 0;
      const backtestRunner = async () => {
        callCount++;
        const isTrainCall = callCount % 2 === 1; // odd = train, even = test
        if (isTrainCall) {
          return makeResult({ sharpeRatio: 3.0, totalReturn: 0.50 });
        }
        return makeResult({ sharpeRatio: -0.5, totalReturn: -0.10 });
      };
      const paramOptimizer = async () => ({ rsiPeriod: 14 });

      const result = await cv.validate(
        start, end,
        [] as MarketData[],
        backtestRunner,
        paramOptimizer,
        { initialCapital: 10000, feeRate: 0.002, granularityMinutes: 60, slippage: { model: 'fixed' as const }, risk: {} as any }
      );

      // Should have negative mean test sharpe
      expect(result.aggregate.meanTestSharpe).toBeLessThan(0);
      // Should detect high overfit score
      expect(result.generalization.overfitScore).toBeGreaterThan(0);
      // Should fail
      expect(result.passed).toBe(false);
    });

    it('should pass when train ≈ test performance', async () => {
      const cv = createCrossValidator({ nFolds: 3, minTradesPerFold: 1 });
      const start = new Date('2024-01-01');
      const end = new Date('2024-12-31');

      // Consistent performance
      const backtestRunner = async () => makeResult({ sharpeRatio: 1.2, totalReturn: 0.08 });
      const paramOptimizer = async () => ({ rsiPeriod: 14 });

      const result = await cv.validate(
        start, end, [] as MarketData[],
        backtestRunner, paramOptimizer,
        { initialCapital: 10000, feeRate: 0.002, granularityMinutes: 60, slippage: { model: 'fixed' as const }, risk: {} as any }
      );

      expect(result.aggregate.meanTestSharpe).toBeGreaterThan(0);
      expect(result.generalization.overfitScore).toBe(0);
      expect(result.passed).toBe(true);
    });
  });
});
