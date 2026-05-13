#!/usr/bin/env node
/**
 * Unit tests for the cost-aware seed scaling formulas (PR-D).
 *
 * Pure-Node test runner — runs outside the vitest pipeline since this is a
 * script-level utility. Exit 0 = pass, 1 = fail.
 *
 * Usage: node scripts/seed-per-direction-weights.test.js
 */
const assert = require('node:assert/strict');
const { computeTNet, scaleFromTNet } = require('./seed-per-direction-weights.js');

const cases = [
  // computeTNet
  { name: 'computeTNet: gross_pct=0 → 0', fn: () =>
    assert.equal(computeTNet({ t_gross: 0, gross_pct: 0, rt_cost_pct: 1 }), 0) },

  { name: 'computeTNet: positive gross, cost < gross → smaller positive t_net', fn: () => {
    // mean_reversion crypto_intraday SHORT 2026-05-13: 10.14 × (1.369-1.08)/1.369 ≈ 2.14
    const t = computeTNet({ t_gross: 10.14, gross_pct: 1.369, rt_cost_pct: 1.08 });
    assert.ok(Math.abs(t - 2.14) < 0.05, `got ${t}, expected ~2.14`);
  } },

  { name: 'computeTNet: positive gross, cost > gross → flips negative', fn: () => {
    // mean_reversion event_financial LONG: 16.94 × (0.552-1.08)/0.552 ≈ -16.2
    const t = computeTNet({ t_gross: 16.94, gross_pct: 0.552, rt_cost_pct: 1.08 });
    assert.ok(Math.abs(t - -16.2) < 0.1, `got ${t}, expected ~-16.2`);
  } },

  { name: 'computeTNet: negative gross stays/grows negative', fn: () => {
    // mlofi event_financial SHORT: -24.41 × (-0.648-1.08)/-0.648 ≈ -65.1
    const t = computeTNet({ t_gross: -24.41, gross_pct: -0.648, rt_cost_pct: 1.08 });
    assert.ok(Math.abs(t - -65.1) < 0.5, `got ${t}, expected ~-65.1`);
  } },

  // scaleFromTNet
  { name: 'scaleFromTNet: t=0 → 1.0', fn: () =>
    assert.ok(Math.abs(scaleFromTNet(0) - 1.0) < 1e-9) },
  { name: 'scaleFromTNet: t=+20 → 2.0 (cap)', fn: () =>
    assert.ok(Math.abs(scaleFromTNet(20) - 2.0) < 1e-9) },
  { name: 'scaleFromTNet: t=+100 → still 2.0 (cap)', fn: () =>
    assert.equal(scaleFromTNet(100), 2.0) },
  { name: 'scaleFromTNet: t=-30 → 0.05 (floor)', fn: () =>
    assert.equal(scaleFromTNet(-30), 0.05) },
  { name: 'scaleFromTNet: t=+10 → 1.5', fn: () =>
    assert.ok(Math.abs(scaleFromTNet(10) - 1.5) < 1e-9) },
  { name: 'scaleFromTNet: t=-10 → 0.5', fn: () =>
    assert.ok(Math.abs(scaleFromTNet(-10) - 0.5) < 1e-9) },

  // End-to-end
  { name: 'end-to-end: mean_reversion crypto_intraday SHORT (the surviving edge cell)', fn: () => {
    const t_net = computeTNet({ t_gross: 10.14, gross_pct: 1.369, rt_cost_pct: 1.08 });
    const w = 1.6649 * scaleFromTNet(t_net);  // base × scale
    // t_net≈2.14 → scale=1+0.107=1.107 → w ≈ 1.6649×1.107 ≈ 1.843
    assert.ok(Math.abs(w - 1.843) < 0.01, `got ${w}, expected ~1.843`);
  } },

  { name: 'end-to-end: mean_reversion event_financial LONG (no longer positive net)', fn: () => {
    const t_net = computeTNet({ t_gross: 16.94, gross_pct: 0.552, rt_cost_pct: 1.08 });
    const w = 1.325 * scaleFromTNet(t_net);
    // t_net≈-16.2 → scale=1-0.81=0.19 → w ≈ 0.252
    assert.ok(Math.abs(w - 0.252) < 0.01, `got ${w}, expected ~0.252`);
  } },

  { name: 'end-to-end: mlofi event_financial SHORT (catastrophic anti-edge → floor)', fn: () => {
    const t_net = computeTNet({ t_gross: -24.41, gross_pct: -0.648, rt_cost_pct: 1.08 });
    const w = 1.98 * scaleFromTNet(t_net);
    // t_net≈-65 → clipped to 0.05 → w=0.099
    assert.ok(Math.abs(w - 0.099) < 0.001, `got ${w}, expected ~0.099`);
  } },
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
