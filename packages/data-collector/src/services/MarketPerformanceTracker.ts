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
           CASE WHEN m.outcome = 'Yes' THEN 1.0 ELSE 0.0 END AS resolution_price
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
