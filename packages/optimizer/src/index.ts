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
  type ParameterImportanceScore,
  ParameterSpace,
  FULL_PARAMETER_SPACE,
  MINIMAL_PARAMETER_SPACE,
  LEAN_PARAMETER_SPACE,
  createImportanceBasedParameterSpace,
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
  calculateCompositeObjective,
  evaluateObjective,
  extractMetrics,
  getDefaultObjectiveConfig,
  DEFAULT_COMPOSITE_WEIGHTS,
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

// Multi-Objective
export {
  MultiObjectiveEvaluator,
  createMultiObjectiveEvaluator,
  type MultiObjectiveConfig,
  type ObjectiveWeight,
  type OptimizationConstraint,
  type MultiObjectiveResult,
  type ConstraintCheckResult,
  DEFAULT_OBJECTIVES,
  DEFAULT_CONSTRAINTS,
  CONSERVATIVE_CONSTRAINTS,
} from './core/MultiObjective.js';

// Ensemble
export {
  EnsembleOptimizer,
  createEnsembleOptimizer,
  type EnsembleConfig,
  type DiversityMethod,
  type EnsembleMember,
  type EnsembleResult,
  type AgreementAnalysis,
  type StabilityAnalysis,
  type EnsembleAssessment,
  type EnsembleBacktestRunner,
  type EnsembleParameterOptimizer,
} from './core/EnsembleOptimizer.js';

// Adaptive Parameters
export {
  AdaptiveRegimeDetector,
  createAdaptiveRegimeDetector,
  buildAdaptiveParameterSet,
  type MarketRegimeType,
  type AdaptiveConfig,
  type RegimeState,
  type RegimeParameters,
  type AdaptiveParameterSet,
  type AdaptiveAssessment,
  type MarketSnapshot,
} from './core/AdaptiveParameters.js';

// Service
export {
  type ServiceConfig,
  DEFAULT_SERVICE_CONFIG,
  OptimizationService,
  createOptimizationService,
} from './service/OptimizationService.js';
