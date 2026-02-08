/**
 * Holdout Validator
 *
 * Implements true out-of-sample testing by reserving a percentage of data
 * that is never seen during optimization or walk-forward analysis.
 * This is the final "acid test" before deployment.
 */

import pino from 'pino';
import type {
  BacktestConfig,
  BacktestResult,
  MarketData,
  PerformanceMetrics,
} from '../types/index.js';

const logger = pino({ name: 'HoldoutValidator' });

// ============================================
// Types
// ============================================

export interface HoldoutConfig {
  /** Fraction of data to reserve as holdout (0-1, e.g., 0.2 = 20%) */
  holdoutFraction: number;
  /** Where to take holdout from: 'end' (most recent) or 'random_blocks' */
  holdoutLocation: 'end' | 'random_blocks';
  /** Number of random blocks if using random_blocks */
  numBlocks?: number;
  /** Minimum holdout days */
  minHoldoutDays: number;
  /** Minimum Sharpe in holdout to pass */
  minHoldoutSharpe: number;
  /** Maximum acceptable degradation from train to holdout */
  maxDegradation: number;
  /** Minimum trades in holdout */
  minHoldoutTrades: number;
}

export interface HoldoutSplit {
  /** Training+validation period (for optimization) */
  trainVal: { start: Date; end: Date };
  /** Holdout period (never touched during optimization) */
  holdout: { start: Date; end: Date };
  /** Days in each split */
  trainValDays: number;
  holdoutDays: number;
}

export interface HoldoutResult {
  config: HoldoutConfig;
  /** Data split used */
  split: HoldoutSplit;
  /** Parameters optimized on train+val */
  optimizedParams: Record<string, number>;
  /** Metrics on train+val set */
  trainValMetrics: PerformanceMetrics;
  /** Metrics on holdout set (THE key result) */
  holdoutMetrics: PerformanceMetrics;
  /** Number of trades in holdout */
  holdoutTrades: number;
  /** Degradation analysis */
  degradation: DegradationDetail;
  /** Confidence assessment */
  confidence: ConfidenceAssessment;
  /** Overall pass/fail */
  passed: boolean;
  /** Failure reasons */
  failureReasons: string[];
}

export interface DegradationDetail {
  /** Sharpe degradation */
  sharpe: number;
  /** Return degradation */
  returns: number;
  /** Win rate degradation */
  winRate: number;
  /** Profit factor degradation */
  profitFactor: number;
  /** Average degradation */
  average: number;
}

export interface ConfidenceAssessment {
  /** How confident are we that the edge is real? (0-1) */
  edgeConfidence: number;
  /** Assessment level */
  level: 'high' | 'moderate' | 'low' | 'none';
  /** Reasoning */
  reasons: string[];
}

export type HoldoutBacktestRunner = (
  config: BacktestConfig,
  marketData: MarketData[],
  params: Record<string, number>
) => Promise<BacktestResult>;

export type HoldoutParameterOptimizer = (
  config: BacktestConfig,
  marketData: MarketData[]
) => Promise<Record<string, number>>;

// ============================================
// Holdout Validator
// ============================================

export class HoldoutValidator {
  private config: HoldoutConfig;

  constructor(config?: Partial<HoldoutConfig>) {
    this.config = {
      holdoutFraction: config?.holdoutFraction ?? 0.2,
      holdoutLocation: config?.holdoutLocation ?? 'end',
      numBlocks: config?.numBlocks ?? 3,
      minHoldoutDays: config?.minHoldoutDays ?? 30,
      minHoldoutSharpe: config?.minHoldoutSharpe ?? 0,
      maxDegradation: config?.maxDegradation ?? 0.5,
      minHoldoutTrades: config?.minHoldoutTrades ?? 10,
    };
  }

  /**
   * Create train/holdout split
   */
  createSplit(startDate: Date, endDate: Date): HoldoutSplit {
    const totalMs = endDate.getTime() - startDate.getTime();
    const holdoutMs = totalMs * this.config.holdoutFraction;
    const msPerDay = 86400000;

    if (holdoutMs / msPerDay < this.config.minHoldoutDays) {
      throw new Error(
        `Holdout period (${(holdoutMs / msPerDay).toFixed(0)} days) is below minimum ` +
        `${this.config.minHoldoutDays} days. Increase total period or reduce holdoutFraction.`
      );
    }

    const splitPoint = new Date(endDate.getTime() - holdoutMs);

    return {
      trainVal: { start: startDate, end: splitPoint },
      holdout: { start: splitPoint, end: endDate },
      trainValDays: (splitPoint.getTime() - startDate.getTime()) / msPerDay,
      holdoutDays: holdoutMs / msPerDay,
    };
  }

  /**
   * Run holdout validation
   */
  async validate(
    startDate: Date,
    endDate: Date,
    marketData: MarketData[],
    backtestRunner: HoldoutBacktestRunner,
    parameterOptimizer: HoldoutParameterOptimizer,
    baseConfig: Omit<BacktestConfig, 'startDate' | 'endDate'>
  ): Promise<HoldoutResult> {
    const split = this.createSplit(startDate, endDate);

    logger.info({
      trainValDays: split.trainValDays.toFixed(0),
      holdoutDays: split.holdoutDays.toFixed(0),
      holdoutStart: split.holdout.start.toISOString(),
    }, 'Starting holdout validation');

    // Step 1: Optimize parameters on train+val (holdout is NEVER seen)
    const trainValConfig: BacktestConfig = {
      ...baseConfig,
      startDate: split.trainVal.start,
      endDate: split.trainVal.end,
    };

    const optimizedParams = await parameterOptimizer(trainValConfig, marketData);

    // Step 2: Evaluate on train+val
    const trainValResult = await backtestRunner(trainValConfig, marketData, optimizedParams);

    // Step 3: Evaluate on holdout (the acid test)
    const holdoutConfig: BacktestConfig = {
      ...baseConfig,
      startDate: split.holdout.start,
      endDate: split.holdout.end,
    };

    const holdoutResult = await backtestRunner(holdoutConfig, marketData, optimizedParams);

    // Step 4: Analyze degradation
    const degradation = this.calculateDegradation(
      trainValResult.metrics,
      holdoutResult.metrics
    );

    // Step 5: Assess confidence
    const confidence = this.assessConfidence(
      trainValResult.metrics,
      holdoutResult.metrics,
      holdoutResult.trades.length,
      degradation
    );

    // Step 6: Determine pass/fail
    const failureReasons: string[] = [];

    if (holdoutResult.trades.length < this.config.minHoldoutTrades) {
      failureReasons.push(
        `Holdout trades (${holdoutResult.trades.length}) below minimum (${this.config.minHoldoutTrades})`
      );
    }

    if (holdoutResult.metrics.sharpeRatio < this.config.minHoldoutSharpe) {
      failureReasons.push(
        `Holdout Sharpe (${holdoutResult.metrics.sharpeRatio.toFixed(2)}) below ` +
        `minimum (${this.config.minHoldoutSharpe})`
      );
    }

    if (degradation.average > this.config.maxDegradation) {
      failureReasons.push(
        `Average degradation (${(degradation.average * 100).toFixed(1)}%) exceeds ` +
        `maximum (${(this.config.maxDegradation * 100).toFixed(1)}%)`
      );
    }

    if (holdoutResult.metrics.totalReturn < 0) {
      failureReasons.push(
        `Holdout return is negative (${(holdoutResult.metrics.totalReturn * 100).toFixed(2)}%)`
      );
    }

    const passed = failureReasons.length === 0;

    logger.info({
      holdoutSharpe: holdoutResult.metrics.sharpeRatio.toFixed(3),
      holdoutReturn: (holdoutResult.metrics.totalReturn * 100).toFixed(2) + '%',
      degradation: (degradation.average * 100).toFixed(1) + '%',
      confidence: confidence.level,
      passed,
    }, 'Holdout validation complete');

    return {
      config: this.config,
      split,
      optimizedParams,
      trainValMetrics: trainValResult.metrics,
      holdoutMetrics: holdoutResult.metrics,
      holdoutTrades: holdoutResult.trades.length,
      degradation,
      confidence,
      passed,
      failureReasons,
    };
  }

  /**
   * Calculate degradation between train and holdout
   */
  private calculateDegradation(
    trainMetrics: PerformanceMetrics,
    holdoutMetrics: PerformanceMetrics
  ): DegradationDetail {
    const calc = (train: number, holdout: number): number => {
      if (train <= 0) return 0;
      return Math.max(0, (train - holdout) / train);
    };

    const sharpe = calc(trainMetrics.sharpeRatio, holdoutMetrics.sharpeRatio);
    const returns = calc(trainMetrics.totalReturn, holdoutMetrics.totalReturn);
    const winRate = calc(trainMetrics.winRate, holdoutMetrics.winRate);
    const profitFactor = calc(
      Math.min(trainMetrics.profitFactor, 10),
      Math.min(holdoutMetrics.profitFactor, 10)
    );
    const average = (sharpe + returns + winRate + profitFactor) / 4;

    return { sharpe, returns, winRate, profitFactor, average };
  }

  /**
   * Assess confidence in the strategy's edge
   */
  private assessConfidence(
    trainMetrics: PerformanceMetrics,
    holdoutMetrics: PerformanceMetrics,
    holdoutTrades: number,
    degradation: DegradationDetail
  ): ConfidenceAssessment {
    const reasons: string[] = [];
    let score = 0;

    // Positive holdout returns
    if (holdoutMetrics.totalReturn > 0) {
      score += 0.25;
      reasons.push('Positive holdout returns');
    }

    // Positive holdout Sharpe
    if (holdoutMetrics.sharpeRatio > 0.5) {
      score += 0.25;
      reasons.push('Good holdout Sharpe ratio (>0.5)');
    } else if (holdoutMetrics.sharpeRatio > 0) {
      score += 0.15;
      reasons.push('Positive holdout Sharpe ratio');
    }

    // Low degradation
    if (degradation.average < 0.2) {
      score += 0.25;
      reasons.push('Low train-to-holdout degradation (<20%)');
    } else if (degradation.average < 0.4) {
      score += 0.10;
      reasons.push('Moderate train-to-holdout degradation');
    }

    // Sufficient trades
    if (holdoutTrades >= 30) {
      score += 0.15;
      reasons.push('Sufficient holdout trades (>30)');
    } else if (holdoutTrades >= 15) {
      score += 0.05;
      reasons.push('Moderate holdout trade count');
    }

    // Win rate check
    if (holdoutMetrics.winRate > 0.5) {
      score += 0.10;
      reasons.push('Positive win rate in holdout');
    }

    const edgeConfidence = Math.min(1, score);

    let level: 'high' | 'moderate' | 'low' | 'none';
    if (edgeConfidence >= 0.7) level = 'high';
    else if (edgeConfidence >= 0.4) level = 'moderate';
    else if (edgeConfidence >= 0.2) level = 'low';
    else level = 'none';

    return { edgeConfidence, level, reasons };
  }
}

/**
 * Create a holdout validator with default config
 */
export function createHoldoutValidator(
  options?: Partial<HoldoutConfig>
): HoldoutValidator {
  return new HoldoutValidator(options);
}
