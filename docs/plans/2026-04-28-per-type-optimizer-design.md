# Per-Type Optimizer Design

**Date**: 2026-04-28
**Status**: Design (pending implementation plan)
**Related**: `project_optuna_runtime_bypass.md`, `project_optimizer_extreme_weights.md`, `project_scorer_per_type.md` (precedent)

## Problem

The optimizer's output does not affect runtime behavior for the markets we trade. Mechanics:

1. `OptimizationScheduler` runs Optuna on a backtest, computes optimal generator weights, calls `updateStrategy()` which writes results to `signal_weights` table.
2. `SignalEngine.setupCombiner()` loads those weights into `combiner.this.weights` at startup and on sync intervals.
3. At runtime, when SignalEngine calls `combiner.combine(... market.marketType)`, the combiner's `getSignalWeight()` consults `this.typeWeights[market.marketType]` first. For all 5 known market types (crypto_intraday, crypto_daily, event_financial, event_short, event_long), `this.typeWeights` returns hardcoded values from `DEFAULT_TYPE_WEIGHTS` in code. The newly-fixed `?? 0` fallback (PR #139) for unlisted generators makes this even more strict — only the 5 listed generators per type contribute, and their weights are 100% hardcoded.

The result: every Optuna cycle does ~10 minutes of compute work that is functionally bypassed. The 2026-04-27 full run found `IS Sharpe = 0.222`, `OOS Sharpe = 0.319` (best on record this week), and its discovered parameters never reached production. Worse, the output that *is* visible at runtime — `DEFAULT_TYPE_WEIGHTS` — is a static guess from when per-type weighting was first introduced. It can't react to regime change, drought, or new market types without code edits.

The user's framing: *"no todas las metricas son utiles para todos los mercados, y hay que ser capaz de distinguir cuales usar para cada uno"* — and *"para eso está el optimizador"*. The right structural answer is to let the optimizer learn per-type weights, replacing the hardcoded prior with empirical data.

## Goal

Make `combiner.typeWeights` DB-backed and per-type optimized. Two-direction change:

- **Read path**: `WeightedAverageCombiner.typeWeights` is loaded from `signal_weights` (filtered by `market_type` column) at SignalEngine startup and every sync interval. Hardcoded `DEFAULT_TYPE_WEIGHTS` in code is no longer the source of truth.
- **Write path**: `OptimizationScheduler` runs Optuna **once per market_type** (5 runs per cycle), filters backtest data to that type, and writes optimized weights to per-type rows in `signal_weights`. Per-type `state.bestSharpe` tracks each type's monotonic peak independently.

The change preserves the structural intent of per-type weighting (different generators matter for different market types) but moves the calibration from a one-time human guess to continuous empirical optimization.

This is **not** a fix for the OOS gate's permissiveness, the IS-monotonic ratchet, or the small training window — those are tracked separately and addressed independently after this lands.

## Architecture

**Schema**: extend `signal_weights` with a `market_type VARCHAR(32) NOT NULL DEFAULT '__global__'` column. Primary key changes to `(signal_type, market_type)`. The `'__global__'` sentinel matches the precedent in `scorer_weights` (Sub-project A, PR #125).

Existing rows (e.g. `direction_multiplier`, `consensus_discount_floor`, `news_sentiment`) become `(signal_type, '__global__')` and continue to drive `combiner.this.weights` (the legacy global path) — unchanged behavior for these.

New per-type rows (5 market_types × 11 active generators = 55 rows) are inserted at deploy time with values copied from the current `DEFAULT_TYPE_WEIGHTS` hardcoded constant for the 5 listed generators per type, and `0` for the 6 unlisted (`volume_anomaly`, `spread_compression`, `cross_market_corr`, `price_divergence`, `attention_spike`, `news_sentiment`). This gives the optimizer a starting point that exactly reproduces today's runtime behavior — no functional change at deploy time.

**Read path** in `WeightedAverageCombiner`:
- Constructor still initializes `this.typeWeights = {}` (now empty by default).
- New caller in `SignalEngine.setupCombiner()` and the sync interval: `signalWeightsRepo.getAllPerType()` returns `Record<marketType, Record<signalType, number>>`, passed to `combiner.setTypeWeights(map)`.
- `getSignalWeight()` lookup chain (post the recent `?? 0` fix) is unchanged: typeWeights[type][gen] → fallback to this.weights[gen] → fallback to 0.

**Write path** in `OptimizationScheduler`:
- `runIncrementalOptimization()` and `runFullOptimization()` now iterate over the 5 market_types. Each iteration is a complete Optuna study filtered to that type's data.
- `state.bestSharpe` becomes `Record<marketType, number>` (per-type peaks) instead of a single scalar.
- `updateStrategy(best, marketType)` writes the optimized weights to per-type rows via `signalWeightsRepo.updatePerType(signalType, marketType, weight, reason)`.
- Param space includes the 11 active generators (extending the current 5: momentum, mean_reversion, ofi, mlofi, hawkes, plus volume_anomaly, spread_compression, cross_market_corr, price_divergence, attention_spike, news_sentiment).

**No change in**: SignalEngine's `combine()` call (still passes `market.marketType`), AutoSignalExecutor, ClobCollector, GammaCollector, MarketScorer, MarketRotator, paper_positions schema, paper_trades schema.

## Components

### `packages/data-collector/src/database/init/025_signal_weights_per_type.sql` (new)

Migration applied via the post-init startup hook pattern in `dashboard/server.ts` (consistent with scorer_weights migration in PR #125):

```sql
ALTER TABLE signal_weights
  ADD COLUMN IF NOT EXISTS market_type VARCHAR(32) NOT NULL DEFAULT '__global__';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'signal_weights_pkey_per_type'
  ) THEN
    ALTER TABLE signal_weights DROP CONSTRAINT signal_weights_pkey;
    ALTER TABLE signal_weights
      ADD CONSTRAINT signal_weights_pkey_per_type PRIMARY KEY (signal_type, market_type);
  END IF;
END $$;

-- Bootstrap: 55 per-type rows from current DEFAULT_TYPE_WEIGHTS hardcoded values.
-- Idempotent via ON CONFLICT DO NOTHING.
INSERT INTO signal_weights (signal_type, weight, market_type, updated_at) VALUES
  ('momentum',           -0.3, 'crypto_intraday', NOW()),
  ('mean_reversion',      0.5, 'crypto_intraday', NOW()),
  ('ofi',                 0.5, 'crypto_intraday', NOW()),
  ('mlofi',               0.5, 'crypto_intraday', NOW()),
  ('hawkes',              0.4, 'crypto_intraday', NOW()),
  ('volume_anomaly',      0.0, 'crypto_intraday', NOW()),
  ('spread_compression',  0.0, 'crypto_intraday', NOW()),
  ('cross_market_corr',   0.0, 'crypto_intraday', NOW()),
  ('price_divergence',    0.0, 'crypto_intraday', NOW()),
  ('attention_spike',     0.0, 'crypto_intraday', NOW()),
  ('news_sentiment',      0.0, 'crypto_intraday', NOW()),
  -- ... 44 more rows for crypto_daily, event_financial, event_short, event_long
ON CONFLICT (signal_type, market_type) DO NOTHING;
```

The full INSERT block (55 rows) follows the values in the bootstrap table from Section 3 of the brainstorm. Idempotent.

### `packages/dashboard/src/repositories/signalWeightsRepo.ts`

Two new methods alongside the existing `get()`, `getAll()`, `update()`:

```typescript
async getAllPerType(): Promise<Record<string, Record<string, number>>> {
  const rows = await query<{ signal_type: string; market_type: string; weight: number }>(
    `SELECT signal_type, market_type, weight
     FROM signal_weights
     WHERE market_type != '__global__'`
  );
  const map: Record<string, Record<string, number>> = {};
  for (const row of rows.rows) {
    if (!map[row.market_type]) map[row.market_type] = {};
    map[row.market_type][row.signal_type] = Number(row.weight);
  }
  return map;
}

async updatePerType(
  signalType: string,
  marketType: string,
  weight: number,
  reason?: string,
): Promise<void> {
  await query(
    `INSERT INTO signal_weights (signal_type, market_type, weight, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (signal_type, market_type)
     DO UPDATE SET weight = EXCLUDED.weight, updated_at = EXCLUDED.updated_at`,
    [signalType, marketType, weight],
  );
  // signal_weights_history insertion mirrors update() if needed; reason logged.
}
```

The existing `update(signalType, weight, reason)` is unchanged — it implicitly writes to `market_type='__global__'` per the column default.

### `packages/signals/src/combiners/WeightedAverageCombiner.ts`

Two changes:

1. **Remove** the `DEFAULT_TYPE_WEIGHTS` constant initialization in the constructor:
   ```typescript
   // Before:
   this.typeWeights = { ...DEFAULT_TYPE_WEIGHTS };
   // After:
   this.typeWeights = {};
   ```
   The `DEFAULT_TYPE_WEIGHTS` constant itself stays in the file as dead code for one release cycle (allows easy rollback). A follow-up PR removes it once production verifies the DB-backed approach.

2. **Keep** `setTypeWeights()` as it is (lines 141-143). It already exists and merges incoming maps with existing `this.typeWeights`. The change is that it now gets called from outside (SignalEngine), where before nothing called it.

`getSignalWeight()` itself is unchanged — the lookup chain is already correct after PR #139 (`?? 0` for per-type, `?? 1` for legacy).

### `packages/dashboard/src/services/SignalEngine.ts`

In `setupCombiner()` (around the existing `signalWeightsRepo.getAll()` block) and in the sync interval handler:

```typescript
// Existing global weight sync (kept for direction_multiplier, consensus_discount_floor, etc.)
const globalWeights = await signalWeightsRepo.getAll();
this.combiner.setWeights(globalWeights);

// NEW: per-type weight sync
const perTypeWeights = await signalWeightsRepo.getAllPerType();
this.combiner.setTypeWeights(perTypeWeights);
console.log(
  `[SignalEngine] Synced typeWeights from database: ${Object.keys(perTypeWeights).length} types`,
);
```

The sync interval (`syncWeightsIntervalMs = 300000`, 5 min) runs both calls. Optimizer-applied per-type weights propagate within 5 minutes of being written.

### `packages/dashboard/src/services/OptimizationScheduler.ts`

Significant changes:

- `state.bestSharpe: number` → `state.bestSharpePerType: Record<string, number>`. Keys are market_types, values are the monotonic peak per type. Initial = `{}` (empty, all types eligible to apply).
- `runIncrementalOptimization()` and `runFullOptimization()` wrap a loop over `MARKET_TYPES = ['crypto_intraday', 'crypto_daily', 'event_financial', 'event_short', 'event_long']`:
  ```typescript
  for (const marketType of MARKET_TYPES) {
    const results = await this.runOptimization(iterations, type, marketType);
    if (results.length === 0) continue;
    const best = results.reduce((a, b) => a.sharpe > b.sharpe ? a : b);
    await this.runOOSAndPersist(best, marketType);
    if (best.sharpe >= (this.state.bestSharpePerType[marketType] ?? 0)) {
      await this.updateStrategy(best, marketType);
    }
  }
  ```
- `runOptimization(iterations, type, marketType)` passes `marketType` to `BacktestService.fetchHistoricalData()` for filtering.
- `mapOptunaParamsToRequest()` extends to include weights for all 11 active generators (existing function adds the 6 missing keys to `combinerConfig`).
- `OPTUNA_PARAM_SPACE` and `REFINEMENT_PARAM_SPACE` extended with `combiner.volumeAnomalyWeight`, `combiner.spreadCompressionWeight`, `combiner.crossMarketCorrWeight`, `combiner.priceDivergenceWeight`, `combiner.attentionSpikeWeight`, `combiner.newsSentimentWeight`. Range `[0.0, 2.0]` for non-momentum (consistent with current generators); momentum stays `[-1.5, 1.5]` (allows contrarian).
- `updateStrategy(best, marketType)` writes per-type weights via `signalWeightsRepo.updatePerType(...)` for all 11 generators (previously called `signalWeightsRepo.update(...)` for the global rows).
- `direction_multiplier` enforcement to `-1.0` stays, but only on `__global__` (not per-type). Same for `consensus_discount_floor`.

### `packages/dashboard/src/services/BacktestService.ts`

Small extension to filter by market_type at fetch time:

```typescript
async fetchHistoricalData(
  startDate: Date,
  endDate: Date,
  marketType?: string,
): Promise<MarketData[]> {
  // Existing query...
  // If marketType is provided, add `AND m.market_type = $N` to the WHERE clause.
}
```

Backwards compatible: callers without `marketType` get unfiltered data as before.

### `packages/dashboard/src/server.ts`

Add the migration block (ALTER TABLE + bootstrap INSERT) to the post-init startup hook list. Pattern matches existing migrations (e.g. scorer_weights from PR #125, paper_positions exploration columns). Migration runs before SignalEngine starts.

### Files NOT modified

- `packages/dashboard/src/services/AutoSignalExecutor.ts` (consumes signals as-is).
- `packages/data-collector/src/services/MarketScorer.ts`, `MarketRotator.ts` (rotator/scorer logic untouched).
- `packages/data-collector/src/collectors/*` (data collection unchanged).
- Schema of `markets`, `paper_positions`, `paper_trades`, `shadow_trades`, `scorer_weights`, etc.

## Bootstrap Values (Initial 55 Rows)

Copied verbatim from `DEFAULT_TYPE_WEIGHTS` hardcoded for the 5 listed generators per type; 0 for the 6 unlisted. This guarantees that runtime behavior immediately post-deploy is identical to runtime behavior pre-deploy. The optimizer then refines from this baseline.

| Generator | crypto_intraday | crypto_daily | event_financial | event_short | event_long |
|---|---|---|---|---|---|
| momentum | -0.3 | -0.3 | -0.3 | -0.4 | -0.4 |
| mean_reversion | 0.5 | 0.6 | 0.6 | 0.6 | 0.6 |
| ofi | 0.5 | 0.4 | 0.4 | 0.3 | 0.2 |
| mlofi | 0.5 | 0.4 | 0.4 | 0.3 | 0.2 |
| hawkes | 0.4 | 0.3 | 0.3 | 0.2 | 0.1 |
| volume_anomaly | 0 | 0 | 0 | 0 | 0 |
| spread_compression | 0 | 0 | 0 | 0 | 0 |
| cross_market_corr | 0 | 0 | 0 | 0 | 0 |
| price_divergence | 0 | 0 | 0 | 0 | 0 |
| attention_spike | 0 | 0 | 0 | 0 | 0 |
| news_sentiment | 0 | 0 | 0 | 0 | 0 |

## Data Flow — Lifecycle Cases

**Case 1 — Dashboard cold start**:
1. dashboard starts, server.ts post-init hook runs migration (idempotent).
2. After migration, SignalEngine.setupCombiner() loads `signalWeightsRepo.getAllPerType()` → 55 rows → 5 typeWeights entries → `combiner.setTypeWeights(map)`.
3. Combiner now has `typeWeights = {crypto_intraday: {...11 keys...}, crypto_daily: {...}, event_financial: {...}, event_short: {...}, event_long: {...}}`.
4. AutoSignalExecutor and SignalEngine continue normally.

**Case 2 — Optimizer cycle for one market_type**:
1. Cron fires at 6h interval.
2. `runIncrementalOptimization()` enters the loop for, say, `event_financial`.
3. `fetchHistoricalData(start, end, 'event_financial')` returns only event_financial market data for the 10-day training window.
4. Optuna study runs N trials; best params have all 11 generator weights.
5. OOS validation runs on the held-out 4-day window for event_financial only.
6. If OOS passes and IS Sharpe ≥ `state.bestSharpePerType.event_financial`, calls `updateStrategy(best, 'event_financial')`.
7. `updateStrategy` writes 11 rows to `signal_weights` with `market_type='event_financial'`.
8. Loop continues to next type.

**Case 3 — Per-type weights propagate to runtime**:
1. After optimizer applies for event_financial: rows updated in DB.
2. Within 5 min, SignalEngine sync interval calls `signalWeightsRepo.getAllPerType()` again.
3. Updated values pushed to combiner via `setTypeWeights(newMap)`.
4. Next signal computation for an event_financial market uses the new weights.

**Case 4 — Brand-new market_type emerges (e.g. classifier introduces 'event_political')**:
1. Market classified as 'event_political'.
2. SignalEngine receives signal with marketType='event_political'.
3. combiner.combine(... 'event_political') — `this.typeWeights['event_political']` undefined.
4. `getSignalWeight` falls through to `this.weights` (legacy global) → contributes via legacy path.
5. Logs flag the unknown type. Operator manually adds bootstrap rows for it (or future automation).
6. No crash; defensive defaults.

## Migration / Deploy

At deploy:
- ALTER TABLE adds column.
- INSERT bootstrap 55 rows (idempotent).
- Existing rows get `market_type='__global__'` via the column default.
- Schema is backward-compatible: pre-deploy code reading `signal_weights` without filtering still gets all rows (would now include both global and per-type, which would confuse old code). However, the `signal_weights` table is only consumed by `SignalEngine.setupCombiner()` and `OptimizationScheduler.updateStrategy()`. Both are updated in this PR. So the schema change is safe.

Rollback:
- Revert merge → code reverts to reading `signal_weights` via `getAll()` (which would now return both types of rows, mixed).
- Mitigation: include in this PR a defensive filter in the legacy `getAll()` to only return `market_type='__global__'` rows. That way rollback to prior code still works.

Or, simpler: keep `getAll()` unchanged in this PR (returns ALL rows including per-type). Pre-deploy code (post-rollback) would see per-type rows and behave undefined. Acceptable risk because rollback after deploy is rare and per-type rows are values that just won't apply since the code wouldn't know how to use them.

Decision: keep getAll() unchanged. If an issue surfaces, defensive filter is a 1-line addition.

## Out of Scope

Explicitly deferred to follow-up brainstorms:

- **Threshold params per-type** (`combiner.minCombinedConfidence`, `combiner.minCombinedStrength`). These could vary per type but expand scope significantly. Stay global.
- **Risk params per-type** (`risk.maxPositionSizePct`, `risk.stopLossPct`, etc.). Same reasoning.
- **`direction_multiplier` per-type**. Per the comment in OptimizationScheduler, it's pinned to -1.0 globally based on validated behavior. Per-type doesn't fit.
- **`consensus_discount_floor` per-type**. Same — global policy.
- **Removing the legacy `this.weights` branch entirely**. Keep for backward compat with any market_type not in typeWeights. Cleanup in a future release once all types are confirmed populated.
- **Removing `DEFAULT_TYPE_WEIGHTS` hardcoded constant**. Keep for one release cycle as rollback safety.
- **OOS gate adjustment for sparse-data types**. Tracked separately. Some types may not pass OOS if their backtest produces <20 simulated trades — they stay at bootstrap values. Acceptable interim.
- **IS-Sharpe-monotonic ratchet fix**. Per-type bestSharpe naturally helps (each type has its own peak), but the fundamental "use OOS not IS to decide apply" question is separate.
- **Schema migration to `signal_weights_history` for per-type tracking**. Existing history table tracks global; per-type history could be added but isn't critical.

## Error Handling

- **Migration fails at startup**: dashboard halts startup. Error propagates from the post-init hook. Operator must fix DB state before container restarts cleanly. Loud failure preferred over silent degradation.
- **`signalWeightsRepo.getAllPerType()` fails (DB down)**: SignalEngine.setupCombiner logs the error and proceeds with empty `typeWeights`. Combiner falls back to `this.weights` (legacy global) → fallback to 0. Trading continues with global weights, no crash.
- **`signalWeightsRepo.updatePerType()` fails for one signal_type within a type**: log + continue. The failed row keeps prior value. Next optimizer cycle retries.
- **Optuna run for one market_type fails**: log error, continue to next type. Other types still optimize.
- **OOS validation fails for one type**: log reason (`OOS Sharpe X < threshold`), don't apply for that type, continue to next type.
- **Unknown market_type at signal time** (classifier emits new type): combiner.combine sees no entry in `typeWeights[type]` → fall through to `this.weights` → fall back to 0. Logs flag the unknown type for operator awareness.

## Testing

**Unit**:
- `signalWeightsRepo.getAllPerType()`: returns correct map shape, excludes `__global__`, groups by market_type.
- `signalWeightsRepo.updatePerType()`: UPSERT writes correct row, doesn't affect `__global__` rows.
- Migration idempotency: running migration twice produces identical state.
- `WeightedAverageCombiner`: existing tests pass (behavior, not source). One new test confirms `setTypeWeights({event_financial: {...}})` followed by `combine(... 'event_financial')` uses those weights, NOT the (now removed-from-init) `DEFAULT_TYPE_WEIGHTS`.
- `SignalEngine.setupCombiner()`: new test verifies it calls `signalWeightsRepo.getAllPerType()` and `combiner.setTypeWeights(...)` with the returned map.
- `OptimizationScheduler`: new tests verify (a) loop iterates all 5 market_types per cycle, (b) `BacktestService.fetchHistoricalData` is called with correct market_type filter, (c) `updateStrategy(best, marketType)` writes per-type rows, (d) per-type `bestSharpePerType` ratchet.
- `BacktestService.fetchHistoricalData(start, end, marketType)`: returns only markets of the specified type when filter is provided; backward compat without filter.

**Integration smoke (post-deploy on VM)**:
- SQL: `SELECT COUNT(*) FROM signal_weights WHERE market_type != '__global__'` ≥ 55.
- Logs: `[SignalEngine] Synced typeWeights from database: 5 types`.
- After one optimizer cycle (within 6h post-deploy): logs show 5 per-type runs.
- After 24h: at least 1 type's per-type rows show `updated_at > deploy_ts` (optimizer wrote new values).

**Type check**: `pnpm exec tsc --noEmit` clean for both signals and dashboard packages.

## Success Criteria (24-48h post-deploy)

All four must hold:

1. SQL: `SELECT COUNT(DISTINCT market_type) FROM signal_weights WHERE market_type != '__global__'` = 5 (all five expected types present).
2. SQL: `SELECT COUNT(*) FROM signal_weights WHERE market_type != '__global__'` ≥ 55 (full bootstrap present, possibly more if types drift).
3. Logs: SignalEngine startup shows 5-types sync; optimizer cycle shows 5 per-type runs.
4. Trade behavior on event_financial markets evolves over 48h — `signal_weights` rows for event_financial show `updated_at` movement, indicating optimizer applied per-type. (If no application, OOS gate is the blocker — addressed in follow-up.)

## Rollback Triggers

Within 24h:
- VM RSS sustained > 900MB (regression — typeWeights load shouldn't add memory).
- Crash loop in SignalEngine — likely indicates schema or repo issue.
- Trade rate drops to 0 sustained for 6h (assuming pool has trade-eligible markets) — could mean weights got mis-bootstrapped.
- `signal_weights` rows mysteriously missing.

Rollback path: revert merge commit, redeploy. Schema column stays (NOT NULL DEFAULT, no breakage). The 55 per-type rows stay in DB but become orphan data unread by post-rollback code.

## Open Questions

None at design time. All architectural decisions confirmed during brainstorming session 2026-04-28.
