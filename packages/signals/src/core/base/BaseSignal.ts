import { pino, Logger } from 'pino';
import type {
  ISignal,
  SignalContext,
  SignalOutput,
  SignalDirection,
} from '../types/signal.types.js';

/**
 * Abstract base class for all trading signals.
 * Provides common functionality like logging, parameter management,
 * and output generation.
 */
export abstract class BaseSignal<TParams extends Record<string, unknown> = Record<string, unknown>> implements ISignal {
  abstract readonly signalId: string;
  abstract readonly name: string;
  abstract readonly description: string;

  protected logger: Logger;
  protected parameters: TParams = {} as TParams;

  /** Default TTL for signals (5 minutes) */
  protected defaultTtlMs = 5 * 60 * 1000;

  constructor() {
    this.logger = pino({ name: `signal:${this.constructor.name}` });
  }

  /**
   * Compute the signal - must be implemented by subclasses
   */
  abstract compute(context: SignalContext): Promise<SignalOutput | null>;

  /**
   * Get the minimum number of price bars required
   */
  abstract getRequiredLookback(): number;

  /**
   * Check if signal has enough data to compute
   */
  isReady(context: SignalContext): boolean {
    const required = this.getRequiredLookback();
    const available = context.priceBars.length;

    if (available < required) {
      this.logger.debug(
        { required, available, marketId: context.market.id },
        'Insufficient data for signal computation'
      );
      return false;
    }

    return true;
  }

  /**
   * Get current parameters
   */
  getParameters(): Record<string, unknown> {
    return { ...this.parameters };
  }

  /**
   * Update parameters
   */
  setParameters(params: Record<string, unknown>): void {
    this.parameters = { ...this.parameters, ...params };
    this.logger.info({ params }, 'Parameters updated');
  }

  /**
   * Create a standardized signal output
   */
  protected createOutput(
    context: SignalContext,
    direction: SignalDirection,
    strength: number,
    confidence: number,
    options: {
      tokenId?: string;
      ttlMs?: number;
      features?: number[];
      metadata?: Record<string, unknown>;
    } = {}
  ): SignalOutput {
    // Clamp values to valid ranges
    const clampedStrength = Math.max(-1, Math.min(1, strength));
    const clampedConfidence = Math.max(0, Math.min(1, confidence));

    return {
      signalId: this.signalId,
      marketId: context.market.id,
      tokenId: options.tokenId || context.market.tokenIdYes,
      direction,
      strength: clampedStrength,
      confidence: clampedConfidence,
      timestamp: context.currentTime,
      ttlMs: options.ttlMs || this.defaultTtlMs,
      features: options.features,
      metadata: options.metadata,
    };
  }

  /**
   * Calculate simple moving average
   */
  protected sma(values: number[], period: number): number {
    if (values.length < period) {
      return values.reduce((a, b) => a + b, 0) / values.length;
    }

    const slice = values.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
  }

  /**
   * Calculate exponential moving average
   */
  protected ema(values: number[], period: number): number {
    if (values.length === 0) return 0;
    if (values.length === 1) return values[0];

    const multiplier = 2 / (period + 1);
    let ema = values[0];

    for (let i = 1; i < values.length; i++) {
      ema = (values[i] - ema) * multiplier + ema;
    }

    return ema;
  }

  /**
   * Calculate standard deviation
   */
  protected stdDev(values: number[], period?: number): number {
    const slice = period ? values.slice(-period) : values;
    if (slice.length === 0) return 0;

    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const squaredDiffs = slice.map(v => Math.pow(v - mean, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / slice.length;

    return Math.sqrt(variance);
  }

  /**
   * Calculate RSI (Relative Strength Index)
   */
  protected rsi(closes: number[], period: number = 14): number {
    if (closes.length < period + 1) return 50; // Neutral

    const changes: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      changes.push(closes[i] - closes[i - 1]);
    }

    const gains = changes.map(c => (c > 0 ? c : 0));
    const losses = changes.map(c => (c < 0 ? Math.abs(c) : 0));

    const avgGain = this.sma(gains.slice(-period), period);
    const avgLoss = this.sma(losses.slice(-period), period);

    if (avgLoss === 0) return 100;

    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  /**
   * Calculate MACD
   */
  protected macd(
    closes: number[],
    fastPeriod: number = 12,
    slowPeriod: number = 26,
    signalPeriod: number = 9
  ): { macd: number; signal: number; histogram: number } {
    const fastEma = this.ema(closes, fastPeriod);
    const slowEma = this.ema(closes, slowPeriod);
    const macdLine = fastEma - slowEma;

    // For signal line, we'd need historical MACD values
    // Simplified: use current MACD as approximation
    const signalLine = macdLine * 0.9; // Rough approximation
    const histogram = macdLine - signalLine;

    return { macd: macdLine, signal: signalLine, histogram };
  }

  /**
   * Calculate Bollinger Bands
   */
  protected bollingerBands(
    closes: number[],
    period: number = 20,
    stdDevMultiplier: number = 2
  ): { upper: number; middle: number; lower: number; percentB: number } {
    const middle = this.sma(closes, period);
    const std = this.stdDev(closes, period);
    const upper = middle + stdDevMultiplier * std;
    const lower = middle - stdDevMultiplier * std;

    const currentPrice = closes[closes.length - 1] || middle;
    const percentB = std !== 0 ? (currentPrice - lower) / (upper - lower) : 0.5;

    return { upper, middle, lower, percentB };
  }

  /**
   * Calculate price momentum (rate of change)
   */
  protected momentum(values: number[], period: number): number {
    if (values.length < period + 1) return 0;

    const current = values[values.length - 1];
    const past = values[values.length - 1 - period];

    if (past === 0) return 0;

    return (current - past) / past;
  }

  /**
   * Calculate volume-weighted average price
   */
  protected vwap(
    bars: { close: number; volume: number }[]
  ): number {
    if (bars.length === 0) return 0;

    let sumPriceVolume = 0;
    let sumVolume = 0;

    for (const bar of bars) {
      sumPriceVolume += bar.close * bar.volume;
      sumVolume += bar.volume;
    }

    return sumVolume > 0 ? sumPriceVolume / sumVolume : 0;
  }

  /**
   * Normalize a value to 0-1 range using min-max scaling
   */
  protected normalize(value: number, min: number, max: number): number {
    if (max === min) return 0.5;
    return (value - min) / (max - min);
  }

  /**
   * Convert confidence to a trading direction
   */
  protected getDirection(strength: number, threshold: number = 0.1): SignalDirection {
    if (strength > threshold) return 'LONG';
    if (strength < -threshold) return 'SHORT';
    return 'NEUTRAL';
  }
}
