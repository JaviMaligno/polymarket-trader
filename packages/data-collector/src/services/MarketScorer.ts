import { pino } from 'pino';
import { query } from '../database/connection.js';

const logger = pino({ name: 'MarketScorer' });

// ─── Constants ─────────────────────────────────────────────────────────
export const WEIGHTS = {
  tradeability: 0.25,
  liquidity: 0.20,
  volatility: 0.15,
  ttr: 0.10,
  dataQuality: 0.10,
  typeExpectedValue: 0.20,
} as const;

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
}

export interface ScorerWeights {
  tradeability: number;
  liquidity: number;
  volatility: number;
  ttr: number;
  dataQuality: number;
  typeExpectedValue: number;
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
   * Composite score — weighted sum of dimensions.
   *
   * When volatility and/or dataQuality are null (cold markets with no
   * price_history), those dimensions are excluded and the remaining
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

    if (totalWeight === 0) return 0;
    return weightedSum / totalWeight;
  }

  // ─── Static method: load dimension weights from DB ─────────────────
  /**
   * Reads the latest row from `scorer_weights` table.
   * Falls back to hardcoded WEIGHTS if the table is empty or the query throws
   * (e.g. migration has not been applied yet).
   */
  static async loadWeights(): Promise<ScorerWeights> {
    try {
      const result = await query<{
        tradeability: number;
        liquidity: number;
        volatility: number;
        ttr: number;
        data_quality: number;
        type_expected_value?: number;
      }>(
        `SELECT tradeability, liquidity, volatility, ttr, data_quality, type_expected_value
         FROM scorer_weights
         ORDER BY id DESC LIMIT 1`,
      );
      if (result.rows.length > 0) {
        const r = result.rows[0];
        const weightsObj: ScorerWeights = {
          tradeability: r.tradeability,
          liquidity: r.liquidity,
          volatility: r.volatility,
          ttr: r.ttr,
          dataQuality: r.data_quality,
          typeExpectedValue: r.type_expected_value ?? WEIGHTS.typeExpectedValue,
        };
        const sum = weightsObj.tradeability + weightsObj.liquidity + weightsObj.volatility
                   + weightsObj.ttr + weightsObj.dataQuality + weightsObj.typeExpectedValue;
        if (Math.abs(sum - 1.0) > 0.05) {
          logger.warn({ sum, weights: weightsObj }, 'scorer_weights do not sum to 1 — using DB values anyway');
        }
        return weightsObj;
      }
    } catch {
      // Table may not exist yet (migration pending) — fall through to defaults
    }
    return { ...WEIGHTS };
  }

  // ─── Static method: load category priors from DB ─────────────────
  /**
   * Reads from `category_performance` table.
   * Returns Map<market_type, prior>.
   * Falls back to empty Map on any error (table missing, DB down, etc.).
   */
  static async loadCategoryPriors(): Promise<Map<string, number>> {
    try {
      const result = await query<{ market_type: string; prior: number }>(
        `SELECT market_type, prior FROM category_performance WHERE n_trades >= 5`,
      );
      const map = new Map<string, number>();
      for (const row of result.rows) {
        map.set(row.market_type, row.prior);
      }
      return map;
    } catch {
      return new Map();
    }
  }

  // ─── Static method: load category metrics from DB ─────────────────
  /**
   * Load current category_performance keyed by market_type.
   * Used once per scoring run to compute typeExpectedValue per market.
   * Returned numerics are coerced from pg strings.
   */
  static async loadCategoryMetrics(): Promise<Map<string, { sharpe: number | null; n: number }>> {
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
  }

  // ─── Instance method: score all markets from DB ────────────────────
  /**
   * Two-pass scoring of all active markets.
   *
   * Pass 1 — cheap dimensions (tradeability, liquidity, TTR):
   *   Reads from `markets` table for ALL active, unresolved markets.
   *   Computes composite with volatility=null, dataQuality=null.
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
    const weights = await MarketScorer.loadWeights();
    const categoryPriors = await MarketScorer.loadCategoryPriors();
    const pass1Candidates = await query<Pass1CandidateRow>(`
      SELECT condition_id,
             current_price_yes,
             volume_24h,
             spread,
             end_date,
             market_type
      FROM markets
      WHERE is_active = true
        AND is_resolved = false
        AND clob_token_id_yes IS NOT NULL
        AND tracking_status NOT IN ('warming', 'active', 'cooling')
    `);

    const pass1Updates: EnrichUpdate[] = pass1Candidates.rows.map((row) => {
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
      const prior = categoryPriors.get(row.market_type ?? '') ?? 1.0;
      const score = MarketScorer.compositeScore({
        tradeability,
        liquidity,
        volatility: null,
        ttr,
        dataQuality: null,
        typeExpectedValue: 0,
      }, weights) * prior;

      return {
        conditionId: row.condition_id,
        trackingStatus: 'cold',
        score,
        tradeability,
        liquidity,
        ttr,
        volatility: null,
        dataQuality: null,
        currentPriceYes: row.current_price_yes != null ? Number(row.current_price_yes) : null,
        volume24h: row.volume_24h != null ? Number(row.volume_24h) : null,
        marketType: row.market_type ?? null,
      };
    });

    await this.batchUpdateScores(pass1Updates);
    const scored = pass1Updates.length;
    logger.info({ scored }, 'Pass 1: scored cold markets via batched updates');

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
             s.total_bars
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

    const enrichUpdates: EnrichUpdate[] = [];

    for (const row of trackedRows) {
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

      const prior = categoryPriors.get(row.market_type ?? '') ?? 1.0;
      const score = MarketScorer.compositeScore({
        tradeability,
        liquidity,
        volatility,
        ttr,
        dataQuality,
        typeExpectedValue: 0,
      }, weights) * prior;

      enrichUpdates.push({
        conditionId: row.condition_id,
        trackingStatus: row.tracking_status,
        score,
        tradeability,
        liquidity,
        ttr,
        volatility,
        dataQuality,
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
      current_price_yes: r.current_price_yes != null ? Number(r.current_price_yes) : null,
      volume_24h: r.volume_24h != null ? Number(r.volume_24h) : null,
    }));

    const all = [...trackedRows, ...coldRows];
    if (all.length === 0) return;

    // Single multi-row INSERT
    const values = all
      .map((_, i) => {
        const base = i * 11;
        return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10},$${base+11})`;
      })
      .join(', ');

    const params = all.flatMap((r) => [
      r.time, r.condition_id, r.tracking_status,
      r.market_score, r.score_tradeability, r.score_liquidity, r.score_ttr,
      r.score_volatility, r.score_data_quality, r.current_price_yes, r.volume_24h,
    ]);

    await query(
      `INSERT INTO market_score_history
         (time, condition_id, tracking_status, market_score,
          score_tradeability, score_liquidity, score_ttr,
          score_volatility, score_data_quality, current_price_yes, volume_24h)
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
}

