# Type-Weights Fallback Bug Fix — Design

**Date**: 2026-04-28
**Status**: Design (pending implementation plan)
**Related**: `project_optuna_runtime_bypass.md`, `project_optimizer_extreme_weights.md`, `project_post_drought_loss_pattern.md`

## Problem

`WeightedAverageCombiner.getSignalWeight()` (line 446-462 in `packages/signals/src/combiners/WeightedAverageCombiner.ts`) selects a per-type weight source when a known market_type is provided:

```ts
const weightSource = (marketType && this.typeWeights[marketType])
  ? this.typeWeights[marketType]
  : this.weights;

let weight = weightSource[signal.signalId] ?? 1;
```

`DEFAULT_TYPE_WEIGHTS` (lines 97-104) lists explicit weights for **5 generators** per type: momentum, mean_reversion, ofi, mlofi, hawkes. The system has **11 generators total** — the other 6 (volume_anomaly, spread_compression, cross_market_corr, price_divergence, attention_spike, news_sentiment) are not listed in any per-type entry.

When any of those 6 unlisted generators emits a signal for a known market_type, the lookup `weightSource[signal.signalId]` returns `undefined`, the `?? 1` fallback applies, and that generator gets **weight 1.0** — higher than every weight in DEFAULT_TYPE_WEIGHTS (whose values range -0.4 to 0.6).

The normalize pass in `getSignalWeight` (lines 455-460) divides each signal's weight by `totalWeight = Object.values(weightSource).reduce((a, b) => a + b, 0)`. The total iterates only over the explicit keys of `weightSource` — the fallback values are NOT included in the total. Concrete example for event_financial:

```
typeWeights["event_financial"] explicit:
  momentum:        -0.3
  mean_reversion:   0.6
  ofi:              0.4
  mlofi:            0.4
  hawkes:           0.3

totalWeight = -0.3 + 0.6 + 0.4 + 0.4 + 0.3 = 1.4

If a 6th generator (e.g. news_sentiment) fires:
  weightSource[news_sentiment] = undefined → fallback 1.0 → normalized: 1.0 / 1.4 = 0.714
  weightSource[mean_reversion] = 0.6        → normalized: 0.6 / 1.4 = 0.428
```

The unlisted (fallback) generator gets normalized weight 0.714 vs mean_reversion's 0.428 — the unlisted has **1.67× the influence** of the deliberately-listed mean_reversion. The opposite of the design intent.

This is a defect in the typeWeights branch, not a design choice. The author of `DEFAULT_TYPE_WEIGHTS` intended "these are the generators that apply for this type"; the fallback subverts that intent.

## Why this matters now

The 2026-04-27/28 trading sessions produced 16 event_financial trades with 12.5% win rate. Same-market churn observed in 6 of 12 markets. Investigation of the signal stack revealed:
- Optuna's optimization output (`this.weights`) is bypassed at runtime for known market types (per-type lookup wins).
- The per-type weights that DO apply have the fallback bug, allowing 6 unlisted generators to dominate the deliberately-set per-type weights.

Fixing the fallback is the smallest defensible change to remove the dominant noise source. It is **strictly a bug fix**, not a strategy change — it honors the original design intent of `DEFAULT_TYPE_WEIGHTS`.

## Goal

Change the fallback in `getSignalWeight()` from `?? 1` to `?? 0`. After the change, generators not listed in a market_type's `DEFAULT_TYPE_WEIGHTS` entry contribute zero to that market's combined signal.

This is a **strict reduction of noise**: the per-type weights as written by the original author become the actual weights at runtime, no spurious dominance.

This is **not** a fix for the bigger architectural gap (Optuna→typeWeights bypass) — that's tracked separately in `project_optuna_runtime_bypass.md` and addressed by a future Step 2 (per-type Optuna optimization).

## Architecture

Surgical edit in `packages/signals/src/combiners/WeightedAverageCombiner.ts`. Split the single fallback into two branch-specific defaults that preserve the design intent of each path:

**Before** (lines 446-452):
```ts
private getSignalWeight(signal: SignalOutput, now: Date, marketType?: string): number {
  // Use type-specific weights if market type is known
  const weightSource = (marketType && this.typeWeights[marketType])
    ? this.typeWeights[marketType]
    : this.weights;

  let weight = weightSource[signal.signalId] ?? 1;
  ...
}
```

**After**:
```ts
private getSignalWeight(signal: SignalOutput, now: Date, marketType?: string): number {
  // Per-type weights are explicit allowlists — generators not listed for this
  // market_type intentionally do not contribute. Default 0 honors that intent
  // (previous default of 1 caused unlisted generators to dominate via normalize).
  // The legacy this.weights branch keeps default 1 for backward compatibility
  // with markets that have no type-specific entry.
  let weight: number;
  if (marketType && this.typeWeights[marketType]) {
    weight = this.typeWeights[marketType][signal.signalId] ?? 0;
  } else {
    weight = this.weights[signal.signalId] ?? 1;
  }
  ...
}
```

The remaining body of `getSignalWeight` (the normalize pass and return) stays unchanged.

**Why surgical, not unconditional**: the two branches encode different design intents. The per-type branch is an explicit allowlist; absence means "not applicable". The legacy branch (`this.weights`) is loaded from `signal_weights` table and used for markets without a known type — its design is "register all generators with default 1, optimizer overrides". Changing the legacy fallback could break behavior for markets that fall through to that path. The fix only addresses the per-type branch where the bug is.

No schema changes. No new tables. No changes to any other file. No changes to env vars, docker-compose, scripts, or daily-review.

## Components

### `packages/signals/src/combiners/WeightedAverageCombiner.ts`

Replace the single-fallback line with the two-branch structure shown in Architecture above. Roughly 4 lines added in place of 4-5 lines (depending on intermediate `weightSource` declaration). Add the comment block explaining the rationale.

The variable `weightSource` becomes redundant after the refactor and can be removed; alternatively keep it for symmetry with the existing tests that may reference it. Implementer judgment.

### `packages/signals/src/combiners/WeightedAverageCombiner.test.ts`

Two new tests:

1. **"unlisted generator gets weight 0 with known market_type"** — passes a marketType (e.g. `event_financial`) and a signal whose `signalId` is not in `DEFAULT_TYPE_WEIGHTS["event_financial"]`. Asserts the resulting `getSignalWeight` (or its observable effect via `combine`) treats that signal as if absent (weight 0 → contributes 0 strength even at signal strength 1.0).

2. **"listed generator unaffected by the fallback change"** — confirms a signal whose `signalId` IS in `DEFAULT_TYPE_WEIGHTS["event_financial"]` (e.g. `mean_reversion`) gets the listed weight (0.6) as before.

`getSignalWeight` is private, so tests use the public `combine()` to assert behavior indirectly. A signal whose generator is not in the type's table should contribute 0 to combined strength regardless of its individual signal strength.

## Data Flow — What Changes At Runtime

**Before fix** (event_financial, normalize=true):
- `totalWeight = sum of explicit typeWeights["event_financial"] values = -0.3 + 0.6 + 0.4 + 0.4 + 0.3 = 1.4`
- Listed signal that fires (e.g. mean_reversion): `weight = 0.6 / 1.4 = 0.428`
- Unlisted signal that fires (e.g. news_sentiment, fallback=1.0): `weight = 1.0 / 1.4 = 0.714`
- → Each unlisted generator has 1.67× the normalized weight of the explicitly-listed mean_reversion.
- The combiner's downstream filter `s.weight !== 0` keeps these unlisted contributions; they participate in the conflict resolution and final strength calculation.

**After fix** (?? 0 in per-type branch only):
- `totalWeight` unchanged: 1.4
- Listed signal: `weight = 0.428` (unchanged)
- Unlisted signal: `weight = 0 / 1.4 = 0` → caught by the existing `s.weight !== 0` filter (line 211) and dropped before conflict resolution.
- Net effect: only the 5 listed generators contribute to the combined signal for event_financial. Their relative shares are exactly what the per-type table specifies. No spurious dominance.

**After fix**:
- If generator emits and is listed → normalized weight = listed_weight / sum_of_listed.
- If generator emits and is NOT listed → contributes 0; ignored.
- The "total" is now just the sum of listed weights.

Concrete impact: for event_financial trades where only listed generators (momentum, mean_reversion, ofi, mlofi, hawkes) emit signals, no behavior change. For trades where 1+ unlisted generators emit, those unlisted are silenced and the listed ones get their full design-intent weights.

## Migration / Deploy

No migration. No data backfill. The fix takes effect immediately on container restart.

Open positions at deploy time: unaffected. Closes go through PositionClosingService unchanged.

Rollback: revert the 1-line commit. Or set the value back to `?? 1`. Schema unaffected.

## Out of Scope

Explicit non-goals:

- **Updating values in DEFAULT_TYPE_WEIGHTS**. Picking new specific values per (type, generator) is arbitrary tuning and "for that we have the optimizer". Step 1 only fixes the fallback bug; the existing per-type values stay as authored.
- **Wiring `setTypeWeights()` to Optuna** (Step 2, deferred). Requires schema redesign of `signal_weights` and OptimizationScheduler refactor. Separate brainstorm.
- **Vol-gate** (Option A, on hold per `feat/vol-gate` branch). Re-evaluate after Step 1's effect is observed.
- **Expanding Optuna parameter space to include all 11 generators**. Tied to Step 2 because per-type optimization needs schema first.

## Error Handling

No new error paths. The change is a value substitution in an existing fallback chain. The fallback was always reachable (and continues to be).

## Testing

- Unit (vitest, in the signals package's combiner test file):
  - Two new tests as listed above.
  - All preexisting `WeightedAverageCombiner` tests pass without modification — the fix is strictly a refinement.

- Type check: `pnpm exec tsc --noEmit` in signals package.

- Integration smoke (post-deploy on VM):
  - Confirm next trade cycle: combiner logs continue to show "Combined signal generated" with strength/confidence numbers in expected ranges. No syntax error fallout.
  - Compare normalized contributions in the combiner debug log if available, or just observe trade behavior.

## Success Criteria

After 24h of post-fix live trading, expect:

- Trades on event_financial produce results consistent with the EXPLICIT per-type weights (momentum -0.3, mean_reversion 0.6, ofi 0.4, mlofi 0.4, hawkes 0.3) rather than dominated by 6 unlisted generators at fallback 1.0.
- If event_financial win rate stays low (~12.5%) after the fix: the explicit per-type weights are themselves wrong, not just the fallback. → Push toward Step 2 (Optuna per-type).
- If event_financial win rate improves (>25%): fallback dominance was the problem. → Step 2 still recommended for completeness, but less urgent.
- If event_financial trade COUNT drops drastically (because fewer unlisted generators emit signals strong enough on their own to push combined output past threshold): also informative — shows the unlisted generators were the source of false-positive signals.

The fix can be evaluated empirically within 24-48h. No need to wait longer.

## Open Questions

None at design time. The fix is mechanical and localized.
