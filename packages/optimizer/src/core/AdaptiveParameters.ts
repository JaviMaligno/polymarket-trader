/**
 * Adaptive Parameters
 *
 * Manages different parameter sets for different market regimes.
 * Instead of one-size-fits-all parameters, this module allows
 * the strategy to adapt based on detected market conditions.
 */

import pino from 'pino';
import type { ParameterValues } from './ParameterSpace.js';
import type { BacktestMetrics } from './ObjectiveFunctions.js';

const logger = pino({ name: 'AdaptiveParameters' });

// ============================================
// Types
// ============================================

export type MarketRegimeType =
  | 'bull_low_vol'
  | 'bull_high_vol'
  | 'bear_low_vol'
  | 'bear_high_vol'
  | 'neutral'
  | 'crisis';

export interface AdaptiveConfig {
  /** Regime detection method */
  regimeDetection: 'volatility_trend' | 'hmm' | 'manual';
  /** Volatility lookback period (days) */
  volatilityLookback: number;
  /** Trend lookback period (days) */
  trendLookback: number;
  /** Volatility threshold for high/low classification */
  volatilityThreshold: number;
  /** Trend threshold for bull/bear classification */
  trendThreshold: number;
  /** Minimum confidence to switch regimes */
  minRegimeConfidence: number;
  /** Transition smoothing (0 = instant, 1 = full interpolation) */
  transitionSmoothing: number;
}

export interface RegimeState {
  /** Current regime */
  current: MarketRegimeType;
  /** Confidence in current regime (0-1) */
  confidence: number;
  /** Time in current regime (minutes) */
  duration: number;
  /** Recent regime history */
  history: Array<{ regime: MarketRegimeType; timestamp: Date; confidence: number }>;
  /** Regime distribution over lookback */
  distribution: Record<MarketRegimeType, number>;
}

export interface RegimeParameters {
  /** Regime type */
  regime: MarketRegimeType;
  /** Optimized parameters for this regime */
  params: Record<string, number>;
  /** Backtest metrics in this regime */
  metrics: BacktestMetrics | null;
  /** Number of data points in this regime */
  sampleSize: number;
  /** Confidence in these parameters */
  confidence: number;
}

export interface AdaptiveParameterSet {
  /** Parameters per regime */
  regimeParams: Map<MarketRegimeType, RegimeParameters>;
  /** Fallback parameters (when regime is uncertain) */
  fallbackParams: Record<string, number>;
  /** Regime transition matrix (probability of switching) */
  transitionMatrix: Record<MarketRegimeType, Record<MarketRegimeType, number>>;
  /** Overall assessment */
  assessment: AdaptiveAssessment;
}

export interface AdaptiveAssessment {
  /** Does regime-adaptive strategy outperform static? */
  adapiveOutperformsStatic: boolean;
  /** Improvement percentage */
  improvementPct: number;
  /** Regimes with strongest signal */
  strongestRegimes: MarketRegimeType[];
  /** Regimes with no edge */
  noEdgeRegimes: MarketRegimeType[];
  /** Recommendation */
  recommendation: string;
}

export interface MarketSnapshot {
  timestamp: Date;
  price: number;
  volume: number;
  volatility: number;
  trend: number;
}

// ============================================
// Regime Detector
// ============================================

export class AdaptiveRegimeDetector {
  private config: AdaptiveConfig;
  private priceHistory: number[] = [];
  private currentRegime: MarketRegimeType = 'neutral';
  private regimeHistory: Array<{ regime: MarketRegimeType; timestamp: Date; confidence: number }> = [];

  constructor(config?: Partial<AdaptiveConfig>) {
    this.config = {
      regimeDetection: config?.regimeDetection ?? 'volatility_trend',
      volatilityLookback: config?.volatilityLookback ?? 20,
      trendLookback: config?.trendLookback ?? 10,
      volatilityThreshold: config?.volatilityThreshold ?? 0.02,
      trendThreshold: config?.trendThreshold ?? 0.01,
      minRegimeConfidence: config?.minRegimeConfidence ?? 0.6,
      transitionSmoothing: config?.transitionSmoothing ?? 0.3,
    };
  }

  /**
   * Detect current market regime from price data
   */
  detect(prices: number[]): RegimeState {
    this.priceHistory = prices;

    if (prices.length < Math.max(this.config.volatilityLookback, this.config.trendLookback) + 1) {
      return this.neutralState();
    }

    // Calculate volatility (std of returns)
    const returns = [];
    for (let i = 1; i < prices.length; i++) {
      returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
    }

    const recentReturns = returns.slice(-this.config.volatilityLookback);
    const volatility = this.std(recentReturns);

    // Calculate trend (linear regression slope of prices)
    const recentPrices = prices.slice(-this.config.trendLookback);
    const trend = this.calculateTrend(recentPrices);

    // Classify regime
    const isHighVol = volatility > this.config.volatilityThreshold;
    const isBull = trend > this.config.trendThreshold;
    const isBear = trend < -this.config.trendThreshold;

    let regime: MarketRegimeType;
    let confidence: number;

    if (isBull && isHighVol) {
      regime = 'bull_high_vol';
      confidence = Math.min(1, (Math.abs(trend) / this.config.trendThreshold) * 0.5 +
        (volatility / this.config.volatilityThreshold) * 0.5);
    } else if (isBull && !isHighVol) {
      regime = 'bull_low_vol';
      confidence = Math.min(1, Math.abs(trend) / this.config.trendThreshold);
    } else if (isBear && isHighVol) {
      regime = 'bear_high_vol';
      confidence = Math.min(1, (Math.abs(trend) / this.config.trendThreshold) * 0.5 +
        (volatility / this.config.volatilityThreshold) * 0.5);
    } else if (isBear && !isHighVol) {
      regime = 'bear_low_vol';
      confidence = Math.min(1, Math.abs(trend) / this.config.trendThreshold);
    } else {
      regime = 'neutral';
      confidence = 1 - Math.abs(trend) / this.config.trendThreshold;
    }

    // Crisis detection: very high vol + large negative trend
    if (volatility > this.config.volatilityThreshold * 3 && trend < -this.config.trendThreshold * 2) {
      regime = 'crisis';
      confidence = 0.9;
    }

    // Apply smoothing - don't switch too fast
    if (regime !== this.currentRegime && confidence < this.config.minRegimeConfidence) {
      regime = this.currentRegime;
    }

    this.currentRegime = regime;
    const entry = { regime, timestamp: new Date(), confidence };
    this.regimeHistory.push(entry);

    // Keep only last 100 entries
    if (this.regimeHistory.length > 100) {
      this.regimeHistory = this.regimeHistory.slice(-100);
    }

    // Calculate distribution
    const distribution = this.calculateDistribution();

    return {
      current: regime,
      confidence,
      duration: this.calculateDuration(regime),
      history: this.regimeHistory.slice(-20),
      distribution,
    };
  }

  /**
   * Get parameters for current regime with smooth blending
   */
  getAdaptiveParams(
    regimeParams: Map<MarketRegimeType, RegimeParameters>,
    fallbackParams: Record<string, number>,
    currentState: RegimeState
  ): Record<string, number> {
    const currentParams = regimeParams.get(currentState.current)?.params;

    if (!currentParams || currentState.confidence < this.config.minRegimeConfidence) {
      return { ...fallbackParams };
    }

    // If smoothing is enabled, blend with fallback
    if (this.config.transitionSmoothing > 0) {
      const alpha = currentState.confidence * (1 - this.config.transitionSmoothing);
      return this.blendParams(currentParams, fallbackParams, alpha);
    }

    return { ...currentParams };
  }

  /**
   * Blend two parameter sets
   */
  private blendParams(
    primary: Record<string, number>,
    secondary: Record<string, number>,
    alpha: number
  ): Record<string, number> {
    const result: Record<string, number> = {};
    const allKeys = new Set([...Object.keys(primary), ...Object.keys(secondary)]);

    for (const key of allKeys) {
      const p = primary[key] ?? secondary[key] ?? 0;
      const s = secondary[key] ?? primary[key] ?? 0;
      result[key] = alpha * p + (1 - alpha) * s;
    }

    return result;
  }

  /**
   * Calculate trend using linear regression
   */
  private calculateTrend(prices: number[]): number {
    const n = prices.length;
    if (n < 2) return 0;

    const xMean = (n - 1) / 2;
    const yMean = this.mean(prices);

    let numerator = 0;
    let denominator = 0;

    for (let i = 0; i < n; i++) {
      numerator += (i - xMean) * (prices[i] - yMean);
      denominator += (i - xMean) ** 2;
    }

    // Normalize by price level
    const slope = denominator > 0 ? numerator / denominator : 0;
    return yMean > 0 ? slope / yMean : 0;
  }

  /**
   * Calculate regime duration in minutes
   */
  private calculateDuration(regime: MarketRegimeType): number {
    let duration = 0;
    for (let i = this.regimeHistory.length - 1; i >= 0; i--) {
      if (this.regimeHistory[i].regime === regime) {
        duration++;
      } else {
        break;
      }
    }
    return duration;
  }

  /**
   * Calculate regime distribution over history
   */
  private calculateDistribution(): Record<MarketRegimeType, number> {
    const dist: Record<MarketRegimeType, number> = {
      bull_low_vol: 0, bull_high_vol: 0,
      bear_low_vol: 0, bear_high_vol: 0,
      neutral: 0, crisis: 0,
    };

    if (this.regimeHistory.length === 0) {
      dist.neutral = 1;
      return dist;
    }

    for (const entry of this.regimeHistory) {
      dist[entry.regime]++;
    }

    const total = this.regimeHistory.length;
    for (const key of Object.keys(dist) as MarketRegimeType[]) {
      dist[key] /= total;
    }

    return dist;
  }

  private neutralState(): RegimeState {
    return {
      current: 'neutral',
      confidence: 0.5,
      duration: 0,
      history: [],
      distribution: {
        bull_low_vol: 0, bull_high_vol: 0,
        bear_low_vol: 0, bear_high_vol: 0,
        neutral: 1, crisis: 0,
      },
    };
  }

  private mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  private std(values: number[]): number {
    if (values.length < 2) return 0;
    const m = this.mean(values);
    const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
    return Math.sqrt(variance);
  }

  /**
   * Get current config
   */
  getConfig(): AdaptiveConfig {
    return { ...this.config };
  }

  /**
   * Reset state
   */
  reset(): void {
    this.priceHistory = [];
    this.currentRegime = 'neutral';
    this.regimeHistory = [];
  }
}

/**
 * Build an adaptive parameter set by optimizing for each regime separately
 */
export async function buildAdaptiveParameterSet(
  regimeData: Map<MarketRegimeType, { prices: number[]; sampleSize: number }>,
  optimizeForRegime: (
    regime: MarketRegimeType,
    prices: number[]
  ) => Promise<{ params: Record<string, number>; metrics: BacktestMetrics }>,
  staticParams: Record<string, number>,
  staticMetrics: BacktestMetrics
): Promise<AdaptiveParameterSet> {
  const regimeParams = new Map<MarketRegimeType, RegimeParameters>();

  for (const [regime, data] of regimeData.entries()) {
    if (data.sampleSize < 20) {
      logger.warn({ regime, sampleSize: data.sampleSize }, 'Insufficient data for regime');
      continue;
    }

    const result = await optimizeForRegime(regime, data.prices);

    regimeParams.set(regime, {
      regime,
      params: result.params,
      metrics: result.metrics,
      sampleSize: data.sampleSize,
      confidence: Math.min(1, data.sampleSize / 100),
    });
  }

  // Calculate transition matrix (simplified: uniform transitions)
  const regimes: MarketRegimeType[] = [
    'bull_low_vol', 'bull_high_vol', 'bear_low_vol', 'bear_high_vol', 'neutral', 'crisis',
  ];
  const transitionMatrix: Record<string, Record<string, number>> = {};
  for (const from of regimes) {
    transitionMatrix[from] = {};
    for (const to of regimes) {
      transitionMatrix[from][to] = from === to ? 0.7 : 0.3 / (regimes.length - 1);
    }
  }

  // Assess improvement
  const regimeMetrics = Array.from(regimeParams.values()).filter(rp => rp.metrics);
  const avgAdaptiveSharpe = regimeMetrics.length > 0
    ? regimeMetrics.reduce((sum, rp) => sum + (rp.metrics?.sharpeRatio ?? 0), 0) / regimeMetrics.length
    : 0;
  const staticSharpe = staticMetrics.sharpeRatio;

  const adapiveOutperformsStatic = avgAdaptiveSharpe > staticSharpe;
  const improvementPct = staticSharpe !== 0
    ? ((avgAdaptiveSharpe - staticSharpe) / Math.abs(staticSharpe)) * 100
    : 0;

  const strongestRegimes = regimeMetrics
    .filter(rp => (rp.metrics?.sharpeRatio ?? 0) > 0.5)
    .map(rp => rp.regime);

  const noEdgeRegimes = regimeMetrics
    .filter(rp => (rp.metrics?.sharpeRatio ?? 0) < 0)
    .map(rp => rp.regime);

  let recommendation: string;
  if (adapiveOutperformsStatic && improvementPct > 10) {
    recommendation = 'Adaptive parameters significantly outperform static. Use regime-dependent params.';
  } else if (adapiveOutperformsStatic) {
    recommendation = 'Marginal improvement with adaptive params. Consider using static for simplicity.';
  } else {
    recommendation = 'Static params perform better. Regime detection may be adding noise.';
  }

  return {
    regimeParams,
    fallbackParams: staticParams,
    transitionMatrix: transitionMatrix as Record<MarketRegimeType, Record<MarketRegimeType, number>>,
    assessment: {
      adapiveOutperformsStatic,
      improvementPct,
      strongestRegimes,
      noEdgeRegimes,
      recommendation,
    },
  };
}

/**
 * Create an adaptive regime detector with default config
 */
export function createAdaptiveRegimeDetector(
  options?: Partial<AdaptiveConfig>
): AdaptiveRegimeDetector {
  return new AdaptiveRegimeDetector(options);
}
