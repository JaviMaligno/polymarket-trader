# Concentration gate — Design

**Status**: Spec, awaiting user review.
**Branch**: `feat/concentration-gate`.

## Goal

Add an open-time gate to `AutoSignalExecutor` that blocks repeated same-direction re-entries on the same `market_id` when the new signal's combined conviction has not grown materially since the previous close on that market.

The rule is information-theoretic: re-entering the same direction with weaker (or equivalent) signal conviction is the same bet placed twice. It increases variance without adding evidence. The gate refuses the second bet unless the new signal is at least 1σ stronger than the signal that triggered the previous close.

## Why this matters

Backtest of the rule on the 362 closed `paper_positions` since the 2026-04-07 reset:

| k | blocked_n | blocked_pnl | wins blocked | wins_pnl |
|---|---|---|---|---|
| 0.0 | 53 | −$107.53 | 5 | +$7.50 |
| 0.5 | 113 | −$745.49 | 10 | +$64.47 |
| **1.0** | **126** | **−$774.30** | **13** | **+$70.98** |
| 1.5 | 130 | −$780.12 | 14 | +$71.26 |
| 2.0 | 134 | −$792.48 | 15 | +$74.04 |

At `k = 1.0`: 126 trades blocked, 90 % losses, 10 % wins. Net save ≈ $703 (block −$774, give back +$71 wins). That is **57 % of the entire post-reset drawdown of −$1,231**. Diminishing returns above k = 1.0 (next 8 trades save only ~$18).

The rule does NOT address single-trade tail losses (e.g., today's −$15.66 on a direction-flip), which is a separate stop-loss problem.

## Empirical grounding

- σ across `signal_predictions` per market_type, last 7 days:
  - `event_financial` (n = 68): σ = 0.353
  - `crypto_intraday` (n = 2): σ = 0.308
  - Other market_types: insufficient `signal_predictions` data (`shadow_trades` records signal_strength × signal_confidence but not via signal_predictions). Use fallback σ = 0.3 until more data accrues.

- Concrete pattern from 2026-04-29 (CPI Kerala market 1004371): 6 opens in ~20 hours, 4 same-direction re-entries with conviction equal-or-weaker than the prior close-trigger. Net loss on this market alone: −$15.36, contributing 73 % of today's losses.

## Algorithm

At each `openPosition` attempt in `AutoSignalExecutor.processSignal`, after existing entry filters (confidence, strength, MAX_POSITIONS_PER_MARKET, etc.) and immediately before the simulator call:

```text
function shouldBlockReopen(signal, marketId, marketType):
  prevClose = querySignalPredictions(
    market_id = marketId,
    metadata->>'action' = 'close',
    ORDER BY time DESC LIMIT 1
  )
  if prevClose is null: return false                 // first action on this market
  if signSign(prevClose.direction) ≠ signSign(signal.direction): return false  // direction flip = legitimate new bet
  
  newSxC      = abs(signal.strength × signal.confidence)
  prevSxC     = abs(prevClose.strength × prevClose.confidence)
  sigma       = sigmaForType(marketType)
  threshold   = prevSxC + (1.0 × sigma)
  
  if newSxC ≥ threshold: return false                // legitimately stronger conviction
  return true                                        // BLOCK: same bet, equal-or-weaker conviction
```

If `shouldBlockReopen` returns true: refuse the open with reason `"Same-direction re-entry conviction not materially stronger (s×c ${newSxC} < ${threshold} = prev ${prevSxC} + 1σ ${sigma})"`. The rejection is logged at INFO level (not warning) and counted in the existing executor stats.

The constant `k = 1.0` (in σ units) is hardcoded with a comment referencing the empirical sensitivity check. Future tuning happens via a separate spec, not an env var, to avoid silent runtime drift.

## σ computation and caching

`SignalEngine` (or a new tiny `SignalSigmaCache` service) computes σ per market_type at startup and refreshes every 6 hours (aligned with the Optuna incremental cycle) by querying:

```sql
SELECT m.market_type, STDDEV(sp.strength * sp.confidence) AS sigma
FROM signal_predictions sp
JOIN markets m ON sp.market_id = m.id
WHERE sp.time > NOW() - INTERVAL '14 days'
GROUP BY m.market_type;
```

Result cached in memory as `Record<string, number>`. `sigmaForType(marketType)` reads the cache; falls back to 0.3 if marketType absent.

The cache is stale-tolerant: if the refresh task fails, we keep the prior values. If the cache is empty (cold start before first refresh completes), every type uses fallback 0.3 — equivalent to applying the rule with conservative threshold until real σ becomes available.

## State storage

No new table. No schema migration. The "last close-trigger signal" is read live from `signal_predictions` via the existing index `idx_signal_predictions_market` (on `(market_id, time DESC)`). Add an index hint check during implementation; if the JSON filter `metadata->>'action' = 'close'` is too slow, add a partial index `WHERE metadata->>'action' = 'close'` as a follow-up.

This keeps the gate logic localised: one extra `SELECT ... LIMIT 1` per `openPosition` attempt (negligible cost) plus an in-memory cache lookup for σ.

## Where it goes

`packages/dashboard/src/services/AutoSignalExecutor.ts`, inside `processSignal`, after the existing per-market concentration limit (around line 612) and before the simulator/openPosition path. Mirror the rejection-stats pattern of the surrounding code.

The σ cache: new file `packages/dashboard/src/services/SignalSigmaCache.ts`, with a singleton accessor exported as `getSignalSigmaCache()`. Initialised at server bootstrap (`server.ts`) and refreshed via existing setInterval pattern.

## Tests

`packages/dashboard/src/services/AutoSignalExecutor.test.ts` (extend) and `packages/dashboard/src/services/SignalSigmaCache.test.ts` (new):

1. **First action on market** (no prior close): rule allows, no block.
2. **Direction flip**: prior close was SHORT, new signal is LONG. Rule allows.
3. **Same direction, weaker conviction**: prior close s×c = −0.456, new signal s×c = −0.241, σ = 0.353. `0.241 < 0.456 + 0.353 = 0.809`. BLOCK.
4. **Same direction, equal conviction**: prior s×c = −0.434, new s×c = −0.434. BLOCK (not stronger by 1σ).
5. **Same direction, strictly stronger by 1σ**: prior s×c = −0.434, new s×c = −0.800, σ = 0.353. `0.800 ≥ 0.434 + 0.353 = 0.787`. ALLOW.
6. **Same direction, stronger but not by 1σ**: prior s×c = −0.434, new s×c = −0.700, σ = 0.353. `0.700 < 0.787`. BLOCK.
7. **Unknown market_type**: σ falls back to 0.3.
8. **σ cache empty (cold start)**: σ = 0.3 fallback.
9. **σ cache populated**: σ for known type returned from cache.
10. **σ refresh on schedule**: cache after refresh has expected values from mocked DB query.
11. **DB query for prevClose returns null**: rule allows.
12. **Rejection reason string contains numeric values for debugging**.

## Acceptance criteria

(a) **Per-test**: every case above passes; `pnpm tsc --noEmit -p packages/dashboard` clean.

(b) **Post-deploy behavioural check** (7 days after merge):
- Count rejections logged with reason matching `"Same-direction re-entry conviction not materially stronger"` over the 7-day window. Expected ~30–50 (extrapolating from backtest's 126 over 21 days, roughly 6 / day).
- Compute counterfactual saved PnL by tagging blocked-signals' market_ids and looking at the next allowed open's PnL on that market — proxies the loss the system would have taken.
- Acceptance: actual blocked count and saved PnL within 50 %–150 % of the projected ~$258 / week (extrapolated from $774 / 21 days). If actual saved PnL is < 50 % of projection, the rule may be too lax in production; if > 150 %, it's catching more than expected (probably fine, but worth investigating for false positives).

(c) **No regression**: `paper_account.realized_pnl` does NOT degrade vs prior 7-day baseline. Existing trades that should fire continue to fire (positive control).

## Out of scope

- Tail single-trade losses (e.g., −$15.66 on direction-flip): separate stop-loss design.
- σ refinement using `shadow_trades.signal_strength × signal_confidence` to fill missing market_types: deferred until empirical evidence shows the 0.3 fallback is biting.
- Per-position-size adjustments based on signal strength delta: separate work.
- Replacing this rule with Kelly sizing or risk-parity: aspirational, not in scope.
- Direction-flip cooldown: data shows direction-flip openings are not the dominant loss driver.

## Files touched

| Path | Change | Purpose |
|---|---|---|
| `packages/dashboard/src/services/AutoSignalExecutor.ts` | Modify (`processSignal`, around line 612) | Insert gate; reject with reason. |
| `packages/dashboard/src/services/AutoSignalExecutor.test.ts` | Modify | Tests 1–6, 11–12. |
| `packages/dashboard/src/services/SignalSigmaCache.ts` | Create | σ cache singleton + refresh logic. |
| `packages/dashboard/src/services/SignalSigmaCache.test.ts` | Create | Tests 7–10. |
| `packages/dashboard/src/server.ts` | Modify | Initialise cache + refresh setInterval at bootstrap. |
| `packages/dashboard/src/index.ts` (or equivalent re-exports) | Modify if needed | Re-export cache accessor. |

No DB migrations, no env vars, no docker-compose changes.

## Risks

- **σ instability across regimes**: σ computed from rolling 14-day window. If signal characteristics shift (e.g., after Optuna cycles change weights), σ moves. The 6-hour refresh handles this. Risk that σ briefly mis-calibrates immediately after major weight changes; the fallback 0.3 absorbs the worst case.
- **JSON filter performance**: `metadata->>'action' = 'close'` on a non-trivially-sized `signal_predictions` table. Mitigation: existing `(market_id, time DESC)` index narrows the scan; LIMIT 1 short-circuits. Add partial index if production telemetry shows the query is > 10 ms.
- **Blocking legitimate wins (false positives)**: backtest shows 13 / 126 (10 %) blocked trades were wins, costing +$71 of foregone profit. Acceptable trade-off given the −$845 of losses prevented.
- **Rule application gap**: 88 / 362 historical trades had `no_signal_data` (signal_predictions row not matched within ±2 min of opened_at). For those, rule cannot apply. Going forward, AutoSignalExecutor reliably writes signal_predictions on each open and close, so the gap should not persist for new trades.
- **Tail losses pass through**: single-bet tail losses on direction-flip remain. Roll into a separate stop-loss / tail-cap design.

## How this aligns with the broader trading-improvement priority

This is option #1 from the four-item improvement list raised during the shadow-execution-realism re-prioritisation. Estimated daily save ≈ $37 if the historical pattern holds. Other high-leverage levers (SHORT asymmetry follow-up, stop-loss tightening, same-market churn filter) remain queued behind this.
