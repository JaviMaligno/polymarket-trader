/**
 * @polymarket-trader/optimizer
 *
 * Strategy optimization and automated parameter tuning for Polymarket trading.
 */

// Core
export {
  type ParameterDefinition,
  type ParameterValues,
  type ParameterCategory,
  ParameterSpace,
  FULL_PARAMETER_SPACE,
  MINIMAL_PARAMETER_SPACE,
} from './core/ParameterSpace.js';

export {
  type BacktestMetrics,
  type ObjectiveFunctionName,
  type ObjectiveConfig,
  calculateSharpeRatio,
  calculateCalmarRatio,
  calculateSortinoRatio,
  calculateRiskAdjustedReturn,
  calculateCustomObjective,
  evaluateObjective,
  extractMetrics,
  getDefaultObjectiveConfig,
} from './core/ObjectiveFunctions.js';

export {
  type OptimizerServerConfig,
  type OptimizerType,
  type OptimizationConfig,
  type OptimizationRunState,
  type BacktestResultRecord,
  type IBacktestRunner,
  StrategyOptimizer,
  createStrategyOptimizer,
} from './core/StrategyOptimizer.js';

// Storage
export {
  type OptimizationRun,
  type BacktestResult,
  type SavedStrategy,
  OptimizationStore,
  createOptimizationStore,
} from './storage/OptimizationStore.js';

// Service
export {
  type ServiceConfig,
  DEFAULT_SERVICE_CONFIG,
  OptimizationService,
  createOptimizationService,
} from './service/OptimizationService.js';
