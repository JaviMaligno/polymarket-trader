import { BaseSignal } from '../../core/base/BaseSignal.js';
import type {
  SignalContext,
  SignalOutput,
} from '../../core/types/signal.types.js';

export interface ResolutionPriorV2Params extends Record<string, unknown> {
  /**
   * How many of the earliest bars in the lookback window contribute to the
   * anchor (prior) SMA. The anchor is "where the market traded before the
   * recent window" — a stable reference that the recent price can be
   * compared against. Default 24. See design doc
   * `docs/plans/2026-05-17-resolution-prior-v2-design.md`.
   */
  anchorWindow: number;
  /**
   * How many of the most recent bars contribute to the volatility estimate
   * (σ) AND to the current-price reference. Disjoint from anchorWindow.
   * Default 24.
   */
  recentWindow: number;
  /**
   * Maximum days-to-resolution at which the generator still fires. Beyond
   * this, the v2 prior is weakly informative; v1 (ResolutionPriorGenerator)
   * covers the longer-horizon regime. Default 7.
   */
  cutoffDays: number;
  /**
   * Minimum |z| required to emit. z = (currentPrice − anchor) / σ. Below
   * this threshold the deviation is interpreted as noise. Default 2.5 (≈
   * 99 % two-tailed). Tuneable via Optuna.
   */
  minZScore: number;
  /**
   * Minimum |strength| required to emit. Mirrors the convention used by
   * ResolutionPriorGenerator. Default 0.05.
   */
  minStrength: number;
  /**
   * Floor for σ. Without this, smooth recent paths produce σ → 0 and z
   * blows up artificially. 0.005 corresponds to 0.5 % of mid-price — well
   * below typical bid-ask spread, so it cannot mask a real noise floor.
   */
  minSigma: number;
}

export const DEFAULT_RESOLUTION_PRIOR_V2_PARAMS: ResolutionPriorV2Params = {
  anchorWindow: 24,
  recentWindow: 24,
  cutoffDays: 7,
  minZScore: 2.5,
  minStrength: 0.05,
  minSigma: 0.005,
};

/**
 * ResolutionPriorV2Generator
 *
 * Mean-reversion-against-anchor generator for prediction markets near
 * resolution. The recent price is compared against an SMA "anchor" taken
 * from the earlier portion of the lookback window. A z-score |z| > minZScore
 * triggers a signal in the direction of the anchor (i.e. against the
 * deviation).
 *
 * NOT a momentum generator. NOT a tail-band generator (that's
 * FavoriteLongshotBiasGenerator). NOT the same as the v1
 * ResolutionPriorGenerator, which is trend-following relative to 0.5 with
 * time-proximity gating.
 *
 * Hypothesis under test (per `project_prediction_market_alpha_research.md`):
 * within the resolution horizon (TTR ≤ 7d), where information has been
 * largely digested, large deviations from the recent anchor reflect
 * temporary liquidity noise rather than genuine information shocks, and
 * mean-revert.
 *
 * Failure mode (documented in design doc): smooth directional moves
 * produce small σ and inflated z. The generator will fire SHORT on a
 * smooth upward drift driven by real information, which is the wrong call.
 * Phase 5 cost-aware t-stat measurement (Pilar 1, nightly cron) is the
 * empirical verdict: if t_net < 0 across cells after ~14 days, the
 * generator is killed.
 */
export class ResolutionPriorV2Generator extends BaseSignal<ResolutionPriorV2Params> {
  readonly signalId = 'resolution_prior_v2';
  readonly name = 'Resolution Prior v2 (mean-reversion)';
  readonly description =
    'Within TTR ≤ 7d, fires against deviations from an SMA anchor computed on the earlier portion of the lookback window';

  protected parameters: ResolutionPriorV2Params;

  constructor(config?: Partial<ResolutionPriorV2Params>) {
    super();
    this.parameters = {
      ...DEFAULT_RESOLUTION_PRIOR_V2_PARAMS,
      ...config,
    };
  }

  getRequiredLookback(): number {
    return this.parameters.anchorWindow + this.parameters.recentWindow;
  }

  isReady(context: SignalContext): boolean {
    return (
      Boolean(context.market.endDate) &&
      context.priceBars.length >= this.getRequiredLookback()
    );
  }

  async compute(context: SignalContext): Promise<SignalOutput | null> {
    const { anchorWindow, recentWindow, cutoffDays, minZScore, minStrength, minSigma } =
      this.parameters;
    const required = anchorWindow + recentWindow;

    const endDate = context.market.endDate;
    if (!endDate) return null;
    const daysToResolution =
      (endDate.getTime() - context.currentTime.getTime()) / (1000 * 60 * 60 * 24);
    if (daysToResolution <= 0 || daysToResolution > cutoffDays) return null;

    const bars = context.priceBars;
    if (bars.length < required) return null;

    const window = bars.slice(-required);
    const anchorBars = window.slice(0, anchorWindow);
    const recentBars = window.slice(anchorWindow);
    const currentPrice = recentBars[recentBars.length - 1].close;
    if (currentPrice <= 0 || currentPrice >= 1) return null;

    const anchorCloses = anchorBars.map((b) => b.close);
    const recentCloses = recentBars.map((b) => b.close);

    const anchor = anchorCloses.reduce((a, b) => a + b, 0) / anchorCloses.length;
    if (anchor <= 0 || anchor >= 1) return null;

    const rawSigma = this.stdDev(recentCloses);
    const sigma = Math.max(rawSigma, minSigma);

    const deviation = currentPrice - anchor;
    const z = deviation / sigma;
    if (Math.abs(z) < minZScore) return null;

    // Mean-reversion: price ABOVE anchor → expect drift DOWN → SHORT.
    //                price BELOW anchor → expect drift UP   → LONG.
    const direction = z > 0 ? 'SHORT' : 'LONG';

    // Magnitude scales linearly above minZScore, saturates at z ≈ minZScore + 2.5.
    const excess = Math.abs(z) - minZScore;
    const magnitude = Math.min(1, excess / 2.5);
    if (magnitude < minStrength) return null;

    const strength = direction === 'LONG' ? magnitude : -magnitude;
    const confidence = Math.min(0.9, 0.4 + 0.5 * magnitude);

    return this.createOutput(context, direction, strength, confidence, {
      features: [currentPrice, anchor, sigma, z],
      metadata: {
        currentPrice,
        anchor,
        sigma,
        zScore: z,
        daysToResolution,
      },
    });
  }
}
