/**
 * Z-Score Volatility Filter (C3)
 *
 * Combines Z-score based entry signals with volatility filtering.
 * Detects legitimate oversold conditions vs crash scenarios.
 */

export interface ZScoreConfig {
  /** Moving average period for baseline (default: 20) */
  maPeriod: number;
  /** Z-score threshold for entry (default: -2.0) */
  entryZScore: number;
  /** Lookback period for historical volatility (default: 30) */
  volatilityLookback: number;
  /** Maximum ratio of current vol to historical vol (default: 1.5) */
  maxVolatilityRatio: number;
}

export interface VolatilityAnalysis {
  currentVolatility: number;
  historicalVolatility: number;
  volatilityRatio: number;
  isHighVolatility: boolean;
}

export interface ZScoreResult {
  zScore: number;
  price: number;
  movingAverage: number;
  standardDeviation: number;
  volatility: VolatilityAnalysis;
}

export interface ZScoreFilterDecision {
  allowed: boolean;
  sizeMultiplier: number;
  reason: string;
  zScoreResult?: ZScoreResult;
}

const DEFAULT_CONFIG: ZScoreConfig = {
  maPeriod: 20,
  entryZScore: -2.0,
  volatilityLookback: 30,
  maxVolatilityRatio: 1.5,
};

// Optimizable ranges
export const OPTIMIZABLE_RANGES = {
  maPeriod: [15, 20, 30],
  entryZScore: [-1.5, -2.0, -2.5],
  maxVolatilityRatio: [1.3, 1.5, 2.0],
};

export class ZScoreVolatilityFilter {
  private config: ZScoreConfig;

  constructor(config: Partial<ZScoreConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Calculate Z-score and volatility metrics
   */
  analyze(prices: number[]): ZScoreResult | null {
    const minBars = Math.max(this.config.maPeriod, this.config.volatilityLookback);
    if (prices.length < minBars) {
      return null;
    }

    const currentPrice = prices[prices.length - 1];

    // Calculate moving average
    const maData = prices.slice(-this.config.maPeriod);
    const movingAverage = maData.reduce((a, b) => a + b, 0) / maData.length;

    // Calculate standard deviation for Z-score
    const variance = maData.reduce((sum, p) => sum + Math.pow(p - movingAverage, 2), 0) / maData.length;
    const standardDeviation = Math.sqrt(variance);

    // Calculate Z-score
    const zScore = standardDeviation > 0
      ? (currentPrice - movingAverage) / standardDeviation
      : 0;

    // Volatility analysis
    const volatility = this.analyzeVolatility(prices);

    return {
      zScore,
      price: currentPrice,
      movingAverage,
      standardDeviation,
      volatility,
    };
  }

  /**
   * Analyze volatility: compare recent vs historical
   */
  private analyzeVolatility(prices: number[]): VolatilityAnalysis {
    // Calculate returns
    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      if (prices[i - 1] !== 0) {
        returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
      }
    }

    // Recent volatility (last 10 bars)
    const recentReturns = returns.slice(-10);
    const currentVolatility = this.standardDeviation(recentReturns);

    // Historical volatility
    const historicalReturns = returns.slice(-this.config.volatilityLookback);
    const historicalVolatility = this.standardDeviation(historicalReturns);

    // Ratio
    const volatilityRatio = historicalVolatility > 0
      ? currentVolatility / historicalVolatility
      : 1;

    return {
      currentVolatility,
      historicalVolatility,
      volatilityRatio,
      isHighVolatility: volatilityRatio > this.config.maxVolatilityRatio,
    };
  }

  /**
   * Calculate standard deviation
   */
  private standardDeviation(values: number[]): number {
    if (values.length === 0) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
    return Math.sqrt(variance);
  }

  /**
   * Check if a mean reversion BUY is allowed based on Z-score and volatility
   */
  shouldAllowMeanReversionBuy(prices: number[]): ZScoreFilterDecision {
    const result = this.analyze(prices);

    if (!result) {
      return {
        allowed: true,
        sizeMultiplier: 0.5,
        reason: 'Insufficient data for Z-score analysis, allowing with reduced size',
      };
    }

    const { zScore, volatility } = result;

    // Case 1: Strongly oversold (Z < entry threshold)
    if (zScore <= this.config.entryZScore) {
      // But check volatility
      if (volatility.isHighVolatility) {
        return {
          allowed: false,
          sizeMultiplier: 0,
          reason: `Z-score ${zScore.toFixed(2)} oversold but volatility ${volatility.volatilityRatio.toFixed(2)}x too high - crash scenario`,
          zScoreResult: result,
        };
      }

      return {
        allowed: true,
        sizeMultiplier: 1.0,
        reason: `Z-score ${zScore.toFixed(2)} oversold with normal volatility - good entry`,
        zScoreResult: result,
      };
    }

    // Case 2: Moderately oversold (Z between -1 and entry threshold)
    if (zScore > this.config.entryZScore && zScore <= -1) {
      if (volatility.isHighVolatility) {
        return {
          allowed: true,
          sizeMultiplier: 0.25,
          reason: `Z-score ${zScore.toFixed(2)} moderately oversold but high volatility - very small size`,
          zScoreResult: result,
        };
      }

      return {
        allowed: true,
        sizeMultiplier: 0.5,
        reason: `Z-score ${zScore.toFixed(2)} moderately oversold - reduced size`,
        zScoreResult: result,
      };
    }

    // Case 3: Not oversold
    return {
      allowed: true,
      sizeMultiplier: 1.0,
      reason: `Z-score ${zScore.toFixed(2)} in normal range`,
      zScoreResult: result,
    };
  }

  /**
   * Check if volatility is legitimate (not a crash)
   */
  isLegitimateVolatility(prices: number[]): boolean {
    const result = this.analyze(prices);
    if (!result) return true;  // Assume legitimate if we can't analyze
    return !result.volatility.isHighVolatility;
  }

  /**
   * Get volatility metrics without full decision
   */
  getVolatilityMetrics(prices: number[]): VolatilityAnalysis | null {
    const result = this.analyze(prices);
    return result?.volatility ?? null;
  }

  /**
   * Get current configuration
   */
  getConfig(): ZScoreConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<ZScoreConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get optimizable parameter ranges
   */
  static getOptimizableRanges(): typeof OPTIMIZABLE_RANGES {
    return OPTIMIZABLE_RANGES;
  }
}
