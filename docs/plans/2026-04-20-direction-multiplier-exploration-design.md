# Direction Multiplier Exploration — Design

**Date:** 2026-04-20
**Status:** Approved (awaiting implementation plan)
**Scope:** Single PR — widen learner range + add epsilon-greedy exploration

## Context & Motivation

The `directionMultiplier` in `WeightedAverageCombiner` flips the combined signal direction (`strength * multiplier`). Currently pinned to `-1.0` globally (PR #104, 2026-04-18), with per-segment overrides via `DirectionMultiplierLearningService` (learner) bounded to `[-1.25, +0.1]`.

### Empirical evidence (329 trades, 2026-04-07 → 2026-04-19)

| Category | Trades | WR actual (flipped) | WR counterfactual (un-flipped) |
|----------|--------|---------------------|-------------------------------|
| event_short | 28 | 3.6% | **89.3%** |
| event_long | 228 | 11.8% | **86.0%** |
| crypto_daily | 4 | 0.0% | 100% |
| event_financial | 68 | 20.6% | 79.4% |
| crypto_intraday | 1 | 100% | 0% |
| **Total** | **329** | **13.1%** | **86.9%** |

The original justification for `-1.0` (commit `f7ea78d`, 2026-04-07) cited "91.5% WR if all 188 trades inverted". The current counterfactual for 329 trades shows the same asymmetry now favours un-flip. Post-reset PnL: −$1,125; counterfactual ≈ +$1,125.

### Cold-start problem

The learner (`deriveDirectionMultiplierPolicy`) compares candidate multiplier buckets **within a segment**. With global pinned `-1.0`, all trades fall in `strong_negative` bucket → single candidate → `best === baseline` → no promotion possible. The existing `event_financial-20to40-medium → -1.25` segment only promoted because its history contained trades at both `-1.0` and `-1.25` (ratchet effect). Widening the range without generating multi-bucket data yields a **structurally inert** learner.

### Chosen approach

Epsilon-greedy exploration: the resolver applies a random multiplier from `[0.0, 1.0]` (continuous uniform) to a small fraction of trades, generating the multi-bucket observations the learner requires.

## Non-goals

- **Not despinning the global multiplier.** Global stays pinned at `-1.0` in this PR. Despin is a separate follow-up PR once exploration produces evidence.
- **Not modifying optimizer parameter space.** `direction_multiplier` stays out of Optuna (preserves PR #104 intent).
- **Not adding Thompson sampling / bandit logic.** Future iteration if uniform sampling proves insufficient.
- **Not resetting the paper account.** The learner's 30-day lookback window absorbs the transition naturally.
- **Not changing signal generators or combiner math.** Only the multiplier resolution layer.

## Design overview

```
SignalEngine
    │
    ▼
DirectionResolver.resolve(context)
    │
    ├─ Segment match via resolveDirectionMultiplier(context, policy)
    │     └─ segmentId found? → exploit (use segment multiplier)
    │
    ├─ No match + exploration disabled → exploit (use global -1.0)
    │
    └─ No match + exploration enabled (roll < epsilon)
          └─ sample U(min, max) → explore (random multiplier)
    │
    ▼
{ multiplier, segmentId, wasExploration, reason }
    │
    ▼
WeightedAverageCombiner.setDirectionMultiplier(multiplier, ctxKey)
WeightedAverageCombiner.combine() → output.appliedDirectionMultiplier
    │
    ▼
SignalEngine enriches: { ...output, wasExploration, metadata.direction }
    │
    ▼
AutoSignalExecutor → paperPositionsRepo.open(..., appliedDirectionMultiplier, wasExploration)
    │
    ▼
INSERT INTO paper_positions (..., applied_direction_multiplier, was_exploration)
```

## Components

### 1. `DirectionResolver` (new module)

Location: `packages/dashboard/src/services/DirectionResolver.ts`

```ts
type ResolveReason = 'segment' | 'global' | 'exploration' | 'breaker_tripped';

interface DirectionResolution {
  multiplier: number;
  contextKey: string;          // preserved from pure resolveDirectionMultiplier for combiner.setDirectionMultiplier(multiplier, contextKey)
  segmentId: string | null;
  wasExploration: boolean;
  reason: ResolveReason;
}

interface DirectionResolverDeps {
  policyProvider: () => Promise<DirectionMultiplierPolicy>;
  explorationConfig: ExplorationConfig;
  rng?: () => number;              // default Math.random — injectable for tests
  paperPositionsRepo: PaperPositionsRepo;  // for circuit breaker state
  logger: Logger;
}

interface ExplorationConfig {
  enabled: boolean;        // env: ENABLE_DIRECTION_EXPLORATION (default true)
  epsilon: number;         // env: DIRECTION_EXPLORATION_EPSILON (default 0.10)
  min: number;             // env: DIRECTION_EXPLORATION_MIN (default 0.0)
  max: number;             // env: DIRECTION_EXPLORATION_MAX (default 1.0)
  breakerMinTrades: number;      // default 20
  breakerWindowDays: number;     // default 7
  breakerMaxCumLoss: number;     // default -150
  breakerCacheTtlMs: number;     // default 300_000 (5 min)
}

class DirectionResolver {
  async resolve(context: DirectionContext): Promise<DirectionResolution>;
  private async isBreakerTripped(): Promise<boolean>;
}
```

**Resolution order inside `resolve()`:**

1. Load active policy (via `policyProvider` — `trading_config.direction_multiplier_policy`).
2. Call pure `resolveDirectionMultiplier(context, policy)` → `{ multiplier, segmentId }`. If `segmentId !== null`, return `{ multiplier, segmentId, wasExploration: false, reason: 'segment' }`.
3. Check `explorationConfig.enabled`. If false → return `{ multiplier: policy.global, ..., reason: 'global' }`.
4. Check circuit breaker (`isBreakerTripped`, cached). If tripped → return global with `reason: 'breaker_tripped'`.
5. Roll `rng() < epsilon`. If miss → return global with `reason: 'global'`.
6. Hit: `sampled = min + rng() * (max - min)` → return `{ multiplier: sampled, segmentId: null, wasExploration: true, reason: 'exploration' }`.

**Policy caching:** `policyProvider` is expected to cache internally (TTL ≥ 60s) since `resolve()` is called per-market per-signal-cycle (~15 markets × 60s cadence = 15 calls/min). The learner writes the policy every 6h, so a 60s–5min TTL is safe. The existing `tradingConfigRepo` has no cache — wrap it in a memoizer at the DirectionResolver's policyProvider or reuse any existing cache in SignalEngine for the same key. Decision deferred to implementation, but required.

**Natural bias of sampled distribution:** `WeightedAverageCombiner` discards any combined signal where `|strength * multiplier| < minCombinedStrength` (0.27). For a raw strength of ~0.5 (typical), exploration multipliers below ~0.55 produce no trade. Effective exploration is thus weighted toward the upper half of `[0, 1.0]`. This is a desirable filter — near-zero multipliers correspond to "no signal" and shouldn't trade anyway — but it means we won't get data points in `near_zero` bucket from exploration alone. The `near_zero` bucket will only see meaningful trades via the learner promoting into it, which is self-consistent.

**Async transition:** `SignalEngine`'s current call to `resolveDirectionMultiplier(policy, ctx)` is synchronous; `directionResolver.resolve(ctx)` is async (must await policy + breaker). The per-market generation path already awaits other repos; adding one more await is mechanical but must be threaded through any sync-only helpers.

**Circuit breaker logic (`isBreakerTripped`):**

```sql
SELECT COUNT(*) AS explore_count,
       COALESCE(SUM(realized_pnl), 0) AS explore_pnl
FROM paper_positions
WHERE was_exploration = true
  AND closed_at >= NOW() - INTERVAL '7 days'
  AND realized_pnl IS NOT NULL;
```

Tripped iff `explore_count >= breakerMinTrades AND explore_pnl < breakerMaxCumLoss`. Result cached for `breakerCacheTtlMs` (default 5 min) to avoid per-signal queries. On trip, emits event `direction_exploration:breaker_tripped` and writes a status object to `trading_config` key `direction_exploration_status`:

```json
{
  "state": "tripped",
  "trippedAt": "2026-04-25T14:22:10Z",
  "exploreCount": 22,
  "explorePnl": -172.45,
  "thresholdTrades": 20,
  "thresholdLoss": -150
}
```

When the breaker un-trips (because the 7-day rolling window has evicted the losing trades), the next `resolve()` call that finds it un-tripped rewrites the status with `{ "state": "active", ... }`. This state transition is observable by the daily review script via a simple `SELECT value FROM trading_config WHERE key = 'direction_exploration_status'`.

### 2. `DirectionMultiplierLearningService` (modify)

Location: `packages/dashboard/src/services/DirectionMultiplierLearningService.ts`

Changes to `DEFAULT_CONFIG`:
```ts
minMultiplier: -1.25,           // unchanged
maxMultiplier: 1.0,             // was 0.1
maxPositiveMultiplier: 1.0,     // was 0.1
```

Changes to `bucketDirectionMultiplier` (new bucket set matching the widened range):
```ts
if (multiplier <= -0.5) return 'strong_negative';
if (multiplier < 0.25)  return 'near_zero';
if (multiplier < 0.75)  return 'weak_positive';
return 'strong_positive';
```

**Learner query modification (critical):** the existing query joins `signal_weights_history` to recover the multiplier-at-trade-time. That column only tracks **global** multiplier changes and would mis-attribute every exploration trade to whichever global value was active at the time (e.g. `-1.0`), making multi-bucket data invisible to the learner. Fix:

```sql
-- COALESCE prefers the per-trade applied value; falls back to historical global for legacy rows
COALESCE(pp.applied_direction_multiplier, dm.weight, $2) AS direction_multiplier
```

This ensures exploration trades and future per-segment overrides are bucketed by the multiplier actually applied to them, not by the contemporaneous global.

No other learner logic changes. Promotion thresholds (`minSegmentTrades=24`, `minCandidateTrades=8`, `minImprovementPerTrade=0.75`, `minWinRateLift=0.08`) unchanged — we do **not** relax promotion criteria.

### 3. `SignalEngine` (modify)

Location: `packages/dashboard/src/services/SignalEngine.ts`

- Inject `DirectionResolver` via constructor.
- Replace synchronous `resolveDirectionMultiplier(policy, ctx)` at line 449 with `await this.directionResolver.resolve(ctx)`.
- Existing `combiner.setDirectionMultiplier(resolution.multiplier, resolution.contextKey)` call at line 455 stays intact (resolver preserves `contextKey`).
- **Consolidate metadata.** Current code at lines 478-483 writes three separate keys (`metadata.directionMultiplier`, `metadata.directionContextKey`, `metadata.directionPolicySegmentId`). Those become top-level on the output (`appliedDirectionMultiplier`, `wasExploration`) plus a single grouped `metadata.direction` for diagnostics. No external consumers read the old keys (grep verified), so this is an internal consolidation:

```ts
// After combiner.combine() returns into `combined`:
combined.appliedDirectionMultiplier = resolution.multiplier;
combined.wasExploration = resolution.wasExploration;
combined.metadata = {
  ...(combined.metadata ?? {}),
  direction: {
    contextKey: resolution.contextKey,
    segmentId: resolution.segmentId ?? 'global',
    reason: resolution.reason,
  },
};
// REMOVED: directionMultiplier, directionContextKey, directionPolicySegmentId (superseded by the above)
```

### 4. `WeightedAverageCombiner` (modify)

Location: `packages/signals/src/combiners/WeightedAverageCombiner.ts`

- Extend `CombinedSignalOutput` type:
```ts
interface CombinedSignalOutput {
  // ... existing fields
  appliedDirectionMultiplier: number;
  // metadata remains Record<string, unknown>
}
```
- In `combine()`, include `appliedDirectionMultiplier: multiplier` (line 163, where `multiplier` is already computed) in the output object.

Combiner does **not** know about exploration. `wasExploration` is attached upstream in SignalEngine.

### 5. `AutoSignalExecutor` (modify)

Location: `packages/dashboard/src/services/AutoSignalExecutor.ts`

- On position open, extend the `PaperPosition` object passed into `openPositionAtomically`:
```ts
await paperPositionsRepo.openPositionAtomically({
  // ... existing fields
  applied_direction_multiplier: signal.appliedDirectionMultiplier,
  was_exploration: signal.wasExploration ?? false,
}, cost, fee);
```

### 6. `paperPositionsRepo` + `PaperPosition` interface (modify)

Location: `packages/dashboard/src/database/repositories.ts`

- Extend `PaperPosition` interface (currently around line 310-335):
```ts
interface PaperPosition {
  // ... existing fields
  applied_direction_multiplier?: number | null;   // nullable: legacy inserts without direction context
  was_exploration?: boolean;                      // default false when omitted
}
```

- **Two INSERT sites must be updated** (confirmed by grep):
  1. `paperPositionsRepo.insert()` at line 341 (also reached via deprecated `upsert()` used by `routes.ts` and `PaperTradingService`)
  2. `paperPositionsRepo.openPositionAtomically()` at line 421 (canonical path from `AutoSignalExecutor`)
- Both INSERT column lists + VALUES clauses get `applied_direction_multiplier, was_exploration` appended.
- Both sites pass `position.applied_direction_multiplier ?? null` and `position.was_exploration ?? false` — backward-compatible for existing callers.

Consumers that must compile without change (don't need to populate the new fields): `routes.ts`, `PaperTradingService`, test fixtures. `AutoSignalExecutor` is the only site that supplies real values.

### 7. DB migration (dual path — fresh deployments + existing VM)

**Fresh deployments** — new migration file following the existing numbered pattern:

Location: `packages/data-collector/src/database/init/017_direction_multiplier_exploration_columns.sql`

```sql
ALTER TABLE paper_positions
  ADD COLUMN IF NOT EXISTS applied_direction_multiplier NUMERIC(5,3),
  ADD COLUMN IF NOT EXISTS was_exploration BOOLEAN NOT NULL DEFAULT false;
```

These files run once on first volume init (per project convention) — they won't execute on the existing VM whose volume was initialized months ago.

**Existing deployments** — startup DDL in `dashboard-api`:

Location: `packages/dashboard/src/server.ts` — alongside existing `trading_config` CREATE TABLE IF NOT EXISTS block.

Same SQL as above. `IF NOT EXISTS` guards make the statement idempotent so fresh and legacy deployments converge to the same schema.

**Column semantics:**
- `applied_direction_multiplier`: NULLABLE (pre-migration rows remain NULL — distinguishes "unknown legacy" from an explicit `0`).
- `was_exploration`: NOT NULL DEFAULT false (semantic default for historical rows and non-signal inserts).

## Configuration

New env vars (defaults in `docker-compose.gcp.yml`):

```yaml
ENABLE_DIRECTION_EXPLORATION: "true"
DIRECTION_EXPLORATION_EPSILON: "0.10"
DIRECTION_EXPLORATION_MIN: "0.0"
DIRECTION_EXPLORATION_MAX: "1.0"
DIRECTION_EXPLORATION_BREAKER_MIN_TRADES: "20"
DIRECTION_EXPLORATION_BREAKER_WINDOW_DAYS: "7"
DIRECTION_EXPLORATION_BREAKER_MAX_CUM_LOSS: "-150"
```

Kill switch: set `ENABLE_DIRECTION_EXPLORATION=false` and restart `dashboard-api` — exploration disabled without code change.

## Success criteria (30-day evaluation window)

**Primary (validates un-flip hypothesis):**
- ≥1 segment promoted by learner to a multiplier in `[+0.25, +1.0]` with ≥24 trades and verified lift vs `-1.0` baseline per existing promotion criteria.

**Secondary (supporting signal for despin global in follow-up PR):**
- Aggregate over 30 days on exploration trades that closed with non-null `realized_pnl`:
  - `AVG(realized_pnl) WHERE was_exploration = true` exceeds
    `AVG(realized_pnl) WHERE was_exploration = false AND applied_direction_multiplier = -1.0`
    by at least **$0.50 per trade**.
  - Expected exploration volume at current throughput: ~24 trades/30d (10% × 8 trades/day × 30 days). Sample is statistically weak — this criterion is a **supporting signal**, not standalone evidence. The primary criterion (segment promotion) carries the decision weight.
  - Below 20 trades, suppress this criterion entirely (not enough data to reason about).

**Failure modes (kills hypothesis):**
- Circuit breaker trips ≥2 times in 30 days → exploration is net-negative. Abandon widen-learner path; investigate signal quality upstream instead.
- 30 days elapse with zero segments promoted AND no positive aggregate — evidence absent, rollback exploration, consider alternative approaches (counterfactual backtesting, manual segment seeding).

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|-----------|
| Exploration trades all lose (worst case 10% × 10 trades/day × worst avg ~$15 = ~$15/day) | Medium | Circuit breaker auto-disable at −$150 / 7d |
| New bucket definitions destabilize existing event_financial promotion | Low | `minImprovementPerTrade=0.75` gate prevents spurious re-promotion; segment needs real evidence to change bucket |
| `wasExploration` not threaded to all open callers | Low | Repo param optional with default `false`; audit `start-paper-trading.js` + any manual-entry scripts in implementation |
| Manual intervention needed if breaker trips silently | Low | Emit event + write status to `trading_config.direction_exploration_status` for daily review visibility |
| Concurrent learner evaluation while exploration active causes transient whipsaw | Low | Learner runs every 6h; `minSegmentTrades=24` smooths short-term noise |

## Out of scope (future work)

- **Despin global multiplier** (Cambio 2 from brainstorm): requires evidence from this PR first.
- **Thompson sampling / bandit logic**: consider if uniform exploration is slow to converge.
- **Account reset**: not needed for this PR; re-evaluate after 30 days of data.
- **Adaptive exploration bounds**: `[min, max]` env-var-only for now; could be learner-driven later.
- **Signal-level direction auditing**: if results are inconclusive, deeper investigation into why raw signals produced poor WR — potentially a generator-quality issue, not a multiplier issue.

## Implementation sequence

Single PR; tasks will be detailed in the implementation plan:
1. DB migration — create init file `017_direction_multiplier_exploration_columns.sql` **and** add matching startup DDL in `server.ts` (must run before any service that inserts into `paper_positions`)
2. Extend `PaperPosition` interface + BOTH INSERT sites (`insert` and `openPositionAtomically`) in `repositories.ts`
3. `WeightedAverageCombiner` output extension (top-level `appliedDirectionMultiplier`, typed field + tests)
4. `DirectionResolver` module + unit tests (deterministic RNG, mocked policy provider, mocked repo for breaker state transitions)
5. `DirectionMultiplierLearningService` updates:
   - `DEFAULT_CONFIG` range + `maxPositiveMultiplier`
   - `bucketDirectionMultiplier` new buckets
   - Learner SQL: prefer `pp.applied_direction_multiplier` via COALESCE
6. `SignalEngine` integration: inject resolver, replace sync `resolveDirectionMultiplier(policy, ctx)` call with `await resolver.resolve(ctx)`, set `appliedDirectionMultiplier` + `wasExploration` top-level on output, consolidate metadata into `metadata.direction`
7. `AutoSignalExecutor` propagates new fields into the `PaperPosition` object passed to `openPositionAtomically`
8. Env vars in `docker-compose.gcp.yml`
9. Audit of non-signal INSERT callers (`routes.ts` POST handlers, `PaperTradingService`, `scripts/start-paper-trading.js`); leave them using backward-compatible defaults (`null` / `false`)
10. Integration test: end-to-end signal flow with mocked RNG hitting exploration branch, and a breaker-trip scenario that falls back to global
