#!/usr/bin/env node
/**
 * Phase 4 PR-A — Seed `market_type_edge_capacity` from a versioned cost-aware
 * t-stat JSON file (e.g. data/cost-aware-tstat-2026-05-13.json). One-shot
 * bootstrap so we have edge_capacity values on day 1 of Phase 4 without
 * waiting for the nightly measurement cron (PR-D) to fire.
 *
 * Reads the same shape as scripts/seed-per-direction-weights.js — keeps the
 * data file as the single source of truth for both seed scripts.
 *
 * edge_capacity per market_type = Σ max(0, t_net) across cells in that type.
 * t_net = t_gross × (gross_pct − rt_cost_pct) / gross_pct. The rt_cost_pct
 * comes from the tstat _meta.rt_cost_assumption_pct (the value the t-stat
 * was computed under), since changing it ex-post would invalidate the
 * t_gross numbers anyway.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/seed-edge-capacity-from-tstat.js \
 *     --tstat data/cost-aware-tstat-2026-05-13.json [--min-n 50] [--dry-run]
 */
const { Pool } = require('pg');
const fs = require('fs');
const { computeEdgeCapacity } = require('./measure-edge-capacity.js');

function parseArgs(argv) {
  const args = { tstat: null, minN: 50, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--tstat') args.tstat = argv[++i];
    else if (k === '--min-n') args.minN = parseInt(argv[++i], 10);
    else if (k === '--dry-run') args.dryRun = true;
  }
  if (!args.tstat) {
    console.error('Error: --tstat <path> is required.');
    process.exit(1);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const data = JSON.parse(fs.readFileSync(args.tstat, 'utf-8'));
  const rtPct = Number(data._meta?.rt_cost_assumption_pct ?? 1.0);
  // Normalize cells to match measure-edge-capacity.js' expected shape.
  const cells = (data.cells || []).map((c) => ({
    signal_id: c.signal_id,
    market_type: c.market_type,
    direction: c.direction,
    n: Number(c.n),
    gross_pct: Number(c.gross_pct),
    t_gross: c.t_gross == null ? null : Number(c.t_gross),
  }));

  // RT cost map: same value for every market_type (the t-stat was computed
  // under a single rtcost assumption). computeEdgeCapacity multiplies by 100
  // internally to convert to pct, so we pass the fraction.
  const rtCostMap = {};
  const sourceLabel = `seed-edge-capacity-from-tstat.js ${data._meta?.generated_at || 'unknown'}`;

  const perType = computeEdgeCapacity(cells, null, rtPct / 100, args.minN);

  console.log('');
  console.log(`edge_capacity seed from ${args.tstat} (rt=${rtPct.toFixed(2)}%, min_n=${args.minN}):`);
  console.log('-'.repeat(96));
  console.log(
    [
      'market_type'.padEnd(20),
      'edge_capacity'.padStart(14),
      'positive_cells'.padStart(15),
      'measured_cells'.padStart(15),
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
      ].join(' | ')
    );
    upserts.push({ market_type: mt, edge_capacity: e.sum, positive: e.positive, measured: e.measured });
  }
  console.log('-'.repeat(96));

  if (args.dryRun) {
    console.log('\n(dry-run — no writes applied)');
    return;
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
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
        [u.market_type, u.edge_capacity, u.positive, u.measured, rtPct, sourceLabel]
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
