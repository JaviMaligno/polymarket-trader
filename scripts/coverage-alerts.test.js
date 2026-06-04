#!/usr/bin/env node
/**
 * Unit tests for detectSupplyCollapse — the deterministic "an ALLOWED market
 * type has zero tracked markets" alert. Added 2026-05-29 after Watchdog #280
 * silently missed crypto_intraday=0 (the supply-collapse rule lived only in the
 * LLM prompt §1d, not in format-review.js's deterministic alert layer).
 */
const assert = require('node:assert/strict');
const {
  detectSupplyCollapse,
  classifySignalActivity,
  flbForwardVerdict,
  DEFAULT_ALLOWED_MARKET_TYPES,
} = require('./coverage-alerts.js');

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

  // ── classifySignalActivity — generation outage vs execution drought ───────
  // Watchdog #286 (2026-05-30) read "Signals (1h)=0" (sourced from
  // signal_predictions, which is written only AFTER block gates, on actual
  // open/close) as "signal generation blocked → CRITICAL". It was a false
  // positive: generator_predictions was healthy (76983/24h); every signal was
  // simply below the combiner threshold or blocked. This classifier makes the
  // distinction deterministic so the watchdog cannot conflate the two again.
  {
    name: 'generation alive + 0 executions/1h → INFO execution_drought (the #286 case)',
    fn: () => {
      const got = classifySignalActivity({
        coverageByType: [
          { market_type: 'crypto_daily', with_preds_24h: 5 },
          { market_type: 'event_short', with_preds_24h: 29 },
        ],
        executions1h: 0,
        prices1h: 888,
      });
      assert.ok(got);
      assert.equal(got.level, 'info');
      assert.equal(got.kind, 'execution_drought');
    },
  },
  {
    name: 'generation dead + price feed alive → CRITICAL generation_halted',
    fn: () => {
      const got = classifySignalActivity({
        coverageByType: [
          { market_type: 'crypto_daily', with_preds_24h: 0 },
          { market_type: 'event_short', with_preds_24h: 0 },
        ],
        executions1h: 0,
        prices1h: 814,
      });
      assert.ok(got);
      assert.equal(got.level, 'critical');
      assert.equal(got.kind, 'generation_halted');
    },
  },
  {
    name: 'generation dead + price feed also dead → null (price alert owns it, no double-alarm)',
    fn: () => {
      const got = classifySignalActivity({
        coverageByType: [{ market_type: 'crypto_daily', with_preds_24h: 0 }],
        executions1h: 0,
        prices1h: 0,
      });
      assert.equal(got, null);
    },
  },
  {
    name: 'generation alive + executions > 0 → null (normal operation)',
    fn: () => {
      const got = classifySignalActivity({
        coverageByType: [{ market_type: 'crypto_daily', with_preds_24h: 5 }],
        executions1h: 3,
        prices1h: 888,
      });
      assert.equal(got, null);
    },
  },
  {
    name: 'string-typed json numerics handled',
    fn: () => {
      const got = classifySignalActivity({
        coverageByType: [{ market_type: 'event_short', with_preds_24h: '29' }],
        executions1h: '0',
        prices1h: '888',
      });
      assert.ok(got);
      assert.equal(got.kind, 'execution_drought');
    },
  },
  {
    name: 'undefined/empty input does not throw',
    fn: () => {
      assert.equal(classifySignalActivity(), null);
      assert.equal(classifySignalActivity({}), null);
    },
  },

  // ── flbForwardVerdict — real-cost FLB forward sentinel ────────────────────
  // Watchdog #305 (2026-06-04) reported the FLB forward t-stat as 1.39 using
  // flb_shadow_signals.net_pnl — the FLAT 0.54% cost column. PR #304 added
  // net_pnl_real (real per-signal half-spread); on real cost the same pooled
  // sample is t≈-0.07 and the enterable subset (cost≤1%) is -1.75%/t=-0.50.
  // The LLM-driven sentinel picked the wrong column, so the "watching, could
  // cross back >2" framing was misleading. This function makes the verdict
  // deterministic: it is keyed on the TRADEABLE cohort's REAL-cost t-stat and
  // surfaces the flat-vs-real discrepancy so the flat number can never be sold
  // as an edge again.
  {
    name: 't computed correctly from avg/sd/n',
    fn: () => {
      // avg=0.02, sd=0.1719, n=151 → t = 0.02/(0.1719/sqrt(151)) ≈ 1.4298
      const { cohorts } = flbForwardVerdict([
        { cohort: 'tradeable', n_real: 151, avg_real: 0.02, sd_real: 0.1719 },
      ]);
      const t = cohorts[0].t_real;
      assert.ok(Math.abs(t - 1.4298) < 0.01, `t_real=${t}`);
    },
  },
  {
    name: 'tradeable real-cost n>=100 & t>=2 & avg>0 → edge_holding',
    fn: () => {
      const { verdict } = flbForwardVerdict([
        { cohort: 'tradeable', n_real: 120, avg_real: 0.03, sd_real: 0.12 },
        { cohort: 'event_long', n_real: 400, avg_real: 0.05, sd_real: 0.10 },
      ]);
      assert.equal(verdict.status, 'edge_holding');
    },
  },
  {
    name: 'tradeable real-cost n<100 → accumulating (n=5 case, the real 2026-06-04 state)',
    fn: () => {
      const { verdict } = flbForwardVerdict([
        { cohort: 'tradeable', n_real: 5, avg_real: 0.018, sd_real: 0.08 },
        { cohort: 'event_long', n_real: 146, avg_real: -0.0016, sd_real: 0.14 },
      ]);
      assert.equal(verdict.status, 'accumulating');
    },
  },
  {
    name: 'tradeable real-cost n>=100 but t<2 → no_edge_at_real_cost',
    fn: () => {
      const { verdict } = flbForwardVerdict([
        { cohort: 'tradeable', n_real: 150, avg_real: -0.001, sd_real: 0.17 },
      ]);
      assert.equal(verdict.status, 'no_edge_at_real_cost');
    },
  },
  {
    name: 'flat t>=2 but real t<2 → costDiscrepancy flagged (the #305 blind-spot guard)',
    fn: () => {
      // The future-risk case: the flat 0.54%-cost column crosses the build gate
      // while real cost does not. avg_flat=0.03/sd=0.12/n=151 → t≈3.07 ≥ 2.
      const { costDiscrepancy } = flbForwardVerdict([
        { cohort: 'tradeable', n_flat: 151, avg_flat: 0.03, sd_flat: 0.12,
          n_real: 151, avg_real: -0.001, sd_real: 0.17 },
      ]);
      assert.ok(costDiscrepancy, 'expected costDiscrepancy to be truthy');
    },
  },
  {
    name: 'the actual 2026-06-04 pooled state (flat t=1.39, real t≈-0.07) → no false costDiscrepancy',
    fn: () => {
      // Both below the gate today, so no build decision is at stake — the guard
      // must stay quiet. (The misleading framing is handled by the verdict text.)
      const { costDiscrepancy } = flbForwardVerdict([
        { cohort: 'tradeable', n_flat: 151, avg_flat: 0.0195, sd_flat: 0.171,
          n_real: 151, avg_real: -0.001, sd_real: 0.17 },
      ]);
      assert.ok(!costDiscrepancy);
    },
  },
  {
    name: 'flat and real agree (both <2) → no costDiscrepancy',
    fn: () => {
      const { costDiscrepancy } = flbForwardVerdict([
        { cohort: 'tradeable', n_flat: 151, avg_flat: 0.005, sd_flat: 0.17,
          n_real: 151, avg_real: 0.004, sd_real: 0.17 },
      ]);
      assert.ok(!costDiscrepancy);
    },
  },
  {
    name: 'enterable subset t computed and surfaced',
    fn: () => {
      const { cohorts } = flbForwardVerdict([
        { cohort: 'tradeable', n_enterable: 51, avg_enterable: -0.01745, sd_enterable: 0.245 },
      ]);
      assert.ok(cohorts[0].t_enterable < 0, `t_enterable=${cohorts[0].t_enterable}`);
    },
  },
  {
    name: 'string-typed json numerics handled',
    fn: () => {
      const { cohorts, verdict } = flbForwardVerdict([
        { cohort: 'tradeable', n_real: '120', avg_real: '0.03', sd_real: '0.12' },
      ]);
      assert.ok(Number.isFinite(cohorts[0].t_real));
      assert.equal(verdict.status, 'edge_holding');
    },
  },
  {
    name: 'missing tradeable cohort → verdict null-safe (no_data)',
    fn: () => {
      const { verdict } = flbForwardVerdict([
        { cohort: 'event_long', n_real: 146, avg_real: -0.0016, sd_real: 0.14 },
      ]);
      assert.equal(verdict.status, 'no_data');
    },
  },
  {
    name: 'undefined/empty input does not throw',
    fn: () => {
      const a = flbForwardVerdict();
      assert.equal(a.verdict.status, 'no_data');
      assert.deepEqual(a.cohorts, []);
      assert.ok(!a.costDiscrepancy);
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
