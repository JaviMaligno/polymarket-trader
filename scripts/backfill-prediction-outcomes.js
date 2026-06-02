#!/usr/bin/env node
/**
 * Throttled one-shot backfill for generator_prediction_outcomes (daily-review #297).
 *
 * Bulk, server-side INSERT...SELECT...LEFT JOIN LATERAL in batches with a pause
 * between them. The FIRST version did a per-row JS round-trip seek and melted the
 * e2-micro on the ~557k backlog (load avg 19, ~2 rows/min). This version pushes
 * the work into ONE SQL statement per batch and sleeps between batches so the VM
 * stays responsive. The hourly `materializePredictionOutcomes` job also drains the
 * backlog on its own (capped per tick); this script just speeds up the initial fill.
 *
 * Safe to run detached on the VM. Tune --batch / --sleep-ms down if load climbs.
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 DATABASE_URL="postgres://..." \
 *     node scripts/backfill-prediction-outcomes.js [--window-days 8] [--horizon 4] [--batch 5000] [--sleep-ms 10000]
 */
const { Pool } = require('pg');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const windowDays = parseInt(arg('window-days', '8'), 10);
  const horizon = parseInt(arg('horizon', '4'), 10);
  const batchSize = parseInt(arg('batch', '5000'), 10);
  const sleepMs = parseInt(arg('sleep-ms', '10000'), 10);
  const verdictAge = horizon + 4;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log(`Backfill start: window ${windowDays}d, horizon ${horizon}h, batch ${batchSize}, sleep ${sleepMs}ms`);
  let totalMat = 0, totalNoPrice = 0, batch = 0;

  for (;;) {
    const res = await pool.query(
      `WITH batch AS (
         SELECT g.id, g.time, g.market_id, g.market_type, g.signal_id,
                g.direction, g.yes_price_at_signal
         FROM generator_predictions g
         WHERE g.time >= NOW() - INTERVAL '${windowDays} days'
           AND g.time <  NOW() - INTERVAL '${verdictAge} hours'
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
    batch++;
    totalNoPrice += res.rows.filter((r) => r.no_price).length;
    totalMat += res.rows.filter((r) => !r.no_price).length;
    console.log(`  batch ${batch}: +${res.rows.length} (materialized=${totalMat} noPrice=${totalNoPrice})`);
    if (res.rows.length < batchSize) break;
    await sleep(sleepMs);
  }

  console.log(`Done: materialized=${totalMat} noPrice=${totalNoPrice} batches=${batch}`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
