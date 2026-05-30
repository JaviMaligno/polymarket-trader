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
 * Build the t-stat SQL for a single market_type with optional sampling.
 *
 * Sampling method (2026-05-30, replaces the original `ORDER BY random() LIMIT N`):
 * single-scan Bernoulli. The old approach materialised every row in the window,
 * assigned random() to each, and top-N sorted — an O(N log N) sort that on the
 * e2-micro (small work_mem) spilled to disk and blew past the 300s timeout for
 * all types on 2026-05-30 (#288 raised the cap; this removes the fixed cost).
 *
 * Instead we keep each row independently with probability `sampleSize / |slice|`
 * (capped at 1.0), where `|slice|` is a one-shot scalar COUNT(*) of the same
 * window/type/direction filter (a non-correlated InitPlan, evaluated once). No
 * sort, no full materialisation — two sequential scans of cost O(N). The sample
 * size is ~Binomial(|slice|, p) so it varies by ~√(Np(1-p)) (≈±1% at N=10k),
 * statistically equivalent to without-replacement sampling for the t-stat.
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
           AND random() < LEAST(1.0, ${sampleSize}::float / GREATEST((
             SELECT COUNT(*) FROM generator_predictions gp
             WHERE gp.time >= NOW() - INTERVAL '${windowDays} days'
               AND gp.direction IN ('long','short')
               AND gp.market_type = $1
           )::float, 1))
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
 * - `EDGE_REFRESH_SAMPLE_SIZE` (default 10000) — predictions sampled per type.
 * - `EDGE_REFRESH_PER_TYPE_TIMEOUT_MS` (default 600000) — per-type query cap;
 *   raised from 300s after the 2026-05-30 stall (#284 DB contention).
 */
export function resolveEdgeRefreshConfig(
  env: Record<string, string | undefined> = process.env,
): { sampleSize: number; perTypeTimeoutMs: number } {
  const posIntOr = (raw: string | undefined, def: number): number => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
  };
  return {
    sampleSize: posIntOr(env.EDGE_REFRESH_SAMPLE_SIZE, 10000),
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
  const sampleSize = options.sampleSize ?? 10000;  // Pilar 1-A default
  // Default raised 300s → 600s on 2026-05-30: all 4 types timed out at 300s
  // under DB contention (cf #284), yielding upserts:0 → generator_edge stale
  // ~33h. The per-type cost is dominated by `ORDER BY random()` over the full
  // window (calibration: N=1000 ≈ N=10000 ≈ 47s), so a higher cap — not a
  // smaller sample — is the right lever; lowering sampleSize would only cut
  // statistical power. See resolveEdgeRefreshConfig for the env overrides.
  const perTypeTimeoutMs = options.perTypeTimeoutMs ?? 600_000;  // 10 min
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

    // Phase 5 Pilar 1-B (2026-05-15): persist per-cell measurements to
    // generator_edge for trending. Append-only — every refresh adds rows so
    // we can answer "is X cell drifting positive over the last 30d?".
    // Best-effort; failure to insert one row should NOT abort the type.
    const rtForType = options.rtCostMap?.get(marketType) ?? defaultRt;
    await persistCellsToHistory(
      cells, rtForType, windowDays, horizonHours, sampleSize, source, minN,
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
    { upserts, types: [...perTypeAcc.keys()], skipped, sampleSize, perTypeTimeoutMs },
    'edge_capacity refreshed',
  );
  return { upserts, perType: perTypeAcc, skipped };
}
