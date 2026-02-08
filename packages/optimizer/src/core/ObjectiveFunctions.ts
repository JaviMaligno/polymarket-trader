/**
 * Objective Functions for Strategy Optimization
 *
 * These functions evaluate backtest results and return a single score
 * that Optuna will try to maximize.
 */

export interface BacktestMetrics {
  totalReturn: number;
  sharpeRatio: number;
  maxDrawdown: number;
  winRate: number;
  profitFactor: number;
  totalTrades: number;
  averageTradeReturn: number;
  volatility: number;
  calmarRatio?: number;
  sortinoRatio?: number;
}

export type ObjectiveFunctionName =
  | 'sharpe_ratio'
  | 'calmar_ratio'
  | 'sortino_ratio'
  | 'total_return'
  | 'risk_adjusted_return'
  | 'profit_factor'
  | 'custom'
  | 'composite';

export interface ObjectiveConfig {
  name: ObjectiveFunctionName;
  // For custom objective
  customWeights?: {
    returnWeight: number;
    sharpeWeight: number;
    drawdownPenalty: number;
    winRateWeight: number;
  };
  // For composite objective (multi-objective as single score)
  compositeWeights?: {
    sharpe: number;
    calmar: number;
    sortino: number;
    returns: number;
    winRate: number;
    profitFactor: number;
  };
  // Hard constraints for composite mode
  constraints?: {
    minSharpe?: number;
    maxDrawdown?: number;
    minWinRate?: number;
    minProfitFactor?: number;
  };
  // Minimum trades required for valid result
  minTrades?: number;
  // Maximum drawdown allowed (absolute value)
  maxAllowedDrawdown?: number;
}

/**
 * Calculate Sharpe Ratio
 * Higher is better - measures risk-adjusted return
 */
export function calculateSharpeRatio(metrics: BacktestMetrics): number {
  if (metrics.volatility === 0) return 0;
  // Assuming risk-free rate of 0 for simplicity
  return metrics.totalReturn / metrics.volatility;
}

/**
 * Calculate Calmar Ratio
 * Higher is better - return divided by max drawdown
 */
export function calculateCalmarRatio(metrics: BacktestMetrics): number {
  if (metrics.maxDrawdown === 0) return metrics.totalReturn > 0 ? 10 : 0;
  return metrics.totalReturn / Math.abs(metrics.maxDrawdown);
}

/**
 * Calculate Sortino Ratio
 * Like Sharpe but only penalizes downside volatility
 */
export function calculateSortinoRatio(metrics: BacktestMetrics): number {
  // If we don't have sortino pre-calculated, approximate with sharpe
  if (metrics.sortinoRatio !== undefined) {
    return metrics.sortinoRatio;
  }
  // Rough approximation: sortino is typically higher than sharpe
  return metrics.sharpeRatio * 1.2;
}

/**
 * Risk-adjusted return combining multiple factors
 */
export function calculateRiskAdjustedReturn(metrics: BacktestMetrics): number {
  // Penalize high drawdowns heavily
  const drawdownPenalty = Math.abs(metrics.maxDrawdown) * 2;

  // Reward high sharpe
  const sharpeBonus = metrics.sharpeRatio * 0.1;

  // Base return minus penalties plus bonuses
  return metrics.totalReturn - drawdownPenalty + sharpeBonus;
}

/**
 * Custom weighted objective function
 */
export function calculateCustomObjective(
  metrics: BacktestMetrics,
  weights: NonNullable<ObjectiveConfig['customWeights']>
): number {
  const {
    returnWeight,
    sharpeWeight,
    drawdownPenalty,
    winRateWeight,
  } = weights;

  return (
    metrics.totalReturn * returnWeight +
    metrics.sharpeRatio * sharpeWeight -
    Math.abs(metrics.maxDrawdown) * drawdownPenalty +
    metrics.winRate * winRateWeight
  );
}

/**
 * Calculate composite objective with multi-metric scoring and constraints
 */
export function calculateCompositeObjective(
  metrics: BacktestMetrics,
  weights: NonNullable<ObjectiveConfig['compositeWeights']>,
  constraints?: ObjectiveConfig['constraints']
): number {
  // Check hard constraints first
  if (constraints) {
    if (constraints.minSharpe !== undefined && metrics.sharpeRatio < constraints.minSharpe) {
      return -200 - Math.abs(constraints.minSharpe - metrics.sharpeRatio) * 50;
    }
    if (constraints.maxDrawdown !== undefined && Math.abs(metrics.maxDrawdown) > constraints.maxDrawdown) {
      return -200 - Math.abs(metrics.maxDrawdown) * 100;
    }
    if (constraints.minWinRate !== undefined && metrics.winRate < constraints.minWinRate) {
      return -200 - Math.abs(constraints.minWinRate - metrics.winRate) * 50;
    }
    if (constraints.minProfitFactor !== undefined && metrics.profitFactor < constraints.minProfitFactor) {
      return -200 - Math.abs(constraints.minProfitFactor - metrics.profitFactor) * 50;
    }
  }

  // Calculate composite score
  const sharpe = calculateSharpeRatio(metrics);
  const calmar = calculateCalmarRatio(metrics);
  const sortino = calculateSortinoRatio(metrics);

  return (
    sharpe * weights.sharpe +
    calmar * weights.calmar +
    sortino * weights.sortino +
    metrics.totalReturn * weights.returns +
    metrics.winRate * weights.winRate +
    Math.min(metrics.profitFactor, 10) * weights.profitFactor
  );
}

/**
 * Main objective function evaluator
 */
export function evaluateObjective(
  metrics: BacktestMetrics,
  config: ObjectiveConfig
): number {
  const { name, minTrades = 10, maxAllowedDrawdown = 0.5 } = config;

  // Invalid result if not enough trades
  if (metrics.totalTrades < minTrades) {
    return -1000; // Very bad score
  }

  // Invalid result if drawdown too high
  if (Math.abs(metrics.maxDrawdown) > maxAllowedDrawdown) {
    return -500 - Math.abs(metrics.maxDrawdown) * 100;
  }

  switch (name) {
    case 'sharpe_ratio':
      return calculateSharpeRatio(metrics);

    case 'calmar_ratio':
      return calculateCalmarRatio(metrics);

    case 'sortino_ratio':
      return calculateSortinoRatio(metrics);

    case 'total_return':
      return metrics.totalReturn;

    case 'risk_adjusted_return':
      return calculateRiskAdjustedReturn(metrics);

    case 'profit_factor':
      return metrics.profitFactor;

    case 'custom':
      if (!config.customWeights) {
        throw new Error('Custom objective requires customWeights');
      }
      return calculateCustomObjective(metrics, config.customWeights);

    case 'composite':
      return calculateCompositeObjective(
        metrics,
        config.compositeWeights ?? DEFAULT_COMPOSITE_WEIGHTS,
        config.constraints
      );

    default:
      throw new Error(`Unknown objective function: ${name}`);
  }
}

/**
 * Default composite weights balancing multiple objectives
 */
export const DEFAULT_COMPOSITE_WEIGHTS: NonNullable<ObjectiveConfig['compositeWeights']> = {
  sharpe: 0.30,
  calmar: 0.20,
  sortino: 0.15,
  returns: 0.15,
  winRate: 0.10,
  profitFactor: 0.10,
};

/**
 * Get default objective configuration.
 * Now defaults to 'composite' for better multi-metric optimization.
 */
export function getDefaultObjectiveConfig(): ObjectiveConfig {
  return {
    name: 'composite',
    compositeWeights: DEFAULT_COMPOSITE_WEIGHTS,
    constraints: {
      maxDrawdown: 0.25,
      minWinRate: 0.40,
    },
    minTrades: 10,
    maxAllowedDrawdown: 0.5,
  };
}

/**
 * Convert backtest result to metrics
 */
export function extractMetrics(backtestResult: {
  totalReturn?: number;
  sharpeRatio?: number;
  maxDrawdown?: number;
  winRate?: number;
  profitFactor?: number;
  totalTrades?: number;
  trades?: unknown[];
  averageTradeReturn?: number;
  volatility?: number;
  calmarRatio?: number;
  sortinoRatio?: number;
}): BacktestMetrics {
  return {
    totalReturn: backtestResult.totalReturn ?? 0,
    sharpeRatio: backtestResult.sharpeRatio ?? 0,
    maxDrawdown: backtestResult.maxDrawdown ?? 0,
    winRate: backtestResult.winRate ?? 0,
    profitFactor: backtestResult.profitFactor ?? 1,
    totalTrades: backtestResult.totalTrades ?? backtestResult.trades?.length ?? 0,
    averageTradeReturn: backtestResult.averageTradeReturn ?? 0,
    volatility: backtestResult.volatility ?? 0.1,
    calmarRatio: backtestResult.calmarRatio,
    sortinoRatio: backtestResult.sortinoRatio,
  };
}
