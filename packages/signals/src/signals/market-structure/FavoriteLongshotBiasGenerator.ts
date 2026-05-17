import { BaseSignal } from '../../core/base/BaseSignal.js';
import type {
  SignalContext,
  SignalOutput,
} from '../../core/types/signal.types.js';

export interface FavoriteLongshotBiasParams extends Record<string, unknown> {
  /**
   * Upper bound of the longshot band. When price < longshotThreshold the
   * market is under-pricing the YES outcome relative to its long-run
   * frequency; the literature reports 3–8% under-pricing for sub-0.10
   * binary contracts. Default 0.10.
   */
  longshotThreshold: number;
  /**
   * Lower bound of the favorite band. When price > favoriteThreshold the
   * market is over-pricing YES (lottery-aversion driving demand for the
   * "sure thing"). Default 0.90 (symmetric to longshotThreshold).
   */
  favoriteThreshold: number;
  /**
   * Minimum |strength| required to emit. Prices just inside the band emit
   * a near-zero signal that the combiner would discard anyway. Default 0.05.
   */
  minStrength: number;
}

export const DEFAULT_FAVORITE_LONGSHOT_BIAS_PARAMS: FavoriteLongshotBiasParams = {
  longshotThreshold: 0.10,
  favoriteThreshold: 0.90,
  minStrength: 0.05,
};

/**
 * FavoriteLongshotBiasGenerator
 *
 * Codifies the favorite-longshot bias documented in prediction-market
 * literature (Wolfers/Zitzewitz 2004, Manski 2006). Two regimes:
 *
 *   1. Longshot band (price < longshotThreshold): YES outcomes priced below
 *      ~0.10 historically resolve YES more often than the price implies.
 *      Empirical mispricing is 3–8%. The generator emits LONG.
 *
 *   2. Favorite band (price > favoriteThreshold): YES outcomes priced above
 *      ~0.90 historically resolve YES less often than the price implies
 *      (lottery-aversion + supply imbalance). The generator emits SHORT.
 *
 * In the mid-range no clear directional bias exists in the literature, so
 * the generator returns null.
 *
 * Mathematical structure:
 *
 *   longshot: magnitude = (longshotThreshold - price) / longshotThreshold
 *             direction = LONG, strength = +magnitude
 *   favorite: magnitude = (price - favoriteThreshold) / (1 - favoriteThreshold)
 *             direction = SHORT, strength = -magnitude
 *   confidence = 0.4 + 0.5 × magnitude  (clamped to [0, 1] by BaseSignal)
 *
 * Output is bounded by `createOutput` to strength ∈ [-1, 1] and
 * confidence ∈ [0, 1]; magnitudes near 1.0 happen only at price ≈ 0 or
 * ≈ 1, which the terminal-price check filters before computation.
 */
export class FavoriteLongshotBiasGenerator extends BaseSignal<FavoriteLongshotBiasParams> {
  readonly signalId = 'favorite_longshot_bias';
  readonly name = 'Favorite-Longshot Bias';
  readonly description =
    'Exploits the empirical under-pricing of longshots (price < 0.10) and over-pricing of favorites (price > 0.90) in binary prediction markets';

  protected parameters: FavoriteLongshotBiasParams;

  constructor(config?: Partial<FavoriteLongshotBiasParams>) {
    super();
    this.parameters = {
      ...DEFAULT_FAVORITE_LONGSHOT_BIAS_PARAMS,
      ...config,
    };
  }

  getRequiredLookback(): number {
    return 0;
  }

  isReady(context: SignalContext): boolean {
    return context.priceBars.length > 0;
  }

  async compute(context: SignalContext): Promise<SignalOutput | null> {
    const { longshotThreshold, favoriteThreshold, minStrength } = this.parameters;

    const bars = context.priceBars;
    if (bars.length === 0) return null;

    const currentPrice = bars[bars.length - 1].close;
    if (currentPrice <= 0 || currentPrice >= 1) return null;

    let magnitude: number;
    let direction: 'LONG' | 'SHORT';
    let band: 'longshot' | 'favorite';

    if (currentPrice < longshotThreshold) {
      magnitude = (longshotThreshold - currentPrice) / longshotThreshold;
      direction = 'LONG';
      band = 'longshot';
    } else if (currentPrice > favoriteThreshold) {
      magnitude = (currentPrice - favoriteThreshold) / (1 - favoriteThreshold);
      direction = 'SHORT';
      band = 'favorite';
    } else {
      return null;
    }

    if (magnitude < minStrength) return null;

    const strength = direction === 'LONG' ? magnitude : -magnitude;
    const confidence = 0.4 + 0.5 * magnitude;

    return this.createOutput(context, direction, strength, confidence, {
      features: [currentPrice, magnitude],
      metadata: {
        currentPrice,
        band,
        magnitude,
        threshold: band === 'longshot' ? longshotThreshold : favoriteThreshold,
      },
    });
  }
}
