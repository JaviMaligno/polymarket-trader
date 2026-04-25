# Shadow Pool Design — Live + Shadow Lane Separation

**Date**: 2026-04-25
**Status**: Design (pending implementation plan)
**Related**: Issue #131 (96h trade drought), `project_crypto_data_gap.md`, `feedback_no_diversity_quota.md`

## Problem

The system has a closed loop that traps 14,386 crypto markets in `tracking_status='cold'`, producing 96h+ trade droughts:

1. All crypto markets are cold.
2. `ClobCollector.snapshotCurrentPricesToHistory()` (and every other ClobCollector method) filters by `tracking_status IN ('warming','active','cooling')` — cold markets never get `price_history` rows.
3. `SignalEngine` requires `EXISTS in price_history (last 24h)` to consider a market — crypto excluded.
4. `MarketRotator` candidate query is `WHERE tracking_status='cold' ORDER BY market_score DESC LIMIT 50`. event_long avg score 0.725 dominates over crypto 0.622. Top-50 are always event_long → crypto never promoted.
5. Loop closes.

The asymmetry: `ALLOWED_MARKET_TYPES` excludes event_long. So 91% of the live pool is occupied by markets the executor will reject. Markets we *would* trade (crypto, event_short, event_financial) get starved by markets we *won't* trade.

Diversity quotas were rejected by the user (see `feedback_no_diversity_quota.md`): pool selection must remain merit-based. The structural fix is to separate the pools so live operates on `ALLOWED_MARKET_TYPES` only, and a small shadow pool keeps observing non-allowed types for promotion decisions.

## Goal

Split tracking into two parallel lanes:
- **Live lane**: candidates restricted to `ALLOWED_MARKET_TYPES`. Operates trades.
- **Shadow lane**: candidates restricted to types NOT in `ALLOWED_MARKET_TYPES`. Observes via `shadow_trades` only. Used by daily auto-review to inform promotion decisions.

Crypto markets compete in the live lane against event_short/event_financial — winning naturally because event_long no longer crowds them out. Trade drought ends. Shadow lane keeps event_long signal data for empirical validation of the allowlist.

## Architecture

**No new schema column.** Lane membership is **derived dynamically** in each `MarketRotator` query from the existing `markets.market_type` and the `ALLOWED_MARKET_TYPES` env var. The env var is the single source of truth; deriving on each rotator pass eliminates duplication, removes startup-hook races between dashboard and data-collector, and makes the rotator self-correcting when the env changes (next deploy applies the new allowlist immediately, no realignment job needed).

**Two rotation passes per cycle**: `MarketRotator.rotate(lane)` is invoked twice per scheduler tick — once with `lane='live'`, once with `lane='shadow'`. Same engine, same hysteresis logic, separate budgets:
- Live: `MAX_TRACKED_MARKETS=40` (existing).
- Shadow: `MAX_SHADOW_MARKETS=10` (new env, default 10).

**Lane derivation** in candidate SQL:
- Live: `AND market_type = ANY($allowed_types::text[])`
- Shadow: `AND (market_type IS NULL OR NOT (market_type = ANY($allowed_types::text[])))`

Same idea for the active/warming/cooling fetch in `rotate()` — each lane sees only its own population.

**Signal pipeline unchanged.** SignalEngine processes everything currently in `tracking_status IN (warming, active, cooling)` — no awareness of lane. The lane manifests itself only at the executor: when `AutoSignalExecutor` sees a signal with `market_type ∉ ALLOWED_MARKET_TYPES` and no open position, it already inserts to `shadow_trades` and returns. That code path stays untouched. The novelty is that with shadow markets actually in the active pool (instead of starved by event_long), shadow_trades flow gets richer.

## Components

### `markets` schema
**No change.** No new columns, no migrations, no startup hooks.

### `MarketRotator` (`packages/data-collector/src/services/MarketRotator.ts`)

Refactor in three steps:

1. **Constructor takes two configs**: `constructor(liveConfig?: Partial<RotationConfig>, shadowConfig?: Partial<RotationConfig>)`. Default for shadow inherits from live but with `maxTracked = parseInt(process.env.MAX_SHADOW_MARKETS || '10', 10)`.

2. **`rotate()` becomes `rotate(lane: 'live' | 'shadow')`**. The two SQL queries inside (`tracked` fetch at L199 and `candidates` fetch at L262) gain a `market_type` predicate parameterized by the allowed-types array. The instance picks the right config based on `lane`.

3. **New `rotateAll(): Promise<{ live: RotationResult; shadow: RotationResult }>`**. Calls `rotate('live')` then `rotate('shadow')` sequentially using a single shared connection. Sequential because parallelizing has no clear benefit and keeps lock contention simple.

The allowed-types array is read once at module load:
```ts
const ALLOWED_MARKET_TYPES_ARR: string[] = process.env.ALLOWED_MARKET_TYPES
  ? process.env.ALLOWED_MARKET_TYPES.split(',').map(t => t.trim()).filter(Boolean)
  : [];
```

If empty/unset, the live lane gets all types (backward-compat), and the shadow lane is empty.

### `Scheduler` (`packages/data-collector/src/services/Scheduler.ts`)
At `Scheduler.ts:346`, `await this.marketRotator.rotate()` becomes `await this.marketRotator.rotateAll()`. The result is logged with both lanes' counts.

### `data-collector` env wiring
The data-collector container needs `ALLOWED_MARKET_TYPES` set (currently only the dashboard container has it). Update `docker-compose.gcp.yml` to pass the same value to both services from a shared `.env` file or duplicate the entry. This is required because the lane derivation now lives inside the rotator (data-collector process).

### `ClobCollector`
**No code change.** The five sites filtering `tracking_status IN ('warming','active','cooling')` correctly serve both lanes — once shadow markets get promoted by the new shadow rotator, they enter the snapshot/orderbook/price-update pipeline automatically. Verification only: confirm logs show `Price snapshots inserted` for shadow markets after they reach warming.

### `SignalEngine`
**No code change.** Already lane-agnostic. Processes whatever is in `tracking_status IN (warming, active, cooling)`.

### `PolymarketService.updateSignalEngine()`
**No code change.** Already passes through `marketType` (line 495 of `PolymarketService.ts`). The executor uses it to gate.

### `AutoSignalExecutor`
**No code change.** The existing market-type gate at lines 462–481 already does exactly what shadow lane needs:
- Signal with non-allowed `market_type` and no open position → `insertShadowTrade(signal)` + return.
- Signal with non-allowed `market_type` and existing open position → falls through to close logic (correct: legacy positions can still close).
- Signal with allowed `market_type` → live trade flow.

Verification only: confirm shadow_trades inserts increase post-deploy.

### `shadow_trades` table and `MarketPerformanceTracker`
No schema change. No code change. The table receives more entries because more non-allowed markets are now active and producing signals.

### Daily auto-review integration

Two files updated to consume the now-richer shadow data and turn it into actionable promotion recommendations:

**`scripts/daily-review.sh`** — replace the existing `shadow_summary` aggregation (lines 523–532) with a richer per-type breakdown over a 30-day window:
```sql
SELECT market_type,
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE resolved_at IS NOT NULL) AS resolved,
       ROUND(AVG(theoretical_pnl) FILTER (WHERE resolved_at IS NOT NULL)::numeric, 4) AS avg_pnl,
       ROUND(
         (COUNT(*) FILTER (WHERE resolved_at IS NOT NULL AND theoretical_pnl > 0)::numeric
           / NULLIF(COUNT(*) FILTER (WHERE resolved_at IS NOT NULL), 0))::numeric,
         3
       ) AS win_rate,
       ROUND(STDDEV(theoretical_pnl) FILTER (WHERE resolved_at IS NOT NULL)::numeric, 4) AS pnl_stddev,
       ROUND(
         CASE WHEN STDDEV(theoretical_pnl) FILTER (WHERE resolved_at IS NOT NULL) > 0
           THEN AVG(theoretical_pnl) FILTER (WHERE resolved_at IS NOT NULL)
                / STDDEV(theoretical_pnl) FILTER (WHERE resolved_at IS NOT NULL)
           ELSE 0 END::numeric,
         3
       ) AS sharpe
FROM shadow_trades
WHERE time >= NOW() - INTERVAL '30 days'
GROUP BY market_type
```

**`scripts/daily-review-prompt.md`** — the existing "Market Type Execution Gate" section already explains the concept but never asks Claude to *act* on it. Add a new explicit instruction block:

> ### Shadow → Live promotion recommendation
>
> Inspect `shadow_summary`. For each `market_type` that meets ALL of:
> - `resolved >= 50` (sufficient sample size)
> - `sharpe >= 0.20` (positive risk-adjusted edge)
> - `win_rate >= 0.50`
> - Not already in the live `ALLOWED_MARKET_TYPES` list (compare against the env value documented above)
>
> Recommend in the issue: "Consider adding `<market_type>` to `ALLOWED_MARKET_TYPES`. Shadow data over 30 days: N=X resolved, win_rate=Y, Sharpe=Z." Do NOT auto-create a PR for the env change — promotion is a manual decision tied to a deploy. The recommendation is informational.
>
> Conversely, if any `market_type` *currently* in `ALLOWED_MARKET_TYPES` has live data that contradicts the prior shadow signal (e.g. live Sharpe is now negative over 30 days while shadow was positive), flag it for review.

The thresholds (50 trades, Sharpe 0.20, win_rate 0.50) are intentional starting points; tune by observation, not optimization. They're documented in this spec so future review changes have a baseline.

## Data Flow — Crypto Market Lifecycle

1. GammaCollector inserts/updates a `crypto_intraday` market (no awareness of lanes; just metadata as today).
2. `MarketClassifier` (in dashboard) eventually sets `market_type='crypto_intraday'`.
3. ClobCollector updates `current_price_yes` (no tracking_status filter on that path; already works).
4. Rotator's next `rotateAll()` tick. Live lane query filters `market_type = ANY('{crypto_intraday, crypto_daily, event_short, event_financial}')`. This crypto market now competes only against allowed types. event_long no longer in the contest. Wins ranking → promoted to warming.
5. ClobCollector's `snapshotCurrentPricesToHistory()` matches `tracking_status='warming'` filter → inserts price_history rows.
6. After 3 bars, rotator promotes warming → active.
7. SignalEngine generates signals. AutoExecutor sees `market_type='crypto_intraday' ∈ ALLOWED` → live trade flow.

**Symmetric for an event_long market**: shadow lane query catches it, promotes to warming/active in the shadow budget. SignalEngine generates signals. AutoExecutor sees non-allowed market_type, no open position → `insertShadowTrade` + return.

## Migration Strategy (Deploy Day)

Pre-deploy state: 32 markets in active+warming, ~29 of them event_long. The rotator currently treats them as live candidates because there's only one lane.

Post-deploy state right after the new code starts:
- **No data migration runs.** No batch UPDATE. The `markets` table is unchanged.
- The first `rotateAll()` call sees the active pool through two new lenses:
  - Live lane: 3 markets active (event_short + event_financial). Way below `MAX_TRACKED_MARKETS=40` → emergency-fill mode triggers, aggressive warming fill from cold candidates that match `market_type = ANY(allowed)`. Crypto and event_short candidates flow in.
  - Shadow lane: 29 markets active (event_long). Way above `MAX_SHADOW_MARKETS=10` → hysteresis-based demotion of worst-scoring event_long markets without open positions, capped at `maxRotationsPerHour=5`. Convergence to 10 takes ~4–6 hours of natural rotation.

Within ~6 hours: pools converge to target sizes. Trade drought ends as live markets accumulate bars and signals.

**Markets with open positions**: stay in their current `tracking_status` regardless of lane. The lane gate is non-destructive — a market doesn't get force-demoted just because the lane reshuffled. Existing positions close naturally via stop-loss, signal exit, or near-resolution gate. Identical to the existing cooling pattern.

## Out of Scope

Explicit non-goals for this spec:
- **Automatic promotion of market_types to ALLOWED.** The auto-review surfaces a recommendation (per the integration above), but the env change + redeploy stays manual.
- **Per-type scorer weights for shadow.** Optuna keeps training on live trades only; shadow lane uses the same `__global__` weights it already uses for non-event_long types.
- **Changes to `MarketScorer`.** The scoring formula is unchanged. The change is in *which subset* gets ranked.
- **Tuning `MAX_SHADOW_MARKETS`.** Default 10, env-overridable. No optimization for now.
- **Changes to `AutoSignalExecutor`.** The existing market-type gate already handles shadow correctly.

## Error Handling

- **`ALLOWED_MARKET_TYPES` env unset on data-collector**: `ALLOWED_MARKET_TYPES_ARR` is empty. The rotator interprets this as "all types allowed in live lane" (the live query becomes `market_type = ANY('{}')` which matches nothing — **this would be wrong**). Mitigation: when the array is empty, the live lane query omits the type predicate entirely (`AND TRUE`), and the shadow lane is empty. Backward-compatible with the pre-existing single-pool behavior.
- **`ALLOWED_MARKET_TYPES` env malformed (whitespace, empty entries)**: parse with `.filter(Boolean)` and trim. If the result is empty, treat as unset (above).
- **`ALLOWED_MARKET_TYPES` mismatch between dashboard and data-collector containers**: the rotator promotes by data-collector's view; the executor gates by dashboard's view. Drift is silently tolerated but produces nonsense (a market promoted as "live" by data-collector that the executor sees as "shadow"). Mitigation: docker-compose binds both services to the same env value (single source). Document this as an operational invariant.
- **Unknown `market_type`** (classifier hasn't run yet, returns NULL, or returns a value not in any list): NULL falls into the shadow lane (correct: don't risk live trading on uncategorized markets). A non-NULL unknown type also falls into shadow (same reasoning).
- **Index regression**: existing market_score indexes don't include market_type. Rotator queries are bounded by `LIMIT 50` and run on schedule (every 5 min), so missing index is acceptable. If query plan shows a problem post-deploy, add a partial index. Not part of this spec.

## Testing

- **Unit `MarketRotator`**:
  - Existing tests pass after the `lane` parameter refactor (defaults preserved when called with no lane in legacy path, OR existing tests updated to pass `'live'` explicitly — pick one consistent style).
  - New: `rotate('live')` query, when `ALLOWED_MARKET_TYPES_ARR=['crypto_intraday','event_short']`, returns only candidates matching those types. Mocked DB query asserted on parameter value.
  - New: `rotate('shadow')` query returns only candidates whose market_type is NULL or NOT in the allowed list.
  - New: per-lane `maxTracked` honored independently — populating live to 40 doesn't restrict shadow's 10.
  - New: `rotateAll()` returns both results and runs them sequentially (verified by call ordering on mocked query).
- **Unit `AutoSignalExecutor`**:
  - **No new tests required.** The existing market-type gate tests already cover the behavior we want. The change in this spec is *that more shadow_trades inserts happen*, not *how* they happen. Re-run existing tests to confirm no regression.
- **Integration (smoke, post-deploy on VM)**:
  - SQL: `SELECT COUNT(*) FROM markets WHERE tracking_status='active' AND market_type IN (allowed_types)` ≥ 5 within 6h.
  - SQL: `SELECT COUNT(*) FROM price_history WHERE market_id IN (crypto markets) AND time > NOW() - INTERVAL '1 hour'` > 0.
  - SQL: `SELECT COUNT(*) FROM shadow_trades WHERE time > NOW() - INTERVAL '24 hours'` ≥ pre-deploy baseline.
  - Logs: rotator log line includes both `live` and `shadow` results.
  - Daily auto-review run after deploy: the issue body's `shadow_summary` JSON includes the new fields (`win_rate`, `pnl_stddev`, `sharpe`) and the prompt's promotion-recommendation logic fires (or correctly stays silent if no type meets thresholds).
- **No data migration test needed** (no schema change).

## Success Criteria (24h post-deploy)

All four must hold:
1. `SELECT COUNT(*) FROM markets WHERE tracking_status='active' AND market_type IN ('crypto_intraday','crypto_daily','event_short','event_financial')` ≥ 5.
2. `SELECT COUNT(*) FROM price_history WHERE market_id IN (SELECT id FROM markets WHERE market_type LIKE 'crypto_%') AND time > NOW() - INTERVAL '1 hour'` > 0.
3. `SELECT COUNT(*) FROM shadow_trades WHERE time > NOW() - INTERVAL '24 hours'` > 0.
4. `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(opened_at)))/3600 FROM paper_positions` < 6 (most recent open within 6 hours).

## Rollback Triggers

If any of these occurs in the first 24h, revert the merge commit:
- VM RSS sustained > 900MB.
- Zero trades opened in 24h post-deploy (drought persists despite the fix).
- `shadow_trades` insertion rate falls below pre-deploy baseline.
- Rotator failures in logs (e.g. SQL syntax error, type mismatch on the array parameter).

Rollback is trivial because there's no schema change. Reverting the merge commit returns the rotator to single-pool behavior. The active pool may be temporarily stuck in whatever distribution the new code produced; one or two cycles of the original rotator restore equilibrium.

## Open Questions

None at design time. All architectural decisions confirmed during brainstorming session 2026-04-25.
