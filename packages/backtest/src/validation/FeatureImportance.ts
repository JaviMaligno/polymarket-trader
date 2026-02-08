/**
 * Permutation Feature Importance
 *
 * Measures the importance of each signal/feature by permuting (shuffling)
 * its outputs and measuring how much performance degrades. Signals whose
 * permutation causes no degradation are not contributing to the strategy.
 */

import pino from 'pino';
import type {
  BacktestConfig,
  BacktestResult,
  MarketData,
  PerformanceMetrics,
  TradeRecord,
} from '../types/index.js';

const logger = pino({ name: 'FeatureImportance' });

// ============================================
// Types
// ============================================

export interface FeatureImportanceConfig {
  /** Number of permutation iterations per feature */
  numPermutations: number;
  /** Primary metric to evaluate importance */
  primaryMetric: keyof PerformanceMetrics;
  /** Random seed for reproducibility */
  randomSeed?: number;
  /** Minimum importance score to be considered useful */
  minImportanceThreshold: number;
  /** Minimum trades for valid evaluation */
  minTrades: number;
}

export interface FeatureImportanceResult {
  config: FeatureImportanceConfig;
  /** Baseline metric value (with all features) */
  baselineMetric: number;
  /** Per-feature importance scores */
  features: FeatureScore[];
  /** Features ranked by importance (most important first) */
  ranking: Array<{ name: string; importance: number; isUseful: boolean }>;
  /** Recommended features to keep */
  recommendedFeatures: string[];
  /** Features that can be dropped (not contributing) */
  droppableFeatures: string[];
  /** Percentage of features that are useful */
  usefulFeatureRatio: number;
}

export interface FeatureScore {
  /** Feature/signal name */
  name: string;
  /** Mean metric when this feature is permuted */
  permutedMetricMean: number;
  /** Std of permuted metric */
  permutedMetricStd: number;
  /** Importance = (baseline - permuted) / baseline */
  importance: number;
  /** 95% CI of importance */
  importanceCI: { lower: number; upper: number };
  /** Whether this feature is statistically useful */
  isUseful: boolean;
  /** P-value (probability that degradation is random) */
  pValue: number;
}

// ============================================
// Permutation Feature Importance Calculator
// ============================================

export class FeatureImportanceCalculator {
  private config: FeatureImportanceConfig;
  private rng: () => number;

  constructor(config?: Partial<FeatureImportanceConfig>) {
    this.config = {
      numPermutations: config?.numPermutations ?? 30,
      primaryMetric: config?.primaryMetric ?? 'sharpeRatio',
      randomSeed: config?.randomSeed,
      minImportanceThreshold: config?.minImportanceThreshold ?? 0.05,
      minTrades: config?.minTrades ?? 10,
    };
    this.rng = this.createRng(this.config.randomSeed);
  }

  /**
   * Calculate feature importance using permutation on trade records.
   *
   * This works by:
   * 1. Getting baseline metrics from original trades
   * 2. For each signal type, shuffling the PnL of trades that used that signal
   * 3. Measuring how much the overall metric degrades
   */
  calculate(
    trades: TradeRecord[],
    baselineMetrics: PerformanceMetrics
  ): FeatureImportanceResult {
    if (trades.length < this.config.minTrades) {
      throw new Error(`Need at least ${this.config.minTrades} trades`);
    }

    const baselineMetric = this.extractMetric(baselineMetrics);

    // Identify unique signal types from trades
    const signalTypes = this.extractSignalTypes(trades);

    logger.info({
      numTrades: trades.length,
      numSignals: signalTypes.length,
      signals: signalTypes,
      baselineMetric,
    }, 'Calculating feature importance');

    const features: FeatureScore[] = [];

    for (const signalType of signalTypes) {
      const permutedMetrics: number[] = [];

      for (let i = 0; i < this.config.numPermutations; i++) {
        // Create permuted version where this signal's trades have shuffled outcomes
        const permutedTrades = this.permuteSignalTrades(trades, signalType);
        const metric = this.calculateTradeMetric(permutedTrades);
        permutedMetrics.push(metric);
      }

      const permutedMean = this.mean(permutedMetrics);
      const permutedStd = this.std(permutedMetrics);

      // Importance: how much worse is permuted vs original
      const importance = baselineMetric !== 0
        ? (baselineMetric - permutedMean) / Math.abs(baselineMetric)
        : 0;

      // P-value: how many permutations were as good as original?
      const betterCount = permutedMetrics.filter(m => m >= baselineMetric).length;
      const pValue = betterCount / this.config.numPermutations;

      // 95% CI
      const se = permutedStd / Math.sqrt(this.config.numPermutations);
      const importanceCI = {
        lower: importance - 1.96 * (se / Math.abs(baselineMetric || 1)),
        upper: importance + 1.96 * (se / Math.abs(baselineMetric || 1)),
      };

      const isUseful = importance > this.config.minImportanceThreshold && pValue < 0.1;

      features.push({
        name: signalType,
        permutedMetricMean: permutedMean,
        permutedMetricStd: permutedStd,
        importance,
        importanceCI,
        isUseful,
        pValue,
      });
    }

    // Rank by importance
    const ranking = features
      .map(f => ({ name: f.name, importance: f.importance, isUseful: f.isUseful }))
      .sort((a, b) => b.importance - a.importance);

    const recommendedFeatures = ranking.filter(r => r.isUseful).map(r => r.name);
    const droppableFeatures = ranking.filter(r => !r.isUseful).map(r => r.name);
    const usefulFeatureRatio = features.length > 0
      ? features.filter(f => f.isUseful).length / features.length
      : 0;

    logger.info({
      recommended: recommendedFeatures,
      droppable: droppableFeatures,
      usefulRatio: usefulFeatureRatio.toFixed(2),
    }, 'Feature importance calculation complete');

    return {
      config: this.config,
      baselineMetric,
      features,
      ranking,
      recommendedFeatures,
      droppableFeatures,
      usefulFeatureRatio,
    };
  }

  /**
   * Extract unique signal types from trades
   */
  private extractSignalTypes(trades: TradeRecord[]): string[] {
    const types = new Set<string>();
    for (const trade of trades) {
      for (const signal of trade.signals) {
        types.add(signal);
      }
    }
    return Array.from(types);
  }

  /**
   * Permute trades associated with a specific signal
   */
  private permuteSignalTrades(trades: TradeRecord[], signalType: string): TradeRecord[] {
    // Find indices of trades that used this signal
    const signalIndices: number[] = [];
    for (let i = 0; i < trades.length; i++) {
      if (trades[i].signals.includes(signalType)) {
        signalIndices.push(i);
      }
    }

    if (signalIndices.length <= 1) {
      return trades;
    }

    // Shuffle PnL values among these trades
    const shuffledPnls = signalIndices.map(i => trades[i].pnl);
    const shuffledPnlPcts = signalIndices.map(i => trades[i].pnlPct);

    for (let i = shuffledPnls.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [shuffledPnls[i], shuffledPnls[j]] = [shuffledPnls[j], shuffledPnls[i]];
      [shuffledPnlPcts[i], shuffledPnlPcts[j]] = [shuffledPnlPcts[j], shuffledPnlPcts[i]];
    }

    // Create new trades array with permuted PnLs
    const result = [...trades];
    for (let k = 0; k < signalIndices.length; k++) {
      const idx = signalIndices[k];
      result[idx] = {
        ...trades[idx],
        pnl: shuffledPnls[k],
        pnlPct: shuffledPnlPcts[k],
      };
    }

    return result;
  }

  /**
   * Calculate metric from trade records
   */
  private calculateTradeMetric(trades: TradeRecord[]): number {
    if (trades.length === 0) return 0;

    const returns = trades.map(t => t.pnlPct / 100);
    const metric = this.config.primaryMetric;

    switch (metric) {
      case 'sharpeRatio': {
        const avgReturn = this.mean(returns);
        const stdReturn = this.std(returns);
        return stdReturn > 0 ? (avgReturn * Math.sqrt(252)) / stdReturn : 0;
      }
      case 'totalReturn': {
        let equity = 1;
        for (const r of returns) equity *= (1 + r);
        return equity - 1;
      }
      case 'winRate': {
        return trades.filter(t => t.pnl > 0).length / trades.length;
      }
      case 'profitFactor': {
        const gross = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
        const loss = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
        return loss > 0 ? gross / loss : gross > 0 ? Infinity : 0;
      }
      default: {
        // Fallback to totalReturn
        let equity = 1;
        for (const r of returns) equity *= (1 + r);
        return equity - 1;
      }
    }
  }

  /**
   * Extract metric value
   */
  private extractMetric(metrics: PerformanceMetrics): number {
    const value = metrics[this.config.primaryMetric];
    return typeof value === 'number' ? value : 0;
  }

  private createRng(seed?: number): () => number {
    if (seed === undefined) return Math.random;
    let state = seed;
    return () => {
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
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
}

/**
 * Create a feature importance calculator with default config
 */
export function createFeatureImportanceCalculator(
  options?: Partial<FeatureImportanceConfig>
): FeatureImportanceCalculator {
  return new FeatureImportanceCalculator(options);
}
