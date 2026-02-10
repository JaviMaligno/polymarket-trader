/**
 * Entry Filter Pipeline
 *
 * Orchestrates all entry filters (Hurst, RSI, Z-Score) with cascading logic.
 * Uses sophisticated filters when data is available, falls back to simpler ones.
 */

import { HurstFilter, type HurstConfig, type FilterDecision as HurstDecision } from './HurstFilter.js';
import { RSIMomentumFilter, type RSIConfig, type RSIFilterDecision } from './RSIMomentumFilter.js';
import { ZScoreVolatilityFilter, type ZScoreConfig, type ZScoreFilterDecision } from './ZScoreVolatilityFilter.js';

export interface EntryFilterConfig {
  /** Minimum bars to use Hurst filter (default: 50) */
  hurstMinBars: number;
  /** Hurst filter configuration */
  hurst: Partial<HurstConfig>;
  /** RSI filter configuration */
  rsi: Partial<RSIConfig>;
  /** Z-Score filter configuration */
  zScore: Partial<ZScoreConfig>;
  /** Combine RSI and Z-Score decisions (default: true) */
  combineRSIAndZScore: boolean;
}

export type SignalType = 'mean_reversion' | 'momentum' | 'other';
export type SignalDirection = 'buy' | 'sell';

export interface PipelineDecision {
  allowed: boolean;
  sizeMultiplier: number;
  reasons: string[];
  filtersApplied: string[];
  hurstResult?: HurstDecision;
  rsiResult?: RSIFilterDecision;
  zScoreResult?: ZScoreFilterDecision;
}

const DEFAULT_CONFIG: EntryFilterConfig = {
  hurstMinBars: 50,
  hurst: {},
  rsi: {},
  zScore: {},
  combineRSIAndZScore: true,
};

export class EntryFilterPipeline {
  private config: EntryFilterConfig;
  private hurstFilter: HurstFilter;
  private rsiFilter: RSIMomentumFilter;
  private zScoreFilter: ZScoreVolatilityFilter;

  constructor(config: Partial<EntryFilterConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.hurstFilter = new HurstFilter({
      minBars: this.config.hurstMinBars,
      ...this.config.hurst,
    });
    this.rsiFilter = new RSIMomentumFilter(this.config.rsi);
    this.zScoreFilter = new ZScoreVolatilityFilter(this.config.zScore);
  }

  /**
   * Evaluate a signal through the filter pipeline
   */
  evaluate(
    prices: number[],
    signalType: SignalType,
    direction: SignalDirection
  ): PipelineDecision {
    const decision: PipelineDecision = {
      allowed: true,
      sizeMultiplier: 1.0,
      reasons: [],
      filtersApplied: [],
    };

    // For non-mean_reversion/momentum signals, don't filter
    if (signalType === 'other') {
      decision.reasons.push('Signal type "other" - no filtering applied');
      return decision;
    }

    // Check if we have enough data for Hurst
    const hasEnoughForHurst = prices.length >= this.config.hurstMinBars;

    if (hasEnoughForHurst) {
      // Use Hurst filter (C1)
      this.applyHurstFilter(decision, prices, signalType);
    } else {
      // Use fallback filters (C2 + C3)
      this.applyFallbackFilters(decision, prices, signalType, direction);
    }

    return decision;
  }

  /**
   * Apply Hurst filter when we have enough data
   */
  private applyHurstFilter(
    decision: PipelineDecision,
    prices: number[],
    signalType: SignalType
  ): void {
    decision.filtersApplied.push('hurst');

    let hurstDecision: HurstDecision;

    if (signalType === 'mean_reversion') {
      hurstDecision = this.hurstFilter.shouldAllowMeanReversion(prices);
    } else {
      hurstDecision = this.hurstFilter.shouldAllowMomentum(prices);
    }

    decision.hurstResult = hurstDecision;
    decision.reasons.push(hurstDecision.reason);

    if (!hurstDecision.allowed) {
      decision.allowed = false;
      decision.sizeMultiplier = 0;
    } else {
      decision.sizeMultiplier *= hurstDecision.sizeMultiplier;
    }
  }

  /**
   * Apply fallback filters (RSI + Z-Score) when insufficient data for Hurst
   */
  private applyFallbackFilters(
    decision: PipelineDecision,
    prices: number[],
    signalType: SignalType,
    direction: SignalDirection
  ): void {
    decision.reasons.push(`Insufficient data for Hurst (${prices.length} bars), using fallback filters`);

    // Only apply fallback to mean_reversion signals
    if (signalType !== 'mean_reversion') {
      decision.reasons.push('Fallback filters only apply to mean_reversion signals');
      return;
    }

    // Apply RSI filter (C2)
    const rsiDecision = direction === 'buy'
      ? this.rsiFilter.shouldAllowMeanReversionBuy(prices)
      : this.rsiFilter.shouldAllowMeanReversionSell(prices);

    decision.rsiResult = rsiDecision;
    decision.filtersApplied.push('rsi');
    decision.reasons.push(`RSI: ${rsiDecision.reason}`);

    // Apply Z-Score filter (C3)
    const zScoreDecision = this.zScoreFilter.shouldAllowMeanReversionBuy(prices);
    decision.zScoreResult = zScoreDecision;
    decision.filtersApplied.push('zscore');
    decision.reasons.push(`Z-Score: ${zScoreDecision.reason}`);

    if (this.config.combineRSIAndZScore) {
      // Combined decision: both must allow, take minimum multiplier
      if (!rsiDecision.allowed || !zScoreDecision.allowed) {
        decision.allowed = false;
        decision.sizeMultiplier = 0;
        decision.reasons.push('Combined filter blocked: one or both filters rejected');
      } else {
        decision.sizeMultiplier *= Math.min(
          rsiDecision.sizeMultiplier,
          zScoreDecision.sizeMultiplier
        );
      }
    } else {
      // Conservative: only block if both block
      if (!rsiDecision.allowed && !zScoreDecision.allowed) {
        decision.allowed = false;
        decision.sizeMultiplier = 0;
      } else {
        // Average the multipliers
        decision.sizeMultiplier *= (rsiDecision.sizeMultiplier + zScoreDecision.sizeMultiplier) / 2;
      }
    }
  }

  /**
   * Quick check if mean reversion should be allowed (simplified)
   */
  shouldAllowMeanReversion(prices: number[], direction: SignalDirection = 'buy'): boolean {
    return this.evaluate(prices, 'mean_reversion', direction).allowed;
  }

  /**
   * Quick check if momentum should be allowed (simplified)
   */
  shouldAllowMomentum(prices: number[], direction: SignalDirection = 'buy'): boolean {
    return this.evaluate(prices, 'momentum', direction).allowed;
  }

  /**
   * Get size multiplier for a signal
   */
  getSizeMultiplier(
    prices: number[],
    signalType: SignalType,
    direction: SignalDirection
  ): number {
    return this.evaluate(prices, signalType, direction).sizeMultiplier;
  }

  /**
   * Update all filter configurations
   */
  updateConfig(config: Partial<EntryFilterConfig>): void {
    this.config = { ...this.config, ...config };

    if (config.hurst) {
      this.hurstFilter.updateConfig(config.hurst);
    }
    if (config.rsi) {
      this.rsiFilter.updateConfig(config.rsi);
    }
    if (config.zScore) {
      this.zScoreFilter.updateConfig(config.zScore);
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): EntryFilterConfig {
    return {
      ...this.config,
      hurst: this.hurstFilter.getConfig(),
      rsi: this.rsiFilter.getConfig(),
      zScore: this.zScoreFilter.getConfig(),
    };
  }

  /**
   * Get all optimizable parameter ranges
   */
  static getOptimizableRanges() {
    return {
      hurst: HurstFilter.getOptimizableRanges(),
      rsi: RSIMomentumFilter.getOptimizableRanges(),
      zScore: ZScoreVolatilityFilter.getOptimizableRanges(),
    };
  }

  /**
   * Get individual filter instances for advanced usage
   */
  getFilters() {
    return {
      hurst: this.hurstFilter,
      rsi: this.rsiFilter,
      zScore: this.zScoreFilter,
    };
  }
}
