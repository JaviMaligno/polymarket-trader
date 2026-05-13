# Per-Direction Signal Weights — Design

**Date**: 2026-05-13
**Trigger**: Cost-aware P2 t-stat (2026-05-13) revealed directional asymmetry the current schema cannot express. Example: `mean_reversion crypto_intraday` has t_net=+6.44 SHORT vs t_net=−23.96 LONG. The combiner averages both into a single weight per (signal_type, market_type), washing out edge.

## Problem

`signal_weights` is keyed on `(signal_type, market_type)` — a single weight applies to BOTH the LONG and the SHORT output of a generator on a given market type. Real edge is direction-specific (asymmetric on most cells, sometimes opposite-signed). Without per-direction granularity:

1. Optuna cannot capture asymmetric edge in the weight space.
2. The combiner cannot favour the profitable direction of a generator without amplifying its anti-edge direction too.
3. Patches at the executor (`EXECUTOR_BLOCKED_TYPE_DIRECTIONS`) are coarse — they zero out the entire direction for a market_type rather than per-(signal, direction).
4. The only operationally-correct cells get diluted into noise (see e.g. `mean_reversion crypto_intraday SHORT` n=126 t_net=+6.44 — drowned by 4 other anti-edge SHORT generators in the combined signal).

## Goals

- Add per-direction granularity to `signal_weights` so Optuna optimises per (signal_type, market_type, direction).
- Migration: zero-downtime, backwards-compatible. Existing 55+ rows continue to work.
- Combiner: looks up exact (sig, type, dir) row, falls back to '__all__' direction.
- Optuna: trial space gains a third axis. Initial seed derived from the cost-aware t-stat (already measured).
- Operational kill-switch: `SIGNAL_DIRECTIONS_DISABLED` env gate (mirrors `SIGNAL_TYPES_DISABLED` from PR #210), default empty.

## Non-goals

- Per-direction `direction_multiplier` pseudo-row — `direction_multiplier` is itself a multiplier on the combined direction; adding a direction to it makes no semantic sense. Keep its rows at direction='__all__'.
- Per-direction `consensus_discount_floor` / `resolution_prior` config rows — they are global parameters, not generator outputs. Keep at '__all__'.
- Removing the executor blocklist (`EXECUTOR_BLOCKED_TYPE_DIRECTIONS`) — keep as belt-and-suspenders. Per-direction weights are the cleaner lever for fine control; the blocklist remains a hard structural override.

## Schema change

```sql
-- packages/data-collector/src/database/init/029_signal_weights_per_direction.sql
-- Idempotent ALTER (re-runs are no-ops). New rows default to direction='__all__' so
-- existing INSERTs without an explicit direction keep working.
ALTER TABLE signal_weights
  ADD COLUMN IF NOT EXISTS direction VARCHAR(8) NOT NULL DEFAULT '__all__'
  CHECK (direction IN ('__all__','long','short'));

ALTER TABLE signal_weights DROP CONSTRAINT IF EXISTS signal_weights_pkey_per_type;
ALTER TABLE signal_weights
  ADD CONSTRAINT signal_weights_pkey_per_direction
  PRIMARY KEY (signal_type, market_type, direction);

CREATE INDEX IF NOT EXISTS idx_signal_weights_lookup
  ON signal_weights (signal_type, market_type, direction)
  WHERE is_enabled = true;
```

**Boot path**: the init SQL runs only on fresh volume. Existing VM needs an idempotent ALTER at dashboard boot (same pattern as the existing `bootstrapDirectionMultiplier`). Add to `server.ts` init sequence right before the per-type bootstrap.

## Lookup semantics (combiner)

For a signal `s` on market_type `t` with output direction `d ∈ {long, short}`:

```typescript
weight = (
  SELECT weight FROM signal_weights
  WHERE signal_type = s AND market_type = t AND direction = d AND is_enabled = true
) ?? (
  SELECT weight FROM signal_weights
  WHERE signal_type = s AND market_type = t AND direction = '__all__' AND is_enabled = true
) ?? 0;
```

Fallback to '__all__' = backwards-compatible. New rows initially populated by the cost-aware seed (PR-D); until Optuna runs, every cell has a sensible initial value.

## `SIGNAL_DIRECTIONS_DISABLED` env gate

Identical mechanism to PR #210 (`SIGNAL_TYPES_DISABLED`). Comma-separated `signal_id:direction` tokens. Combiner skips any signal whose `signalId:direction` (uppercase) is in the set. Cost: ~30 LOC + 1 test. Default: empty (no-op).

Use case: emergency operational override when the schema-driven weights drift or when we want to canary-disable a specific cell pre-optimization.

## Migration strategy (zero-downtime)

1. **PR-A (schema, additive only)**: ALTER TABLE adds the column with default '__all__'. PK swap is atomic in Postgres. All existing rows valid. All existing INSERT/UPSERT statements keep working (omitted column defaults to '__all__').

2. **PR-B (combiner + env gate)**: combiner reads per-direction with fallback. New env var. No new rows yet — fallback handles everything.

3. **PR-C (optimizer)**: Optuna trial space gains direction axis. Writes per-direction rows (LONG and SHORT separately) instead of '__all__'. Existing '__all__' rows untouched but progressively shadowed by per-direction rows.

4. **PR-D (seed)**: SQL script seeds per-direction rows from current `__all__` rows × the cost-aware t-stat measured today. Scaling: `weight_dir = base_weight × max(0, 0.5 + 0.05 × t_net_dir)` clamped to [0, 2]. So strongly negative t_net rows seed near 0; strong positive seed near base. After Optuna runs, the seed gets refined.

5. **PR-E (deprecation)**: once per-direction rows fully cover the active universe, change combiner default behaviour to ignore '__all__' rows (or keep them only for config/pseudo signals). Optional, can defer.

## Affected files (from inventory)

### Schema (1)
- `packages/data-collector/src/database/init/029_signal_weights_per_direction.sql` (new)

### Boot ALTER for existing VM (1)
- `packages/dashboard/src/server.ts` — add ALTER block before line 356

### Repo layer (1)
- `packages/dashboard/src/database/repositories.ts:240-330` — `signalWeightsRepo.{get,getAll,getAllPerType,getPerType,update,updatePerType}` gain `direction` parameter, default '__all__'. Lookup falls back to '__all__'.

### Combiner (2)
- `packages/signals/src/combiners/WeightedAverageCombiner.ts` — `getSignalWeight()` per-direction lookup; new `disabledSignalDirections: Set<string>` param.
- `packages/dashboard/src/services/SignalEngine.ts:200-260` — sync per-direction weights to combiner. Parse `SIGNAL_DIRECTIONS_DISABLED` env.

### Optimizer (2)
- `packages/dashboard/src/services/OptimizationScheduler.ts:1240-1280` — per-direction loop in `updateStrategy()`.
- `packages/optimizer/*` (Render service) — Optuna study param space gains direction. Schema in Neon DB unaffected (trial storage).

### API routes (1)
- `packages/dashboard/src/api/routes.ts:1822-1829` (POST `/api/signals/weights`) — accept optional `direction` field, default '__all__'.

### Seed script (1)
- `scripts/seed-per-direction-weights.sql` (new) — backfills per-direction rows from t-stat.

### Tests (estimated +6 files)
- `WeightedAverageCombiner.perDirection.test.ts` (new)
- `bootstrapDirectionMultiplier.test.ts` — verify dm stays at direction='__all__'
- `repositories.test.ts` — verify per-direction lookup with fallback
- `SignalEngine.test.ts` — verify per-direction sync
- `OptimizationScheduler.test.ts` — verify per-direction updates respect min-lift per direction
- `signal_weights_per_direction.migration.test.ts` (new)

### Untouched
- `direction_multiplier` rows: stay direction='__all__'.
- `consensus_discount_floor` / `resolution_prior` config rows: stay '__all__'.
- `SignalLearningService` updates global rows only — no change needed.
- Daily-review / monitoring scripts: still read by signal_type; add direction column to output later.

## Risks

- **PK swap**: atomic in Postgres but locks the table briefly (~1s on 50 rows). Acceptable.
- **Combiner regression**: fallback semantics must be correct; if buggy, weight becomes 0 → no trades. PR-B includes integration test that verifies fallback behaviour with a row at '__all__'.
- **Optuna convergence time**: doubles param space (LONG, SHORT separately). One full cycle (~6h) before per-direction edges crystallize. The seed in PR-D mitigates by starting from a cost-aware prior.
- **Stale '__all__' rows**: after PR-C starts writing per-direction, '__all__' rows from before become outdated. The lookup priority (direction-first, fallback) handles this correctly — but PR-E is the eventual cleanup.

## Pre-requisite to PR-D: measure round-trip cost per market_type

A single 0.5% prior is arbitrary. Before seeding per-direction weights, measure actual round-trip cost from `paper_trades` per `market_type` (fee + observed slippage). Use the measured value as the `rtcost` input to the seed formula, per market_type. This becomes part of PR-D's commit (data + measurement script).

## Out-of-scope (deferred)

- `event_financial:long` blocklist re-evaluation. Held until per-direction weights land + 2 Optuna cycles. The Optimizer should downweight the anti-edge LONG generators (momentum, ofi, etc.) on event_financial first, then we re-measure live WR.
- PR-E (deprecation of '__all__' code path) runs at the end of the series, after C and D land and stabilize.

## Validation checklist (post-deploy)

- [ ] Migration applies idempotently on existing DB.
- [ ] All 55+ existing rows survive ALTER with direction='__all__'.
- [ ] Combiner fallback verified by integration test (row exists for '__all__' but not for direction='long' → reads '__all__').
- [ ] Optuna writes per-direction rows after one cycle.
- [ ] `mean_reversion crypto_intraday SHORT` weight diverges from `LONG` weight after 1-2 cycles.
- [ ] Live SHORT trades emerge (target: ≥1 in 72h post-deploy).
- [ ] Live event_financial LONG WR improves (current 26.3% → target ≥40% over n≥30).

## Acceptance

Plan signed off by the project owner. PRs land one at a time with checkpoints; CI must be green and the next PR doesn't open until the previous is on the VM.
