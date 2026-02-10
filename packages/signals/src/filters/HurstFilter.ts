/**
 * Hurst Exponent Filter (C1)
 *
 * Detects market regime (trending vs mean-reverting) using Hurst exponent.
 * - H < 0.5: Mean-reverting (good for mean reversion signals)
 * - H = 0.5: Random walk (unpredictable)
 * - H > 0.5: Trending (bad for mean reversion, good for momentum)
 */

export interface HurstConfig {
  /** Minimum price bars required for calculation (default: 50) */
  minBars: number;
  /** Window size for Hurst calculation (default: 30) */
  windowSize: number;
  /** Threshold below which mean reversion is allowed (default: 0.45) */
  meanReversionThreshold: number;
  /** Threshold above which market is considered trending (default: 0.55) */
  trendingThreshold: number;
}

export type MarketRegime = 'mean_reverting' | 'random_walk' | 'trending';

export interface HurstResult {
  hurstExponent: number;
  regime: MarketRegime;
  confidence: number;
  barsUsed: number;
}

export interface FilterDecision {
  allowed: boolean;
  sizeMultiplier: number;
  reason: string;
  hurstResult?: HurstResult;
}

const DEFAULT_CONFIG: HurstConfig = {
  minBars: 50,
  windowSize: 30,
  meanReversionThreshold: 0.45,
  trendingThreshold: 0.55,
};

// Optimizable ranges
export const OPTIMIZABLE_RANGES = {
  windowSize: [20, 30, 40],
  meanReversionThreshold: [0.40, 0.45, 0.50],
  trendingThreshold: [0.55, 0.60, 0.65],
};

export class HurstFilter {
  private config: HurstConfig;

  constructor(config: Partial<HurstConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Calculate Hurst exponent using R/S (Rescaled Range) analysis
   */
  calculateHurst(prices: number[]): HurstResult | null {
    if (prices.length < this.config.minBars) {
      return null;
    }

    // Use the most recent windowSize prices
    const data = prices.slice(-this.config.windowSize);

    // Calculate returns
    const returns: number[] = [];
    for (let i = 1; i < data.length; i++) {
      if (data[i - 1] !== 0) {
        returns.push(Math.log(data[i] / data[i - 1]));
      }
    }

    if (returns.length < 10) {
      return null;
    }

    // R/S analysis with multiple sub-periods
    const rsValues: Array<{ n: number; rs: number }> = [];
    const subPeriods = [8, 12, 16, 20, 24];

    for (const n of subPeriods) {
      if (n > returns.length) continue;

      const numSegments = Math.floor(returns.length / n);
      if (numSegments === 0) continue;

      let totalRS = 0;
      let validSegments = 0;

      for (let seg = 0; seg < numSegments; seg++) {
        const segment = returns.slice(seg * n, (seg + 1) * n);
        const rs = this.calculateRS(segment);
        if (rs !== null && rs > 0) {
          totalRS += rs;
          validSegments++;
        }
      }

      if (validSegments > 0) {
        rsValues.push({ n, rs: totalRS / validSegments });
      }
    }

    if (rsValues.length < 2) {
      return null;
    }

    // Linear regression of log(R/S) vs log(n) to get Hurst exponent
    const logN = rsValues.map(v => Math.log(v.n));
    const logRS = rsValues.map(v => Math.log(v.rs));

    const { slope, r2 } = this.linearRegression(logN, logRS);

    // Hurst exponent is the slope
    const hurst = Math.max(0, Math.min(1, slope));

    // Determine regime
    let regime: MarketRegime;
    if (hurst < this.config.meanReversionThreshold) {
      regime = 'mean_reverting';
    } else if (hurst > this.config.trendingThreshold) {
      regime = 'trending';
    } else {
      regime = 'random_walk';
    }

    return {
      hurstExponent: hurst,
      regime,
      confidence: r2,
      barsUsed: this.config.windowSize,
    };
  }

  /**
   * Calculate R/S (Rescaled Range) for a segment
   */
  private calculateRS(segment: number[]): number | null {
    const n = segment.length;
    if (n < 2) return null;

    // Mean
    const mean = segment.reduce((a, b) => a + b, 0) / n;

    // Cumulative deviation from mean
    const cumDev: number[] = [];
    let cumSum = 0;
    for (const val of segment) {
      cumSum += val - mean;
      cumDev.push(cumSum);
    }

    // Range
    const range = Math.max(...cumDev) - Math.min(...cumDev);

    // Standard deviation
    const variance = segment.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / n;
    const std = Math.sqrt(variance);

    if (std === 0) return null;

    // R/S
    return range / std;
  }

  /**
   * Simple linear regression
   */
  private linearRegression(x: number[], y: number[]): { slope: number; r2: number } {
    const n = x.length;
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
    const sumY2 = y.reduce((sum, yi) => sum + yi * yi, 0);

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

    // R-squared
    const meanY = sumY / n;
    const ssTotal = y.reduce((sum, yi) => sum + Math.pow(yi - meanY, 2), 0);
    const ssResidual = y.reduce((sum, yi, i) => {
      const predicted = slope * x[i] + (meanY - slope * (sumX / n));
      return sum + Math.pow(yi - predicted, 2);
    }, 0);
    const r2 = ssTotal > 0 ? 1 - ssResidual / ssTotal : 0;

    return { slope, r2: Math.max(0, Math.min(1, r2)) };
  }

  /**
   * Check if a mean reversion signal should be allowed based on market regime
   */
  shouldAllowMeanReversion(prices: number[]): FilterDecision {
    if (prices.length < this.config.minBars) {
      return {
        allowed: true,
        sizeMultiplier: 0.5,  // Reduce size when insufficient data
        reason: `Insufficient data (${prices.length}/${this.config.minBars} bars), allowing with reduced size`,
      };
    }

    const hurstResult = this.calculateHurst(prices);

    if (!hurstResult) {
      return {
        allowed: true,
        sizeMultiplier: 0.5,
        reason: 'Could not calculate Hurst exponent, allowing with reduced size',
      };
    }

    switch (hurstResult.regime) {
      case 'mean_reverting':
        return {
          allowed: true,
          sizeMultiplier: 1.0,
          reason: `Market is mean-reverting (H=${hurstResult.hurstExponent.toFixed(3)})`,
          hurstResult,
        };

      case 'random_walk':
        return {
          allowed: true,
          sizeMultiplier: 0.5,
          reason: `Market is random walk (H=${hurstResult.hurstExponent.toFixed(3)}), reducing size`,
          hurstResult,
        };

      case 'trending':
        return {
          allowed: false,
          sizeMultiplier: 0,
          reason: `Market is trending (H=${hurstResult.hurstExponent.toFixed(3)}), blocking mean reversion`,
          hurstResult,
        };
    }
  }

  /**
   * Check if a momentum signal should be allowed based on market regime
   */
  shouldAllowMomentum(prices: number[]): FilterDecision {
    if (prices.length < this.config.minBars) {
      return {
        allowed: true,
        sizeMultiplier: 0.5,
        reason: `Insufficient data (${prices.length}/${this.config.minBars} bars), allowing with reduced size`,
      };
    }

    const hurstResult = this.calculateHurst(prices);

    if (!hurstResult) {
      return {
        allowed: true,
        sizeMultiplier: 0.5,
        reason: 'Could not calculate Hurst exponent, allowing with reduced size',
      };
    }

    switch (hurstResult.regime) {
      case 'trending':
        return {
          allowed: true,
          sizeMultiplier: 1.0,
          reason: `Market is trending (H=${hurstResult.hurstExponent.toFixed(3)})`,
          hurstResult,
        };

      case 'random_walk':
        return {
          allowed: true,
          sizeMultiplier: 0.5,
          reason: `Market is random walk (H=${hurstResult.hurstExponent.toFixed(3)}), reducing size`,
          hurstResult,
        };

      case 'mean_reverting':
        return {
          allowed: false,
          sizeMultiplier: 0,
          reason: `Market is mean-reverting (H=${hurstResult.hurstExponent.toFixed(3)}), blocking momentum`,
          hurstResult,
        };
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): HurstConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<HurstConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get optimizable parameter ranges
   */
  static getOptimizableRanges(): typeof OPTIMIZABLE_RANGES {
    return OPTIMIZABLE_RANGES;
  }
}
