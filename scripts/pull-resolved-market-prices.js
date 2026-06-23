#!/usr/bin/env node
/**
 * pull-resolved-market-prices.js
 *
 * Backfills historical YES-price series for RESOLVED markets from the
 * Polymarket CLOB /prices-history endpoint into the unlogged table
 * `flb_backtest_prices`, to feed backtest-favorite-longshot-resolution.js.
 *
 * Why: the data-collector only stores price_history for markets it tracked
 * live (~28 of 9,266 resolved markets). A hold-to-resolution backtest of the
 * favorite-longshot bias needs prices for a large, unbiased sample of resolved
 * markets — which only the API can provide.
 *
 * Orientation gotcha: CLOB /prices-history is documented (Scheduler.ts:103) to
 * return complementary (NO) prices for YES token ids. This script does NOT
 * trust that blindly — it probes ~25 markets with known resolution outcomes,
 * checks whether each series converges to the outcome, and inverts only if the
 * evidence says so. Aborts if the probe is inconclusive.
 *
 * Daily fidelity: the API is queried hourly, then downsampled to one bar per
 * UTC day (last bar) — enough for a hold-to-resolution backtest, bounds the
 * table to <= 365 rows/market.
 *
 * Resumable: skips markets already present in flb_backtest_prices.
 *
 * Usage (dashboard container — has pg, DATABASE_URL, internet):
 *   docker cp scripts/pull-resolved-market-prices.js polymarket-dashboard-api:/app/pull.js
 *   docker exec polymarket-dashboard-api node /app/pull.js --limit 4000
 */

const { Pool } = require('pg');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const CLOB = process.env.CLOB_API_URL || 'https://clob.polymarket.com';
const LIMIT = parseInt(arg('limit', '4000'), 10);
const DELAY_MS = parseInt(arg('delay', '150'), 10);
const FIDELITY = 60; // hourly from API, downsampled to daily

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchHistory(tokenId, attempt = 0) {
  const url = `${CLOB}/prices-history?market=${encodeURIComponent(tokenId)}&fidelity=${FIDELITY}&interval=max`;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(to);
    if (res.status === 404) return [];
    if (res.status === 429 || res.status >= 500) {
      if (attempt < 4) { await sleep(1000 * (attempt + 1)); return fetchHistory(tokenId, attempt + 1); }
      return null;
    }
    if (!res.ok) return null;
    const j = await res.json();
    return (j.history || []).map(h => ({ t: Number(h.t), p: Number(h.p) }))
      .filter(h => Number.isFinite(h.t) && Number.isFinite(h.p));
  } catch (e) {
    if (attempt < 4) { await sleep(1000 * (attempt + 1)); return fetchHistory(tokenId, attempt + 1); }
    return null;
  }
}

// One bar per UTC day — the last bar of each day (input assumed ascending in t).
function toDaily(hist) {
  const byDay = new Map();
  for (const h of hist) {
    if (!(h.p > 0 && h.p < 1)) continue;
    byDay.set(Math.floor(h.t / 86400), h);
  }
  return [...byDay.values()].sort((a, b) => a.t - b.t);
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // LOGGED (not UNLOGGED): an unlogged table is TRUNCATED on every Postgres
  // crash/restart. The original unlogged backfill (2026-05-19, 6339 markets) was
  // silently wiped when timescaledb restarted ~2026-06-09, leaving downstream
  // backtests (FLB, H-INE-4 conditional) with no price corpus. SET LOGGED is
  // idempotent and converts a pre-existing empty unlogged table in place.
  await pool.query(`CREATE TABLE IF NOT EXISTS flb_backtest_prices (
    market_id text NOT NULL, ts timestamptz NOT NULL, yes_price numeric(10,6) NOT NULL)`);
  await pool.query(`ALTER TABLE flb_backtest_prices SET LOGGED`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_flb_bt ON flb_backtest_prices (market_id, ts)`);

  const { rows: markets } = await pool.query(
    `SELECT id, lower(resolution_outcome) AS outcome, clob_token_id_yes
     FROM markets
     WHERE is_resolved = true AND lower(resolution_outcome) IN ('yes','no')
       AND resolved_at IS NOT NULL
       AND clob_token_id_yes IS NOT NULL AND clob_token_id_yes <> ''
       AND id NOT IN (SELECT DISTINCT market_id FROM flb_backtest_prices)
     ORDER BY random() LIMIT $1`,
    [LIMIT],
  );
  console.log(`Markets to pull: ${markets.length}  (CLOB=${CLOB}, fidelity=${FIDELITY}, delay=${DELAY_MS}ms)`);
  if (markets.length === 0) { await pool.end(); return; }

  // --- PROBE: detect YES/NO orientation against known outcomes ---
  let agree = 0, disagree = 0;
  for (const m of markets.slice(0, 25)) {
    const h = await fetchHistory(m.clob_token_id_yes);
    await sleep(DELAY_MS);
    if (!h || h.length === 0) continue;
    const last = h[h.length - 1].p;
    if (last > 0.8 || last < 0.2) {
      const looksYes = last > 0.5;
      if (looksYes === (m.outcome === 'yes')) agree++; else disagree++;
    }
  }
  if (agree + disagree < 5) {
    console.error(`Probe inconclusive (agree=${agree} disagree=${disagree}) — aborting`);
    process.exit(1);
  }
  const invert = disagree > agree;
  console.log(`Probe: agree=${agree} disagree=${disagree} → invert=${invert}` +
    (invert ? ' (endpoint returns NO prices — inverting to YES)' : ' (endpoint returns YES prices)'));

  // --- PULL ---
  let done = 0, withData = 0, rowsInserted = 0, failed = 0;
  for (const m of markets) {
    const h = await fetchHistory(m.clob_token_id_yes);
    await sleep(DELAY_MS);
    done++;
    if (h === null) { failed++; }
    else if (h.length) {
      const daily = toDaily(h);
      const vals = [], params = [];
      let i = 1;
      for (const d of daily) {
        const yes = invert ? 1 - d.p : d.p;
        if (!(yes > 0 && yes < 1)) continue;
        vals.push(`($${i++},$${i++},$${i++})`);
        params.push(m.id, new Date(d.t * 1000).toISOString(), yes);
      }
      if (vals.length) {
        await pool.query(
          `INSERT INTO flb_backtest_prices (market_id, ts, yes_price) VALUES ${vals.join(',')}`,
          params,
        );
        rowsInserted += vals.length;
        withData++;
      }
    }
    if (done % 100 === 0) {
      console.log(`  ${done}/${markets.length}  withData=${withData}  failed=${failed}  rows=${rowsInserted}`);
    }
  }
  console.log(`DONE: ${done} markets processed, ${withData} with usable data, ${failed} failed, ${rowsInserted} rows inserted.`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
