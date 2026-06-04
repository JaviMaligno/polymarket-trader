#!/usr/bin/env node
// coverage-alerts.js — deterministic coverage alerts for the daily watchdog.
//
// Background: Watchdog #280 (2026-05-29) silently missed that crypto_intraday
// had 0 tracked markets despite being in ALLOWED_MARKET_TYPES. The rule
// "tracked = 0 for an ALLOWED type → supply collapse" lived ONLY in the LLM
// prompt (daily-review-prompt.md §1d), so it depended on the model noticing it
// inside a wall of metrics — and in watchdog-mode the coverage table was
// compressed away entirely. This module makes that check deterministic.
//
// Two failure modes it covers:
//   1. The type appears in coverage_by_type with tracked=0.
//   2. The type is ENTIRELY ABSENT from coverage_by_type — the gather query
//      uses `GROUP BY market_type`, which emits no row for a type that has zero
//      rows in `markets`, making the gap invisible to any row-iterating check.
'use strict';

// Mirrors the executor's ALLOWED_MARKET_TYPES (live-tradeable types). event_long
// is intentionally excluded — it is shadow-only by policy, so tracked=0 there is
// expected, not a collapse. Keep in sync with the executor config; the LLM
// prompt §1d remains the backstop if this drifts.
const DEFAULT_ALLOWED_MARKET_TYPES = ['crypto_daily', 'event_financial', 'event_short'];

/**
 * Return the ALLOWED market types whose tracked count is zero (or which are
 * absent from the coverage rows entirely).
 *
 * @param {Array<{market_type:string, tracked?:number|string}>} coverageByType
 * @param {string[]} allowedTypes
 * @returns {Array<{market_type:string, tracked:number}>}
 */
function detectSupplyCollapse(coverageByType, allowedTypes) {
  const allowed = Array.isArray(allowedTypes) && allowedTypes.length
    ? allowedTypes
    : DEFAULT_ALLOWED_MARKET_TYPES;
  const rows = Array.isArray(coverageByType) ? coverageByType : [];
  const byType = new Map(rows.map((r) => [r.market_type, r]));

  const out = [];
  for (const t of allowed) {
    const row = byType.get(t);
    const tracked = row ? Number(row.tracked) : 0;
    // Absent row → treated as tracked=0. NaN (malformed) → treat as 0 so we
    // err toward surfacing rather than hiding.
    if (!row || !Number.isFinite(tracked) || tracked === 0) {
      out.push({ market_type: t, tracked: Number.isFinite(tracked) ? tracked : 0 });
    }
  }
  return out;
}

/**
 * Distinguish a real signal-generation outage from a benign execution drought.
 *
 * The watchdog's "Signals (1h)" metric is sourced from `signal_predictions`,
 * which is written ONLY inside open/close of a position (AutoSignalExecutor.ts)
 * — i.e. AFTER every block gate and the combiner threshold. So when all cohorts
 * are blocked, or no combined signal clears `minCombinedConfidence`, that count
 * is 0 even though the generators are producing predictions normally. Watchdog
 * #286 (2026-05-30) read "Signals (1h)=0" as "signal generation blocked" and
 * escalated to CRITICAL — a false positive (generator_predictions was healthy
 * at 76983/24h; every signal was simply below threshold or blocked).
 *
 * Generation liveness lives in `generator_predictions`, surfaced per-type as
 * `with_preds_24h` in coverage_by_type. This classifier separates:
 *   - generation dead + price feed alive → CRITICAL (real SignalEngine outage)
 *   - generation alive + 0 executions/1h → INFO (execution drought; expected
 *     when everything is blocked/below-threshold; NOT a generation failure)
 *   - generation dead + price feed also dead → null (the "no prices" alert owns
 *     it; avoid double-paging on a single upstream cause)
 *   - generation alive + executions > 0 → null (normal operation)
 *
 * @param {{coverageByType?:Array<{with_preds_24h?:number|string}>, executions1h?:number|string, prices1h?:number|string}} [input]
 * @returns {{level:'critical'|'info', kind:'generation_halted'|'execution_drought', message:string}|null}
 */
function classifySignalActivity(input) {
  const { coverageByType, executions1h, prices1h } = input || {};
  const rows = Array.isArray(coverageByType) ? coverageByType : [];
  const generation24h = rows.reduce((sum, r) => {
    const n = Number(r && r.with_preds_24h);
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0);
  const execNum = Number(executions1h);
  const executions = Number.isFinite(execNum) ? execNum : 0;
  const priceNum = Number(prices1h);
  const pricesLive = Number.isFinite(priceNum) && priceNum > 0;

  if (generation24h === 0) {
    // No generation. Only a real outage if prices are still flowing; otherwise
    // the price-feed alert is the root cause — stay silent to avoid double-alarm.
    if (!pricesLive) return null;
    return {
      level: 'critical',
      kind: 'generation_halted',
      message:
        'Signal generation halted: 0 generator predictions in 24h while the price feed is live. The SignalEngine is not producing predictions — a real outage, not a trading drought.',
    };
  }
  if (executions === 0) {
    return {
      level: 'info',
      kind: 'execution_drought',
      message:
        `Execution drought: ${generation24h} generator predictions in 24h but 0 signals executed in the last hour. Signals ARE being generated; they are all below the combiner threshold or blocked by gates. Expected steady state when cohorts are blocked — NOT a generation failure. Do not escalate on "Signals (1h)=0" alone.`,
    };
  }
  return null;
}

// ── FLB forward sentinel (real-cost) ─────────────────────────────────────────
// Watchdog #305 (2026-06-04) reported the FLB forward t-stat as 1.39, computed
// from flb_shadow_signals.net_pnl — the FLAT 0.54% entry-cost column. PR #304
// added net_pnl_real (the real per-signal half-spread) precisely because the
// flat cost over-states the edge by ~half the fees plus the omitted spread. On
// real cost the same 2026-06-04 sample was pooled t≈-0.07, and the enterable
// subset (entry_cost_real ≤ 1% — what the executor would actually fill) was
// -1.75%/t=-0.50. The forward sentinel lived only in the LLM prompt, so the
// model silently picked the wrong column and framed the drop to 1.39 as
// "watching, could cross back above 2" — implying a latent edge that does not
// exist at realistic cost. This makes the verdict deterministic.
const FLB_VERDICT_MIN_N = 100;
const FLB_VERDICT_MIN_T = 2;

/** Student-t for a one-sample mean: avg / (sd / sqrt(n)). Null if not computable. */
function tStat(avg, sd, n) {
  const a = Number(avg);
  const s = Number(sd);
  const k = Number(n);
  if (!Number.isFinite(a) || !Number.isFinite(s) || !Number.isFinite(k)) return null;
  if (k < 2 || s <= 0) return null;
  return a / (s / Math.sqrt(k));
}

/**
 * Deterministic FLB forward verdict from resolved flb_shadow_signals, segmented
 * by cohort. The verdict is keyed on the TRADEABLE cohort's REAL-cost t-stat
 * (the pre-registered build gate: n ≥ 100, t ≥ 2, avg > 0). event_long is
 * shadow-only and never drives the verdict; the flat-cost column is reported for
 * continuity only and is explicitly flagged when it disagrees with real cost.
 *
 * @param {Array<{cohort:string, n_flat?:number|string, avg_flat?:number|string, sd_flat?:number|string, n_real?:number|string, avg_real?:number|string, sd_real?:number|string, n_enterable?:number|string, avg_enterable?:number|string, sd_enterable?:number|string}>} [cohortRows]
 * @returns {{cohorts:Array<object>, verdict:{status:string,message:string}, costDiscrepancy:(string|null)}}
 */
function flbForwardVerdict(cohortRows) {
  const rows = Array.isArray(cohortRows) ? cohortRows : [];
  const cohorts = rows.map((r) => ({
    cohort: r.cohort,
    n_flat: Number(r.n_flat) || 0,
    avg_flat: Number(r.avg_flat),
    t_flat: tStat(r.avg_flat, r.sd_flat, r.n_flat),
    n_real: Number(r.n_real) || 0,
    avg_real: Number(r.avg_real),
    t_real: tStat(r.avg_real, r.sd_real, r.n_real),
    n_enterable: Number(r.n_enterable) || 0,
    avg_enterable: Number(r.avg_enterable),
    t_enterable: tStat(r.avg_enterable, r.sd_enterable, r.n_enterable),
  }));

  // The flat column may not be sold as an edge: flag any cohort where flat clears
  // the gate (t ≥ 2) but real cost does not. This is exactly the #305 failure.
  let costDiscrepancy = null;
  for (const c of cohorts) {
    if (c.t_flat != null && c.t_flat >= FLB_VERDICT_MIN_T
        && (c.t_real == null || c.t_real < FLB_VERDICT_MIN_T)) {
      costDiscrepancy =
        `FLB ${c.cohort}: flat-cost t=${c.t_flat.toFixed(2)} clears the gate but `
        + `real-cost t=${c.t_real == null ? 'n/a' : c.t_real.toFixed(2)} does not. `
        + `The flat 0.54% column over-states the edge — read net_pnl_real, not net_pnl.`;
      break;
    }
  }

  const tradeable = cohorts.find((c) => c.cohort === 'tradeable');
  let verdict;
  if (!tradeable || tradeable.n_real === 0) {
    verdict = { status: 'no_data', message: 'No resolved tradeable FLB signals yet.' };
  } else if (tradeable.n_real < FLB_VERDICT_MIN_N) {
    verdict = {
      status: 'accumulating',
      message:
        `FLB tradeable forward: n=${tradeable.n_real} (< ${FLB_VERDICT_MIN_N}) — accumulating. `
        + `Real-cost t=${tradeable.t_real == null ? 'n/a' : tradeable.t_real.toFixed(2)}. `
        + `Do NOT build the executor until n ≥ ${FLB_VERDICT_MIN_N} on real cost.`,
    };
  } else if (tradeable.t_real != null && tradeable.t_real >= FLB_VERDICT_MIN_T && tradeable.avg_real > 0) {
    verdict = {
      status: 'edge_holding',
      message:
        `FLB forward edge holding at REAL cost: tradeable n=${tradeable.n_real}, `
        + `t=${tradeable.t_real.toFixed(2)}, avg=${(tradeable.avg_real * 100).toFixed(2)}% — `
        + `candidate to build the executor.`,
    };
  } else {
    verdict = {
      status: 'no_edge_at_real_cost',
      message:
        `FLB tradeable forward: n=${tradeable.n_real}, real-cost `
        + `t=${tradeable.t_real == null ? 'n/a' : tradeable.t_real.toFixed(2)}, `
        + `avg=${(tradeable.avg_real * 100).toFixed(2)}% — no edge at realistic cost. `
        + `Keep the executor gated off.`,
    };
  }

  return { cohorts, verdict, costDiscrepancy };
}

module.exports = {
  detectSupplyCollapse,
  classifySignalActivity,
  flbForwardVerdict,
  DEFAULT_ALLOWED_MARKET_TYPES,
};
