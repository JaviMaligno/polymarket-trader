#!/usr/bin/env node
/**
 * probe-structural-arb.js
 *
 * Feasibility probe for same-venue structural arbitrage on Polymarket.
 *
 * A negative-risk ("negRisk") event is a mutually-exclusive, exhaustive set of
 * outcome markets — exactly one resolves YES. Their YES prices must therefore
 * sum to 1. When the sum deviates:
 *   - Σ > 1: SHORT every outcome (buy every NO) — locks Σ−1 at resolution.
 *   - Σ < 1: BUY every outcome's YES — locks 1−Σ at resolution.
 * Either way the profit is |Σ−1|, regardless of which outcome wins — no
 * prediction required. The catch: you cross a spread on every one of the N
 * legs, so the arb is real only if |Σ−1| exceeds Σ(half-spread) over the legs.
 *
 * Polymarket's negRisk mechanism is designed to suppress this, so the
 * expectation is that most groups sum very close to 1. This probe measures
 * whether exploitable deviations nonetheless exist — the "measure first"
 * step before any arbitrage strategy work.
 *
 * Single snapshot — measures whether deviations EXIST and their size net of
 * spreads. Persistence (do they last long enough to execute N legs?) is a
 * follow-up if this probe finds anything.
 *
 * FINDING (2026-05-19, 3000 events, 1270 plausible-MECE groups): no
 * exploitable structural arb. Real MECE groups sum to ≈1 — median |Σ−1| 1.5%,
 * negative net of N-leg execution cost; the negRisk netting mechanism enforces
 * it (verified directly: a 6-outcome group at Σ=1.004). The probe's positive
 * tail is artifacts — N=3 groups at Σ=exactly 1.5 are three unpriced markets
 * sitting at the 0.50 default, not a tradeable arb.
 *
 * CAVEAT: negRiskMarketID is event-scoped — an event bundling several MECE
 * sub-groups yields one bucket; the Σyes∈[0.5,1.5] filter isolates plausible
 * single groups but is imperfect. The conclusion rests on the mechanism + the
 * verified example, not on a perfectly clean aggregate.
 *
 * Usage (anywhere with internet — no DB needed):
 *   node scripts/probe-structural-arb.js --pages 20
 */

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const GAMMA = process.env.GAMMA_API_URL || 'https://gamma-api.polymarket.com';
const PAGES = parseInt(arg('pages', '20'), 10);
const PAGE_SIZE = 100;
const DELAY_MS = parseInt(arg('delay', '120'), 10);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getEvents(offset, attempt = 0) {
  const url = `${GAMMA}/events?active=true&closed=false&limit=${PAGE_SIZE}&offset=${offset}`;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(to);
    if (res.status === 429 || res.status >= 500) {
      if (attempt < 4) { await sleep(1000 * (attempt + 1)); return getEvents(offset, attempt + 1); }
      return null;
    }
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    if (attempt < 4) { await sleep(1000 * (attempt + 1)); return getEvents(offset, attempt + 1); }
    return null;
  }
}

function num(x) { const n = parseFloat(x); return Number.isFinite(n) ? n : null; }

function stats(xs) {
  const n = xs.length;
  if (n === 0) return { n: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const pct = q => s[Math.min(n - 1, Math.max(0, Math.floor(q * (n - 1))))];
  return {
    n, mean: xs.reduce((a, x) => a + x, 0) / n,
    median: pct(0.5), p75: pct(0.75), p90: pct(0.90), p99: pct(0.99), max: s[n - 1],
  };
}

const fp = x => (x * 100 >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%';

async function main() {
  console.log('=== Same-venue structural arbitrage probe (Polymarket negRisk groups) ===');
  console.log(`GAMMA=${GAMMA}  scanning up to ${PAGES} pages × ${PAGE_SIZE} events\n`);

  // A true mutually-exclusive outcome set is identified by a shared
  // negRiskMarketID — NOT by event_id (an event can bundle several separate
  // negRisk groups, or independent markets). Collect every negRisk market and
  // bucket by negRiskMarketID. Markets are deduped by market id: the same
  // market is cross-listed across multiple events / returned on overlapping
  // pages, and counting it twice would inflate the sum.
  const byGroup = new Map(); // negRiskMarketID -> Map(marketId -> {yes,bid,ask})
  let eventsScanned = 0;

  for (let p = 0; p < PAGES; p++) {
    const events = await getEvents(p * PAGE_SIZE);
    await sleep(DELAY_MS);
    if (!events || events.length === 0) break;
    eventsScanned += events.length;

    for (const ev of events) {
      for (const m of (ev.markets || [])) {
        if (!m.negRisk || m.closed || m.active === false || !m.id) continue;
        const gid = m.negRiskMarketID;
        if (!gid) continue;
        let yes = null;
        try { const pr = JSON.parse(m.outcomePrices || '[]'); yes = num(pr[0]); } catch { /* */ }
        if (yes === null) yes = num(m.lastTradePrice);
        if (yes === null) continue;
        const bid = num(m.bestBid), ask = num(m.bestAsk);
        if (!byGroup.has(gid)) byGroup.set(gid, new Map());
        byGroup.get(gid).set(m.id, { yes, bid, ask }); // dedup by market id
      }
    }
  }

  const groups = []; // { gid, n, sumYes, deviation, execCost, netArb }
  for (const [gid, legMap] of byGroup) {
    const legs = [...legMap.values()];
    if (legs.length < 2) continue; // a 1-leg "group" is just a binary market
    let sumYes = 0, execCost = 0;
    for (const l of legs) {
      sumYes += l.yes;
      // half-spread per leg; fall back to a 1% assumption when the book is absent
      execCost += (l.bid !== null && l.ask !== null && l.ask > l.bid) ? (l.ask - l.bid) / 2 : 0.01;
    }
    const deviation = sumYes - 1;
    groups.push({ gid, n: legs.length, sumYes, deviation, execCost, netArb: Math.abs(deviation) - execCost });
  }

  console.log(`Events scanned: ${eventsScanned}  |  true MECE groups (by negRiskMarketID): ${groups.length}\n`);
  if (groups.length === 0) {
    console.log('No MECE groups found — cannot assess. (Check the events API / negRiskMarketID field.)');
    return;
  }

  // negRiskMarketID is event-scoped: an event bundling several MECE sub-groups
  // gives one bucket whose Σyes ≈ (number of sub-groups), not 1. Such buckets
  // are NOT a single arbitrage set. A genuine single MECE group sums to ≈1
  // regardless of how many outcomes it has, so restrict to Σyes ∈ [0.5, 1.5]
  // to isolate the buckets that are plausibly one real MECE set.
  const mece = groups.filter(g => g.sumYes >= 0.5 && g.sumYes <= 1.5);
  const dev = stats(mece.map(g => Math.abs(g.deviation)));
  const net = stats(mece.map(g => g.netArb));
  const netPos = mece.filter(g => g.netArb > 0).sort((a, b) => b.netArb - a.netArb);

  console.log(`Plausible single-MECE groups (Σyes ∈ [0.5,1.5]): ${mece.length} / ${groups.length}`);
  console.log(`(the other ${groups.length - mece.length} buckets are events bundling multiple sub-groups — not one arb set)\n`);
  console.log('|Σyes − 1|  (gross deviation, before execution cost):');
  console.log(`  median=${fp(dev.median)}  p75=${fp(dev.p75)}  p90=${fp(dev.p90)}  p99=${fp(dev.p99)}  max=${fp(dev.max)}`);
  console.log('');
  console.log('NET arb per group  (|Σ−1| − Σ half-spreads over the N legs):');
  console.log(`  median=${fp(net.median)}  p90=${fp(net.p90)}  p99=${fp(net.p99)}  max=${fp(net.max)}`);
  console.log('');
  console.log(`Plausible-MECE groups with NET arb > 0: ${netPos.length} / ${mece.length}`);
  for (const g of netPos.slice(0, 10)) {
    console.log(`  group ${g.gid.slice(0, 14)}…  N=${g.n}  Σyes=${g.sumYes.toFixed(4)}  ` +
      `gross=${fp(Math.abs(g.deviation))}  execCost=${fp(g.execCost)}  NET=${fp(g.netArb)}`);
  }
  console.log('');
  console.log(netPos.length === 0
    ? 'VERDICT: no exploitable structural arb — negRisk netting holds Σyes at ≈1 on real MECE groups.'
    : `VERDICT: ${netPos.length} plausible-MECE groups show positive net arb in this snapshot — inspect them individually (may still be mis-grouped) before any persistence study.`);
}

main().catch(e => { console.error(e); process.exit(1); });
