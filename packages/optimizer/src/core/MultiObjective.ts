/**
 * Multi-Objective Optimization
 *
 * Replaces single-objective Sharpe optimization with a composite score
 * that balances multiple metrics. Supports constraints (hard limits that
 * must be satisfied) and Pareto-aware ranking.
 */

import { pino } from 'pino';
import type { BacktestMetrics } from './ObjectiveFunctions.js';

const logger = pino({ name: 'MultiObjective' });

// ============================================
// Types
// ============================================

export interface MultiObjectiveConfig {
  /** Weights for each objective (must sum to ~1) */
  objectives: ObjectiveWeight[];
  /** Hard constraints that must be satisfied */
  constraints: OptimizationConstraint[];
  /** Penalty for violating constraints */
  constraintPenalty: number;
  /** Normalization method for objectives */
  normalization: 'minmax' | 'zscore' | 'none';
}

export interface ObjectiveWeight {
  /** Metric name */
  metric: keyof BacktestMetrics | 'calmarRatio' | 'sortinoRatio';
  /** Weight (positive = maximize, negative = minimize) */
  weight: number;
  /** Optional: ideal target value (penalize deviations) */
  target?: number;
}

export interface OptimizationConstraint {
  /** Metric name */
  metric: keyof BacktestMetrics;
  /** Constraint type */
  type: 'min' | 'max' | 'range';
  /** Value for min/max, or [low, high] for range */
  value: number | [number, number];
  /** Hard constraint (reject if violated) vs soft (penalize) */
  hard: boolean;
  /** Penalty weight for soft constraints */
  penaltyWeight?: number;
}

export interface MultiObjectiveResult {
  /** Composite score (single number for Optuna) */
  score: number;
  /** Individual objective scores before weighting */
  objectiveScores: Record<string, number>;
  /** Constraint satisfaction */
  constraintResults: ConstraintCheckResult[];
  /** All constraints satisfied? */
  allConstraintsMet: boolean;
  /** Was the result penalized? */
  wasPenalized: boolean;
  /** Penalty amount applied */
  totalPenalty: number;
}

export interface ConstraintCheckResult {
  metric: string;
  type: string;
  required: number | [number, number];
  actual: number;
  satisfied: boolean;
  penalty: number;
}

// ============================================
// Multi-Objective Evaluator
// ============================================

export class MultiObjectiveEvaluator {
  private config: MultiObjectiveConfig;
  private history: BacktestMetrics[] = [];

  constructor(config?: Partial<MultiObjectiveConfig>) {
    this.config = {
      objectives: config?.objectives ?? DEFAULT_OBJECTIVES,
      constraints: config?.constraints ?? DEFAULT_CONSTRAINTS,
      constraintPenalty: config?.constraintPenalty ?? 500,
      normalization: config?.normalization ?? 'minmax',
    };

    // Validate weights sum approximately to 1
    const totalWeight = this.config.objectives.reduce((sum, o) => sum + Math.abs(o.weight), 0);
    if (Math.abs(totalWeight - 1) > 0.1) {
      logger.warn({ totalWeight }, 'Objective weights do not sum to ~1, normalizing');
      for (const obj of this.config.objectives) {
        obj.weight /= totalWeight;
      }
    }
  }

  /**
   * Evaluate a backtest result with multi-objective scoring
   */
  evaluate(metrics: BacktestMetrics, minTrades: number = 10): MultiObjectiveResult {
    // Insufficient trades → reject
    if (metrics.totalTrades < minTrades) {
      return {
        score: -1000,
        objectiveScores: {},
        constraintResults: [],
        allConstraintsMet: false,
        wasPenalized: true,
        totalPenalty: 1000,
      };
    }

    // Record for normalization
    this.history.push(metrics);

    // Check constraints
    const constraintResults = this.checkConstraints(metrics);
    const allConstraintsMet = constraintResults.every(c => c.satisfied);
    const hardConstraintViolation = constraintResults.some(c => !c.satisfied &&
      this.config.constraints.find(cc => cc.metric === c.metric)?.hard
    );

    // Hard constraint violation → heavy penalty
    if (hardConstraintViolation) {
      const totalPenalty = constraintResults.reduce((sum, c) => sum + c.penalty, 0);
      return {
        score: -this.config.constraintPenalty - totalPenalty,
        objectiveScores: {},
        constraintResults,
        allConstraintsMet: false,
        wasPenalized: true,
        totalPenalty: this.config.constraintPenalty + totalPenalty,
      };
    }

    // Calculate individual objective scores
    const objectiveScores: Record<string, number> = {};
    let compositeScore = 0;

    for (const obj of this.config.objectives) {
      const rawValue = this.getMetricValue(metrics, obj.metric);
      let score: number;

      if (obj.target !== undefined) {
        // Target mode: penalize deviations from target
        score = -Math.abs(rawValue - obj.target);
      } else {
        // Maximize/minimize mode
        score = this.normalizeMetric(obj.metric, rawValue);
      }

      objectiveScores[obj.metric] = score;
      compositeScore += obj.weight * score;
    }

    // Apply soft constraint penalties
    let totalPenalty = 0;
    for (const cr of constraintResults) {
      if (!cr.satisfied) {
        totalPenalty += cr.penalty;
      }
    }
    compositeScore -= totalPenalty;

    return {
      score: compositeScore,
      objectiveScores,
      constraintResults,
      allConstraintsMet,
      wasPenalized: totalPenalty > 0,
      totalPenalty,
    };
  }

  /**
   * Check all constraints
   */
  private checkConstraints(metrics: BacktestMetrics): ConstraintCheckResult[] {
    return this.config.constraints.map(constraint => {
      const actual = this.getMetricValue(metrics, constraint.metric);
      let satisfied = false;
      let penalty = 0;

      switch (constraint.type) {
        case 'min': {
          const min = constraint.value as number;
          satisfied = actual >= min;
          if (!satisfied) {
            penalty = (constraint.penaltyWeight ?? 10) * Math.abs(min - actual);
          }
          break;
        }
        case 'max': {
          const max = constraint.value as number;
          satisfied = actual <= max;
          if (!satisfied) {
            penalty = (constraint.penaltyWeight ?? 10) * Math.abs(actual - max);
          }
          break;
        }
        case 'range': {
          const [low, high] = constraint.value as [number, number];
          satisfied = actual >= low && actual <= high;
          if (!satisfied) {
            const dist = actual < low ? low - actual : actual - high;
            penalty = (constraint.penaltyWeight ?? 10) * dist;
          }
          break;
        }
      }

      return {
        metric: constraint.metric,
        type: constraint.type,
        required: constraint.value,
        actual,
        satisfied,
        penalty,
      };
    });
  }

  /**
   * Get metric value from BacktestMetrics
   */
  private getMetricValue(metrics: BacktestMetrics, name: string): number {
    const value = (metrics as unknown as Record<string, unknown>)[name];
    return typeof value === 'number' ? value : 0;
  }

  /**
   * Normalize a metric based on historical distribution
   */
  private normalizeMetric(metricName: string, value: number): number {
    if (this.config.normalization === 'none' || this.history.length < 5) {
      return value;
    }

    const historicalValues = this.history.map(m => this.getMetricValue(m, metricName));

    if (this.config.normalization === 'minmax') {
      const min = Math.min(...historicalValues);
      const max = Math.max(...historicalValues);
      if (max === min) return 0.5;
      return (value - min) / (max - min);
    }

    // zscore
    const mean = historicalValues.reduce((a, b) => a + b, 0) / historicalValues.length;
    const std = Math.sqrt(
      historicalValues.reduce((sum, v) => sum + (v - mean) ** 2, 0) / historicalValues.length
    );
    return std > 0 ? (value - mean) / std : 0;
  }

  /**
   * Reset normalization history
   */
  reset(): void {
    this.history = [];
  }

  /**
   * Get current config
   */
  getConfig(): MultiObjectiveConfig {
    return { ...this.config };
  }
}

// ============================================
// Default Configurations
// ============================================

/** Balanced multi-objective weights */
export const DEFAULT_OBJECTIVES: ObjectiveWeight[] = [
  { metric: 'sharpeRatio', weight: 0.30 },
  { metric: 'calmarRatio', weight: 0.20 },
  { metric: 'sortinoRatio', weight: 0.15 },
  { metric: 'totalReturn', weight: 0.15 },
  { metric: 'winRate', weight: 0.10 },
  { metric: 'profitFactor', weight: 0.10 },
];

/** Default hard and soft constraints */
export const DEFAULT_CONSTRAINTS: OptimizationConstraint[] = [
  // Hard constraints
  { metric: 'maxDrawdown', type: 'max', value: 0.30, hard: true },
  { metric: 'totalTrades', type: 'min', value: 15, hard: true },
  // Soft constraints (penalized but not rejected)
  { metric: 'sharpeRatio', type: 'min', value: 0.5, hard: false, penaltyWeight: 5 },
  { metric: 'winRate', type: 'min', value: 0.40, hard: false, penaltyWeight: 3 },
  { metric: 'maxDrawdown', type: 'max', value: 0.20, hard: false, penaltyWeight: 8 },
];

/** Conservative constraints for live trading */
export const CONSERVATIVE_CONSTRAINTS: OptimizationConstraint[] = [
  { metric: 'maxDrawdown', type: 'max', value: 0.15, hard: true },
  { metric: 'totalTrades', type: 'min', value: 20, hard: true },
  { metric: 'sharpeRatio', type: 'min', value: 1.0, hard: true },
  { metric: 'winRate', type: 'min', value: 0.45, hard: false, penaltyWeight: 5 },
  { metric: 'profitFactor', type: 'min', value: 1.2, hard: false, penaltyWeight: 5 },
];

/**
 * Create a multi-objective evaluator with default config
 */
export function createMultiObjectiveEvaluator(
  options?: Partial<MultiObjectiveConfig>
): MultiObjectiveEvaluator {
  return new MultiObjectiveEvaluator(options);
}
