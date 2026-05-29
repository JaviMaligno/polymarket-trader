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
const DEFAULT_ALLOWED_MARKET_TYPES = ['crypto_intraday', 'crypto_daily', 'event_financial', 'event_short'];

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

module.exports = { detectSupplyCollapse, DEFAULT_ALLOWED_MARKET_TYPES };
