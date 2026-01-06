/**
 * Walk-Forward Analyzer
 *
 * Implements walk-forward analysis to validate trading strategies
 * without lookahead bias. Supports both anchored and rolling windows.
 */

import pino from 'pino';
import type {
  BacktestConfig,
  BacktestResult,
  PerformanceMetrics,
  MarketData,
} from '../types/index.js';

const logger = pino({ name: 'WalkForwardAnalyzer' });

// ============================================
// Types
// ============================================

export interface WalkForwardConfig {
  /** Total period start date */
  startDate: Date;
  /** Total period end date */
  endDate: Date;
  /** In-sample window size in days */
  inSampleDays: number;
  /** Out-of-sample window size in days */
  outOfSampleDays: number;
  /** Whether to use anchored (expanding) or rolling windows */
  windowType: 'anchored' | 'rolling';
  /** Minimum number of trades required in each period */
  minTradesPerPeriod: number;
  /** Gap between IS and OOS to avoid lookahead (days) */
  gapDays: number;
}

export interface WalkForwardPeriod {
  /** Period index */
  index: number;
  /** In-sample start date */
  inSampleStart: Date;
  /** In-sample end date */
  inSampleEnd: Date;
  /** Out-of-sample start date */
  outOfSampleStart: Date;
  /** Out-of-sample end date */
  outOfSampleEnd: Date;
  /** In-sample metrics */
  inSampleMetrics: PerformanceMetrics | null;
  /** Out-of-sample metrics */
  outOfSampleMetrics: PerformanceMetrics | null;
  /** Optimal parameters found in IS */
  optimalParams: Record<string, number>;
  /** Whether this period passed validation */
  passed: boolean;
}

export interface WalkForwardResult {
  config: WalkForwardConfig;
  periods: WalkForwardPeriod[];
  aggregateMetrics: AggregateWalkForwardMetrics;
  passed: boolean;
  failureReasons: string[];
}

export interface AggregateWalkForwardMetrics {
  /** Number of walk-forward periods */
  numPeriods: number;
  /** Number of periods that passed */
  numPassed: number;
  /** Consistency ratio (passed/total) */
  consistencyRatio: number;
  /** Average IS Sharpe ratio */
  avgInSampleSharpe: number;
  /** Average OOS Sharpe ratio */
  avgOutOfSampleSharpe: number;
  /** Sharpe ratio degradation (IS - OOS) / IS */
  sharpeDegradation: number;
  /** Average IS return */
  avgInSampleReturn: number;
  /** Average OOS return */
  avgOutOfSampleReturn: number;
  /** Return degradation */
  returnDegradation: number;
  /** OOS equity curve (concatenated) */
  oosEquityCurve: { date: Date; value: number }[];
  /** Combined OOS total return */
  combinedOosReturn: number;
  /** Combined OOS Sharpe */
  combinedOosSharpe: number;
  /** Parameter stability score (0-1, higher is more stable) */
  parameterStability: number;
}

export type BacktestRunner = (
  config: BacktestConfig,
  marketData: MarketData[],
  params: Record<string, number>
) => Promise<BacktestResult>;

export type ParameterOptimizer = (
  config: BacktestConfig,
  marketData: MarketData[]
) => Promise<Record<string, number>>;

// ============================================
// Walk-Forward Analyzer
// ============================================

export class WalkForwardAnalyzer {
  private config: WalkForwardConfig;

  constructor(config: WalkForwardConfig) {
    this.config = config;
    this.validateConfig();
  }

  /**
   * Validate configuration
   */
  private validateConfig(): void {
    const { startDate, endDate, inSampleDays, outOfSampleDays } = this.config;

    const totalDays = (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);
    const periodDays = inSampleDays + outOfSampleDays;

    if (totalDays < periodDays) {
      throw new Error(
        `Total period (${totalDays} days) must be at least one full IS+OOS period (${periodDays} days)`
      );
    }

    if (inSampleDays < 30) {
      logger.warn('In-sample period less than 30 days may lead to unreliable optimization');
    }

    if (outOfSampleDays < 7) {
      logger.warn('Out-of-sample period less than 7 days may not be statistically significant');
    }
  }

  /**
   * Generate walk-forward periods
   */
  generatePeriods(): Omit<WalkForwardPeriod, 'inSampleMetrics' | 'outOfSampleMetrics' | 'optimalParams' | 'passed'>[] {
    const periods: Omit<WalkForwardPeriod, 'inSampleMetrics' | 'outOfSampleMetrics' | 'optimalParams' | 'passed'>[] = [];
    const { startDate, endDate, inSampleDays, outOfSampleDays, gapDays, windowType } = this.config;

    const msPerDay = 1000 * 60 * 60 * 24;
    let periodIndex = 0;

    if (windowType === 'anchored') {
      // Anchored: IS always starts from startDate, expands forward
      let oosEnd = new Date(startDate.getTime() + (inSampleDays + gapDays + outOfSampleDays) * msPerDay);

      while (oosEnd <= endDate) {
        const inSampleStart = startDate;
        const inSampleEnd = new Date(oosEnd.getTime() - (outOfSampleDays + gapDays) * msPerDay);
        const outOfSampleStart = new Date(inSampleEnd.getTime() + gapDays * msPerDay);
        const outOfSampleEnd = oosEnd;

        periods.push({
          index: periodIndex++,
          inSampleStart,
          inSampleEnd,
          outOfSampleStart,
          outOfSampleEnd,
        });

        oosEnd = new Date(oosEnd.getTime() + outOfSampleDays * msPerDay);
      }
    } else {
      // Rolling: Fixed-size IS window moves forward
      let isStart = startDate;

      while (true) {
        const inSampleStart = isStart;
        const inSampleEnd = new Date(isStart.getTime() + inSampleDays * msPerDay);
        const outOfSampleStart = new Date(inSampleEnd.getTime() + gapDays * msPerDay);
        const outOfSampleEnd = new Date(outOfSampleStart.getTime() + outOfSampleDays * msPerDay);

        if (outOfSampleEnd > endDate) break;

        periods.push({
          index: periodIndex++,
          inSampleStart,
          inSampleEnd,
          outOfSampleStart,
          outOfSampleEnd,
        });

        isStart = new Date(isStart.getTime() + outOfSampleDays * msPerDay);
      }
    }

    logger.info({ numPeriods: periods.length, windowType }, 'Generated walk-forward periods');
    return periods;
  }

  /**
   * Run walk-forward analysis
   */
  async analyze(
    marketData: MarketData[],
    backtestRunner: BacktestRunner,
    parameterOptimizer: ParameterOptimizer,
    baseConfig: Omit<BacktestConfig, 'startDate' | 'endDate'>
  ): Promise<WalkForwardResult> {
    const periodTemplates = this.generatePeriods();
    const periods: WalkForwardPeriod[] = [];
    const allOptimalParams: Record<string, number>[] = [];

    for (const template of periodTemplates) {
      logger.info({ periodIndex: template.index }, 'Processing walk-forward period');

      // 1. Optimize parameters on in-sample
      const isConfig: BacktestConfig = {
        ...baseConfig,
        startDate: template.inSampleStart,
        endDate: template.inSampleEnd,
      };

      const optimalParams = await parameterOptimizer(isConfig, marketData);
      allOptimalParams.push(optimalParams);

      // 2. Run backtest on in-sample with optimal params
      const isResult = await backtestRunner(isConfig, marketData, optimalParams);

      // 3. Run backtest on out-of-sample with same params
      const oosConfig: BacktestConfig = {
        ...baseConfig,
        startDate: template.outOfSampleStart,
        endDate: template.outOfSampleEnd,
      };

      const oosResult = await backtestRunner(oosConfig, marketData, optimalParams);

      // 4. Check if period passed validation
      const passed = this.validatePeriod(isResult, oosResult);

      periods.push({
        ...template,
        inSampleMetrics: isResult.metrics,
        outOfSampleMetrics: oosResult.metrics,
        optimalParams,
        passed,
      });
    }

    // Calculate aggregate metrics
    const aggregateMetrics = this.calculateAggregateMetrics(periods, allOptimalParams);

    // Overall pass/fail
    const failureReasons = this.checkFailureConditions(aggregateMetrics);
    const passed = failureReasons.length === 0;

    return {
      config: this.config,
      periods,
      aggregateMetrics,
      passed,
      failureReasons,
    };
  }

  /**
   * Validate a single period
   */
  private validatePeriod(isResult: BacktestResult, oosResult: BacktestResult): boolean {
    const { minTradesPerPeriod } = this.config;

    // Check minimum trades
    if (oosResult.metrics.totalTrades < minTradesPerPeriod) {
      return false;
    }

    // Check OOS is not catastrophically worse than IS
    if (oosResult.metrics.totalReturn < -0.2) {
      return false; // More than 20% loss in OOS
    }

    // Check OOS Sharpe is not too negative
    if (oosResult.metrics.sharpeRatio < -1) {
      return false;
    }

    // Check degradation is not too severe
    const sharpeDegradation = isResult.metrics.sharpeRatio > 0
      ? (isResult.metrics.sharpeRatio - oosResult.metrics.sharpeRatio) / isResult.metrics.sharpeRatio
      : 0;

    if (sharpeDegradation > 0.7) {
      return false; // More than 70% degradation
    }

    return true;
  }

  /**
   * Calculate aggregate metrics across all periods
   */
  private calculateAggregateMetrics(
    periods: WalkForwardPeriod[],
    allOptimalParams: Record<string, number>[]
  ): AggregateWalkForwardMetrics {
    const validPeriods = periods.filter(p => p.inSampleMetrics && p.outOfSampleMetrics);

    if (validPeriods.length === 0) {
      return this.emptyAggregateMetrics();
    }

    // Calculate averages
    const isSharpes = validPeriods.map(p => p.inSampleMetrics!.sharpeRatio);
    const oosSharpes = validPeriods.map(p => p.outOfSampleMetrics!.sharpeRatio);
    const isReturns = validPeriods.map(p => p.inSampleMetrics!.totalReturn);
    const oosReturns = validPeriods.map(p => p.outOfSampleMetrics!.totalReturn);

    const avgInSampleSharpe = this.mean(isSharpes);
    const avgOutOfSampleSharpe = this.mean(oosSharpes);
    const avgInSampleReturn = this.mean(isReturns);
    const avgOutOfSampleReturn = this.mean(oosReturns);

    // Calculate degradation
    const sharpeDegradation = avgInSampleSharpe > 0
      ? (avgInSampleSharpe - avgOutOfSampleSharpe) / avgInSampleSharpe
      : 0;

    const returnDegradation = avgInSampleReturn > 0
      ? (avgInSampleReturn - avgOutOfSampleReturn) / avgInSampleReturn
      : 0;

    // Combined OOS performance (compounded)
    let combinedOosReturn = 1;
    for (const ret of oosReturns) {
      combinedOosReturn *= (1 + ret);
    }
    combinedOosReturn -= 1;

    // Combined OOS Sharpe (simple average weighted by period length)
    const combinedOosSharpe = avgOutOfSampleSharpe;

    // Build OOS equity curve
    const oosEquityCurve: { date: Date; value: number }[] = [];
    let cumulativeValue = 1;
    for (const period of validPeriods) {
      cumulativeValue *= (1 + period.outOfSampleMetrics!.totalReturn);
      oosEquityCurve.push({
        date: period.outOfSampleEnd,
        value: cumulativeValue,
      });
    }

    // Calculate parameter stability
    const parameterStability = this.calculateParameterStability(allOptimalParams);

    // Consistency ratio
    const numPassed = periods.filter(p => p.passed).length;

    return {
      numPeriods: periods.length,
      numPassed,
      consistencyRatio: numPassed / periods.length,
      avgInSampleSharpe,
      avgOutOfSampleSharpe,
      sharpeDegradation,
      avgInSampleReturn,
      avgOutOfSampleReturn,
      returnDegradation,
      oosEquityCurve,
      combinedOosReturn,
      combinedOosSharpe,
      parameterStability,
    };
  }

  /**
   * Calculate parameter stability across periods
   */
  private calculateParameterStability(allParams: Record<string, number>[]): number {
    if (allParams.length < 2) return 1;

    const paramNames = Object.keys(allParams[0]);
    if (paramNames.length === 0) return 1;

    const stabilities: number[] = [];

    for (const paramName of paramNames) {
      const values = allParams.map(p => p[paramName]).filter(v => v !== undefined);
      if (values.length < 2) continue;

      const mean = this.mean(values);
      const std = this.std(values);

      // Coefficient of variation (lower = more stable)
      const cv = mean !== 0 ? std / Math.abs(mean) : 0;

      // Convert to stability score (1 = perfectly stable, 0 = highly variable)
      const stability = Math.max(0, 1 - cv);
      stabilities.push(stability);
    }

    return stabilities.length > 0 ? this.mean(stabilities) : 1;
  }

  /**
   * Check for failure conditions
   */
  private checkFailureConditions(metrics: AggregateWalkForwardMetrics): string[] {
    const failures: string[] = [];

    // Consistency check
    if (metrics.consistencyRatio < 0.6) {
      failures.push(
        `Consistency ratio ${(metrics.consistencyRatio * 100).toFixed(1)}% is below 60% threshold`
      );
    }

    // OOS Sharpe check
    if (metrics.avgOutOfSampleSharpe < 0) {
      failures.push(
        `Average OOS Sharpe ratio ${metrics.avgOutOfSampleSharpe.toFixed(2)} is negative`
      );
    }

    // Degradation check
    if (metrics.sharpeDegradation > 0.5) {
      failures.push(
        `Sharpe degradation ${(metrics.sharpeDegradation * 100).toFixed(1)}% exceeds 50% threshold`
      );
    }

    // Combined OOS return check
    if (metrics.combinedOosReturn < 0) {
      failures.push(
        `Combined OOS return ${(metrics.combinedOosReturn * 100).toFixed(1)}% is negative`
      );
    }

    // Parameter stability check
    if (metrics.parameterStability < 0.5) {
      failures.push(
        `Parameter stability ${(metrics.parameterStability * 100).toFixed(1)}% is below 50% threshold`
      );
    }

    return failures;
  }

  /**
   * Empty aggregate metrics for error cases
   */
  private emptyAggregateMetrics(): AggregateWalkForwardMetrics {
    return {
      numPeriods: 0,
      numPassed: 0,
      consistencyRatio: 0,
      avgInSampleSharpe: 0,
      avgOutOfSampleSharpe: 0,
      sharpeDegradation: 0,
      avgInSampleReturn: 0,
      avgOutOfSampleReturn: 0,
      returnDegradation: 0,
      oosEquityCurve: [],
      combinedOosReturn: 0,
      combinedOosSharpe: 0,
      parameterStability: 0,
    };
  }

  /**
   * Calculate mean
   */
  private mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  /**
   * Calculate standard deviation
   */
  private std(values: number[]): number {
    if (values.length < 2) return 0;
    const m = this.mean(values);
    const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length;
    return Math.sqrt(variance);
  }

  /**
   * Get configuration
   */
  getConfig(): WalkForwardConfig {
    return { ...this.config };
  }
}

/**
 * Create a walk-forward analyzer with default config
 */
export function createWalkForwardAnalyzer(
  startDate: Date,
  endDate: Date,
  options?: Partial<Omit<WalkForwardConfig, 'startDate' | 'endDate'>>
): WalkForwardAnalyzer {
  return new WalkForwardAnalyzer({
    startDate,
    endDate,
    inSampleDays: options?.inSampleDays ?? 90,
    outOfSampleDays: options?.outOfSampleDays ?? 30,
    windowType: options?.windowType ?? 'rolling',
    minTradesPerPeriod: options?.minTradesPerPeriod ?? 10,
    gapDays: options?.gapDays ?? 1,
  });
}
