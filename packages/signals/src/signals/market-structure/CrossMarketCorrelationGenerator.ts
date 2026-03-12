import { BaseSignal } from '../../core/base/BaseSignal.js';
import type {
  SignalContext,
  SignalOutput,
} from '../../core/types/signal.types.js';

interface CrossMarketCorrelationParams extends Record<string, unknown> {
  minRelatedMarkets: number;
  minPriceChangePct: number;
  lagThresholdPct: number;
}

/**
 * CrossMarketCorrelationGenerator
 *
 * Fires when related markets (same event) have moved but this market has
 * lagged behind. Detects momentum contagion: if correlated markets moved
 * significantly in a direction and this market has not yet followed, it
 * signals an expected catch-up move.
 *
 * Direction: LONG if related markets rose more than this one, SHORT if they fell.
 */
export class CrossMarketCorrelationGenerator extends BaseSignal<CrossMarketCorrelationParams> {
  readonly signalId = 'cross_market_corr';
  readonly name = 'Cross-Market Correlation';
  readonly description =
    'Fires when related markets have moved but this market has lagged behind';

  protected parameters: CrossMarketCorrelationParams = {
    minRelatedMarkets: 1,
    minPriceChangePct: 5,
    lagThresholdPct: 3,
  };

  getRequiredLookback(): number {
    return 2;
  }

  isReady(context: SignalContext): boolean {
    const { minRelatedMarkets } = this.parameters;
    return (
      (context.relatedMarkets?.length ?? 0) >= minRelatedMarkets &&
      context.priceBars.length >= 2
    );
  }

  async compute(context: SignalContext): Promise<SignalOutput | null> {
    const { minPriceChangePct, lagThresholdPct } = this.parameters;
    const { priceBars, relatedMarkets } = context;

    // 1. Require at least one related market
    if (!relatedMarkets || relatedMarkets.length === 0) {
      return null;
    }

    // 2. Require at least 2 price bars
    if (priceBars.length < 2) {
      return null;
    }

    // 3. Get related market price changes from custom context
    const relatedChanges =
      (context.custom?.relatedMarketPriceChanges as Record<string, number>) ?? {};

    // 4. Require at least one related change entry
    if (Object.keys(relatedChanges).length === 0) {
      return null;
    }

    // 5. This market's price change: first bar to last bar
    const firstBar = priceBars[0];
    const lastBar = priceBars[priceBars.length - 1];
    const thisChange =
      firstBar.close !== 0
        ? (lastBar.close - firstBar.close) / firstBar.close
        : 0;

    // 6. Filter related changes to only those above the minimum threshold
    const threshold = minPriceChangePct / 100;
    const significantChanges = Object.values(relatedChanges).filter(
      change => Math.abs(change) >= threshold
    );

    // 7. Require at least one significant related change
    if (significantChanges.length === 0) {
      return null;
    }

    // 8. Average related change across significant movers
    const avgRelatedChange =
      significantChanges.reduce((sum, c) => sum + c, 0) / significantChanges.length;

    // 9. Lag = how much the related markets moved relative to this one
    const lag = avgRelatedChange - thisChange;

    // 10. Require lag to exceed the threshold before signalling
    if (Math.abs(lag) < lagThresholdPct / 100) {
      return null;
    }

    // 11. Direction: positive lag → related went up more → LONG (expect catch-up)
    const direction = lag > 0 ? 'LONG' : 'SHORT';
    const directionSign = lag > 0 ? 1 : -1;

    // 12. Strength: scaled by lag magnitude, capped at 1.0
    const strength = Math.min(1.0, Math.abs(lag) * 5) * directionSign;

    // 13. Confidence: base 0.3 boosted by number of confirming related markets
    const significantCount = significantChanges.length;
    const confidence = Math.min(1.0, 0.3 + significantCount * 0.15);

    return this.createOutput(context, direction, strength, confidence, {
      metadata: {
        thisChange,
        avgRelatedChange,
        lag,
        significantCount,
        relatedChanges,
      },
    });
  }
}
