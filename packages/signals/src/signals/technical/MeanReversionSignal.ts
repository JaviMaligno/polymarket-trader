import { BaseSignal } from '../../core/base/BaseSignal.js';
import type {
  SignalContext,
  SignalOutput,
} from '../../core/types/signal.types.js';

interface MeanReversionParams extends Record<string, unknown> {
  /** Bollinger Bands period */
  bbPeriod: number;
  /** Bollinger Bands standard deviation multiplier */
  bbStdDev: number;
  /** Moving average period for mean */
  maPeriod: number;
  /** Z-score threshold for extreme deviation */
  zScoreThreshold: number;
  /** Minimum deviation from mean to trigger signal (%) */
  minDeviationPct: number;
  /** Time since resolution threshold (days) - prediction markets specific */
  resolutionProximityDays: number;
  /** Weight for Bollinger Band signal */
  bbWeight: number;
  /** Weight for Z-score signal */
  zScoreWeight: number;
  /** Weight for historical mean reversion */
  historicalWeight: number;
}

/**
 * Mean Reversion Signal
 *
 * Detects when prices have deviated significantly from their mean
 * and are likely to revert. Particularly useful for prediction markets
 * where prices tend to mean-revert after overreactions.
 *
 * Uses:
 * 1. Bollinger Bands - price relative to moving average bands
 * 2. Z-Score - statistical deviation from mean
 * 3. Historical mean reversion tendency for the market
 */
export class MeanReversionSignal extends BaseSignal {
  readonly signalId = 'mean_reversion';
  readonly name = 'Mean Reversion';
  readonly description = 'Detects overbought/oversold conditions likely to revert';

  protected parameters: MeanReversionParams = {
    bbPeriod: 20,
    bbStdDev: 2,
    maPeriod: 20,
    zScoreThreshold: 2,
    minDeviationPct: 5,
    resolutionProximityDays: 7,
    bbWeight: 0.4,
    zScoreWeight: 0.35,
    historicalWeight: 0.25,
  };

  getRequiredLookback(): number {
    return Math.max(this.parameters.bbPeriod, this.parameters.maPeriod) + 10;
  }

  async compute(context: SignalContext): Promise<SignalOutput | null> {
    if (!this.isReady(context)) {
      return null;
    }

    const params = this.parameters;
    const bars = context.priceBars;
    const closes = bars.map(b => b.close);
    const currentPrice = closes[closes.length - 1];

    // Skip if price is too close to 0 or 1 (resolved or near-certain)
    if (currentPrice < 0.05 || currentPrice > 0.95) {
      return null;
    }

    // Calculate signals
    const bbSignal = this.calculateBollingerSignal(closes, params);
    const zScoreSignal = this.calculateZScoreSignal(closes, params);
    const historicalSignal = this.calculateHistoricalReversion(closes, params);

    // Adjust for resolution proximity (prediction markets specific)
    const resolutionAdjustment = this.getResolutionProximityAdjustment(context, params);

    // Combine signals
    const combinedStrength =
      (bbSignal.strength * params.bbWeight +
        zScoreSignal.strength * params.zScoreWeight +
        historicalSignal.strength * params.historicalWeight) *
      resolutionAdjustment;

    // Calculate confidence
    const confidence = this.calculateConfidence(
      bbSignal,
      zScoreSignal,
      historicalSignal,
      currentPrice
    );

    // Mean reversion signals should be contrarian
    // Positive strength = price is too low, expect up (LONG)
    // Negative strength = price is too high, expect down (SHORT)
    const direction = this.getDirection(combinedStrength);

    // Only emit if deviation is significant
    if (Math.abs(combinedStrength) < 0.2 || confidence < 0.3) {
      return null;
    }

    return this.createOutput(context, direction, combinedStrength, confidence, {
      features: [
        bbSignal.percentB,
        bbSignal.bandwidth,
        zScoreSignal.zScore,
        historicalSignal.avgReversion,
        currentPrice,
        resolutionAdjustment,
      ],
      metadata: {
        bollingerPercentB: bbSignal.percentB,
        bandwidth: bbSignal.bandwidth,
        zScore: zScoreSignal.zScore,
        avgHistoricalReversion: historicalSignal.avgReversion,
        resolutionAdjustment,
        currentPrice,
      },
    });
  }

  /**
   * Calculate Bollinger Bands signal
   */
  private calculateBollingerSignal(
    closes: number[],
    params: MeanReversionParams
  ): { strength: number; percentB: number; bandwidth: number } {
    const { upper, middle, lower, percentB } = this.bollingerBands(
      closes,
      params.bbPeriod,
      params.bbStdDev
    );

    // Calculate bandwidth as volatility indicator
    const bandwidth = middle > 0 ? (upper - lower) / middle : 0;

    // Mean reversion signal:
    // - Below lower band (percentB < 0) = oversold, expect up
    // - Above upper band (percentB > 1) = overbought, expect down
    let strength: number;

    if (percentB <= 0) {
      // Below lower band - strong buy signal
      strength = Math.min(1, Math.abs(percentB) + 0.5);
    } else if (percentB >= 1) {
      // Above upper band - strong sell signal
      strength = -Math.min(1, (percentB - 1) + 0.5);
    } else if (percentB < 0.2) {
      // Near lower band - moderate buy
      strength = (0.2 - percentB) * 2.5;
    } else if (percentB > 0.8) {
      // Near upper band - moderate sell
      strength = -(percentB - 0.8) * 2.5;
    } else {
      // Within normal bands - no signal
      strength = 0;
    }

    return { strength, percentB, bandwidth };
  }

  /**
   * Calculate Z-score signal
   */
  private calculateZScoreSignal(
    closes: number[],
    params: MeanReversionParams
  ): { strength: number; zScore: number } {
    const mean = this.sma(closes, params.maPeriod);
    const std = this.stdDev(closes, params.maPeriod);

    if (std === 0) {
      return { strength: 0, zScore: 0 };
    }

    const currentPrice = closes[closes.length - 1];
    const zScore = (currentPrice - mean) / std;

    // Mean reversion signal based on z-score
    // High positive z-score = overbought = expect down
    // High negative z-score = oversold = expect up
    let strength: number;

    if (Math.abs(zScore) < 1) {
      // Within 1 std dev - no signal
      strength = 0;
    } else if (Math.abs(zScore) >= params.zScoreThreshold) {
      // Beyond threshold - strong signal
      strength = -Math.sign(zScore) * Math.min(1, (Math.abs(zScore) - 1) / 2);
    } else {
      // Between 1 and threshold - moderate signal
      strength = -Math.sign(zScore) * (Math.abs(zScore) - 1) / (params.zScoreThreshold - 1) * 0.5;
    }

    return { strength, zScore };
  }

  /**
   * Calculate historical mean reversion tendency
   */
  private calculateHistoricalReversion(
    closes: number[],
    params: MeanReversionParams
  ): { strength: number; avgReversion: number } {
    if (closes.length < params.maPeriod * 2) {
      return { strength: 0, avgReversion: 0 };
    }

    // Look at past deviations and how quickly they reverted
    const mean = this.sma(closes.slice(-params.maPeriod * 2), params.maPeriod);
    const reversionRates: number[] = [];

    // Analyze reversion in rolling windows
    for (let i = params.maPeriod; i < closes.length - 5; i++) {
      const windowMean = this.sma(closes.slice(i - params.maPeriod, i), params.maPeriod);
      const deviation = closes[i] - windowMean;
      const futurePrice = closes[Math.min(i + 5, closes.length - 1)];
      const futureDeviation = futurePrice - windowMean;

      // Check if it reverted (deviation reduced)
      if (Math.abs(deviation) > 0.01) {
        const reversionRate = 1 - Math.abs(futureDeviation) / Math.abs(deviation);
        reversionRates.push(reversionRate);
      }
    }

    const avgReversion = reversionRates.length > 0
      ? reversionRates.reduce((a, b) => a + b, 0) / reversionRates.length
      : 0;

    // Current deviation
    const currentPrice = closes[closes.length - 1];
    const currentDeviation = (currentPrice - mean) / mean;

    // If historical reversion is strong and we're deviated, signal reversion
    const strength = avgReversion > 0.3 && Math.abs(currentDeviation) > params.minDeviationPct / 100
      ? -Math.sign(currentDeviation) * avgReversion * Math.min(1, Math.abs(currentDeviation) * 5)
      : 0;

    return { strength, avgReversion };
  }

  /**
   * Adjust signal based on proximity to market resolution
   * Closer to resolution = more informative prices, less mean reversion
   */
  private getResolutionProximityAdjustment(
    context: SignalContext,
    params: MeanReversionParams
  ): number {
    if (!context.market.endDate) {
      return 1; // No end date, full signal
    }

    const daysToResolution =
      (context.market.endDate.getTime() - context.currentTime.getTime()) /
      (1000 * 60 * 60 * 24);

    if (daysToResolution <= 0) {
      return 0; // Market ended, no signal
    }

    if (daysToResolution < params.resolutionProximityDays) {
      // Reduce mean reversion signal as resolution approaches
      // Prices become more informative near resolution
      return Math.min(1, daysToResolution / params.resolutionProximityDays);
    }

    return 1;
  }

  /**
   * Calculate confidence
   */
  private calculateConfidence(
    bbSignal: { strength: number; percentB: number; bandwidth: number },
    zScoreSignal: { strength: number; zScore: number },
    historicalSignal: { strength: number; avgReversion: number },
    currentPrice: number
  ): number {
    // Higher confidence when signals agree
    const signals = [bbSignal.strength, zScoreSignal.strength, historicalSignal.strength];
    const nonZero = signals.filter(s => Math.abs(s) > 0.1);
    const agreement = nonZero.length > 0 &&
      nonZero.every(s => Math.sign(s) === Math.sign(nonZero[0]))
      ? 0.3
      : 0;

    // Higher confidence with stronger deviation
    const deviationStrength = Math.min(1, Math.abs(zScoreSignal.zScore) / 3);

    // Higher confidence with historical reversion
    const historicalConfidence = historicalSignal.avgReversion * 0.3;

    // Lower confidence at extreme prices (near 0 or 1)
    const priceConfidence = 1 - Math.abs(currentPrice - 0.5) * 1.5;

    return Math.min(1, agreement + deviationStrength * 0.3 + historicalConfidence + priceConfidence * 0.2);
  }
}
