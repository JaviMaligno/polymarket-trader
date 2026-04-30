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

The `DirectionMultiplierLearningService` becomes redundant once dm lives in the per-type optimizer pipeline. PR-1 leaves it running but irrelevant (the combiner reads from `signal_weights`, not from `trading_config.direction_multiplier_policy`); subsequent PRs deprecate and remove it.

## 3. Architecture

```
Optuna PER_TYPE study (categorical {-1, +1})
    ↓ best params per (market_type)
OptimizationScheduler.runIncrementalOptimization (per-type loop)
    ↓ post-OOS write
signal_weights row: (signal_type='direction_multiplier', market_type=X) → ±1
    ↓ next sync cycle
SignalEngine.syncTypeWeights() calls combiner.setDirectionMultipliers({[marketType]: dm})
    ↓ at signal emission
DirectionResolver returns contextKey = marketType
    ↓
WeightedAverageCombiner.getDirectionMultiplier(contextKey) → looks up contextDirectionMultipliers
```

Reuses every component shipped in PR #143/#155/#157. No new tables, no new services, no new schedulers.

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

The combiner already has the API we need (`setDirectionMultipliers(map)` and `getDirectionMultiplier(contextKey)` accepting a string-keyed lookup with global fallback — `WeightedAverageCombiner.ts:155-174`). We do **not** add a new `typeDirectionMultipliers` map; we fill the existing `contextDirectionMultipliers` with `marketType` keys.

The combiner's `combine()` already accepts `marketType` and `directionContextKey` (line 182-187). The live path (`SignalEngine.ts:510`) already passes both. The plumbing is in place.

### 5.1 Fill `contextDirectionMultipliers` from `signal_weights`

Today `contextDirectionMultipliers` is populated by `DirectionMultiplierLearningService` with composite keys (e.g. `event_financial-40to60|seg-7`). After this PR it is populated by `SignalEngine.syncTypeWeights()` with **simple `marketType` keys** read from `signal_weights` rows where `signal_type='direction_multiplier'`.

`SignalEngine.syncTypeWeights()`:
1. Existing query loads per-type generator weights → `combiner.setTypeWeights(map)`.
2. **New**: same query (or a sibling one) also pulls rows where `signal_type = 'direction_multiplier'`, builds `Record<marketType, number>`, and calls `combiner.setDirectionMultipliers(record)`.

The two calls happen inside the same sync cycle. No new schedule.

### 5.2 `DirectionResolver` fallback to `marketType`-only key

`DirectionResolver.resolve(...)` returns `{ multiplier, contextKey }`. Today the `contextKey` it returns is something like `event_financial-40to60` (always includes priceBucket) or `event_financial-40to60|seg-7` (with segment match). The combiner then looks up that key in `contextDirectionMultipliers`, which now stores keys like `event_financial`. Mismatch — fallback to global = −1.

Fix: when no `LearningService` segment matches, **the resolver returns `contextKey = marketType`** (no priceBucket suffix, no segment suffix). The combiner finds the per-type row, applies it.

If a future LearningService re-activates (PR-3 might preserve it for sub-segmentation), it can still inject finer keys via `setDirectionMultiplier(multiplier, finerContextKey)` — they sit alongside the per-type keys without collision because the resolver picks one or the other based on priority.

This is the smallest change that makes the per-type bootstrap actually take effect at runtime. Without it, `signal_weights` rows would be written but never consulted.

### 5.3 `OptimizationScheduler` per-type loop

In `runPerTypeIncremental(marketType)`:
- After Optuna best params returned and OOS gate passes, the existing `WEIGHT_PARAM_MAP` writes `combiner.<x>Weight` rows. Extend the map with `'combiner.directionMultiplier' → 'direction_multiplier'`.
- Same OOS-gated path: if OOS fails, the row is **not** updated. Existing dm value persists.

**Existing FULL-strategy test stays valid.** `OptimizationScheduler.test.ts:70` ("always enforces direction_multiplier to -1.0 after a successful optimization") asserts that `updateStrategy` (the FULL pathway) pins dm to −1.0 regardless of optimizer output. The FULL pathway has no per-type concept, so its global pin is the right safeguard there. Our per-type write path is separate — new tests cover it; the existing test is untouched.

### 5.4 `mapOptunaParamsToRequest` — wire dm into the trial backtest

`mapOptunaParamsToRequest(params, startDate, endDate)` builds the `BacktestRequest` for each Optuna trial. It currently maps `combiner.<x>Weight` params into `combinerConfig.<x>Weight`. **Add an explicit map entry**:

```typescript
combinerConfig: {
  // existing weights...
  directionMultiplier: params['combiner.directionMultiplier'] as number | undefined,
}
```

Without this line, every per-type trial runs with the combiner's hardcoded default `−1`, the optimizer's choice between `−1` and `+1` produces identical fitness, and the per-type optimizer cannot learn dm. **This is the line that closes the optimizer feedback loop.**

### 5.5 `BacktestService.createBacktest` — apply dm to the trial combiner

Two adjustments to `BacktestService.ts`:

(a) Add field to the `combinerConfig` interface (`BacktestService.ts:71-86`):

```typescript
combinerConfig?: {
  // existing fields...
  directionMultiplier?: number;
};
```

(b) Apply it when constructing the combiner (`BacktestService.ts:181-188`):

```typescript
const combiner = new WeightedAverageCombiner(weights, cc ? { ... } : undefined);
if (cc?.directionMultiplier !== undefined) {
  combiner.setDirectionMultiplier(cc.directionMultiplier);
}
```

This means each per-type trial backtest applies the dm Optuna chose for that trial. Markets in the trial's pool already share one `market_type` (per-type filter from PR #143), so a single global dm in the trial is correct: the trial answers "for this type, what is the best dm?".

`BacktestEngine.combine()` (line 813) does **not** need to change. It already calls `combiner.combine(signals, currentTime)` without `marketType`, and that is fine because the combiner during a per-type trial only ever sees one type — the global `directionMultiplier` set in (b) is the right value for every signal in that trial.

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
| **PR-1 (this)** | Bootstrap rows + runtime + optimizer changes. LearningService keeps running but is no longer load-bearing — its `direction_multiplier_policy` in trading_config is ignored by the new combiner code path. | Now |
| PR-2 | Add env var `ENABLE_DIRECTION_MULTIPLIER_LEARNING_SERVICE` (default `false`). Service stops scheduling. | +1 week, contingent on PR-1 showing event_financial WR recovery |
| PR-3 | Delete `DirectionMultiplierLearningService.ts`, `DirectionMultiplierPolicy.ts`, related tests, `direction_multiplier_policy` row in trading_config, columns `applied_direction_multiplier_segment` if any in paper_positions. Keep `applied_direction_multiplier` (numeric column) for tracking what dm was used at trade time. | +2-3 weeks |

**PR-1 is the only PR planned in this spec.** PRs 2 and 3 are tracked as follow-ups; their plans are written separately when triggered.

## 8. Guardrails

- **Categorical-only domain in optimizer.** Optuna physically cannot propose 0 or any intermediate value. Reproducing the Apr 14 / Apr 18 drift events is impossible by construction.
- **Runtime fallback −1.** Markets with unknown `market_type` (e.g. mid-classification) keep historical behaviour. Never falls to 0.
- **OOS gate intact.** dm writes go through the same `if (oosPass) write` path as every other per-type weight. A degenerate trial cannot push a bad dm to production unless OOS validates it.
- **Bootstrap idempotent.** `ON CONFLICT DO NOTHING` means re-running migrations never overwrites optimizer-discovered values.
- **Per-type test coverage.** Three regression tests in ParameterSpace + integration test in `OptimizationScheduler.test.ts` covering one per-type cycle that exercises the dm write path.

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
packages/data-collector/src/database/init/028_direction_multiplier_per_type_seed.sql  [new]
packages/optimizer/src/core/ParameterSpace.ts                                          [add categorical entry to PER_TYPE_PARAMETER_SPACE]
packages/optimizer/src/core/ParameterSpace.test.ts                                     [add 2 regression tests for categorical-only domain]
packages/dashboard/src/services/DirectionResolver.ts                                   [fall back to contextKey = marketType when no segment match]
packages/dashboard/src/services/DirectionResolver.test.ts                              [test marketType-only fallback]
packages/dashboard/src/services/SignalEngine.ts                                        [extend syncTypeWeights to load dm rows + call setDirectionMultipliers(record)]
packages/dashboard/src/services/SignalEngine.test.ts                                   [test sync loads dm rows + applies them via combiner]
packages/dashboard/src/services/OptimizationScheduler.ts                               [extend WEIGHT_PARAM_MAP for per-type dm; mapOptunaParamsToRequest forwards combiner.directionMultiplier]
packages/dashboard/src/services/OptimizationScheduler.test.ts                          [test per-type write path + mapping]
packages/dashboard/src/services/BacktestService.ts                                     [add directionMultiplier? to combinerConfig interface; apply combiner.setDirectionMultiplier() before backtest]
packages/dashboard/src/services/BacktestService.test.ts (or similar)                   [test trial dm propagates to combiner]
docs/plans/2026-04-30-direction-multiplier-per-type-design.md                          [this file]
```

Note: `WeightedAverageCombiner.ts` is **not** modified — the API we need (`setDirectionMultipliers`, `getDirectionMultiplier(contextKey)`, `combine(..., marketType, contextKey)`) already exists.

Estimated scope: 2 files new (migration + design doc) + 9 files modified. Total LOC ~180 (mostly tests).
