/**
 * RSI Momentum Filter (C2)
 *
 * Fallback filter when insufficient data for Hurst calculation.
 * Uses RSI with momentum confirmation to avoid buying into falling markets.
 */

export interface RSIConfig {
  /** RSI calculation period (default: 14) */
  period: number;
  /** RSI level considered oversold (default: 30) */
  oversoldThreshold: number;
  /** RSI level considered overbought (default: 70) */
  overboughtThreshold: number;
  /** Number of bars to confirm momentum direction (default: 3) */
  momentumBars: number;
}

export interface RSIResult {
  rsi: number;
  isOversold: boolean;
  isOverbought: boolean;
  momentum: 'rising' | 'falling' | 'neutral';
  rsiHistory: number[];
}

export interface RSIFilterDecision {
  allowed: boolean;
  sizeMultiplier: number;
  reason: string;
  rsiResult?: RSIResult;
}

const DEFAULT_CONFIG: RSIConfig = {
  period: 14,
  oversoldThreshold: 30,
  overboughtThreshold: 70,
  momentumBars: 3,
};

// Optimizable ranges
export const OPTIMIZABLE_RANGES = {
  period: [10, 14, 20],
  oversoldThreshold: [25, 30, 35],
  overboughtThreshold: [65, 70, 75],
  momentumBars: [2, 3, 5],
};

export class RSIMomentumFilter {
  private config: RSIConfig;

  constructor(config: Partial<RSIConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Calculate RSI for a price series
   */
  calculateRSI(prices: number[]): RSIResult | null {
    const minBars = this.config.period + this.config.momentumBars + 1;
    if (prices.length < minBars) {
      return null;
    }

    // Calculate price changes
    const changes: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      changes.push(prices[i] - prices[i - 1]);
    }

    // Calculate RSI for the last several bars to track momentum
    const rsiHistory: number[] = [];
    const historyLength = this.config.momentumBars + 1;

    for (let offset = historyLength - 1; offset >= 0; offset--) {
      const endIdx = changes.length - offset;
      if (endIdx < this.config.period) continue;

      const relevantChanges = changes.slice(endIdx - this.config.period, endIdx);
      const rsi = this.computeRSI(relevantChanges);
      rsiHistory.push(rsi);
    }

    if (rsiHistory.length === 0) {
      return null;
    }

    const currentRSI = rsiHistory[rsiHistory.length - 1];

    // Determine momentum from RSI trend
    const momentum = this.determineMomentum(rsiHistory);

    return {
      rsi: currentRSI,
      isOversold: currentRSI < this.config.oversoldThreshold,
      isOverbought: currentRSI > this.config.overboughtThreshold,
      momentum,
      rsiHistory,
    };
  }

  /**
   * Compute RSI value from price changes
   */
  private computeRSI(changes: number[]): number {
    let gains = 0;
    let losses = 0;

    for (const change of changes) {
      if (change > 0) {
        gains += change;
      } else {
        losses += Math.abs(change);
      }
    }

    const avgGain = gains / changes.length;
    const avgLoss = losses / changes.length;

    if (avgLoss === 0) {
      return 100;
    }

    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  /**
   * Determine RSI momentum direction
   */
  private determineMomentum(rsiHistory: number[]): 'rising' | 'falling' | 'neutral' {
    if (rsiHistory.length < 2) {
      return 'neutral';
    }

    // Count rising vs falling bars
    let rising = 0;
    let falling = 0;

    for (let i = 1; i < rsiHistory.length; i++) {
      const diff = rsiHistory[i] - rsiHistory[i - 1];
      if (diff > 0.5) rising++;
      else if (diff < -0.5) falling++;
    }

    if (rising > falling) return 'rising';
    if (falling > rising) return 'falling';
    return 'neutral';
  }

  /**
   * Check if a mean reversion BUY signal should be allowed
   */
  shouldAllowMeanReversionBuy(prices: number[]): RSIFilterDecision {
    const rsiResult = this.calculateRSI(prices);

    if (!rsiResult) {
      return {
        allowed: true,
        sizeMultiplier: 0.5,
        reason: 'Insufficient data for RSI, allowing with reduced size',
      };
    }

    // Ideal: Oversold + RSI rising (reversal starting)
    if (rsiResult.isOversold && rsiResult.momentum === 'rising') {
      return {
        allowed: true,
        sizeMultiplier: 1.0,
        reason: `RSI ${rsiResult.rsi.toFixed(1)} oversold and rising - reversal starting`,
        rsiResult,
      };
    }

    // Risky: Oversold but RSI still falling (catching falling knife)
    if (rsiResult.isOversold && rsiResult.momentum === 'falling') {
      return {
        allowed: false,
        sizeMultiplier: 0,
        reason: `RSI ${rsiResult.rsi.toFixed(1)} oversold but still falling - avoid falling knife`,
        rsiResult,
      };
    }

    // Moderate: Oversold with neutral momentum
    if (rsiResult.isOversold && rsiResult.momentum === 'neutral') {
      return {
        allowed: true,
        sizeMultiplier: 0.5,
        reason: `RSI ${rsiResult.rsi.toFixed(1)} oversold with neutral momentum - reduced size`,
        rsiResult,
      };
    }

    // Not oversold but approaching (30-40 range)
    if (rsiResult.rsi >= this.config.oversoldThreshold && rsiResult.rsi < 40) {
      if (rsiResult.momentum === 'rising') {
        return {
          allowed: true,
          sizeMultiplier: 0.75,
          reason: `RSI ${rsiResult.rsi.toFixed(1)} approaching oversold and rising`,
          rsiResult,
        };
      }
      return {
        allowed: true,
        sizeMultiplier: 0.5,
        reason: `RSI ${rsiResult.rsi.toFixed(1)} approaching oversold`,
        rsiResult,
      };
    }

    // RSI in normal range - allow with standard size
    return {
      allowed: true,
      sizeMultiplier: 1.0,
      reason: `RSI ${rsiResult.rsi.toFixed(1)} in normal range`,
      rsiResult,
    };
  }

  /**
   * Check if a mean reversion SELL signal should be allowed
   */
  shouldAllowMeanReversionSell(prices: number[]): RSIFilterDecision {
    const rsiResult = this.calculateRSI(prices);

    if (!rsiResult) {
      return {
        allowed: true,
        sizeMultiplier: 0.5,
        reason: 'Insufficient data for RSI, allowing with reduced size',
      };
    }

    // Ideal: Overbought + RSI falling (reversal starting)
    if (rsiResult.isOverbought && rsiResult.momentum === 'falling') {
      return {
        allowed: true,
        sizeMultiplier: 1.0,
        reason: `RSI ${rsiResult.rsi.toFixed(1)} overbought and falling - reversal starting`,
        rsiResult,
      };
    }

    // Risky: Overbought but RSI still rising
    if (rsiResult.isOverbought && rsiResult.momentum === 'rising') {
      return {
        allowed: false,
        sizeMultiplier: 0,
        reason: `RSI ${rsiResult.rsi.toFixed(1)} overbought but still rising - momentum too strong`,
        rsiResult,
      };
    }

    // Normal cases
    return {
      allowed: true,
      sizeMultiplier: 1.0,
      reason: `RSI ${rsiResult.rsi.toFixed(1)} allows sell`,
      rsiResult,
    };
  }

  /**
   * Get current configuration
   */
  getConfig(): RSIConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<RSIConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get optimizable parameter ranges
   */
  static getOptimizableRanges(): typeof OPTIMIZABLE_RANGES {
    return OPTIMIZABLE_RANGES;
  }
}
