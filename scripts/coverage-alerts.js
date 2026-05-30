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

module.exports = { detectSupplyCollapse, classifySignalActivity, DEFAULT_ALLOWED_MARKET_TYPES };
