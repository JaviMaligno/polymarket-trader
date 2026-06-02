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
 * >600s timeout root cause). Idempotent via NOT EXISTS.
 *
 * SCALE LESSON (2026-06-02 deploy): the first version did one round-trip JS
 * seek per prediction. Against the real backlog (~557k rows over 8d) that melted
 * the e2-micro (load avg 19, ~2 rows materialized). This version does the work
 * SERVER-SIDE in bulk via `INSERT ... SELECT ... LEFT JOIN LATERAL`, and caps
 * each invocation at `maxBatches × batchSize` rows so the backlog drains over a
 * few hours of hourly ticks without saturating the VM. In steady state only the
 * ~hour's worth of newly-matured rows remain, so a single small batch suffices.
 *
 * Maturity rule (simplified to avoid re-selecting young no-price rows every tick):
 *  - age < horizon+4h  → not selected yet (waits for a later tick).
 *  - age ≥ horizon+4h  → written: y1 if a forward price exists, else
 *                        y1=NULL, no_forward_price=true (terminal, never retried).
 */
export async function materializePredictionOutcomes(
  opts: { horizonHours?: number; batchSize?: number; maxBatches?: number } = {},
): Promise<{ materialized: number; noPrice: number; batches: number }> {
  const horizon = opts.horizonHours ?? 4;
  const batchSize = opts.batchSize ?? 5000;
  const maxBatches = opts.maxBatches ?? 4;
  // Rows reach a verdict once the [+horizon, +horizon+1h) forward window is well
  // in the past. horizon+4h gives a comfortable margin for late-arriving prices.
  const verdictAgeHours = horizon + 4;

  let materialized = 0;
  let noPrice = 0;
  let batches = 0;

  for (let b = 0; b < maxBatches; b++) {
    const res = await query<{ no_price: boolean }>(
      `WITH batch AS (
         SELECT g.id, g.time, g.market_id, g.market_type, g.signal_id,
                g.direction, g.yes_price_at_signal
         FROM generator_predictions g
         WHERE g.time >= NOW() - INTERVAL '8 days'
           AND g.time <  NOW() - INTERVAL '${verdictAgeHours} hours'
           AND g.direction IN ('long','short')
           AND NOT EXISTS (
             SELECT 1 FROM generator_prediction_outcomes o
             WHERE o.prediction_id = g.id AND o.horizon_hours = $1
           )
         ORDER BY g.time
         LIMIT ${batchSize}
       ),
       resolved AS (
         SELECT b.*, fwd.close AS y1
         FROM batch b
         LEFT JOIN LATERAL (
           SELECT p.close FROM price_history p
           WHERE p.market_id = b.market_id
             AND p.time >= b.time + INTERVAL '${horizon} hours'
             AND p.time <  b.time + INTERVAL '${horizon + 1} hours'
           ORDER BY p.time ASC LIMIT 1
         ) fwd ON true
       ),
       ins AS (
         INSERT INTO generator_prediction_outcomes
           (prediction_id, prediction_time, market_id, market_type, signal_id,
            direction, y0, y1, horizon_hours, no_forward_price)
         SELECT id, time, market_id, market_type, signal_id, direction,
                yes_price_at_signal::numeric, y1::numeric, $1, (y1 IS NULL)
         FROM resolved
         ON CONFLICT (prediction_time, prediction_id, horizon_hours) DO NOTHING
         RETURNING no_forward_price AS no_price
       )
       SELECT no_price FROM ins`,
      [horizon],
    );

    if (res.rows.length === 0) break;
    batches++;
    for (const r of res.rows) {
      if (r.no_price) noPrice++; else materialized++;
    }
    if (res.rows.length < batchSize) break;  // backlog drained
  }

  if (batches > 0) {
    logger.info({ materialized, noPrice, batches, batchSize }, 'Prediction outcomes materialized');
  }
  return { materialized, noPrice, batches };
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
