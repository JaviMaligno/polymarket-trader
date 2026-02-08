/**
 * Ensemble Optimizer
 *
 * Runs multiple independent optimizations with different random seeds,
 * data subsets, and objective functions, then combines results via
 * voting or averaging. This reduces the variance of the optimization
 * and makes the strategy more robust to overfitting.
 */

import pino from 'pino';
import type { ParameterValues } from './ParameterSpace.js';
import type { BacktestMetrics } from './ObjectiveFunctions.js';

const logger = pino({ name: 'EnsembleOptimizer' });

// ============================================
// Types
// ============================================

export interface EnsembleConfig {
  /** Number of independent optimization runs */
  numMembers: number;
  /** Diversity methods to use */
  diversityMethods: DiversityMethod[];
  /** How to aggregate parameter sets */
  aggregation: 'median' | 'trimmed_mean' | 'voting';
  /** Trim percentage for trimmed_mean (remove top/bottom N%) */
  trimPercent: number;
  /** Minimum agreement ratio for voting */
  minAgreementRatio: number;
  /** Whether to also evaluate the ensemble as a combined strategy */
  evaluateEnsemble: boolean;
}

export type DiversityMethod =
  | 'random_seed'       // Different random seeds in Optuna
  | 'data_subset'       // Different 80% subsets of data (bagging)
  | 'objective_variant'  // Different objective weight combinations
  | 'parameter_subset'; // Optimize on different parameter subsets

export interface EnsembleMember {
  /** Member index */
  index: number;
  /** Random seed used */
  seed: number;
  /** Diversity method applied */
  diversityMethod: DiversityMethod;
  /** Optimized parameters */
  params: Record<string, number>;
  /** Backtest metrics */
  metrics: BacktestMetrics;
  /** Objective score */
  score: number;
}

export interface EnsembleResult {
  config: EnsembleConfig;
  /** Individual member results */
  members: EnsembleMember[];
  /** Aggregated (consensus) parameters */
  consensusParams: Record<string, number>;
  /** Metrics of consensus strategy */
  consensusMetrics: BacktestMetrics | null;
  /** Agreement analysis */
  agreement: AgreementAnalysis;
  /** Stability analysis */
  stability: StabilityAnalysis;
  /** Overall assessment */
  assessment: EnsembleAssessment;
}

export interface AgreementAnalysis {
  /** Per-parameter agreement (low CV = high agreement) */
  parameterAgreement: Record<string, { mean: number; std: number; cv: number; agreement: number }>;
  /** Overall agreement score (0-1) */
  overallAgreement: number;
  /** Parameters with strong consensus */
  strongConsensus: string[];
  /** Parameters with weak consensus (high disagreement) */
  weakConsensus: string[];
}

export interface StabilityAnalysis {
  /** How stable is each metric across ensemble members */
  metricStability: Record<string, { mean: number; std: number; cv: number }>;
  /** Overall stability score (0-1) */
  overallStability: number;
  /** Is the strategy robust across perturbations? */
  isRobust: boolean;
}

export interface EnsembleAssessment {
  /** Confidence level (high/moderate/low) */
  confidence: 'high' | 'moderate' | 'low';
  /** Estimated edge persistence probability */
  edgePersistenceProbability: number;
  /** Recommended action */
  recommendation: string;
  /** Key findings */
  findings: string[];
}

export type EnsembleBacktestRunner = (
  params: Record<string, number>,
  seed?: number
) => Promise<{ metrics: BacktestMetrics; score: number }>;

export type EnsembleParameterOptimizer = (
  seed: number,
  diversityMethod: DiversityMethod
) => Promise<{ params: Record<string, number>; metrics: BacktestMetrics; score: number }>;

// ============================================
// Ensemble Optimizer
// ============================================

export class EnsembleOptimizer {
  private config: EnsembleConfig;

  constructor(config?: Partial<EnsembleConfig>) {
    this.config = {
      numMembers: config?.numMembers ?? 10,
      diversityMethods: config?.diversityMethods ?? ['random_seed', 'data_subset'],
      aggregation: config?.aggregation ?? 'trimmed_mean',
      trimPercent: config?.trimPercent ?? 0.2,
      minAgreementRatio: config?.minAgreementRatio ?? 0.6,
      evaluateEnsemble: config?.evaluateEnsemble ?? true,
    };
  }

  /**
   * Run ensemble optimization
   */
  async optimize(
    optimizer: EnsembleParameterOptimizer,
    backtestRunner?: EnsembleBacktestRunner
  ): Promise<EnsembleResult> {
    logger.info({
      numMembers: this.config.numMembers,
      methods: this.config.diversityMethods,
    }, 'Starting ensemble optimization');

    const members: EnsembleMember[] = [];

    // Run independent optimizations
    for (let i = 0; i < this.config.numMembers; i++) {
      const seed = 42 + i * 1337;
      const method = this.config.diversityMethods[i % this.config.diversityMethods.length];

      logger.info({ member: i + 1, seed, method }, 'Running ensemble member');

      const result = await optimizer(seed, method);

      members.push({
        index: i,
        seed,
        diversityMethod: method,
        params: result.params,
        metrics: result.metrics,
        score: result.score,
      });
    }

    // Aggregate parameters
    const consensusParams = this.aggregateParams(members);

    // Evaluate consensus if runner provided
    let consensusMetrics: BacktestMetrics | null = null;
    if (backtestRunner && this.config.evaluateEnsemble) {
      const result = await backtestRunner(consensusParams);
      consensusMetrics = result.metrics;
    }

    // Analyze agreement
    const agreement = this.analyzeAgreement(members);

    // Analyze stability
    const stability = this.analyzeStability(members);

    // Generate assessment
    const assessment = this.generateAssessment(members, agreement, stability, consensusMetrics);

    logger.info({
      overallAgreement: agreement.overallAgreement.toFixed(3),
      overallStability: stability.overallStability.toFixed(3),
      confidence: assessment.confidence,
    }, 'Ensemble optimization complete');

    return {
      config: this.config,
      members,
      consensusParams,
      consensusMetrics,
      agreement,
      stability,
      assessment,
    };
  }

  /**
   * Aggregate parameters from ensemble members
   */
  private aggregateParams(members: EnsembleMember[]): Record<string, number> {
    if (members.length === 0) return {};

    const paramNames = Object.keys(members[0].params);
    const result: Record<string, number> = {};

    for (const name of paramNames) {
      const values = members.map(m => m.params[name]).filter(v => v !== undefined);

      if (values.length === 0) continue;

      switch (this.config.aggregation) {
        case 'median':
          result[name] = this.median(values);
          break;

        case 'trimmed_mean':
          result[name] = this.trimmedMean(values, this.config.trimPercent);
          break;

        case 'voting': {
          // For voting: bin values and pick most common bin
          result[name] = this.votingAggregate(values);
          break;
        }
      }
    }

    return result;
  }

  /**
   * Analyze agreement between ensemble members
   */
  private analyzeAgreement(members: EnsembleMember[]): AgreementAnalysis {
    if (members.length < 2) {
      return {
        parameterAgreement: {},
        overallAgreement: 1,
        strongConsensus: [],
        weakConsensus: [],
      };
    }

    const paramNames = Object.keys(members[0].params);
    const parameterAgreement: AgreementAnalysis['parameterAgreement'] = {};
    const agreements: number[] = [];

    for (const name of paramNames) {
      const values = members.map(m => m.params[name]).filter(v => v !== undefined);
      const mean = this.mean(values);
      const std = this.std(values);
      const cv = mean !== 0 ? std / Math.abs(mean) : 0;
      const agreement = Math.max(0, 1 - cv);

      parameterAgreement[name] = { mean, std, cv, agreement };
      agreements.push(agreement);
    }

    const overallAgreement = this.mean(agreements);
    const strongConsensus = Object.entries(parameterAgreement)
      .filter(([, v]) => v.agreement > 0.8)
      .map(([k]) => k);
    const weakConsensus = Object.entries(parameterAgreement)
      .filter(([, v]) => v.agreement < 0.5)
      .map(([k]) => k);

    return {
      parameterAgreement,
      overallAgreement,
      strongConsensus,
      weakConsensus,
    };
  }

  /**
   * Analyze metric stability across members
   */
  private analyzeStability(members: EnsembleMember[]): StabilityAnalysis {
    if (members.length < 2) {
      return { metricStability: {}, overallStability: 1, isRobust: true };
    }

    const metricNames: (keyof BacktestMetrics)[] = [
      'sharpeRatio', 'totalReturn', 'maxDrawdown', 'winRate', 'profitFactor',
    ];

    const metricStability: StabilityAnalysis['metricStability'] = {};
    const stabilities: number[] = [];

    for (const name of metricNames) {
      const values = members.map(m => {
        const v = m.metrics[name];
        return typeof v === 'number' ? v : 0;
      });
      const mean = this.mean(values);
      const std = this.std(values);
      const cv = mean !== 0 ? std / Math.abs(mean) : 0;
      metricStability[name] = { mean, std, cv };
      stabilities.push(Math.max(0, 1 - cv));
    }

    const overallStability = this.mean(stabilities);
    const isRobust = overallStability > 0.6;

    return { metricStability, overallStability, isRobust };
  }

  /**
   * Generate overall assessment
   */
  private generateAssessment(
    members: EnsembleMember[],
    agreement: AgreementAnalysis,
    stability: StabilityAnalysis,
    consensusMetrics: BacktestMetrics | null
  ): EnsembleAssessment {
    const findings: string[] = [];

    // Agreement analysis
    if (agreement.overallAgreement > 0.7) {
      findings.push('Strong parameter consensus across optimizations (good sign)');
    } else if (agreement.overallAgreement < 0.4) {
      findings.push('Weak parameter consensus - optimization landscape may be flat or noisy');
    }

    // Stability analysis
    if (stability.isRobust) {
      findings.push('Strategy metrics are stable across perturbations');
    } else {
      findings.push('Strategy metrics vary significantly - high sensitivity to optimization noise');
    }

    // Consensus performance
    if (consensusMetrics) {
      if (consensusMetrics.sharpeRatio > 0.5) {
        findings.push(`Consensus strategy Sharpe: ${consensusMetrics.sharpeRatio.toFixed(2)} (positive)`);
      } else if (consensusMetrics.sharpeRatio < 0) {
        findings.push('Consensus strategy has negative Sharpe - edge may not be real');
      }
    }

    // Members with positive returns
    const positiveMembers = members.filter(m => m.metrics.totalReturn > 0).length;
    const positivePct = positiveMembers / members.length;
    findings.push(`${positiveMembers}/${members.length} (${(positivePct * 100).toFixed(0)}%) members have positive returns`);

    // Confidence
    let confidence: 'high' | 'moderate' | 'low';
    const score = (agreement.overallAgreement * 0.4) + (stability.overallStability * 0.3) + (positivePct * 0.3);

    if (score > 0.7) confidence = 'high';
    else if (score > 0.4) confidence = 'moderate';
    else confidence = 'low';

    // Edge persistence
    const edgePersistenceProbability = Math.min(1, Math.max(0,
      positivePct * 0.5 + agreement.overallAgreement * 0.3 + stability.overallStability * 0.2
    ));

    // Recommendation
    let recommendation: string;
    if (confidence === 'high') {
      recommendation = 'Strategy shows robust edge across multiple optimizations. Consider paper trading.';
    } else if (confidence === 'moderate') {
      recommendation = 'Strategy shows some edge but with moderate uncertainty. Extend backtesting period.';
    } else {
      recommendation = 'Strategy does not show consistent edge. Re-examine signal design before re-optimizing.';
    }

    return {
      confidence,
      edgePersistenceProbability,
      recommendation,
      findings,
    };
  }

  // ============================================
  // Utility methods
  // ============================================

  private median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  private trimmedMean(values: number[], trimPct: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    const trimCount = Math.floor(sorted.length * trimPct);
    const trimmed = sorted.slice(trimCount, sorted.length - trimCount);
    return trimmed.length > 0 ? this.mean(trimmed) : this.mean(values);
  }

  private votingAggregate(values: number[]): number {
    // Bin values into 10 bins and pick the center of the most popular bin
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (max === min) return min;

    const numBins = Math.min(10, values.length);
    const binWidth = (max - min) / numBins;
    const bins = new Array(numBins).fill(0);

    for (const v of values) {
      const bin = Math.min(numBins - 1, Math.floor((v - min) / binWidth));
      bins[bin]++;
    }

    const maxBin = bins.indexOf(Math.max(...bins));
    return min + (maxBin + 0.5) * binWidth;
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
 * Create an ensemble optimizer with default config
 */
export function createEnsembleOptimizer(
  options?: Partial<EnsembleConfig>
): EnsembleOptimizer {
  return new EnsembleOptimizer(options);
}
