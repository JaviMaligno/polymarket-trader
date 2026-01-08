import { BaseSignal } from '../../core/base/BaseSignal.js';
import type {
  SignalContext,
  SignalOutput,
  PriceBar,
} from '../../core/types/signal.types.js';

/**
 * Configuration parameters for Momentum Signal
 */
export interface MomentumSignalConfig extends Record<string, unknown> {
  /** Short-term momentum period (bars) - default: 5 */
  shortPeriod?: number;
  /** Medium-term momentum period (bars) - default: 14 */
  mediumPeriod?: number;
  /** Long-term momentum period (bars) - default: 30 */
  longPeriod?: number;
  /** RSI period - default: 14 */
  rsiPeriod?: number;
  /** RSI overbought threshold - default: 70 */
  rsiOverbought?: number;
  /** RSI oversold threshold - default: 30 */
  rsiOversold?: number;
  /** MACD fast period - default: 12 */
  macdFast?: number;
  /** MACD slow period - default: 26 */
  macdSlow?: number;
  /** MACD signal period - default: 9 */
  macdSignal?: number;
  /** Minimum volume to consider valid signal - default: 1.0 */
  minVolumeMultiplier?: number;
  /** Weight for price momentum - default: 0.35 */
  priceMomentumWeight?: number;
  /** Weight for RSI - default: 0.25 */
  rsiWeight?: number;
  /** Weight for MACD - default: 0.25 */
  macdWeight?: number;
  /** Weight for volume confirmation - default: 0.15 */
  volumeWeight?: number;
}

interface MomentumParams extends Record<string, unknown> {
  /** Short-term momentum period (bars) */
  shortPeriod: number;
  /** Medium-term momentum period (bars) */
  mediumPeriod: number;
  /** Long-term momentum period (bars) */
  longPeriod: number;
  /** RSI period */
  rsiPeriod: number;
  /** RSI overbought threshold */
  rsiOverbought: number;
  /** RSI oversold threshold */
  rsiOversold: number;
  /** MACD fast period */
  macdFast: number;
  /** MACD slow period */
  macdSlow: number;
  /** MACD signal period */
  macdSignal: number;
  /** Minimum volume to consider valid signal */
  minVolumeMultiplier: number;
  /** Weight for price momentum */
  priceMomentumWeight: number;
  /** Weight for RSI */
  rsiWeight: number;
  /** Weight for MACD */
  macdWeight: number;
  /** Weight for volume confirmation */
  volumeWeight: number;
}

/** Default parameters for Momentum Signal */
export const DEFAULT_MOMENTUM_PARAMS: MomentumParams = {
  shortPeriod: 5,
  mediumPeriod: 14,
  longPeriod: 30,
  rsiPeriod: 14,
  rsiOverbought: 70,
  rsiOversold: 30,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  minVolumeMultiplier: 1.0,
  priceMomentumWeight: 0.35,
  rsiWeight: 0.25,
  macdWeight: 0.25,
  volumeWeight: 0.15,
};

/**
 * Momentum Signal
 *
 * Detects price momentum using multiple technical indicators:
 * 1. Price momentum (rate of change across multiple timeframes)
 * 2. RSI (Relative Strength Index)
 * 3. MACD (Moving Average Convergence Divergence)
 * 4. Volume confirmation
 */
export class MomentumSignal extends BaseSignal {
  readonly signalId = 'momentum';
  readonly name = 'Momentum';
  readonly description = 'Detects price momentum using technical indicators';

  protected parameters: MomentumParams;

  /**
   * Create a new Momentum Signal
   * @param config - Optional configuration to override defaults
   */
  constructor(config?: MomentumSignalConfig) {
    super();
    this.parameters = {
      ...DEFAULT_MOMENTUM_PARAMS,
      ...config,
    };
  }

  getRequiredLookback(): number {
    const params = this.parameters;
    return Math.max(params.longPeriod, params.macdSlow) + 5;
  }

  async compute(context: SignalContext): Promise<SignalOutput | null> {
    if (!this.isReady(context)) {
      return null;
    }

    const params = this.parameters;
    const bars = context.priceBars;
    const closes = bars.map(b => b.close);
    const volumes = bars.map(b => b.volume);

    // Calculate individual momentum components
    const priceMomentum = this.calculatePriceMomentum(closes, params);
    const rsiSignal = this.calculateRsiSignal(closes, params);
    const macdSignal = this.calculateMacdSignal(closes, params);
    const volumeConfirmation = this.calculateVolumeConfirmation(volumes, closes, params);

    // Combine signals with weights
    const combinedStrength =
      priceMomentum.strength * params.priceMomentumWeight +
      rsiSignal.strength * params.rsiWeight +
      macdSignal.strength * params.macdWeight +
      volumeConfirmation.strength * params.volumeWeight;

    // Calculate confidence based on indicator agreement
    const confidence = this.calculateConfidence(
      priceMomentum,
      rsiSignal,
      macdSignal,
      volumeConfirmation
    );

    // Determine direction
    const direction = this.getDirection(combinedStrength);

    // Only emit signal if strong enough
    // Relaxed thresholds to generate more trades
    if (Math.abs(combinedStrength) < 0.05 || confidence < 0.1) {
      return null;
    }

    return this.createOutput(context, direction, combinedStrength, confidence, {
      features: [
        priceMomentum.strength,
        priceMomentum.shortTerm,
        priceMomentum.mediumTerm,
        priceMomentum.longTerm,
        rsiSignal.rsi,
        macdSignal.macd,
        macdSignal.histogram,
        volumeConfirmation.volumeRatio,
      ],
      metadata: {
        shortMomentum: priceMomentum.shortTerm,
        mediumMomentum: priceMomentum.mediumTerm,
        longMomentum: priceMomentum.longTerm,
        rsi: rsiSignal.rsi,
        macd: macdSignal.macd,
        macdSignal: macdSignal.signal,
        volumeRatio: volumeConfirmation.volumeRatio,
      },
    });
  }

  /**
   * Calculate price momentum across multiple timeframes
   */
  private calculatePriceMomentum(
    closes: number[],
    params: MomentumParams
  ): { strength: number; shortTerm: number; mediumTerm: number; longTerm: number } {
    const shortMom = this.momentum(closes, params.shortPeriod);
    const mediumMom = this.momentum(closes, params.mediumPeriod);
    const longMom = this.momentum(closes, params.longPeriod);

    // Normalize to -1 to +1 range (assuming max momentum is ~50%)
    const normalizeMax = 0.5;
    const shortNorm = Math.max(-1, Math.min(1, shortMom / normalizeMax));
    const mediumNorm = Math.max(-1, Math.min(1, mediumMom / normalizeMax));
    const longNorm = Math.max(-1, Math.min(1, longMom / normalizeMax));

    // Weight recent momentum more heavily
    const strength = shortNorm * 0.5 + mediumNorm * 0.3 + longNorm * 0.2;

    return {
      strength,
      shortTerm: shortMom,
      mediumTerm: mediumMom,
      longTerm: longMom,
    };
  }

  /**
   * Calculate RSI-based signal
   */
  private calculateRsiSignal(
    closes: number[],
    params: MomentumParams
  ): { strength: number; rsi: number } {
    const rsi = this.rsi(closes, params.rsiPeriod);

    // Convert RSI to -1 to +1 strength
    // Neutral at 50, bullish above 50, bearish below 50
    // Strong signals at overbought/oversold levels
    let strength: number;

    if (rsi > params.rsiOverbought) {
      // Overbought - might reverse, but currently bullish momentum
      strength = 0.5 + (rsi - params.rsiOverbought) / (100 - params.rsiOverbought) * 0.5;
    } else if (rsi < params.rsiOversold) {
      // Oversold - might reverse, but currently bearish momentum
      strength = -0.5 - (params.rsiOversold - rsi) / params.rsiOversold * 0.5;
    } else {
      // Neutral zone - linear scaling
      strength = (rsi - 50) / 50;
    }

    return { strength, rsi };
  }

  /**
   * Calculate MACD-based signal
   */
  private calculateMacdSignal(
    closes: number[],
    params: MomentumParams
  ): { strength: number; macd: number; signal: number; histogram: number } {
    const { macd, signal, histogram } = this.macd(
      closes,
      params.macdFast,
      params.macdSlow,
      params.macdSignal
    );

    // Normalize MACD based on price level
    const currentPrice = closes[closes.length - 1];
    const normalizedMacd = currentPrice > 0 ? macd / currentPrice : 0;
    const normalizedHistogram = currentPrice > 0 ? histogram / currentPrice : 0;

    // Strength based on MACD direction and histogram
    // Max expected normalized MACD is ~5%
    const strength = Math.max(-1, Math.min(1, normalizedMacd / 0.05));

    return { strength, macd, signal, histogram };
  }

  /**
   * Calculate volume confirmation
   */
  private calculateVolumeConfirmation(
    volumes: number[],
    closes: number[],
    params: MomentumParams
  ): { strength: number; volumeRatio: number } {
    if (volumes.length < 10) {
      return { strength: 0, volumeRatio: 1 };
    }

    // Average volume over lookback
    const avgVolume = this.sma(volumes.slice(-20), 20);
    const recentVolume = this.sma(volumes.slice(-5), 5);

    if (avgVolume === 0) {
      return { strength: 0, volumeRatio: 1 };
    }

    const volumeRatio = recentVolume / avgVolume;

    // Determine price direction
    const priceChange = closes.length >= 5
      ? (closes[closes.length - 1] - closes[closes.length - 5]) / closes[closes.length - 5]
      : 0;

    // Volume confirmation:
    // - High volume + price up = bullish confirmation
    // - High volume + price down = bearish confirmation
    // - Low volume = weak signal
    const volumeMultiplier = volumeRatio >= params.minVolumeMultiplier
      ? Math.min(2, volumeRatio)
      : volumeRatio;

    const strength = priceChange > 0
      ? Math.min(1, volumeMultiplier - 1)
      : Math.max(-1, -(volumeMultiplier - 1));

    return { strength: strength * Math.sign(priceChange), volumeRatio };
  }

  /**
   * Calculate confidence based on indicator agreement
   */
  private calculateConfidence(
    priceMom: { strength: number },
    rsiSig: { strength: number },
    macdSig: { strength: number },
    volConf: { strength: number }
  ): number {
    const signals = [priceMom.strength, rsiSig.strength, macdSig.strength];

    // Check if signals agree on direction
    const positiveCount = signals.filter(s => s > 0.1).length;
    const negativeCount = signals.filter(s => s < -0.1).length;

    // All agree = high confidence
    // Mixed signals = lower confidence
    let agreement = 0;
    if (positiveCount === 3 || negativeCount === 3) {
      agreement = 1;
    } else if (positiveCount >= 2 || negativeCount >= 2) {
      agreement = 0.7;
    } else {
      agreement = 0.3;
    }

    // Volume confirmation boosts confidence
    const volumeBonus = Math.abs(volConf.strength) > 0.2 ? 0.15 : 0;

    // Strength of signals adds confidence
    const avgStrength = signals.reduce((a, b) => a + Math.abs(b), 0) / signals.length;
    const strengthBonus = avgStrength * 0.2;

    return Math.min(1, agreement * 0.6 + strengthBonus + volumeBonus);
  }
}
