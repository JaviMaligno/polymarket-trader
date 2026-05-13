#!/usr/bin/env node
/**
 * Unit tests for the edge_capacity computation (Phase 4 PR-A).
 */
const assert = require('node:assert/strict');
const { computeEdgeCapacity } = require('./measure-edge-capacity.js');

const cases = [
  {
    name: 'empty input → empty map',
    fn: () => {
      const got = computeEdgeCapacity([], null, 0.01, 50);
      assert.equal(got.size, 0);
    },
  },
  {
    name: 'single positive net cell → edge_capacity > 0',
    fn: () => {
      const cells = [
        // mean_reversion crypto_intraday SHORT 2026-05-13: gross=+1.369%, t_gross=+10.14, n=126
        // With rt=1.08%: t_net ≈ 10.14 × (1.369 - 1.08) / 1.369 ≈ 2.14
        { signal_id: 'mean_reversion', market_type: 'crypto_intraday', direction: 'short', n: 126, gross_pct: 1.369, t_gross: 10.14 },
      ];
      const got = computeEdgeCapacity(cells, null, 0.0108, 50);
      const e = got.get('crypto_intraday');
      assert.ok(e, 'crypto_intraday entry exists');
      assert.ok(Math.abs(e.sum - 2.14) < 0.05, `sum got ${e.sum}, expected ~2.14`);
      assert.equal(e.positive, 1);
      assert.equal(e.measured, 1);
    },
  },
  {
    name: 'cells under min_n are dropped',
    fn: () => {
      const cells = [
        { signal_id: 'x', market_type: 'event_short', direction: 'long', n: 30, gross_pct: 1.0, t_gross: 5 },
      ];
      const got = computeEdgeCapacity(cells, null, 0.01, 50);
      assert.equal(got.size, 0);
    },
  },
  {
    name: 'anti-edge cells contribute 0 (not negative) to the sum',
    fn: () => {
      const cells = [
        // good cell t_net ≈ +2.14
        { signal_id: 'mean_reversion', market_type: 'crypto_intraday', direction: 'short', n: 126, gross_pct: 1.369, t_gross: 10.14 },
        // bad cell t_net very negative — should NOT subtract
        { signal_id: 'momentum', market_type: 'crypto_intraday', direction: 'long', n: 3000, gross_pct: -0.06, t_gross: -3.25 },
      ];
      const got = computeEdgeCapacity(cells, null, 0.0108, 50);
      const e = got.get('crypto_intraday');
      assert.ok(Math.abs(e.sum - 2.14) < 0.05, `sum got ${e.sum}, expected ~2.14`);
      assert.equal(e.positive, 1, 'one positive cell counted');
      assert.equal(e.measured, 2, 'both cells measured');
    },
  },
  {
    name: 'event_financial post 2026-05-13: every cell anti-edge net → edge_capacity = 0',
    fn: () => {
      const cells = [
        { signal_id: 'mean_reversion', market_type: 'event_financial', direction: 'long', n: 4200, gross_pct: 0.552, t_gross: 16.94 },
        { signal_id: 'momentum', market_type: 'event_financial', direction: 'long', n: 7661, gross_pct: 0.203, t_gross: 11.31 },
        { signal_id: 'mean_reversion', market_type: 'event_financial', direction: 'short', n: 2387, gross_pct: 0.025, t_gross: 0.82 },
      ];
      const got = computeEdgeCapacity(cells, null, 0.0108, 50);
      const e = got.get('event_financial');
      assert.equal(e.sum, 0, 'edge_capacity is 0 when no cell beats cost');
      assert.equal(e.positive, 0);
      assert.equal(e.measured, 3);
    },
  },
  {
    name: 'zero-information cells (gross=0, t=0) measured but do not contribute',
    fn: () => {
      const cells = [
        // event_short World Cup: static midpoints → gross=0
        { signal_id: 'mean_reversion', market_type: 'event_short', direction: 'long', n: 336, gross_pct: 0, t_gross: 0 },
      ];
      const got = computeEdgeCapacity(cells, null, 0.01, 50);
      const e = got.get('event_short');
      assert.equal(e.sum, 0);
      assert.equal(e.positive, 0);
      assert.equal(e.measured, 1, 'cell is measured (counted) but contributes 0');
    },
  },
  {
    name: 'per-type rt_cost map override is honored',
    fn: () => {
      const cells = [
        // gross=0.6%. With rt=0.5% → t_net = 5 × 0.1/0.6 ≈ +0.83 (positive)
        // With rt=1.5% → t_net = 5 × -0.9/0.6 ≈ -7.5 (negative)
        { signal_id: 's', market_type: 'aaa', direction: 'long', n: 100, gross_pct: 0.6, t_gross: 5 },
      ];
      const cheap = computeEdgeCapacity(cells, { aaa: 0.005 }, 0.05, 50);
      const expensive = computeEdgeCapacity(cells, { aaa: 0.015 }, 0.05, 50);
      assert.ok(cheap.get('aaa').sum > 0, 'cheap RT cost: positive edge');
      assert.equal(expensive.get('aaa').sum, 0, 'expensive RT cost: no edge');
    },
  },
];

let failed = 0;
for (const c of cases) {
  try {
    c.fn();
    console.log(`  ✓ ${c.name}`);
  } catch (err) {
    console.error(`  ✗ ${c.name}\n    ${err.message}`);
    failed++;
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exitCode = failed > 0 ? 1 : 0;
