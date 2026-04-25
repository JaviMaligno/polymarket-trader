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

**Single new column**: `markets.is_shadow BOOLEAN NOT NULL DEFAULT false`. Combined with existing `tracking_status` (cold/warming/active/cooling), defines a market's lane. A market is in exactly one lane at a time.

Lane assignment is **derived** from `market_type` and `ALLOWED_MARKET_TYPES`:
- `is_shadow = false` if `market_type ∈ ALLOWED_MARKET_TYPES`
- `is_shadow = true` otherwise

The flag is materialized (not computed per query) for performance, and recomputed on every market sync. When `ALLOWED_MARKET_TYPES` env changes, a startup hook does a batch UPDATE.

**Two rotation passes per cycle**: `MarketRotator.rotate(lane)` is invoked twice — once with `lane='live'`, once with `lane='shadow'`. Same engine, same hysteresis logic, separate budgets:
- Live: `MAX_TRACKED_MARKETS=40` (existing).
- Shadow: `MAX_SHADOW_MARKETS=10` (new env, default 10).

**Signal pipeline** unchanged in shape. SignalEngine processes both lanes uniformly. AutoSignalExecutor short-circuits shadow signals to `shadow_trades` directly, bypassing the rejection path.

## Components

### `markets` schema
- Add `is_shadow BOOLEAN NOT NULL DEFAULT false` via startup `ALTER TABLE IF NOT EXISTS` pattern (post-init migration, consistent with how the project applies schema changes after first volume init).
- Partial indexes for hot rotator paths:
  - `CREATE INDEX IF NOT EXISTS idx_markets_live_cold_candidates ON markets(market_score DESC) WHERE is_shadow=false AND tracking_status='cold' AND is_active=true AND is_resolved=false`
  - `CREATE INDEX IF NOT EXISTS idx_markets_shadow_cold_candidates ON markets(market_score DESC) WHERE is_shadow=true AND tracking_status='cold' AND is_active=true AND is_resolved=false`

### `GammaCollector` / sync-markets job
- On upsert, compute `is_shadow = market_type NOT IN ALLOWED_LIST` and write it.
- The `ALLOWED_LIST` is read from `ALLOWED_MARKET_TYPES` env once at process start (already the pattern in `AutoSignalExecutor`).

### Startup hook (in `packages/dashboard/src/server.ts`)
- Owned by the dashboard process because it already reads `ALLOWED_MARKET_TYPES` (via `AutoSignalExecutor`) and is responsible for other post-init ALTER TABLE migrations in the codebase.
- Runs after schema migration (column add) and before the SignalEngine starts emitting signals or the data-collector's rotator first runs:
  ```sql
  UPDATE markets
  SET is_shadow = (market_type IS NULL OR NOT (market_type = ANY($1::text[])))
  WHERE is_resolved = false;
  ```
- Blocks startup until complete. Logged with row counts (rows updated, rows that flipped lanes, rows already correct).
- Idempotent: re-running with the same allowed list is a no-op (UPDATE matches nothing because all rows already have correct `is_shadow`).

### `MarketRotator` (`packages/data-collector/src/services/MarketRotator.ts`)
- Refactor: existing `rotate()` becomes `rotate(lane: 'live' | 'shadow'): Promise<RotationResult>`. Internal queries add `AND is_shadow = $lane_bool`.
- New public method `rotateAll(): Promise<{ live: RotationResult; shadow: RotationResult }>` orchestrates both lanes sequentially (shared DB connection; parallelizing has no clear benefit and complicates lock contention).
- Single `MarketRotator` instance is constructed with two `RotationConfig`s internally — one per lane. Constructor signature changes from `constructor(config?: Partial<RotationConfig>)` to `constructor(liveConfig?: Partial<RotationConfig>, shadowConfig?: Partial<RotationConfig>)`. The lane parameter selects which config applies inside `rotate()`.
- `MIN_CANDIDATE_SCORE=0.15` shared between lanes.
- The Scheduler entry currently calling `rotator.rotate()` becomes `rotator.rotateAll()`.
- `DEFAULT_CONFIG` for shadow defaults: `maxTracked = parseInt(process.env.MAX_SHADOW_MARKETS || '10', 10)`. All other defaults inherited from the existing live config.

### `ClobCollector`
- **No code change to filter clauses.** The 5 sites filtering `tracking_status IN ('warming','active','cooling')` correctly serve both lanes — once shadow markets get promoted, they enter the snapshot/orderbook/price-update pipeline automatically.
- Verification only: confirm logs show `Price snapshots inserted` for shadow markets after they reach warming.

### `SignalEngine` (`packages/dashboard/src/services/SignalEngine.ts`)
- `ActiveMarket` type adds `isShadow: boolean`.
- `setActiveMarkets()` filter unchanged — it already includes both lanes via tracking_status.
- `SignalResult` adds `isShadow: boolean`, populated from the source `ActiveMarket`.
- `PolymarketService.updateSignalEngine()` populates `isShadow` from the markets query.

### `AutoSignalExecutor` (`packages/dashboard/src/services/AutoSignalExecutor.ts`)
- New first check in `processSignal()`:
  ```ts
  if (signal.isShadow) {
    await this.insertShadowTrade(signal);
    return { executed: false, reason: 'shadow_lane' };
  }
  ```
- The existing `market_type_not_allowed` gate stays as defense-in-depth (handles the rare case of a live signal whose market_type isn't in ALLOWED — possible if ALLOWED env was changed without a sync). Insert path stays the same.

### `shadow_trades` table and `MarketPerformanceTracker`
- No schema change. No code change. The table receives entries via the new short-circuit path instead of the rejection path; semantically identical.

## Data Flow — Crypto Market Lifecycle

1. GammaCollector inserts/updates a `crypto_intraday` market. `is_shadow=false` (it's in ALLOWED_MARKET_TYPES).
2. ClobCollector updates `current_price_yes` (no tracking_status filter on that path; already works).
3. Rotator live lane runs. Sees this market as a cold candidate. Crypto markets now compete only against other ALLOWED types (event_short, event_financial). Wins ranking → promoted to warming.
4. ClobCollector's `snapshotCurrentPricesToHistory()` matches `tracking_status='warming'` filter → inserts price_history rows.
5. After 3 bars, rotator promotes warming → active.
6. SignalEngine generates signals. AutoExecutor sees `isShadow=false` → live trade flow.

**Symmetric for an event_long market**: lands `is_shadow=true`, competes in shadow lane only, generates `shadow_trades` entries when SignalEngine emits.

## Migration Strategy (Deploy Day)

Pre-deploy state: 32 markets in active+warming, ~29 of them event_long (live pool dominated by non-allowed types).

Post-startup-hook state:
- 29 event_long markets: `is_shadow=true, tracking_status=active`. Now in shadow lane, **already over the cap** (29 vs MAX_SHADOW_MARKETS=10).
- 2 event_financial + 1 event_short: `is_shadow=false, tracking_status=active`. In live lane, far below cap (3 vs 40).

Next rotator cycle (within 5 min of deploy):
- Shadow lane: hysteresis-based demotions select worst-scoring event_long markets without open positions and demote them. `maxRotationsPerHour=5` rate limits this — convergence to 10 takes ~4 hours of natural rotation.
- Live lane: emergency-fill mode triggers (`activeCount=3 < emergencyFillThreshold=20`). Aggressive warming fill from cold candidates that are now exclusively `is_shadow=false`. Crypto and event_short candidates flow in.

Within ~6 hours: pools converge to target sizes. Trade drought ends as live markets accumulate bars and signals.

**Markets with open positions** that fall into the wrong lane after migration (e.g., an event_long with a position open from before the deploy): logged but not auto-closed. Position closes naturally via stop-loss, signal exit, or near-resolution gate. Identical to the existing cooling pattern.

## Out of Scope

Explicit non-goals for this spec:
- **Daily auto-review consuming shadow_trades.** This spec only ensures the data stream stays alive. Adding shadow_trades summary to the auto-review report is a separate follow-up.
- **Automatic promotion of market_types to ALLOWED.** The decision remains manual via env var change + redeploy.
- **Per-type scorer weights for shadow.** Optuna keeps training on live trades only; shadow lane uses the same `__global__` weights it already uses for non-event_long types.
- **Changes to `MarketScorer`.** The scoring formula is unchanged. The change is in *which subset* gets ranked.
- **Tuning `MAX_SHADOW_MARKETS`.** Default 10, env-overridable. No optimization for now.
- **Removing the `market_type_not_allowed → insertShadowTrade` defensive path.** Kept for safety against env/sync drift.

## Error Handling

- **`ALLOWED_MARKET_TYPES` env unset**: existing behavior treats this as "all types allowed" (backward-compat). Then `is_shadow` is always false; shadow lane stays empty. No drought (this is what the system did before live/shadow distinction existed).
- **`ALLOWED_MARKET_TYPES` env malformed (empty after parse, etc.)**: fail-closed. Refuse to start. No silent fallback.
- **Unknown `market_type`** (classifier emits a value not in any known list): default `is_shadow=true`. Routing to shadow is safer than to live.
- **Race at startup**: the batch UPDATE in the startup hook completes before the rotator's first scheduled tick. The rotator's first run sees a consistent `is_shadow` column.
- **Index creation failure**: `CREATE INDEX IF NOT EXISTS` is non-blocking; rotator queries work without the index but slower. Logged as warning.
- **Position open in market that became shadow**: log `WARN`, do not close. Existing position lifecycle (stop-loss, near-resolution) handles it.

## Testing

- **Unit `MarketRotator`**:
  - Existing tests pass after the `lane` parameter refactor (defaults preserved).
  - New: `rotate('live')` ignores markets with `is_shadow=true` regardless of score.
  - New: `rotate('shadow')` ignores `is_shadow=false` markets.
  - New: per-lane `maxTracked` honored independently.
- **Unit `AutoSignalExecutor`**:
  - Signal with `isShadow=true` → calls `insertShadowTrade` exactly once, does not touch `paper_positions`, returns `{ executed: false, reason: 'shadow_lane' }`.
  - Signal with `isShadow=false` and allowed market_type → existing live flow unchanged.
- **Unit `GammaCollector` upsert**:
  - Allowed market_type → row written with `is_shadow=false`.
  - Non-allowed market_type → row written with `is_shadow=true`.
  - Null/unknown market_type → `is_shadow=true`.
- **Migration test**:
  - Idempotency: running the startup hook twice produces no extra writes (UPDATE matches no rows on second run).
  - Realignment: changing ALLOWED env and re-running the hook flips `is_shadow` correctly for affected rows.

## Success Criteria (24h post-deploy)

All four must hold:
1. `SELECT COUNT(*) FROM markets WHERE is_shadow=false AND tracking_status='active' AND market_type IN ('crypto_intraday','crypto_daily','event_short','event_financial')` ≥ 5.
2. `SELECT COUNT(*) FROM price_history WHERE market_id IN (SELECT id FROM markets WHERE market_type LIKE 'crypto_%') AND time > NOW() - INTERVAL '1 hour'` > 0.
3. `SELECT COUNT(*) FROM shadow_trades WHERE time > NOW() - INTERVAL '24 hours'` > 0.
4. `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(opened_at)))/3600 FROM paper_positions` < 6 (most recent open within 6 hours).

## Rollback Triggers

If any of these occurs in the first 24h, revert:
- VM RSS sustained > 900MB.
- Zero trades opened in 24h post-deploy (drought persists despite the fix).
- `shadow_trades` insertion rate falls below pre-deploy baseline (the rejection-path-derived rate).
- Any data corruption (markets with `is_shadow=NULL`, or markets visible in both lanes simultaneously).

Rollback path: revert the merge commit on main, redeploy. The schema column stays (NOT NULL DEFAULT false → no breakage). The startup hook becomes a no-op without the rest of the code referring to `is_shadow`.

## Open Questions

None at design time. All architectural decisions confirmed during brainstorming session 2026-04-25.
