/**
 * Market Regime Detection System
 *
 * Provides:
 * - Hidden Markov Model for regime detection
 * - Market regime types and parameters
 * - Strategy adaptation based on regime
 */

export { HiddenMarkovModel, type HMMConfig } from './HiddenMarkovModel.js';
export { RegimeDetector, type RegimeDetectorConfig } from './RegimeDetector.js';
export {
  MarketRegime,
  type RegimeState,
  type TransitionMatrix,
  type EmissionParams,
  type RegimeParameters,
  type MarketObservation,
  DEFAULT_REGIME_PARAMETERS,
} from './types.js';
