#!/usr/bin/env node
/**
 * measure-tailband-spreads.js
 *
 * Open question #1 of the FLB hold-to-resolution strategy track: the backtest
 * assumed a 0.54% entry cost. This measures the REAL bid-ask cost of entering
 * the favorite-longshot trade on tail-band markets, from live CLOB order books.
 *
 * The FLB longshot trade buys the NO token (= short YES) on a market whose YES
 * price is in 0.02-0.10. The YES and NO order books are mirror images, so the
 * absolute spread is the same on both sides; entering NO as a taker costs half
 * that spread vs mid. As a fraction of the NO stake (~0.90-0.98):
 *
 *   entryCostFrac = (spreadAbs / 2) / (1 - yesMid)
 *
 * Resolved markets have no live book, so this samples currently-ACTIVE
 * tail-band markets as the proxy for the cost a live strategy would pay.
 *
 * Usage (dashboard container — has pg, DATABASE_URL, internet):
 *   docker cp scripts/measure-tailband-spreads.js polymarket-dashboard-api:/app/spr.js
 *   docker exec polymarket-dashboard-api node /app/spr.js --limit 400
 */

const { Pool } = require('pg');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const CLOB = process.env.CLOB_API_URL || 'https://clob.polymarket.com';
const LIMIT = parseInt(arg('limit', '400'), 10);
const DELAY_MS = parseInt(arg('delay', '120'), 10);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchBook(tokenId, attempt = 0) {
  const url = `${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(to);
    if (res.status === 404) return { bids: [], asks: [] };
    if (res.status === 429 || res.status >= 500) {
      if (attempt < 4) { await sleep(1000 * (attempt + 1)); return fetchBook(tokenId, attempt + 1); }
      return null;
    }
    if (!res.ok) return null;
    const j = await res.json();
    return { bids: j.bids || [], asks: j.asks || [] };
  } catch (e) {
    if (attempt < 4) { await sleep(1000 * (attempt + 1)); return fetchBook(tokenId, attempt + 1); }
    return null;
  }
}

function stats(xs) {
  const n = xs.length;
  if (n === 0) return { n: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, x) => a + x, 0) / n;
  const pct = q => s[Math.min(n - 1, Math.max(0, Math.floor(q * (n - 1))))];
  return { n, mean, p10: pct(0.10), p25: pct(0.25), median: pct(0.5), p75: pct(0.75), p90: pct(0.90) };
}

const fp = x => (x * 100).toFixed(2) + '%';

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  console.log('=== Tail-band entry-cost measurement (live CLOB order books) ===');
  console.log(`CLOB=${CLOB}  sample limit=${LIMIT}\n`);

  const { rows: markets } = await pool.query(
    `SELECT id, current_price_yes, market_type, clob_token_id_yes
     FROM markets
     WHERE is_active = true AND COALESCE(is_resolved,false) = false
       AND current_price_yes BETWEEN 0.02 AND 0.10
       AND clob_token_id_yes IS NOT NULL AND clob_token_id_yes <> ''
     ORDER BY random() LIMIT $1`,
    [LIMIT],
  );
  console.log(`Active tail-band markets sampled: ${markets.length}\n`);

  const costs = [];      // entryCostFrac (half-spread / NO stake)
  const spreadsAbs = []; // absolute YES/NO spread
  let illiquid = 0, failed = 0, crossed = 0;

  let done = 0;
  for (const m of markets) {
    const book = await fetchBook(m.clob_token_id_yes);
    await sleep(DELAY_MS);
    done++;
    if (book === null) { failed++; continue; }
    const bidP = book.bids.map(b => parseFloat(b.price)).filter(Number.isFinite);
    const askP = book.asks.map(a => parseFloat(a.price)).filter(Number.isFinite);
    if (bidP.length === 0 || askP.length === 0) { illiquid++; continue; } // one-sided / empty book
    const bestBid = Math.max(...bidP);
    const bestAsk = Math.min(...askP);
    if (bestAsk <= bestBid) { crossed++; continue; } // locked/crossed book — skip
    const spreadAbs = bestAsk - bestBid;
    const yesMid = (bestBid + bestAsk) / 2;
    const noPrice = 1 - yesMid;
    spreadsAbs.push(spreadAbs);
    costs.push((spreadAbs / 2) / noPrice);
    if (done % 100 === 0) console.log(`  ${done}/${markets.length}  liquid=${costs.length} illiquid=${illiquid}`);
  }

  const c = stats(costs);
  const s = stats(spreadsAbs);
  console.log('');
  console.log(`Books fetched: ${done}  |  liquid (2-sided): ${costs.length}  illiquid/empty: ${illiquid}  crossed: ${crossed}  failed: ${failed}`);
  console.log('');
  console.log('Absolute spread (YES/NO, same):');
  console.log(`  median=${s.median?.toFixed(4)}  mean=${s.mean?.toFixed(4)}  p25=${s.p25?.toFixed(4)}  p75=${s.p75?.toFixed(4)}  p90=${s.p90?.toFixed(4)}`);
  console.log('');
  console.log('ENTRY COST as fraction of stake  (half-spread / NO price) — the number the backtest needs:');
  console.log(`  median=${fp(c.median)}  mean=${fp(c.mean)}  p10=${fp(c.p10)}  p25=${fp(c.p25)}  p75=${fp(c.p75)}  p90=${fp(c.p90)}`);
  console.log('');
  console.log(`Backtest assumed 0.54%. Re-run backtest with --entry-cost <median above>.`);
  console.log(`Note: ${illiquid}/${done} markets had a one-sided/empty book — un-enterable; a real`);
  console.log(`strategy would filter them, so the liquid-sample cost is the relevant figure.`);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
