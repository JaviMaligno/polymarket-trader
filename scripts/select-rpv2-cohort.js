#!/usr/bin/env node
/**
 * select-rpv2-cohort.js
 *
 * Selects ~6 candidate markets to refresh the RPv2 sub-cohort in
 * FORCE_INCLUDE_MARKET_IDS. The RPv2 generator (ResolutionPriorV2Generator)
 * only fires within `cutoffDays=7`, so without a steady supply of TTR-≤7d
 * markets pinned to `active` the generator has no measurement signal.
 *
 * This script is idempotent and read-only. Output is paste-ready: copy the
 * "FORCE_INCLUDE_MARKET_IDS:" line into docker-compose.gcp.yml (both
 * occurrences: data-collector and dashboard-api).
 *
 * Cadence: run weekly (or whenever the current RPv2 sub-cohort markets resolve).
 * Recorded 2026-05-20 in docker-compose.gcp.yml.
 *
 * Usage (locally):
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 DATABASE_URL="postgres://..." \
 *     node scripts/select-rpv2-cohort.js
 *
 * Usage (in dashboard container):
 *   docker exec polymarket-dashboard-api node /app/select-rpv2-cohort.js
 *
 * Flags:
 *   --keep "id1,id2,..."   FLB sub-cohort to preserve (defaults to the
 *                          12-market list documented in compose). The script
 *                          adds 6 RPv2 markets, prints the combined list.
 *   --count N              How many RPv2 markets to select (default 6).
 *   --min-volume V         Min volume_24h for candidates (default 2000).
 *   --min-ttr-hours H      Min TTR in hours (default 36 — leave one full day
 *                          of measurement before resolution).
 *   --max-ttr-hours H      Max TTR in hours (default 168 — the RPv2 cutoff).
 */

const { Pool } = require('pg');

// Defaults — the FLB sub-cohort documented in docker-compose.gcp.yml (the
// tail-band markets pinned for `favorite_longshot_bias` measurement). Update
// only if those markets resolve and the cohort comment changes.
const DEFAULT_FLB_COHORT = [
  '616905', '616906', '948956', '948957', '1144471', '1654959',
  '1294363', '1032269', '951180', '1652691', '1818152', '1032270',
];

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

async function main() {
  const keep = (arg('keep', DEFAULT_FLB_COHORT.join(',')) || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const count = parseInt(arg('count', '6'), 10);
  const minVolume = parseFloat(arg('min-volume', '2000'));
  const minTtrHours = parseFloat(arg('min-ttr-hours', '36'));
  const maxTtrHours = parseFloat(arg('max-ttr-hours', '168'));

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  console.log(`=== RPv2 cohort selection — ${new Date().toISOString().slice(0, 10)} ===`);
  console.log(`keep (FLB sub-cohort): ${keep.length} markets`);
  console.log(`target count: ${count}, min volume: $${minVolume}, TTR window: ${minTtrHours}-${maxTtrHours}h`);

  // Step 1 — fetch current candidates ordered by volume_24h. Exclude markets
  // already in `keep` and anything already resolved. Restrict to types that
  // actually flow predictions; event_long is included (shadow-only live but
  // the prediction stream is what feeds the t-stat job).
  const res = await pool.query(`
    SELECT
      m.id,
      m.market_type,
      ROUND((EXTRACT(EPOCH FROM (m.end_date - NOW()))/3600)::numeric, 1) AS ttr_hours,
      m.volume_24h,
      (SELECT close FROM price_history WHERE market_id = m.id ORDER BY time DESC LIMIT 1) AS recent_yes,
      LEFT(m.question, 80) AS question
    FROM markets m
    WHERE m.is_active = true
      AND COALESCE(m.is_resolved, false) = false
      AND m.end_date > NOW() + ($1 || ' hours')::interval
      AND m.end_date < NOW() + ($2 || ' hours')::interval
      AND m.market_type IN ('event_financial','crypto_daily','event_short','event_long')
      AND m.volume_24h >= $3
      AND NOT (m.id::text = ANY($4))
    ORDER BY m.volume_24h DESC NULLS LAST
    LIMIT 50
  `, [minTtrHours, maxTtrHours, minVolume, keep]);

  if (res.rows.length === 0) {
    console.error('No candidate markets matched the filters. Try lowering --min-volume or widening --max-ttr-hours.');
    process.exit(1);
  }

  // Step 2 — diversity selection: pick `count` markets aiming for at least
  // one of each type that has candidates, then fill the rest by descending
  // volume. Bias toward `event_financial`/`crypto_daily` since those are
  // the live-allowed types (event_long stays shadow).
  const byType = new Map();
  for (const row of res.rows) {
    if (!byType.has(row.market_type)) byType.set(row.market_type, []);
    byType.get(row.market_type).push(row);
  }

  const picked = [];
  // First pass: one per type with candidates, preferring event_financial / crypto_daily.
  const typeOrder = ['event_financial', 'crypto_daily', 'event_short', 'event_long'];
  for (const t of typeOrder) {
    if (picked.length >= count) break;
    const candidates = byType.get(t) || [];
    if (candidates.length > 0) picked.push(candidates[0]);
  }
  // Second pass: fill remaining slots by descending volume across all types,
  // skipping anything already picked.
  for (const row of res.rows) {
    if (picked.length >= count) break;
    if (picked.find(p => p.id === row.id)) continue;
    picked.push(row);
  }

  console.log('\nProposed RPv2 sub-cohort:');
  console.log('  id        | type             | ttr (h) | vol_24h    | recent_yes | question');
  console.log('  ----------|------------------|---------|------------|------------|---------');
  for (const r of picked) {
    const vol = r.volume_24h == null ? '       ?' : Number(r.volume_24h).toFixed(0).padStart(8);
    const yes = r.recent_yes == null ? '   none   ' : Number(r.recent_yes).toFixed(4).padStart(9);
    console.log(`  ${String(r.id).padEnd(9)} | ${(r.market_type || '?').padEnd(16)} | ${String(r.ttr_hours).padStart(7)} | ${vol} | ${yes}  | ${r.question}`);
  }

  const combined = [...keep, ...picked.map(p => String(p.id))];
  console.log('\nPaste-ready compose env (both data-collector and dashboard-api):');
  console.log(`      FORCE_INCLUDE_MARKET_IDS: "${combined.join(',')}"`);

  console.log('\nNext steps:');
  console.log('  1. Update docker-compose.gcp.yml (two occurrences: data-collector + dashboard-api).');
  console.log('  2. Update the "Selection YYYY-MM-DD" line in the comment block above the var.');
  console.log('  3. PR + CI deploy + verify env on VM after deploy.');

  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
