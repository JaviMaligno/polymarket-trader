import { BaseSignal } from '../../core/base/BaseSignal.js';
import type {
  SignalContext,
  SignalOutput,
  Trade,
  OrderBookSnapshot,
} from '../../core/types/signal.types.js';

/**
 * Configuration parameters for Order Flow Imbalance Signal
 */
export interface OFISignalConfig extends Record<string, unknown> {
  /** Lookback period for trade analysis (bars) - default: 20 */
  lookbackBars?: number;
  /** Whether to weight by volume - default: true */
  volumeWeighted?: boolean;
  /** Exponential decay factor for older data - default: 0.9 */
  decayFactor?: number;
  /** Minimum trades required to generate signal - default: 5 */
  minTrades?: number;
  /** Threshold for strong OFI signal - default: 0.3 */
  strongOfiThreshold?: number;
  /** Weight for trade-based OFI - default: 0.6 */
  tradeOfiWeight?: number;
  /** Weight for order book OFI - default: 0.4 */
  bookOfiWeight?: number;
  /** Minimum confidence to emit signal - default: 0.2 */
  minConfidence?: number;
  /** Minimum strength to emit signal - default: 0.1 */
  minStrength?: number;
}

interface OFIParams extends Record<string, unknown> {
  lookbackBars: number;
  volumeWeighted: boolean;
  decayFactor: number;
  minTrades: number;
  strongOfiThreshold: number;
  tradeOfiWeight: number;
  bookOfiWeight: number;
  minConfidence: number;
  minStrength: number;
}

/** Default parameters for Order Flow Imbalance Signal */
export const DEFAULT_OFI_PARAMS: OFIParams = {
  lookbackBars: 20,
  volumeWeighted: true,
  decayFactor: 0.9,
  minTrades: 5,
  strongOfiThreshold: 0.3,
  tradeOfiWeight: 0.6,
  bookOfiWeight: 0.4,
  minConfidence: 0.2,
  minStrength: 0.1,
};

/**
 * Order Flow Imbalance (OFI) Signal
 *
 * Measures the imbalance between buying and selling pressure in the market.
 * This is a key microstructure signal that predicts short-term price movements.
 *
 * OFI is calculated from:
 * 1. Trade flow: Net buy vs sell volume from recent trades
 * 2. Order book imbalance: Bid vs ask depth at best prices
 *
 * Positive OFI = buying pressure (expect price up)
 * Negative OFI = selling pressure (expect price down)
 *
 * Reference: Cont, Kukanov, Stoikov (2014) "The Price Impact of Order Book Events"
 */
export class OrderFlowImbalanceSignal extends BaseSignal {
  readonly signalId = 'ofi';
  readonly name = 'Order Flow Imbalance';
  readonly description = 'Detects buying/selling pressure from trade flow and order book';

  protected parameters: OFIParams;

  constructor(config?: OFISignalConfig) {
    super();
    this.parameters = {
      ...DEFAULT_OFI_PARAMS,
      ...config,
    };
  }

  getRequiredLookback(): number {
    return this.parameters.lookbackBars;
  }

  async compute(context: SignalContext): Promise<SignalOutput | null> {
    const params = this.parameters;

    // Calculate trade-based OFI
    const tradeOfi = this.calculateTradeOFI(context.recentTrades, params);

    // Calculate order book OFI
    const bookOfi = this.calculateBookOFI(context.orderBook, params);

    // Combine OFI signals
    let combinedOfi: number;
    let dataQuality: number;

    if (tradeOfi !== null && bookOfi !== null) {
      // Both sources available - weighted average
      combinedOfi = tradeOfi.ofi * params.tradeOfiWeight + bookOfi.ofi * params.bookOfiWeight;
      dataQuality = (tradeOfi.quality + bookOfi.quality) / 2;
    } else if (tradeOfi !== null) {
      // Only trades available
      combinedOfi = tradeOfi.ofi;
      dataQuality = tradeOfi.quality * 0.7; // Reduced quality without book data
    } else if (bookOfi !== null) {
      // Only order book available
      combinedOfi = bookOfi.ofi;
      dataQuality = bookOfi.quality * 0.7;
    } else {
      // No data available
      return null;
    }

    // Calculate strength and confidence
    const strength = Math.max(-1, Math.min(1, combinedOfi));
    const confidence = this.calculateConfidence(tradeOfi, bookOfi, dataQuality);

    // Determine direction
    const direction = this.getDirection(strength, params.minStrength);

    // Filter weak signals
    if (Math.abs(strength) < params.minStrength || confidence < params.minConfidence) {
      return null;
    }

    return this.createOutput(context, direction, strength, confidence, {
      features: [
        combinedOfi,
        tradeOfi?.ofi ?? 0,
        bookOfi?.ofi ?? 0,
        tradeOfi?.buyVolume ?? 0,
        tradeOfi?.sellVolume ?? 0,
        bookOfi?.bidDepth ?? 0,
        bookOfi?.askDepth ?? 0,
      ],
      metadata: {
        combinedOfi,
        tradeOfi: tradeOfi?.ofi ?? null,
        bookOfi: bookOfi?.ofi ?? null,
        tradeCount: tradeOfi?.tradeCount ?? 0,
        buyVolume: tradeOfi?.buyVolume ?? 0,
        sellVolume: tradeOfi?.sellVolume ?? 0,
        bidDepth: bookOfi?.bidDepth ?? 0,
        askDepth: bookOfi?.askDepth ?? 0,
        spread: bookOfi?.spread ?? 0,
        dataQuality,
      },
    });
  }

  /**
   * Calculate OFI from recent trades
   *
   * Formula: OFI = (BuyVolume - SellVolume) / TotalVolume
   * With optional time decay for older trades
   */
  private calculateTradeOFI(
    trades: Trade[],
    params: OFIParams
  ): { ofi: number; buyVolume: number; sellVolume: number; tradeCount: number; quality: number } | null {
    if (!trades || trades.length < params.minTrades) {
      return null;
    }

    // Sort trades by time (newest first for decay)
    const sortedTrades = [...trades].sort((a, b) => b.time.getTime() - a.time.getTime());
    const now = sortedTrades[0]?.time.getTime() ?? Date.now();

    let buyVolume = 0;
    let sellVolume = 0;
    let totalWeight = 0;

    for (let i = 0; i < sortedTrades.length; i++) {
      const trade = sortedTrades[i];

      // Time-based decay: older trades have less weight
      const ageMs = now - trade.time.getTime();
      const decayWeight = Math.pow(params.decayFactor, ageMs / 60000); // Decay per minute

      // Volume weighting
      const volumeWeight = params.volumeWeighted ? trade.size : 1;
      const weight = decayWeight * volumeWeight;

      if (trade.side === 'BUY') {
        buyVolume += weight;
      } else {
        sellVolume += weight;
      }
      totalWeight += weight;
    }

    if (totalWeight === 0) {
      return null;
    }

    // Normalize to -1 to +1 range
    const ofi = (buyVolume - sellVolume) / totalWeight;

    // Quality based on number of trades
    const quality = Math.min(1, sortedTrades.length / 20);

    return {
      ofi,
      buyVolume,
      sellVolume,
      tradeCount: sortedTrades.length,
      quality,
    };
  }

  /**
   * Calculate OFI from order book snapshot
   *
   * Formula: BookOFI = (BidDepth - AskDepth) / (BidDepth + AskDepth)
   * Positive = more bids than asks (buying pressure)
   */
  private calculateBookOFI(
    orderBook: OrderBookSnapshot | undefined,
    params: OFIParams
  ): { ofi: number; bidDepth: number; askDepth: number; spread: number; quality: number } | null {
    if (!orderBook) {
      return null;
    }

    const bidDepth = orderBook.bidDepth10Pct ?? 0;
    const askDepth = orderBook.askDepth10Pct ?? 0;
    const totalDepth = bidDepth + askDepth;

    if (totalDepth === 0) {
      return null;
    }

    // Order book imbalance
    const ofi = (bidDepth - askDepth) / totalDepth;

    // Quality based on depth and spread
    // Tighter spread = higher quality signal
    const spreadQuality = orderBook.spread < 0.02 ? 1 : 1 - Math.min(1, orderBook.spread / 0.1);
    const depthQuality = Math.min(1, totalDepth / 10000); // Assume $10k is good depth
    const quality = (spreadQuality + depthQuality) / 2;

    return {
      ofi,
      bidDepth,
      askDepth,
      spread: orderBook.spread,
      quality,
    };
  }

  /**
   * Calculate confidence based on data quality and signal agreement
   */
  private calculateConfidence(
    tradeOfi: { ofi: number; quality: number } | null,
    bookOfi: { ofi: number; quality: number } | null,
    dataQuality: number
  ): number {
    let confidence = dataQuality * 0.5; // Base confidence from data quality

    // Agreement bonus: if both signals agree on direction, boost confidence
    if (tradeOfi !== null && bookOfi !== null) {
      const agreementSign = Math.sign(tradeOfi.ofi) === Math.sign(bookOfi.ofi);
      if (agreementSign && Math.abs(tradeOfi.ofi) > 0.1 && Math.abs(bookOfi.ofi) > 0.1) {
        confidence += 0.3; // Agreement bonus
      }

      // Strength bonus: stronger signals are more confident
      const avgStrength = (Math.abs(tradeOfi.ofi) + Math.abs(bookOfi.ofi)) / 2;
      confidence += avgStrength * 0.2;
    } else if (tradeOfi !== null || bookOfi !== null) {
      // Single source: add strength bonus
      const ofi = tradeOfi?.ofi ?? bookOfi?.ofi ?? 0;
      confidence += Math.abs(ofi) * 0.15;
    }

    return Math.min(1, confidence);
  }
}
