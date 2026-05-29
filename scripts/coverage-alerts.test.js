#!/usr/bin/env node
/**
 * Unit tests for detectSupplyCollapse — the deterministic "an ALLOWED market
 * type has zero tracked markets" alert. Added 2026-05-29 after Watchdog #280
 * silently missed crypto_intraday=0 (the supply-collapse rule lived only in the
 * LLM prompt §1d, not in format-review.js's deterministic alert layer).
 */
const assert = require('node:assert/strict');
const { detectSupplyCollapse, DEFAULT_ALLOWED_MARKET_TYPES } = require('./coverage-alerts.js');

const ALLOWED = ['crypto_intraday', 'crypto_daily', 'event_financial', 'event_short'];

const cases = [
  {
    name: 'allowed type present with tracked=0 → flagged',
    fn: () => {
      const coverage = [
        { market_type: 'crypto_intraday', tracked: 0, priced_24h: 0, with_preds_24h: 0 },
        { market_type: 'crypto_daily', tracked: 7, priced_24h: 7, with_preds_24h: 5 },
        { market_type: 'event_financial', tracked: 14, priced_24h: 14, with_preds_24h: 5 },
        { market_type: 'event_short', tracked: 22, priced_24h: 22, with_preds_24h: 64 },
      ];
      const got = detectSupplyCollapse(coverage, ALLOWED);
      assert.equal(got.length, 1);
      assert.equal(got[0].market_type, 'crypto_intraday');
      assert.equal(got[0].tracked, 0);
    },
  },
  {
    name: 'allowed type entirely absent from coverage (GROUP BY dropped it) → flagged',
    fn: () => {
      // event_short has zero rows in the markets table → the GROUP BY query
      // emits no row for it. It must still be flagged, not silently invisible.
      const coverage = [
        { market_type: 'crypto_daily', tracked: 7, priced_24h: 7, with_preds_24h: 5 },
      ];
      const got = detectSupplyCollapse(coverage, ALLOWED);
      const types = got.map((r) => r.market_type).sort();
      assert.deepEqual(types, ['crypto_intraday', 'event_financial', 'event_short']);
      // absent types report tracked=0
      assert.ok(got.every((r) => r.tracked === 0));
    },
  },
  {
    name: 'all allowed types tracked > 0 → no alert',
    fn: () => {
      const coverage = ALLOWED.map((market_type) => ({ market_type, tracked: 5, priced_24h: 5, with_preds_24h: 5 }));
      const got = detectSupplyCollapse(coverage, ALLOWED);
      assert.equal(got.length, 0);
    },
  },
  {
    name: 'shadow-only type (event_long) with tracked=0 is NOT flagged (not in ALLOWED)',
    fn: () => {
      const coverage = [
        { market_type: 'event_long', tracked: 0, priced_24h: 0, with_preds_24h: 0 },
        ...ALLOWED.map((market_type) => ({ market_type, tracked: 5, priced_24h: 5, with_preds_24h: 5 })),
      ];
      const got = detectSupplyCollapse(coverage, ALLOWED);
      assert.equal(got.length, 0);
    },
  },
  {
    name: 'string-typed tracked (json numerics arrive as strings) handled',
    fn: () => {
      const coverage = [
        { market_type: 'crypto_intraday', tracked: '0', priced_24h: '0', with_preds_24h: '0' },
        { market_type: 'crypto_daily', tracked: '7' },
        { market_type: 'event_financial', tracked: '14' },
        { market_type: 'event_short', tracked: '22' },
      ];
      const got = detectSupplyCollapse(coverage, ALLOWED);
      assert.equal(got.length, 1);
      assert.equal(got[0].market_type, 'crypto_intraday');
    },
  },
  {
    name: 'defaults: empty/undefined coverage flags every allowed type',
    fn: () => {
      const got = detectSupplyCollapse([], DEFAULT_ALLOWED_MARKET_TYPES);
      assert.equal(got.length, DEFAULT_ALLOWED_MARKET_TYPES.length);
    },
  },
  {
    name: 'undefined coverage arg does not throw',
    fn: () => {
      const got = detectSupplyCollapse(undefined, ALLOWED);
      assert.equal(got.length, ALLOWED.length);
    },
  },
  {
    name: 'DEFAULT_ALLOWED_MARKET_TYPES excludes untradeable crypto_intraday',
    fn: () => {
      assert.ok(!DEFAULT_ALLOWED_MARKET_TYPES.includes('crypto_intraday'));
      assert.deepEqual(DEFAULT_ALLOWED_MARKET_TYPES, ['crypto_daily', 'event_financial', 'event_short']);
    },
  },
];

let failed = 0;
for (const c of cases) {
  try {
    c.fn();
    console.log(`  ✓ ${c.name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${c.name}\n    ${err.message}`);
  }
}
if (failed > 0) {
  console.error(`\n${failed}/${cases.length} tests failed`);
  process.exit(1);
}
console.log(`\n${cases.length}/${cases.length} tests passed`);
