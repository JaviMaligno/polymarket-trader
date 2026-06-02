#!/usr/bin/env node
/**
 * One-shot backfill for generator_prediction_outcomes (daily-review #297).
 *
 * Run ONCE on the VM after deploying the materialization job + creating the
 * table, to fill the initial 7-day window the EdgeCapacityRefresher reads.
 * This pass touches compressed price_history chunks (expensive), so it runs
 * offline without the cron's 600s cap. The hourly job keeps the table current
 * thereafter.
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 DATABASE_URL="postgres://..." \
 *     node scripts/backfill-prediction-outcomes.js [--window-days 8] [--horizon 4]
 */
const { Pool } = require('pg');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function main() {
  const windowDays = parseInt(arg('window-days', '8'), 10);
  const horizon = parseInt(arg('horizon', '4'), 10);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const pending = await pool.query(
    `SELECT g.id, g.time, g.market_id, g.market_type, g.signal_id, g.direction,
            g.yes_price_at_signal
     FROM generator_predictions g
     WHERE g.time >= NOW() - INTERVAL '${windowDays} days'
       AND g.time <  NOW() - INTERVAL '${horizon + 1} hours'
       AND g.direction IN ('long','short')
       AND NOT EXISTS (
         SELECT 1 FROM generator_prediction_outcomes o
         WHERE o.prediction_id = g.id AND o.horizon_hours = $1
       )`,
    [horizon],
  );

  console.log(`Backfilling ${pending.rows.length} predictions (window ${windowDays}d, horizon ${horizon}h)`);
  let materialized = 0, noPrice = 0, errors = 0;

  for (const row of pending.rows) {
    try {
      const fwd = await pool.query(
        `SELECT close::float AS close FROM price_history
         WHERE market_id = $1
           AND time >= $2::timestamptz + INTERVAL '${horizon} hours'
           AND time <  $2::timestamptz + INTERVAL '${horizon + 1} hours'
         ORDER BY time ASC LIMIT 1`,
        [row.market_id, row.time],
      );
      const y1 = fwd.rows.length > 0 ? Number(fwd.rows[0].close) : null;
      await pool.query(
        `INSERT INTO generator_prediction_outcomes
           (prediction_id, prediction_time, market_id, market_type, signal_id,
            direction, y0, y1, horizon_hours, no_forward_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (prediction_time, prediction_id, horizon_hours) DO NOTHING`,
        [row.id, row.time, row.market_id, row.market_type, row.signal_id,
         row.direction, Number(row.yes_price_at_signal), y1, horizon, y1 === null],
      );
      if (y1 === null) noPrice++; else materialized++;
      if ((materialized + noPrice) % 5000 === 0) {
        console.log(`  ... ${materialized + noPrice}/${pending.rows.length}`);
      }
    } catch (e) {
      errors++;
      if (errors <= 10) console.error(`  row ${row.id} failed: ${e.message}`);
    }
  }

  console.log(`Done: materialized=${materialized} noPrice=${noPrice} errors=${errors}`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
