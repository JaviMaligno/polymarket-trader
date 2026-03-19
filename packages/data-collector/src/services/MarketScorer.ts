import { pino } from 'pino';
import { query } from '../database/connection.js';

const logger = pino({ name: 'MarketScorer' });

// ─── Constants ─────────────────────────────────────────────────────────
export const WEIGHTS = {
  tradeability: 0.30,
  liquidity: 0.25,
  volatility: 0.20,
  ttr: 0.15,
  dataQuality: 0.10,
} as const;

export const MAX_VOLUME_REF = 30_000_000;

const BATCH_SIZE = 500;

// ─── Types ─────────────────────────────────────────────────────────────
export interface ScoreDimensions {
  tradeability: number;
  liquidity: number;
  volatility: number | null;
  ttr: number;
  dataQuality: number | null;
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
   *   (0.45, 0.55)       → 0   (50/50 dead zone)
   *   [0.55, 0.60)       → ramp 0→1
   *   [0.60, 0.85]       → 1.0 (optimal high)
   *   (0.85, 0.95]       → ramp 1→0
   *   (0.95, 1.00]       → 0   (near-certain Yes)
   */
  static tradeabilityScore(price: number | null): number {
    if (price === null) return 0;
    if (price < 0.05 || price > 0.95) return 0;
    if (price >= 0.45 && price <= 0.55) return 0;

    // Lower half
    if (price >= 0.05 && price < 0.15) return clamp01(lerp(price, 0.05, 0.15, 0, 1));
    if (price >= 0.15 && price <= 0.40) return 1.0;
    if (price > 0.40 && price < 0.45) return clamp01(lerp(price, 0.40, 0.45, 1, 0));

    // Upper half (symmetric)
    if (price > 0.55 && price < 0.60) return clamp01(lerp(price, 0.55, 0.60, 0, 1));
    if (price >= 0.60 && price <= 0.85) return 1.0;
    if (price > 0.85 && price <= 0.95) return clamp01(lerp(price, 0.85, 0.95, 1, 0));

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
   * Composite score — weighted sum of dimensions.
   *
   * When volatility and/or dataQuality are null (cold markets with no
   * price_history), those dimensions are excluded and the remaining
   * weights are renormalized so the score stays in [0, 1].
   */
  static compositeScore(dims: ScoreDimensions): number {
    let weightedSum = 0;
    let totalWeight = 0;

    // Always-present dimensions
    weightedSum += dims.tradeability * WEIGHTS.tradeability;
    totalWeight += WEIGHTS.tradeability;

    weightedSum += dims.liquidity * WEIGHTS.liquidity;
    totalWeight += WEIGHTS.liquidity;

    weightedSum += dims.ttr * WEIGHTS.ttr;
    totalWeight += WEIGHTS.ttr;

    // Optional dimensions
    if (dims.volatility !== null) {
      weightedSum += dims.volatility * WEIGHTS.volatility;
      totalWeight += WEIGHTS.volatility;
    }

    if (dims.dataQuality !== null) {
      weightedSum += dims.dataQuality * WEIGHTS.dataQuality;
      totalWeight += WEIGHTS.dataQuality;
    }

    if (totalWeight === 0) return 0;
    return weightedSum / totalWeight;
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
    // ── Pass 1: single SQL UPDATE for cheap dimensions ──────────────
    // Computes tradeability + liquidity + TTR in pure SQL.
    // Only scores eligible candidates (tradeable price, active, unresolved).
    // Normalizes by available weights (0.30 + 0.25 + 0.15 = 0.70).
    const NORM = WEIGHTS.tradeability + WEIGHTS.liquidity + WEIGHTS.ttr;
    const pass1Result = await query(`
      UPDATE markets SET market_score = (
        ${WEIGHTS.tradeability} * CASE
          WHEN current_price_yes IS NULL THEN 0
          WHEN current_price_yes < 0.05 OR current_price_yes > 0.95 THEN 0
          WHEN current_price_yes >= 0.45 AND current_price_yes <= 0.55 THEN 0
          WHEN current_price_yes >= 0.15 AND current_price_yes <= 0.40 THEN 1.0
          WHEN current_price_yes >= 0.60 AND current_price_yes <= 0.85 THEN 1.0
          WHEN current_price_yes >= 0.05 AND current_price_yes < 0.15 THEN (current_price_yes - 0.05) / 0.10
          WHEN current_price_yes > 0.40 AND current_price_yes < 0.45 THEN (0.45 - current_price_yes) / 0.05
          WHEN current_price_yes > 0.55 AND current_price_yes < 0.60 THEN (current_price_yes - 0.55) / 0.05
          WHEN current_price_yes > 0.85 AND current_price_yes <= 0.95 THEN (0.95 - current_price_yes) / 0.10
          ELSE 0
        END
        + ${WEIGHTS.liquidity} * CASE
          WHEN volume_24h IS NULL OR volume_24h <= 0 THEN 0
          WHEN spread IS NOT NULL AND spread > 0.03 THEN LEAST(1.0, LN(volume_24h) / LN(${MAX_VOLUME_REF})) * 0.5
          ELSE LEAST(1.0, LN(volume_24h) / LN(${MAX_VOLUME_REF}))
        END
        + ${WEIGHTS.ttr} * CASE
          WHEN end_date IS NULL THEN 0.5
          WHEN end_date < NOW() THEN 0
          WHEN end_date < NOW() + INTERVAL '1 day' THEN 0.1
          WHEN end_date < NOW() + INTERVAL '7 days' THEN LEAST(1.0, 0.1 + 0.9 * (EXTRACT(EPOCH FROM end_date - NOW()) - 86400) / EXTRACT(EPOCH FROM INTERVAL '6 days'))
          WHEN end_date <= NOW() + INTERVAL '60 days' THEN 1.0
          WHEN end_date <= NOW() + INTERVAL '180 days' THEN 1.0 - 0.5 * EXTRACT(EPOCH FROM end_date - NOW() - INTERVAL '60 days') / EXTRACT(EPOCH FROM INTERVAL '120 days')
          ELSE 0.5
        END
      ) / ${NORM}
      WHERE is_active = true
        AND is_resolved = false
        AND clob_token_id_yes IS NOT NULL
    `);
    const scored = pass1Result.rowCount ?? 0;
    logger.info({ scored }, 'Pass 1: scored markets via SQL');

    // ── Pass 2: enrich tracked markets with volatility + data quality ─
    const trackedResult = await query<{
      condition_id: string;
      tracking_status: string;
      current_price_yes: number | null;
      volume_24h: number | null;
      spread: number | null;
      end_date: string | null;
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

    const enrichUpdates: Array<{
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
    }> = [];

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

      const score = MarketScorer.compositeScore({
        tradeability,
        liquidity,
        volatility,
        ttr,
        dataQuality,
      });

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
      });
    }

    // Batch update pass 2
    await this.batchUpdateScores(enrichUpdates);
    // Write score history snapshot (fire-and-forget — don't block scoring return)
    this.writeScoreHistory(enrichUpdates).catch((err) =>
      logger.warn({ err }, 'writeScoreHistory failed — non-critical'),
    );
    const enriched = enrichUpdates.length;

    logger.info({ scored, enriched }, 'Market scoring complete');
    return { scored, enriched };
  }

  // ─── Private helpers ───────────────────────────────────────────────
  private async writeScoreHistory(
    tracked: Array<{
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
    }>,
  ): Promise<void> {
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

    const coldRows = coldResult.rows.map((r) => ({
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

  private async batchUpdateScores(
    updates: Array<{ conditionId: string; score: number }>,
  ): Promise<void> {
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
