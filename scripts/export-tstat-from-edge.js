#!/usr/bin/env node
/**
 * Export the latest per-(signal, market_type, direction) cost-aware t-stat
 * measurement from `generator_edge` into the JSON shape that
 * `scripts/seed-per-direction-weights.js` consumes.
 *
 * Use case: close `project_per_direction_weights_gap` Gap B
 * (crypto_daily + event_long were never seeded because the original input
 * file `data/cost-aware-tstat-2026-05-13.json` only covered crypto_intraday,
 * event_financial, event_short). `EdgeCapacityRefresher` measures all types
 * nightly into `generator_edge`, so the data already exists — this script
 * just lifts it into the seed's input format. After 2026-05-13, this is the
 * preferred way to refresh the seed (the original measurement queries via
 * `tmp-tstat-focused.sql` were ad-hoc; this is the cron's measurement).
 *
 * Output mirrors `data/cost-aware-tstat-2026-05-13.json`:
 *
 *   { _meta: { ... }, cells: [ { signal_id, market_type, direction, n, gross_pct, t_gross } ] }
 *
 * Also writes a sibling `rt-cost-YYYY-MM-DD.json` so the seed can map per-type
 * round-trip cost (the cron measures per-type RT cost into
 * `generator_edge.rt_cost_pct`).
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/export-tstat-from-edge.js \
 *     --out data/cost-aware-tstat-2026-05-28.json \
 *     [--rt-out data/rt-cost-2026-05-28.json] \
 *     [--types crypto_daily,event_long] \
 *     [--lookback-hours 48]
 *
 * Flags:
 *   --out PATH            Output JSON path (required).
 *   --rt-out PATH         Companion RT-cost JSON path. Default: alongside --out.
 *   --types LIST          Comma-separated market_types. Default: all in table.
 *   --lookback-hours N    Window for "latest measurement". Default 48.
 *   --min-n N             Drop cells with n < N. Default 30.
 *
 * Exit:
 *   0 — wrote both files.
 *   1 — error.
 */
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {
    out: null,
    rtOut: null,
    types: null,
    lookbackHours: 48,
    minN: 30,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--out') args.out = argv[++i];
    else if (k === '--rt-out') args.rtOut = argv[++i];
    else if (k === '--types') args.types = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--lookback-hours') args.lookbackHours = parseInt(argv[++i], 10);
    else if (k === '--min-n') args.minN = parseInt(argv[++i], 10);
  }
  if (!args.out) {
    console.error('Error: --out <path> is required.');
    process.exit(1);
  }
  if (!args.rtOut) {
    const dir = path.dirname(args.out);
    const base = path.basename(args.out).replace(/^cost-aware-tstat-/, 'rt-cost-');
    args.rtOut = path.join(dir, base);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const params = [args.lookbackHours, args.minN];
    let typeFilter = '';
    if (args.types && args.types.length > 0) {
      params.push(args.types);
      typeFilter = ` AND market_type = ANY($${params.length}::text[])`;
    }

    // Take the LATEST measurement per cell within the lookback window —
    // the cron writes a new row per cell each night, so duplicates are
    // expected. DISTINCT ON + ORDER BY measured_at DESC keeps the freshest.
    const cellsRes = await pool.query(
      `SELECT DISTINCT ON (signal_id, market_type, direction)
         signal_id, market_type, direction, n, gross_pct, t_gross, t_net,
         rt_cost_pct, window_days, horizon_hours, measured_at, source
       FROM generator_edge
       WHERE measured_at > NOW() - ($1 || ' hours')::interval
         AND n >= $2
         ${typeFilter}
       ORDER BY signal_id, market_type, direction, measured_at DESC`,
      params
    );

    const cells = cellsRes.rows.map((r) => ({
      signal_id: r.signal_id,
      market_type: r.market_type,
      direction: r.direction,
      n: Number(r.n),
      gross_pct: Number(r.gross_pct),
      t_gross: Number(r.t_gross),
    }));

    // Per-type RT cost: each row carries its own rt_cost_pct (the cron measures
    // it from paper_trades). Take the mean over the cells of each type so the
    // file has one value per type — they're nearly identical within a type
    // because the cron uses one rt cost per type per run.
    const rtPerType = new Map();
    for (const r of cellsRes.rows) {
      const t = r.market_type;
      const rt = Number(r.rt_cost_pct);
      if (!rtPerType.has(t)) rtPerType.set(t, []);
      rtPerType.get(t).push(rt);
    }
    const rtCostMap = {};
    for (const [t, arr] of rtPerType) {
      const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
      // generator_edge.rt_cost_pct is a percentage point (e.g. 1.08 = 1.08%).
      // The seed expects a fraction (e.g. 0.0108). Convert here.
      rtCostMap[t] = Number((mean / 100).toFixed(6));
    }

    if (cells.length === 0) {
      console.error(
        `No cells matched. Lookback ${args.lookbackHours}h, min-n ${args.minN}` +
          (args.types ? `, types ${args.types.join(',')}` : '') +
          '. Check EdgeCapacityRefresher freshness.'
      );
      process.exit(1);
    }

    // Distinct windows/horizons used → for the _meta. Picking the most
    // common values to record; if the cron uses heterogeneous params for
    // different types this will alert (different rows in cells).
    const winSet = new Set(cellsRes.rows.map((r) => `${r.window_days}d/${r.horizon_hours}h`));
    const fallbackRtPct = rtPerType.size > 0
      ? (Array.from(rtPerType.values()).flat().reduce((a, b) => a + b, 0)
         / Array.from(rtPerType.values()).flat().length)
      : null;

    const output = {
      _meta: {
        generated_at: new Date().toISOString().slice(0, 10),
        source: 'scripts/export-tstat-from-edge.js — latest measurement per cell from generator_edge',
        lookback_hours: args.lookbackHours,
        windows_horizons_observed: Array.from(winSet),
        rt_cost_assumption_pct: fallbackRtPct != null ? Number(fallbackRtPct.toFixed(4)) : null,
        rt_cost_source:
          'generator_edge.rt_cost_pct (per-row); aggregated to per-type means in companion rt-cost JSON. ' +
          'Pass --rt-cost <file> to the seed script for per-type cost.',
        types: Array.from(new Set(cellsRes.rows.map((r) => r.market_type))),
        cell_count: cells.length,
        note:
          'For cells where gross_pct == 0 (static-midpoint markets, e.g. event_short at long horizons), ' +
          'the seed script writes no per-direction row (zero information). The combiner falls back to __all__.',
      },
      cells,
    };

    fs.writeFileSync(args.out, JSON.stringify(output, null, 2) + '\n');
    fs.writeFileSync(args.rtOut, JSON.stringify(rtCostMap, null, 2) + '\n');

    console.log(`Wrote ${cells.length} cells across ${output._meta.types.length} types to ${args.out}`);
    console.log(`Wrote ${Object.keys(rtCostMap).length} per-type RT costs to ${args.rtOut}`);
    console.log(
      'Run: node scripts/seed-per-direction-weights.js ' +
        `--tstat ${args.out} --rt-cost ${args.rtOut} --dry-run`
    );
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
