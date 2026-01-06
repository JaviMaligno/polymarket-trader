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
export { WalletTrackingSignal } from './signals/wallet/WalletTrackingSignal.js';
export { MomentumSignal } from './signals/technical/MomentumSignal.js';
export { MeanReversionSignal } from './signals/technical/MeanReversionSignal.js';
export { CrossMarketArbitrageSignal } from './signals/arbitrage/CrossMarketArbitrageSignal.js';

// Combiners
export { WeightedAverageCombiner } from './combiners/WeightedAverageCombiner.js';

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

// Signal Registry (factory for creating signals)
import { MomentumSignal } from './signals/technical/MomentumSignal.js';
import { MeanReversionSignal } from './signals/technical/MeanReversionSignal.js';
import { WalletTrackingSignal } from './signals/wallet/WalletTrackingSignal.js';
import { CrossMarketArbitrageSignal } from './signals/arbitrage/CrossMarketArbitrageSignal.js';
import type { ISignal, SignalConfig } from './core/types/signal.types.js';

const signalRegistry: Record<string, () => ISignal> = {
  momentum: () => new MomentumSignal(),
  mean_reversion: () => new MeanReversionSignal(),
  wallet_tracking: () => new WalletTrackingSignal(),
  cross_market_arb: () => new CrossMarketArbitrageSignal(),
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
