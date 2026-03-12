/**
 * DurationWeightModifier
 *
 * Scales signal weights based on a market's time horizon (duration band).
 * Different signal types have different predictive value depending on how
 * far a market is from resolution.
 *
 * Bands:
 *   immediate  < 7 days
 *   short      7–30 days
 *   medium     30–90 days
 *   long       > 90 days
 *   null/undefined endDate → treated as short
 *   Past endDate (negative days remaining) → immediate
 */

export type DurationBand = 'immediate' | 'short' | 'medium' | 'long';

/** Full multiplier row for all four bands */
export type BandMultipliers = Record<DurationBand, number>;

/**
 * Default compatibility matrix.
 * Values are multipliers (0–1) applied to a signal's weight for each band.
 */
const DEFAULT_MATRIX: Record<string, BandMultipliers> = {
  momentum:           { immediate: 1.0, short: 0.5, medium: 0,   long: 0   },
  mean_reversion:     { immediate: 1.0, short: 1.0, medium: 0.3, long: 0   },
  ofi:                { immediate: 1.0, short: 1.0, medium: 1.0, long: 0.5 },
  mlofi:              { immediate: 1.0, short: 1.0, medium: 1.0, long: 0.5 },
  hawkes:             { immediate: 1.0, short: 1.0, medium: 1.0, long: 1.0 },
  volume_anomaly:     { immediate: 0.3, short: 0.7, medium: 1.0, long: 1.0 },
  spread_compression: { immediate: 0.3, short: 0.7, medium: 1.0, long: 1.0 },
  cross_market_corr:  { immediate: 0,   short: 0.5, medium: 1.0, long: 1.0 },
  price_divergence:   { immediate: 0,   short: 0,   medium: 0.8, long: 1.0 },
  attention_spike:    { immediate: 0,   short: 0.3, medium: 0.8, long: 1.0 },
  news_sentiment:     { immediate: 0,   short: 0.3, medium: 0.8, long: 1.0 },
};

/** Multiplier applied to any signal not present in the matrix */
const DEFAULT_UNKNOWN_MULTIPLIER = 0.5;

/** Band boundary constants in days */
const IMMEDIATE_MAX_DAYS = 7;
const SHORT_MAX_DAYS = 30;
const MEDIUM_MAX_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export class DurationWeightModifier {
  private matrix: Record<string, BandMultipliers>;

  /**
   * @param customMatrix  Optional partial matrix to merge over the defaults.
   *                      Only the supplied signal rows are overridden; all
   *                      other signals keep their default values.
   */
  constructor(customMatrix?: Partial<Record<string, BandMultipliers>>) {
    // Deep-clone defaults then apply any overrides
    this.matrix = Object.fromEntries(
      Object.entries(DEFAULT_MATRIX).map(([k, v]) => [k, { ...v }])
    );
    if (customMatrix) {
      for (const [signalId, row] of Object.entries(customMatrix)) {
        if (row != null) {
          this.matrix[signalId] = { ...row } as BandMultipliers;
        }
      }
    }
  }

  /**
   * Classify a market's end date into a duration band.
   *
   * @param endDate  The market's resolution date, or null/undefined if unknown.
   * @returns        The appropriate DurationBand.
   */
  getDurationBand(endDate: Date | null | undefined): DurationBand {
    if (endDate == null) {
      return 'short';
    }

    const daysRemaining = (endDate.getTime() - Date.now()) / MS_PER_DAY;

    // Past or at resolution (negative or zero days)
    if (daysRemaining < IMMEDIATE_MAX_DAYS) {
      return 'immediate';
    }
    if (daysRemaining < SHORT_MAX_DAYS) {
      return 'short';
    }
    if (daysRemaining < MEDIUM_MAX_DAYS) {
      return 'medium';
    }
    return 'long';
  }

  /**
   * Get the weight multiplier for a specific signal in a given duration band.
   *
   * @param signalId  The signal identifier (e.g. 'momentum', 'hawkes').
   * @param band      The duration band.
   * @returns         A multiplier in [0, 1]; unknown signals return 0.5.
   */
  getWeightMultiplier(signalId: string, band: DurationBand): number {
    const row = this.matrix[signalId];
    if (row == null) {
      return DEFAULT_UNKNOWN_MULTIPLIER;
    }
    return row[band];
  }

  /**
   * Apply duration-based multipliers to an entire weights map.
   *
   * Each weight is multiplied by the signal's band multiplier. The original
   * object is not mutated.
   *
   * @param weights  Map of signalId → weight (e.g. from WeightedAverageCombiner).
   * @param endDate  The market's resolution date (null/undefined → short band).
   * @returns        New weights map with multipliers applied.
   */
  modifyWeights(
    weights: Record<string, number>,
    endDate: Date | null | undefined
  ): Record<string, number> {
    const band = this.getDurationBand(endDate);
    const result: Record<string, number> = {};
    for (const [signalId, weight] of Object.entries(weights)) {
      result[signalId] = weight * this.getWeightMultiplier(signalId, band);
    }
    return result;
  }

  /**
   * Merge updates into the compatibility matrix at runtime.
   *
   * Only the supplied signal rows are replaced; all others are unchanged.
   *
   * @param updates  Partial matrix with full band rows for each signal to update.
   */
  updateMatrix(updates: Partial<Record<string, BandMultipliers>>): void {
    for (const [signalId, row] of Object.entries(updates)) {
      if (row != null) {
        this.matrix[signalId] = { ...row };
      }
    }
  }

  /**
   * Return a deep copy of the current compatibility matrix.
   */
  getMatrix(): Record<string, BandMultipliers> {
    return Object.fromEntries(
      Object.entries(this.matrix).map(([k, v]) => [k, { ...v }])
    );
  }
}
