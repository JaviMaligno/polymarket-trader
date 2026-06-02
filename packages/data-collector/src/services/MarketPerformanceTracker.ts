import { pino } from 'pino';
import { query } from '../database/connection.js';

const logger = pino({ name: 'MarketPerformanceTracker' });

export const MIN_CATEGORY_TRADES = 5;

// ── Pure helpers (exported for testing) ────────────────────────────────────

/** prior = 0.5 + sigmoid(sharpe * 2), bounded [0.5, 1.5] */
export function computePrior(sharpe: number): number {
  const sigmoid = 1 / (1 + Math.exp(-sharpe * 2));
  return Math.min(1.5, Math.max(0.5, 0.5 + sigmoid));
}

// ── Main entry point ───────────────────────────────────────────────────────

export async function updateCategoryPriors(): Promise<void> {
  const result = await query<{
    market_type: string;
    n_trades: string;
    win_rate: string;
    avg_pnl: string;
    sharpe_ratio: string;
  }>(`
    SELECT m.market_type,
           COUNT(*)::text AS n_trades,
           AVG(CASE WHEN p.realized_pnl > 0 THEN 1.0 ELSE 0.0 END)::text AS win_rate,
           AVG(p.realized_pnl)::text AS avg_pnl,
           CASE WHEN STDDEV(p.realized_pnl) > 0
                THEN (AVG(p.realized_pnl) / STDDEV(p.realized_pnl))::text
                ELSE '0' END AS sharpe_ratio
    FROM paper_positions p
    JOIN markets m ON p.market_id = m.id
    WHERE p.closed_at IS NOT NULL
      AND p.realized_pnl IS NOT NULL
      AND m.market_type IS NOT NULL
    GROUP BY m.market_type
  `);

  logger.info({ categories: result.rows.length }, 'Computed category performance');

  for (const row of result.rows) {
    const nTrades = parseInt(row.n_trades, 10);
    const sharpe = parseFloat(row.sharpe_ratio);
    const prior = nTrades >= MIN_CATEGORY_TRADES ? computePrior(sharpe) : 1.0;

    await query(
      `INSERT INTO category_performance (market_type, win_rate, avg_pnl, sharpe_ratio, n_trades, prior, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (market_type) DO UPDATE SET
         win_rate = $2, avg_pnl = $3, sharpe_ratio = $4, n_trades = $5, prior = $6, updated_at = NOW()`,
      [row.market_type, parseFloat(row.win_rate), parseFloat(row.avg_pnl), sharpe, nTrades, prior],
    );

    logger.info({ market_type: row.market_type, nTrades, sharpe: sharpe.toFixed(3), prior: prior.toFixed(3) },
      'Updated category prior');
  }
}

/**
 * Resolve shadow trades whose markets have been resolved.
 * For LONG: pnl = (resolution_price - entry_price) * theoretical_size
 * For SHORT: pnl = (entry_price - resolution_price) * theoretical_size
 * Resolution price is 1.0 (YES outcome) or 0.0 (NO outcome).
 */
export async function resolveShadowTrades(): Promise<void> {
  const result = await query<{
    id: string;
    direction: string;
    entry_price: string;
    theoretical_size: string;
    resolution_price: string;
  }>(`
    SELECT st.id, st.direction, st.entry_price, st.theoretical_size,
           CASE WHEN LOWER(m.resolution_outcome) = 'yes' THEN 1.0 ELSE 0.0 END AS resolution_price
    FROM shadow_trades st
    JOIN markets m ON st.market_id = m.id
    WHERE st.resolved_at IS NULL
      AND m.is_resolved = true
  `);

  if (result.rows.length === 0) return;

  logger.info({ count: result.rows.length }, 'Resolving shadow trades');

  for (const row of result.rows) {
    const entryPrice = parseFloat(row.entry_price);
    const size = parseFloat(row.theoretical_size);
    const resolutionPrice = parseFloat(row.resolution_price);
    const pnl = row.direction === 'long'
      ? (resolutionPrice - entryPrice) * size
      : (entryPrice - resolutionPrice) * size;

    await query(
      `UPDATE shadow_trades SET resolved_at = NOW(), resolution_price = $1, theoretical_pnl = $2 WHERE id = $3`,
      [resolutionPrice, pnl, parseInt(row.id, 10)],
    );
  }

  logger.info({ resolved: result.rows.length }, 'Shadow trades resolved');
}

/**
 * Phase 5 / daily-review #297: materialize the 4h-forward outcome (y1) per
 * generator_prediction ONCE, when it matures, into generator_prediction_outcomes.
 * The nightly EdgeCapacityRefresher then reads that table instead of recomputing
 * a correlated price_history seek per sampled row over compressed chunks (the
 * >600s timeout root cause). Idempotent via NOT EXISTS; runs hourly on hot data.
 *
 * Maturity rule:
 *  - age < horizon+1h         → not selected (too young to have a forward price).
 *  - horizon+1h ≤ age < 8h, no price → left unwritten, retried next run (price
 *                              may arrive late after a transient collector gap).
 *  - age ≥ 8h, no price       → written with y1=NULL, no_forward_price=true
 *                              (processed; never retried — market stopped quoting/resolved).
 *  - price found              → written with y1, no_forward_price=false.
 */
export async function materializePredictionOutcomes(
  opts: { horizonHours?: number } = {},
): Promise<{ materialized: number; noPrice: number }> {
  const horizon = opts.horizonHours ?? 4;

  const pending = await query<{
    id: string;
    time: Date;
    market_id: string;
    market_type: string | null;
    signal_id: string;
    direction: string;
    yes_price_at_signal: string;
    age_hours: string;
  }>(
    `SELECT g.id, g.time, g.market_id, g.market_type, g.signal_id, g.direction,
            g.yes_price_at_signal,
            EXTRACT(EPOCH FROM (NOW() - g.time)) / 3600.0 AS age_hours
     FROM generator_predictions g
     WHERE g.time >= NOW() - INTERVAL '8 days'
       AND g.time <  NOW() - INTERVAL '${horizon + 1} hours'
       AND g.direction IN ('long','short')
       AND NOT EXISTS (
         SELECT 1 FROM generator_prediction_outcomes o
         WHERE o.prediction_id = g.id AND o.horizon_hours = $1
       )`,
    [horizon],
  );

  if (pending.rows.length === 0) {
    return { materialized: 0, noPrice: 0 };
  }

  logger.info({ count: pending.rows.length, horizon }, 'Materializing prediction outcomes');

  let materialized = 0;
  let noPrice = 0;

  for (const row of pending.rows) {
    try {
      const fwd = await query<{ close: number }>(
        `SELECT close::float AS close FROM price_history
         WHERE market_id = $1
           AND time >= $2::timestamptz + INTERVAL '${horizon} hours'
           AND time <  $2::timestamptz + INTERVAL '${horizon + 1} hours'
         ORDER BY time ASC LIMIT 1`,
        [row.market_id, row.time],
      );

      const y1 = fwd.rows.length > 0 ? Number(fwd.rows[0].close) : null;
      const ageHours = Number(row.age_hours);

      if (y1 === null && ageHours < 8) {
        continue;
      }

      await query(
        `INSERT INTO generator_prediction_outcomes
           (prediction_id, prediction_time, market_id, market_type, signal_id,
            direction, y0, y1, horizon_hours, no_forward_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (prediction_time, prediction_id, horizon_hours) DO NOTHING`,
        [row.id, row.time, row.market_id, row.market_type, row.signal_id,
         row.direction, Number(row.yes_price_at_signal), y1, horizon, y1 === null],
      );

      if (y1 === null) noPrice++; else materialized++;
    } catch (err) {
      logger.warn({ predictionId: row.id, err: (err as Error).message },
        'materializePredictionOutcomes: row failed (non-fatal)');
    }
  }

  logger.info({ materialized, noPrice }, 'Prediction outcomes materialized');
  return { materialized, noPrice };
}

export async function updateShadowCategoryPerformance(): Promise<void> {
  const haircutRaw = parseFloat(process.env.SHADOW_HAIRCUT ?? '0.33');
  const minN = parseInt(process.env.CATEGORY_MIN_SHADOW_N ?? '30', 10);

  if (!Number.isFinite(haircutRaw)) {
    logger.warn({ haircut: process.env.SHADOW_HAIRCUT }, 'Invalid SHADOW_HAIRCUT, falling back to 0.33');
  }
  const effectiveHaircut = Number.isFinite(haircutRaw) ? haircutRaw : 0.33;

  const result = await query<{
    market_type: string;
    n_trades: string;
    win_rate: string;
    avg_pnl: string;
    raw_sharpe: string;
  }>(`
    SELECT market_type,
           COUNT(*)::text AS n_trades,
           AVG(CASE WHEN theoretical_pnl > 0 THEN 1.0 ELSE 0.0 END)::text AS win_rate,
           AVG(theoretical_pnl)::text AS avg_pnl,
           CASE WHEN STDDEV(theoretical_pnl) > 0
                THEN (AVG(theoretical_pnl) / STDDEV(theoretical_pnl))::text
                ELSE '0' END AS raw_sharpe
    FROM shadow_trades
    WHERE resolved_at IS NOT NULL
      AND theoretical_pnl IS NOT NULL
    GROUP BY market_type
  `);

  logger.info({ categories: result.rows.length, haircut: effectiveHaircut, minN },
    'Computing shadow category performance');

  for (const row of result.rows) {
    const nTrades = parseInt(row.n_trades, 10);
    if (nTrades < minN) {
      logger.debug({ market_type: row.market_type, nTrades, minN }, 'Skipping shadow category (below MIN_N)');
      continue;
    }
    const rawSharpe = parseFloat(row.raw_sharpe);
    const effectiveSharpe = rawSharpe * effectiveHaircut;
    const prior = computePrior(effectiveSharpe);

    await query(
      `INSERT INTO category_performance_shadow
         (market_type, win_rate, avg_pnl, sharpe_ratio, n_trades, prior, haircut_applied, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (market_type) DO UPDATE SET
         win_rate = $2, avg_pnl = $3, sharpe_ratio = $4, n_trades = $5,
         prior = $6, haircut_applied = $7, updated_at = NOW()`,
      [row.market_type, parseFloat(row.win_rate), parseFloat(row.avg_pnl),
       effectiveSharpe, nTrades, prior, effectiveHaircut],
    );

    logger.info({ market_type: row.market_type, nTrades,
                  raw_sharpe: rawSharpe.toFixed(3), effective_sharpe: effectiveSharpe.toFixed(3),
                  haircut: effectiveHaircut, prior: prior.toFixed(3) },
      'Updated shadow category performance');
  }
}
