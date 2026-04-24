# Sub-project B.2: Signal-Generator Consensus

**Date:** 2026-04-25
**Parent:** [2026-04-24-scorer-overhaul-roadmap.md](./2026-04-24-scorer-overhaul-roadmap.md)
**Status:** Design — awaiting user approval before writing implementation plan.

## Problem statement

`WeightedAverageCombiner` combines N per-generator signals into a single `CombinedSignalOutput` using per-type weighted averaging plus confidence-weighted averaging. It does not currently penalize disagreement between generators. A combined signal with three generators LONG and two SHORT carries identical downstream weight as a unanimous 5-LONG signal if the averaged confidence is the same. Yet empirically and Bayesianly, unanimous signals should be more reliable than contested ones — the prior literature on ensemble methods (bagging, boosting, Bayesian model averaging) treats disagreement as a first-class source of uncertainty.

## Hypothesis

For signals with the same nominal combined confidence, **higher directional consensus predicts better PnL**. That is: a 5/0 split with `combinedConfidence=0.6` outperforms a 3/2 split with `combinedConfidence=0.6` on realized PnL.

The mechanism: disagreement reflects underlying ambiguity in the market state. When generators measuring different microstructural angles (momentum, mean-reversion, OFI, MLOFI, Hawkes) disagree, either the signal is noise or the state is genuinely uncertain — either way, the trade's EV is lower than the aggregate confidence number suggests.

## Non-goals

- Change the per-generator weights (`mean_reversion: 0.5`, `ofi: 0.5`, etc.). Those are optimized by the existing Optuna loop.
- Add a new optimizer for combiner parameters. The existing Optuna on Render already tunes signal-layer params; we extend its space.
- Instrument generators to emit richer metadata. `componentSignals` already carries everything needed.
- Modify `MarketScorer` or the scorer optimization path. Consensus is a per-trade signal-layer feature, not a market-level feature (per the B.2 decomposition decided in brainstorming).
- Persist `componentSignals` as a raw array in the database. Deferred to follow-up — not needed for Optuna training because backtests regenerate signals per trial (Path 1 verified during brainstorm).

## Architecture overview

```
┌──────────────────────────────────────────────────────────────────┐
│ SignalEngine (per market, every ~60s)                            │
│  runs generators → array of SignalOutput (with direction,        │
│  strength, confidence per generator)                             │
└─────────────────────┬────────────────────────────────────────────┘
                      │ componentSignals: SignalOutput[]
                      ▼
┌──────────────────────────────────────────────────────────────────┐
│ WeightedAverageCombiner.combine()                                │
│  1. existing: direction + strength + confidence via weighted avg │
│  2. NEW: compute consensus = 1 - H(longCount, shortCount)        │
│  3. NEW: finalConfidence = combinedConfidence * discount(cons)   │
│     where discount(c) = floor + (1-floor)*c                      │
│  4. existing: if finalConfidence < minCombinedConfidence → null  │
│  5. emit CombinedSignalOutput with consensus in metadata         │
└─────────────────────┬────────────────────────────────────────────┘
                      │ signal.metadata.consensus, componentCounts
                      ▼
┌──────────────────────────────────────────────────────────────────┐
│ AutoSignalExecutor — on position open                            │
│  reads signal.metadata.consensus + componentCounts               │
│  persists in paper_positions.score_dimensions_at_entry JSONB     │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│ Render — Optuna optimizer (weekly)                               │
│  OPTUNA_PARAM_SPACE gains consensusDiscountFloor ∈ [0.0, 1.0]    │
│  each trial → new BacktestRequest with consensusDiscountFloor   │
│  BacktestService → fresh WeightedAverageCombiner that uses floor │
│  Sharpe of backtest feeds Optuna objective → converges on optimum│
└──────────────────────────────────────────────────────────────────┘
```

## Design details

### 1. Consensus metric

Shannon-based normalized consensus on directional tallies, computed from `componentSignals`:

```typescript
function signalConsensus(signals: SignalOutput[]): {
  consensus: number | null;
  longCount: number;
  shortCount: number;
  neutralCount: number;
} {
  const longCount    = signals.filter(s => s.direction === 'LONG').length;
  const shortCount   = signals.filter(s => s.direction === 'SHORT').length;
  const neutralCount = signals.filter(s => s.direction === 'NEUTRAL').length;
  const N = longCount + shortCount; // NEUTRAL excluded — no directional vote

  if (N < 3) {
    return { consensus: null, longCount, shortCount, neutralCount };
  }

  const pL = longCount / N;
  const pS = shortCount / N;
  const H = -(pL > 0 ? pL * Math.log2(pL) : 0) - (pS > 0 ? pS * Math.log2(pS) : 0);
  // log base 2 → H ∈ [0, 1] for 2 categories (no further normalization needed)
  return {
    consensus: 1 - H, // 0 = 50/50 split, 1 = unanimous
    longCount, shortCount, neutralCount,
  };
}
```

Why Shannon entropy:
- Unique categorical uncertainty measure satisfying Shannon-Khinchin axioms (continuity, symmetry, maximality at uniform, aditivity under independence).
- Information-theoretic grounding makes it justifiable in code review and future literature review.
- Non-linear in agreement fraction — 5/0 is much more informative than 4/1, which is much more informative than 3/2. A linear fraction metric wouldn't capture this.

Why N<3 returns null: with N=1 or N=2, consensus is trivially 1 or binary. No useful signal.

### 2. Discount function

Linear floor-shifted:

```typescript
function consensusDiscount(consensus: number | null, floor: number): number {
  if (consensus === null) return 1.0; // no info → no discount
  return floor + (1 - floor) * consensus;
}
```

Properties:
- `floor = 1.0` → always returns 1.0, consensus has no effect.
- `floor = 0.5` (initial default) → 50/50 signal gets 0.5× confidence, unanimous gets 1.0×.
- `floor = 0.0` → consensus fully scales confidence (aggressive filtering).

Linear shape chosen for simplicity and interpretability. YAGNI on power/sigmoid variants until linear proves inadequate.

### 3. Combiner integration

Modify `WeightedAverageCombiner.combine()` at the point after computing `confidence` (existing) and before the `minCombinedConfidence` threshold check:

```typescript
// Compute consensus from the valid signals used
const { consensus, longCount, shortCount, neutralCount } = signalConsensus(
  usedSignals.map(s => s.signal)
);

// Apply discount
const floor = this.parameters.consensusDiscountFloor;
const discount = consensusDiscount(consensus, floor);
const finalConfidence = confidence * discount;

// Existing threshold check, now on finalConfidence
if (finalConfidence < params.minCombinedConfidence) {
  this.logger.info(
    { confidence, finalConfidence, consensus, longCount, shortCount, threshold: params.minCombinedConfidence },
    'Combined confidence (post-consensus-discount) below threshold'
  );
  return null;
}

// Emit
const combinedOutput: CombinedSignalOutput = {
  // ... existing fields ...
  confidence: finalConfidence, // post-discount
  metadata: {
    combinerType: 'weighted_average',
    signalCount: usedSignals.length,
    conflictResolution: params.conflictResolution,
    // NEW:
    consensus,
    consensusDiscount: discount,
    rawConfidence: confidence, // pre-discount, for forensics
    componentCounts: { long: longCount, short: shortCount, neutral: neutralCount },
  },
};
```

The existing `strength` calculation is unchanged — consensus only affects confidence, not strength.

### 4. Combiner parameters + schema

Extend `WeightedAverageParams`:
```typescript
interface WeightedAverageParams {
  // ... existing ...
  consensusDiscountFloor: number; // [0.0, 1.0]
}
```

Default in constructor: `0.5`. Env override: `CONSENSUS_DISCOUNT_FLOOR`.

DB persistence (so Optuna updates are visible at runtime): the `signal_weights` table already stores per-signal weights (`momentum`, `mean_reversion`, etc.) and the combiner loads them at startup. Extend:

```sql
ALTER TABLE signal_weights
  ADD COLUMN IF NOT EXISTS consensus_discount_floor FLOAT NOT NULL DEFAULT 0.5;
```

Combiner's weight-loading code reads this column and injects it into `parameters.consensusDiscountFloor`.

### 5. AutoSignalExecutor capture

At position open, extract from `signal.metadata` and persist into `score_dimensions_at_entry`:

```typescript
scoreDimensionsAtEntry = {
  tradeability: ...,
  liquidity: ...,
  ttr: ...,
  volatility: null,
  dataQuality: null,
  typeExpectedValue: typeEV,
  realizedVolatility,
  // NEW:
  signalConsensus: (signal.metadata as any)?.consensus ?? null,
  signalComponentLong: (signal.metadata as any)?.componentCounts?.long ?? null,
  signalComponentShort: (signal.metadata as any)?.componentCounts?.short ?? null,
  signalComponentNeutral: (signal.metadata as any)?.componentCounts?.neutral ?? null,
};
```

`signalConsensus` is nullable (mirrors combiner output). The raw counts preserve reanalysis flexibility.

Note: `signalConsensus` is **not** added to `ScoreDimensions` or `ScorerWeights` interfaces. It sits in the JSONB as an extra key, outside the typed dim set. `MarketScorer.compositeScore` does not see it. `ScorerWeightOptimizer` does not train on it. This is deliberate — consensus is a signal-layer feature, not a market-layer feature. Its optimization lives in the Render Optuna loop, not the weekly ScorerWeightOptimizer.

### 6. Optuna integration

On Render's optimizer service, extend `OPTUNA_PARAM_SPACE` to include:

```python
"consensusDiscountFloor": {"type": "float", "low": 0.0, "high": 1.0}
```

Each trial:
1. Optuna samples a `consensusDiscountFloor` value.
2. Constructs a `BacktestRequest` with `combinerConfig.consensusDiscountFloor` set.
3. Calls the VM's `BacktestService.runBacktest(request)` endpoint (existing pattern).
4. `BacktestService` creates a fresh `WeightedAverageCombiner` with the floor param — signals are replayed and filtered accordingly.
5. Sharpe of result → Optuna objective.

On trial completion, the Optuna service writes best params (including `consensusDiscountFloor`) back to `signal_weights` table. Combiner in production reloads params on next weekly cycle (or on explicit refresh).

### 7. Backtest compatibility

Verified during brainstorm: `BacktestService.runBacktest()` uses a fresh `WeightedAverageCombiner` instance per call, constructed from `request.combinerConfig`. Generators run from scratch on historical price bars via `this.createSignals(...)`, producing `componentSignals` in memory. No disk persistence of componentSignals is required.

Implementation checkpoint during plan: extend `request.combinerConfig` type to include `consensusDiscountFloor`, and propagate through `BacktestService` constructor → `WeightedAverageCombiner` parameters.

### 8. Nullable contract

`signalConsensus = null` when N<3 informative generators. Downstream behavior:
- Discount returns 1.0 (no-op) — signal passes or fails the existing `minCombinedConfidence` threshold identically to pre-B.2 behavior.
- `signal.metadata.consensus = null` is persisted as-is in JSONB.
- ScorerWeightOptimizer ignores the field (not in ScoreDimensions) — no training impact.
- SQL analysis queries use `IS NOT NULL` to filter out these trades from consensus-related correlations.

### 9. Logging and observability

Combiner logs at info level when a signal is filtered by the post-discount threshold, with raw + post fields:

```
{ confidence: 0.60, finalConfidence: 0.31, consensus: 0.03, longCount: 3, shortCount: 2, threshold: 0.43 }
'Combined confidence (post-consensus-discount) below threshold'
```

Signals passing the threshold also log consensus at debug level for trend monitoring.

`signal_predictions` table keeps its existing shape — the combiner's metadata JSONB fields (including `consensus`, `rawConfidence`, `componentCounts`) are already written via the existing `metadata` column path.

## Tests

### Unit tests

`WeightedAverageCombiner.test.ts`:
- `signalConsensus` helper function: null for N<3, correct values for (5,0), (4,1), (3,2) and the symmetric cases. Boundary at N=3.
- `consensusDiscount` helper: floor=1 gives 1.0 for any consensus; floor=0 gives exact consensus value; floor=0.5 gives expected values at consensus 0, 0.5, 1.
- Combiner `combine()`: signal with high consensus passes existing threshold; same signal with low consensus fails same threshold.
- Null consensus (N<3): discount=1.0, threshold unchanged from pre-B.2 behavior.

### Integration / backtest

Add one end-to-end test: `BacktestService` with `consensusDiscountFloor=0.5` should produce a strict subset of trades vs `consensusDiscountFloor=1.0` (same signals, stricter filter → fewer or equal executions).

### Manual post-deploy

1. Check `signal_weights` has `consensus_discount_floor` column with `0.5` default.
2. Trigger optimizer manually; confirm at least one trial with `consensusDiscountFloor != 0.5`.
3. SQL check: some `paper_positions.score_dimensions_at_entry` rows have non-null `signalConsensus` after first post-deploy trades.
4. SQL correlation after 50+ post-deploy trades:
   ```sql
   SELECT CORR(
     (score_dimensions_at_entry->>'signalConsensus')::numeric,
     realized_pnl
   ) AS consensus_pnl_pearson
   FROM paper_positions
   WHERE closed_at >= <deploy_date>
     AND (score_dimensions_at_entry->>'signalConsensus') IS NOT NULL
     AND realized_pnl IS NOT NULL;
   ```

## Success metrics

**Immediate (deploy validation)**:
- At least one signal gets filtered by the post-discount threshold within first hour.
- `consensus_discount_floor` column populated with 0.5 on all rows.

**2-week gate**:
- After one Optuna weekly retrain, the optimized `consensusDiscountFloor` differs from 0.5 by at least 0.05 AND the backtest Sharpe improved by at least 0.01 with the new value. This indicates Optuna found signal.
- If the optimized floor converges toward 1.0, consensus had no signal in backtest — document the null result, accept it, and consider reverting the combiner change in a follow-up cleanup.
- If the optimized floor converges toward 0.0 with strong Sharpe gain, consensus is a major signal. Consider adding shape optimization (power or sigmoid curve) in a follow-up.

**Operational**: trade count drops by 10-30% initially (signals that would have marginally passed the confidence threshold now fail post-discount). Acceptable if PnL-per-trade improves proportionally.

## Rollback

```sql
-- Set floor to 1.0 to disable consensus filtering
UPDATE signal_weights SET consensus_discount_floor = 1.0;
```

Combiner reloads params on next cycle (typically 1 hour). Production restored to pre-B.2 behavior. Captured data in `score_dimensions_at_entry` stays — no cleanup needed.

Full code revert is the deeper rollback. Schema column remains harmless.

## Out of scope (deferred follow-ups)

- **Persistence of raw componentSignals** to `signal_predictions.metadata` for forensics and alternative-metric reanalysis. Not blocking because backtests regenerate signals per trial (Path 1). Nice-to-have if we ever want to audit specific trades' generator outputs or try new consensus metrics on historical data.
- **Alternative consensus metrics** (β confidence-weighted, γ strength coherence). Start with Shannon-based; if it works, consider whether a different metric would work better. YAGNI now.
- **Shape variants** (power, sigmoid discount functions) if linear saturates at Optuna boundaries.
- **Per-type consensus discount floor** — different market types may warrant different floors. Single global param for now; add per-type later if evidence demands.
- **Consensus-based position sizing** (an alternative to confidence discounting). Current proposal filters via threshold; sizing would be a more graduated response. Revisit only if filtering proves too blunt.

## Open items for implementation plan

- Final value of default `consensusDiscountFloor`. Proposed 0.5. Confirm with a quick one-off backtest on historical data pre-deploy (sanity: does 0.5 drastically change trade count?). If yes, start at 0.7 conservative.
- How combiner loads `signal_weights.consensus_discount_floor`: the existing signal-weights-load path in combiner needs to pick up the new column. Confirm path during plan.
- Exact shape of OPTUNA_PARAM_SPACE JSON on the Render service — need to locate the config file and understand naming conventions.
- Whether `signalConsensus` in JSONB should be stored as the raw computed value (0 to 1) OR as something else. Proposed raw; future analysis can re-bucket.
- Schema migration placement: `signal_weights` ALTER at dashboard startup (same pattern as A/B.1).

## Relationship to prior work

B.2 reuses minimal infrastructure from A/B.1 — only the `score_dimensions_at_entry` JSONB persistence pattern. The optimizer path is fundamentally different (Optuna vs ScorerWeightOptimizer). No coupling to market-level scoring.

From the roadmap: B.2 was initially described as "requires SignalEngine instrumentation to expose per-generator outputs". This turned out to be unnecessary — `componentSignals` are already exposed in `CombinedSignalOutput`. Scope is lighter than originally anticipated.
