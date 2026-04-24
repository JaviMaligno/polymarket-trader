# Signal-Generator Consensus (Sub-project B.2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Penalize signals with low directional agreement among generators via a post-discount on combined confidence, optimizable via the existing Render Optuna loop.

**Architecture:** `WeightedAverageCombiner` computes Shannon-entropy-based consensus on `componentSignals` directional tallies, multiplies combined confidence by `discount(consensus) = floor + (1-floor)*consensus` before the existing `minCombinedConfidence` threshold. Floor is an optimizable parameter persisted in `signal_weights.consensus_discount_floor` and tuned by Optuna. `AutoSignalExecutor` captures consensus + raw component counts at position open into `score_dimensions_at_entry` JSONB for correlation analysis. No changes to `MarketScorer` or `ScorerWeightOptimizer` — this lives entirely in the signal layer.

**Tech Stack:** TypeScript, vitest, PostgreSQL (TimescaleDB), node-cron, Optuna (out-of-repo, on Render — separate follow-up).

**Spec:** `docs/plans/2026-04-25-signal-consensus-design.md`
**Roadmap:** `docs/plans/2026-04-24-scorer-overhaul-roadmap.md`

---

## File Structure

**Modified:**
- `packages/signals/src/combiners/WeightedAverageCombiner.ts` — add `signalConsensus` + `consensusDiscount` module-level helpers, extend `WeightedAverageParams` with `consensusDiscountFloor`, integrate into `combine()`.
- `packages/signals/src/combiners/WeightedAverageCombiner.test.ts` — unit tests.
- `packages/dashboard/src/services/AutoSignalExecutor.ts` — read `signal.metadata.consensus` and `metadata.componentCounts` at position open; persist in `score_dimensions_at_entry`.
- `packages/dashboard/src/server.ts` — idempotent `ALTER TABLE signal_weights ADD COLUMN consensus_discount_floor FLOAT NOT NULL DEFAULT 0.5` at startup.
- `packages/dashboard/src/services/BacktestService.ts` — propagate `consensusDiscountFloor` through `combinerConfig` to the new `WeightedAverageCombiner` instance per trial.
- Wherever the production signal-weights loader lives — add a read of the new column and pass to combiner params. The location is discovered in Task 4.

**Created:**
- `packages/data-collector/src/database/init/023_signal_consensus_discount_floor.sql` — init SQL for fresh DB installs.

**Out of scope (documented as follow-up):**
- Render-side `OPTUNA_PARAM_SPACE` extension and write-back verification. Tracked as a separate issue (Task 8 notes the handoff).
- Persistence of raw `componentSignals` in `signal_predictions.metadata`. Deferred per spec's "Out of scope" section.

---

## Task 1: Pure helpers — `signalConsensus` + `consensusDiscount`

**Files:**
- Modify: `packages/signals/src/combiners/WeightedAverageCombiner.ts` (add module-level helpers above the class).
- Test: `packages/signals/src/combiners/WeightedAverageCombiner.test.ts`.

- [ ] **Step 1: Write failing tests**

Add to `WeightedAverageCombiner.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { signalConsensus, consensusDiscount } from './WeightedAverageCombiner.js';
import type { SignalOutput } from '../core/types/signal.types.js';

function mkSignal(direction: 'LONG' | 'SHORT' | 'NEUTRAL'): SignalOutput {
  return {
    signalId: 'x',
    marketId: 'm',
    tokenId: 't',
    direction,
    strength: 0.5,
    confidence: 0.5,
    timestamp: Date.now(),
    ttlMs: 60_000,
  } as SignalOutput;
}

describe('signalConsensus', () => {
  it('returns null when N<3 informative signals', () => {
    expect(signalConsensus([mkSignal('LONG')]).consensus).toBeNull();
    expect(signalConsensus([mkSignal('LONG'), mkSignal('SHORT')]).consensus).toBeNull();
    expect(signalConsensus([mkSignal('LONG'), mkSignal('NEUTRAL'), mkSignal('NEUTRAL')]).consensus).toBeNull();
  });

  it('returns 1.0 for unanimous (5,0) LONG', () => {
    const sigs = Array.from({ length: 5 }, () => mkSignal('LONG'));
    expect(signalConsensus(sigs).consensus).toBeCloseTo(1.0, 5);
  });

  it('returns 1.0 for unanimous (0,5) SHORT', () => {
    const sigs = Array.from({ length: 5 }, () => mkSignal('SHORT'));
    expect(signalConsensus(sigs).consensus).toBeCloseTo(1.0, 5);
  });

  it('returns ~0.278 for 4/1 split', () => {
    // p=0.8: H = -0.8*log2(0.8) - 0.2*log2(0.2) = 0.7219
    // consensus = 1 - 0.7219 = 0.2781
    const sigs = [
      mkSignal('LONG'), mkSignal('LONG'), mkSignal('LONG'), mkSignal('LONG'),
      mkSignal('SHORT'),
    ];
    expect(signalConsensus(sigs).consensus).toBeCloseTo(0.2781, 3);
  });

  it('returns ~0.029 for 3/2 split', () => {
    // p=0.6: H = -0.6*log2(0.6) - 0.4*log2(0.4) = 0.9710
    // consensus = 1 - 0.9710 = 0.0290
    const sigs = [
      mkSignal('LONG'), mkSignal('LONG'), mkSignal('LONG'),
      mkSignal('SHORT'), mkSignal('SHORT'),
    ];
    expect(signalConsensus(sigs).consensus).toBeCloseTo(0.0290, 3);
  });

  it('returns correct raw counts including NEUTRAL', () => {
    const sigs = [
      mkSignal('LONG'), mkSignal('LONG'),
      mkSignal('SHORT'),
      mkSignal('NEUTRAL'), mkSignal('NEUTRAL'),
    ];
    const r = signalConsensus(sigs);
    expect(r.longCount).toBe(2);
    expect(r.shortCount).toBe(1);
    expect(r.neutralCount).toBe(2);
    // N_informative = 3, p=2/3, H ≈ 0.918, consensus ≈ 0.082
    expect(r.consensus).toBeCloseTo(0.0817, 3);
  });
});

describe('consensusDiscount', () => {
  it('returns 1.0 when consensus is null (no-op)', () => {
    expect(consensusDiscount(null, 0.5)).toBe(1.0);
    expect(consensusDiscount(null, 0.0)).toBe(1.0);
    expect(consensusDiscount(null, 1.0)).toBe(1.0);
  });

  it('returns consensus when floor is 0 (aggressive)', () => {
    expect(consensusDiscount(0.5, 0)).toBeCloseTo(0.5, 5);
    expect(consensusDiscount(1.0, 0)).toBeCloseTo(1.0, 5);
    expect(consensusDiscount(0.0, 0)).toBeCloseTo(0.0, 5);
  });

  it('returns 1.0 when floor is 1 (no-op)', () => {
    expect(consensusDiscount(0.5, 1)).toBeCloseTo(1.0, 5);
    expect(consensusDiscount(0.0, 1)).toBeCloseTo(1.0, 5);
  });

  it('linear mapping at floor=0.5', () => {
    // discount = 0.5 + 0.5*consensus
    expect(consensusDiscount(0.0, 0.5)).toBeCloseTo(0.5, 5);
    expect(consensusDiscount(0.5, 0.5)).toBeCloseTo(0.75, 5);
    expect(consensusDiscount(1.0, 0.5)).toBeCloseTo(1.0, 5);
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

Run from repo root:
```bash
cd /c/Users/Usuario/GitHub/polymarket-trader
npx vitest run packages/signals/src/combiners/WeightedAverageCombiner.test.ts --reporter=verbose 2>&1 | tail -30
```
Expected: new tests FAIL with `signalConsensus is not exported` / `consensusDiscount is not exported`.

- [ ] **Step 3: Implement helpers**

In `WeightedAverageCombiner.ts`, add BEFORE the `export class WeightedAverageCombiner` declaration:

```typescript
/**
 * Compute Shannon-entropy-based consensus on directional tallies.
 * Returns null if fewer than 3 informative (non-NEUTRAL) signals — not enough
 * granularity. NEUTRAL signals are excluded from the tally.
 * Formula: consensus = 1 - H(p_long, p_short) where H is Shannon entropy in
 * log base 2 (so H ∈ [0,1] naturally for 2 categories).
 *   - Unanimous (5,0) → consensus = 1.0
 *   - Balanced (3,2)  → consensus ≈ 0.029
 *   - Balanced (2,3)  → consensus ≈ 0.029 (symmetric)
 */
export function signalConsensus(signals: SignalOutput[]): {
  consensus: number | null;
  longCount: number;
  shortCount: number;
  neutralCount: number;
} {
  let longCount = 0;
  let shortCount = 0;
  let neutralCount = 0;
  for (const s of signals) {
    if (s.direction === 'LONG') longCount++;
    else if (s.direction === 'SHORT') shortCount++;
    else if (s.direction === 'NEUTRAL') neutralCount++;
  }
  const N = longCount + shortCount;
  if (N < 3) {
    return { consensus: null, longCount, shortCount, neutralCount };
  }
  const pL = longCount / N;
  const pS = shortCount / N;
  const H = -(pL > 0 ? pL * Math.log2(pL) : 0) - (pS > 0 ? pS * Math.log2(pS) : 0);
  return {
    consensus: 1 - H,
    longCount,
    shortCount,
    neutralCount,
  };
}

/**
 * Linear floor-shifted discount: discount(c) = floor + (1-floor) * c.
 * Returns 1.0 when consensus is null (no-op — matches pre-B.2 behavior).
 * - floor=1.0 → always 1.0 (consensus has no effect)
 * - floor=0.5 → 50/50 signal gets 0.5×, unanimous 1.0× (initial default)
 * - floor=0.0 → consensus fully scales confidence (aggressive filtering)
 */
export function consensusDiscount(
  consensus: number | null,
  floor: number,
): number {
  if (consensus === null) return 1.0;
  return floor + (1 - floor) * consensus;
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run packages/signals/src/combiners/WeightedAverageCombiner.test.ts --reporter=verbose 2>&1 | tail -25`
Expected: all helper tests PASS. Pre-existing combiner tests still pass (we only added new top-level exports, no behavior change).

Also run: `npx tsc -p packages/signals --noEmit 2>&1 | tail -10`
Expected: no new TS errors.

- [ ] **Step 5: Commit**

```bash
git add packages/signals/src/combiners/WeightedAverageCombiner.ts packages/signals/src/combiners/WeightedAverageCombiner.test.ts
git commit -m "feat(combiner): Shannon-based signalConsensus + consensusDiscount helpers

Pure module-level helpers added. signalConsensus returns nullable
consensus in [0,1] from componentSignals directional tallies
(NEUTRAL excluded, null when N<3 informative signals).
consensusDiscount returns 1.0 (no-op) when consensus is null, else
linear floor-shifted discount = floor + (1-floor)*consensus."
```

---

## Task 2: Schema migration — `signal_weights.consensus_discount_floor`

**Files:**
- Create: `packages/data-collector/src/database/init/023_signal_consensus_discount_floor.sql`.
- Modify: `packages/dashboard/src/server.ts` — add runtime ALTER block alongside the existing B.1 migrations (near `realized_volatility columns ensured`).

- [ ] **Step 1: Create init SQL for fresh DB installs**

Create `packages/data-collector/src/database/init/023_signal_consensus_discount_floor.sql`:

```sql
-- Sub-project B.2: consensus discount floor for the signal combiner.
-- Optuna optimizer will tune this value empirically. Default 0.5 until it
-- converges. Column persisted in signal_weights so the combiner reads it
-- via the same path as momentum/mean_reversion/etc. weights.
ALTER TABLE signal_weights
  ADD COLUMN IF NOT EXISTS consensus_discount_floor FLOAT NOT NULL DEFAULT 0.5;
```

- [ ] **Step 2: Add runtime ALTER to server.ts**

Read `packages/dashboard/src/server.ts` and find the block that ensures realized_volatility columns (from Sub-project B.1, should contain the log line `'realized_volatility columns ensured on markets / scorer_weights / market_score_history'`). Add IMMEDIATELY AFTER that block:

```typescript
      // Sub-project B.2: signal consensus discount floor.
      // See docs/plans/2026-04-25-signal-consensus-design.md.
      await query(`
        ALTER TABLE signal_weights
          ADD COLUMN IF NOT EXISTS consensus_discount_floor FLOAT NOT NULL DEFAULT 0.5;
      `);
      console.log('signal_weights.consensus_discount_floor ensured');
```

- [ ] **Step 3: Verify TypeScript compilation**

Run: `cd /c/Users/Usuario/GitHub/polymarket-trader && npx tsc -p packages/dashboard --noEmit 2>&1 | tail -10`
Expected: no new TS errors.

- [ ] **Step 4: Run dashboard tests for regressions**

Run: `npx vitest run packages/dashboard --reporter=verbose 2>&1 | tail -15`
Expected: no new failures.

- [ ] **Step 5: Commit**

```bash
git add packages/data-collector/src/database/init/023_signal_consensus_discount_floor.sql packages/dashboard/src/server.ts
git commit -m "feat(combiner): schema migration for consensus_discount_floor

Idempotent ADD COLUMN IF NOT EXISTS at dashboard startup on
signal_weights. Default 0.5 keeps pre-B.2 signals-level behavior
effectively unchanged for rows that already existed until Optuna or
a manual UPDATE moves it. Matching init SQL 023 for fresh installs."
```

---

## Task 3: Extend combiner params + integrate consensus logic in `combine()`

**Files:**
- Modify: `packages/signals/src/combiners/WeightedAverageCombiner.ts` — `WeightedAverageParams` interface + constructor default + `combine()` method body.
- Test: `packages/signals/src/combiners/WeightedAverageCombiner.test.ts`.

- [ ] **Step 1: Write failing tests**

Add to `WeightedAverageCombiner.test.ts` (near existing combiner behavior tests):

```typescript
describe('WeightedAverageCombiner — consensus discount integration', () => {
  const mkValidSignal = (direction: 'LONG' | 'SHORT', confidence = 0.8): SignalOutput => ({
    signalId: 'sig',
    marketId: 'm',
    tokenId: 't',
    direction,
    strength: 0.8,
    confidence,
    timestamp: Date.now(),
    ttlMs: 60_000,
  } as SignalOutput);

  it('consensus=1.0 (unanimous) — no discount, passes threshold as pre-B.2', () => {
    // Use a low minCombinedConfidence so the pre-discount confidence passes
    // clearly. With 5 identical LONG signals at conf=0.8, discount=1.0, final=0.8.
    const combiner = new WeightedAverageCombiner(
      { sig_a: 1, sig_b: 1, sig_c: 1, sig_d: 1, sig_e: 1 },
      { minCombinedConfidence: 0.3, minCombinedStrength: 0.1, consensusDiscountFloor: 0.5 },
    );
    const signals = [
      { signalType: 'sig_a', signal: mkValidSignal('LONG') },
      { signalType: 'sig_b', signal: mkValidSignal('LONG') },
      { signalType: 'sig_c', signal: mkValidSignal('LONG') },
      { signalType: 'sig_d', signal: mkValidSignal('LONG') },
      { signalType: 'sig_e', signal: mkValidSignal('LONG') },
    ];
    const result = combiner.combine(signals as any);
    expect(result).not.toBeNull();
    expect(result!.metadata!.consensus).toBeCloseTo(1.0, 3);
    expect(result!.metadata!.consensusDiscount).toBeCloseTo(1.0, 3);
    expect(result!.metadata!.componentCounts).toEqual({ long: 5, short: 0, neutral: 0 });
    // rawConfidence should equal finalConfidence since discount=1.0
    expect((result!.metadata as any).rawConfidence).toBeCloseTo(result!.confidence, 3);
  });

  it('consensus=0.029 (3/2) with floor=0.5 — discount≈0.515, most signals fail threshold', () => {
    // With 3 LONG + 2 SHORT at conf=0.8, raw combined confidence ~ 0.5-0.6
    // discount = 0.5 + 0.5*0.029 ≈ 0.515
    // final ≈ 0.3, likely below threshold 0.43
    const combiner = new WeightedAverageCombiner(
      { sig_a: 1, sig_b: 1, sig_c: 1, sig_d: 1, sig_e: 1 },
      { minCombinedConfidence: 0.43, minCombinedStrength: 0.1, consensusDiscountFloor: 0.5 },
    );
    const signals = [
      { signalType: 'sig_a', signal: mkValidSignal('LONG') },
      { signalType: 'sig_b', signal: mkValidSignal('LONG') },
      { signalType: 'sig_c', signal: mkValidSignal('LONG') },
      { signalType: 'sig_d', signal: mkValidSignal('SHORT') },
      { signalType: 'sig_e', signal: mkValidSignal('SHORT') },
    ];
    const result = combiner.combine(signals as any);
    // At these thresholds + 3/2 split, the post-discount confidence likely
    // fails → result is null. (If test proves too brittle depending on how
    // conflict resolution handles 3v2, relax to: assert finalConfidence
    // < rawConfidence OR result null.)
    expect(result).toBeNull();
  });

  it('N<3 signals (nullable) — discount=1.0, threshold behavior unchanged', () => {
    const combiner = new WeightedAverageCombiner(
      { sig_a: 1, sig_b: 1 },
      { minCombinedConfidence: 0.3, minCombinedStrength: 0.1, consensusDiscountFloor: 0.5 },
    );
    const signals = [
      { signalType: 'sig_a', signal: mkValidSignal('LONG') },
      { signalType: 'sig_b', signal: mkValidSignal('LONG') },
    ];
    const result = combiner.combine(signals as any);
    expect(result).not.toBeNull();
    expect(result!.metadata!.consensus).toBeNull();
    expect(result!.metadata!.consensusDiscount).toBeCloseTo(1.0, 3);
  });

  it('consensusDiscountFloor=1.0 — no-op, pre-B.2 behavior exactly', () => {
    const combiner = new WeightedAverageCombiner(
      { sig_a: 1, sig_b: 1, sig_c: 1, sig_d: 1, sig_e: 1 },
      { minCombinedConfidence: 0.43, minCombinedStrength: 0.1, consensusDiscountFloor: 1.0 },
    );
    const signals = [
      { signalType: 'sig_a', signal: mkValidSignal('LONG') },
      { signalType: 'sig_b', signal: mkValidSignal('LONG') },
      { signalType: 'sig_c', signal: mkValidSignal('LONG') },
      { signalType: 'sig_d', signal: mkValidSignal('SHORT') },
      { signalType: 'sig_e', signal: mkValidSignal('SHORT') },
    ];
    const result = combiner.combine(signals as any);
    // Even with low consensus, discount=1.0 means no filter — passes if
    // pre-discount confidence passes 0.43 threshold.
    expect(result).not.toBeNull();
    expect(result!.metadata!.consensusDiscount).toBeCloseTo(1.0, 3);
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `npx vitest run packages/signals/src/combiners/WeightedAverageCombiner.test.ts --reporter=verbose 2>&1 | tail -30`
Expected: new tests FAIL — TS errors on the `consensusDiscountFloor` param, or runtime assertion failures because combine() doesn't emit consensus metadata yet.

- [ ] **Step 3: Extend `WeightedAverageParams` + constructor default**

In `WeightedAverageCombiner.ts`, modify the interface:

```typescript
interface WeightedAverageParams {
  /** Minimum confidence to include signal */
  minConfidence: number;
  /** Whether to normalize weights to sum to 1 */
  normalizeWeights: boolean;
  /** Minimum combined confidence to emit signal */
  minCombinedConfidence: number;
  /** Minimum absolute strength to emit signal */
  minCombinedStrength: number;
  /** How to handle conflicting signals */
  conflictResolution: 'weighted' | 'strongest' | 'majority';
  /** Decay factor for older signals */
  timeDecayFactor: number;
  /** Maximum age of signal in ms before full decay */
  maxSignalAgeMs: number;
  /** Consensus discount floor ∈ [0, 1]. 1.0 = no effect. 0.0 = aggressive
   *  filter. Optuna tunes this value weekly via signal_weights table. */
  consensusDiscountFloor: number;
}
```

In the constructor, add to the default-params object:

```typescript
    this.parameters = {
      minConfidence: 0.2,
      normalizeWeights: true,
      minCombinedConfidence: 0.2,
      minCombinedStrength: 0.3,
      conflictResolution: 'weighted',
      timeDecayFactor: 0.9,
      maxSignalAgeMs: 5 * 60 * 1000,
      consensusDiscountFloor: 0.5,   // NEW
      ...params,
    };
```

- [ ] **Step 4: Integrate in `combine()`**

Find the `combine()` method. Identify:
1. The `confidence` computation (existing).
2. The `if (confidence < params.minCombinedConfidence) return null;` check.
3. The `combinedOutput: CombinedSignalOutput = { ... }` construction with its `metadata` field.

Modify to insert consensus logic between confidence computation and threshold check. Specifically, replace the existing threshold check:

```typescript
    // Existing (PRE):
    if (confidence < params.minCombinedConfidence) {
      this.logger.info(
        { confidence, threshold: params.minCombinedConfidence },
        'Combined confidence below threshold'
      );
      return null;
    }
```

With:

```typescript
    // NEW: Consensus discount on confidence
    const consensusResult = signalConsensus(usedSignals.map(s => s.signal));
    const discount = consensusDiscount(consensusResult.consensus, params.consensusDiscountFloor);
    const rawConfidence = confidence;
    const finalConfidence = confidence * discount;

    if (finalConfidence < params.minCombinedConfidence) {
      this.logger.info(
        {
          confidence: rawConfidence,
          finalConfidence,
          consensus: consensusResult.consensus,
          longCount: consensusResult.longCount,
          shortCount: consensusResult.shortCount,
          discount,
          threshold: params.minCombinedConfidence,
        },
        'Combined confidence (post-consensus-discount) below threshold'
      );
      return null;
    }
```

Update the `combinedOutput` construction so `confidence` is the post-discount value and the `metadata` carries the new fields:

```typescript
    const combinedOutput: CombinedSignalOutput = {
      signalId: 'combined',
      marketId: firstSignal.marketId,
      tokenId: firstSignal.tokenId,
      direction,
      strength,
      confidence: finalConfidence,   // POST-DISCOUNT
      timestamp: now,
      ttlMs: Math.min(...usedSignals.map(s => s.signal.ttlMs)),
      componentSignals: usedSignals.map(s => s.signal),
      weights: this.getCurrentWeights(usedSignals),
      appliedDirectionMultiplier: multiplier,
      wasExploration: false,
      metadata: {
        combinerType: 'weighted_average',
        signalCount: usedSignals.length,
        conflictResolution: params.conflictResolution,
        // NEW B.2 metadata:
        consensus: consensusResult.consensus,
        consensusDiscount: discount,
        rawConfidence,
        componentCounts: {
          long: consensusResult.longCount,
          short: consensusResult.shortCount,
          neutral: consensusResult.neutralCount,
        },
      },
    };
```

- [ ] **Step 5: Run tests until green**

Run: `npx vitest run packages/signals/src/combiners/WeightedAverageCombiner.test.ts --reporter=verbose 2>&1 | tail -30`
Expected: all new tests pass. Pre-existing tests may break because they construct `WeightedAverageCombiner` with partial params but now the type requires `consensusDiscountFloor`. If so:
- If the pre-existing test passes params via the partial `{...}` literal, it should still compile because the interface uses `Partial<WeightedAverageParams>` in the constructor signature. Verify this is the case (look at the constructor: `params: Partial<WeightedAverageParams> = {}`).
- Numeric assertions that depended on raw confidence may need updating. With `consensusDiscountFloor=0.5` default, tests constructing 3+ unanimous LONG signals should see `finalConfidence = rawConfidence * 1.0 = rawConfidence`, so unchanged. Tests with mixed directions may break — update them.

Run: `npx tsc -p packages/signals --noEmit 2>&1 | tail -10`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/signals/src/combiners/WeightedAverageCombiner.ts packages/signals/src/combiners/WeightedAverageCombiner.test.ts
git commit -m "feat(combiner): integrate consensus discount in combine()

WeightedAverageParams gains consensusDiscountFloor (default 0.5).
combine() computes signalConsensus on the valid signals used, applies
consensusDiscount to combinedConfidence before the existing threshold
check, and emits consensus/consensusDiscount/rawConfidence/
componentCounts in CombinedSignalOutput.metadata. confidence field in
the output is the post-discount value (raw preserved in metadata)."
```

---

## Task 4: Production combiner picks up `consensus_discount_floor` from DB

**Files:**
- Discovery: find the file that reads `signal_weights` at runtime and passes params to the combiner constructor. Likely in `packages/dashboard/src/services/SignalEngine.ts` or similar.
- Modify that file to read the new column + inject into combiner params.
- Test: extend whatever tests cover that file, or add a new focused test.

- [ ] **Step 1: Locate the signal-weights loader**

Run:
```bash
cd /c/Users/Usuario/GitHub/polymarket-trader
grep -rn "FROM signal_weights\|signal_weights" packages/dashboard/src --include="*.ts" | grep -v test | head -15
```

Identify which file reads the `signal_weights` table. Also search for where `directionMultiplier` is loaded — that's the closest precedent for combiner params that live in `signal_weights`. Read the surrounding code to understand the load path.

Report back what you found. If there are multiple candidates or the path is unclear, ESCALATE with a NEEDS_CONTEXT before proceeding — the controller needs to disambiguate.

- [ ] **Step 2: Write a test for the new read (if the file has tests)**

If the identified loader file has a test suite, add a test asserting that when the DB row has `consensus_discount_floor = 0.42`, the constructed combiner's `parameters.consensusDiscountFloor` equals `0.42`.

If it does not have test coverage, skip this step and rely on the deploy verification in Task 9 for runtime confirmation. Document in the commit message that runtime-only coverage was chosen.

- [ ] **Step 3: Extend the SELECT and params wiring**

In the loader file:

1. Add `consensus_discount_floor` to the `SELECT` column list when loading from `signal_weights`.
2. Extend the DB row TS type with `consensus_discount_floor: number | string | null`.
3. When constructing the combiner params (or before), pass `consensusDiscountFloor: Number(row.consensus_discount_floor ?? 0.5)` into the `WeightedAverageCombiner` constructor options.

The exact code shape depends on the loader file's current style — follow the same pattern used for `directionMultiplier` since that's the structural twin.

- [ ] **Step 4: Run tests**

Run tests for the file you modified:
```bash
npx vitest run <path-to-test-file> --reporter=verbose 2>&1 | tail -15
```
Expected: all pass.

TypeScript: `npx tsc -p packages/dashboard --noEmit 2>&1 | tail -10`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add <the modified loader file> <optional test file>
git commit -m "feat(combiner): load consensus_discount_floor from signal_weights

Wires the new signal_weights column through to
WeightedAverageCombiner params at startup. Follows the same load path
as directionMultiplier. When the column is missing or null (pre-T2
deploy), falls back to 0.5 default."
```

---

## Task 5: `AutoSignalExecutor` captures consensus at position open

**Files:**
- Modify: `packages/dashboard/src/services/AutoSignalExecutor.ts` — at the block that builds `scoreDimensionsAtEntry` (around line 880, after the typeEV + realizedVolatility captures from A/B.1).

- [ ] **Step 1: Locate the `scoreDimensionsAtEntry` construction block**

Read `AutoSignalExecutor.ts` around line 870-890. Find the block that builds `scoreDimensionsAtEntry` after computing typeEV and realizedVolatility (from prior sub-projects). It should look like:

```typescript
        scoreDimensionsAtEntry = {
          tradeability:      computeTradeability(price),
          liquidity:         computeLiquidity(vol, sprd),
          ttr:               computeTtr(endDate),
          volatility:        null,
          dataQuality:       null,
          typeExpectedValue: typeEV,
          realizedVolatility,
        };
```

- [ ] **Step 2: Write a light test (if coverage allows)**

The existing AutoSignalExecutor tests may or may not cover the position-open path. If they do, add a focused test asserting that a signal with `metadata.consensus = 0.75` and `metadata.componentCounts = { long: 4, short: 1, neutral: 0 }` results in `scoreDimensionsAtEntry.signalConsensus = 0.75` and the three `signalComponent*` fields populated.

If existing tests bail before the position-open path (as noted in B.1 T9's report), skip this step and rely on runtime verification at deploy.

- [ ] **Step 3: Extend `scoreDimensionsAtEntry` construction**

Extend the literal to read from `signal.metadata`:

```typescript
        const sigMeta = signal.metadata as (Record<string, unknown> | undefined);
        const componentCounts = (sigMeta?.componentCounts as
          { long?: number; short?: number; neutral?: number } | undefined);

        scoreDimensionsAtEntry = {
          tradeability:      computeTradeability(price),
          liquidity:         computeLiquidity(vol, sprd),
          ttr:               computeTtr(endDate),
          volatility:        null,
          dataQuality:       null,
          typeExpectedValue: typeEV,
          realizedVolatility,
          // NEW B.2 fields:
          signalConsensus:         (sigMeta?.consensus as number | null | undefined) ?? null,
          signalComponentLong:     componentCounts?.long ?? null,
          signalComponentShort:    componentCounts?.short ?? null,
          signalComponentNeutral:  componentCounts?.neutral ?? null,
        };
```

Note: `signalConsensus` and the three count fields are NOT in the `ScoreDimensions` TypeScript interface (they're extra JSONB keys outside the typed shape, per spec design decision). The object is typed as `Record<string, unknown> | null` or similar at the assignment site. Verify this compiles — if the assignment site has a stricter type, you may need to cast (`as any` or an extended type).

- [ ] **Step 4: Verify compile + tests**

Run: `npx tsc -p packages/dashboard --noEmit 2>&1 | tail -10`
Expected: no new errors.

Run: `npx vitest run packages/dashboard/src/services/AutoSignalExecutor --reporter=verbose 2>&1 | tail -15`
Expected: no regressions.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/services/AutoSignalExecutor.ts
git commit -m "feat(executor): capture signalConsensus + component counts at open

Extends scoreDimensionsAtEntry JSONB with signalConsensus (nullable),
signalComponentLong, signalComponentShort, signalComponentNeutral —
all extracted from signal.metadata populated by the combiner. Extra
keys outside the typed ScoreDimensions interface (signal-layer
features, not used by MarketScorer runtime)."
```

---

## Task 6: `BacktestService` propagates `consensusDiscountFloor` to the combiner

**Files:**
- Modify: `packages/dashboard/src/services/BacktestService.ts`.
- Types: wherever `BacktestRequest`/`combinerConfig` are defined.

- [ ] **Step 1: Locate combinerConfig type**

Read `BacktestService.ts` around lines 156-166 where `cc = request.combinerConfig` is used. Find the TS type of `combinerConfig` (likely in `packages/dashboard/src/services/BacktestService.ts` top-of-file or in a types module).

- [ ] **Step 2: Write a failing test**

In the existing `BacktestService.test.ts` (or create one if missing), add:

```typescript
describe('BacktestService — consensusDiscountFloor propagation', () => {
  it('passes consensusDiscountFloor through combinerConfig to the combiner', async () => {
    // This test verifies the wiring — not the outcome. A combiner constructed
    // with floor=0.7 from the request should have parameters.consensusDiscountFloor === 0.7.
    // Implementation: spy on WeightedAverageCombiner constructor or inspect the
    // resulting backtest's emitted combiner params if exposed.
  });
});
```

(Exact shape depends on existing test structure — aim for a quick wiring assertion, not an end-to-end backtest which would be too heavy.)

- [ ] **Step 3: Extend `combinerConfig` type**

In the type definition, add:
```typescript
interface CombinerConfigOption {
  // ... existing ...
  consensusDiscountFloor?: number;   // optional; combiner default applies if omitted
}
```

In `BacktestService.runBacktest()`, when constructing `WeightedAverageCombiner`, pass the new param:

```typescript
      const combiner = new WeightedAverageCombiner(weights, cc ? {
        minCombinedConfidence: cc.minCombinedConfidence,
        minCombinedStrength: cc.minCombinedStrength,
        conflictResolution: cc.conflictResolution as any,
        ...(cc.consensusDiscountFloor !== undefined
          ? { consensusDiscountFloor: cc.consensusDiscountFloor }
          : {}),
      } : undefined);
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run packages/dashboard/src/services/BacktestService --reporter=verbose 2>&1 | tail -15
npx tsc -p packages/dashboard --noEmit 2>&1 | tail -10
```
Expected: tests pass, no TS errors.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/services/BacktestService.ts <types file if separate> <test file>
git commit -m "feat(backtest): plumb consensusDiscountFloor through combinerConfig

Optuna-issued backtest requests can now set combinerConfig.
consensusDiscountFloor. Each trial's fresh WeightedAverageCombiner
instance picks up the value via the constructor params. Absent
value means combiner default (0.5) applies — pre-B.2 baseline
backtests keep working with no changes."
```

---

## Task 7: Pre-deploy sanity backtest (calibrate default)

This is a non-code task — pure measurement to validate the default floor.

- [ ] **Step 1: Run a 30-day backtest at `consensusDiscountFloor = 1.0` (baseline)**

Use the dashboard API (or the BacktestService directly via a one-off script) to run a backtest over the last 30 days of data with:
- `combinerConfig.consensusDiscountFloor = 1.0` (no-op — pre-B.2 behavior)
- All other params at production defaults.

Record: trade count, realized PnL, Sharpe.

- [ ] **Step 2: Run the same backtest at `consensusDiscountFloor = 0.5`**

Same data, same other params. Record: trade count, realized PnL, Sharpe.

- [ ] **Step 3: Compare and decide default**

If trade count at floor=0.5 drops >40% vs baseline: the default is too aggressive. Change the DB migration and init SQL (task 2) to use 0.7 as default. Update the server.ts ALTER and the init SQL file.

If trade count drops by 10-30% AND Sharpe is stable or improves: 0.5 is fine as default.

If trade count drops <10%: the filter is barely effective — still ship at 0.5 and let Optuna converge upward if that's the empirical finding.

- [ ] **Step 4: Commit default-value change if needed**

If the default was changed from 0.5 to 0.7 (or other):

```bash
git add packages/data-collector/src/database/init/023_signal_consensus_discount_floor.sql packages/dashboard/src/server.ts packages/signals/src/combiners/WeightedAverageCombiner.ts
git commit -m "chore(combiner): calibrate default consensus_discount_floor

30-day sanity backtest showed trade count drop of X% at floor=0.5,
Y% at floor=0.7. Chose Z as initial default to preserve trade flow
while Optuna converges."
```

If the default stays at 0.5, commit nothing here — just note the measurements in a comment on the PR.

- [ ] **Step 5 (documentation): record measurements on the PR description**

When opening the final B.2 PR, include in the description:
- Baseline (floor=1.0) trade count and Sharpe.
- With-filter (chosen floor) trade count and Sharpe.
- Delta reasoning.

This makes the ship decision auditable.

---

## Task 8: Render OPTUNA_PARAM_SPACE extension (follow-up, separate change)

This task is a handoff to a different deploy target (Render service) — not in-repo.

- [ ] **Step 1: Create a follow-up issue**

Open a GitHub issue titled "B.2 follow-up: extend OPTUNA_PARAM_SPACE on Render optimizer to include consensusDiscountFloor" with the following body:

```
Sub-project B.2 ships the combiner-side consensus discount. The
param is persisted in signal_weights.consensus_discount_floor and
the combiner reads it at startup.

Optuna on Render should sample consensusDiscountFloor ∈ [0.0, 1.0]
per trial, pass it to the VM's BacktestService via
combinerConfig.consensusDiscountFloor, and write the best value back
to signal_weights.consensus_discount_floor on trial completion.

Verification:
- Locate the OPTUNA_PARAM_SPACE config on Render (service
  srv-d5fove3e5dus73d2ehog per memory).
- Add consensusDiscountFloor with type=float, low=0.0, high=1.0.
- Confirm the write-back routine handles the new column (pattern
  should match directionMultiplier).
- After next weekly retrain, confirm signal_weights.
  consensus_discount_floor changes from 0.5.

Spec: docs/plans/2026-04-25-signal-consensus-design.md
Plan: docs/plans/2026-04-25-signal-consensus-plan.md
```

- [ ] **Step 2: Note the issue number in the B.2 PR description**

When the final B.2 PR is opened, include the follow-up issue number so the dependency is traceable.

---

## Task 9: Deploy + post-deploy verification

- [ ] **Step 1: Open PR and merge**

Open PR with body referencing spec + plan + Task 7 measurements + Task 8 issue. On merge, CI builds images and deploys.

- [ ] **Step 2: Confirm deploy**

```bash
rtk gh run list --workflow=deploy-gcp.yml --limit=1
gcloud compute ssh polymarket-vm --zone=us-east1-b --command "cd /home/Usuario/polymarket-trader && git log --oneline -1"
```

Expected: run `ok`, VM HEAD matches merge SHA.

- [ ] **Step 3: Verify schema migration**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command \
  'docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c "\d signal_weights" | grep consensus_discount_floor'
```

Expected: column `consensus_discount_floor FLOAT NOT NULL DEFAULT 0.5` listed.

- [ ] **Step 4: Verify the combiner is running the new code**

Tail the dashboard-api logs for 5-10 minutes after deploy. Expect to see one of:
- `"Combined confidence (post-consensus-discount) below threshold"` — filter is firing (there are low-consensus signals being rejected, confirms logic is live).
- OR log lines for combiner `'Combined signal generated'` including the new metadata fields.

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command \
  "docker logs polymarket-dashboard-api 2>&1 | tail -200 | grep -iE 'post-consensus-discount|combined signal generated'"
```

Expected: at least one matching log line in the first hour.

- [ ] **Step 5: Verify persistence**

Wait until at least one trade opens post-deploy. Then:

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command \
  'docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c "SELECT COUNT(*) AS total_posttrades, COUNT(*) FILTER (WHERE score_dimensions_at_entry ? '"'"'signalConsensus'"'"') AS with_consensus FROM paper_positions WHERE closed_at IS NULL AND opened_at > (SELECT MAX(updated_at) FROM signal_weights) - INTERVAL '"'"'1 hour'"'"';"'
```

Expected: `with_consensus > 0` for any newly-opened trades (post-deploy signals should have `signal.metadata.consensus` if N>=3 component signals fired).

- [ ] **Step 6: Real PnL sanity check**

Standard check from the daily-review playbook:

```sql
SELECT COUNT(*) AS total,
  COUNT(*) FILTER (WHERE ABS(avg_entry_price + current_price - 1.0) < 0.05
    AND EXTRACT(EPOCH FROM (closed_at - opened_at)) < 1800) AS inverted
FROM paper_positions
WHERE closed_at >= (SELECT last_reset_at FROM paper_account ORDER BY id LIMIT 1)
  AND realized_pnl IS NOT NULL;
```

Expected: `inverted = 0`.

- [ ] **Step 7: Monitor over 24h**

Watch the daily auto-review the morning after deploy. Confirm:
- No new container restarts caused by this deploy.
- No new DB errors around signal_weights or combiner paths.
- Combiner emits log lines with the new metadata (observable via VM log grep).
- Trade count in the first 24h is within the expected band (from Task 7 measurements).

If any check fails, open an incident issue and consider the rollback: `UPDATE signal_weights SET consensus_discount_floor = 1.0` (reverts combiner to no-op without redeploy).

---

## Self-Review

**1. Spec coverage:** Each design section in the spec maps to at least one task:

| Spec section | Task(s) |
|---|---|
| 1. Consensus metric (Shannon) | T1 |
| 2. Discount function | T1 |
| 3. Combiner integration (combine() changes + metadata) | T3 |
| 4. Combiner parameters + schema (WeightedAverageParams, signal_weights column) | T2, T3 |
| 5. AutoSignalExecutor capture | T5 |
| 6. Optuna integration (in-repo side: BacktestRequest propagation) | T6 |
| 6. Optuna integration (out-of-repo side: Render PARAM_SPACE) | T8 (follow-up issue) |
| 7. Backtest compatibility (verified — no new code) | T6 covers the propagation |
| 8. Nullable contract | T1 + T3 (test cases explicitly verify null-consensus path) |
| 9. Logging + observability | T3 (log message in threshold-fail path) |
| Tests — unit, integration, manual | T1 (helpers), T3 (combiner integration), T9 (manual post-deploy) |
| Success metrics | T7 (pre-deploy measurement), T9 (post-deploy verification) |
| Rollback | T9 notes the SQL-based rollback; no separate task needed |
| Follow-up persistence of componentSignals | Deferred per spec; not a plan task |

**2. Placeholder scan:**

- Task 4 Step 1 says "Report back what you found" and escalate if unclear — not a placeholder, explicit escalation contract.
- Task 4 Step 3 says "The exact code shape depends on the loader file's current style — follow the same pattern used for directionMultiplier" — acceptable because we can't pre-determine the exact shape without seeing the file, and we give clear guidance.
- Task 5 Step 2 says "The existing tests may or may not cover — skip if bails before position-open path" — same escape hatch as B.1 T9. Acceptable.
- No TBDs, TODOs, or "implement later" anywhere.

**3. Type consistency:**

- `consensusDiscountFloor` (camelCase) used in TypeScript throughout.
- `consensus_discount_floor` (snake_case) used in SQL throughout (column name).
- `signalConsensus` is the JSONB key (camelCase, matches typeExpectedValue precedent).
- `WeightedAverageParams.consensusDiscountFloor: number` in T3 matches `combinerConfig.consensusDiscountFloor?: number` in T6.
- `signalConsensus` / `consensusDiscount` helpers defined in T1 are used verbatim in T3.
- All consistent.

---
