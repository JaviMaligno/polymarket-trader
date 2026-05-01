# directionMultiplier per-(market_type) — Design Spec

**Date:** 2026-04-30
**Branch:** `feat/direction-multiplier-per-type`
**Status:** approved, ready for plan

---

## 1. Problem

Live trading on `event_financial` has WR=17.4% over the last 7 days (8 wins / 46 trades), driving PnL to −$94.83 in that type alone. The losing pattern is sharp:

| dm applied | side | n | wins | WR | avg YES entry | PnL |
|---|---|---|---|---|---|---|
| −1.0 | long | 19 | 6 | 31.6% | 0.438 | −$41.97 |
| −1.0 | short | 27 | 2 | **7.4%** | 0.611 | −$52.86 |

If the same trades had been entered with `dm=+1`, estimated WR would be ~81%. The combiner weights for event_financial are mean-reversion-heavy (`mean_reversion=1.57`, `ofi=1.70`, `spread_compression=1.67`), so the raw signal direction is correctly identifying mean-reverting moves. The global flip `dm=−1` then inverts that into a contrarian-of-the-contrarian, which is the wrong sign for event_financial's regime.

`directionMultiplier` is currently global, pinned to −1.0 (`PR #104`), and explicitly excluded from optimizer parameter spaces with regression tests. The pin was a response to optimizer drift on continuous domain `[-1.5, 1.5]` (e.g. `dm=+1.02` on Apr 14 → WR collapsed 91.5%→13.2%; `dm=-0.6335` on Apr 18 → issue #109). A `DirectionMultiplierLearningService` was added on Apr 19 as a conservative replacement — it segments by (market_type × priceBucket × durationBand) but requires `minSegmentTrades=24` per segment. With 1143 trades over 30d divided into ~75 segments, no segment passes the gate, so the policy reverts to global `−1` indefinitely.

**Root cause of historical drift:** continuous domain over a small backtest window. The Sharpe difference between `dm=−1.0` and `dm=−0.63` over 6 markets and 10 days is statistical noise, so the optimizer drifts. Drift is not inherent to optimizer-managed dm — it is inherent to **continuous-domain** optimizer-managed dm.

## 2. Solution

Move `directionMultiplier` into the per-type optimizer infrastructure (`signal_weights` table, per-type Optuna study, OOS-gated apply) **as a categorical parameter with choices `[-1.0, +1.0]`**. Categorical-only domain makes drift impossible by construction: Optuna can only flip the sign, never settle on intermediate values. Per-type lets each `market_type` converge to its empirical optimum.

The `DirectionMultiplierLearningService` becomes redundant once dm lives in the per-type optimizer pipeline. PR-1 leaves it running but its outputs are dominated by the new per-type layer (segments still take precedence over per-type if any are ever promoted, which is currently never). Subsequent PRs deprecate and remove it.

## 3. Architecture

```
Optuna PER_TYPE study (categorical {-1, +1})
    ↓ best params per (market_type)
OptimizationScheduler.runIncrementalOptimization (per-type loop)
    ↓ post-OOS write
signal_weights row: (signal_type='direction_multiplier', market_type=X) → ±1
    ↓ on next signal cycle
policyProvider() composes DirectionMultiplierPolicy = {
  global: from trading_config (legacy),
  perMarketType: from signal_weights (new),
  segments: from trading_config (legacy, currently empty),
}
    ↓
DirectionResolver.resolve(ctx) → resolveDirectionMultiplier(policy, ctx):
  1. segment match? use it (currently never)
  2. else perMarketType[ctx.marketType] match? use it (NEW path)
  3. else policy.global (or ε-greedy exploration on miss)
    ↓
SignalEngine.combine() applies the resolved multiplier
```

Zero new tables, services, or schedulers. The change is concentrated in two pure functions (`resolveDirectionMultiplier`, `policyProvider`) plus the optimizer feedback loop wiring.

## 4. Data layer

### 4.1 Schema

`signal_weights` is reused without alteration. Existing PK `(signal_type VARCHAR, market_type VARCHAR)` accepts new rows where `signal_type='direction_multiplier'`. The `weight FLOAT` column is interpreted polymorphically:
- For numeric signals (`momentum`, `ofi`, …): the linear combiner coefficient.
- For `direction_multiplier`: the multiplier applied to combined signal direction (must be ±1).

A short comment block in `signal_weights` schema documentation (or a `docs/database/signal_weights.md` if absent) clarifies the polymorphism.

### 4.2 Bootstrap migration

New file: `packages/data-collector/src/database/init/028_direction_multiplier_per_type_seed.sql` (next available number; existing migrations end at `027_*`).

```sql
INSERT INTO signal_weights (signal_type, market_type, weight, updated_at)
VALUES
  ('direction_multiplier', 'crypto_intraday', -1.0, NOW()),
  ('direction_multiplier', 'crypto_daily',    -1.0, NOW()),
  ('direction_multiplier', 'event_short',     -1.0, NOW()),
  ('direction_multiplier', 'event_long',      -1.0, NOW()),
  ('direction_multiplier', 'event_financial', 1.0,  NOW())
ON CONFLICT (signal_type, market_type) DO NOTHING;
```

| market_type | bootstrap dm | rationale |
|---|---|---|
| `crypto_intraday` | −1 | historical WR 91.5% with global dm=−1 |
| `crypto_daily` | −1 | same |
| `event_short` | −1 | shadow Sharpe 2.026 with dm=−1 → already validated |
| `event_long` | −1 | no clean evidence either way; status-quo safe |
| `event_financial` | **+1** | live 7d evidence: dm=−1 produces WR=17%; estimated WR=81% with +1 |

Migration uses `ON CONFLICT DO NOTHING` so re-runs are idempotent. If a row already exists (e.g. from a previous test run), the migration leaves it alone — operator's prior state wins.

### 4.3 Reaching existing deployments

`init/*.sql` files run only on first TimescaleDB volume initialisation (project memory note). The current production VM has been running for months, so adding a new init SQL alone will not seed the rows. Two acceptable paths, decided at plan time:

- **Path A (preferred):** add the migration file AND apply the same `INSERT … ON CONFLICT DO NOTHING` block at runtime startup of `dashboard-api` (alongside the existing per-type bootstrap added in PR #143). This is the pattern already used for `signal_weights` per-type rows in migration `025_signal_weights_per_type.sql`.
- **Path B (one-shot):** apply the SQL manually post-deploy via `docker exec polymarket-timescaledb psql … -f`.

The plan picks Path A unless the existing startup bootstrap turns out to be one-time-only; in that case it falls back to B with the SQL committed to a `scripts/migrate-direction-multiplier-per-type.sql` file for traceability.

## 5. Runtime changes

The change is concentrated in the policy layer. The runtime flow today is:

```
SignalEngine.computeMarketSignals(market):
  1. policy = await directionResolver.deps.policyProvider()          // reads trading_config
  2. resolution = directionResolver.resolve(ctx)                      // segment match → policy.global → exploration
  3. combiner.setDirectionMultiplier(resolution.multiplier, resolution.contextKey)
  4. combiner.combine(signals, marketType, resolution.contextKey)
```

We extend the `policy` object with a new `perMarketType` field, slot a new step into `resolveDirectionMultiplier()` between segment match and global fallback, and compose the policy from both `trading_config` (legacy) and `signal_weights` (new). No changes to `SignalEngine`, no changes to `WeightedAverageCombiner`, no changes to `DirectionResolver.resolve()` itself.

### 5.1 Extend `DirectionMultiplierPolicy` interface

In `packages/dashboard/src/services/DirectionMultiplierPolicy.ts`:

```typescript
export interface DirectionMultiplierPolicy {
  global: number;
  perMarketType?: Record<string, number>;   // NEW — keys are market_type strings
  segments: DirectionMultiplierSegment[];
  minMultiplier: number;
  maxMultiplier: number;
  // ...existing fields
}
```

The `sanitizeDirectionMultiplierPolicy()` helper in the same file is extended to clamp `perMarketType` values to `[minMultiplier, maxMultiplier]` and drop NaN/Infinity entries.

### 5.2 Extend `resolveDirectionMultiplier()`

Same file, in the function that today returns `policy.global` after segment miss:

```typescript
if (!bestMatch) {
  const perType = policy.perMarketType?.[context.marketType];
  if (perType !== undefined && Number.isFinite(perType)) {
    return {
      multiplier: perType,
      contextKey: buildDirectionContextKey(context),
      segmentId: null,
    };
  }
  return {
    multiplier: policy.global,
    contextKey: buildDirectionContextKey(context),
    segmentId: null,
  };
}
```

Three priorities: segment > perMarketType > global. Exploration ε-greedy continues to wrap this function from `DirectionResolver.resolve()` exactly as today — it activates only on a "true global" miss (no segment, no per-type), preserving the safety net for markets without a classified type.

### 5.3 Compose policy in `policyProvider`

The `policyProvider` (deps of `DirectionResolver`, set up in `SignalEngine` initialisation or `server.ts`) currently calls `tradingConfigRepo.getDirectionMultiplierPolicy()` and returns whatever JSON it stores. Wrap it:

```typescript
async function loadComposedPolicy(): Promise<DirectionMultiplierPolicy> {
  const base = await tradingConfigRepo.getDirectionMultiplierPolicy();
  const perTypeRows = await signalWeightsRepo.getAllPerType('direction_multiplier');
  const perMarketType: Record<string, number> = {};
  for (const row of perTypeRows) perMarketType[row.market_type] = row.weight;
  return sanitizeDirectionMultiplierPolicy({ ...base, perMarketType });
}
```

`signalWeightsRepo.getAllPerType(signalType)` already exists from PR #143. `tradingConfigRepo.getDirectionMultiplierPolicy()` already exists (used by `LearningService`). The change is one new function and one wiring point.

If `signal_weights` has no `direction_multiplier` rows for a type, `perMarketType[type]` is undefined → resolver falls through to `policy.global` (today: −1). Backward compatible.

### 5.4 Optimizer write path — `OptimizationScheduler` per-type loop

In `runPerTypeIncremental(marketType)`:

- After Optuna best params returned and OOS gate passes, the existing `WEIGHT_PARAM_MAP` writes `combiner.<x>Weight` rows. **Extend the map with `'combiner.directionMultiplier' → 'direction_multiplier'`**.
- Same OOS-gated path: if OOS fails, the row is **not** updated. Existing dm value persists.

**Existing FULL-strategy test stays valid.** `OptimizationScheduler.test.ts:70` ("always enforces direction_multiplier to -1.0 after a successful optimization") asserts that `updateStrategy` (the FULL pathway) pins dm to −1.0 regardless of optimizer output. The FULL pathway has no per-type concept, so its global pin is the right safeguard there. Our per-type write path is separate — new tests cover it; the existing test is untouched.

### 5.5 Optimizer feedback loop — `mapOptunaParamsToRequest` + `BacktestService`

Without these two pieces, the per-type trial backtest cannot vary dm and the optimizer cannot learn. Both must ship in PR-1 or the design is non-functional.

**(a) `mapOptunaParamsToRequest`** in `OptimizationScheduler.ts:550`:

```typescript
combinerConfig: {
  // existing weight forwards...
  directionMultiplier: params['combiner.directionMultiplier'] as number | undefined,
}
```

**(b) `BacktestService.combinerConfig`** interface (`BacktestService.ts:71-86`):

```typescript
combinerConfig?: {
  // existing fields...
  directionMultiplier?: number;
};
```

**(c) `BacktestService.createBacktest`** combiner construction (`BacktestService.ts:181-188`):

```typescript
const combiner = new WeightedAverageCombiner(weights, cc ? { ... } : undefined);
if (cc?.directionMultiplier !== undefined) {
  combiner.setDirectionMultiplier(cc.directionMultiplier);
}
```

Each per-type trial backtest applies the dm Optuna chose for that trial. Markets in the trial's pool already share one `market_type` (per-type filter from PR #143), so a single global dm in the trial is correct: the trial answers "for this type, what is the best dm?". `BacktestEngine.combine()` does **not** need to change — the combiner during a per-type trial only ever sees one type.

## 6. Optimizer parameter space

### 6.1 New per-type entry

In `packages/optimizer/src/core/ParameterSpace.ts`, add to `PER_TYPE_PARAMETER_SPACE` only:

```typescript
{
  name: 'combiner.directionMultiplier',
  type: 'categorical',
  choices: [-1.0, 1.0],
  category: 'combiner',
  description: 'Sign of signal-to-side mapping. Per-market-type categorical to prevent continuous drift (issue #109).',
}
```

`FULL_PARAMETER_SPACE` and `MINIMAL_PARAMETER_SPACE` continue to exclude `combiner.directionMultiplier` entirely. The PR #104 regression tests still pass unchanged.

### 6.2 New regression tests

In `ParameterSpace.test.ts`:

```typescript
it('PER_TYPE_PARAMETER_SPACE exposes combiner.directionMultiplier as categorical with choices [-1, 1] only', () => {
  const dm = PER_TYPE_PARAMETER_SPACE.find(p => p.name === 'combiner.directionMultiplier');
  expect(dm).toBeDefined();
  expect(dm!.type).toBe('categorical');
  expect(dm!.choices).toEqual([-1.0, 1.0]);
});

it('PER_TYPE_PARAMETER_SPACE never exposes combiner.directionMultiplier as continuous (float/int)', () => {
  const dm = PER_TYPE_PARAMETER_SPACE.find(p => p.name === 'combiner.directionMultiplier');
  expect(dm?.type).not.toBe('float');
  expect(dm?.type).not.toBe('int');
});
```

These three tests (existing #104 plus two new) jointly enforce: dm is **never** continuous anywhere, and **only** categorical `{-1, +1}` in PER_TYPE.

## 7. Transition plan

This spec covers PR-1 only. Subsequent PRs are sketched here for completeness but not designed in detail.

| PR | Scope | When |
|---|---|---|
| **PR-1 (this)** | Bootstrap rows + policy extension + optimizer feedback wiring. LearningService keeps running but its segments stay empty (it never promotes any) so it has no observable effect. | Now |
| PR-2 | Add env var `ENABLE_DIRECTION_MULTIPLIER_LEARNING_SERVICE` (default `false`). Service stops scheduling. | +1 week, contingent on PR-1 showing event_financial WR recovery |
| PR-3 | Delete `DirectionMultiplierLearningService.ts`, sub-segment policy fields (segments[], priceBucket logic), `direction_multiplier_policy` legacy structure in trading_config. Keep `DirectionMultiplierPolicy.ts` (now thin: just the per-type lookup function), `applied_direction_multiplier` column (for live tracking), and the new policy composer. | +2-3 weeks |

**PR-1 is the only PR planned in this spec.** PRs 2 and 3 are tracked as follow-ups; their plans are written separately when triggered.

## 8. Guardrails

- **Categorical-only domain in optimizer.** Optuna physically cannot propose 0 or any intermediate value for the per-type dm. Reproducing the Apr 14 / Apr 18 drift events is impossible by construction.
- **Runtime fallback −1.** Resolver returns `policy.global` (today: −1) when neither segment nor perMarketType match. Markets without a classified type keep historical behaviour. Never falls to 0.
- **OOS gate intact.** dm writes go through the same `if (oosPass) write` path as every other per-type weight. A degenerate trial cannot push a bad dm to production unless OOS validates it.
- **Optional minimum-lift gate.** New env var `OPTIMIZER_DM_FLIP_MIN_LIFT` (default `0`). When `> 0`, the per-type write path requires `OOS_Sharpe(new_dm) > OOS_Sharpe(current_dm) + OPTIMIZER_DM_FLIP_MIN_LIFT` before flipping a market_type from its current dm value. The default of 0 disables the extra gate (any OOS pass writes); operators raise it if a regression is observed (e.g. crypto WR drops). Implementation: read current `direction_multiplier[marketType]` from signal_weights before write; if Optuna best dm equals current → write proceeds (no flip); if differs → check lift; if below threshold → skip the write and log the rejected flip. Other params written normally.
- **Bootstrap idempotent.** `ON CONFLICT DO NOTHING` means re-running migrations never overwrites optimizer-discovered values.
- **Per-type test coverage.** Three regression tests in ParameterSpace + new integration test in `OptimizationScheduler.test.ts` exercising per-type dm write + min-lift rejection.
- **Sanity monitoring query.** Daily review SQL (added in §9) verifies `signal_weights.weight` for `signal_type='direction_multiplier'` only ever holds values in `{-1, +1}`. Any other value → drift regression alarm.

## 9. Verification post-deploy

### Immediate (within 1 hour of deploy)

```sql
-- Bootstrap landed
SELECT signal_type, market_type, weight, updated_at::timestamp(0)
FROM signal_weights
WHERE signal_type = 'direction_multiplier'
ORDER BY market_type;
-- Expected: 5 rows. crypto_*=-1, event_short=-1, event_long=-1, event_financial=+1.
```

### After first full per-type cycle (~6h)

```sql
-- Optimizer started writing per-type dm
SELECT market_type, weight, updated_at::timestamp(0)
FROM signal_weights
WHERE signal_type = 'direction_multiplier' AND updated_at > <deploy_time>
ORDER BY updated_at DESC;
-- Expected: at least 1 row updated (whichever type ran the cycle), weight ∈ {-1, +1}.
```

### After 24 hours of trading

```sql
-- Live trades reflect new dm
SELECT m.market_type,
       pp.applied_direction_multiplier,
       COUNT(*) trades,
       COUNT(*) FILTER (WHERE realized_pnl > 0) wins
FROM paper_positions pp
JOIN markets m ON pp.market_id = m.id
WHERE pp.opened_at > <deploy_time>
  AND pp.realized_pnl IS NOT NULL
GROUP BY m.market_type, pp.applied_direction_multiplier
ORDER BY m.market_type;
-- Expected: event_financial trades have applied_direction_multiplier=+1.
```

### Success criteria (7 days post-deploy)

- `event_financial` 7-day WR rises from 17% to >50% (would still be a major regime if it stays at 50%, but moves us out of "worse than random").
- No regression in other types: each `market_type` 7-day WR ≥ its baseline from the 7 days before deploy.
- No optimizer drift events: `signal_weights` rows for `direction_multiplier` only ever contain values in `{-1.0, 1.0}`. A monitoring query in the daily review enforces this:

```sql
SELECT market_type, weight FROM signal_weights
WHERE signal_type = 'direction_multiplier' AND weight NOT IN (-1.0, 1.0);
-- Must always return zero rows. Any row → regression.
```

## 10. Non-goals / Open items

- **Sub-segmentation by priceBucket × durationBand.** The LearningService's segmentation was finer than per-(market_type). PR-1 keeps the cruder per-(market_type) only because that is the unit at which we have data to validate. If volume grows enough that sub-segmentation pays off (probably 6+ months out), we revisit then.
- **Removing the env var fallback.** `process.env.DIRECTION_MULTIPLIER` and the global combiner field are kept as a fallback path in PR-1. PR-3 removes them once we are confident the per-type path is reliable.
- **Backtest cycle uses the same dm.** Backtests inside Optuna trials apply the trial's `combiner.directionMultiplier` to all markets in that backtest, regardless of market_type, because each trial belongs to one type's study. This is correct: the trial is asking "what if all event_financial markets used dm=+1?", not "what if mixed dms?". The implementation uses the trial's dm uniformly within the per-type backtest pool.
- **Migration numbering.** Choose the next available `NNN` at implementation time — listing existing init SQL files. Init SQL pattern is `NNN_<slug>.sql` per project convention.

## 11. Files touched

```
packages/data-collector/src/database/init/028_direction_multiplier_per_type_seed.sql       [new]
packages/optimizer/src/core/ParameterSpace.ts                                               [categorical entry in PER_TYPE_PARAMETER_SPACE]
packages/optimizer/src/core/ParameterSpace.test.ts                                          [+2 regression tests for categorical-only domain]
packages/dashboard/src/services/DirectionMultiplierPolicy.ts                                [add perMarketType to interface + sanitize; extend resolveDirectionMultiplier with per-type branch]
packages/dashboard/src/services/DirectionMultiplierPolicy.test.ts                           [test per-type priority between segment match and global fallback]
packages/dashboard/src/services/SignalEngine.ts (or wherever policyProvider is wired)       [policy composer reads signal_weights.direction_multiplier rows]
packages/dashboard/src/services/SignalEngine.test.ts                                        [test composed policy applies perMarketType end-to-end]
packages/dashboard/src/services/OptimizationScheduler.ts                                    [extend WEIGHT_PARAM_MAP for per-type dm; mapOptunaParamsToRequest forwards combiner.directionMultiplier; min-lift gate]
packages/dashboard/src/services/OptimizationScheduler.test.ts                               [per-type dm write + min-lift rejection]
packages/dashboard/src/services/BacktestService.ts                                          [add directionMultiplier? to combinerConfig; apply combiner.setDirectionMultiplier() before backtest]
packages/dashboard/src/services/BacktestService.test.ts (or similar)                        [trial dm propagates to combiner]
docs/plans/2026-04-30-direction-multiplier-per-type-design.md                               [this file]
```

Files **not** modified:
- `WeightedAverageCombiner.ts` — existing API is sufficient.
- `DirectionResolver.ts` — wraps the policy resolver; the per-type logic lives inside `resolveDirectionMultiplier()` so the resolver itself does not change.
- `BacktestEngine.ts` — per-type filter ensures one type per trial, so global combiner dm is correct in-trial.

Estimated scope: 2 files new (migration + design doc) + 9 files modified. Total LOC ~180 (mostly tests).
