import { pino } from 'pino';
import { query } from '../database/connection.js';

const logger = pino({ name: 'MarketScorer' });

// ─── Constants ─────────────────────────────────────────────────────────
export const WEIGHTS = {
  tradeability:        0.1995,  // 0.21 × 0.95
  liquidity:           0.1615,  // 0.17 × 0.95
  volatility:          0.1425,  // 0.15 × 0.95
  ttr:                 0.0760,  // 0.08 × 0.95
  dataQuality:         0.0950,  // 0.10 × 0.95
  typeExpectedValue:   0.1615,  // 0.17 × 0.95
  realizedVolatility:  0.1140,  // 0.12 × 0.95
  shadowExpectedValue: 0.0500,  // NEW
} as const;
// Total: 1.0000

export const MAX_VOLUME_REF = 30_000_000;

const SCORER_SHRINKAGE_K: number = (() => {
  const raw = Number(process.env.SCORER_SHRINKAGE_K ?? 20);
  return Number.isFinite(raw) ? raw : 20;
})();

const BATCH_SIZE = 500;

// ─── Types ─────────────────────────────────────────────────────────────
export interface ScoreDimensions {
  tradeability: number;
  liquidity: number;
  volatility: number | null;
  ttr: number;
  dataQuality: number | null;
  typeExpectedValue: number;
  realizedVolatility: number | null;
  shadowExpectedValue: number;       // NEW — always present (0.5 neutral default)
}

export interface ScorerWeights {
  tradeability: number;
  liquidity: number;
  volatility: number;
  ttr: number;
  dataQuality: number;
  typeExpectedValue: number;
  realizedVolatility: number;
  shadowExpectedValue: number;     // NEW
}

export interface EnrichUpdate {
  conditionId: string;
  trackingStatus: string;
  score: number;
  tradeability: number;
  liquidity: number;
  ttr: number;
  volatility: number | null;
  dataQuality: number | null;
  typeExpectedValue: number;
  realizedVolatility: number | null;
  currentPriceYes: number | null;
  volume24h: number | null;
  marketType: string | null;
}

interface Pass1CandidateRow {
  condition_id: string;
  current_price_yes: number | null;
  volume_24h: number | null;
  spread: number | null;
  end_date: string | null;
  market_type: string | null;
  realized_volatility_24h: number | string | null;   // NEW
  realized_volatility_bar_count: number | null;       // NEW
}

// ─── Helper: clamp value between 0 and 1 ──────────────────────────────
function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

// ─── Helper: linear interpolation between two breakpoints ─────────────
function lerp(x: number, x0: number, x1: number, y0: number, y1: number): number {
  return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
}

// ─── MarketScorer ──────────────────────────────────────────────────────
export class MarketScorer {
  /**
   * Piecewise-linear tradeability score based on price.
   *
   * Zones (symmetric around 0.50):
   *   [0.00, 0.05)       → 0   (near-certain No)
   *   [0.05, 0.15)       → ramp 0→1
   *   [0.15, 0.40]       → 1.0 (optimal low)
   *   (0.40, 0.45]       → ramp 1→0
   *   [0.05, 0.15)       → 0.5  (extreme low — contrarian momentum)
   *   [0.15, 0.30)       → ramp 0.5→1.0
   *   [0.30, 0.70]       → 1.0  (balanced — maximum uncertainty)
   *   (0.70, 0.85]       → ramp 1.0→0.5
   *   (0.85, 0.95]       → 0.5  (extreme high — contrarian momentum)
   *   (0.95, 1.00]       → 0    (near-certain Yes)
   */
  static tradeabilityScore(price: number | null): number {
    if (price === null) return 0;
    if (price < 0.05 || price > 0.95) return 0;

    // Extreme low — tradeable with contrarian strategy
    if (price >= 0.05 && price < 0.15) return 0.5;
    // Ramp from moderate to balanced
    if (price >= 0.15 && price < 0.30) return clamp01(lerp(price, 0.15, 0.30, 0.5, 1.0));
    // Balanced zone — maximum tradeability
    if (price >= 0.30 && price <= 0.70) return 1.0;
    // Ramp from balanced to moderate
    if (price > 0.70 && price <= 0.85) return clamp01(lerp(price, 0.70, 0.85, 1.0, 0.5));
    // Extreme high — tradeable with contrarian strategy
    if (price > 0.85 && price <= 0.95) return 0.5;

    return 0;
  }

  /**
   * Liquidity score based on 24h volume (log-scaled) with spread penalty.
   *
   * - null/zero volume → 0
   * - log(volume) / log(MAX_VOLUME_REF), capped at 1.0
   * - 50% penalty if spread > 0.03
   * - null spread treated as no penalty
   */
  static liquidityScore(volume24h: number | null, spread: number | null): number {
    if (volume24h === null || volume24h <= 0) return 0;

    const raw = Math.log(volume24h) / Math.log(MAX_VOLUME_REF);
    let score = clamp01(raw);

    // Wide-spread penalty
    if (spread !== null && spread > 0.03) {
      score *= 0.5;
    }

    return score;
  }

  /**
   * Time-to-resolution score.
   *
   * Piecewise:
   *   null             → 0.5 (unknown)
   *   past             → 0   (expired)
   *   < 1 day          → 0.1 (too close)
   *   1-7 days         → ramp 0.1 → 1.0
   *   7-60 days        → 1.0 (optimal)
   *   60-180 days      → decay 1.0 → 0.5
   *   > 180 days       → 0.5 (too far out)
   */
  static ttrScore(endDate: Date | null): number {
    if (endDate === null) return 0.5;

    const now = Date.now();
    const msRemaining = endDate.getTime() - now;

    if (msRemaining <= 0) return 0;

    const daysRemaining = msRemaining / (24 * 60 * 60 * 1000);

    if (daysRemaining < 1) return 0.1;
    if (daysRemaining <= 7) return lerp(daysRemaining, 1, 7, 0.1, 1.0);
    if (daysRemaining <= 60) return 1.0;
    if (daysRemaining <= 180) return lerp(daysRemaining, 60, 180, 1.0, 0.5);
    return 0.5;
  }

  /**
   * Volatility score — Gaussian bell curve peaking at stddev ≈ 0.07.
   *
   * f(x) = exp(-((x - 0.07)^2) / (2 * 0.06^2))
   * Returns 0 for null/zero.
   */
  static volatilityScore(stddev: number | null): number {
    if (stddev === null || stddev <= 0) return 0;

    const peak = 0.07;
    const width = 0.06;
    const exponent = -((stddev - peak) ** 2) / (2 * width ** 2);
    return clamp01(Math.exp(exponent));
  }

  /**
   * Data quality score — ratio of informative bars to total bars, capped at 1.0.
   */
  static dataQualityScore(informativeBars: number, totalBars: number): number {
    if (totalBars === 0) return 0;
    return clamp01(informativeBars / totalBars);
  }

  /**
   * Map shrunk Sharpe of a market type to [0, 1] using Beta-Binomial-style
   * shrinkage. Returns 0.5 (neutral) for types with too few trades or missing
   * sharpe. The (shrunk + 1) / 1.5 mapping was sized for typical [-1, +0.5]
   * Sharpe range; recalibrate if the observed spread stays < 0.10 after a
   * training cycle. Env: SCORER_SHRINKAGE_K overrides the default K=20.
   */
  static typeExpectedValue(
    sharpe: number | null,
    nTrades: number,
    K: number = SCORER_SHRINKAGE_K,
    MIN_N: number = 5,
  ): number {
    if (!Number.isFinite(K)) K = SCORER_SHRINKAGE_K;
    if (sharpe === null || nTrades < MIN_N) return 0.5;
    const shrunk = (sharpe * nTrades) / (nTrades + K);
    return clamp01((shrunk + 1) / 1.5);
  }

  /**
   * Shadow Expected Value dimension.
   *
   * Reads the haircut-adjusted shadow Sharpe (effectiveSharpe = raw_shadow_Sharpe × SHADOW_HAIRCUT,
   * applied by the writer in MarketPerformanceTracker.updateShadowCategoryPerformance).
   * Returns 0.5 (neutral) when shadow data is insufficient (sharpe null or n_trades below MIN_N).
   *
   * Identical formula to typeExpectedValue — the only difference is the data source. Reusing the
   * same shrinkage and clamp mapping keeps both dimensions on a comparable [0, 1] scale, so the
   * weighted sum in compositeScore behaves predictably.
   */
  static shadowExpectedValue(
    effectiveSharpe: number | null,
    nTrades: number,
    K: number = SCORER_SHRINKAGE_K,
    MIN_N: number = 5,
  ): number {
    if (!Number.isFinite(K)) K = SCORER_SHRINKAGE_K;
    if (effectiveSharpe === null || nTrades < MIN_N) return 0.5;
    const shrunk = (effectiveSharpe * nTrades) / (nTrades + K);
    return clamp01((shrunk + 1) / 1.5);
  }

  /**
   * Map raw realized volatility (stddev of Δp over 24h window) to [0, 1].
   * Returns null when insufficient data (barCount < 5) — consistent with the
   * nullable contract of volatility/dataQuality. Env: REALIZED_VOL_REF
   * overrides the default VOL_REF=0.02 (a raw vol of 2 percentage points
   * maps to 1.0 on the normalized scale).
   */
  static mapRealizedVolatility(
    raw: number | null,
    barCount: number | null,
    VOL_REF: number = Number(process.env.REALIZED_VOL_REF ?? 0.02),
  ): number | null {
    if (raw === null || barCount === null || barCount < 5) return null;
    if (!Number.isFinite(VOL_REF) || VOL_REF <= 0) {
      VOL_REF = 0.02; // defensive fallback for misconfigured env
    }
    return clamp01(raw / VOL_REF);
  }

  /**
   * Composite score — weighted sum of dimensions.
   *
   * When volatility, dataQuality, and/or realizedVolatility are null (cold markets
   * with no price_history), those dimensions are excluded and the remaining
   * weights are renormalized so the score stays in [0, 1].
   */
  static compositeScore(dims: ScoreDimensions, weights: ScorerWeights = WEIGHTS): number {
    let weightedSum = 0;
    let totalWeight = 0;

    // Always-present dimensions
    weightedSum += dims.tradeability * weights.tradeability;
    totalWeight += weights.tradeability;

    weightedSum += dims.liquidity * weights.liquidity;
    totalWeight += weights.liquidity;

    weightedSum += dims.ttr * weights.ttr;
    totalWeight += weights.ttr;

    weightedSum += dims.typeExpectedValue * weights.typeExpectedValue;
    totalWeight += weights.typeExpectedValue;

    // Optional dimensions
    if (dims.volatility !== null) {
      weightedSum += dims.volatility * weights.volatility;
      totalWeight += weights.volatility;
    }

    if (dims.dataQuality !== null) {
      weightedSum += dims.dataQuality * weights.dataQuality;
      totalWeight += weights.dataQuality;
    }

    if (dims.realizedVolatility !== null) {
      weightedSum += dims.realizedVolatility * weights.realizedVolatility;
      totalWeight += weights.realizedVolatility;
    }

    if (totalWeight === 0) return 0;
    return weightedSum / totalWeight;
  }

  // ─── Per-type weights with cache + fallback ──────────────────────────────
  private static readonly GLOBAL_MARKET_TYPE = '__global__';
  private static readonly MIN_TRADES_FOR_PER_TYPE = 30;
  private static readonly WEIGHTS_CACHE_TTL_MS = 5 * 60 * 1000;

  private static weightsCache = new Map<string, { weights: ScorerWeights; loadedAt: number }>();

  /** Test hook: wipe the in-memory cache. */
  static clearWeightsCache(): void {
    MarketScorer.weightsCache.clear();
  }

  /**
   * Load the composite weights for the given market type. Falls back to the
   * '__global__' sentinel row if: (a) no per-type row exists, (b) the per-type
   * row's n_trades is below MIN_TRADES_FOR_PER_TYPE. TTL-cached for 5 minutes;
   * no explicit invalidation (a freshly retrained per-type row is picked up
   * within at most one TTL, well under the hourly scoring cadence). Falls back
   * to hardcoded WEIGHTS defaults if the DB errors.
   */
  static async loadWeights(marketType: string | null = null): Promise<ScorerWeights> {
    const key = marketType ?? MarketScorer.GLOBAL_MARKET_TYPE;
    const cached = MarketScorer.weightsCache.get(key);
    if (cached && Date.now() - cached.loadedAt < MarketScorer.WEIGHTS_CACHE_TTL_MS) {
      return cached.weights;
    }

    let weights: ScorerWeights;
    try {
      const result = await query<{
        market_type: string;
        tradeability: number | string;
        liquidity: number | string;
        volatility: number | string;
        ttr: number | string;
        data_quality: number | string;
        type_expected_value: number | string | null;
        realized_volatility: number | string | null;
        n_trades: number | null;
      }>(
        `SELECT market_type, tradeability, liquidity, volatility, ttr,
                data_quality, type_expected_value, realized_volatility, n_trades
         FROM scorer_weights
         WHERE market_type IN ($1, $2)`,
        [key, MarketScorer.GLOBAL_MARKET_TYPE],
      );

      const perType = result.rows.find(
        r => r.market_type === key && key !== MarketScorer.GLOBAL_MARKET_TYPE
          && (r.n_trades ?? 0) >= MarketScorer.MIN_TRADES_FOR_PER_TYPE,
      );
      const globalRow = result.rows.find(r => r.market_type === MarketScorer.GLOBAL_MARKET_TYPE);
      const row = perType ?? globalRow;

      weights = row
        ? {
            tradeability:        Number(row.tradeability),
            liquidity:           Number(row.liquidity),
            volatility:          Number(row.volatility),
            ttr:                 Number(row.ttr),
            dataQuality:         Number(row.data_quality),
            typeExpectedValue:   row.type_expected_value !== null
              ? Number(row.type_expected_value)
              : WEIGHTS.typeExpectedValue,
            realizedVolatility:  row.realized_volatility !== null
              ? Number(row.realized_volatility)
              : WEIGHTS.realizedVolatility,
            shadowExpectedValue: WEIGHTS.shadowExpectedValue,  // NEW — always WEIGHTS default; per-type DB override out of scope
          }
        : { ...WEIGHTS };

      MarketScorer.weightsCache.set(key, { weights, loadedAt: Date.now() });
    } catch {
      // DB unreachable or column missing (pre-migration deploy) → fall back silently.
      weights = { ...WEIGHTS };
    }

    return weights;
  }

  // ─── Static method: load category metrics from DB ─────────────────
  /**
   * Load current category_performance keyed by market_type.
   * Used once per scoring run to compute typeExpectedValue per market.
   * Returned numerics are coerced from pg strings.
   * Falls back to empty Map on any error (table missing, DB down, etc.).
   */
  static async loadCategoryMetrics(): Promise<Map<string, { sharpe: number | null; n: number }>> {
    try {
      const result = await query<{
        market_type: string;
        sharpe_ratio: number | string | null;
        n_trades: number | string;
      }>(
        `SELECT market_type, sharpe_ratio, n_trades FROM category_performance`,
      );
      const map = new Map<string, { sharpe: number | null; n: number }>();
      for (const r of result.rows) {
        map.set(r.market_type, {
          sharpe: r.sharpe_ratio !== null ? Number(r.sharpe_ratio) : null,
          n: Number(r.n_trades),
        });
      }
      return map;
    } catch {
      // Missing table or DB error → neutral typeEV (0.5) for all types.
      return new Map();
    }
  }

  // ─── Instance method: score all markets from DB ────────────────────
  /**
   * Two-pass scoring of all active markets.
   *
   * Pass 1 — cheap dimensions (tradeability, liquidity, TTR, typeExpectedValue):
   *   Reads from `markets` table for ALL active, unresolved, cold markets.
   *   Computes composite with volatility=null, dataQuality=null.
   *   Issues one UPDATE per distinct market_type (per-type weights + typeEV
   *   from category_performance) plus one fallback UPDATE for markets with
   *   NULL market_type (global weights, neutral typeEV=0.5).
   *   typeExpectedValue replaces the old category_performance.prior multiplier.
   *
   * Pass 2 — enrich tracked markets:
   *   For markets with tracking_status IN (warming, active, cooling),
   *   compute volatility + data quality from price_history.
   *   Recompute composite with full 5 dimensions.
   *
   * Updates are batched (500 rows at a time).
   *
   * @returns { scored, enriched } counts
   */
  async scoreAllMarkets(): Promise<{ scored: number; enriched: number }> {
    // Load category metrics (sharpe + n_trades per type) for typeExpectedValue computation.
    const categoryMetrics = await MarketScorer.loadCategoryMetrics();

    // Fetch all cold candidates.
    const pass1Candidates = await query<Pass1CandidateRow>(`
      SELECT condition_id,
             current_price_yes,
             volume_24h,
             spread,
             end_date,
             market_type,
             realized_volatility_24h,
             realized_volatility_bar_count
      FROM markets
      WHERE is_active = true
        AND is_resolved = false
        AND clob_token_id_yes IS NOT NULL
        AND tracking_status NOT IN ('warming', 'active', 'cooling')
    `);

    // Group candidates by market_type (null goes into its own group).
    const byType = new Map<string | null, Pass1CandidateRow[]>();
    for (const row of pass1Candidates.rows) {
      const key = row.market_type ?? null;
      if (!byType.has(key)) byType.set(key, []);
      byType.get(key)!.push(row);
    }

    let scored = 0;

    // ── Per-type UPDATEs ──────────────────────────────────────────────
    // Derive distinct types from the already-grouped candidates.
    // This eliminates the second DB round-trip and any staleness window.
    for (const [marketType, rows] of byType.entries()) {
      if (marketType === null) continue; // handled by fallback block below
      if (rows.length === 0) continue;

      const weights = await MarketScorer.loadWeights(marketType);
      const metrics = categoryMetrics.get(marketType);
      const typeEV = MarketScorer.typeExpectedValue(
        metrics?.sharpe ?? null,
        metrics?.n ?? 0,
      );

      const updates = rows.map((row) => {
        const tradeability = MarketScorer.tradeabilityScore(
          row.current_price_yes != null ? Number(row.current_price_yes) : null,
        );
        const liquidity = MarketScorer.liquidityScore(
          row.volume_24h != null ? Number(row.volume_24h) : null,
          row.spread != null ? Number(row.spread) : null,
        );
        const ttr = MarketScorer.ttrScore(
          row.end_date ? new Date(row.end_date) : null,
        );
        const realizedVolatility = MarketScorer.mapRealizedVolatility(
          row.realized_volatility_24h != null ? Number(row.realized_volatility_24h) : null,
          row.realized_volatility_bar_count,
        );
        const score = MarketScorer.compositeScore({
          tradeability,
          liquidity,
          volatility: null,
          ttr,
          dataQuality: null,
          typeExpectedValue: typeEV,
          realizedVolatility,
        }, weights);

        return {
          conditionId: row.condition_id,
          trackingStatus: 'cold',
          score,
          tradeability,
          liquidity,
          ttr,
          volatility: null,
          dataQuality: null,
          typeExpectedValue: typeEV,
          realizedVolatility,
          currentPriceYes: row.current_price_yes != null ? Number(row.current_price_yes) : null,
          volume24h: row.volume_24h != null ? Number(row.volume_24h) : null,
          marketType: row.market_type ?? null,
        } satisfies EnrichUpdate;
      });

      await this.batchUpdateScoresForType(updates, marketType, typeEV);
      scored += updates.length;
    }

    // ── Fallback UPDATE for NULL market_type ──────────────────────────
    const nullRows = byType.get(null) ?? [];
    if (nullRows.length > 0) {
      const weights = await MarketScorer.loadWeights(null);
      const typeEV = 0.5; // neutral for unknown type

      const updates = nullRows.map((row) => {
        const tradeability = MarketScorer.tradeabilityScore(
          row.current_price_yes != null ? Number(row.current_price_yes) : null,
        );
        const liquidity = MarketScorer.liquidityScore(
          row.volume_24h != null ? Number(row.volume_24h) : null,
          row.spread != null ? Number(row.spread) : null,
        );
        const ttr = MarketScorer.ttrScore(
          row.end_date ? new Date(row.end_date) : null,
        );
        const realizedVolatility = MarketScorer.mapRealizedVolatility(
          row.realized_volatility_24h != null ? Number(row.realized_volatility_24h) : null,
          row.realized_volatility_bar_count,
        );
        const score = MarketScorer.compositeScore({
          tradeability,
          liquidity,
          volatility: null,
          ttr,
          dataQuality: null,
          typeExpectedValue: typeEV,
          realizedVolatility,
        }, weights);

        return {
          conditionId: row.condition_id,
          trackingStatus: 'cold',
          score,
          tradeability,
          liquidity,
          ttr,
          volatility: null,
          dataQuality: null,
          typeExpectedValue: typeEV,
          realizedVolatility,
          currentPriceYes: row.current_price_yes != null ? Number(row.current_price_yes) : null,
          volume24h: row.volume_24h != null ? Number(row.volume_24h) : null,
          marketType: null,
        } satisfies EnrichUpdate;
      });

      await this.batchUpdateScoresForType(updates, null, typeEV);
      scored += updates.length;
    }

    logger.info({ scored }, 'Pass 1: scored cold markets via per-type batched updates');

    // ── Pass 2 — enrich tracked markets with per-type weights + typeEV ──
    const trackedResult = await query<{
      condition_id: string;
      tracking_status: string;
      current_price_yes: number | null;
      volume_24h: number | null;
      spread: number | null;
      end_date: string | null;
      market_type: string | null;
      stddev: number | null;
      informative_bars: string;
      total_bars: string;
      realized_volatility_24h: number | string | null;    // NEW
      realized_volatility_bar_count: number | null;        // NEW
    }>(`
      SELECT m.condition_id,
             m.tracking_status,
             m.current_price_yes,
             m.volume_24h,
             m.spread,
             m.end_date,
             m.market_type,
             s.price_stddev AS stddev,
             s.informative_bars,
             s.total_bars,
             m.realized_volatility_24h,
             m.realized_volatility_bar_count
      FROM   markets m
      LEFT JOIN LATERAL (
        SELECT
          STDDEV(close) AS price_stddev,
          COUNT(*) FILTER (WHERE source = 'api' OR close != prev_close) AS informative_bars,
          COUNT(*) AS total_bars
        FROM (
          SELECT close, source, LAG(close) OVER (ORDER BY time) AS prev_close
          FROM price_history
          WHERE token_id = m.clob_token_id_yes
            AND time > NOW() - INTERVAL '24 hours'
        ) sub
      ) s ON true
      WHERE  m.is_active = true
        AND  m.is_resolved = false
        AND  m.tracking_status IN ('warming', 'active', 'cooling')
    `);

    const trackedRows = trackedResult.rows;
    logger.info({ count: trackedRows.length }, 'Pass 2: enriching tracked markets');

    // Pre-warm the loadWeights cache for all distinct market_types in the tracked set.
    // Without this, serial per-row awaits would fire one DB query per new type before
    // cache hits kick in. With this, all distinct-type misses resolve in parallel.
    const distinctPass2Types = [...new Set(trackedRows.map(r => r.market_type ?? null))];
    await Promise.all(distinctPass2Types.map(t => MarketScorer.loadWeights(t)));

    const enrichUpdates: EnrichUpdate[] = [];

    for (const row of trackedRows) {
      const weights = await MarketScorer.loadWeights(row.market_type ?? null);
      const metrics = categoryMetrics.get(row.market_type ?? '');
      const typeEV = MarketScorer.typeExpectedValue(
        metrics?.sharpe ?? null,
        metrics?.n ?? 0,
      );

      const tradeability = MarketScorer.tradeabilityScore(
        row.current_price_yes != null ? Number(row.current_price_yes) : null,
      );
      const liquidity = MarketScorer.liquidityScore(
        row.volume_24h != null ? Number(row.volume_24h) : null,
        row.spread != null ? Number(row.spread) : null,
      );
      const ttr = MarketScorer.ttrScore(
        row.end_date ? new Date(row.end_date) : null,
      );
      const volatility = row.stddev != null
        ? MarketScorer.volatilityScore(Number(row.stddev))
        : null;
      const informativeBars = parseInt(row.informative_bars, 10) || 0;
      const totalBars = parseInt(row.total_bars, 10) || 0;
      const dataQuality = totalBars > 0
        ? MarketScorer.dataQualityScore(informativeBars, totalBars)
        : null;
      const realizedVolatility = MarketScorer.mapRealizedVolatility(
        row.realized_volatility_24h != null ? Number(row.realized_volatility_24h) : null,
        row.realized_volatility_bar_count,
      );

      const score = MarketScorer.compositeScore({
        tradeability,
        liquidity,
        volatility,
        ttr,
        dataQuality,
        typeExpectedValue: typeEV,
        realizedVolatility,
      }, weights);

      enrichUpdates.push({
        conditionId: row.condition_id,
        trackingStatus: row.tracking_status,
        score,
        tradeability,
        liquidity,
        ttr,
        volatility,
        dataQuality,
        typeExpectedValue: typeEV,
        realizedVolatility,
        currentPriceYes: row.current_price_yes != null ? Number(row.current_price_yes) : null,
        volume24h: row.volume_24h != null ? Number(row.volume_24h) : null,
        marketType: row.market_type ?? null,
      });
    }

    await this.batchUpdateScores(enrichUpdates);
    this.writeScoreHistory(enrichUpdates).catch((err) =>
      logger.warn({ err }, 'writeScoreHistory failed — non-critical'),
    );
    const enriched = enrichUpdates.length;

    logger.info({ scored, enriched }, 'Market scoring complete');
    return { scored, enriched };
  }
  private async writeScoreHistory(tracked: EnrichUpdate[]): Promise<void> {
    // Top 50 cold markets by score (no dimension breakdown — Pass 1 SQL doesn't return them individually)
    const coldResult = await query<{
      condition_id: string;
      market_score: number | null;
      current_price_yes: number | null;
      volume_24h: number | null;
    }>(`
      SELECT condition_id, market_score, current_price_yes, volume_24h
      FROM   markets
      WHERE  is_active = true
        AND  is_resolved = false
        AND  tracking_status = 'cold'
        AND  market_score > 0
      ORDER  BY market_score DESC
      LIMIT  50
    `);

    const now = new Date();

    const trackedRows = tracked.map((u) => ({
      time: now,
      condition_id: u.conditionId,
      tracking_status: u.trackingStatus,
      market_score: u.score,
      score_tradeability: u.tradeability,
      score_liquidity: u.liquidity,
      score_ttr: u.ttr,
      score_volatility: u.volatility,
      score_data_quality: u.dataQuality,
      score_type_expected_value: u.typeExpectedValue,
      score_realized_volatility: u.realizedVolatility,
      current_price_yes: u.currentPriceYes,
      volume_24h: u.volume24h,
    }));

    // Exclude condition_ids already in trackedRows to prevent race-window duplicates
    // (a market may transition status between Pass 2 and this query)
    const trackedIds = new Set(tracked.map((u) => u.conditionId));
    const coldRows = coldResult.rows.filter((r) => !trackedIds.has(r.condition_id)).map((r) => ({
      time: now,
      condition_id: r.condition_id,
      tracking_status: 'cold' as string | null,
      market_score: r.market_score != null ? Number(r.market_score) : null,
      score_tradeability: null as number | null,
      score_liquidity: null as number | null,
      score_ttr: null as number | null,
      score_volatility: null as number | null,
      score_data_quality: null as number | null,
      score_type_expected_value: null as number | null,
      score_realized_volatility: null as number | null,
      current_price_yes: r.current_price_yes != null ? Number(r.current_price_yes) : null,
      volume_24h: r.volume_24h != null ? Number(r.volume_24h) : null,
    }));

    const all = [...trackedRows, ...coldRows];
    if (all.length === 0) return;

    // Single multi-row INSERT (13 columns per row, plus NOW() for time)
    const values = all
      .map((_, i) => {
        const base = i * 13;
        return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10},$${base+11},$${base+12},$${base+13})`;
      })
      .join(', ');

    const params = all.flatMap((r) => [
      r.time, r.condition_id, r.tracking_status,
      r.market_score, r.score_tradeability, r.score_liquidity, r.score_ttr,
      r.score_volatility, r.score_data_quality, r.score_type_expected_value,
      r.score_realized_volatility,
      r.current_price_yes, r.volume_24h,
    ]);

    await query(
      `INSERT INTO market_score_history
         (time, condition_id, tracking_status, market_score,
          score_tradeability, score_liquidity, score_ttr,
          score_volatility, score_data_quality, score_type_expected_value,
          score_realized_volatility,
          current_price_yes, volume_24h)
       VALUES ${values}`,
      params,
    );

    logger.info({ tracked: trackedRows.length, cold: coldRows.length }, 'Score history written');
  }

  private async batchUpdateScores(updates: EnrichUpdate[]): Promise<void> {
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE);

      // Build a VALUES list for a single UPDATE ... FROM (VALUES ...) statement
      const values = batch
        .map((u, idx) => `($${idx * 2 + 1}, $${idx * 2 + 2}::double precision)`)
        .join(', ');
      const params = batch.flatMap((u) => [u.conditionId, u.score]);

      await query(
        `UPDATE markets AS m
         SET    market_score = v.score
         FROM   (VALUES ${values}) AS v(condition_id, score)
         WHERE  m.condition_id = v.condition_id`,
        params,
      );
    }
  }

  /**
   * Per-type variant of batchUpdateScores used by Pass 1.
   *
   * Embeds the market_type scope in the WHERE clause so each UPDATE only
   * touches markets of that type. Uses parameter binding for market_type:
   * NULL matches via ($1::text IS NULL); non-null values match on equality.
   *
   * For the NULL market_type fallback, marketType is null — the clause
   * evaluates to true only for rows with market_type IS NULL.
   */
  private async batchUpdateScoresForType(
    updates: EnrichUpdate[],
    marketType: string | null,
    typeEV: number,
  ): Promise<void> {
    // Use parameter binding for market_type. NULL matches NULL via the
    // ($1::text IS NULL) branch; non-null values match on equality.
    const typeClauseParameterized = `AND ($1::text IS NULL OR m.market_type = $1)`;

    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE);

      // The type param is prepended as $1; condition_id/score pairs shift to $2..$2N+1.
      const values = batch
        .map((u, idx) => `($${idx * 2 + 2}, $${idx * 2 + 3}::double precision)`)
        .join(', ');
      const params: unknown[] = [marketType, ...batch.flatMap((u) => [u.conditionId, u.score])];

      logger.debug({ marketType, typeEV, batchSize: batch.length }, 'Pass 1 per-type batch update');

      await query(
        `UPDATE markets AS m
         SET    market_score = v.score
         FROM   (VALUES ${values}) AS v(condition_id, score)
         WHERE  m.condition_id = v.condition_id
           ${typeClauseParameterized}`,
        params,
      );
    }
  }
}

