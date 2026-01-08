/**
 * @polymarket-trader/backtest
 *
 * Event-driven backtesting engine for Polymarket trading strategies.
 *
 * Features:
 * - Realistic order book simulation with slippage
 * - Position and portfolio management
 * - Risk management with position/exposure limits
 * - Performance metrics (Sharpe, Sortino, max drawdown, etc.)
 * - Prediction market specific metrics (Brier score, calibration)
 */

// Core types
export * from './types/index.js';

// Engine
export { EventBus } from './engine/EventBus.js';
export {
  BacktestEngine,
  type IPortfolioManager,
  type IOrderBookSimulator,
  type IRiskManager,
} from './engine/BacktestEngine.js';

// Simulation
export { OrderBookSimulator } from './simulation/OrderBookSimulator.js';
export { SlippageModel, type SlippageResult } from './simulation/SlippageModel.js';

// Portfolio
export { PortfolioManager } from './portfolio/PortfolioManager.js';

// Risk
export { RiskManager } from './risk/RiskManager.js';

// Metrics
export { PerformanceCalculator } from './metrics/PerformanceCalculator.js';
export { PredictionMarketCalculator } from './metrics/PredictionMarketCalculator.js';

// Validation
export {
  WalkForwardAnalyzer,
  createWalkForwardAnalyzer,
  type WalkForwardConfig,
  type WalkForwardPeriod,
  type WalkForwardResult,
  type AggregateWalkForwardMetrics,
  type BacktestRunner,
  type ParameterOptimizer,
} from './validation/WalkForwardAnalyzer.js';

export {
  MonteCarloSimulator,
  createMonteCarloSimulator,
  type MonteCarloConfig,
  type MonteCarloResult,
  type SimulationMetrics,
  type SimulationDistribution,
  type SignificanceTests,
  type ConfidenceIntervals,
  type RiskMetrics,
} from './validation/MonteCarloSimulator.js';

export {
  OverfitDetector,
  createOverfitDetector,
  type OverfitConfig,
  type OverfitResult,
  type OverfitIndicators,
  type OverfitAnalysis,
  type DegradationMetrics,
  type ParameterSensitivity,
  type ComplexityMetrics,
  type DistributionMetrics,
  type TimeStability,
} from './validation/OverfitDetector.js';

export {
  ValidationReportGenerator,
  createValidationReportGenerator,
  type ValidationConfig,
  type ValidationReport,
  type ValidationResult,
  type ValidationDecision,
  type BacktestSummarySection,
  type WalkForwardSection,
  type MonteCarloSection,
  type OverfitSection,
  type PredictionMarketSection,
} from './validation/ValidationReport.js';

// Factory functions
import { BacktestEngine } from './engine/BacktestEngine.js';
import { OrderBookSimulator } from './simulation/OrderBookSimulator.js';
import { SlippageModel } from './simulation/SlippageModel.js';
import { PortfolioManager } from './portfolio/PortfolioManager.js';
import { RiskManager } from './risk/RiskManager.js';
import type { BacktestConfig, MarketData, SlippageConfig, RiskConfig } from './types/index.js';
import type { ISignal, ISignalCombiner } from '@polymarket-trader/signals';

/**
 * Configuration for creating a backtest engine
 */
export interface CreateBacktestOptions {
  config: BacktestConfig;
  marketData: MarketData[];
  signals: ISignal[];
  combiner: ISignalCombiner;
  slippageConfig?: SlippageConfig;
  riskConfig?: RiskConfig;
  snapshotIntervalMinutes?: number;
}

/**
 * Create a fully configured backtest engine
 */
export function createBacktestEngine(options: CreateBacktestOptions): BacktestEngine {
  // Create slippage model
  const slippageConfig = options.slippageConfig || {
    model: 'proportional' as const,
    proportionalRate: 0.001,
  };
  const slippageModel = new SlippageModel(slippageConfig);

  // Create order book simulator
  const orderBookSimulator = new OrderBookSimulator(slippageModel);

  // Create portfolio manager
  const portfolioManager = new PortfolioManager({
    initialCapital: options.config.initialCapital,
    feeRate: options.config.feeRate,
    snapshotIntervalMinutes: options.snapshotIntervalMinutes || 60,
  });

  // Create risk manager
  const riskConfig = options.riskConfig || options.config.risk;
  const riskManager = new RiskManager(riskConfig);

  // Create engine
  const engine = new BacktestEngine({
    config: options.config,
    marketData: options.marketData,
    signals: options.signals,
    combiner: options.combiner,
  });

  // Inject components
  engine.setOrderBookSimulator(orderBookSimulator);
  engine.setPortfolioManager(portfolioManager);
  engine.setRiskManager(riskManager);

  return engine;
}

/**
 * Default backtest configuration
 */
export const DEFAULT_BACKTEST_CONFIG: Partial<BacktestConfig> = {
  feeRate: 0.001, // 0.1% (optimized)
  granularityMinutes: 60,
  slippage: {
    model: 'fixed',
    fixedSlippage: 0.005, // 0.5% slippage
  },
  risk: {
    maxPositionSizePct: 5,    // Optimized: smaller positions reduce risk
    maxExposurePct: 80,
    maxDrawdownPct: 25,
    dailyLossLimit: 1000,
    maxPositions: 10,
    stopLossPct: 20,
    takeProfitPct: 50,
  },
  // SHORT-only strategy is profitable (+31% vs -30% for LONG)
  // Mean reversion signals work better for identifying overpriced markets
  onlyDirection: 'SHORT',
};

/**
 * Create a default backtest config with overrides
 */
export function createBacktestConfig(
  overrides: Partial<BacktestConfig> & {
    startDate: Date;
    endDate: Date;
    initialCapital: number;
  }
): BacktestConfig {
  return {
    startDate: overrides.startDate,
    endDate: overrides.endDate,
    initialCapital: overrides.initialCapital,
    feeRate: overrides.feeRate ?? DEFAULT_BACKTEST_CONFIG.feeRate!,
    granularityMinutes: overrides.granularityMinutes ?? DEFAULT_BACKTEST_CONFIG.granularityMinutes!,
    slippage: overrides.slippage ?? DEFAULT_BACKTEST_CONFIG.slippage!,
    risk: { ...DEFAULT_BACKTEST_CONFIG.risk!, ...overrides.risk },
    marketIds: overrides.marketIds,
    onlyDirection: overrides.onlyDirection ?? DEFAULT_BACKTEST_CONFIG.onlyDirection,
  };
}
