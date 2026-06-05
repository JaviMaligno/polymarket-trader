#!/usr/bin/env node
/**
 * Tests for the backfill classifier used by reclassify-year-horizon-crypto.js.
 *
 * Context: daily-review #308 (2026-06-05) surfaced that 11/12 tracked
 * `crypto_daily` markets are year-horizon binaries ("Will December be the best
 * month for Bitcoin in 2026?", end_date 2027-01-01) that should be `event_long`
 * (shadow-only). The live classifier already routes these correctly (PR #211,
 * e8fcd32) but only touches `market_type IS NULL` — it never re-classifies, so
 * markets labelled before the fix stay wrong and leak real capital into
 * shadow-only cohorts.
 *
 * classifyWithRegex here is a verbatim port of MarketClassifier.classifyWithRegex
 * (regex path). The backfill re-runs it over already-classified crypto_* markets
 * and corrects the diffs. These tests pin the port to the live behaviour.
 */
const assert = require('node:assert/strict');
const { classifyWithRegex } = require('./reclassify-year-horizon-crypto.js');

// Fixed "now" is implicit (Date.now); use relative offsets via real dates far
// enough out that the boundary is unambiguous.
const inDays = (d) => new Date(Date.now() + d * 24 * 60 * 60 * 1000);
const inHours = (h) => new Date(Date.now() + h * 60 * 60 * 1000);

const cases = [
  {
    name: 'year-horizon "best month for Bitcoin" → event_long (the #308 bug)',
    fn: () => assert.equal(
      classifyWithRegex('Will December be the best month for Bitcoin in 2026?', inDays(210)),
      'event_long'),
  },
  {
    name: 'year-horizon crypto PRICE market → event_long',
    fn: () => assert.equal(
      classifyWithRegex('Will Bitcoin reach $100,000 by Dec 31, 2026?', inDays(210)),
      'event_long'),
  },
  {
    name: 'short-horizon crypto price market → crypto_daily',
    fn: () => assert.equal(
      classifyWithRegex('Will Bitcoin be above $90,000 by Friday?', inDays(5)),
      'crypto_daily'),
  },
  {
    name: 'intraday up/down crypto → crypto_intraday',
    fn: () => assert.equal(
      classifyWithRegex('Bitcoin up or down in the next 2 hours?', inHours(2)),
      'crypto_intraday'),
  },
  {
    name: 'Bitcoin-vs-Gold year market → event_financial (gold keyword)',
    fn: () => assert.equal(
      classifyWithRegex('Will Bitcoin outperform Gold in 2026?', inDays(210)),
      'event_financial'),
  },
  {
    name: 'MicroStrategy holdings year market → event_long',
    fn: () => assert.equal(
      classifyWithRegex('Will MicroStrategy announce holding 1M+ BTC by December 31, 2026?', inDays(210)),
      'event_long'),
  },
  {
    name: 'non-crypto long event → event_long',
    fn: () => assert.equal(
      classifyWithRegex('Will Canada win the 2026 FIFA World Cup?', inDays(210)),
      'event_long'),
  },
  {
    name: 'non-crypto short event → event_short',
    fn: () => assert.equal(
      classifyWithRegex('Will it rain in NYC next week?', inDays(5)),
      'event_short'),
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
