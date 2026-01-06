/**
 * Validation Report Generator
 *
 * Combines results from walk-forward analysis, Monte Carlo simulation,
 * and overfit detection into a comprehensive validation report.
 */

import pino from 'pino';
import type { WalkForwardResult } from './WalkForwardAnalyzer.js';
import type { MonteCarloResult } from './MonteCarloSimulator.js';
import type { OverfitResult } from './OverfitDetector.js';
import type { BacktestResult } from '../types/index.js';

const logger = pino({ name: 'ValidationReport' });

// ============================================
// Types
// ============================================

export interface ValidationConfig {
  /** Minimum required OOS Sharpe ratio */
  minOosSharpe: number;
  /** Minimum required consistency ratio */
  minConsistencyRatio: number;
  /** Maximum acceptable overfit probability */
  maxOverfitProbability: number;
  /** Minimum statistical significance (1 - p-value) */
  minSignificance: number;
  /** Minimum required trades */
  minTrades: number;
  /** Maximum acceptable Brier score (prediction markets) */
  maxBrierScore: number;
}

export interface ValidationReport {
  /** Report generation timestamp */
  timestamp: Date;
  /** Strategy identifier */
  strategyId: string;
  /** Overall validation result */
  overallResult: ValidationResult;
  /** Backtest summary */
  backtestSummary: BacktestSummarySection;
  /** Walk-forward analysis section */
  walkForwardSection: WalkForwardSection;
  /** Monte Carlo section */
  monteCarloSection: MonteCarloSection;
  /** Overfit detection section */
  overfitSection: OverfitSection;
  /** Prediction market specific section */
  predictionMarketSection: PredictionMarketSection;
  /** Recommendations */
  recommendations: string[];
  /** Warnings */
  warnings: string[];
  /** Go/No-Go decision */
  decision: ValidationDecision;
}

export interface ValidationResult {
  passed: boolean;
  score: number;
  confidence: number;
  summary: string;
}

export interface BacktestSummarySection {
  totalReturn: number;
  annualizedReturn: number;
  sharpeRatio: number;
  maxDrawdown: number;
  winRate: number;
  profitFactor: number;
  totalTrades: number;
  avgHoldingPeriod: number;
}

export interface WalkForwardSection {
  included: boolean;
  result?: WalkForwardResult;
  summary: {
    numPeriods: number;
    consistencyRatio: number;
    avgOosSharpe: number;
    sharpeDegradation: number;
    combinedOosReturn: number;
    parameterStability: number;
  };
  passed: boolean;
  issues: string[];
}

export interface MonteCarloSection {
  included: boolean;
  result?: MonteCarloResult;
  summary: {
    returnsPValue: number;
    sharpePValue: number;
    isSignificant: boolean;
    confidenceInterval: { lower: number; upper: number };
    valueAtRisk: number;
    probabilityOfRuin: number;
  };
  passed: boolean;
  issues: string[];
}

export interface OverfitSection {
  included: boolean;
  result?: OverfitResult;
  summary: {
    overfitProbability: number;
    severityLevel: string;
    likelyCauses: string[];
  };
  passed: boolean;
  issues: string[];
}

export interface PredictionMarketSection {
  brierScore: number;
  logLoss: number;
  calibrationError: number;
  resolutionAccuracy: number;
  passed: boolean;
  issues: string[];
}

export interface ValidationDecision {
  decision: 'GO' | 'NO_GO' | 'CONDITIONAL';
  confidence: number;
  conditions?: string[];
  reasoning: string;
}

// ============================================
// Validation Report Generator
// ============================================

export class ValidationReportGenerator {
  private config: ValidationConfig;

  constructor(config?: Partial<ValidationConfig>) {
    this.config = {
      minOosSharpe: config?.minOosSharpe ?? 0.5,
      minConsistencyRatio: config?.minConsistencyRatio ?? 0.6,
      maxOverfitProbability: config?.maxOverfitProbability ?? 0.5,
      minSignificance: config?.minSignificance ?? 0.95,
      minTrades: config?.minTrades ?? 100,
      maxBrierScore: config?.maxBrierScore ?? 0.25,
    };
  }

  /**
   * Generate a comprehensive validation report
   */
  generate(
    strategyId: string,
    backtestResult: BacktestResult,
    walkForwardResult?: WalkForwardResult,
    monteCarloResult?: MonteCarloResult,
    overfitResult?: OverfitResult
  ): ValidationReport {
    logger.info({ strategyId }, 'Generating validation report');

    const timestamp = new Date();

    // Generate sections
    const backtestSummary = this.generateBacktestSummary(backtestResult);
    const walkForwardSection = this.generateWalkForwardSection(walkForwardResult);
    const monteCarloSection = this.generateMonteCarloSection(monteCarloResult);
    const overfitSection = this.generateOverfitSection(overfitResult);
    const predictionMarketSection = this.generatePredictionMarketSection(backtestResult);

    // Calculate overall result
    const overallResult = this.calculateOverallResult(
      backtestResult,
      walkForwardSection,
      monteCarloSection,
      overfitSection,
      predictionMarketSection
    );

    // Generate recommendations and warnings
    const { recommendations, warnings } = this.generateRecommendationsAndWarnings(
      backtestResult,
      walkForwardSection,
      monteCarloSection,
      overfitSection,
      predictionMarketSection
    );

    // Make decision
    const decision = this.makeDecision(
      overallResult,
      walkForwardSection,
      monteCarloSection,
      overfitSection,
      predictionMarketSection
    );

    return {
      timestamp,
      strategyId,
      overallResult,
      backtestSummary,
      walkForwardSection,
      monteCarloSection,
      overfitSection,
      predictionMarketSection,
      recommendations,
      warnings,
      decision,
    };
  }

  /**
   * Generate backtest summary section
   */
  private generateBacktestSummary(result: BacktestResult): BacktestSummarySection {
    return {
      totalReturn: result.metrics.totalReturn,
      annualizedReturn: result.metrics.annualizedReturn,
      sharpeRatio: result.metrics.sharpeRatio,
      maxDrawdown: result.metrics.maxDrawdown,
      winRate: result.metrics.winRate,
      profitFactor: result.metrics.profitFactor,
      totalTrades: result.metrics.totalTrades,
      avgHoldingPeriod: result.metrics.avgHoldingPeriod,
    };
  }

  /**
   * Generate walk-forward section
   */
  private generateWalkForwardSection(result?: WalkForwardResult): WalkForwardSection {
    if (!result) {
      return {
        included: false,
        summary: {
          numPeriods: 0,
          consistencyRatio: 0,
          avgOosSharpe: 0,
          sharpeDegradation: 0,
          combinedOosReturn: 0,
          parameterStability: 0,
        },
        passed: false,
        issues: ['Walk-forward analysis not performed'],
      };
    }

    const issues: string[] = [];

    if (result.aggregateMetrics.consistencyRatio < this.config.minConsistencyRatio) {
      issues.push(`Consistency ratio ${(result.aggregateMetrics.consistencyRatio * 100).toFixed(1)}% below ${(this.config.minConsistencyRatio * 100).toFixed(1)}% threshold`);
    }

    if (result.aggregateMetrics.avgOutOfSampleSharpe < this.config.minOosSharpe) {
      issues.push(`Average OOS Sharpe ${result.aggregateMetrics.avgOutOfSampleSharpe.toFixed(2)} below ${this.config.minOosSharpe} threshold`);
    }

    if (result.aggregateMetrics.sharpeDegradation > 0.5) {
      issues.push(`Sharpe degradation ${(result.aggregateMetrics.sharpeDegradation * 100).toFixed(1)}% exceeds 50% threshold`);
    }

    issues.push(...result.failureReasons);

    return {
      included: true,
      result,
      summary: {
        numPeriods: result.aggregateMetrics.numPeriods,
        consistencyRatio: result.aggregateMetrics.consistencyRatio,
        avgOosSharpe: result.aggregateMetrics.avgOutOfSampleSharpe,
        sharpeDegradation: result.aggregateMetrics.sharpeDegradation,
        combinedOosReturn: result.aggregateMetrics.combinedOosReturn,
        parameterStability: result.aggregateMetrics.parameterStability,
      },
      passed: result.passed,
      issues,
    };
  }

  /**
   * Generate Monte Carlo section
   */
  private generateMonteCarloSection(result?: MonteCarloResult): MonteCarloSection {
    if (!result) {
      return {
        included: false,
        summary: {
          returnsPValue: 1,
          sharpePValue: 1,
          isSignificant: false,
          confidenceInterval: { lower: 0, upper: 0 },
          valueAtRisk: 0,
          probabilityOfRuin: 0,
        },
        passed: false,
        issues: ['Monte Carlo simulation not performed'],
      };
    }

    const issues: string[] = [];
    const significance = 1 - result.significanceTests.returnsPValue;

    if (significance < this.config.minSignificance) {
      issues.push(`Statistical significance ${(significance * 100).toFixed(1)}% below ${(this.config.minSignificance * 100).toFixed(1)}% threshold`);
    }

    if (!result.significanceTests.isSignificant) {
      issues.push('Strategy is not statistically significant');
    }

    if (result.riskMetrics.probabilityOfRuin > 0.05) {
      issues.push(`Probability of ruin ${(result.riskMetrics.probabilityOfRuin * 100).toFixed(1)}% exceeds 5% threshold`);
    }

    return {
      included: true,
      result,
      summary: {
        returnsPValue: result.significanceTests.returnsPValue,
        sharpePValue: result.significanceTests.sharpePValue,
        isSignificant: result.significanceTests.isSignificant,
        confidenceInterval: result.confidenceIntervals.returns,
        valueAtRisk: result.riskMetrics.valueAtRisk,
        probabilityOfRuin: result.riskMetrics.probabilityOfRuin,
      },
      passed: result.significanceTests.isSignificant && result.riskMetrics.probabilityOfRuin <= 0.05,
      issues,
    };
  }

  /**
   * Generate overfit section
   */
  private generateOverfitSection(result?: OverfitResult): OverfitSection {
    if (!result) {
      return {
        included: false,
        summary: {
          overfitProbability: 0,
          severityLevel: 'unknown',
          likelyCauses: [],
        },
        passed: false,
        issues: ['Overfit detection not performed'],
      };
    }

    const issues: string[] = [];

    if (result.overfitProbability > this.config.maxOverfitProbability) {
      issues.push(`Overfit probability ${(result.overfitProbability * 100).toFixed(1)}% exceeds ${(this.config.maxOverfitProbability * 100).toFixed(1)}% threshold`);
    }

    issues.push(...result.analysis.likelyCauses);

    return {
      included: true,
      result,
      summary: {
        overfitProbability: result.overfitProbability,
        severityLevel: result.analysis.severityLevel,
        likelyCauses: result.analysis.likelyCauses,
      },
      passed: result.passed,
      issues,
    };
  }

  /**
   * Generate prediction market section
   */
  private generatePredictionMarketSection(result: BacktestResult): PredictionMarketSection {
    const pm = result.predictionMetrics;
    const issues: string[] = [];

    if (pm.brierScore > this.config.maxBrierScore) {
      issues.push(`Brier score ${pm.brierScore.toFixed(3)} exceeds ${this.config.maxBrierScore} threshold`);
    }

    if (pm.calibrationError > 0.1) {
      issues.push(`Calibration error ${(pm.calibrationError * 100).toFixed(1)}% exceeds 10% threshold`);
    }

    if (pm.resolutionAccuracy < 0.5) {
      issues.push(`Resolution accuracy ${(pm.resolutionAccuracy * 100).toFixed(1)}% below 50%`);
    }

    const passed = pm.brierScore <= this.config.maxBrierScore && pm.calibrationError <= 0.1;

    return {
      brierScore: pm.brierScore,
      logLoss: pm.logLoss,
      calibrationError: pm.calibrationError,
      resolutionAccuracy: pm.resolutionAccuracy,
      passed,
      issues,
    };
  }

  /**
   * Calculate overall validation result
   */
  private calculateOverallResult(
    backtest: BacktestResult,
    walkForward: WalkForwardSection,
    monteCarlo: MonteCarloSection,
    overfit: OverfitSection,
    prediction: PredictionMarketSection
  ): ValidationResult {
    // Score components
    let score = 0;
    let weights = 0;

    // Backtest contribution (20%)
    if (backtest.metrics.sharpeRatio > 0) {
      score += 0.2 * Math.min(1, backtest.metrics.sharpeRatio / 2);
    }
    weights += 0.2;

    // Walk-forward contribution (30%)
    if (walkForward.included) {
      score += 0.3 * (walkForward.passed ? 1 : 0.3);
    }
    weights += walkForward.included ? 0.3 : 0;

    // Monte Carlo contribution (20%)
    if (monteCarlo.included) {
      score += 0.2 * (monteCarlo.passed ? 1 : 0.3);
    }
    weights += monteCarlo.included ? 0.2 : 0;

    // Overfit contribution (20%)
    if (overfit.included) {
      score += 0.2 * (overfit.passed ? 1 : 1 - overfit.summary.overfitProbability);
    }
    weights += overfit.included ? 0.2 : 0;

    // Prediction market contribution (10%)
    score += 0.1 * (prediction.passed ? 1 : 0.5);
    weights += 0.1;

    // Normalize score
    const normalizedScore = weights > 0 ? score / weights : 0;

    // Determine if passed
    const sectionsPassed = [
      walkForward.included ? walkForward.passed : true,
      monteCarlo.included ? monteCarlo.passed : true,
      overfit.included ? overfit.passed : true,
      prediction.passed,
    ];
    const passedCount = sectionsPassed.filter(Boolean).length;
    const passed = passedCount >= 3 && normalizedScore >= 0.6;

    // Confidence based on how many tests were run
    const testsRun = [walkForward.included, monteCarlo.included, overfit.included, true].filter(Boolean).length;
    const confidence = testsRun / 4;

    // Generate summary
    let summary: string;
    if (passed) {
      summary = `Strategy passed validation with score ${(normalizedScore * 100).toFixed(0)}%`;
    } else {
      summary = `Strategy failed validation with score ${(normalizedScore * 100).toFixed(0)}%`;
    }

    return {
      passed,
      score: normalizedScore,
      confidence,
      summary,
    };
  }

  /**
   * Generate recommendations and warnings
   */
  private generateRecommendationsAndWarnings(
    backtest: BacktestResult,
    walkForward: WalkForwardSection,
    monteCarlo: MonteCarloSection,
    overfit: OverfitSection,
    prediction: PredictionMarketSection
  ): { recommendations: string[]; warnings: string[] } {
    const recommendations: string[] = [];
    const warnings: string[] = [];

    // Sample size warnings
    if (backtest.metrics.totalTrades < this.config.minTrades) {
      warnings.push(`Sample size (${backtest.metrics.totalTrades} trades) is below recommended minimum (${this.config.minTrades})`);
      recommendations.push('Collect more trading data before deploying');
    }

    // Walk-forward recommendations
    if (walkForward.included && !walkForward.passed) {
      recommendations.push('Review walk-forward failures and consider parameter simplification');
    }

    // Monte Carlo recommendations
    if (monteCarlo.included && !monteCarlo.passed) {
      recommendations.push('Run additional permutation tests to verify edge is real');
    }

    // Overfit recommendations
    if (overfit.included && overfit.result) {
      recommendations.push(...overfit.result.recommendations);
    }

    // Prediction market recommendations
    if (!prediction.passed) {
      recommendations.push('Improve calibration by adjusting confidence levels');
    }

    // Risk warnings
    if (monteCarlo.included && monteCarlo.summary.probabilityOfRuin > 0.01) {
      warnings.push('Non-trivial probability of ruin detected');
    }

    if (backtest.metrics.maxDrawdown > 0.2) {
      warnings.push(`Maximum drawdown ${(backtest.metrics.maxDrawdown * 100).toFixed(1)}% exceeds 20%`);
    }

    return { recommendations, warnings };
  }

  /**
   * Make final go/no-go decision
   */
  private makeDecision(
    overall: ValidationResult,
    walkForward: WalkForwardSection,
    monteCarlo: MonteCarloSection,
    overfit: OverfitSection,
    prediction: PredictionMarketSection
  ): ValidationDecision {
    // Critical failures = NO_GO
    if (overfit.included && overfit.summary.severityLevel === 'critical') {
      return {
        decision: 'NO_GO',
        confidence: 0.9,
        reasoning: 'Critical overfitting detected. Strategy should not be deployed.',
      };
    }

    if (walkForward.included && walkForward.summary.consistencyRatio < 0.4) {
      return {
        decision: 'NO_GO',
        confidence: 0.85,
        reasoning: 'Walk-forward consistency below 40%. Strategy is unreliable.',
      };
    }

    // All passed = GO
    if (overall.passed && overall.score >= 0.8) {
      return {
        decision: 'GO',
        confidence: overall.confidence,
        reasoning: 'All validation criteria passed. Strategy is ready for paper trading.',
      };
    }

    // Partial pass = CONDITIONAL
    if (overall.score >= 0.5) {
      const conditions: string[] = [];

      if (!walkForward.passed && walkForward.included) {
        conditions.push('Improve walk-forward consistency to >60%');
      }
      if (!monteCarlo.passed && monteCarlo.included) {
        conditions.push('Achieve statistical significance at 95% level');
      }
      if (!prediction.passed) {
        conditions.push('Improve Brier score to <0.25');
      }

      return {
        decision: 'CONDITIONAL',
        confidence: overall.confidence * 0.8,
        conditions,
        reasoning: 'Strategy shows promise but requires improvements before deployment.',
      };
    }

    // Default = NO_GO
    return {
      decision: 'NO_GO',
      confidence: overall.confidence,
      reasoning: 'Validation score too low. Strategy requires significant work.',
    };
  }

  /**
   * Generate text report
   */
  generateTextReport(report: ValidationReport): string {
    const lines: string[] = [];
    const divider = '='.repeat(60);
    const subDivider = '-'.repeat(40);

    lines.push(divider);
    lines.push(`VALIDATION REPORT: ${report.strategyId}`);
    lines.push(`Generated: ${report.timestamp.toISOString()}`);
    lines.push(divider);

    // Decision
    lines.push('');
    lines.push(`DECISION: ${report.decision.decision}`);
    lines.push(`Confidence: ${(report.decision.confidence * 100).toFixed(0)}%`);
    lines.push(`Reasoning: ${report.decision.reasoning}`);
    if (report.decision.conditions) {
      lines.push('Conditions:');
      report.decision.conditions.forEach(c => lines.push(`  - ${c}`));
    }

    // Overall Result
    lines.push('');
    lines.push(subDivider);
    lines.push('OVERALL RESULT');
    lines.push(subDivider);
    lines.push(`Status: ${report.overallResult.passed ? 'PASSED' : 'FAILED'}`);
    lines.push(`Score: ${(report.overallResult.score * 100).toFixed(1)}%`);
    lines.push(`Summary: ${report.overallResult.summary}`);

    // Backtest Summary
    lines.push('');
    lines.push(subDivider);
    lines.push('BACKTEST SUMMARY');
    lines.push(subDivider);
    lines.push(`Total Return: ${(report.backtestSummary.totalReturn * 100).toFixed(2)}%`);
    lines.push(`Sharpe Ratio: ${report.backtestSummary.sharpeRatio.toFixed(2)}`);
    lines.push(`Max Drawdown: ${(report.backtestSummary.maxDrawdown * 100).toFixed(2)}%`);
    lines.push(`Win Rate: ${(report.backtestSummary.winRate * 100).toFixed(1)}%`);
    lines.push(`Total Trades: ${report.backtestSummary.totalTrades}`);

    // Walk-Forward
    if (report.walkForwardSection.included) {
      lines.push('');
      lines.push(subDivider);
      lines.push(`WALK-FORWARD ANALYSIS: ${report.walkForwardSection.passed ? 'PASSED' : 'FAILED'}`);
      lines.push(subDivider);
      lines.push(`Periods: ${report.walkForwardSection.summary.numPeriods}`);
      lines.push(`Consistency: ${(report.walkForwardSection.summary.consistencyRatio * 100).toFixed(1)}%`);
      lines.push(`Avg OOS Sharpe: ${report.walkForwardSection.summary.avgOosSharpe.toFixed(2)}`);
      lines.push(`Sharpe Degradation: ${(report.walkForwardSection.summary.sharpeDegradation * 100).toFixed(1)}%`);
      if (report.walkForwardSection.issues.length > 0) {
        lines.push('Issues:');
        report.walkForwardSection.issues.forEach(i => lines.push(`  - ${i}`));
      }
    }

    // Monte Carlo
    if (report.monteCarloSection.included) {
      lines.push('');
      lines.push(subDivider);
      lines.push(`MONTE CARLO SIMULATION: ${report.monteCarloSection.passed ? 'PASSED' : 'FAILED'}`);
      lines.push(subDivider);
      lines.push(`Statistical Significance: ${report.monteCarloSection.summary.isSignificant ? 'Yes' : 'No'}`);
      lines.push(`Returns P-Value: ${report.monteCarloSection.summary.returnsPValue.toFixed(4)}`);
      lines.push(`VaR (${((1 - (report.monteCarloSection.result?.config.confidenceLevel ?? 0.95)) * 100).toFixed(0)}%): ${(report.monteCarloSection.summary.valueAtRisk * 100).toFixed(2)}%`);
      lines.push(`Probability of Ruin: ${(report.monteCarloSection.summary.probabilityOfRuin * 100).toFixed(2)}%`);
    }

    // Overfit
    if (report.overfitSection.included) {
      lines.push('');
      lines.push(subDivider);
      lines.push(`OVERFIT DETECTION: ${report.overfitSection.passed ? 'PASSED' : 'FAILED'}`);
      lines.push(subDivider);
      lines.push(`Overfit Probability: ${(report.overfitSection.summary.overfitProbability * 100).toFixed(1)}%`);
      lines.push(`Severity: ${report.overfitSection.summary.severityLevel.toUpperCase()}`);
      if (report.overfitSection.summary.likelyCauses.length > 0) {
        lines.push('Likely Causes:');
        report.overfitSection.summary.likelyCauses.forEach(c => lines.push(`  - ${c}`));
      }
    }

    // Prediction Market
    lines.push('');
    lines.push(subDivider);
    lines.push(`PREDICTION MARKET METRICS: ${report.predictionMarketSection.passed ? 'PASSED' : 'FAILED'}`);
    lines.push(subDivider);
    lines.push(`Brier Score: ${report.predictionMarketSection.brierScore.toFixed(4)}`);
    lines.push(`Calibration Error: ${(report.predictionMarketSection.calibrationError * 100).toFixed(2)}%`);
    lines.push(`Resolution Accuracy: ${(report.predictionMarketSection.resolutionAccuracy * 100).toFixed(1)}%`);

    // Warnings
    if (report.warnings.length > 0) {
      lines.push('');
      lines.push(subDivider);
      lines.push('WARNINGS');
      lines.push(subDivider);
      report.warnings.forEach(w => lines.push(`! ${w}`));
    }

    // Recommendations
    if (report.recommendations.length > 0) {
      lines.push('');
      lines.push(subDivider);
      lines.push('RECOMMENDATIONS');
      lines.push(subDivider);
      report.recommendations.forEach(r => lines.push(`* ${r}`));
    }

    lines.push('');
    lines.push(divider);

    return lines.join('\n');
  }
}

/**
 * Create a validation report generator with default config
 */
export function createValidationReportGenerator(
  options?: Partial<ValidationConfig>
): ValidationReportGenerator {
  return new ValidationReportGenerator(options);
}
