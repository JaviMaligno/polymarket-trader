/**
 * PriceRangeWeightModifier
 *
 * Scales signal weights based on the market's current Yes-token price.
 * Near-50% markets have more uncertainty; only order-flow signals remain
 * informative there. Momentum/mean-reversion lose edge near the coin-flip point.
 *
 * Bands:
 *   normal       < 0.40  or  > 0.60   Full signal validity
 *   transitional  0.40–0.45 / 0.55–0.60  Reduced confidence
 *   uncertain     0.45–0.55            Only flow signals meaningful
 */

export type PriceRangeBand = 'normal' | 'transitional' | 'uncertain';

export type PriceBandMultipliers = Record<PriceRangeBand, number>;

const DEFAULT_MATRIX: Record<string, PriceBandMultipliers> = {
  momentum:           { normal: 1.0, transitional: 0.6, uncertain: 0   },
  mean_reversion:     { normal: 1.0, transitional: 0.4, uncertain: 0   },
  ofi:                { normal: 1.0, transitional: 1.0, uncertain: 1.0 },
  mlofi:              { normal: 1.0, transitional: 1.0, uncertain: 1.0 },
  hawkes:             { normal: 1.0, transitional: 1.0, uncertain: 1.0 },
  volume_anomaly:     { normal: 1.0, transitional: 1.0, uncertain: 1.0 },
  spread_compression: { normal: 1.0, transitional: 1.0, uncertain: 0.8 },
  cross_market_corr:  { normal: 1.0, transitional: 0.8, uncertain: 0.5 },
  price_divergence:   { normal: 1.0, transitional: 1.0, uncertain: 1.0 },
  attention_spike:    { normal: 1.0, transitional: 1.0, uncertain: 1.0 },
  news_sentiment:     { normal: 1.0, transitional: 1.0, uncertain: 0.7 },
};

const DEFAULT_UNKNOWN_MULTIPLIER = 0.5;

// Band boundaries (optimizable via Bayesian optimizer)
const UNCERTAIN_MIN = 0.45;
const UNCERTAIN_MAX = 0.55;
const TRANSITIONAL_MIN = 0.40;
const TRANSITIONAL_MAX = 0.60;

export class PriceRangeWeightModifier {
  private matrix: Record<string, PriceBandMultipliers>;

  constructor(customMatrix?: Partial<Record<string, PriceBandMultipliers>>) {
    this.matrix = Object.fromEntries(
      Object.entries(DEFAULT_MATRIX).map(([k, v]) => [k, { ...v }])
    );
    if (customMatrix) {
      for (const [signalId, row] of Object.entries(customMatrix)) {
        if (row != null) {
          this.matrix[signalId] = { ...row } as PriceBandMultipliers;
        }
      }
    }
  }

  getPriceBand(price: number): PriceRangeBand {
    if (price >= UNCERTAIN_MIN && price <= UNCERTAIN_MAX) return 'uncertain';
    if (price >= TRANSITIONAL_MIN && price <= TRANSITIONAL_MAX) return 'transitional';
    return 'normal';
  }

  getWeightMultiplier(signalId: string, band: PriceRangeBand): number {
    const row = this.matrix[signalId];
    if (row == null) return DEFAULT_UNKNOWN_MULTIPLIER;
    return row[band];
  }

  modifyWeights(
    weights: Record<string, number>,
    currentPrice: number
  ): Record<string, number> {
    const band = this.getPriceBand(currentPrice);
    const result: Record<string, number> = {};
    for (const [signalId, weight] of Object.entries(weights)) {
      result[signalId] = weight * this.getWeightMultiplier(signalId, band);
    }
    return result;
  }

  updateMatrix(updates: Partial<Record<string, PriceBandMultipliers>>): void {
    for (const [signalId, row] of Object.entries(updates)) {
      if (row != null) {
        this.matrix[signalId] = { ...row };
      }
    }
  }

  getMatrix(): Record<string, PriceBandMultipliers> {
    return Object.fromEntries(
      Object.entries(this.matrix).map(([k, v]) => [k, { ...v }])
    );
  }
}
