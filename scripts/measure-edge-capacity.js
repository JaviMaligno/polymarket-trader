#!/usr/bin/env node
/**
 * Phase 4 — Measure per-(market_type) edge_capacity from generator_predictions
 * and upsert into market_type_edge_capacity. Run nightly via Scheduler.ts
 * (Phase 4 PR-D) or ad-hoc.
 *
 * edge_capacity = Σ max(0, t_net) across (signal_id, direction) cells for the
 * market_type, where:
 *   t_gross = AVG(gross_edge) × √n / STDDEV(gross_edge)
 *   t_net   = t_gross × (gross_pct − rt_cost_pct) / gross_pct
 *   gross_edge = (y1 − y0) for long, (y0 − y1) for short
 *   y0 = yes_price_at_signal, y1 = price 4h forward
 *
 * Each market_type aggregates positive net-t-stat cells (signals where the
 * forward drift exceeds round-trip cost). Anti-edge cells contribute 0 (not
 * negative — they don't subtract from positive cells; they just don't add).
 *
 * Source of round-trip cost per market_type:
 *   - If --rt-cost-json: JSON map { market_type: rt_cost_fraction }
 *   - Else: --default-rt (default 0.01 = 1%)
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/measure-edge-capacity.js \
 *     [--window 7d] [--horizon 4h] [--rt-cost-json data/rt-cost.json] \
 *     [--default-rt 0.01] [--min-n 50] [--source LABEL] [--dry-run]
 *
 * Flags:
 *   --window 7d        Lookback for generator_predictions. Default 7d.
 *   --horizon 4h       Forward price horizon (matches MAX_HOLD_TIME_HOURS).
 *   --rt-cost-json     Per-(market_type) cost map. From measure-rt-cost.js --format=json.
 *   --default-rt 0.01  Fallback when type has no rt_cost row. 1% conservative.
 *   --min-n 50         Skip cells with fewer than N observations.
 *   --source LABEL     Provenance string written to upsert row.
 *   --dry-run          Print planned upserts without persisting.
 */
const { Pool } = require('pg');
const fs = require('fs');

function parseArgs(argv) {
  const args = {
    window: '7d',
    horizon: '4h',
    rtCostJson: null,
    defaultRt: 0.01,
    minN: 50,
    source: 'measure-edge-capacity.js',
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--window') args.window = argv[++i];
    else if (k === '--horizon') args.horizon = argv[++i];
    else if (k === '--rt-cost-json') args.rtCostJson = argv[++i];
    else if (k === '--default-rt') args.defaultRt = parseFloat(argv[++i]);
    else if (k === '--min-n') args.minN = parseInt(argv[++i], 10);
    else if (k === '--source') args.source = argv[++i];
    else if (k === '--dry-run') args.dryRun = true;
  }
  return args;
}

function intervalLiteral(s) {
  const m = String(s).match(/^(\d+)([dh])$/);
  if (!m) throw new Error(`Invalid window/horizon: ${s}`);
  return `INTERVAL '${m[1]} ${m[2] === 'd' ? 'days' : 'hours'}'`;
}

/**
 * Compute per-market_type edge_capacity from the array of cell rows returned
 * by the t-stat SQL. Each row has { signal_id, market_type, direction, n,
 * gross_pct, t_gross }. We compute t_net per cell using the per-type rt_cost
 * map (falling back to defaultRt) and sum max(0, t_net) per market_type.
 *
 * Skips cells where gross_pct is 0 (no information — static midpoints) and
 * where n < minN (insufficient statistical power).
 */
function computeEdgeCapacity(cells, rtCostMap, defaultRt, minN) {
  const perType = new Map();  // market_type → { sum, positive, measured, rt }
  for (const c of cells) {
    if (c.n < minN) continue;
    const rt = (rtCostMap && rtCostMap[c.market_type] != null)
      ? Number(rtCostMap[c.market_type])
      : defaultRt;
    if (!perType.has(c.market_type)) {
      perType.set(c.market_type, { sum: 0, positive: 0, measured: 0, rt });
    }
    const entry = perType.get(c.market_type);
    entry.measured++;
    // Zero-information cell (gross=0, static midpoint) → contributes 0.
    if (c.gross_pct === 0 || c.t_gross === 0 || c.t_gross == null) continue;
    const tNet = c.t_gross * (c.gross_pct - rt * 100) / c.gross_pct;
    if (tNet > 0) {
      entry.sum += tNet;
      entry.positive++;
    }
  }
  return perType;
}

async function main() {
  const args = parseArgs(process.argv);
  const rtCostMap = args.rtCostJson ? JSON.parse(fs.readFileSync(args.rtCostJson, 'utf-8')) : null;
  const windowSql = intervalLiteral(args.window);
  const horizonSql = intervalLiteral(args.horizon);
  const horizonHi = intervalLiteral(args.horizon.replace(/(\d+)([dh])/, (_, n, u) =>
    `${parseInt(n, 10) + 1}${u}`));

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    // Query cells (signal × type × direction) with per-cell t_gross + n + gross_pct.
    // This is the same shape as scripts/p2-tstat.js but aggregated for edge_capacity.
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
              AND p.time >= g.time + ${horizonSql}
              AND p.time <  g.time + ${horizonHi}
            ORDER BY p.time ASC
            LIMIT 1
          ) AS y1
        FROM generator_predictions g
        WHERE g.time >= NOW() - ${windowSql}
          AND g.direction IN ('long','short')
      ),
      edges AS (
        SELECT signal_id, market_type, direction,
               CASE WHEN direction='long' THEN y1 - y0 ELSE y0 - y1 END AS gross_edge
        FROM outcomes WHERE y1 IS NOT NULL
      )
      SELECT
        signal_id, market_type, direction,
        COUNT(*) AS n,
        (AVG(gross_edge) * 100)::float AS gross_pct,
        CASE WHEN STDDEV(gross_edge) > 0 THEN
          (AVG(gross_edge) * SQRT(COUNT(*)) / STDDEV(gross_edge))::float
        END AS t_gross
      FROM edges
      GROUP BY 1, 2, 3
    `;
    const res = await pool.query(sql);
    const cells = res.rows.map((r) => ({
      signal_id: r.signal_id,
      market_type: r.market_type,
      direction: r.direction,
      n: Number(r.n),
      gross_pct: r.gross_pct == null ? 0 : Number(r.gross_pct),
      t_gross: r.t_gross == null ? null : Number(r.t_gross),
    }));

    const perType = computeEdgeCapacity(cells, rtCostMap, args.defaultRt, args.minN);

    // Report
    console.log('');
    console.log(`edge_capacity per market_type (window=${args.window}, horizon=${args.horizon}, min_n=${args.minN}, default_rt=${args.defaultRt}):`);
    console.log('-'.repeat(96));
    console.log(
      [
        'market_type'.padEnd(20),
        'edge_capacity'.padStart(14),
        'positive_cells'.padStart(15),
        'measured_cells'.padStart(15),
        'rt_pct'.padStart(8),
      ].join(' | ')
    );
    console.log('-'.repeat(96));
    const upserts = [];
    for (const [mt, e] of perType.entries()) {
      console.log(
        [
          mt.padEnd(20),
          e.sum.toFixed(4).padStart(14),
          String(e.positive).padStart(15),
          String(e.measured).padStart(15),
          (e.rt * 100).toFixed(2).padStart(8),
        ].join(' | ')
      );
      upserts.push({ market_type: mt, edge_capacity: e.sum, positive: e.positive, measured: e.measured, rt: e.rt });
    }
    console.log('-'.repeat(96));

    if (args.dryRun) {
      console.log('\n(dry-run — no writes applied)');
      return;
    }

    for (const u of upserts) {
      await pool.query(
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
        [u.market_type, u.edge_capacity, u.positive, u.measured, u.rt * 100, args.source]
      );
    }
    console.log(`\nUpserted: ${upserts.length} market_type rows.`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Error:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { computeEdgeCapacity };
