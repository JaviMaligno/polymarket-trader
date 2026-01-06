/**
 * Overfit Detector
 *
 * Detects signs of overfitting in trading strategies by analyzing:
 * - In-sample vs out-of-sample performance degradation
 * - Parameter sensitivity and stability
 * - Complexity vs performance trade-offs
 * - Distribution of returns vs expected
 */

import pino from 'pino';
import type { PerformanceMetrics, TradeRecord } from '../types/index.js';

const logger = pino({ name: 'OverfitDetector' });

// ============================================
// Types
// ============================================

export interface OverfitConfig {
  /** Maximum acceptable IS/OOS Sharpe degradation (0-1) */
  maxSharpeDegradation: number;
  /** Maximum acceptable IS/OOS return degradation (0-1) */
  maxReturnDegradation: number;
  /** Minimum required parameter stability (0-1) */
  minParameterStability: number;
  /** Minimum required sample size */
  minSampleSize: number;
  /** Maximum parameter count relative to sample size */
  maxParameterRatio: number;
  /** Significance level for statistical tests */
  significanceLevel: number;
}

export interface OverfitResult {
  config: OverfitConfig;
  /** Overall overfit probability (0-1) */
  overfitProbability: number;
  /** Individual overfit indicators */
  indicators: OverfitIndicators;
  /** Detailed analysis */
  analysis: OverfitAnalysis;
  /** Recommendations */
  recommendations: string[];
  /** Whether strategy passes overfit check */
  passed: boolean;
}

export interface OverfitIndicators {
  /** Performance degradation from IS to OOS */
  performanceDegradation: DegradationMetrics;
  /** Parameter sensitivity analysis */
  parameterSensitivity: ParameterSensitivity;
  /** Complexity metrics */
  complexityMetrics: ComplexityMetrics;
  /** Distribution analysis */
  distributionAnalysis: DistributionMetrics;
  /** Time stability */
  timeStability: TimeStability;
}

export interface DegradationMetrics {
  /** Sharpe ratio degradation */
  sharpeDegradation: number;
  /** Return degradation */
  returnDegradation: number;
  /** Win rate degradation */
  winRateDegradation: number;
  /** Profit factor degradation */
  profitFactorDegradation: number;
  /** Average degradation across metrics */
  averageDegradation: number;
  /** Is degradation concerning */
  isConcerning: boolean;
}

export interface ParameterSensitivity {
  /** Coefficient of variation for each parameter */
  parameterCV: Record<string, number>;
  /** Overall stability score (0-1) */
  stabilityScore: number;
  /** Parameters that are unstable */
  unstableParameters: string[];
  /** Is sensitivity concerning */
  isConcerning: boolean;
}

export interface ComplexityMetrics {
  /** Number of parameters */
  parameterCount: number;
  /** Number of trades (sample size) */
  sampleSize: number;
  /** Parameters per trade ratio */
  parametersPerTrade: number;
  /** Degrees of freedom */
  degreesOfFreedom: number;
  /** Estimated overfit from complexity */
  complexityOverfitScore: number;
  /** Is complexity concerning */
  isConcerning: boolean;
}

export interface DistributionMetrics {
  /** Skewness of returns */
  skewness: number;
  /** Kurtosis of returns */
  kurtosis: number;
  /** Normality test p-value */
  normalityPValue: number;
  /** Are returns suspiciously good */
  suspiciouslyGood: boolean;
  /** Autocorrelation of returns */
  returnsAutocorrelation: number;
  /** Is distribution concerning */
  isConcerning: boolean;
}

export interface TimeStability {
  /** Performance consistency across time periods */
  timeConsistency: number;
  /** Trend in performance over time */
  performanceTrend: number;
  /** Regime changes detected */
  regimeChanges: number;
  /** Is time stability concerning */
  isConcerning: boolean;
}

export interface OverfitAnalysis {
  /** Most likely causes of overfit */
  likelyCauses: string[];
  /** Severity level (low/medium/high/critical) */
  severityLevel: 'low' | 'medium' | 'high' | 'critical';
  /** Confidence in overfit detection */
  confidence: number;
  /** Detailed breakdown */
  breakdown: Record<string, number>;
}

// ============================================
// Overfit Detector
// ============================================

export class OverfitDetector {
  private config: OverfitConfig;

  constructor(config?: Partial<OverfitConfig>) {
    this.config = {
      maxSharpeDegradation: config?.maxSharpeDegradation ?? 0.5,
      maxReturnDegradation: config?.maxReturnDegradation ?? 0.5,
      minParameterStability: config?.minParameterStability ?? 0.5,
      minSampleSize: config?.minSampleSize ?? 100,
      maxParameterRatio: config?.maxParameterRatio ?? 0.1,
      significanceLevel: config?.significanceLevel ?? 0.05,
    };
  }

  /**
   * Detect overfitting in a strategy
   */
  detect(
    inSampleMetrics: PerformanceMetrics,
    outOfSampleMetrics: PerformanceMetrics,
    inSampleTrades: TradeRecord[],
    outOfSampleTrades: TradeRecord[],
    parameterHistory: Record<string, number>[]
  ): OverfitResult {
    logger.info('Running overfit detection');

    // Calculate all indicators
    const performanceDegradation = this.calculateDegradation(inSampleMetrics, outOfSampleMetrics);
    const parameterSensitivity = this.analyzeParameterSensitivity(parameterHistory);
    const complexityMetrics = this.analyzeComplexity(parameterHistory, inSampleTrades);
    const distributionAnalysis = this.analyzeDistribution(inSampleTrades);
    const timeStability = this.analyzeTimeStability(inSampleTrades, outOfSampleTrades);

    const indicators: OverfitIndicators = {
      performanceDegradation,
      parameterSensitivity,
      complexityMetrics,
      distributionAnalysis,
      timeStability,
    };

    // Calculate overall overfit probability
    const overfitProbability = this.calculateOverfitProbability(indicators);

    // Generate analysis
    const analysis = this.generateAnalysis(indicators, overfitProbability);

    // Generate recommendations
    const recommendations = this.generateRecommendations(indicators, analysis);

    // Determine if passed
    const passed = overfitProbability < 0.5 && !analysis.likelyCauses.some(c => c.includes('critical'));

    return {
      config: this.config,
      overfitProbability,
      indicators,
      analysis,
      recommendations,
      passed,
    };
  }

  /**
   * Quick check for obvious overfitting
   */
  quickCheck(
    inSampleSharpe: number,
    outOfSampleSharpe: number,
    numParameters: number,
    numTrades: number
  ): { isOverfit: boolean; reason: string | null } {
    // Check Sharpe degradation
    if (inSampleSharpe > 0) {
      const degradation = (inSampleSharpe - outOfSampleSharpe) / inSampleSharpe;
      if (degradation > this.config.maxSharpeDegradation) {
        return {
          isOverfit: true,
          reason: `Sharpe degradation ${(degradation * 100).toFixed(1)}% exceeds ${(this.config.maxSharpeDegradation * 100).toFixed(1)}% threshold`,
        };
      }
    }

    // Check complexity
    if (numTrades > 0) {
      const ratio = numParameters / numTrades;
      if (ratio > this.config.maxParameterRatio) {
        return {
          isOverfit: true,
          reason: `Parameter/trade ratio ${ratio.toFixed(3)} exceeds ${this.config.maxParameterRatio} threshold`,
        };
      }
    }

    // Check sample size
    if (numTrades < this.config.minSampleSize) {
      return {
        isOverfit: true,
        reason: `Sample size ${numTrades} is below minimum ${this.config.minSampleSize}`,
      };
    }

    // Check OOS performance
    if (outOfSampleSharpe < 0 && inSampleSharpe > 0.5) {
      return {
        isOverfit: true,
        reason: 'Positive IS Sharpe but negative OOS Sharpe suggests overfitting',
      };
    }

    return { isOverfit: false, reason: null };
  }

  /**
   * Calculate performance degradation metrics
   */
  private calculateDegradation(
    isMetrics: PerformanceMetrics,
    oosMetrics: PerformanceMetrics
  ): DegradationMetrics {
    const calcDegradation = (is: number, oos: number): number => {
      if (is <= 0) return 0;
      return Math.max(0, (is - oos) / is);
    };

    const sharpeDegradation = calcDegradation(isMetrics.sharpeRatio, oosMetrics.sharpeRatio);
    const returnDegradation = calcDegradation(isMetrics.totalReturn, oosMetrics.totalReturn);
    const winRateDegradation = calcDegradation(isMetrics.winRate, oosMetrics.winRate);
    const profitFactorDegradation = calcDegradation(
      Math.min(isMetrics.profitFactor, 10),
      Math.min(oosMetrics.profitFactor, 10)
    );

    const averageDegradation = (
      sharpeDegradation +
      returnDegradation +
      winRateDegradation +
      profitFactorDegradation
    ) / 4;

    const isConcerning =
      sharpeDegradation > this.config.maxSharpeDegradation ||
      returnDegradation > this.config.maxReturnDegradation ||
      averageDegradation > 0.4;

    return {
      sharpeDegradation,
      returnDegradation,
      winRateDegradation,
      profitFactorDegradation,
      averageDegradation,
      isConcerning,
    };
  }

  /**
   * Analyze parameter sensitivity
   */
  private analyzeParameterSensitivity(
    parameterHistory: Record<string, number>[]
  ): ParameterSensitivity {
    if (parameterHistory.length < 2) {
      return {
        parameterCV: {},
        stabilityScore: 1,
        unstableParameters: [],
        isConcerning: false,
      };
    }

    const paramNames = Object.keys(parameterHistory[0]);
    const parameterCV: Record<string, number> = {};
    const unstableParameters: string[] = [];

    for (const param of paramNames) {
      const values = parameterHistory.map(p => p[param]).filter(v => v !== undefined);
      if (values.length < 2) continue;

      const mean = this.mean(values);
      const std = this.std(values);
      const cv = mean !== 0 ? std / Math.abs(mean) : 0;

      parameterCV[param] = cv;

      if (cv > 0.5) {
        unstableParameters.push(param);
      }
    }

    const cvValues = Object.values(parameterCV);
    const avgCV = cvValues.length > 0 ? this.mean(cvValues) : 0;
    const stabilityScore = Math.max(0, 1 - avgCV);

    const isConcerning = stabilityScore < this.config.minParameterStability;

    return {
      parameterCV,
      stabilityScore,
      unstableParameters,
      isConcerning,
    };
  }

  /**
   * Analyze strategy complexity
   */
  private analyzeComplexity(
    parameterHistory: Record<string, number>[],
    trades: TradeRecord[]
  ): ComplexityMetrics {
    const parameterCount = parameterHistory.length > 0
      ? Object.keys(parameterHistory[0]).length
      : 0;
    const sampleSize = trades.length;

    const parametersPerTrade = sampleSize > 0 ? parameterCount / sampleSize : 0;
    const degreesOfFreedom = Math.max(0, sampleSize - parameterCount - 1);

    // Higher is worse - too many parameters for the data
    let complexityOverfitScore = 0;

    if (sampleSize < this.config.minSampleSize) {
      complexityOverfitScore += 0.3;
    }

    if (parametersPerTrade > this.config.maxParameterRatio) {
      complexityOverfitScore += 0.4;
    }

    if (degreesOfFreedom < 20) {
      complexityOverfitScore += 0.3;
    }

    const isConcerning = complexityOverfitScore > 0.5;

    return {
      parameterCount,
      sampleSize,
      parametersPerTrade,
      degreesOfFreedom,
      complexityOverfitScore: Math.min(1, complexityOverfitScore),
      isConcerning,
    };
  }

  /**
   * Analyze return distribution
   */
  private analyzeDistribution(trades: TradeRecord[]): DistributionMetrics {
    if (trades.length < 10) {
      return {
        skewness: 0,
        kurtosis: 3,
        normalityPValue: 1,
        suspiciouslyGood: false,
        returnsAutocorrelation: 0,
        isConcerning: false,
      };
    }

    const returns = trades.map(t => t.pnlPct);
    const n = returns.length;

    // Calculate skewness
    const mean = this.mean(returns);
    const std = this.std(returns);
    const skewness = std > 0
      ? returns.reduce((sum, r) => sum + Math.pow((r - mean) / std, 3), 0) / n
      : 0;

    // Calculate kurtosis
    const kurtosis = std > 0
      ? returns.reduce((sum, r) => sum + Math.pow((r - mean) / std, 4), 0) / n
      : 3;

    // Simplified normality test (Jarque-Bera approximation)
    const jb = (n / 6) * (skewness ** 2 + (kurtosis - 3) ** 2 / 4);
    const normalityPValue = Math.exp(-jb / 2); // Simplified

    // Check for suspiciously good results
    const winRate = trades.filter(t => t.pnl > 0).length / n;
    const avgWin = this.mean(trades.filter(t => t.pnl > 0).map(t => t.pnlPct));
    const avgLoss = Math.abs(this.mean(trades.filter(t => t.pnl < 0).map(t => t.pnlPct)));

    // Suspiciously good: very high win rate with good risk/reward
    const suspiciouslyGood = winRate > 0.7 && avgWin > avgLoss;

    // Autocorrelation (lag 1)
    let autocorr = 0;
    if (returns.length > 1) {
      const r1 = returns.slice(0, -1);
      const r2 = returns.slice(1);
      const cov = this.mean(r1.map((r, i) => (r - mean) * (r2[i] - mean)));
      autocorr = std > 0 ? cov / (std * std) : 0;
    }

    // Concerning if returns are too regular or autocorrelated
    const isConcerning =
      suspiciouslyGood ||
      Math.abs(autocorr) > 0.3 ||
      normalityPValue < this.config.significanceLevel;

    return {
      skewness,
      kurtosis,
      normalityPValue,
      suspiciouslyGood,
      returnsAutocorrelation: autocorr,
      isConcerning,
    };
  }

  /**
   * Analyze time stability
   */
  private analyzeTimeStability(
    inSampleTrades: TradeRecord[],
    outOfSampleTrades: TradeRecord[]
  ): TimeStability {
    const allTrades = [...inSampleTrades, ...outOfSampleTrades];

    if (allTrades.length < 20) {
      return {
        timeConsistency: 1,
        performanceTrend: 0,
        regimeChanges: 0,
        isConcerning: false,
      };
    }

    // Split into quarters and check consistency
    const quarterSize = Math.floor(allTrades.length / 4);
    const quarterReturns: number[] = [];

    for (let i = 0; i < 4; i++) {
      const start = i * quarterSize;
      const end = i === 3 ? allTrades.length : (i + 1) * quarterSize;
      const quarterTrades = allTrades.slice(start, end);
      const quarterReturn = quarterTrades.reduce((sum, t) => sum + t.pnlPct, 0);
      quarterReturns.push(quarterReturn);
    }

    // Time consistency (coefficient of variation of quarter returns)
    const meanQuarter = this.mean(quarterReturns);
    const stdQuarter = this.std(quarterReturns);
    const cv = meanQuarter !== 0 ? stdQuarter / Math.abs(meanQuarter) : 0;
    const timeConsistency = Math.max(0, 1 - cv);

    // Performance trend (regression slope)
    const xMean = 1.5; // (0+1+2+3)/4
    const yMean = meanQuarter;
    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < 4; i++) {
      numerator += (i - xMean) * (quarterReturns[i] - yMean);
      denominator += (i - xMean) ** 2;
    }
    const performanceTrend = denominator > 0 ? numerator / denominator : 0;

    // Detect regime changes (sign changes in quarter returns)
    let regimeChanges = 0;
    for (let i = 1; i < quarterReturns.length; i++) {
      if (Math.sign(quarterReturns[i]) !== Math.sign(quarterReturns[i - 1])) {
        regimeChanges++;
      }
    }

    // Concerning if inconsistent, declining, or many regime changes
    const isConcerning =
      timeConsistency < 0.5 ||
      performanceTrend < -10 ||
      regimeChanges >= 2;

    return {
      timeConsistency,
      performanceTrend,
      regimeChanges,
      isConcerning,
    };
  }

  /**
   * Calculate overall overfit probability
   */
  private calculateOverfitProbability(indicators: OverfitIndicators): number {
    const weights = {
      degradation: 0.35,
      parameterSensitivity: 0.20,
      complexity: 0.25,
      distribution: 0.10,
      timeStability: 0.10,
    };

    let probability = 0;

    // Degradation contribution
    probability += weights.degradation * Math.min(1, indicators.performanceDegradation.averageDegradation * 2);

    // Parameter sensitivity contribution
    probability += weights.parameterSensitivity * (1 - indicators.parameterSensitivity.stabilityScore);

    // Complexity contribution
    probability += weights.complexity * indicators.complexityMetrics.complexityOverfitScore;

    // Distribution contribution
    if (indicators.distributionAnalysis.suspiciouslyGood) {
      probability += weights.distribution * 0.8;
    } else if (indicators.distributionAnalysis.isConcerning) {
      probability += weights.distribution * 0.5;
    }

    // Time stability contribution
    probability += weights.timeStability * (1 - indicators.timeStability.timeConsistency);

    return Math.min(1, probability);
  }

  /**
   * Generate detailed analysis
   */
  private generateAnalysis(
    indicators: OverfitIndicators,
    overfitProbability: number
  ): OverfitAnalysis {
    const likelyCauses: string[] = [];
    const breakdown: Record<string, number> = {};

    // Check each indicator for causes
    if (indicators.performanceDegradation.isConcerning) {
      likelyCauses.push('Significant performance degradation from IS to OOS');
      breakdown['degradation'] = indicators.performanceDegradation.averageDegradation;
    }

    if (indicators.parameterSensitivity.isConcerning) {
      likelyCauses.push(`Unstable parameters: ${indicators.parameterSensitivity.unstableParameters.join(', ')}`);
      breakdown['parameter_instability'] = 1 - indicators.parameterSensitivity.stabilityScore;
    }

    if (indicators.complexityMetrics.isConcerning) {
      likelyCauses.push('Model complexity too high relative to sample size');
      breakdown['complexity'] = indicators.complexityMetrics.complexityOverfitScore;
    }

    if (indicators.distributionAnalysis.suspiciouslyGood) {
      likelyCauses.push('Return distribution appears too good to be true');
      breakdown['suspicious_distribution'] = 0.8;
    }

    if (indicators.timeStability.isConcerning) {
      likelyCauses.push('Performance inconsistent across time periods');
      breakdown['time_instability'] = 1 - indicators.timeStability.timeConsistency;
    }

    // Determine severity
    let severityLevel: 'low' | 'medium' | 'high' | 'critical';
    if (overfitProbability < 0.25) {
      severityLevel = 'low';
    } else if (overfitProbability < 0.5) {
      severityLevel = 'medium';
    } else if (overfitProbability < 0.75) {
      severityLevel = 'high';
    } else {
      severityLevel = 'critical';
    }

    // Confidence in detection
    const numConcerning = [
      indicators.performanceDegradation.isConcerning,
      indicators.parameterSensitivity.isConcerning,
      indicators.complexityMetrics.isConcerning,
      indicators.distributionAnalysis.isConcerning,
      indicators.timeStability.isConcerning,
    ].filter(Boolean).length;

    const confidence = Math.min(1, 0.5 + numConcerning * 0.1);

    return {
      likelyCauses,
      severityLevel,
      confidence,
      breakdown,
    };
  }

  /**
   * Generate recommendations
   */
  private generateRecommendations(
    indicators: OverfitIndicators,
    analysis: OverfitAnalysis
  ): string[] {
    const recommendations: string[] = [];

    if (indicators.performanceDegradation.isConcerning) {
      recommendations.push('Reduce model complexity or use more robust parameter estimation');
      recommendations.push('Increase out-of-sample testing period');
    }

    if (indicators.parameterSensitivity.isConcerning) {
      recommendations.push('Use regularization or Bayesian priors on parameters');
      recommendations.push('Consider fixing unstable parameters to defaults');
    }

    if (indicators.complexityMetrics.isConcerning) {
      recommendations.push('Reduce number of parameters or increase sample size');
      recommendations.push('Use feature selection to identify most important parameters');
    }

    if (indicators.distributionAnalysis.suspiciouslyGood) {
      recommendations.push('Verify backtest for implementation errors or lookahead bias');
      recommendations.push('Run Monte Carlo permutation tests to validate edge');
    }

    if (indicators.timeStability.isConcerning) {
      recommendations.push('Investigate regime changes in the market');
      recommendations.push('Consider adaptive or ensemble strategies');
    }

    if (analysis.severityLevel === 'high' || analysis.severityLevel === 'critical') {
      recommendations.push('Do not deploy this strategy without significant modifications');
      recommendations.push('Collect more data before re-optimization');
    }

    return recommendations;
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
}

/**
 * Create an overfit detector with default config
 */
export function createOverfitDetector(options?: Partial<OverfitConfig>): OverfitDetector {
  return new OverfitDetector(options);
}
