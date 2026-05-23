#!/usr/bin/env node
/**
 * flb-cost-realism-check.js
 *
 * Early-failure detector for the FLB hold-to-resolution strategy. The
 * in-sample backtest (scripts/backtest-favorite-longshot-resolution.js)
 * assumes a flat 0.54% entry cost. The forward shadow recorder (table
 * `flb_shadow_signals`) stores the LIVE bid-ask spread of every recorded
 * signal — so we can recompute net/trade per market_type by replacing the
 * flat assumption with the forward distribution of effective entry costs,
 * without waiting for resolutions to accumulate.
 *
 * For each market_type:
 *   1. Replays the in-sample backtest entry rule against `flb_backtest_prices`
 *      (longshot SHORT YES, first bar in [0.02, 0.10] with TTR≥48h).
 *      Computes per-trade gross PnL and the cohort mean.
 *   2. Reads the forward effective-entry-cost distribution from
 *      `flb_shadow_signals`. Effective cost as a fraction of NO stake:
 *        cost = (entry_spread / 2) / (1 − entry_yes_price)
 *      The /2 turns full bid-ask into half-spread (price paid to cross);
 *      the /(1−p) normalises by the NO stake the backtest's gross is
 *      already in. Rows with NULL spread are reported separately as
 *      "no-book" — un-enterable, not failure but a sample-loss.
 *   3. Reports per type:
 *        in_sample_gross  (mean ± t)
 *        forward_cost (p25 / p50 / p75 / p95 + n + no-book share)
 *        recomputed_net at each cost percentile
 *        VERDICT: DEAD if cost_p50 >= gross  | MARGINAL if cost_p75 >= gross
 *                 | ALIVE otherwise
 *
 * The verdict is pre-registered: a "DEAD" type means the strategy's economics
 * fail BEFORE any forward resolutions are needed — a real-time kill signal.
 *
 * Usage (dashboard container — has pg + DATABASE_URL):
 *   docker cp scripts/flb-cost-realism-check.js polymarket-dashboard-api:/app/flb-cost.js
 *   docker exec polymarket-dashboard-api node /app/flb-cost.js
 *
 * Optional flags:
 *   --longshot-floor 0.02   exclude entries below this YES price (default 0.02)
 *   --longshot       0.10   upper bound of the longshot band (default 0.10)
 *   --min-ttr-hours  48     min hours between entry and resolved_at (default 48)
 */

const { Pool } = require('pg');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const LONGSHOT_FLOOR = parseFloat(arg('longshot-floor', '0.02'));
const LONGSHOT       = parseFloat(arg('longshot', '0.10'));
const MIN_TTR_HOURS  = parseInt(arg('min-ttr-hours', '48'), 10);

function stats(xs) {
  const n = xs.length;
  if (n === 0) return { n: 0, mean: 0, std: 0, t: 0 };
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const variance = n > 1 ? xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) : 0;
  const std = Math.sqrt(variance);
  const se = n > 1 ? std / Math.sqrt(n) : 0;
  return { n, mean, std, t: se > 0 ? mean / se : 0 };
}

function pct(sortedXs, q) {
  const n = sortedXs.length;
  if (n === 0) return NaN;
  return sortedXs[Math.min(n - 1, Math.max(0, Math.floor(q * (n - 1))))];
}

function fmtPct(x, digits = 2) {
  if (!Number.isFinite(x)) return '   n/a';
  return (x * 100 >= 0 ? '+' : '') + (x * 100).toFixed(digits) + '%';
}

function fmtCost(x, digits = 2) {
  if (!Number.isFinite(x)) return '   n/a';
  return (x * 100).toFixed(digits) + '%';
}

function verdict(gross, costP50, costP75) {
  if (!Number.isFinite(gross) || !Number.isFinite(costP50)) return 'NO_DATA';
  if (costP50 >= gross) return 'DEAD';
  if (costP75 >= gross) return 'MARGINAL';
  return 'ALIVE';
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  console.log('=== FLB Cost-Realism Check ===');
  console.log(`band: [${LONGSHOT_FLOOR}, ${LONGSHOT})  minTtrHours=${MIN_TTR_HOURS}`);
  console.log('Recomputes in-sample net/trade per market_type using the forward distribution');
  console.log('of live entry costs from flb_shadow_signals. No resolutions required.');
  console.log('');

  // Step 1 — in-sample per-trade gross PnL, segmented by market_type.
  // Replicates the backtest's first-in-band-bar entry rule, longshot SHORT YES.
  // gross = ((settle_no - q) / q) where q = 1 - entry_yes_price.
  const inSampleSql = `
    WITH resolved AS (
      SELECT id, market_type, lower(resolution_outcome) AS outcome, resolved_at
      FROM markets
      WHERE is_resolved = true
        AND lower(resolution_outcome) IN ('yes','no')
        AND resolved_at IS NOT NULL
    ),
    entry AS (
      SELECT DISTINCT ON (r.id)
        r.id, r.market_type, r.outcome,
        p.yes_price AS entry_price
      FROM resolved r
      JOIN flb_backtest_prices p ON p.market_id = r.id
      WHERE p.ts <= r.resolved_at - ($1 || ' hours')::interval
        AND p.yes_price >= $2 AND p.yes_price < $3
      ORDER BY r.id, p.ts ASC
    )
    SELECT market_type, outcome, entry_price FROM entry`;

  const inSample = await pool.query(inSampleSql, [String(MIN_TTR_HOURS), LONGSHOT_FLOOR, LONGSHOT]);
  console.log(`In-sample tail-band entries: ${inSample.rowCount} resolved markets`);

  // Compute per-trade gross PnL: SHORT YES → buy NO at q=1-p, settles 1 if outcome=no.
  // gross-on-stake = (settle_no - q) / q
  const grossByType = new Map();   // market_type -> array of gross PnL values
  for (const row of inSample.rows) {
    const p = Number(row.entry_price);
    const q = 1 - p;
    const settleNo = row.outcome === 'no' ? 1 : 0;
    const gross = (settleNo - q) / q;
    const type = row.market_type || '(null)';
    if (!grossByType.has(type)) grossByType.set(type, []);
    grossByType.get(type).push(gross);
  }
  // Pooled buckets
  const all = [].concat(...grossByType.values());
  grossByType.set('__ALL__', all);
  const tradeable = ['crypto_intraday', 'crypto_daily', 'event_financial', 'event_short']
    .flatMap(t => grossByType.get(t) || []);
  grossByType.set('__TRADEABLE__', tradeable);

  // Step 2 — forward effective entry cost distribution from flb_shadow_signals.
  // cost = (entry_spread / 2) / (1 - entry_yes_price)
  // entry_spread is the full bid-ask spread from markets.spread (Gamma API).
  const fwdSql = `
    SELECT s.market_type, s.entry_yes_price, s.entry_spread
    FROM flb_shadow_signals s
    WHERE s.entry_yes_price BETWEEN $1 AND $2`;
  const fwd = await pool.query(fwdSql, [LONGSHOT_FLOOR, LONGSHOT]);

  const costByType = new Map();    // type -> array of effective cost (NUMERIC, fraction of stake)
  const noBookByType = new Map();  // type -> { total, noBook }
  for (const row of fwd.rows) {
    const type = row.market_type || '(null)';
    if (!noBookByType.has(type)) noBookByType.set(type, { total: 0, noBook: 0 });
    const bucket = noBookByType.get(type);
    bucket.total++;
    if (row.entry_spread == null) {
      bucket.noBook++;
      continue;
    }
    const p = Number(row.entry_yes_price);
    const spread = Number(row.entry_spread);
    const q = 1 - p;
    if (q <= 0) continue;
    const cost = (spread / 2) / q;
    if (!costByType.has(type)) costByType.set(type, []);
    costByType.get(type).push(cost);
  }
  // Pooled buckets
  const allCosts = [].concat(...costByType.values());
  costByType.set('__ALL__', allCosts);
  const allNoBook = [...noBookByType.values()].reduce(
    (acc, x) => ({ total: acc.total + x.total, noBook: acc.noBook + x.noBook }),
    { total: 0, noBook: 0 },
  );
  noBookByType.set('__ALL__', allNoBook);
  const tradeableCosts = ['crypto_intraday', 'crypto_daily', 'event_financial', 'event_short']
    .flatMap(t => costByType.get(t) || []);
  costByType.set('__TRADEABLE__', tradeableCosts);
  const tradeableNoBook = ['crypto_intraday', 'crypto_daily', 'event_financial', 'event_short']
    .reduce((acc, t) => {
      const b = noBookByType.get(t);
      return b ? { total: acc.total + b.total, noBook: acc.noBook + b.noBook } : acc;
    }, { total: 0, noBook: 0 });
  noBookByType.set('__TRADEABLE__', tradeableNoBook);

  // Step 3 — per-type report.
  console.log('');
  console.log('Verdict rule: DEAD if cost_p50 >= in-sample gross | MARGINAL if cost_p75 >= gross | ALIVE otherwise');
  console.log('');
  const header = [
    'market_type'.padEnd(18),
    'n_in'.padStart(6),
    'gross'.padStart(8),
    't'.padStart(6),
    'n_fwd'.padStart(6),
    'noBk'.padStart(5),
    'c25'.padStart(7),
    'c50'.padStart(7),
    'c75'.padStart(7),
    'c95'.padStart(7),
    'net@p50'.padStart(8),
    'net@p75'.padStart(8),
    'verdict'.padStart(9),
  ].join(' ');
  console.log(header);
  console.log('-'.repeat(header.length));

  const orderedTypes = [
    'crypto_intraday', 'crypto_daily', 'event_financial', 'event_short', 'event_long',
    '__TRADEABLE__', '__ALL__',
  ];

  for (const type of orderedTypes) {
    const grosses = grossByType.get(type) || [];
    const costs = (costByType.get(type) || []).slice().sort((a, b) => a - b);
    const noBook = noBookByType.get(type) || { total: 0, noBook: 0 };

    const gStats = stats(grosses);
    const c25 = pct(costs, 0.25);
    const c50 = pct(costs, 0.50);
    const c75 = pct(costs, 0.75);
    const c95 = pct(costs, 0.95);
    const noBookShare = noBook.total > 0 ? noBook.noBook / noBook.total : NaN;
    const netP50 = Number.isFinite(gStats.mean) && Number.isFinite(c50) ? gStats.mean - c50 : NaN;
    const netP75 = Number.isFinite(gStats.mean) && Number.isFinite(c75) ? gStats.mean - c75 : NaN;
    const v = verdict(gStats.mean, c50, c75);

    const noBookFmt = Number.isFinite(noBookShare)
      ? `${(noBookShare * 100).toFixed(0)}%`
      : ' n/a';

    console.log([
      type.padEnd(18),
      String(gStats.n).padStart(6),
      fmtPct(gStats.mean).padStart(8),
      gStats.t.toFixed(2).padStart(6),
      String(costs.length).padStart(6),
      noBookFmt.padStart(5),
      fmtCost(c25).padStart(7),
      fmtCost(c50).padStart(7),
      fmtCost(c75).padStart(7),
      fmtCost(c95).padStart(7),
      fmtPct(netP50).padStart(8),
      fmtPct(netP75).padStart(8),
      v.padStart(9),
    ].join(' '));
  }

  console.log('');
  console.log('Notes:');
  console.log('  - gross is the in-sample per-trade gross PnL (SHORT YES, hold to resolution).');
  console.log('  - cost columns are EFFECTIVE entry cost as a fraction of NO stake:');
  console.log('      cost = (entry_spread / 2) / (1 - entry_yes_price)');
  console.log('  - noBk = share of forward signals with NULL spread (un-enterable, see OQ#1).');
  console.log('  - net@pX = gross - cost_pX. DEAD means even median forward cost exceeds gross.');
  console.log('  - The 0.54% backtest assumption corresponds to roughly cost = 0.54%; compare');
  console.log('    against c50 to see how far reality drifted from the assumption.');

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
