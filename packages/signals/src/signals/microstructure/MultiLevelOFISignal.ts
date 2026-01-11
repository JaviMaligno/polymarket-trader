import { BaseSignal } from '../../core/base/BaseSignal.js';
import type {
  SignalContext,
  SignalOutput,
} from '../../core/types/signal.types.js';

/**
 * Extended OrderBook with multiple levels
 */
export interface MultiLevelOrderBook {
  time: Date;
  marketId: string;
  tokenId: string;
  /** Array of bid levels [price, size] sorted by price descending */
  bids: Array<{ price: number; size: number }>;
  /** Array of ask levels [price, size] sorted by price ascending */
  asks: Array<{ price: number; size: number }>;
}

/**
 * Configuration parameters for Multi-Level OFI Signal
 */
export interface MLOFISignalConfig extends Record<string, unknown> {
  /** Number of order book levels to analyze - default: 5 */
  levels?: number;
  /** Decay factor for deeper levels - default: 1.5 */
  levelDecay?: number;
  /** Lookback period for change analysis (bars) - default: 10 */
  lookbackBars?: number;
  /** Weight for level changes vs static imbalance - default: 0.6 */
  changeWeight?: number;
  /** Weight for static imbalance - default: 0.4 */
  staticWeight?: number;
  /** Minimum depth to consider valid signal - default: 100 */
  minDepth?: number;
  /** Threshold for strong signal - default: 0.25 */
  strongSignalThreshold?: number;
  /** Minimum confidence to emit signal - default: 0.25 */
  minConfidence?: number;
  /** Minimum strength to emit signal - default: 0.1 */
  minStrength?: number;
}

interface MLOFIParams extends Record<string, unknown> {
  levels: number;
  levelDecay: number;
  lookbackBars: number;
  changeWeight: number;
  staticWeight: number;
  minDepth: number;
  strongSignalThreshold: number;
  minConfidence: number;
  minStrength: number;
}

/** Default parameters for Multi-Level OFI Signal */
export const DEFAULT_MLOFI_PARAMS: MLOFIParams = {
  levels: 5,
  levelDecay: 1.5,
  lookbackBars: 10,
  changeWeight: 0.6,
  staticWeight: 0.4,
  minDepth: 100,
  strongSignalThreshold: 0.25,
  minConfidence: 0.25,
  minStrength: 0.1,
};

/**
 * Multi-Level Order Flow Imbalance (MLOFI) Signal
 *
 * Enhanced version of OFI that analyzes multiple levels of the order book.
 * Deep book imbalances often predict larger price moves than top-of-book alone.
 *
 * MLOFI = Σ(weight[i] * OFI[i]) for i = 1..N levels
 * where weight[i] = 1 / (i^decay)
 *
 * Also tracks changes in imbalance over time, as the RATE of change
 * is often more predictive than the static imbalance.
 *
 * Reference: Cao et al. (2009) "The Information Content of Order Flow"
 */
export class MultiLevelOFISignal extends BaseSignal {
  readonly signalId = 'mlofi';
  readonly name = 'Multi-Level Order Flow Imbalance';
  readonly description = 'Analyzes order book imbalance across multiple price levels';

  protected parameters: MLOFIParams;
  private historicalMLOFI: Array<{ time: Date; mlofi: number }> = [];

  constructor(config?: MLOFISignalConfig) {
    super();
    this.parameters = {
      ...DEFAULT_MLOFI_PARAMS,
      ...config,
    };
  }

  getRequiredLookback(): number {
    return this.parameters.lookbackBars;
  }

  async compute(context: SignalContext): Promise<SignalOutput | null> {
    const params = this.parameters;

    // FIXED: Early validation of levels parameter
    if (params.levels <= 0) {
      this.logger.warn('MultiLevelOFI: levels must be > 0');
      return null;
    }

    // Get multi-level order book from custom data
    const multiLevelBook = context.custom?.multiLevelOrderBook as MultiLevelOrderBook | undefined;

    if (!multiLevelBook) {
      // Fall back to basic order book if multi-level not available
      if (context.orderBook) {
        return this.computeFromBasicBook(context, params);
      }
      return null;
    }

    // Validate order book depth
    if (multiLevelBook.bids.length < params.levels || multiLevelBook.asks.length < params.levels) {
      return null;
    }

    // Calculate level weights (decaying with depth)
    const levelWeights = this.calculateLevelWeights(params.levels, params.levelDecay);

    // Calculate OFI at each level
    const levelOFIs: number[] = [];
    let totalBidDepth = 0;
    let totalAskDepth = 0;

    for (let i = 0; i < params.levels; i++) {
      const bidLevel = multiLevelBook.bids[i];
      const askLevel = multiLevelBook.asks[i];

      const bidSize = bidLevel?.size ?? 0;
      const askSize = askLevel?.size ?? 0;
      const totalSize = bidSize + askSize;

      totalBidDepth += bidSize;
      totalAskDepth += askSize;

      // Level OFI: imbalance at this specific level
      const levelOfi = totalSize > 0 ? (bidSize - askSize) / totalSize : 0;
      levelOFIs.push(levelOfi);
    }

    // Check minimum depth
    if (totalBidDepth + totalAskDepth < params.minDepth) {
      return null;
    }

    // Weighted MLOFI
    // FIXED: Division by zero protection when levels = 0 or weights sum to 0
    let staticMLOFI = 0;
    let totalWeight = 0;
    for (let i = 0; i < params.levels; i++) {
      staticMLOFI += levelOFIs[i] * levelWeights[i];
      totalWeight += levelWeights[i];
    }

    // Protect against division by zero
    if (totalWeight === 0 || params.levels === 0) {
      return null;
    }
    staticMLOFI /= totalWeight;

    // Update historical MLOFI for change tracking
    this.updateHistory(context.currentTime, staticMLOFI, params.lookbackBars);

    // Calculate rate of change in MLOFI
    const mlofiChange = this.calculateMLOFIChange(staticMLOFI);

    // Combined signal: static imbalance + rate of change
    const combinedMLOFI = staticMLOFI * params.staticWeight + mlofiChange * params.changeWeight;

    // Calculate depth imbalance across all levels
    const totalDepth = totalBidDepth + totalAskDepth;
    const depthImbalance = totalDepth > 0 ? (totalBidDepth - totalAskDepth) / totalDepth : 0;

    // Strength and direction
    const strength = Math.max(-1, Math.min(1, combinedMLOFI));
    const confidence = this.calculateConfidence(
      staticMLOFI,
      mlofiChange,
      depthImbalance,
      totalDepth,
      params
    );

    const direction = this.getDirection(strength, params.minStrength);

    // Filter weak signals
    if (Math.abs(strength) < params.minStrength || confidence < params.minConfidence) {
      return null;
    }

    return this.createOutput(context, direction, strength, confidence, {
      features: [
        combinedMLOFI,
        staticMLOFI,
        mlofiChange,
        depthImbalance,
        totalBidDepth,
        totalAskDepth,
        ...levelOFIs,
      ],
      metadata: {
        combinedMLOFI,
        staticMLOFI,
        mlofiChange,
        depthImbalance,
        totalBidDepth,
        totalAskDepth,
        levelOFIs,
        levelWeights,
        historyLength: this.historicalMLOFI.length,
      },
    });
  }

  /**
   * Fallback computation using basic order book
   */
  private async computeFromBasicBook(
    context: SignalContext,
    params: MLOFIParams
  ): Promise<SignalOutput | null> {
    const book = context.orderBook!;
    const bidDepth = book.bidDepth10Pct ?? 0;
    const askDepth = book.askDepth10Pct ?? 0;
    const totalDepth = bidDepth + askDepth;

    if (totalDepth < params.minDepth) {
      return null;
    }

    const staticMLOFI = (bidDepth - askDepth) / totalDepth;

    // Update history
    this.updateHistory(context.currentTime, staticMLOFI, params.lookbackBars);

    const mlofiChange = this.calculateMLOFIChange(staticMLOFI);
    const combinedMLOFI = staticMLOFI * params.staticWeight + mlofiChange * params.changeWeight;

    const strength = Math.max(-1, Math.min(1, combinedMLOFI));
    const confidence = this.calculateConfidence(staticMLOFI, mlofiChange, staticMLOFI, totalDepth, params) * 0.7;

    const direction = this.getDirection(strength, params.minStrength);

    if (Math.abs(strength) < params.minStrength || confidence < params.minConfidence) {
      return null;
    }

    return this.createOutput(context, direction, strength, confidence, {
      features: [combinedMLOFI, staticMLOFI, mlofiChange, staticMLOFI, bidDepth, askDepth],
      metadata: {
        combinedMLOFI,
        staticMLOFI,
        mlofiChange,
        bidDepth,
        askDepth,
        source: 'basic_orderbook',
      },
    });
  }

  /**
   * Calculate weights for each order book level
   * Deeper levels have less weight (power law decay)
   */
  private calculateLevelWeights(levels: number, decay: number): number[] {
    const weights: number[] = [];
    for (let i = 0; i < levels; i++) {
      weights.push(1 / Math.pow(i + 1, decay));
    }
    return weights;
  }

  /**
   * Update MLOFI history for change tracking
   */
  private updateHistory(time: Date, mlofi: number, maxLength: number): void {
    this.historicalMLOFI.push({ time, mlofi });

    // Keep only recent history
    if (this.historicalMLOFI.length > maxLength * 2) {
      this.historicalMLOFI = this.historicalMLOFI.slice(-maxLength);
    }
  }

  /**
   * Calculate rate of change in MLOFI
   */
  private calculateMLOFIChange(currentMLOFI: number): number {
    if (this.historicalMLOFI.length < 2) {
      return 0;
    }

    // Compare to average of historical values
    const historicalValues = this.historicalMLOFI.slice(0, -1).map(h => h.mlofi);
    const avgHistorical = historicalValues.reduce((a, b) => a + b, 0) / historicalValues.length;

    // Rate of change: positive if MLOFI is increasing (more buying pressure)
    return currentMLOFI - avgHistorical;
  }

  /**
   * Calculate confidence based on signal quality
   */
  private calculateConfidence(
    staticMLOFI: number,
    mlofiChange: number,
    depthImbalance: number,
    totalDepth: number,
    params: MLOFIParams
  ): number {
    let confidence = 0;

    // Depth quality: more depth = more reliable signal
    const depthQuality = Math.min(1, totalDepth / (params.minDepth * 10));
    confidence += depthQuality * 0.3;

    // Agreement bonus: static and change agree
    const agreementSign = Math.sign(staticMLOFI) === Math.sign(mlofiChange);
    if (agreementSign && Math.abs(staticMLOFI) > 0.1 && Math.abs(mlofiChange) > 0.1) {
      confidence += 0.25;
    }

    // Strength bonus: stronger signals
    const strength = Math.abs(staticMLOFI * params.staticWeight + mlofiChange * params.changeWeight);
    confidence += Math.min(0.25, strength / params.strongSignalThreshold * 0.25);

    // Historical consistency bonus
    if (this.historicalMLOFI.length >= 3) {
      const recentValues = this.historicalMLOFI.slice(-3).map(h => h.mlofi);
      const allSameSign = recentValues.every(v => Math.sign(v) === Math.sign(staticMLOFI));
      if (allSameSign) {
        confidence += 0.2;
      }
    }

    return Math.min(1, confidence);
  }

  /**
   * Clear historical data (useful for backtesting)
   */
  clearHistory(): void {
    this.historicalMLOFI = [];
  }
}
