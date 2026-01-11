/**
 * Market Regime Types
 *
 * Defines the different market regimes that can be detected
 * and the data structures used for regime analysis.
 */

/**
 * Market regimes based on trend and volatility
 */
export enum MarketRegime {
  /** Strong uptrend with low volatility - ideal for momentum */
  BULL_LOW_VOL = 'bull_low_vol',
  /** Strong uptrend with high volatility - momentum with caution */
  BULL_HIGH_VOL = 'bull_high_vol',
  /** Strong downtrend with low volatility - avoid momentum */
  BEAR_LOW_VOL = 'bear_low_vol',
  /** Strong downtrend with high volatility - high risk */
  BEAR_HIGH_VOL = 'bear_high_vol',
  /** No clear trend - range-bound, good for mean reversion */
  NEUTRAL = 'neutral',
}

/**
 * Regime detection result
 */
export interface RegimeState {
  /** Current detected regime */
  regime: MarketRegime;
  /** Probability of being in current regime (0-1) */
  probability: number;
  /** Probabilities for all regimes */
  stateProbabilities: Record<MarketRegime, number>;
  /** When this regime was detected */
  timestamp: Date;
  /** How long we've been in this regime (bars) */
  duration: number;
  /** Recent regime history for transition analysis */
  history: Array<{ regime: MarketRegime; probability: number; timestamp: Date }>;
}

/**
 * Regime transition matrix
 * Probability of transitioning from regime A to regime B
 */
export type TransitionMatrix = Record<MarketRegime, Record<MarketRegime, number>>;

/**
 * Emission parameters for each regime
 * Defines the statistical properties of returns in each regime
 */
export interface EmissionParams {
  /** Mean return in this regime */
  meanReturn: number;
  /** Standard deviation of returns */
  stdReturn: number;
  /** Mean volatility level */
  meanVolatility: number;
  /** Std of volatility */
  stdVolatility: number;
}

/**
 * Regime-specific trading parameters
 */
export interface RegimeParameters {
  /** Regime this applies to */
  regime: MarketRegime;
  /** Position size multiplier (0-2) */
  positionSizeMultiplier: number;
  /** Minimum confidence threshold */
  minConfidence: number;
  /** Minimum strength threshold */
  minStrength: number;
  /** Preferred signal types for this regime */
  preferredSignals: string[];
  /** Signals to avoid in this regime */
  avoidSignals: string[];
  /** Stop loss adjustment multiplier */
  stopLossMultiplier: number;
  /** Take profit adjustment multiplier */
  takeProfitMultiplier: number;
}

/**
 * Market observation used for regime detection
 */
export interface MarketObservation {
  timestamp: Date;
  /** Returns (close-to-close) */
  returns: number;
  /** Realized volatility (e.g., rolling std of returns) */
  volatility: number;
  /** Volume relative to average */
  relativeVolume: number;
  /** Momentum indicator (e.g., ROC) */
  momentum?: number;
}

/**
 * Default regime parameters for strategy adaptation
 */
export const DEFAULT_REGIME_PARAMETERS: Record<MarketRegime, RegimeParameters> = {
  [MarketRegime.BULL_LOW_VOL]: {
    regime: MarketRegime.BULL_LOW_VOL,
    positionSizeMultiplier: 1.2,
    minConfidence: 0.35,
    minStrength: 0.15,
    preferredSignals: ['momentum', 'ofi', 'mlofi'],
    avoidSignals: [],
    stopLossMultiplier: 0.8,
    takeProfitMultiplier: 1.2,
  },
  [MarketRegime.BULL_HIGH_VOL]: {
    regime: MarketRegime.BULL_HIGH_VOL,
    positionSizeMultiplier: 0.8,
    minConfidence: 0.45,
    minStrength: 0.25,
    preferredSignals: ['momentum', 'wallet_tracking'],
    avoidSignals: ['mean_reversion'],
    stopLossMultiplier: 1.2,
    takeProfitMultiplier: 1.0,
  },
  [MarketRegime.BEAR_LOW_VOL]: {
    regime: MarketRegime.BEAR_LOW_VOL,
    positionSizeMultiplier: 0.6,
    minConfidence: 0.50,
    minStrength: 0.20,
    preferredSignals: ['mean_reversion', 'cross_market_arb'],
    avoidSignals: ['momentum'],
    stopLossMultiplier: 1.0,
    takeProfitMultiplier: 0.8,
  },
  [MarketRegime.BEAR_HIGH_VOL]: {
    regime: MarketRegime.BEAR_HIGH_VOL,
    positionSizeMultiplier: 0.4,
    minConfidence: 0.60,
    minStrength: 0.30,
    preferredSignals: ['cross_market_arb', 'wallet_tracking'],
    avoidSignals: ['momentum', 'ofi'],
    stopLossMultiplier: 1.5,
    takeProfitMultiplier: 0.7,
  },
  [MarketRegime.NEUTRAL]: {
    regime: MarketRegime.NEUTRAL,
    positionSizeMultiplier: 1.0,
    minConfidence: 0.40,
    minStrength: 0.20,
    preferredSignals: ['mean_reversion', 'cross_market_arb', 'ofi'],
    avoidSignals: [],
    stopLossMultiplier: 1.0,
    takeProfitMultiplier: 1.0,
  },
};
