import { BaseSignal } from '../../core/base/BaseSignal.js';
import type {
  SignalContext,
  SignalOutput,
} from '../../core/types/signal.types.js';

export interface ResolutionPriorParams extends Record<string, unknown> {
  /**
   * Maximum days to resolution at which the generator still fires. Beyond
   * this window the prior contains too little information vs price-action
   * signals — return null instead of emitting weak noise. Default 14 days.
   */
  cutoffDays: number;
  /**
   * Minimum |price - 0.5| to fire. Markets near the coin-flip prior have no
   * directional content from the resolution prior. Default 0.05 (i.e. price
   * outside [0.45, 0.55]).
   */
  minPriceDistance: number;
  /**
   * Minimum strength to emit the signal. Default 0.05 — the same low gate
   * used elsewhere in the system; the combiner threshold filters further.
   */
  minStrength: number;
}

export const DEFAULT_RESOLUTION_PRIOR_PARAMS: ResolutionPriorParams = {
  cutoffDays: 14,
  minPriceDistance: 0.05,
  minStrength: 0.05,
};

/**
 * ResolutionPriorGenerator
 *
 * Codifies the terminal-resolution prior of a binary prediction market. As
 * a market approaches its end date, price → outcome (0 or 1). A market
 * trading at 0.20 with two days to expiry has a strong prior toward NO;
 * mean-reversion / SMA-based generators read the same information as
 * "buy the dip" because their reference is the rolling average. This
 * generator gives the system a directional voice that is *not* anchored
 * to recent price action.
 *
 * Mathematical structure:
 *
 *   - daysToResolution > cutoffDays  → null (prior too weak)
 *   - daysToResolution ≤ 0           → null (market expired)
 *   - direction       = price > 0.5 ? 'LONG' : 'SHORT'
 *   - priceDistance   = clamp(|price - 0.5| / 0.5, 0, 1)
 *   - timeProximity   = 1 - daysToResolution / cutoffDays
 *   - strength        = priceDistance × timeProximity × sign(direction)
 *   - confidence      = 0.4 + 0.5 × priceDistance × timeProximity
 *
 * Strength is signed to match the SignalOutput convention (positive = LONG,
 * negative = SHORT). `confidence` floor is 0.4 so the generator contributes
 * meaningfully to the combiner consensus computation when it does fire.
 */
export class ResolutionPriorGenerator extends BaseSignal<ResolutionPriorParams> {
  readonly signalId = 'resolution_prior';
  readonly name = 'Resolution Prior';
  readonly description =
    'Codifies the terminal-resolution prior — markets drift to 0/1 near expiry';

  protected parameters: ResolutionPriorParams;

  constructor(config?: Partial<ResolutionPriorParams>) {
    super();
    this.parameters = {
      ...DEFAULT_RESOLUTION_PRIOR_PARAMS,
      ...config,
    };
  }

  getRequiredLookback(): number {
    return 0;
  }

  isReady(context: SignalContext): boolean {
    return Boolean(context.market.endDate) && context.priceBars.length > 0;
  }

  async compute(context: SignalContext): Promise<SignalOutput | null> {
    const { cutoffDays, minPriceDistance, minStrength } = this.parameters;
    const endDate = context.market.endDate;
    if (!endDate) return null;

    const daysToResolution =
      (endDate.getTime() - context.currentTime.getTime()) / (1000 * 60 * 60 * 24);

    if (daysToResolution <= 0 || daysToResolution > cutoffDays) {
      return null;
    }

    const bars = context.priceBars;
    if (bars.length === 0) return null;
    const currentPrice = bars[bars.length - 1].close;
    if (currentPrice <= 0 || currentPrice >= 1) return null;

    const priceDistance = Math.min(1, Math.abs(currentPrice - 0.5) / 0.5);
    if (priceDistance < minPriceDistance) return null;

    const timeProximity = 1 - daysToResolution / cutoffDays;
    const direction = currentPrice > 0.5 ? 'LONG' : 'SHORT';
    const directionSign = currentPrice > 0.5 ? 1 : -1;
    const magnitude = priceDistance * timeProximity;
    const strength = magnitude * directionSign;

    if (Math.abs(strength) < minStrength) return null;

    const confidence = Math.min(1, 0.4 + 0.5 * magnitude);

    return this.createOutput(context, direction, strength, confidence, {
      features: [currentPrice, priceDistance, timeProximity],
      metadata: {
        currentPrice,
        daysToResolution,
        priceDistance,
        timeProximity,
      },
    });
  }
}
