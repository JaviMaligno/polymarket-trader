/**
 * Phase 4 PR-D — Nightly refresh of `market_type_edge_capacity` from
 * `generator_predictions` × `price_history` 4h-forward drift, minus
 * per-(market_type) round-trip cost.
 *
 * Same formula as `scripts/measure-edge-capacity.js` (the ad-hoc CLI tool).
 * Ported here as a TS service so `Scheduler.ts` can call it directly via
 * `cron.schedule` without spawning a subprocess (saves ~50MB of overhead
 * on the e2-micro VM).
 *
 * Cron schedule: nightly at 02:30 UTC, just before `compute-market-priors`
 * (02:45). MarketScorer reads `market_type_edge_capacity` on each
 * `scoreAllMarkets` call (hourly at :17), so the next scoring run after
 * the refresh picks up the new values automatically.
 */
import { pino } from 'pino';
import { query } from '../database/connection.js';

const logger = pino({ name: 'EdgeCapacityRefresher' });

interface Cell {
  signal_id: string;
  market_type: string;
  direction: 'long' | 'short';
  n: number;
  gross_pct: number;
  t_gross: number | null;
}

interface EdgeCapacityEntry {
  sum: number;
  positive: number;
  measured: number;
  rt: number;
}

/**
 * Compute edge_capacity per market_type from a flat list of cell measurements.
 * Mirrors the JS computeEdgeCapacity in scripts/measure-edge-capacity.js so
 * unit tests cover both paths identically. Pure function.
 */
export function computeEdgeCapacity(
  cells: Cell[],
  rtCostMap: Map<string, number> | null,
  defaultRt: number,
  minN: number,
): Map<string, EdgeCapacityEntry> {
  const perType = new Map<string, EdgeCapacityEntry>();
  for (const c of cells) {
    if (c.n < minN) continue;
    const rt = rtCostMap?.has(c.market_type) ? rtCostMap.get(c.market_type)! : defaultRt;
    if (!perType.has(c.market_type)) {
      perType.set(c.market_type, { sum: 0, positive: 0, measured: 0, rt });
    }
    const entry = perType.get(c.market_type)!;
    entry.measured++;
    if (c.gross_pct === 0 || c.t_gross == null || c.t_gross === 0) continue;
    const tNet = c.t_gross * (c.gross_pct - rt * 100) / c.gross_pct;
    if (tNet > 0) {
      entry.sum += tNet;
      entry.positive++;
    }
  }
  return perType;
}

export interface RefreshOptions {
  windowDays?: number;
  horizonHours?: number;
  defaultRtCost?: number;  // fraction (e.g. 0.0108 = 1.08%)
  rtCostMap?: Map<string, number>;
  minN?: number;
  source?: string;
}

/**
 * Refresh `market_type_edge_capacity` table for all market_types with enough
 * generator_predictions in the window. Returns the upserted entries (useful
 * for tests + logging).
 */
export async function refreshEdgeCapacity(options: RefreshOptions = {}): Promise<{
  upserts: number;
  perType: Map<string, EdgeCapacityEntry>;
}> {
  const windowDays = options.windowDays ?? 7;
  const horizonHours = options.horizonHours ?? 4;
  const defaultRt = options.defaultRtCost ?? 0.01;
  const minN = options.minN ?? 50;
  const source = options.source ?? `EdgeCapacityRefresher cron ${new Date().toISOString().slice(0, 10)}`;

  // The SQL mirrors scripts/measure-edge-capacity.js. Plain string interpolation
  // is fine here because windowDays / horizonHours are server-controlled
  // integers. We keep the LATERAL-style correlated subquery — slow on e2-micro
  // (event_long timed out at 60+ min on 2026-05-13) but acceptable nightly.
  // event_long would need a CAGG rewrite for production; tracked in
  // project_phase4_deferred.md.
  const sql = `
    WITH outcomes AS (
      SELECT
        g.signal_id,
        g.market_type,
        g.direction,
        g.yes_price_at_signal::numeric AS y0,
        (
          SELECT p.close::numeric
          FROM price_history p
          WHERE p.market_id = g.market_id
            AND p.time >= g.time + INTERVAL '${horizonHours} hours'
            AND p.time <  g.time + INTERVAL '${horizonHours + 1} hours'
          ORDER BY p.time ASC LIMIT 1
        ) AS y1
      FROM generator_predictions g
      WHERE g.time >= NOW() - INTERVAL '${windowDays} days'
        AND g.direction IN ('long','short')
    ),
    edges AS (
      SELECT signal_id, market_type, direction,
             CASE WHEN direction='long' THEN y1 - y0 ELSE y0 - y1 END AS gross_edge
      FROM outcomes WHERE y1 IS NOT NULL
    )
    SELECT
      signal_id, market_type, direction,
      COUNT(*)::int AS n,
      (AVG(gross_edge) * 100)::float AS gross_pct,
      CASE WHEN STDDEV(gross_edge) > 0 THEN
        (AVG(gross_edge) * SQRT(COUNT(*)) / STDDEV(gross_edge))::float
      END AS t_gross
    FROM edges
    GROUP BY 1, 2, 3
  `;

  const res = await query<{
    signal_id: string;
    market_type: string;
    direction: string;
    n: number;
    gross_pct: number | null;
    t_gross: number | null;
  }>(sql);

  const cells: Cell[] = res.rows.map((r) => ({
    signal_id: r.signal_id,
    market_type: r.market_type,
    direction: r.direction as 'long' | 'short',
    n: Number(r.n),
    gross_pct: r.gross_pct == null ? 0 : Number(r.gross_pct),
    t_gross: r.t_gross == null ? null : Number(r.t_gross),
  }));

  const perType = computeEdgeCapacity(cells, options.rtCostMap ?? null, defaultRt, minN);

  let upserts = 0;
  for (const [marketType, entry] of perType.entries()) {
    await query(
      `INSERT INTO market_type_edge_capacity
         (market_type, edge_capacity, n_cells_positive, n_cells_measured, rt_cost_pct, source, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (market_type) DO UPDATE SET
         edge_capacity    = EXCLUDED.edge_capacity,
         n_cells_positive = EXCLUDED.n_cells_positive,
         n_cells_measured = EXCLUDED.n_cells_measured,
         rt_cost_pct      = EXCLUDED.rt_cost_pct,
         source           = EXCLUDED.source,
         updated_at       = NOW()`,
      [marketType, entry.sum, entry.positive, entry.measured, entry.rt * 100, source],
    );
    upserts++;
  }

  logger.info(
    { upserts, types: [...perType.keys()] },
    'edge_capacity refreshed',
  );
  return { upserts, perType };
}
