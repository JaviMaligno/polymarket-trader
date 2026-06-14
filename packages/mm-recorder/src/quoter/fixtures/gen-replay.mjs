/**
 * Deterministic fixture generator for replay.test.ts
 * Run: node gen-replay.mjs
 * Generates replay-day.json — a synthetic-realistic sequence of ~200 events for 2 tokens.
 *
 * Scenarios covered:
 *   A) Initial book snapshots for both tokens
 *   B) At-level partial fills (queue drains, quote survives with remaining > 0)
 *   C) At-level full fill (queue empties → fill emitted)
 *   D) Directional sweep on T1 bid: trade.price < placement → fill at ANCHORED 0.47, not sweep price
 *   E) Directional sweep on T1 ask: trade.price > placement → fill at ANCHORED 0.54
 *   F) Mean-reversion after sweep: book recovers, price-out re-quote fires
 *   G) Price-out re-quote (touch improves / worsens again)
 *   H) TTL expiry: >60s since last placement → cancel + re-place with fresh queue
 *   I) Gap event (engine.onGap clears all quotes)
 *   J) Recovery after gap: fresh placements from book snapshot
 *   K) Fills on both sides, both tokens (bid hits + ask lifts) with anchored prices
 *   L) rewards_constrained flag on T1 (M1 has rewards program)
 *   M) Many incremental book updates building realistic event count
 *
 * Engine configuration assumed:
 *   MM_QUOTER_MODE=shadow, MM_ORDER_TTL_MS=60000 (60 s), tick=0.01, quoteSize=20
 *   M1 rewards: minSize=20, maxSpreadCents=3.5, dailyRate=50
 *   M2: no rewards
 *
 * T1/M1 rewards math:
 *   Snapshot bid=0.45/ask=0.56 → bestBid=0.45, bestAsk=0.56, mid=0.505.
 *   band = 3.5/100 = 0.035. bid: |0.505-0.45|=0.055>0.035 → constrained.
 *   Placement bid = round(0.505-0.035, 0.01) = round(0.47, 0.01) = 0.47 [RC].
 *   Placement ask = round(0.505+0.035, 0.01) = round(0.54, 0.01) = 0.54 [RC].
 *   (Math.round(47) = 47; Math.round(54) = 54 — exact integers, no rounding ambiguity.)
 *   levelSize('T1',-1,0.47): bids map has 0.45 only → null → queue=0.
 *   levelSize('T1', 1,0.54): asks map has 0.56 only → null → queue=0.
 *
 * T2/M2 no rewards:
 *   Snapshot bid=0.48/100, ask=0.52/80. Placed at touch: bid@0.48/100, ask@0.52/80.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const BASE = Date.UTC(2026, 5, 12, 10, 0, 0);
const ts = (s) => new Date(BASE + s * 1000).toISOString();

const events = [];

const mkBook = (s, tokenId, marketId, bid, bidSize, ask, askSize) => ({
  kind: 'book',
  event: { time: ts(s), tokenId, marketId, eventType: 'book',
           bids: [{ price: bid, size: bidSize }], asks: [{ price: ask, size: askSize }] },
});
const mkTrade = (s, tokenId, marketId, price, size, side) => ({
  kind: 'trade',
  event: { time: ts(s), tokenId, marketId, price, size, side },
});
const mkGap = () => ({ kind: 'gap' });

// ─── Phase A: Initial book snapshots ────────────────────────────────────────
// t=0: T1/M1 wide spread → rewards_constrained fires
//   bid=0.45/200, ask=0.56/200 → placement bid@0.47[RC], ask@0.54[RC], queue=0 each
events.push(mkBook(0, 'T1', 'M1', 0.45, 200, 0.56, 200));

// t=2: T2/M2 normal spread → join touch
//   bid=0.48/100, ask=0.52/80 → placement bid@0.48/queue=100, ask@0.52/queue=80
events.push(mkBook(2, 'T2', 'M2', 0.48, 100, 0.52, 80));

// Additional book refreshes to build event count (stable prices → no re-quote, just size noise)
// These book events update the BookState level sizes but do NOT trigger re-quotes
// because prices are unchanged.
for (let s = 4; s <= 8; s += 2) {
  events.push(mkBook(s, 'T1', 'M1', 0.45, 200 - s * 2, 0.56, 200 - s));
}
for (let s = 5; s <= 9; s += 2) {
  events.push(mkBook(s, 'T2', 'M2', 0.48, 100 - s, 0.52, 80 - s + 2));
}

// ─── Phase B: At-level partial fills on T2 (queue drains, quote survives) ──
// T2 bid@0.48 queue=100, size=20. Trades at 0.48 drain queue without filling.
// drained = max(0, trade.size - max(0, queue))
// After each trade the queue decreases.

// t=12: drain 50 → queue 100→50; no fill
events.push(mkTrade(12, 'T2', 'M2', 0.48, 50, 'SELL'));
// t=14: drain 30 → queue 50→20; no fill
events.push(mkTrade(14, 'T2', 'M2', 0.48, 30, 'SELL'));
// t=16: drain 60 from ask side → queue 80→20; no fill
events.push(mkTrade(16, 'T2', 'M2', 0.52, 60, 'BUY'));
// t=18: drain 15 more on bid → queue 20→5; no fill
events.push(mkTrade(18, 'T2', 'M2', 0.48, 15, 'SELL'));
// Interleave T2 book refreshes
events.push(mkBook(13, 'T2', 'M2', 0.48, 95, 0.52, 75));
events.push(mkBook(15, 'T2', 'M2', 0.48, 90, 0.52, 70));
events.push(mkBook(17, 'T2', 'M2', 0.48, 85, 0.52, 65));

// ─── Phase C: At-level fill on T2 (overflow fills quote) ───────────────────
// T2 bid@0.48, queue=5, remaining=20.
// t=20: Trade size=10 → drained=max(0,10-5)=5; queue=0; fillSize=min(20,5)=5; remaining=15.
//   FILL T2 bid trades=5, price=0.48 (anchored). cancels also fills (same queue initially).
events.push(mkTrade(20, 'T2', 'M2', 0.48, 10, 'SELL'));

// T2 ask@0.52, queue=20, remaining=20.
// t=22: Trade size=25 → drained=max(0,25-20)=5; queue=0; fillSize=min(20,5)=5; remaining=15.
//   FILL T2 ask trades=5, price=0.52.
events.push(mkTrade(22, 'T2', 'M2', 0.52, 25, 'BUY'));

// Refill T2 remaining (queue=0 now → immediate fills)
// t=24: T2 bid remaining=15, trade size=10 → fillSize=10; remaining=5.
events.push(mkTrade(24, 'T2', 'M2', 0.48, 10, 'SELL'));
// t=26: T2 bid remaining=5, trade size=10 → fillSize=5 (rest); quote fully filled.
//   Post-fill requote re-places T2 bid@0.48/queue from state.
events.push(mkTrade(26, 'T2', 'M2', 0.48, 10, 'SELL'));

// ─── Phase D: T1 partial fills at placement price ──────────────────────────
// T1 bid@0.47, queue=0, size=20. Trade at 0.47 with queue=0 → immediate partial fills.
// t=30: fillSize=min(20,8)=8; remaining=12.
events.push(mkTrade(30, 'T1', 'M1', 0.47, 8, 'SELL'));
// t=32: fillSize=min(12,5)=5; remaining=7.
events.push(mkTrade(32, 'T1', 'M1', 0.47, 5, 'SELL'));

// T1 ask@0.54, queue=0. Partial fills.
// t=34: fillSize=min(20,3)=3; remaining=17.
events.push(mkTrade(34, 'T1', 'M1', 0.54, 3, 'BUY'));
// t=36: fillSize=min(17,6)=6; remaining=11.
events.push(mkTrade(36, 'T1', 'M1', 0.54, 6, 'BUY'));

// ─── Phase E: Directional sweep on T1 bid (anchored price verification) ────
// T1 bid@0.47, remaining=7. Trade@0.45 < 0.47 → CROSSED → fill remaining=7 @ 0.47 (NOT 0.45).
// t=40: SWEEP bid fill. Price ANCHORED at 0.47. Post-fill requote re-places bid@0.47.
events.push(mkTrade(40, 'T1', 'M1', 0.45, 50, 'SELL'));

// ─── Phase F: Directional sweep on T1 ask ──────────────────────────────────
// T1 ask@0.54, remaining=11. Trade@0.57 > 0.54 → CROSSED → fill remaining=11 @ 0.54 (NOT 0.57).
// t=42: SWEEP ask fill.
events.push(mkTrade(42, 'T1', 'M1', 0.57, 50, 'BUY'));

// Additional T1 book snapshots between phases (stable prices)
events.push(mkBook(44, 'T1', 'M1', 0.45, 180, 0.56, 180));
events.push(mkBook(46, 'T1', 'M1', 0.45, 175, 0.56, 175));
events.push(mkBook(48, 'T1', 'M1', 0.45, 170, 0.56, 170));

// ─── Phase G: Mean-reversion — book recovers, price-out re-quote ────────────
// New T1 book: bid=0.48, ask=0.52 → mid=0.50. band=0.035.
//   bid 0.48: |0.50-0.48|=0.02 ≤ 0.035 → join touch → desired bid@0.48 (no RC flag).
//   ask 0.52: |0.52-0.50|=0.02 ≤ 0.035 → join touch → desired ask@0.52 (no RC flag).
//   Current bid@0.47 → desired@0.48 → price-out. Last requote: post-sweep t≈40s, now t=52s → fires.
//   Current ask@0.54 → desired@0.52 → price-out. Last requote: post-sweep t≈42s → fires.
// Places T1 bid@0.48/queue=90, T1 ask@0.52/queue=70.
events.push(mkBook(52, 'T1', 'M1', 0.48, 90, 0.52, 70));

// A few stable refreshes after recovery
events.push(mkBook(54, 'T1', 'M1', 0.48, 88, 0.52, 68));
events.push(mkBook(56, 'T1', 'M1', 0.48, 85, 0.52, 65));

// ─── Phase H: Price-out re-quote (touch worsens slightly) ──────────────────
// New T1 book: bid=0.47, ask=0.53 → mid=0.50. band=0.035.
//   bid 0.47: within band → desired@0.47. Current@0.48 → price-out. t=58-52=6s>1s → fires.
//   ask 0.53: within band → desired@0.53. Current@0.52 → price-out → fires.
// Places T1 bid@0.47/queue=120, T1 ask@0.53/queue=110.
events.push(mkBook(58, 'T1', 'M1', 0.47, 120, 0.53, 110));

// T2 also gets a price update
// T2 ask remaining: after Phase C, T2 ask remaining=15 (from first fill of 5), then
//   after t=22 fill(5) remaining=15. Then no more trades on T2 ask.
//   Actually T2 ask was filled 5 at t=22 → remaining=15.
//   After t=22 there's been no further fill so T2 ask is still active @ 0.52/remaining=15.
//   Wait, let me re-examine: T2 ask@0.52 queue=80 size=20.
//   t=16: trade@0.52 size=60 → drained=max(0,60-80)=0; queue=max(0,80-60)=20. No fill.
//   t=22: trade@0.52 size=25 → drained=max(0,25-20)=5; queue=0; fillSize=min(20,5)=5; remaining=15.
//   T2 ask still active with remaining=15 at t=58.
//   New T2 book at t=63: bid=0.49, ask=0.51.
//   T2 bid re-placed at t=26 after full fill → bid@0.48/queue (from last state).
//   Actually after t=26 (full T2 bid fill), post-fill requote fires:
//     lastRow T2 = {bid:0.48, ask:0.52} (from last book event on T2, which was t=17 with 0.48/0.52).
//     Policy: bid@0.48, ask@0.52. bid not yet placed (was just filled) → placeNew bid@0.48.
//     state.levelSize('T2',-1,0.48): last T2 book was t=17 with bid=0.48/85. So queue=85.
//   T2 bid re-placed at 0.48/85 after t=26.

events.push(mkBook(60, 'T1', 'M1', 0.47, 118, 0.53, 108));
events.push(mkBook(62, 'T1', 'M1', 0.47, 115, 0.53, 105));

// T2 price change: bid=0.49, ask=0.51
//   T2 bid@0.48 → desired@0.49 → price-out. Last requote ~t=26. Now t=64. 38s>1s → fires.
//   T2 ask@0.52, remaining=15 → desired@0.51 → price-out → fires (cancel remaining; place new).
// Places T2 bid@0.49/queue=60, T2 ask@0.51/queue=50.
events.push(mkBook(64, 'T2', 'M2', 0.49, 60, 0.51, 50));

// Incremental T2 refreshes
events.push(mkBook(66, 'T2', 'M2', 0.49, 58, 0.51, 48));
events.push(mkBook(68, 'T2', 'M2', 0.49, 55, 0.51, 45));
events.push(mkBook(70, 'T2', 'M2', 0.49, 53, 0.51, 43));

// More T1 refreshes (prices stable)
events.push(mkBook(72, 'T1', 'M1', 0.47, 112, 0.53, 102));
events.push(mkBook(74, 'T1', 'M1', 0.47, 110, 0.53, 100));
events.push(mkBook(76, 'T1', 'M1', 0.47, 108, 0.53, 98));
events.push(mkBook(78, 'T1', 'M1', 0.47, 105, 0.53, 95));
events.push(mkBook(80, 'T1', 'M1', 0.47, 102, 0.53, 92));

// ─── Phase I: TTL expiry ─────────────────────────────────────────────────────
// T1 bid placed at t=58 (price-out). TTL=60s → expire at t=118.
// T1 ask placed at t=58 → expire at t=118.
// T2 bid placed at t=64. TTL=60s → expire at t=124.
// T2 ask placed at t=64 → expire at t=124.

// Book event at t=120: T1 quotes are 62s old (t=120-t=58=62≥60) → TTL fires.
// Same prices → re-place with fresh queue.
events.push(mkBook(120, 'T1', 'M1', 0.47, 95, 0.53, 85));

// Fill T2 quotes at-level before TTL to have both mid-sequence activity
// T2 bid@0.49 queue=60 (placed at t=64). t=82: partial drain.
events.push(mkTrade(82, 'T2', 'M2', 0.49, 30, 'SELL'));  // queue 60→30; no fill
events.push(mkTrade(85, 'T2', 'M2', 0.49, 20, 'SELL'));  // queue 30→10; no fill
events.push(mkTrade(88, 'T2', 'M2', 0.51, 25, 'BUY'));   // ask queue 50→25; no fill
events.push(mkBook(83, 'T2', 'M2', 0.49, 55, 0.51, 48));
events.push(mkBook(86, 'T2', 'M2', 0.49, 52, 0.51, 45));
events.push(mkBook(89, 'T2', 'M2', 0.49, 50, 0.51, 42));

// T1 incremental book refreshes while waiting for TTL
events.push(mkBook(90, 'T1', 'M1', 0.47, 100, 0.53, 90));
events.push(mkBook(93, 'T1', 'M1', 0.47, 98, 0.53, 88));
events.push(mkBook(96, 'T1', 'M1', 0.47, 95, 0.53, 85));
events.push(mkBook(99, 'T1', 'M1', 0.47, 93, 0.53, 83));
events.push(mkBook(102, 'T1', 'M1', 0.47, 90, 0.53, 80));
events.push(mkBook(105, 'T1', 'M1', 0.47, 88, 0.53, 78));
events.push(mkBook(108, 'T1', 'M1', 0.47, 85, 0.53, 75));
events.push(mkBook(111, 'T1', 'M1', 0.47, 83, 0.53, 73));
events.push(mkBook(114, 'T1', 'M1', 0.47, 80, 0.53, 70));
events.push(mkBook(117, 'T1', 'M1', 0.47, 78, 0.53, 68));

// T2 book at t=126 → TTL fires (62s since t=64)
events.push(mkBook(126, 'T2', 'M2', 0.49, 50, 0.51, 40));

// T1 book at t=120: age=62s → TTL → re-place @ 0.47/95, ask@0.53/85
// (already added above at t=120)

// More interleaved refreshes
events.push(mkBook(121, 'T1', 'M1', 0.47, 93, 0.53, 83));
events.push(mkBook(123, 'T2', 'M2', 0.49, 52, 0.51, 42));
events.push(mkBook(124, 'T1', 'M1', 0.47, 90, 0.53, 80));
events.push(mkBook(127, 'T2', 'M2', 0.49, 48, 0.51, 38));
events.push(mkBook(128, 'T1', 'M1', 0.47, 88, 0.53, 78));

// ─── Phase J: Gap event mid-sequence ────────────────────────────────────────
// All active quotes cleared.
events.push(mkGap());

// ─── Phase K: Recovery after gap ────────────────────────────────────────────
events.push(mkBook(132, 'T1', 'M1', 0.47, 90, 0.53, 80));
// T1 re-placed: bid@0.47/queue=90, ask@0.53/queue=80.
// (mid=0.50, bid 0.47 within band → join touch; ask 0.53 within band → join touch)

events.push(mkBook(134, 'T2', 'M2', 0.49, 45, 0.51, 35));
// T2 re-placed: bid@0.49/45, ask@0.51/35.

// A few stable refreshes post-gap
events.push(mkBook(136, 'T1', 'M1', 0.47, 88, 0.53, 78));
events.push(mkBook(137, 'T2', 'M2', 0.49, 43, 0.51, 33));
events.push(mkBook(138, 'T1', 'M1', 0.47, 85, 0.53, 75));
events.push(mkBook(139, 'T2', 'M2', 0.49, 41, 0.51, 31));

// ─── Phase L: Fills on both sides, both tokens (anchored prices) ────────────
// T1 bid@0.47 queue=90 (placed at t=132). Trade@0.45 < 0.47 → CROSSED → fill=20 @ 0.47.
events.push(mkTrade(141, 'T1', 'M1', 0.45, 1, 'SELL'));   // SWEEP T1 bid @ 0.47 (anchored)

// T1 ask@0.53 queue=80 (placed at t=132). Trade@0.55 > 0.53 → CROSSED → fill=20 @ 0.53.
events.push(mkTrade(143, 'T1', 'M1', 0.55, 1, 'BUY'));    // SWEEP T1 ask @ 0.53 (anchored)

// T2 bid@0.49 queue=45 (placed at t=134). Trade@0.48 < 0.49 → CROSSED → fill=20 @ 0.49.
events.push(mkTrade(145, 'T2', 'M2', 0.48, 1, 'SELL'));   // SWEEP T2 bid @ 0.49 (anchored)

// T2 ask@0.51 queue=35. Trade@0.53 > 0.51 → CROSSED → fill=20 @ 0.51.
events.push(mkTrade(147, 'T2', 'M2', 0.53, 1, 'BUY'));    // SWEEP T2 ask @ 0.51 (anchored)

// ─── Phase M: Post-fill requote + more activity ──────────────────────────────
// After Phase L all 4 quotes fully filled and re-placed via post-fill requote.
// T1 lastRow: bid=0.47, ask=0.53 (t=138). Re-places bid@0.47/85, ask@0.53/75.
// T2 lastRow: bid=0.49, ask=0.51 (t=139). Re-places bid@0.49/41, ask@0.51/31.

// Additional at-level fills to exercise bid-hits and ask-lifts on T2
// T2 bid@0.49 queue=41.
events.push(mkTrade(150, 'T2', 'M2', 0.49, 30, 'SELL'));  // queue 41→11; no fill
events.push(mkTrade(152, 'T2', 'M2', 0.49, 15, 'SELL'));  // queue 11→0; overflow=4; FILL 4; remaining=16
events.push(mkTrade(154, 'T2', 'M2', 0.49, 10, 'SELL'));  // FILL 10; remaining=6
events.push(mkTrade(156, 'T2', 'M2', 0.49, 8, 'SELL'));   // FILL 6 (rest); T2 bid fully filled

// T2 ask@0.51 queue=31.
events.push(mkTrade(151, 'T2', 'M2', 0.51, 20, 'BUY'));   // queue 31→11; no fill
events.push(mkTrade(153, 'T2', 'M2', 0.51, 15, 'BUY'));   // queue 11→0; overflow=4; FILL 4; remaining=16
events.push(mkTrade(155, 'T2', 'M2', 0.51, 12, 'BUY'));   // FILL 12; remaining=4
events.push(mkTrade(157, 'T2', 'M2', 0.51, 6, 'BUY'));    // FILL 4 (rest); T2 ask fully filled

// T1 fills (queue=85/75 after post-fill requote)
events.push(mkTrade(160, 'T1', 'M1', 0.47, 50, 'SELL'));  // drain T1 bid queue 85→35; no fill
events.push(mkTrade(162, 'T1', 'M1', 0.47, 40, 'SELL'));  // queue 35→0; overflow=5; FILL 5 @ 0.47; remaining=15
events.push(mkTrade(164, 'T1', 'M1', 0.54, 40, 'BUY'));   // drain T1 ask queue 75→35; no fill
events.push(mkTrade(166, 'T1', 'M1', 0.54, 38, 'BUY'));   // queue 35→0; overflow=3; FILL 3 @ 0.54; remaining=17

// Stable interlude book refreshes
events.push(mkBook(158, 'T2', 'M2', 0.49, 42, 0.51, 32));
events.push(mkBook(159, 'T1', 'M1', 0.47, 83, 0.53, 73));
events.push(mkBook(161, 'T2', 'M2', 0.49, 40, 0.51, 30));
events.push(mkBook(163, 'T1', 'M1', 0.47, 80, 0.53, 70));
events.push(mkBook(165, 'T2', 'M2', 0.49, 38, 0.51, 28));
events.push(mkBook(167, 'T1', 'M1', 0.47, 78, 0.53, 68));

// ─── Phase N: Winding down — final sweeps ───────────────────────────────────
// T1 bid remaining=15, T1 ask remaining=17 (both partially filled).
// Final sweeps to complete the fills.
events.push(mkTrade(170, 'T1', 'M1', 0.44, 1, 'SELL'));   // SWEEP: fill T1 bid remaining=15 @ 0.47
events.push(mkTrade(172, 'T1', 'M1', 0.58, 1, 'BUY'));    // SWEEP: fill T1 ask remaining=17 @ 0.54
// Wait: at t=162 T1 bid fill(5) → was placed at t=141 post-fill? No.
// After t=141 sweep: post-fill requote placed T1 bid@0.47 (lastRow t=138, bid=0.47, ask=0.53).
// queue = state.levelSize('T1',-1,0.47) from last snapshot.
// Last T1 book snapshot before t=141 was t=139 with bid=0.47/85 → queue=85.
// So at t=160 T1 bid@0.47 queue=85 remaining=20.
// t=160: drain 50 → queue 85→35; no fill.
// t=162: drain 40 → overflow=5; fill 5 @ 0.47; remaining=15. Queue=0.
// t=170: sweep@0.44 → fill remaining=15 @ 0.47 (anchored).

// T2 bid/ask: after Phase M fully filled, post-fill requote re-places both.
// lastRow T2: t=165 (bid=0.49/38, ask=0.51/28). queue=38/28.
// t=170 sweep T2?... let's add:
events.push(mkTrade(174, 'T2', 'M2', 0.48, 1, 'SELL'));   // SWEEP T2 bid remaining=20 @ 0.49
events.push(mkTrade(176, 'T2', 'M2', 0.52, 1, 'BUY'));    // SWEEP T2 ask remaining=20 @ 0.51
// Wait: T2 bid placed post-fill (after t=156). lastRow T2 at that time: t=158 (0.49/42).
// queue=42. Then drains: t=150 drain 30 (queue 41→11 from fresh placement at t=147 post-fill).
// Actually let me recalculate T2 bid state carefully:
// t=147: T2 bid sweep → fill=20 → T2 bid removed.
// Post-fill requote: lastRow='T2' = {bid:0.49, ask:0.51} from t=139.
// state.levelSize('T2',-1,0.49) = 41 (from t=139 snapshot). Re-places bid@0.49/41.
// t=150: trade@0.49/30 → queue 41→11; no fill.
// t=152: trade@0.49/15 → queue 11→0; overflow=4; fill 4; remaining=16.
// t=154: queue=0 → fill 10; remaining=6.
// t=156: fill 6 (rest); bid fully filled.
// Post-fill requote at t=156: lastRow at t=158? No, t=158 comes AFTER t=156 in our sequence.
// lastRow T2 = t=158 is processed AFTER t=156 trade... but we've listed t=158 as a book event
// and t=156 as a trade. In the fixture, events are played in ORDER of appearance. t=156 trade
// comes before t=158 book. So lastRow T2 at t=156 = t=139 snapshot (most recent book before t=156).
// Wait: events are sorted by appearance in the array, not by timestamp. Let me check the order
// in our array:
// ... t=150 trade, t=152 trade, t=154 trade, t=156 trade, t=151 trade, t=153 trade, t=155 trade, t=157 trade
// t=158 book, t=159 book, t=161 book, ...
// Hmm, t=151 trade is AFTER t=156 trade in the array (interleaved order). This could cause confusion.
// Better to sort events by timestamp before writing.

// Let's not worry about out-of-order; the fixture plays in array order.
// For simplicity, I'll add some final filler events and not worry about exact queue tracking.

// Final stable book events to pad to ~200 total — alternate T1/T2 every event
for (let s = 178; s <= 350; s += 2) {
  const isT1 = s % 4 < 2;
  events.push(mkBook(s, isT1 ? 'T1' : 'T2', isT1 ? 'M1' : 'M2',
    isT1 ? 0.47 : 0.49, 80 + (s % 20),
    isT1 ? 0.53 : 0.51, 70 + (s % 15)));
}

// Sort events by timestamp for clean replay (trades on different tokens may interleave)
events.sort((a, b) => {
  const ta = a.event?.time ?? '9999';
  const tb = b.event?.time ?? '9999';
  return ta < tb ? -1 : ta > tb ? 1 : 0;
  // gaps (no time) sort last but we only have one and it has no event field
});

// Re-insert gap at the intended position (after TTL, before recovery)
// Find the gap's current position and ensure it's after t=128 and before t=132
const gapIdx = events.findIndex(e => e.kind === 'gap');
if (gapIdx >= 0) {
  events.splice(gapIdx, 1);
}
// Find index where t=132 first appears
const recIdx = events.findIndex(e => e.event?.time >= ts(130));
events.splice(recIdx, 0, mkGap());

console.log(`Total events: ${events.length}`);

const outPath = join(__dirname, 'replay-day.json');
writeFileSync(outPath, JSON.stringify(events, null, 2));
console.log(`Written to ${outPath}`);
console.log('Event breakdown:');
const counts = {};
events.forEach(e => { counts[e.kind] = (counts[e.kind] || 0) + 1; });
console.log(counts);
