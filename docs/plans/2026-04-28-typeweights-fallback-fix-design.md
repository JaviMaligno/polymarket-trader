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

After the combiner's `normalize: true` pass, this 1.0 fallback is much higher than the deliberately set per-type weights. Concrete example for event_financial:

```
typeWeights["event_financial"] explicit:
  momentum:        -0.3
  mean_reversion:   0.6
  ofi:              0.4
  mlofi:            0.4
  hawkes:           0.3

If a 6th generator (e.g. news_sentiment) fires:
  Total before normalize:  -0.3 + 0.6 + 0.4 + 0.4 + 0.3 + 1.0 (fallback) = 2.4
  Normalized share of mean_reversion:    0.6 / 2.4 = 0.25
  Normalized share of fallback news:     1.0 / 2.4 = 0.42
```

The unlisted (fallback) generator dominates mean_reversion in the combine output — the opposite of the design intent.

This is a defect, not a design choice. The author of `DEFAULT_TYPE_WEIGHTS` intended "these are the generators that apply for this type"; the fallback subverts that intent.

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

Single-line code change in `packages/signals/src/combiners/WeightedAverageCombiner.ts`:

**Before** (line 452):
```ts
let weight = weightSource[signal.signalId] ?? 1;
```

**After**:
```ts
let weight = weightSource[signal.signalId] ?? 0;
```

No schema changes. No new tables. No changes to any other file. No changes to env vars or docker-compose. No changes to scripts or daily-review.

The behavior change is **localized and predictable**: a generator with no entry in the type-specific weights table contributes 0 to combined output for that market type. With `normalize: true`, the normalization total decreases by the count of fallback generators × 1.0, raising the relative share of the explicitly-listed generators.

## Components

### `packages/signals/src/combiners/WeightedAverageCombiner.ts`

One character changed (literal `1` → `0`) on line 452. Comment update one line above to document the rationale:

**Before**:
```ts
let weight = weightSource[signal.signalId] ?? 1;
```

**After**:
```ts
// Default 0: a generator not listed in DEFAULT_TYPE_WEIGHTS for this market_type
// does not contribute. Previous default of 1 caused unlisted generators to dominate
// the explicitly-listed per-type weights via the normalization pass.
let weight = weightSource[signal.signalId] ?? 0;
```

### `packages/signals/src/combiners/WeightedAverageCombiner.test.ts` (or equivalent test file location for this package)

Two new tests:

1. **"unlisted generator gets weight 0 with known market_type"** — passes a marketType (e.g. `event_financial`) and a signal whose `signalId` is not in `DEFAULT_TYPE_WEIGHTS["event_financial"]`. Asserts the resulting `getSignalWeight` (or its observable effect via `combine`) treats that signal as if absent (weight 0 → contributes 0 strength even at signal strength 1.0).

2. **"listed generator unaffected by the fallback change"** — confirms a signal whose `signalId` IS in `DEFAULT_TYPE_WEIGHTS["event_financial"]` (e.g. `mean_reversion`) gets the listed weight (0.6) as before.

`getSignalWeight` is private, so tests use the public `combine()` to assert behavior indirectly. A signal whose generator is not in the type's table should contribute 0 to combined strength regardless of its individual signal strength.

## Data Flow — What Changes At Runtime

**Before fix** (event_financial example, hypothetically all 11 generators emit signals):
- Five listed contributions: -0.3 + 0.6 + 0.4 + 0.4 + 0.3 = 1.4
- Six unlisted contributions (fallback): 6 × 1.0 = 6.0
- Total for normalization: 7.4
- mean_reversion's normalized share: 0.6 / 7.4 = 0.081
- Each unlisted generator's normalized share: 1.0 / 7.4 = 0.135
- → unlisted generators each have ~1.7× the influence of the deliberately-listed mean_reversion.
- In practice, only the generators that actually fire on a given tick contribute. But any tick where at least one unlisted generator fires, that fallback dilutes the listed weights significantly.

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
