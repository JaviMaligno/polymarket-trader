import { BaseSignal } from '../../core/base/BaseSignal.js';
import type {
  SignalContext,
  SignalOutput,
  SignalDirection,
} from '../../core/types/signal.types.js';

interface ExternalPrice {
  platform: string;
  probability: number;
  confidence: number;
}

interface PriceDivergenceParams extends Record<string, unknown> {
  minDivergencePp: number;
}

/**
 * PriceDivergenceGenerator
 *
 * Fires when the Polymarket price diverges from the weighted-average
 * consensus of external prediction platforms (Metaculus, Manifold, etc.).
 * Consensus is a confidence-weighted average of external probabilities.
 * Direction is LONG when Polymarket is underpriced vs consensus, SHORT when
 * overpriced. Signal strength and confidence scale with divergence magnitude.
 */
export class PriceDivergenceGenerator extends BaseSignal<PriceDivergenceParams> {
  readonly signalId = 'price_divergence';
  readonly name = 'Cross-Platform Price Divergence';
  readonly description =
    'Fires when Polymarket price diverges from Metaculus/Manifold consensus';

  protected parameters: PriceDivergenceParams = {
    minDivergencePp: 5,
  };

  getRequiredLookback(): number {
    return 0;
  }

  isReady(context: SignalContext): boolean {
    return ((context.custom?.externalPrices as any[]) ?? []).length > 0;
  }

  async compute(context: SignalContext): Promise<SignalOutput | null> {
    const { minDivergencePp } = this.parameters;

    // 1. Get external prices — return null if missing or empty
    const externalPrices = context.custom?.externalPrices as ExternalPrice[] | undefined;
    if (!externalPrices || externalPrices.length === 0) {
      return null;
    }

    // 2. Get Polymarket price from custom or fall back to market
    const polyPrice =
      context.custom?.polymarketPrice !== undefined
        ? (context.custom.polymarketPrice as number)
        : context.market.currentPriceYes;

    if (polyPrice === undefined) {
      return null;
    }

    // 3. Confidence-weighted average of external probabilities
    let sumWeighted = 0;
    let totalWeight = 0;
    for (const ep of externalPrices) {
      sumWeighted += ep.probability * ep.confidence;
      totalWeight += ep.confidence;
    }

    if (totalWeight === 0) {
      return null;
    }

    const externalConsensus = sumWeighted / totalWeight;

    // 4. Divergence in percentage points
    const divergencePp = (externalConsensus - polyPrice) * 100;

    // 5. Return null if below minimum divergence threshold
    if (Math.abs(divergencePp) < minDivergencePp) {
      return null;
    }

    // 6. Direction
    const direction: SignalDirection = divergencePp > 0 ? 'LONG' : 'SHORT';
    const directionSign = divergencePp > 0 ? 1 : -1;

    // 7. Strength: scales with divergence, signed
    const strength = Math.min(1.0, Math.abs(divergencePp) * 0.05) * directionSign;

    // 8. Average match confidence (unweighted)
    const avgMatchConf =
      externalPrices.reduce((sum, ep) => sum + ep.confidence, 0) / externalPrices.length;

    // 9. Confidence: capped by both match confidence and divergence-derived cap
    const confidence = Math.min(
      avgMatchConf,
      0.3 + Math.abs(divergencePp) * 0.03
    );

    // 10. Return output
    return this.createOutput(context, direction, strength, confidence, {
      metadata: {
        polymarketPrice: polyPrice,
        externalConsensus,
        divergencePp,
        platformCount: externalPrices.length,
        avgMatchConfidence: avgMatchConf,
      },
    });
  }
}
