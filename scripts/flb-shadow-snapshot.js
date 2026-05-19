#!/usr/bin/env node
/**
 * flb-shadow-snapshot.js
 *
 * Forward out-of-sample recorder for the favorite-longshot-bias
 * hold-to-resolution strategy. The historical backtest covers only a single
 * ~5-week window (Polymarket's CLOB price API serves no history older than
 * ~6 weeks — see project_flb_strategy_design memo, OQ#2), so the only way to
 * validate the +2.24%/trade edge across regimes is to record entry signals
 * going forward and score them when the markets resolve.
 *
 * Run daily. Idempotent — safe to run repeatedly.
 *
 *   Step 1 (record): every active market currently in the longshot band
 *     (YES 0.02-0.10) with TTR-to-end_date >= 48h is recorded ONCE, the first
 *     day it qualifies (PRIMARY KEY + ON CONFLICT DO NOTHING freezes the entry
 *     — mirrors the backtest's "first in-band bar" rule). entry_spread is
 *     stored so the OQ#1 spread filter can be applied in analysis.
 *   Step 2 (score): rows whose market has since resolved get the
 *     hold-to-resolution net PnL (short YES / buy NO, 0.54% entry cost).
 *   Step 3 (report): running out-of-sample stats.
 *
 * Usage (dashboard container — has pg + DATABASE_URL):
 *   docker exec polymarket-dashboard-api node /app/flb-shadow.js
 */

const { Pool } = require('pg');

const ENTRY_COST = 0.0054; // entry only — resolution settles at par

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const today = new Date().toISOString().slice(0, 10);
  console.log(`=== FLB shadow snapshot — ${today} ===`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS flb_shadow_signals (
      market_id        text PRIMARY KEY,
      first_seen       date NOT NULL,
      entry_yes_price  numeric(10,6) NOT NULL,
      entry_spread     numeric(10,6),
      end_date         timestamptz,
      market_type      text,
      recorded_at      timestamptz NOT NULL DEFAULT NOW(),
      resolved_outcome text,
      resolved_at      timestamptz,
      hold_days        numeric(10,3),
      net_pnl          numeric(12,6)
    )`);

  // Step 1 — record first-time longshot-band entries (ex-ante end_date gate).
  const ins = await pool.query(`
    INSERT INTO flb_shadow_signals (market_id, first_seen, entry_yes_price, entry_spread, end_date, market_type)
    SELECT id, CURRENT_DATE, current_price_yes, spread, end_date, market_type
    FROM markets
    WHERE is_active = true AND COALESCE(is_resolved,false) = false
      AND current_price_yes BETWEEN 0.02 AND 0.10
      AND end_date IS NOT NULL AND end_date > NOW() + INTERVAL '48 hours'
    ON CONFLICT (market_id) DO NOTHING`);
  console.log(`Step 1 — new signals recorded today: ${ins.rowCount}`);

  // Step 2 — score signals whose market has resolved.
  const upd = await pool.query(`
    UPDATE flb_shadow_signals s SET
      resolved_outcome = lower(m.resolution_outcome),
      resolved_at      = m.resolved_at,
      hold_days        = EXTRACT(EPOCH FROM (m.resolved_at - s.first_seen::timestamptz)) / 86400,
      net_pnl          = CASE WHEN lower(m.resolution_outcome) = 'no'
                              THEN s.entry_yes_price / (1 - s.entry_yes_price) - ${ENTRY_COST}
                              ELSE -1 - ${ENTRY_COST} END
    FROM markets m
    WHERE m.id = s.market_id
      AND m.is_resolved = true
      AND lower(m.resolution_outcome) IN ('yes','no')
      AND s.resolved_outcome IS NULL`);
  console.log(`Step 2 — signals newly scored (resolved): ${upd.rowCount}`);

  // Step 3 — running out-of-sample stats.
  const tot = await pool.query(`SELECT COUNT(*) n,
      COUNT(*) FILTER (WHERE resolved_outcome IS NOT NULL) resolved,
      MIN(first_seen) since FROM flb_shadow_signals`);
  const r = tot.rows[0];
  console.log('');
  console.log(`Total signals: ${r.n}  |  resolved (out-of-sample): ${r.resolved}  |  recording since ${r.since || today}`);

  const sc = await pool.query(`
    SELECT COUNT(*) n,
      ROUND(AVG(net_pnl)::numeric, 4) avg_net,
      ROUND(STDDEV_SAMP(net_pnl)::numeric, 4) sd,
      COUNT(*) FILTER (WHERE net_pnl > 0) wins,
      ROUND(AVG(hold_days)::numeric, 1) avg_hold
    FROM flb_shadow_signals WHERE resolved_outcome IS NOT NULL`);
  const s = sc.rows[0];
  if (Number(s.n) > 0) {
    const n = Number(s.n), avg = Number(s.avg_net), sd = Number(s.sd) || 0;
    const t = sd > 0 ? avg / (sd / Math.sqrt(n)) : 0;
    console.log('');
    console.log('Resolved-signal performance (forward OOS — short YES, hold to resolution):');
    console.log(`  n=${n}  net/trade=${(avg * 100).toFixed(2)}%  t=${t.toFixed(2)}  winRate=${(100 * Number(s.wins) / n).toFixed(1)}%  avgHold=${s.avg_hold}d`);
    console.log(`  (in-sample backtest reference: +2.24%/trade, t=3.49 — see project_flb_strategy_design)`);
  } else {
    console.log('No resolved signals yet — accumulating. Check back as markets resolve.');
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
