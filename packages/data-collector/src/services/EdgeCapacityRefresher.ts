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
  // Phase 5 Pilar 1-A (2026-05-15): per-type sampling avoids the LATERAL
  // bulk-query timeout on e2-micro. Calibration found N=10k → 47-150s,
  // 14 cells visible. The original bulk query never completed for event_long
  // (122k predictions × per-row price seek).
  sampleSize?: number;  // null/undefined = no sampling (full data, legacy)
  perTypeTimeoutMs?: number;  // skip a type that exceeds this; default 300s
}

/**
 * Build the t-stat SQL for a single market_type with optional sampling.
 * Phase 5 Pilar 1-A: when sampleSize is set, we use `ORDER BY random() LIMIT N`
 * to avoid the LATERAL bulk-scan timeout on e2-micro. The price_history seek
 * still happens per sampled row (~5ms each), so cost is linear in sampleSize.
 *
 * Calibration 2026-05-15:
 *   N=1000  → 47s
 *   N=5000  → 147s
 *   N=10000 → 47-100s (cache-dependent)
 *   full event_long (~125k rows) → DNF at 60+ min
 */
function buildPerTypeSQL(marketType: string, windowDays: number, horizonHours: number, sampleSize: number | null): string {
  const sampledCTE = sampleSize
    ? `sampled AS (
         SELECT g.id, g.signal_id, g.market_type, g.direction,
                g.market_id, g.time, g.yes_price_at_signal
         FROM generator_predictions g
         WHERE g.time >= NOW() - INTERVAL '${windowDays} days'
           AND g.direction IN ('long','short')
           AND g.market_type = $1
         ORDER BY random() LIMIT ${sampleSize}
       )`
    : `sampled AS (
         SELECT g.id, g.signal_id, g.market_type, g.direction,
                g.market_id, g.time, g.yes_price_at_signal
         FROM generator_predictions g
         WHERE g.time >= NOW() - INTERVAL '${windowDays} days'
           AND g.direction IN ('long','short')
           AND g.market_type = $1
       )`;

  // Note: `${marketType}` is NOT interpolated below — it goes through $1 binding
  // to prevent SQL injection. Only numeric server-controlled values interpolate.
  return `
    WITH ${sampledCTE},
    outcomes AS (
      SELECT
        s.signal_id,
        s.market_type,
        s.direction,
        s.yes_price_at_signal::numeric AS y0,
        (
          SELECT p.close::numeric
          FROM price_history p
          WHERE p.market_id = s.market_id
            AND p.time >= s.time + INTERVAL '${horizonHours} hours'
            AND p.time <  s.time + INTERVAL '${horizonHours + 1} hours'
          ORDER BY p.time ASC LIMIT 1
        ) AS y1
      FROM sampled s
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
}

/**
 * Run the t-stat query for a single market_type, wrapped in a configurable
 * timeout. Returns null on timeout or DB error (caller logs + skips type).
 *
 * Why per-type: the original bulk query (all types in one SELECT) is dominated
 * by the slowest type, even if other types would complete quickly. Per-type
 * means event_long's slowness doesn't block crypto_intraday from refreshing.
 */
async function measureCellsForType(
  marketType: string,
  windowDays: number,
  horizonHours: number,
  sampleSize: number | null,
  timeoutMs: number,
): Promise<Cell[] | null> {
  const sql = buildPerTypeSQL(marketType, windowDays, horizonHours, sampleSize);
  const start = Date.now();
  try {
    // Race the query against a timeout. If the timeout fires first we reject
    // and the caller marks this type as skipped. The query continues running
    // in pg until it finishes or the connection is closed — acceptable since
    // event_long worst-case is ~95min which is still under the daily cycle.
    const result = await Promise.race([
      query<{
        signal_id: string;
        market_type: string;
        direction: string;
        n: number;
        gross_pct: number | null;
        t_gross: number | null;
      }>(sql, [marketType]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`per-type timeout ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
    const elapsed = Date.now() - start;
    logger.info({ marketType, n: result.rows.length, elapsedMs: elapsed }, 'measureCellsForType OK');
    return result.rows.map((r) => ({
      signal_id: r.signal_id,
      market_type: r.market_type,
      direction: r.direction as 'long' | 'short',
      n: Number(r.n),
      gross_pct: r.gross_pct == null ? 0 : Number(r.gross_pct),
      t_gross: r.t_gross == null ? null : Number(r.t_gross),
    }));
  } catch (err) {
    const elapsed = Date.now() - start;
    logger.warn({ marketType, elapsedMs: elapsed, err: (err as Error).message }, 'measureCellsForType failed/timeout');
    return null;
  }
}

/**
 * Refresh `market_type_edge_capacity` table by iterating over distinct
 * market_types with active markets, sampling N=sampleSize predictions per
 * type, and upserting the computed edge_capacity. Returns the upserted
 * entries (useful for tests + logging).
 *
 * Phase 5 Pilar 1-A (2026-05-15): rewrote from bulk-query to per-type
 * sampling. Calibrated N=10000 takes 47-150s/type on e2-micro. perTypeTimeoutMs
 * caps each type at 300s so a slow type doesn't block the others.
 */
export async function refreshEdgeCapacity(options: RefreshOptions = {}): Promise<{
  upserts: number;
  perType: Map<string, EdgeCapacityEntry>;
  skipped: string[];
}> {
  const windowDays = options.windowDays ?? 7;
  const horizonHours = options.horizonHours ?? 4;
  const defaultRt = options.defaultRtCost ?? 0.01;
  const minN = options.minN ?? 50;
  const sampleSize = options.sampleSize ?? 10000;  // Pilar 1-A default
  const perTypeTimeoutMs = options.perTypeTimeoutMs ?? 300_000;  // 5 min
  const source = options.source ??
    `EdgeCapacityRefresher cron ${new Date().toISOString().slice(0, 10)} (sample N=${sampleSize})`;

  // Discover types that have any active markets — there's no point measuring
  // a cohort with zero supply (Phase 4 lesson: crypto_intraday went from 2.14
  // edge → 0 supply in 2 days post-deploy).
  const typesRes = await query<{ market_type: string }>(
    `SELECT DISTINCT market_type
     FROM markets
     WHERE is_active = true
       AND COALESCE(is_resolved, false) = false
       AND market_type IS NOT NULL`,
  );
  const types = typesRes.rows.map((r) => r.market_type);
  logger.info({ types }, 'refreshEdgeCapacity starting per-type loop');

  const perTypeAcc = new Map<string, EdgeCapacityEntry>();
  const skipped: string[] = [];

  for (const marketType of types) {
    const cells = await measureCellsForType(marketType, windowDays, horizonHours, sampleSize, perTypeTimeoutMs);
    if (cells === null) {
      skipped.push(marketType);
      continue;
    }
    if (cells.length === 0) {
      // No measurable cells (no predictions or no forward price match).
      // Skip — don't write a misleading edge_capacity=0 when reality is "no data".
      skipped.push(marketType);
      continue;
    }
    const oneTypeMap = computeEdgeCapacity(cells, options.rtCostMap ?? null, defaultRt, minN);
    for (const [mt, entry] of oneTypeMap.entries()) {
      perTypeAcc.set(mt, entry);
    }
  }

  let upserts = 0;
  for (const [marketType, entry] of perTypeAcc.entries()) {
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
    { upserts, types: [...perTypeAcc.keys()], skipped, sampleSize, perTypeTimeoutMs },
    'edge_capacity refreshed',
  );
  return { upserts, perType: perTypeAcc, skipped };
}
