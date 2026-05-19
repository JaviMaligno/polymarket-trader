#!/usr/bin/env node
/**
 * market-panel-snapshot.js
 *
 * Forward data-collection recorder for the trading-edge research program
 * (calibration / supervised model / holding-horizon vías — see
 * docs/superpowers/specs/2026-05-19-market-panel-recorder-design.md).
 *
 * Weekly panel: one row per (market_id, ISO week) for every liquid active
 * market, capturing its features + price. PRIMARY KEY (market_id, iso_week)
 * + ON CONFLICT DO NOTHING makes it exactly one snapshot per market per week,
 * however often the script runs. On resolution, every row of that market is
 * backfilled with the outcome.
 *
 * Run daily; idempotent. Run inside the dashboard container (has pg +
 * DATABASE_URL):
 *   docker exec polymarket-dashboard-api node /app/market-panel.js
 */

const { Pool } = require('pg');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

// Data-hygiene floor — drops dead markets whose price is stale/default 0.50.
// Not a strict gate; tune from the first run's reported count.
const LIQUIDITY_FLOOR = parseFloat(arg('liquidity-floor', '100'));

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  console.log(`=== Market panel snapshot — ${new Date().toISOString().slice(0, 10)} ===`);
  console.log(`liquidity floor: ${LIQUIDITY_FLOOR}`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS market_panel (
      market_id        text NOT NULL,
      iso_week         text NOT NULL,
      snapshot_at      timestamptz NOT NULL DEFAULT NOW(),
      market_type      text,
      category         text,
      question         text,
      event_id         text,
      end_date         timestamptz,
      created_at       timestamptz,
      yes_price        numeric(10,6),
      last_trade_price numeric(10,6),
      best_bid         numeric(10,6),
      best_ask         numeric(10,6),
      spread           numeric(10,6),
      volume_24h       numeric(20,6),
      liquidity        numeric(20,6),
      market_score     numeric(10,4),
      realized_vol_24h numeric(12,6),
      ttr_days         numeric(10,3),
      market_age_days  numeric(10,3),
      resolved_outcome text,
      resolved_at      timestamptz,
      outcome_yes      smallint,
      PRIMARY KEY (market_id, iso_week)
    )`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_market_panel_market ON market_panel (market_id)`);

  // Step 1 — record one row per (market, ISO week) for liquid active markets.
  const ins = await pool.query(`
    INSERT INTO market_panel (
      market_id, iso_week, market_type, category, question, event_id,
      end_date, created_at, yes_price, last_trade_price, best_bid, best_ask,
      spread, volume_24h, liquidity, market_score, realized_vol_24h,
      ttr_days, market_age_days)
    SELECT
      id, to_char(NOW(), 'IYYY"-W"IW'),
      market_type, category, question, event_id,
      end_date, created_at, current_price_yes, last_trade_price, best_bid, best_ask,
      spread, volume_24h, liquidity, market_score, realized_volatility_24h,
      EXTRACT(EPOCH FROM (end_date - NOW())) / 86400.0,
      EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400.0
    FROM markets
    WHERE is_active = true AND COALESCE(is_resolved, false) = false
      AND current_price_yes IS NOT NULL
      AND liquidity >= $1
    ON CONFLICT (market_id, iso_week) DO NOTHING`,
    [LIQUIDITY_FLOOR]);
  console.log(`Step 1 — rows recorded this run: ${ins.rowCount}`);

  // Step 2 — backfill the outcome on rows whose market has resolved.
  const upd = await pool.query(`
    UPDATE market_panel p SET
      resolved_outcome = lower(m.resolution_outcome),
      resolved_at      = m.resolved_at,
      outcome_yes      = CASE WHEN lower(m.resolution_outcome) = 'yes' THEN 1 ELSE 0 END
    FROM markets m
    WHERE m.id = p.market_id
      AND m.is_resolved = true
      AND lower(m.resolution_outcome) IN ('yes','no')
      AND p.resolved_outcome IS NULL`);
  console.log(`Step 2 — rows newly scored (market resolved): ${upd.rowCount}`);

  // Step 3 — report.
  const r = (await pool.query(`
    SELECT COUNT(*) AS rows,
      COUNT(DISTINCT market_id) AS markets,
      COUNT(DISTINCT iso_week) AS weeks,
      COUNT(*) FILTER (WHERE resolved_outcome IS NOT NULL) AS scored,
      pg_size_pretty(pg_total_relation_size('market_panel')) AS size
    FROM market_panel`)).rows[0];
  console.log('');
  console.log(`Panel total: ${r.rows} rows | ${r.markets} markets | ${r.weeks} weeks ` +
    `| ${r.scored} scored | table ${r.size}`);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
