/**
 * Polymarket Trading Signals Package
 *
 * Signal framework for generating trading signals based on:
 * - Wallet tracking (insider/smart money detection)
 * - Technical analysis (momentum, mean reversion)
 * - Cross-market arbitrage
 *
 * @example
 * ```typescript
 * import {
 *   MomentumSignal,
 *   MeanReversionSignal,
 *   WalletTrackingSignal,
 *   WeightedAverageCombiner,
 * } from '@polymarket-trader/signals';
 *
 * // Create signals
 * const momentum = new MomentumSignal();
 * const meanReversion = new MeanReversionSignal();
 * const walletTracking = new WalletTrackingSignal();
 *
 * // Create combiner with weights
 * const combiner = new WeightedAverageCombiner({
 *   momentum: 0.35,
 *   mean_reversion: 0.35,
 *   wallet_tracking: 0.30,
 * });
 *
 * // Compute signals
 * const context = { ... }; // SignalContext
 * const signals = await Promise.all([
 *   momentum.compute(context),
 *   meanReversion.compute(context),
 *   walletTracking.compute(context),
 * ]);
 *
 * // Combine into final signal
 * const combined = combiner.combine(signals.filter(Boolean));
 * ```
 */

// Types
export * from './core/types/signal.types.js';

// Base classes
export { BaseSignal } from './core/base/BaseSignal.js';

// Signals
export {
  WalletTrackingSignal,
  type WalletTrackingConfig,
  type WalletProfile,
  type TopTrader,
  type WalletCluster,
  DEFAULT_WALLET_TRACKING_PARAMS,
} from './signals/wallet/WalletTrackingSignal.js';
export {
  MomentumSignal,
  type MomentumSignalConfig,
  DEFAULT_MOMENTUM_PARAMS,
} from './signals/technical/MomentumSignal.js';
export {
  MeanReversionSignal,
  type MeanReversionSignalConfig,
  DEFAULT_MEAN_REVERSION_PARAMS,
} from './signals/technical/MeanReversionSignal.js';
export {
  CrossMarketArbitrageSignal,
  type CrossMarketArbitrageConfig,
  type ExternalPlatform,
  type PlatformFees,
  type ExternalMarketData,
  type CrossPlatformOpportunity,
  type IExternalPlatformProvider,
  type MarketCorrelation,
  PLATFORM_FEES,
  DEFAULT_ARBITRAGE_PARAMS,
} from './signals/arbitrage/CrossMarketArbitrageSignal.js';

// Microstructure Signals
export {
  OrderFlowImbalanceSignal,
  type OFISignalConfig,
  DEFAULT_OFI_PARAMS,
} from './signals/microstructure/OrderFlowImbalanceSignal.js';
export {
  MultiLevelOFISignal,
  type MLOFISignalConfig,
  type MultiLevelOrderBook,
  DEFAULT_MLOFI_PARAMS,
} from './signals/microstructure/MultiLevelOFISignal.js';
export {
  HawkesSignal,
  type HawkesSignalConfig,
  DEFAULT_HAWKES_PARAMS,
} from './signals/microstructure/HawkesSignal.js';

// Sentiment Signals
export {
  SentimentSignal,
  type SentimentSignalConfig,
  type SentimentAnalysis,
  type ISentimentProvider,
  type SentimentSource,
  DEFAULT_SENTIMENT_PARAMS,
} from './signals/sentiment/SentimentSignal.js';

// Event-Driven Signals
export {
  EventDrivenSignal,
  type EventDrivenSignalConfig,
  DEFAULT_EVENT_SIGNAL_PARAMS,
  EventCalendar,
  type EventCalendarConfig,
  type IEventProvider,
  EventCategory,
  EventSubType,
  EventImportance,
  EventPhase,
  type ScheduledEvent,
  type MarketEventContext,
  type EventPattern,
  type EventTradingConfig,
  DEFAULT_EVENT_TRADING_CONFIG,
} from './signals/event/index.js';

// RL Signal
export {
  RLSignal,
  type RLSignalConfig,
} from './signals/rl/RLSignal.js';

// Combiners
export { WeightedAverageCombiner } from './combiners/WeightedAverageCombiner.js';
export {
  AttentionCombiner,
  type AttentionCombinerConfig,
  type AttentionWeights,
  type AttentionCombinedResult,
  DEFAULT_ATTENTION_CONFIG,
} from './combiners/AttentionCombiner.js';

// Regime Detection
export {
  HiddenMarkovModel,
  type HMMConfig,
  RegimeDetector,
  type RegimeDetectorConfig,
  MarketRegime,
  type RegimeState,
  type RegimeParameters,
  type MarketObservation,
  DEFAULT_REGIME_PARAMETERS,
} from './regime/index.js';

// Optimizers
export {
  BayesianOptimizerClient,
  MLCombinerClient,
  createOptimizerClient,
  createCombinerClient,
  DEFAULT_OPTIMIZER_URL,
  type SignalBounds,
  type OptimizerConfig,
  type OptimizationResult,
  type OptimizerStatistics,
  type CombinerPrediction,
  type SignalFeaturesInput,
  type TrainingExample,
} from './optimizers/BayesianOptimizer.js';

// Reinforcement Learning
export {
  RLMarketMaker,
  type RLMarketMakerConfig,
  type TrainingCallback,
  type TrainingResult,
  DEFAULT_RL_CONFIG,
  DQNAgent,
  MarketMakingEnvironment,
  type OrderBookSnapshot,
  type MarketTick,
  type StepResult,
  ReplayBuffer,
  type ReplayBufferConfig,
  DEFAULT_BUFFER_CONFIG,
  type RLState,
  type RLAction,
  DiscreteAction,
  type Experience,
  type TrainingBatch,
  type AgentConfig,
  type EnvironmentConfig,
  type MarketMakerMetrics,
  type ModelCheckpoint,
  DEFAULT_AGENT_CONFIG,
  DEFAULT_ENV_CONFIG,
} from './ml/index.js';

// Risk Protection Filters
export {
  // Position and Stop-Loss Management (A & B)
  PositionLimits,
  type PositionLimitsConfig,
  type Position,
  type PositionCheckResult,
  StopLossManager,
  type StopLossConfig,
  type TrackedPosition,
  type StopCheckResult,
  STOP_LOSS_RANGES,
  // Entry Filters (C1, C2, C3)
  HurstFilter,
  type HurstConfig,
  type HurstResult,
  type MarketRegime as HurstMarketRegime,
  type HurstFilterDecision,
  HURST_RANGES,
  RSIMomentumFilter,
  type RSIConfig,
  type RSIResult,
  type RSIFilterDecision,
  RSI_RANGES,
  ZScoreVolatilityFilter,
  type ZScoreConfig,
  type ZScoreResult,
  type ZScoreFilterDecision,
  type VolatilityAnalysis,
  ZSCORE_RANGES,
  // Pipeline Orchestrator
  EntryFilterPipeline,
  type EntryFilterConfig,
  type PipelineDecision,
  type SignalType,
  type SignalDirection,
} from './filters/index.js';

// Signal Registry (factory for creating signals)
import { MomentumSignal } from './signals/technical/MomentumSignal.js';
import { MeanReversionSignal } from './signals/technical/MeanReversionSignal.js';
import { WalletTrackingSignal } from './signals/wallet/WalletTrackingSignal.js';
import { CrossMarketArbitrageSignal } from './signals/arbitrage/CrossMarketArbitrageSignal.js';
import { OrderFlowImbalanceSignal } from './signals/microstructure/OrderFlowImbalanceSignal.js';
import { MultiLevelOFISignal } from './signals/microstructure/MultiLevelOFISignal.js';
import { HawkesSignal } from './signals/microstructure/HawkesSignal.js';
import { SentimentSignal } from './signals/sentiment/SentimentSignal.js';
import { EventDrivenSignal } from './signals/event/EventDrivenSignal.js';
import { RLSignal } from './signals/rl/RLSignal.js';
import type { ISignal, SignalConfig } from './core/types/signal.types.js';

const signalRegistry: Record<string, () => ISignal> = {
  momentum: () => new MomentumSignal(),
  mean_reversion: () => new MeanReversionSignal(),
  wallet_tracking: () => new WalletTrackingSignal(),
  cross_market_arb: () => new CrossMarketArbitrageSignal(),
  ofi: () => new OrderFlowImbalanceSignal(),
  mlofi: () => new MultiLevelOFISignal(),
  hawkes: () => new HawkesSignal(),
  sentiment: () => new SentimentSignal(),
  event_driven: () => new EventDrivenSignal(),
  rl: () => new RLSignal(),
};

/**
 * Create a signal instance by ID
 */
export function createSignal(signalId: string): ISignal | null {
  const factory = signalRegistry[signalId];
  return factory ? factory() : null;
}

/**
 * Create multiple signals from configuration
 */
export function createSignals(configs: SignalConfig[]): ISignal[] {
  const signals: ISignal[] = [];

  for (const config of configs) {
    if (!config.enabled) continue;

    const signal = createSignal(config.signalId);
    if (signal) {
      signal.setParameters(config.parameters);
      signals.push(signal);
    }
  }

  return signals;
}

/**
 * Get all available signal IDs
 */
export function getAvailableSignals(): string[] {
  return Object.keys(signalRegistry);
}
