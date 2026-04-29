# Update strategy — extract global threshold deploy from per-type loop (closes #145)

**Status**: Spec, awaiting user review.
**Branch**: `fix/update-strategy-global-thresholds`.

## Goal

Decouple the global-threshold deploy from the per-type weight-write inside `updateStrategy`. Today both happen in the same method called once per market_type in the per-type loop, so the executor's runtime `minEdge` / `minConfidence` are clobbered by whichever type processes last and passes OOS — order-dependent and fragile. The fix selects the highest-Sharpe winner across the cycle and deploys global thresholds exactly once.

Spec context: `docs/plans/2026-04-28-per-type-optimizer-design.md` introduced the per-type loop. CodeRabbit caught this gap as an "outside-diff" finding; it was deferred as issue #145.

## Empirical justification

Today's first per-type cycle (2026-04-29 02:04 UTC):
- crypto_intraday/crypto_daily: skipped (no data)
- event_financial: applied (Sharpe 0.07) ✓
- event_short: rejected (IS Sharpe ≤ 0)
- event_long: rejected (trades < 20)

Only event_financial's `updateStrategy` ran, so its thresholds drove the executor by accident. After PR #150 lowered the OOS `minTrades` floor for event_long to 5, multiple types may now pass in the same cycle. With the current code, the loop order (`crypto_intraday → crypto_daily → event_financial → event_short → event_long`) determines which type's thresholds win — last-passing type clobbers earlier ones. Not a current-day problem (only event_financial passes), but load-bearing the moment it changes.

## Design

### Split `updateStrategy(result, marketType)` into two phases

**Phase A — per-type writes (stays in the per-type loop)**

These operations are either explicitly per-type or idempotent. Keep them inside `updateStrategy`:

1. Sanity checks (sharpe > 8, trades < 5, totalReturn < −0.1).
2. OOS gate (`_lastOOSResult.passed`).
3. `state.bestSharpePerType[marketType] = result.sharpe`.
4. `optimization_runs UPDATE WHERE status='running'` (idempotent — first call updates, subsequent calls find no rows).
5. `direction_multiplier` enforcement to −1.0 (idempotent — same value every call).
6. Per-type weight writes via `signalWeightsRepo.updatePerType(...)` (the `WEIGHT_PARAM_MAP` loop).

`updateStrategy` returns `{ wasApplied: boolean }`. `wasApplied = true` iff phase A ran to completion (i.e., OOS passed + sanity checks passed).

**Phase B — global threshold deploy (new method, runs ONCE after the loop)**

New `applyGlobalThresholds(result, marketType)`:

1. Extract `minEdge` and `minConfidence` from `result.params`.
2. Stop currently-running strategies via `${dashboardApiUrl}/api/strategies` API.
3. Create new combo strategy with the new thresholds.
4. Update `tradingAutomation.executor.config` runtime.

The `marketType` argument is informational only (logged for traceability — "deployed global thresholds from event_financial winner").

### Caller refactor in `runIncrementalOptimization` and `runFullOptimization`

```typescript
const winners: Array<{ marketType: string; result: OptimizationResult }> = [];

for (const marketType of MARKET_TYPES) {
  // ... existing loop body that runs Optuna, OOS, calls updateStrategy ...
  const { wasApplied } = await this.updateStrategy(best, marketType);
  if (wasApplied) {
    winners.push({ marketType, result: best });
  }
}

// Apply global thresholds ONCE per cycle, with the winner type
if (winners.length > 0) {
  const globalWinner = winners.reduce((a, b) =>
    a.result.sharpe > b.result.sharpe ? a : b,
  );
  console.log(
    `[OptimizationScheduler] Cycle winner: ${globalWinner.marketType} (Sharpe ${globalWinner.result.sharpe.toFixed(3)}, ${winners.length} types qualified)`,
  );
  await this.applyGlobalThresholds(globalWinner.result, globalWinner.marketType);
}
```

Identical pattern for `runFullOptimization`.

### Why this is the right line for the split

| Operation | Per-type or global? | Why |
|---|---|---|
| Per-type weights | Per-type | Different value per type by design — stays in loop |
| `bestSharpePerType[marketType]` | Per-type | Indexed by type — stays in loop |
| `direction_multiplier=-1.0` | Idempotent | Same value every call → no clobber. Keep in updateStrategy for simplicity. |
| `optimization_runs UPDATE` | Idempotent | First call clears `status=running` → subsequent are no-ops. Keep in updateStrategy. |
| `minEdge`/`minConfidence` extraction | Type-specific values | Different per type → MUST move to global, MUST pick a winner |
| Stop/start combo strategy | Global state mutation | One executor — last-writer-wins → MUST be once-per-cycle |
| Executor `updateConfig` | Global state mutation | Same — once-per-cycle |

## Tests

`packages/dashboard/src/services/OptimizationScheduler.test.ts`:

1. **Single qualifying type**: mock loop with one type passing OOS → assert `applyGlobalThresholds` invoked exactly once with that type's result.
2. **Multiple qualifying types**: mock 2-3 types passing with different Sharpes → assert `applyGlobalThresholds` invoked exactly ONCE with the highest-Sharpe winner.
3. **No qualifying types**: all types fail OOS → assert `applyGlobalThresholds` is NOT invoked.
4. **Direction multiplier still enforced per-type call**: existing test `'always enforces direction_multiplier to -1.0 after a successful optimization'` continues to pass without modification (it calls `updateStrategy` directly, which still does the enforcement).
5. **Per-type weights still written**: per-type loop still calls `signalWeightsRepo.updatePerType` for each generator (existing behaviour).

## Acceptance criteria

(a) Tests above all pass; `pnpm tsc -p packages/dashboard/tsconfig.json --noEmit` clean.

(b) Post-deploy log evidence: dashboard-api logs include `[OptimizationScheduler] Cycle winner: <market_type> (Sharpe ...)` after each per-type cycle that has at least one qualifying type. With current data only event_financial qualifies, so the log fires with that type. After PR #150 lowered the minTrades floor for event_long, event_long may also start passing — at which point the log line confirms the deterministic winner selection.

## Out of scope

- Per-type minEdge/minConfidence (i.e., the executor reads thresholds keyed by `signal.marketType`). That is the architecturally correct fix; it requires a separate executor refactor and is documented in the issue body as the alternative path. Not in this PR.
- Tie-breaking when two types have identical Sharpe — JavaScript `reduce` keeps the first encountered. Documented in code comment but not test-asserted (vanishingly unlikely in practice).

## Files touched

| Path | Change |
|---|---|
| `packages/dashboard/src/services/OptimizationScheduler.ts` | Modify `updateStrategy` to return `{ wasApplied }` and remove global-threshold block. Add new `applyGlobalThresholds` method. Modify `runIncrementalOptimization` and `runFullOptimization` to track winners and call `applyGlobalThresholds` once. |
| `packages/dashboard/src/services/OptimizationScheduler.test.ts` | Add 3 tests for winner selection and global deploy behaviour. |

No DB migrations, no env vars, no schema changes.

## Risks

- **Breaking change to `updateStrategy` return type**: existing callers (only the loop in this file) need to read `{ wasApplied }`. The existing test that calls `updateStrategy` directly with a single arg ignores the return value, so it remains compatible.
- **`applyGlobalThresholds` uses `dashboardApiUrl`**: the strategy stop/start API roundtrip can fail. Existing code already wraps it in try/catch — preserved verbatim.
- **`getTradingAutomation().getExecutor().updateConfig` is a runtime mutation**: after this PR it fires once per cycle instead of up to 5 times. If the executor cached values per-type (it doesn't), behaviour would change. Verified: executor stores a single `{ minStrength, minConfidence }` config — last-writer-wins is preserved, just deterministic now.
