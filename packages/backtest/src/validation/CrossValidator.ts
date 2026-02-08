/**
 * K-Fold Cross-Validator
 *
 * Implements time-series aware k-fold cross-validation for trading strategies.
 * Uses purged k-fold to prevent data leakage between folds.
 */

import pino from 'pino';
import type {
  BacktestConfig,
  BacktestResult,
  MarketData,
  PerformanceMetrics,
} from '../types/index.js';

const logger = pino({ name: 'CrossValidator' });

// ============================================
// Types
// ============================================

export interface CrossValidationConfig {
  /** Number of folds */
  nFolds: number;
  /** Purge gap in days between train/test to avoid leakage */
  purgeGapDays: number;
  /** Embargo period in days after test set (for walk-forward leakage) */
  embargoDays: number;
  /** Minimum trades required per fold */
  minTradesPerFold: number;
  /** Whether to use combinatorial purged CV (more conservative) */
  combinatorial: boolean;
}

export interface CrossValidationFold {
  /** Fold index */
  index: number;
  /** Training period start */
  trainStart: Date;
  /** Training period end */
  trainEnd: Date;
  /** Test period start */
  testStart: Date;
  /** Test period end */
  testEnd: Date;
  /** Training metrics */
  trainMetrics: PerformanceMetrics | null;
  /** Test metrics */
  testMetrics: PerformanceMetrics | null;
  /** Optimized parameters for this fold */
  params: Record<string, number>;
  /** Number of trades in test */
  testTrades: number;
}

export interface CrossValidationResult {
  config: CrossValidationConfig;
  /** Results per fold */
  folds: CrossValidationFold[];
  /** Aggregate statistics */
  aggregate: CrossValidationAggregate;
  /** Generalization estimate */
  generalization: GeneralizationEstimate;
  /** Overall pass/fail */
  passed: boolean;
  /** Failure reasons */
  failureReasons: string[];
}

export interface CrossValidationAggregate {
  /** Mean test Sharpe across folds */
  meanTestSharpe: number;
  /** Std of test Sharpe across folds */
  stdTestSharpe: number;
  /** Mean test return across folds */
  meanTestReturn: number;
  /** Std of test return */
  stdTestReturn: number;
  /** Mean train-test Sharpe gap */
  meanSharpeGap: number;
  /** Mean test win rate */
  meanTestWinRate: number;
  /** Folds with positive test return */
  positiveFolds: number;
  /** Total folds evaluated */
  totalFolds: number;
}

export interface GeneralizationEstimate {
  /** Expected out-of-sample Sharpe (mean - 1 std for conservatism) */
  expectedSharpe: number;
  /** Expected out-of-sample return */
  expectedReturn: number;
  /** 95% confidence interval for return */
  returnCI: { lower: number; upper: number };
  /** 95% confidence interval for Sharpe */
  sharpeCI: { lower: number; upper: number };
  /** Estimated probability of positive returns */
  probPositiveReturn: number;
  /** Overfitting score based on train-test gap */
  overfitScore: number;
}

export type CVBacktestRunner = (
  config: BacktestConfig,
  marketData: MarketData[],
  params: Record<string, number>
) => Promise<BacktestResult>;

export type CVParameterOptimizer = (
  config: BacktestConfig,
  marketData: MarketData[]
) => Promise<Record<string, number>>;

// ============================================
// Cross-Validator
// ============================================

export class CrossValidator {
  private config: CrossValidationConfig;

  constructor(config?: Partial<CrossValidationConfig>) {
    this.config = {
      nFolds: config?.nFolds ?? 5,
      purgeGapDays: config?.purgeGapDays ?? 2,
      embargoDays: config?.embargoDays ?? 1,
      minTradesPerFold: config?.minTradesPerFold ?? 5,
      combinatorial: config?.combinatorial ?? false,
    };
  }

  /**
   * Generate time-series aware fold splits
   */
  generateFolds(startDate: Date, endDate: Date): Array<{
    trainStart: Date; trainEnd: Date;
    testStart: Date; testEnd: Date;
  }> {
    const msPerDay = 86400000;
    const totalMs = endDate.getTime() - startDate.getTime();
    const foldSize = totalMs / this.config.nFolds;
    const purgeMs = this.config.purgeGapDays * msPerDay;
    const embargoMs = this.config.embargoDays * msPerDay;
    const folds: Array<{
      trainStart: Date; trainEnd: Date;
      testStart: Date; testEnd: Date;
    }> = [];

    for (let i = 0; i < this.config.nFolds; i++) {
      const testStart = new Date(startDate.getTime() + i * foldSize);
      const testEnd = new Date(testStart.getTime() + foldSize);

      // Training: everything except test + purge + embargo
      const trainSegments: Array<{ start: Date; end: Date }> = [];

      // Before test (with purge gap)
      const beforeEnd = new Date(testStart.getTime() - purgeMs);
      if (beforeEnd > startDate) {
        trainSegments.push({ start: startDate, end: beforeEnd });
      }

      // After test (with embargo)
      const afterStart = new Date(testEnd.getTime() + embargoMs);
      if (afterStart < endDate) {
        trainSegments.push({ start: afterStart, end: endDate });
      }

      // Use the largest contiguous training segment
      if (trainSegments.length > 0) {
        const largest = trainSegments.reduce((a, b) =>
          (b.end.getTime() - b.start.getTime()) > (a.end.getTime() - a.start.getTime()) ? b : a
        );

        folds.push({
          trainStart: largest.start,
          trainEnd: largest.end,
          testStart,
          testEnd: testEnd > endDate ? endDate : testEnd,
        });
      }
    }

    return folds;
  }

  /**
   * Run k-fold cross-validation
   */
  async validate(
    startDate: Date,
    endDate: Date,
    marketData: MarketData[],
    backtestRunner: CVBacktestRunner,
    parameterOptimizer: CVParameterOptimizer,
    baseConfig: Omit<BacktestConfig, 'startDate' | 'endDate'>
  ): Promise<CrossValidationResult> {
    const foldSplits = this.generateFolds(startDate, endDate);

    logger.info({
      nFolds: foldSplits.length,
      startDate,
      endDate,
    }, 'Starting k-fold cross-validation');

    const folds: CrossValidationFold[] = [];

    for (let i = 0; i < foldSplits.length; i++) {
      const split = foldSplits[i];

      logger.info({ fold: i + 1, total: foldSplits.length }, 'Processing fold');

      // Optimize on training set
      const trainConfig: BacktestConfig = {
        ...baseConfig,
        startDate: split.trainStart,
        endDate: split.trainEnd,
      };

      const params = await parameterOptimizer(trainConfig, marketData);

      // Evaluate on training set
      const trainResult = await backtestRunner(trainConfig, marketData, params);

      // Evaluate on test set
      const testConfig: BacktestConfig = {
        ...baseConfig,
        startDate: split.testStart,
        endDate: split.testEnd,
      };

      const testResult = await backtestRunner(testConfig, marketData, params);

      folds.push({
        index: i,
        trainStart: split.trainStart,
        trainEnd: split.trainEnd,
        testStart: split.testStart,
        testEnd: split.testEnd,
        trainMetrics: trainResult.metrics,
        testMetrics: testResult.metrics,
        params,
        testTrades: testResult.trades.length,
      });
    }

    // Calculate aggregates
    const aggregate = this.calculateAggregate(folds);
    const generalization = this.estimateGeneralization(folds);

    // Determine pass/fail
    const failureReasons: string[] = [];

    if (aggregate.meanTestSharpe < 0) {
      failureReasons.push(`Mean test Sharpe ${aggregate.meanTestSharpe.toFixed(2)} is negative`);
    }

    if (aggregate.positiveFolds < aggregate.totalFolds * 0.5) {
      failureReasons.push(
        `Only ${aggregate.positiveFolds}/${aggregate.totalFolds} folds have positive returns`
      );
    }

    if (generalization.overfitScore > 0.6) {
      failureReasons.push(
        `Overfit score ${(generalization.overfitScore * 100).toFixed(1)}% is too high`
      );
    }

    if (aggregate.stdTestSharpe > Math.abs(aggregate.meanTestSharpe) * 2) {
      failureReasons.push('Test Sharpe variance is too high relative to mean (unstable)');
    }

    const passed = failureReasons.length === 0;

    logger.info({
      meanTestSharpe: aggregate.meanTestSharpe.toFixed(3),
      meanTestReturn: (aggregate.meanTestReturn * 100).toFixed(2) + '%',
      overfitScore: generalization.overfitScore.toFixed(3),
      passed,
    }, 'Cross-validation complete');

    return {
      config: this.config,
      folds,
      aggregate,
      generalization,
      passed,
      failureReasons,
    };
  }

  /**
   * Calculate aggregate statistics across folds
   */
  private calculateAggregate(folds: CrossValidationFold[]): CrossValidationAggregate {
    const validFolds = folds.filter(f => f.testMetrics && f.trainMetrics);

    if (validFolds.length === 0) {
      return {
        meanTestSharpe: 0, stdTestSharpe: 0,
        meanTestReturn: 0, stdTestReturn: 0,
        meanSharpeGap: 0, meanTestWinRate: 0,
        positiveFolds: 0, totalFolds: folds.length,
      };
    }

    const testSharpes = validFolds.map(f => f.testMetrics!.sharpeRatio);
    const testReturns = validFolds.map(f => f.testMetrics!.totalReturn);
    const sharpeGaps = validFolds.map(f =>
      f.trainMetrics!.sharpeRatio - f.testMetrics!.sharpeRatio
    );
    const testWinRates = validFolds.map(f => f.testMetrics!.winRate);

    return {
      meanTestSharpe: this.mean(testSharpes),
      stdTestSharpe: this.std(testSharpes),
      meanTestReturn: this.mean(testReturns),
      stdTestReturn: this.std(testReturns),
      meanSharpeGap: this.mean(sharpeGaps),
      meanTestWinRate: this.mean(testWinRates),
      positiveFolds: testReturns.filter(r => r > 0).length,
      totalFolds: validFolds.length,
    };
  }

  /**
   * Estimate generalization performance
   */
  private estimateGeneralization(folds: CrossValidationFold[]): GeneralizationEstimate {
    const validFolds = folds.filter(f => f.testMetrics && f.trainMetrics);

    if (validFolds.length === 0) {
      return {
        expectedSharpe: 0, expectedReturn: 0,
        returnCI: { lower: 0, upper: 0 },
        sharpeCI: { lower: 0, upper: 0 },
        probPositiveReturn: 0, overfitScore: 1,
      };
    }

    const testSharpes = validFolds.map(f => f.testMetrics!.sharpeRatio);
    const testReturns = validFolds.map(f => f.testMetrics!.totalReturn);
    const trainSharpes = validFolds.map(f => f.trainMetrics!.sharpeRatio);

    const meanSharpe = this.mean(testSharpes);
    const stdSharpe = this.std(testSharpes);
    const meanReturn = this.mean(testReturns);
    const stdReturn = this.std(testReturns);

    // Conservative estimate: mean - 1 std
    const expectedSharpe = meanSharpe - stdSharpe;
    const expectedReturn = meanReturn - stdReturn;

    // 95% CI using t-distribution approximation
    const n = validFolds.length;
    const tCritical = n > 2 ? 2.0 : 12.7; // simplified t-value
    const seReturn = stdReturn / Math.sqrt(n);
    const seSharpe = stdSharpe / Math.sqrt(n);

    const returnCI = {
      lower: meanReturn - tCritical * seReturn,
      upper: meanReturn + tCritical * seReturn,
    };
    const sharpeCI = {
      lower: meanSharpe - tCritical * seSharpe,
      upper: meanSharpe + tCritical * seSharpe,
    };

    // Probability of positive return (assuming normal distribution)
    const zScore = stdReturn > 0 ? meanReturn / stdReturn : 0;
    const probPositiveReturn = this.normalCDF(zScore);

    // Overfit score: how much worse is test vs train?
    const meanTrainSharpe = this.mean(trainSharpes);
    const overfitScore = meanTrainSharpe > 0
      ? Math.max(0, Math.min(1, (meanTrainSharpe - meanSharpe) / meanTrainSharpe))
      : 0;

    return {
      expectedSharpe,
      expectedReturn,
      returnCI,
      sharpeCI,
      probPositiveReturn,
      overfitScore,
    };
  }

  /**
   * Standard normal CDF approximation
   */
  private normalCDF(x: number): number {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989422804014327;
    const p = d * Math.exp(-x * x / 2) *
      (0.3193815 * t - 0.3565638 * t * t + 1.781478 * t * t * t -
       1.821256 * t * t * t * t + 1.330274 * t * t * t * t * t);
    return x > 0 ? 1 - p : p;
  }

  private mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  private std(values: number[]): number {
    if (values.length < 2) return 0;
    const m = this.mean(values);
    const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
    return Math.sqrt(variance);
  }
}

/**
 * Create a cross-validator with default config
 */
export function createCrossValidator(
  options?: Partial<CrossValidationConfig>
): CrossValidator {
  return new CrossValidator(options);
}
