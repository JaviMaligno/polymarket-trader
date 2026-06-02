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
  perTypeTimeoutMs?: number;  // skip a type that exceeds this; default 300s
  // If non-empty, only measure types in this list — skips non-traded types
  // (e.g. event_long) that always time out and waste the nightly cron window.
  // When empty/undefined, all active types are measured (backward compat).
  allowedTypes?: string[];
}

/**
 * Phase 5 Pilar 1-B: persist every cell measurement into `generator_edge`
 * (append-only). One row per (signal, type, direction) — captures the raw
 * t_gross + computed t_net + sample_size at this measurement time. Lets
 * downstream queries trend a specific cell over time (instead of just
 * snapshotting the per-type aggregate in market_type_edge_capacity).
 *
 * Skipped: cells under minN are dropped (insufficient stat power, would
 * just add noise to trends). Cells with gross=0 are kept (zero-information
 * but documents that we measured + got nothing — useful for "is X cell
 * still flat?" queries).
 */
async function persistCellsToHistory(
  cells: Cell[],
  rtCost: number,
  windowDays: number,
  horizonHours: number,
  sampleSize: number | null,
  source: string,
  minN: number,
): Promise<void> {
  const rtPct = rtCost * 100;
  for (const c of cells) {
    if (c.n < minN) continue;
    // t_net = t_gross × (gross_pct - rt_cost_pct) / gross_pct. Edge cases:
    // gross_pct=0 → t_net=0; t_gross=null → t_net=null.
    let tNet: number | null = null;
    if (c.t_gross != null && c.gross_pct !== 0) {
      tNet = c.t_gross * (c.gross_pct - rtPct) / c.gross_pct;
    } else if (c.t_gross != null && c.gross_pct === 0) {
      tNet = 0;
    }
    await query(
      `INSERT INTO generator_edge
         (signal_id, market_type, direction, window_days, horizon_hours,
          sample_size, n, gross_pct, t_gross, rt_cost_pct, t_net, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [c.signal_id, c.market_type, c.direction, windowDays, horizonHours,
       sampleSize, c.n, c.gross_pct, c.t_gross, rtPct, tNet, source],
    );
  }
}

/**
 * Build the t-stat SQL for a single market_type, reading the precomputed
 * generator_prediction_outcomes table (daily-review #297). No price_history
 * seek, no sampling — the table is small and index-served by
 * idx_gpo_type_dir_time. gross_edge uses y0/y1 already present per row.
 *
 * `${marketType}` is NOT interpolated — it binds through $1. Only numeric
 * server-controlled values (windowDays, horizonHours) interpolate.
 */
function buildPerTypeSQL(marketType: string, windowDays: number, horizonHours: number): string {
  return `
    WITH edges AS (
      SELECT signal_id, market_type, direction,
             CASE WHEN direction='long' THEN y1 - y0 ELSE y0 - y1 END AS gross_edge
      FROM generator_prediction_outcomes
      WHERE prediction_time >= NOW() - INTERVAL '${windowDays} days'
        AND market_type = $1
        AND direction IN ('long','short')
        AND horizon_hours = ${horizonHours}
        AND y1 IS NOT NULL
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
  timeoutMs: number,
): Promise<Cell[] | null> {
  const sql = buildPerTypeSQL(marketType, windowDays, horizonHours);
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
/**
 * Phase 5 Pilar 1-B reporting helper: latest measurement per (signal, type,
 * direction) cell, with t_net > 0 indicating cost-aware positive edge. Used
 * by Pilar 4-A health-of-edge daily-review queries to answer "what cohorts
 * currently have measurable edge?".
 *
 * Returns rows ordered by t_net DESC NULLS LAST so the most-positive cells
 * appear first. Includes ALL measured cells (positive, zero, negative) —
 * caller filters by t_net > 0 if they want only "edge" cells.
 */
export async function getLatestEdgePerCell(): Promise<Array<{
  signal_id: string;
  market_type: string;
  direction: string;
  n: number;
  gross_pct: number | null;
  t_gross: number | null;
  t_net: number | null;
  rt_cost_pct: number;
  measured_at: Date;
}>> {
  const res = await query<{
    signal_id: string;
    market_type: string;
    direction: string;
    n: number;
    gross_pct: number | null;
    t_gross: number | null;
    t_net: number | null;
    rt_cost_pct: number;
    measured_at: Date;
  }>(
    `SELECT DISTINCT ON (signal_id, market_type, direction)
       signal_id, market_type, direction, n, gross_pct, t_gross, t_net,
       rt_cost_pct, measured_at
     FROM generator_edge
     ORDER BY signal_id, market_type, direction, measured_at DESC`,
  );
  return res.rows
    .map((r) => ({
      signal_id: r.signal_id,
      market_type: r.market_type,
      direction: r.direction,
      n: Number(r.n),
      gross_pct: r.gross_pct == null ? null : Number(r.gross_pct),
      t_gross: r.t_gross == null ? null : Number(r.t_gross),
      t_net: r.t_net == null ? null : Number(r.t_net),
      rt_cost_pct: Number(r.rt_cost_pct),
      measured_at: r.measured_at,
    }))
    .sort((a, b) => (b.t_net ?? -Infinity) - (a.t_net ?? -Infinity));
}

/**
 * Resolve the env-overridable knobs for the nightly refresh. Pure (env in →
 * config out) so it is unit-testable without process/timing mocks. Invalid
 * values (non-numeric, ≤0) fall back to the calibrated defaults.
 *
 * - `EDGE_REFRESH_PER_TYPE_TIMEOUT_MS` (default 600000) — per-type query cap.
 *   A safety backstop only: now that the per-type query reads the precomputed
 *   generator_prediction_outcomes table (no price_history seek, no sampling),
 *   it is no longer the binding constraint.
 */
export function resolveEdgeRefreshConfig(
  env: Record<string, string | undefined> = process.env,
): { perTypeTimeoutMs: number } {
  const posIntOr = (raw: string | undefined, def: number): number => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
  };
  return {
    perTypeTimeoutMs: posIntOr(env.EDGE_REFRESH_PER_TYPE_TIMEOUT_MS, 600_000),
  };
}

export async function refreshEdgeCapacity(options: RefreshOptions = {}): Promise<{
  upserts: number;
  perType: Map<string, EdgeCapacityEntry>;
  skipped: string[];
}> {
  const windowDays = options.windowDays ?? 7;
  const horizonHours = options.horizonHours ?? 4;
  const defaultRt = options.defaultRtCost ?? 0.01;
  const minN = options.minN ?? 50;
  const perTypeTimeoutMs = options.perTypeTimeoutMs ?? 600_000;  // 10 min
  const source = options.source ??
    `EdgeCapacityRefresher cron ${new Date().toISOString().slice(0, 10)} (full)`;

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
  let types = typesRes.rows.map((r) => r.market_type);
  if (options.allowedTypes && options.allowedTypes.length > 0) {
    const allowed = new Set(options.allowedTypes);
    types = types.filter((t) => allowed.has(t));
  }
  logger.info({ types }, 'refreshEdgeCapacity starting per-type loop');

  const perTypeAcc = new Map<string, EdgeCapacityEntry>();
  const skipped: string[] = [];

  for (const marketType of types) {
    const cells = await measureCellsForType(marketType, windowDays, horizonHours, perTypeTimeoutMs);
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

    // Phase 5 Pilar 1-B (2026-05-15): persist per-cell measurements to
    // generator_edge for trending. Append-only — every refresh adds rows so
    // we can answer "is X cell drifting positive over the last 30d?".
    // Best-effort; failure to insert one row should NOT abort the type.
    const rtForType = options.rtCostMap?.get(marketType) ?? defaultRt;
    await persistCellsToHistory(
      cells, rtForType, windowDays, horizonHours, null, source, minN,
    ).catch((err) => {
      logger.warn({ marketType, err: (err as Error).message }, 'persistCellsToHistory failed (non-fatal)');
    });

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
    { upserts, types: [...perTypeAcc.keys()], skipped, perTypeTimeoutMs },
    'edge_capacity refreshed',
  );
  return { upserts, perType: perTypeAcc, skipped };
}
