# TypeWeights Fallback Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the per-type fallback in `WeightedAverageCombiner.getSignalWeight()` so that signal generators not listed in `DEFAULT_TYPE_WEIGHTS[marketType]` contribute 0 (instead of falling back to 1.0 and dominating the explicitly-listed weights via the normalize pass).

**Architecture:** Split the single `?? 1` fallback into two branch-specific defaults: per-type branch defaults to 0 (allowlist semantics), legacy `this.weights` branch keeps 1 (backward-compat for markets without a type-specific entry). One file modified. Two tests added. No schema changes.

**Tech Stack:** TypeScript + Vitest, single package (`packages/signals`), pnpm monorepo. Spec: `docs/plans/2026-04-28-typeweights-fallback-fix-design.md`.

---

## File Structure

| Path | Change | Responsibility |
|---|---|---|
| `packages/signals/src/combiners/WeightedAverageCombiner.ts` | Modify (lines 446-462 of `getSignalWeight`) | Split single fallback into per-type branch (?? 0) and legacy branch (?? 1). |
| `packages/signals/src/combiners/WeightedAverageCombiner.test.ts` | Modify (append) | Two new tests: unlisted generator silenced; listed generator unaffected. |

No new files. No new dependencies. No schema. No env vars. No docker-compose changes.

---

### Task 1: Add failing tests for the fallback fix

Two unit tests assert behavior at the public `combine()` boundary, since `getSignalWeight` is private. Tests use `setTypeWeights()` to install a known per-type table, then verify that an unlisted signal contributes 0 (does not affect combined output) while a listed signal contributes per its explicit weight.

**Files:**
- Modify: `packages/signals/src/combiners/WeightedAverageCombiner.test.ts`

- [ ] **Step 1: Append the two new tests**

Open `packages/signals/src/combiners/WeightedAverageCombiner.test.ts` and append at the end of the file (after the last existing `describe` block, around line 302):

```typescript
describe('WeightedAverageCombiner — typeWeights fallback', () => {
  it('drops a signal whose generator is not listed in typeWeights[marketType]', () => {
    // Setup: typeWeights for "event_financial" lists ONLY mean_reversion.
    // An unlisted generator (e.g. news_sentiment) should NOT contribute to the
    // combined output — its fallback weight must be 0, dropping it via the
    // s.weight !== 0 filter inside combine().
    const combiner = new WeightedAverageCombiner(
      {},
      { minCombinedStrength: 0.01, minCombinedConfidence: 0.01 }
    );
    combiner.setTypeWeights({
      event_financial: { mean_reversion: 0.6 },
    });
    combiner.setDirectionMultiplier(1); // disable contrarian flip for this test

    const listedSignal = buildSignal({
      signalId: 'mean_reversion',
      direction: 'long',
      strength: 0.5,
      confidence: 0.8,
    });
    const unlistedSignal = buildSignal({
      signalId: 'news_sentiment',
      direction: 'short',
      strength: 0.9,
      confidence: 0.9,
    });

    const result = combiner.combine([listedSignal, unlistedSignal], undefined, 'event_financial');

    expect(result).not.toBeNull();
    // If the unlisted SHORT contributed, its high strength (0.9) and
    // pre-fix weight 1.0/0.6 ≈ 1.67x mean_reversion would push the
    // combined direction to SHORT. With the fix it's silenced and the
    // LONG mean_reversion alone defines the direction.
    expect(result!.direction).toBe('LONG');
  });

  it('keeps explicit per-type weight for a listed generator', () => {
    // Sanity check: a listed generator still gets its specified weight.
    // This guards against accidentally also dropping listed signals.
    const combiner = new WeightedAverageCombiner(
      {},
      { minCombinedStrength: 0.01, minCombinedConfidence: 0.01 }
    );
    combiner.setTypeWeights({
      event_financial: { mean_reversion: 0.6, momentum: -0.3 },
    });
    combiner.setDirectionMultiplier(1);

    const meanRevSignal = buildSignal({
      signalId: 'mean_reversion',
      direction: 'long',
      strength: 0.4,
      confidence: 0.7,
    });

    const result = combiner.combine([meanRevSignal], undefined, 'event_financial');

    expect(result).not.toBeNull();
    expect(result!.direction).toBe('LONG');
    // strength is positive and proportional to weight × signal strength.
    // We don't assert exact value (depends on normalize, time decay, etc.)
    // but it must be well above the minCombinedStrength threshold of 0.01.
    expect(result!.strength).toBeGreaterThan(0.01);
  });
});
```

The tests reuse the existing `buildSignal` helper at line 26-42 of the test file — no new helpers needed.

- [ ] **Step 2: Run the new tests to verify they fail**

```bash
pnpm exec vitest run packages/signals/src/combiners/WeightedAverageCombiner.test.ts -t 'typeWeights fallback'
```

Expected: the **first test FAILS** because the unlisted SHORT signal currently contributes (fallback weight 1.0, normalized to ~0.714 for the example) and pulls combined direction toward SHORT. The second test PASSES (mean_reversion still works).

If both tests pass before the fix, that means the fallback bug doesn't actually manifest in the test setup — investigate before proceeding (probably a setup issue: check that signalConsensus discount or directionMultiplier isn't interfering).

- [ ] **Step 3: Commit the failing tests**

```bash
git add packages/signals/src/combiners/WeightedAverageCombiner.test.ts
git commit -m "test(combiner): failing tests for typeWeights fallback bug"
```

---

### Task 2: Implement the fallback split

Replace the single `?? 1` fallback in `getSignalWeight()` with a branch-specific structure. Per-type fallback becomes 0 (allowlist intent); legacy `this.weights` fallback stays 1 (backward-compat).

**Files:**
- Modify: `packages/signals/src/combiners/WeightedAverageCombiner.ts:446-462`

- [ ] **Step 1: Read the current method**

Confirm the current shape of `getSignalWeight()` matches the spec (lines 446-462). The method currently:
1. Picks `weightSource` based on whether `marketType` matches a known per-type entry.
2. Looks up `weightSource[signal.signalId]`, falling back to `1`.
3. Optionally normalizes against the sum of `weightSource`'s values.

If the method shape has drifted from the spec, stop and reconcile before editing.

- [ ] **Step 2: Apply the surgical edit**

Replace the body of `getSignalWeight()` (lines 446-462) with:

```typescript
  /**
   * Get weight for a specific signal, using market-type-specific weights if available
   */
  private getSignalWeight(signal: SignalOutput, now: Date, marketType?: string): number {
    // Per-type weights are explicit allowlists — generators not listed for this
    // market_type intentionally do not contribute. Default 0 honors that intent
    // (a previous default of 1 caused unlisted generators to dominate via the
    // normalize pass). The legacy this.weights branch keeps default 1 for
    // backward compatibility with markets that have no type-specific entry.
    let weight: number;
    let weightSource: Record<string, number>;
    if (marketType && this.typeWeights[marketType]) {
      weightSource = this.typeWeights[marketType];
      weight = weightSource[signal.signalId] ?? 0;
    } else {
      weightSource = this.weights;
      weight = weightSource[signal.signalId] ?? 1;
    }

    // Normalize if configured
    if (this.parameters.normalizeWeights) {
      const totalWeight = Object.values(weightSource).reduce((a, b) => a + b, 0);
      if (totalWeight > 0) {
        weight = weight / totalWeight;
      }
    }

    return weight;
  }
```

The `weightSource` variable is preserved (used by the normalize block). The only logical change is splitting the single `?? 1` into the two branch-specific defaults.

- [ ] **Step 3: Run the full combiner test suite**

```bash
pnpm exec vitest run packages/signals/src/combiners/WeightedAverageCombiner.test.ts
```

Expected: ALL tests pass — the 2 new fallback tests AND every preexisting test in this file (which currently has multiple `describe` blocks: direction context, applied direction multiplier, signalConsensus, consensusDiscount, consensus discount integration). Net pass count = preexisting + 2.

If any preexisting test fails, the change has unintended scope — stop, investigate, do NOT commit.

- [ ] **Step 4: TypeScript check**

```bash
pnpm --filter @polymarket-trader/signals exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit the implementation**

```bash
git add packages/signals/src/combiners/WeightedAverageCombiner.ts
git commit -m "fix(combiner): typeWeights fallback to 0 for unlisted generators"
```

---

### Task 3: Cross-package regression check

The `WeightedAverageCombiner` is consumed by `packages/dashboard` (SignalEngine, BacktestService) and `packages/backtest`. Run those test suites to catch any cross-package effect.

**Files:** None modified.

- [ ] **Step 1: Run dashboard tests**

```bash
pnpm exec vitest run packages/dashboard/src
```

Expected: all pass (or same skip count as the most recent green run). The fallback change should not affect dashboard tests because they typically register weights explicitly.

- [ ] **Step 2: Run backtest tests if present**

```bash
pnpm exec vitest run packages/backtest 2>&1 | tail -15 || echo 'no backtest tests'
```

Expected: pass or "no test files found". Treat passing-with-no-files as success — backtest may not have its own vitest config.

- [ ] **Step 3: Run signals package full suite**

```bash
pnpm exec vitest run packages/signals/src
```

Expected: all pass.

- [ ] **Step 4: Typecheck across the monorepo**

```bash
pnpm exec tsc -p packages/signals/tsconfig.json --noEmit && \
pnpm exec tsc -p packages/dashboard/tsconfig.json --noEmit
```

Expected: zero errors from either.

- [ ] **Step 5: No commit needed** — verification only.

---

### Task 4: Post-deploy smoke verification on VM

Runs after the merge has deployed to GCP. Confirms the runtime behavior matches the fix's intent.

**Files:** None modified.

- [ ] **Step 1: Confirm deploy reached the VM**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command "cd /home/Usuario/polymarket-trader && git log --oneline -3"
```

Expected: top commit matches the merged PR's squashed commit on main. If VM is behind, see the deploy-recovery flow in `daily-autoreview-analysis` SKILL.md (manual `git pull && docker compose pull && docker compose up -d`).

- [ ] **Step 2: Observe the next signal cycle's combined output**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command "docker compose -f /home/Usuario/polymarket-trader/docker-compose.gcp.yml logs --since 10m dashboard-api 2>&1 | grep 'Combined signal generated' | tail -10"
```

Expected: log lines continue with reasonable strength/confidence values. The `signalCount` field should reflect ONLY the listed generators that fired — for `event_financial` markets that's at most 5 (momentum, mean_reversion, ofi, mlofi, hawkes). If `signalCount` exceeds 5 for an event_financial signal, the fix did not deploy correctly.

- [ ] **Step 3: Watch for behavior change in trades**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command "docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"SELECT m.market_type, COUNT(*) AS opens_24h, ROUND(SUM(p.realized_pnl)::numeric, 2) AS pnl_closed_24h FROM paper_positions p JOIN markets m ON m.id = p.market_id WHERE p.opened_at >= NOW() - INTERVAL '24 hours' GROUP BY m.market_type;\""
```

Expected within 24h: trade volume on event_financial may DECREASE compared to pre-fix (if many of the prior signals were driven by fallback-1 unlisted generators). PnL trend hard to call after only 24h — needs a few days of data.

- [ ] **Step 4: No commit needed** — verification only.

---

## Self-Review Notes

The plan covers all 5 spec sections (Architecture, Components, Data Flow, Migration, Out of Scope). Two tasks for the actual change (test + impl), one for cross-package regression, one for post-deploy. Total ~30 minutes of focused work.

The legacy `this.weights` branch behavior is unchanged — verified by Task 3 running the dashboard suite (which exercises the legacy path through real market signals).
