#!/usr/bin/env node
/**
 * backtest-favorite-longshot-resolution.js
 *
 * Tests the favorite-longshot bias as a HOLD-TO-RESOLUTION strategy, the
 * framing the 4h-drift measurement (generator_edge / p2-tstat) cannot see.
 *
 * Question: do binary markets priced in a tail band (YES < longshot or
 * YES > favorite) resolve in line with their price, or is the price biased?
 * The favorite-longshot bias predicts longshots are over-priced (resolve YES
 * LESS often than priced) and favorites under-priced (resolve YES MORE often).
 *
 * Trade modelled (one entry per market, held to resolution):
 *   - Longshot band (entry YES price p < longshot): SHORT YES = buy NO at
 *     q = 1 - p. Settles 1 if outcome=no, 0 if yes.
 *       gross return on stake = (settle_no - q) / q
 *   - Favorite band (entry YES price p > favorite): LONG YES = buy YES at p.
 *     Settles 1 if outcome=yes, 0 if no.
 *       gross return on stake = (settle_yes - p) / p
 *   net return = gross return - entryCost   (entry cost only — resolution
 *   settles at par, there is no exit spread; this is the whole point).
 *
 * Entry rule: the FIRST price bar where the YES close is in a tail band, at
 * least minTtrHours before resolved_at (excludes trivial near-resolution
 * entries where the price is simply correct). One trade per market.
 *
 * NOTE on lookahead: the TTR gate uses resolved_at, which is future info at
 * entry time. This is acceptable for an existence test of the bias — a live
 * rule would gate on end_date. Markets that enter a band and resolve within
 * minTtrHours are excluded; the count is reported so the effect is visible.
 *
 * Usage (from the dashboard container, which has pg + DATABASE_URL):
 *   docker cp scripts/backtest-favorite-longshot-resolution.js \
 *     polymarket-dashboard-api:/app/blr.js
 *   docker exec polymarket-dashboard-api node /app/blr.js \
 *     --longshot 0.10 --favorite 0.90 --min-ttr-hours 48 --entry-cost 0.0054
 */

const { Pool } = require('pg');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const LONGSHOT = parseFloat(arg('longshot', '0.10'));
// Lower bound of the longshot band. Below this the win (p/(1-p)) is smaller
// than the entry cost, so the trade is structurally un-edged regardless of
// any bias — excluding it is a rule a real strategy would apply ex-ante.
const LONGSHOT_FLOOR = parseFloat(arg('longshot-floor', '0'));
const FAVORITE = parseFloat(arg('favorite', '0.90'));
const MIN_TTR_HOURS = parseInt(arg('min-ttr-hours', '48'), 10);
const ENTRY_COST = parseFloat(arg('entry-cost', '0.0054')); // half of ~1.08% RT
// Price source: 'backtest' = flb_backtest_prices (API backfill, large sample);
// 'collector' = price_history (only the ~28 markets tracked live).
const SOURCE = arg('source', 'backtest');

function stats(xs) {
  const n = xs.length;
  if (n === 0) return { n: 0 };
  const sorted = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const variance = n > 1 ? xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) : 0;
  const std = Math.sqrt(variance);
  const se = n > 1 ? std / Math.sqrt(n) : 0;
  const pct = q => sorted[Math.min(n - 1, Math.max(0, Math.floor(q * (n - 1))))];
  return {
    n, mean, std,
    t: se > 0 ? mean / se : 0,
    min: sorted[0], p5: pct(0.05), p25: pct(0.25), median: pct(0.5),
    p75: pct(0.75), p95: pct(0.95), max: sorted[n - 1],
  };
}

function holdDays(row) {
  return (new Date(row.resolved_at).getTime() - new Date(row.entry_time).getTime()) / 86400000;
}

function pnl(row) {
  const p = Number(row.entry_price);
  const outcomeYes = row.outcome === 'yes';
  let gross;
  if (p < LONGSHOT) {
    // SHORT YES = buy NO at q = 1 - p; NO settles 1 if outcome=no
    const q = 1 - p;
    gross = ((outcomeYes ? 0 : 1) - q) / q;
  } else {
    // LONG YES = buy YES at p; YES settles 1 if outcome=yes
    gross = ((outcomeYes ? 1 : 0) - p) / p;
  }
  return { gross, net: gross - ENTRY_COST, band: p < LONGSHOT ? 'longshot' : 'favorite' };
}

function fmtPct(x) {
  return (x * 100 >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%';
}

function report(label, rows) {
  if (rows.length === 0) {
    console.log(`  ${label}: (no trades)`);
    return;
  }
  const nets = rows.map(r => r._net);
  const grosses = rows.map(r => r._gross);
  const s = stats(nets);
  const g = stats(grosses);
  const wins = rows.filter(r => r._net > 0).length;
  const meanEntry = rows.reduce((a, r) => a + Number(r.entry_price), 0) / rows.length;
  const yesRate = rows.filter(r => r.outcome === 'yes').length / rows.length;
  const totalNet = nets.reduce((a, x) => a + x, 0);
  const hd = stats(rows.map(r => r._holdDays));
  // Annualised return of a fully-deployed book: capital turns over 365/H times
  // a year, each turn earning the per-trade net. Uses median hold (robust to
  // the long-dated tail). Assumes enough concurrent flow to stay deployed.
  const annual = hd.median > 0 ? s.mean * (365 / hd.median) : 0;
  console.log(`  ${label}`);
  console.log(`    n=${s.n}  meanEntryPrice=${meanEntry.toFixed(4)}  actualYesRate=${(yesRate * 100).toFixed(2)}%`);
  console.log(`    gross/trade=${fmtPct(g.mean)}  net/trade=${fmtPct(s.mean)}  t_net=${s.t.toFixed(2)}  winRate=${(100 * wins / s.n).toFixed(1)}%`);
  console.log(`    net total (1 unit/trade)=${totalNet.toFixed(2)}  std=${(s.std * 100).toFixed(1)}%  perTradeSharpe=${(s.std > 0 ? s.mean / s.std : 0).toFixed(3)}`);
  console.log(`    holdDays: med=${hd.median.toFixed(1)} mean=${hd.mean.toFixed(1)} p25=${hd.p25.toFixed(1)} p75=${hd.p75.toFixed(1)} p95=${hd.p95.toFixed(1)}  → annualised(med hold)≈${fmtPct(annual)}`);
  console.log(`    net distn: min=${fmtPct(s.min)} p5=${fmtPct(s.p5)} p25=${fmtPct(s.p25)} med=${fmtPct(s.median)} p75=${fmtPct(s.p75)} p95=${fmtPct(s.p95)} max=${fmtPct(s.max)}`);
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  console.log('=== Favorite-Longshot Bias — Hold-to-Resolution Backtest ===');
  console.log(`params: longshot∈[${LONGSHOT_FLOOR},${LONGSHOT})  favorite>${FAVORITE}  minTtrHours=${MIN_TTR_HOURS}  entryCost=${fmtPct(ENTRY_COST)}  source=${SOURCE}`);
  console.log('');

  // 'backtest' source: flb_backtest_prices (API backfill, keyed by market_id,
  // yes_price already oriented). 'collector' source: price_history (keyed by
  // YES token id, close = YES price) — only the markets tracked live.
  const sql = SOURCE === 'collector'
    ? `WITH resolved AS (
         SELECT id, market_type, lower(resolution_outcome) AS outcome,
                resolved_at, clob_token_id_yes
         FROM markets
         WHERE is_resolved = true AND lower(resolution_outcome) IN ('yes','no')
           AND resolved_at IS NOT NULL
           AND clob_token_id_yes IS NOT NULL AND clob_token_id_yes <> ''
       ),
       entry AS (
         SELECT DISTINCT ON (r.id)
           r.id, r.market_type, r.outcome, r.resolved_at,
           ph.time AS entry_time, ph.close AS entry_price
         FROM resolved r
         JOIN price_history ph ON ph.token_id = r.clob_token_id_yes
         WHERE ph.time <= r.resolved_at - ($1 || ' hours')::interval
           AND ph.close > 0 AND ph.close < 1
           AND ((ph.close >= $4 AND ph.close < $2) OR ph.close > $3)
         ORDER BY r.id, ph.time ASC
       )
       SELECT * FROM entry`
    : `WITH resolved AS (
         SELECT id, market_type, lower(resolution_outcome) AS outcome, resolved_at
         FROM markets
         WHERE is_resolved = true AND lower(resolution_outcome) IN ('yes','no')
           AND resolved_at IS NOT NULL
       ),
       entry AS (
         SELECT DISTINCT ON (r.id)
           r.id, r.market_type, r.outcome, r.resolved_at,
           p.ts AS entry_time, p.yes_price AS entry_price
         FROM resolved r
         JOIN flb_backtest_prices p ON p.market_id = r.id
         WHERE p.ts <= r.resolved_at - ($1 || ' hours')::interval
           AND p.yes_price > 0 AND p.yes_price < 1
           AND ((p.yes_price >= $4 AND p.yes_price < $2) OR p.yes_price > $3)
         ORDER BY r.id, p.ts ASC
       )
       SELECT * FROM entry`;

  const { rows } = await pool.query(sql, [String(MIN_TTR_HOURS), LONGSHOT, FAVORITE, LONGSHOT_FLOOR]);

  console.log(`Tail-band entries found: ${rows.length} resolved markets`);
  console.log('');

  for (const r of rows) {
    const x = pnl(r);
    r._gross = x.gross;
    r._net = x.net;
    r._band = x.band;
    r._holdDays = holdDays(r);
  }

  const longshot = rows.filter(r => r._band === 'longshot');
  const favorite = rows.filter(r => r._band === 'favorite');

  console.log('--- By band ---');
  report('LONGSHOT  (short YES / buy NO)', longshot);
  report('FAVORITE  (long YES)', favorite);
  console.log('');

  console.log('--- Longshot band, by market_type ---');
  for (const mt of [...new Set(longshot.map(r => r.market_type))].sort()) {
    report(mt || '(null)', longshot.filter(r => r.market_type === mt));
  }
  console.log('');

  console.log('--- Calibration: entry price vs actual YES-resolution rate ---');
  console.log('  (bias confirmed if, for longshots, actualYes < meanEntry; for favorites, actualYes > meanEntry)');
  const bins = [
    [0.00, 0.02], [0.02, 0.04], [0.04, 0.06], [0.06, 0.08], [0.08, LONGSHOT],
    [FAVORITE, 0.92], [0.92, 0.94], [0.94, 0.96], [0.96, 0.98], [0.98, 1.00],
  ];
  for (const [lo, hi] of bins) {
    const b = rows.filter(r => Number(r.entry_price) >= lo && Number(r.entry_price) < hi);
    if (b.length === 0) continue;
    const meanEntry = b.reduce((a, r) => a + Number(r.entry_price), 0) / b.length;
    const yesRate = b.filter(r => r.outcome === 'yes').length / b.length;
    const meanNet = b.reduce((a, r) => a + r._net, 0) / b.length;
    const gap = yesRate - meanEntry;
    console.log(
      `  [${lo.toFixed(2)},${hi.toFixed(2)})  n=${String(b.length).padStart(5)}  ` +
      `meanEntry=${meanEntry.toFixed(4)}  actualYes=${(yesRate * 100).toFixed(2).padStart(6)}%  ` +
      `gap=${(gap * 100 >= 0 ? '+' : '') + (gap * 100).toFixed(2)}%  net/trade=${fmtPct(meanNet)}`,
    );
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
