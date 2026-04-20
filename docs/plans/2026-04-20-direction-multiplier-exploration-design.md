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

**Circuit breaker logic (`isBreakerTripped`):**

```sql
SELECT COUNT(*) AS explore_count,
       COALESCE(SUM(realized_pnl), 0) AS explore_pnl
FROM paper_positions
WHERE was_exploration = true
  AND closed_at >= NOW() - INTERVAL '7 days'
  AND realized_pnl IS NOT NULL;
```

Tripped iff `explore_count >= breakerMinTrades AND explore_pnl < breakerMaxCumLoss`. Result cached for `breakerCacheTtlMs` (default 5 min) to avoid per-signal queries. On trip, emits event `direction_exploration:breaker_tripped` and writes a note to `trading_config` key `direction_exploration_status`.

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

No other learner logic changes. Promotion thresholds (`minSegmentTrades=24`, `minCandidateTrades=8`, `minImprovementPerTrade=0.75`, `minWinRateLift=0.08`) unchanged — we do **not** relax promotion criteria.

### 3. `SignalEngine` (modify)

Location: `packages/dashboard/src/services/SignalEngine.ts`

- Inject `DirectionResolver` via constructor.
- Replace existing direct call to `resolveDirectionMultiplier` with `directionResolver.resolve(context)`.
- After `combiner.combine()` returns, enrich the output:

```ts
return {
  ...combined,
  wasExploration: resolution.wasExploration,
  metadata: {
    ...combined.metadata,
    direction: {
      segmentId: resolution.segmentId,
      reason: resolution.reason,
    },
  },
};
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

- On position open, pass two new fields to repo:
```ts
await paperPositionsRepo.open({
  // ... existing
  appliedDirectionMultiplier: signal.appliedDirectionMultiplier,
  wasExploration: signal.wasExploration ?? false,
});
```

### 6. `paperPositionsRepo.open()` (modify)

Location: `packages/dashboard/src/repos/paperPositionsRepo.ts` (or equivalent).

- Extend parameter type with two new fields (both optional in the signature for manual-script callers; defaults `NULL` and `false`).
- Extend the INSERT SQL:
```sql
INSERT INTO paper_positions (
  ..., applied_direction_multiplier, was_exploration
) VALUES (..., $N, $N+1)
```

### 7. DB migration (startup DDL)

Location: `packages/dashboard/src/server.ts` — alongside existing `trading_config` CREATE TABLE IF NOT EXISTS block.

```sql
ALTER TABLE paper_positions
  ADD COLUMN IF NOT EXISTS applied_direction_multiplier NUMERIC(5,3),
  ADD COLUMN IF NOT EXISTS was_exploration BOOLEAN NOT NULL DEFAULT false;
```

- `applied_direction_multiplier`: NULLABLE (pre-migration rows remain NULL — distinguishes "unknown legacy" from explicit `0`).
- `was_exploration`: NOT NULL DEFAULT false (semantic default for all historical rows and non-signal inserts).

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
1. DB migration DDL in `server.ts` startup
2. `DirectionResolver` module + unit tests (deterministic RNG, mocked repo)
3. `DirectionMultiplierLearningService` config + bucket updates (with test coverage for new buckets)
4. `WeightedAverageCombiner` output extension (typed field + tests)
5. `SignalEngine` integration (wire resolver, enrich output)
6. `AutoSignalExecutor` + `paperPositionsRepo.open()` param propagation
7. Env vars in `docker-compose.gcp.yml`
8. Integration test: end-to-end signal flow with mocked RNG hitting exploration branch
