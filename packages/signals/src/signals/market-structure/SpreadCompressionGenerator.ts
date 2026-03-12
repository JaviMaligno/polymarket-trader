import { BaseSignal } from '../../core/base/BaseSignal.js';
import type {
  SignalContext,
  SignalOutput,
} from '../../core/types/signal.types.js';

interface SpreadCompressionParams extends Record<string, unknown> {
  compressionThreshold: number;
  minHistoricalSpreads: number;
}

/**
 * SpreadCompressionGenerator
 *
 * Detects bid-ask spread compression indicating informed trader entry.
 * When the current spread is significantly tighter than the historical
 * average, informed buyers (LONG) or sellers (SHORT) are likely entering
 * the market. Direction is determined by depth imbalance at the top of book.
 */
export class SpreadCompressionGenerator extends BaseSignal<SpreadCompressionParams> {
  readonly signalId = 'spread_compression';
  readonly name = 'Spread Compression';
  readonly description =
    'Detects bid-ask spread compression indicating informed trader entry';

  protected parameters: SpreadCompressionParams = {
    compressionThreshold: 0.5,
    minHistoricalSpreads: 10,
  };

  getRequiredLookback(): number {
    return 0;
  }

  isReady(context: SignalContext): boolean {
    return !!context.orderBook;
  }

  async compute(context: SignalContext): Promise<SignalOutput | null> {
    const { compressionThreshold, minHistoricalSpreads } = this.parameters;

    // 1. Require orderBook with a spread value
    if (!context.orderBook || !context.orderBook.spread) {
      return null;
    }

    const orderBook = context.orderBook;

    // 2. Get historical spreads from custom context
    const historicalSpreads =
      (context.custom?.historicalSpreads as number[]) ?? [];

    // 3. Require minimum number of historical spreads
    if (historicalSpreads.length < minHistoricalSpreads) {
      return null;
    }

    // 4. Calculate average spread
    const avgSpread =
      historicalSpreads.reduce((a, b) => a + b, 0) / historicalSpreads.length;

    // 5. Guard against zero average
    if (avgSpread === 0) {
      return null;
    }

    // 6. Compression ratio: current / average
    const compressionRatio = orderBook.spread / avgSpread;

    // 7. No compression if ratio is at or above threshold
    if (compressionRatio >= compressionThreshold) {
      return null;
    }

    // 8. Determine direction from depth imbalance
    const bidDepth = orderBook.bidDepth10Pct ?? 0;
    const askDepth = orderBook.askDepth10Pct ?? 0;
    const totalDepth = bidDepth + askDepth;

    // 9. Guard against zero depth
    if (totalDepth === 0) {
      return null;
    }

    const direction = bidDepth > askDepth ? 'LONG' : 'SHORT';
    const directionSign = direction === 'LONG' ? 1 : -1;

    // 10. Depth imbalance: |bid - ask| / total
    const depthImbalance = Math.abs(bidDepth - askDepth) / totalDepth;

    // 11. Strength: scaled by compression magnitude and depth imbalance
    const strength =
      Math.min(1.0, (1 - compressionRatio) * depthImbalance * 2) *
      directionSign;

    // 12. Confidence: base 0.3 boosted by compression magnitude
    const confidence = Math.min(1.0, 0.3 + (1 - compressionRatio) * 0.7);

    return this.createOutput(context, direction, strength, confidence, {
      metadata: {
        compressionRatio,
        avgSpread,
        currentSpread: orderBook.spread,
        bidDepth,
        askDepth,
        depthImbalance,
      },
    });
  }
}
