/**
 * Parameter Perturbation Test
 *
 * Tests the robustness of optimized parameters by perturbing each one
 * by ±N% and measuring how much performance degrades. Fragile parameters
 * (where small changes cause large performance drops) indicate overfitting.
 */

import pino from 'pino';
import type {
  BacktestConfig,
  BacktestResult,
  MarketData,
  PerformanceMetrics,
} from '../types/index.js';

const logger = pino({ name: 'ParameterPerturbationTest' });

// ============================================
// Types
// ============================================

export interface PerturbationConfig {
  /** Perturbation magnitudes to test (e.g., [0.05, 0.10, 0.20] for ±5%, ±10%, ±20%) */
  perturbationLevels: number[];
  /** Primary metric to evaluate sensitivity */
  primaryMetric: keyof PerformanceMetrics;
  /** Maximum acceptable degradation ratio (0-1) for each perturbation level */
  maxDegradationByLevel: Record<number, number>;
  /** Minimum trades required for valid result */
  minTrades: number;
}

export interface PerturbationResult {
  config: PerturbationConfig;
  /** Per-parameter sensitivity analysis */
  parameterResults: ParameterPerturbationResult[];
  /** Aggregate robustness score (0-1, higher = more robust) */
  robustnessScore: number;
  /** Parameters ranked by fragility (most fragile first) */
  fragilityRanking: Array<{ name: string; fragilityScore: number }>;
  /** Overall pass/fail */
  passed: boolean;
  /** Failure reasons */
  failureReasons: string[];
}

export interface ParameterPerturbationResult {
  /** Parameter name */
  parameterName: string;
  /** Original value */
  originalValue: number;
  /** Results at each perturbation level */
  levelResults: PerturbationLevelResult[];
  /** Average sensitivity across levels */
  averageSensitivity: number;
  /** Is this parameter fragile? */
  isFragile: boolean;
  /** Recommended: should this parameter be fixed to default? */
  recommendFixToDefault: boolean;
}

export interface PerturbationLevelResult {
  /** Perturbation level (e.g., 0.10 for ±10%) */
  level: number;
  /** Metric value when parameter is increased */
  metricUp: number;
  /** Metric value when parameter is decreased */
  metricDown: number;
  /** Original metric value */
  metricOriginal: number;
  /** Degradation ratio (worst of up/down) */
  degradation: number;
  /** Passed at this level? */
  passed: boolean;
}

export type PerturbationBacktestRunner = (
  config: BacktestConfig,
  marketData: MarketData[],
  params: Record<string, number>
) => Promise<BacktestResult>;

// ============================================
// Parameter Perturbation Test
// ============================================

export class ParameterPerturbationTest {
  private config: PerturbationConfig;

  constructor(config?: Partial<PerturbationConfig>) {
    this.config = {
      perturbationLevels: config?.perturbationLevels ?? [0.05, 0.10, 0.20],
      primaryMetric: config?.primaryMetric ?? 'sharpeRatio',
      maxDegradationByLevel: config?.maxDegradationByLevel ?? {
        0.05: 0.15,  // ±5% change should cause <15% degradation
        0.10: 0.25,  // ±10% change should cause <25% degradation
        0.20: 0.40,  // ±20% change should cause <40% degradation
      },
      minTrades: config?.minTrades ?? 10,
    };
  }

  /**
   * Run perturbation test on all parameters
   */
  async run(
    optimizedParams: Record<string, number>,
    backtestRunner: PerturbationBacktestRunner,
    backtestConfig: BacktestConfig,
    marketData: MarketData[]
  ): Promise<PerturbationResult> {
    logger.info({
      numParams: Object.keys(optimizedParams).length,
      levels: this.config.perturbationLevels,
    }, 'Starting parameter perturbation test');

    // First run backtest with original params to get baseline
    const baselineResult = await backtestRunner(backtestConfig, marketData, optimizedParams);
    const baselineMetric = this.extractMetric(baselineResult.metrics);

    // Test each parameter
    const parameterResults: ParameterPerturbationResult[] = [];

    for (const [paramName, originalValue] of Object.entries(optimizedParams)) {
      // Skip categorical / zero-value params (can't perturb by percentage)
      if (originalValue === 0) {
        continue;
      }

      const levelResults: PerturbationLevelResult[] = [];

      for (const level of this.config.perturbationLevels) {
        // Perturb up
        const paramsUp = { ...optimizedParams, [paramName]: originalValue * (1 + level) };
        const resultUp = await backtestRunner(backtestConfig, marketData, paramsUp);
        const metricUp = resultUp.metrics.totalTrades >= this.config.minTrades
          ? this.extractMetric(resultUp.metrics)
          : -Infinity;

        // Perturb down
        const paramsDown = { ...optimizedParams, [paramName]: originalValue * (1 - level) };
        const resultDown = await backtestRunner(backtestConfig, marketData, paramsDown);
        const metricDown = resultDown.metrics.totalTrades >= this.config.minTrades
          ? this.extractMetric(resultDown.metrics)
          : -Infinity;

        // Calculate degradation (worst of up/down)
        const degradationUp = baselineMetric > 0
          ? Math.max(0, (baselineMetric - metricUp) / baselineMetric)
          : 0;
        const degradationDown = baselineMetric > 0
          ? Math.max(0, (baselineMetric - metricDown) / baselineMetric)
          : 0;
        const degradation = Math.max(degradationUp, degradationDown);

        const maxAllowed = this.config.maxDegradationByLevel[level] ?? 0.5;

        levelResults.push({
          level,
          metricUp,
          metricDown,
          metricOriginal: baselineMetric,
          degradation,
          passed: degradation <= maxAllowed,
        });
      }

      const averageSensitivity = levelResults.length > 0
        ? levelResults.reduce((sum, r) => sum + r.degradation, 0) / levelResults.length
        : 0;

      const isFragile = averageSensitivity > 0.3 || levelResults.some(r => !r.passed);
      const recommendFixToDefault = averageSensitivity > 0.5;

      parameterResults.push({
        parameterName: paramName,
        originalValue,
        levelResults,
        averageSensitivity,
        isFragile,
        recommendFixToDefault,
      });

      logger.debug({
        param: paramName,
        sensitivity: averageSensitivity.toFixed(3),
        fragile: isFragile,
      }, 'Parameter perturbation result');
    }

    // Calculate aggregate robustness score
    const sensitivities = parameterResults.map(r => r.averageSensitivity);
    const avgSensitivity = sensitivities.length > 0
      ? sensitivities.reduce((a, b) => a + b, 0) / sensitivities.length
      : 0;
    const robustnessScore = Math.max(0, 1 - avgSensitivity);

    // Rank by fragility
    const fragilityRanking = parameterResults
      .map(r => ({ name: r.parameterName, fragilityScore: r.averageSensitivity }))
      .sort((a, b) => b.fragilityScore - a.fragilityScore);

    // Check failure conditions
    const failureReasons: string[] = [];
    const fragileCount = parameterResults.filter(r => r.isFragile).length;

    if (robustnessScore < 0.5) {
      failureReasons.push(
        `Robustness score ${(robustnessScore * 100).toFixed(1)}% is below 50% threshold`
      );
    }

    if (fragileCount > parameterResults.length * 0.5) {
      failureReasons.push(
        `${fragileCount}/${parameterResults.length} parameters are fragile (>50%)`
      );
    }

    const passed = failureReasons.length === 0;

    logger.info({
      robustnessScore: robustnessScore.toFixed(3),
      fragileParams: fragileCount,
      totalParams: parameterResults.length,
      passed,
    }, 'Parameter perturbation test complete');

    return {
      config: this.config,
      parameterResults,
      robustnessScore,
      fragilityRanking,
      passed,
      failureReasons,
    };
  }

  /**
   * Extract the primary metric value from performance metrics
   */
  private extractMetric(metrics: PerformanceMetrics): number {
    const value = metrics[this.config.primaryMetric];
    return typeof value === 'number' ? value : 0;
  }
}

/**
 * Create a parameter perturbation test with default config
 */
export function createParameterPerturbationTest(
  options?: Partial<PerturbationConfig>
): ParameterPerturbationTest {
  return new ParameterPerturbationTest(options);
}
