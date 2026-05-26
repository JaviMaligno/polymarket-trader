# SignalEngine per-`market_type` allocation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure each `market_type` with active markets in the DB gets proportional representation in the SignalEngine processing pipeline, eliminating the silent feed bug where event_short markets are tracked + priced but produce 0 generator predictions.

**Architecture:** Three coordinated fixes — DB-fetch per-type sub-query union (L1), `selectDiversifiedMarkets` with `byMarketType` primary axis (L2), and per-cycle round-robin slice in `SignalEngine.computeSignals` (L3). Backward-compatible defaults: env vars unset → existing behaviour unchanged. New env vars: `SIGNAL_FETCH_BUDGET_PER_TYPE`, `SIGNAL_SLOTS_PER_TYPE`.

**Tech Stack:** TypeScript (dashboard package), pg, vitest. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-05-26-signalengine-per-type-allocation-design.md`

---

## File Structure

**Create:**
- (no new files — all changes are additions to existing modules to keep the diff focused)

**Modify:**
- `packages/dashboard/src/services/MarketSelector.ts` — add `parsePerTypeBudget` helper alongside existing `parseForceIncludeIds` and `parseVolumeWeight`.
- `packages/dashboard/src/services/MarketSelector.test.ts` — new test file colocated with MarketSelector.ts; tests `parsePerTypeBudget` edge cases.
- `packages/dashboard/src/services/PolymarketService.ts` — refactor `fetchMarketsFromDb` (L1) + `selectDiversifiedMarkets` (L2) for per-type allocation.
- `packages/dashboard/src/services/PolymarketService.test.ts` — new test file colocated; tests new selection behaviour on synthetic candidate sets.
- `packages/dashboard/src/services/SignalEngine.ts` — replace `computeSignals` slice with round-robin per-type.
- `packages/dashboard/src/services/SignalEngine.perTypeSlice.test.ts` — new test file; tests round-robin behaviour with biased input.
- `docker-compose.gcp.yml` — add the two new env vars to the `dashboard-api` service.

---

## Task 1: Add `parsePerTypeBudget` helper to MarketSelector

**Files:**
- Modify: `packages/dashboard/src/services/MarketSelector.ts` (add export after existing `parseVolumeWeight`)
- Create: `packages/dashboard/src/services/MarketSelector.test.ts`

- [ ] **Step 1: Create the test file with the failing tests**

Create `packages/dashboard/src/services/MarketSelector.test.ts` with:

```typescript
import { describe, it, expect } from 'vitest';
import { parsePerTypeBudget } from './MarketSelector.js';

describe('parsePerTypeBudget', () => {
  it('returns empty Map for undefined input', () => {
    expect(parsePerTypeBudget(undefined)).toEqual(new Map());
  });

  it('returns empty Map for empty string', () => {
    expect(parsePerTypeBudget('')).toEqual(new Map());
  });

  it('parses a single type:budget pair', () => {
    expect(parsePerTypeBudget('event_short:15')).toEqual(new Map([['event_short', 15]]));
  });

  it('parses multiple pairs separated by commas', () => {
    const result = parsePerTypeBudget('crypto_daily:8,event_financial:12,event_short:12');
    expect(result).toEqual(new Map([
      ['crypto_daily', 8],
      ['event_financial', 12],
      ['event_short', 12],
    ]));
  });

  it('tolerates whitespace around tokens', () => {
    const result = parsePerTypeBudget(' crypto_daily : 8 , event_short : 12 ');
    expect(result).toEqual(new Map([['crypto_daily', 8], ['event_short', 12]]));
  });

  it('drops entries with non-numeric budgets', () => {
    const result = parsePerTypeBudget('event_short:abc,crypto_daily:5');
    expect(result).toEqual(new Map([['crypto_daily', 5]]));
  });

  it('drops entries with missing colon', () => {
    const result = parsePerTypeBudget('event_short15,crypto_daily:5');
    expect(result).toEqual(new Map([['crypto_daily', 5]]));
  });

  it('drops entries with empty type name', () => {
    const result = parsePerTypeBudget(':15,crypto_daily:5');
    expect(result).toEqual(new Map([['crypto_daily', 5]]));
  });

  it('drops entries with negative or zero budget', () => {
    const result = parsePerTypeBudget('event_short:-5,crypto_daily:0,event_long:10');
    expect(result).toEqual(new Map([['event_long', 10]]));
  });

  it('floors fractional budgets to integers', () => {
    const result = parsePerTypeBudget('event_short:12.7,crypto_daily:5');
    expect(result).toEqual(new Map([['event_short', 12], ['crypto_daily', 5]]));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/dashboard/src/services/MarketSelector.test.ts`
Expected: FAIL with `parsePerTypeBudget is not a function` (or import error).

- [ ] **Step 3: Implement `parsePerTypeBudget` in MarketSelector.ts**

Add to `packages/dashboard/src/services/MarketSelector.ts` immediately after the existing `parseVolumeWeight` export:

```typescript
/**
 * Parse a per-`market_type` budget map from an env var string.
 *
 * Format: `type:budget,type:budget,...` — e.g. `"crypto_daily:8,event_short:12"`.
 *
 * Used by SignalEngine feed allocation: each `market_type` gets a fixed share of
 * the total processing slots, so low-volume types (event_short) are not starved
 * by the volume-sorted candidate pool. See spec
 * `docs/superpowers/specs/2026-05-26-signalengine-per-type-allocation-design.md`.
 *
 * Tolerant of malformed entries: invalid entries are silently dropped (logged is
 * not necessary — env vars are operator-controlled). Empty / undefined input
 * returns an empty Map, signalling "no per-type allocation; fall back to legacy
 * behaviour".
 *
 * Rules:
 * - Both type and budget must be present (entry must contain `:`).
 * - Type name must be non-empty after trim.
 * - Budget must parse to a finite positive integer (fractional values are floored).
 *
 * @returns Map<market_type, budget>. Empty when input is unset/malformed.
 */
export function parsePerTypeBudget(raw: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!raw) return out;
  for (const entry of raw.split(',')) {
    const colonIdx = entry.indexOf(':');
    if (colonIdx < 0) continue;
    const type = entry.slice(0, colonIdx).trim();
    const budgetRaw = entry.slice(colonIdx + 1).trim();
    if (type.length === 0) continue;
    const budget = Number(budgetRaw);
    if (!Number.isFinite(budget) || budget <= 0) continue;
    out.set(type, Math.floor(budget));
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/dashboard/src/services/MarketSelector.test.ts`
Expected: PASS — all 10 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/services/MarketSelector.ts packages/dashboard/src/services/MarketSelector.test.ts
git commit -m "feat(market-selector): add parsePerTypeBudget helper for per-type allocation"
```

---

## Task 2: L3 — Per-cycle round-robin slice in SignalEngine

**Files:**
- Modify: `packages/dashboard/src/services/SignalEngine.ts:498-535` (the `computeSignals` method) — refactor to pick markets via round-robin per `marketType` instead of `slice(0, maxMarketsPerCycle)`.
- Create: `packages/dashboard/src/services/SignalEngine.perTypeSlice.test.ts`

- [ ] **Step 1: Read the existing `computeSignals` method**

Read `packages/dashboard/src/services/SignalEngine.ts` lines 498-535 to confirm the current shape. Key line:
```typescript
const marketsToProcess = this.activeMarkets.slice(0, this.config.maxMarketsPerCycle);
```

The refactor extracts that pick into a separate pure method `pickMarketsForCycle(activeMarkets, maxMarketsPerCycle)` so it can be unit-tested without driving the full async pipeline.

- [ ] **Step 2: Create the failing test file**

Create `packages/dashboard/src/services/SignalEngine.perTypeSlice.test.ts` with:

```typescript
import { describe, it, expect } from 'vitest';
import { pickMarketsForCycle, type ActiveMarketLike } from './SignalEngine.js';

// Helper: synthetic markets with just the fields the picker reads.
const m = (id: string, marketType: string): ActiveMarketLike => ({
  id, marketType,
  // Other fields irrelevant for the round-robin pick — keep minimal.
} as ActiveMarketLike);

describe('pickMarketsForCycle', () => {
  it('returns all markets when count <= maxMarketsPerCycle', () => {
    const ms = [m('a', 'event_long'), m('b', 'crypto_daily')];
    expect(pickMarketsForCycle(ms, 10).map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('returns empty array when input is empty', () => {
    expect(pickMarketsForCycle([], 10)).toEqual([]);
  });

  it('returns empty array when maxMarketsPerCycle is 0', () => {
    expect(pickMarketsForCycle([m('a', 'event_long')], 0)).toEqual([]);
  });

  it('round-robins across types when input is biased', () => {
    // Biased input: 6 event_long, 2 crypto_daily, 1 event_short
    const ms = [
      m('l1', 'event_long'), m('l2', 'event_long'), m('l3', 'event_long'),
      m('l4', 'event_long'), m('l5', 'event_long'), m('l6', 'event_long'),
      m('c1', 'crypto_daily'), m('c2', 'crypto_daily'),
      m('s1', 'event_short'),
    ];
    const picked = pickMarketsForCycle(ms, 6).map((x) => x.id);
    // Expect round-robin: l1, c1, s1, l2, c2, l3 (one from each type per cycle
    // until that type is exhausted).
    expect(picked).toEqual(['l1', 'c1', 's1', 'l2', 'c2', 'l3']);
  });

  it('skips exhausted types and continues with the rest', () => {
    // event_short has 1 market, others have 3 — after 1 round, event_short is
    // exhausted and the remaining slots are filled from the survivors.
    const ms = [
      m('l1', 'event_long'), m('l2', 'event_long'), m('l3', 'event_long'),
      m('c1', 'crypto_daily'), m('c2', 'crypto_daily'), m('c3', 'crypto_daily'),
      m('s1', 'event_short'),
    ];
    const picked = pickMarketsForCycle(ms, 7).map((x) => x.id);
    // Round 1: l1, c1, s1. Round 2: l2, c2 (s exhausted). Round 3: l3, c3.
    expect(picked).toEqual(['l1', 'c1', 's1', 'l2', 'c2', 'l3', 'c3']);
  });

  it('treats markets with missing marketType as a single "unknown" bucket', () => {
    const ms = [
      m('a', 'event_long'),
      { id: 'b' } as ActiveMarketLike,           // no marketType
      { id: 'c', marketType: undefined } as ActiveMarketLike,
      m('d', 'event_long'),
    ];
    const picked = pickMarketsForCycle(ms, 3).map((x) => x.id);
    // Round 1: a (event_long), b (unknown). Round 2: d.
    // The 'unknown' bucket gets one slot per round just like any other type.
    expect(picked).toEqual(['a', 'b', 'd']);
  });

  it('preserves bucket-internal order (does not sort)', () => {
    const ms = [
      m('z', 'event_long'), m('a', 'event_long'),
      m('y', 'crypto_daily'), m('b', 'crypto_daily'),
    ];
    expect(pickMarketsForCycle(ms, 4).map((x) => x.id)).toEqual(['z', 'y', 'a', 'b']);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run packages/dashboard/src/services/SignalEngine.perTypeSlice.test.ts`
Expected: FAIL — `pickMarketsForCycle is not exported` (or `ActiveMarketLike` undefined).

- [ ] **Step 4: Implement `pickMarketsForCycle` in SignalEngine.ts**

Add this near the top of `packages/dashboard/src/services/SignalEngine.ts`, immediately above the `SignalEngine` class declaration (the existing `ActiveMarket` interface in that file is fine; we add a structural alias for the picker to test against without dragging the whole shape in):

```typescript
/**
 * Structural alias for `pickMarketsForCycle`. The picker only reads `id` and
 * `marketType`, so tests can pass minimal synthetic objects. Production callers
 * pass the full `ActiveMarket` (which extends this).
 */
export interface ActiveMarketLike {
  id: string;
  marketType?: string;
}

/**
 * Round-robin pick across `market_type` buckets up to `maxMarketsPerCycle`.
 *
 * Why: the legacy `activeMarkets.slice(0, N)` preserves whatever order the
 * pipeline upstream produced — typically volume-sorted, which biases the pick
 * toward `event_long` (high volume) and starves low-volume types like
 * `event_short` (which currently produce 0 predictions despite being tracked).
 *
 * Per-type round-robin guarantees fair coverage per cycle regardless of upstream
 * order. Markets without `marketType` are bucketed together under the `__unknown__`
 * key and round-robined like any other type.
 *
 * Bucket-internal order is preserved (no sort) so callers retain control over
 * within-type prioritisation (e.g. by score, recent activity).
 */
export function pickMarketsForCycle<T extends ActiveMarketLike>(
  activeMarkets: T[],
  maxMarketsPerCycle: number,
): T[] {
  if (maxMarketsPerCycle <= 0 || activeMarkets.length === 0) return [];
  if (activeMarkets.length <= maxMarketsPerCycle) return activeMarkets.slice();

  // Group preserving insertion order — Map iteration order = insertion order.
  const buckets = new Map<string, T[]>();
  for (const market of activeMarkets) {
    const key = market.marketType ?? '__unknown__';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(market);
  }

  const result: T[] = [];
  // Round-robin: keep iterating until result is full or every bucket is empty.
  // No sort — bucket iteration order is the order types first appeared.
  while (result.length < maxMarketsPerCycle) {
    let pickedThisRound = false;
    for (const bucket of buckets.values()) {
      if (bucket.length === 0) continue;
      result.push(bucket.shift()!);
      pickedThisRound = true;
      if (result.length >= maxMarketsPerCycle) break;
    }
    if (!pickedThisRound) break; // all buckets exhausted
  }
  return result;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run packages/dashboard/src/services/SignalEngine.perTypeSlice.test.ts`
Expected: PASS — all 7 tests green.

- [ ] **Step 6: Wire the new picker into `computeSignals`**

In `packages/dashboard/src/services/SignalEngine.ts`, replace the line in `computeSignals` (around line 507):

```typescript
const marketsToProcess = this.activeMarkets.slice(0, this.config.maxMarketsPerCycle);
```

with:

```typescript
const marketsToProcess = pickMarketsForCycle(this.activeMarkets, this.config.maxMarketsPerCycle);
```

- [ ] **Step 7: Run the full existing SignalEngine tests to confirm no regression**

Run: `pnpm vitest run packages/dashboard/src/services/SignalEngine.test.ts packages/dashboard/src/services/SignalEngine.filter.test.ts packages/dashboard/src/services/SignalEngine.directionsDisabledParser.test.ts`
Expected: all existing tests still PASS.

- [ ] **Step 8: TypeScript build check**

Run: `pnpm --filter dashboard build`
Expected: build green (no TS errors).

- [ ] **Step 9: Commit**

```bash
git add packages/dashboard/src/services/SignalEngine.ts packages/dashboard/src/services/SignalEngine.perTypeSlice.test.ts
git commit -m "feat(signal-engine): round-robin per-market_type slice in computeSignals"
```

---

## Task 3: L2 — `selectDiversifiedMarkets` byMarketType with underfill redistribution

**Files:**
- Modify: `packages/dashboard/src/services/PolymarketService.ts:363-413` (the `selectDiversifiedMarkets` method)
- Create: `packages/dashboard/src/services/PolymarketService.test.ts`

The current method diversifies by `category` only. The spec requires `marketType` as the primary axis with `ALLOWED_MARKET_TYPES` priority for underfill redistribution.

- [ ] **Step 1: Read the existing `selectDiversifiedMarkets`**

Read `packages/dashboard/src/services/PolymarketService.ts` lines 363-413 to confirm current shape. Key behaviour to preserve: force-include pinning (Step 1 of the old method), `rankMarketsByVolumeScoreBlend` within-bucket ranking.

- [ ] **Step 2: Create the failing test file**

Create `packages/dashboard/src/services/PolymarketService.test.ts` with:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { selectByTypeBudget, type SelectableMarket } from './PolymarketService.js';

const m = (id: string, marketType: string, volume = 100, marketScore = 0.5): SelectableMarket => ({
  id, marketType, volume, marketScore,
  // Other fields irrelevant for the budget selector.
} as SelectableMarket);

describe('selectByTypeBudget', () => {
  beforeEach(() => {
    delete process.env.ALLOWED_MARKET_TYPES;
  });

  it('returns empty when budgets is empty', () => {
    const ms = [m('a', 'event_long')];
    expect(selectByTypeBudget(ms, new Map(), 10, new Set())).toEqual([]);
  });

  it('honours per-type budgets when supply is sufficient', () => {
    const ms = [
      m('l1', 'event_long', 100), m('l2', 'event_long', 90), m('l3', 'event_long', 80),
      m('s1', 'event_short', 50), m('s2', 'event_short', 40),
    ];
    const budgets = new Map([['event_long', 2], ['event_short', 2]]);
    const picked = selectByTypeBudget(ms, budgets, 10, new Set()).map((x) => x.id).sort();
    expect(picked).toEqual(['l1', 'l2', 's1', 's2']);
  });

  it('redistributes underfill to ALLOWED types first', () => {
    process.env.ALLOWED_MARKET_TYPES = 'event_short,crypto_daily';
    const ms = [
      m('s1', 'event_short'), m('s2', 'event_short'), m('s3', 'event_short'),
      m('c1', 'crypto_daily'), m('c2', 'crypto_daily'),
      m('l1', 'event_long'), m('l2', 'event_long'), m('l3', 'event_long'),
    ];
    // Budgets: event_long=4 (only 3 supply → 1 leftover), event_short=2, crypto_daily=2.
    const budgets = new Map([['event_long', 4], ['event_short', 2], ['crypto_daily', 2]]);
    const picked = selectByTypeBudget(ms, budgets, 8, new Set()).map((x) => x.id).sort();
    // event_long picks all 3 (limited supply). 1 leftover slot → event_short or
    // crypto_daily (both allowed). Either is acceptable; assert count + supply
    // sources rather than exact ID.
    expect(picked.length).toBe(8);
    const counts = countByPrefix(picked);
    expect(counts.l).toBe(3);
    // 3 + 2 + 2 = 7; the 8th came from an allowed type.
    expect(counts.s + counts.c).toBe(5);
  });

  it('redistributes leftover to non-allowed types if no allowed surplus exists', () => {
    process.env.ALLOWED_MARKET_TYPES = 'event_short';
    const ms = [
      m('s1', 'event_short'),                                 // 1 supply
      m('l1', 'event_long'), m('l2', 'event_long'),
      m('l3', 'event_long'), m('l4', 'event_long'),           // 4 supply
    ];
    const budgets = new Map([['event_short', 3], ['event_long', 1]]);
    const picked = selectByTypeBudget(ms, budgets, 5, new Set()).map((x) => x.id).sort();
    // event_short can only fill 1 (supply limit); 2 budget unused. No allowed
    // surplus. Leftover goes to event_long.
    expect(picked).toContain('s1');
    expect(picked.filter((id) => id.startsWith('l')).length).toBeGreaterThanOrEqual(2);
    expect(picked.length).toBeLessThanOrEqual(5);
  });

  it('never exceeds maxTotal even if budgets sum higher', () => {
    const ms = [
      m('l1', 'event_long'), m('l2', 'event_long'), m('l3', 'event_long'),
      m('s1', 'event_short'), m('s2', 'event_short'),
    ];
    const budgets = new Map([['event_long', 5], ['event_short', 5]]);
    const picked = selectByTypeBudget(ms, budgets, 3, new Set());
    expect(picked.length).toBe(3);
  });

  it('excludes force-included markets from the per-type budget', () => {
    const ms = [
      m('forced1', 'event_long'), m('l1', 'event_long'), m('l2', 'event_long'),
    ];
    const budgets = new Map([['event_long', 2]]);
    const picked = selectByTypeBudget(ms, budgets, 10, new Set(['forced1']));
    // 'forced1' is excluded from per-type picks (caller adds it back separately).
    // event_long budget=2 → l1, l2.
    expect(picked.map((x) => x.id).sort()).toEqual(['l1', 'l2']);
  });

  it('uses within-bucket volume order (highest first)', () => {
    const ms = [
      m('low', 'event_short', 10), m('high', 'event_short', 100), m('mid', 'event_short', 50),
    ];
    const budgets = new Map([['event_short', 2]]);
    const picked = selectByTypeBudget(ms, budgets, 10, new Set());
    expect(picked.map((x) => x.id)).toEqual(['high', 'mid']);
  });
});

function countByPrefix(ids: string[]): Record<string, number> {
  const counts: Record<string, number> = { l: 0, s: 0, c: 0 };
  for (const id of ids) {
    const prefix = id[0];
    counts[prefix] = (counts[prefix] || 0) + 1;
  }
  return counts;
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run packages/dashboard/src/services/PolymarketService.test.ts`
Expected: FAIL — `selectByTypeBudget is not exported`.

- [ ] **Step 4: Export the `SelectableMarket` type alias and implement `selectByTypeBudget`**

In `packages/dashboard/src/services/PolymarketService.ts`, add these exports near the top of the file (after the `PolymarketMarket` interface declaration, around line 80):

```typescript
/**
 * Structural alias for `selectByTypeBudget`. The selector only reads the fields
 * listed here; full `PolymarketMarket` extends this. Exported so tests can pass
 * minimal synthetic objects without constructing the full shape.
 */
export interface SelectableMarket {
  id: string;
  marketType?: string;
  volume: number;
  marketScore?: number;
}
```

Add the `selectByTypeBudget` function as a standalone exported helper (so it is independently testable). Place it immediately above the `PolymarketService` class declaration (around line 116):

```typescript
/**
 * Select markets up to a per-`market_type` budget, with underfill
 * redistribution to ALLOWED_MARKET_TYPES (live-traded) first.
 *
 * Why standalone (not a method): pure function with no DB / state access, so
 * it can be unit-tested with synthetic inputs covering all edge cases.
 *
 * Algorithm:
 *   1. Filter out force-included IDs — the caller pins those separately.
 *   2. Bucket remaining markets by `marketType`. Within each bucket, sort by
 *      volume DESC (within-bucket priority is volume-blend; the caller can
 *      pre-sort by score-blend if a different priority is desired).
 *   3. First pass: take min(budget[type], bucket.length) from each type.
 *   4. Compute leftover = maxTotal - selected_so_far - sum(unused budget).
 *      Wait — simpler: while selected < maxTotal AND any type with surplus
 *      candidates still exists, pull one more from the type with the highest
 *      original budget that has surplus. Prefer ALLOWED_MARKET_TYPES.
 *   5. Final cap at maxTotal.
 */
export function selectByTypeBudget<T extends SelectableMarket>(
  markets: T[],
  budgets: Map<string, number>,
  maxTotal: number,
  forceIds: Set<string>,
): T[] {
  if (budgets.size === 0 || maxTotal <= 0) return [];

  // 1. Drop force-included; caller pins those.
  const candidates = markets.filter((m) => !forceIds.has(m.id));

  // 2. Bucket by marketType + sort within bucket by volume DESC.
  const buckets = new Map<string, T[]>();
  for (const m of candidates) {
    const key = m.marketType ?? '__unknown__';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(m);
  }
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => b.volume - a.volume);
  }

  // 3. First pass: take min(budget, supply) from each type.
  const selected: T[] = [];
  const remainingByType = new Map<string, T[]>();
  for (const [type, budget] of budgets) {
    const bucket = buckets.get(type) ?? [];
    const take = Math.min(budget, bucket.length);
    selected.push(...bucket.slice(0, take));
    remainingByType.set(type, bucket.slice(take));
  }

  // 4. Underfill: while under maxTotal AND any bucket has surplus, pick one.
  //    Priority: ALLOWED_MARKET_TYPES first, then non-allowed; within each
  //    priority, the type with the largest original budget wins ties.
  const allowed = new Set(
    (process.env.ALLOWED_MARKET_TYPES ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean)
  );
  while (selected.length < maxTotal) {
    // Build the prioritised list of types that still have surplus.
    const surplus = [...remainingByType.entries()]
      .filter(([, rem]) => rem.length > 0)
      .map(([type, rem]) => ({
        type,
        budget: budgets.get(type) ?? 0,
        rem,
        priority: allowed.size === 0 || allowed.has(type) ? 0 : 1, // 0 = allowed/no-allowlist, 1 = non-allowed
      }))
      .sort((a, b) => a.priority - b.priority || b.budget - a.budget);
    if (surplus.length === 0) break;
    selected.push(surplus[0].rem.shift()!);
  }

  // 5. Hard cap.
  return selected.slice(0, maxTotal);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run packages/dashboard/src/services/PolymarketService.test.ts`
Expected: PASS — all 7 tests green.

- [ ] **Step 6: Wire `selectByTypeBudget` into `selectDiversifiedMarkets`**

In `packages/dashboard/src/services/PolymarketService.ts`, refactor the existing `selectDiversifiedMarkets` method. Locate the existing method (around line 363) and modify it. The full new version:

```typescript
private selectDiversifiedMarkets(allMarkets: PolymarketMarket[]): PolymarketMarket[] {
  const maxPerCategory = this.config.maxMarketsPerCategory;
  const maxTotal = this.config.maxMarketsToTrack;

  const forceIds = parseForceIncludeIds(process.env.FORCE_INCLUDE_MARKET_IDS);
  const volumeWeight = parseVolumeWeight(process.env.MARKET_SELECTION_VOLUME_WEIGHT);
  const perTypeBudget = parsePerTypeBudget(process.env.SIGNAL_SLOTS_PER_TYPE);

  // Step 1: pin force-included markets at the top, regardless of volume/score.
  const forced = allMarkets.filter((m) => forceIds.has(m.id));
  const missingForced = [...forceIds].filter((id) => !forced.some((m) => m.id === id));
  if (forced.length > 0) {
    console.log(`[PolymarketService] Force-included ${forced.length} markets: ${forced.map((m) => m.id).join(',')}`);
  }
  if (missingForced.length > 0) {
    console.log(`[PolymarketService] Force-include IDs not in candidate set (skipped): ${missingForced.join(',')}`);
  }

  // Step 2: NEW — if SIGNAL_SLOTS_PER_TYPE is configured, use per-type budgets
  // as the primary diversification axis. This guarantees low-volume types
  // (event_short) get representation. Otherwise fall back to the legacy
  // byCategory path for full backward compatibility.
  if (perTypeBudget.size > 0) {
    const remainingSlots = Math.max(0, maxTotal - forced.length);
    const byType = selectByTypeBudget(allMarkets, perTypeBudget, remainingSlots, forceIds);
    const selected = [...forced, ...byType];
    console.log(`[PolymarketService] Per-type selection: forced=${forced.length}, byType=${byType.length}, total=${selected.length}`);
    return selected;
  }

  // Step 3 (legacy path): rank the non-forced pool by blended volume + market_score.
  const candidates = allMarkets.filter((m) => !forceIds.has(m.id));
  const ranked = rankMarketsByVolumeScoreBlend(candidates, volumeWeight);

  // Step 4: diversify by category, taking the highest-ranked first.
  const byCategory = new Map<string, PolymarketMarket[]>();
  for (const { market } of ranked) {
    const cat = market.category;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(market);
  }

  const selected: PolymarketMarket[] = [...forced];
  for (const [category, markets] of byCategory) {
    const toTake = Math.min(maxPerCategory, markets.length);
    selected.push(...markets.slice(0, toTake));
    console.log(`[PolymarketService] Category '${category}': ${toTake}/${markets.length} markets selected`);
  }

  // Step 5: fill remaining slots with the next best by blended rank (legacy behaviour preserved).
  if (selected.length < maxTotal) {
    const remaining = ranked
      .map((r) => r.market)
      .filter((m) => !selected.some((s) => s.id === m.id));
    const needed = maxTotal - selected.length;
    selected.push(...remaining.slice(0, needed));
  }

  return selected.slice(0, maxTotal);
}
```

Also add the import for `parsePerTypeBudget` to the existing import group at line 13-17:

```typescript
import {
  parseForceIncludeIds,
  parsePerTypeBudget,
  parseVolumeWeight,
  rankMarketsByVolumeScoreBlend,
} from './MarketSelector.js';
```

- [ ] **Step 7: TypeScript build check**

Run: `pnpm --filter dashboard build`
Expected: build green.

- [ ] **Step 8: Run the full test suite to catch regressions in PolymarketService**

Run: `pnpm vitest run packages/dashboard/src/services/`
Expected: all tests PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/dashboard/src/services/PolymarketService.ts packages/dashboard/src/services/PolymarketService.test.ts
git commit -m "feat(polymarket-service): per-market_type selection in selectDiversifiedMarkets"
```

---

## Task 4: L1 — Per-type sub-query union in fetchMarketsFromDb

**Files:**
- Modify: `packages/dashboard/src/services/PolymarketService.ts` — the SQL in `fetchMarketsFromDb` (around lines 471-502).

The current single `ORDER BY volume_24h DESC LIMIT N` query biases the candidate pool toward `event_long`. Replace with a UNION ALL of per-type sub-queries, each with its own LIMIT from `SIGNAL_FETCH_BUDGET_PER_TYPE`.

- [ ] **Step 1: Read the current SQL block**

Read `packages/dashboard/src/services/PolymarketService.ts` lines 440-505 to confirm exact shape. Note: SQL uses parametrised values `$1` (min price), `$2` (max price), `$3` (min volume), `$4` (limit), `$5` (force ids). Building the UNION dynamically requires building the SQL string with one sub-query branch per configured type.

- [ ] **Step 2: Add a helper `buildFetchSQL` near the top of the module**

Right after the `selectByTypeBudget` function added in Task 3, insert:

```typescript
/**
 * Build the candidate-fetch SQL for the markets table.
 *
 * Two modes:
 * - When `fetchBudgets` is empty → single ORDER BY volume_24h DESC LIMIT $4
 *   (legacy behaviour, backward-compatible default).
 * - When `fetchBudgets` is non-empty → one sub-query per type each with its
 *   own LIMIT, joined by UNION ALL. The total candidate pool size is
 *   sum(budgets) + |forceIds|. Force-included IDs are always appended as a
 *   final sub-query with minimal filters so they never get excluded.
 *
 * Returns { sql, params } — caller spreads `params` into pg's query().
 *
 * Parameter layout (legacy path):
 *   $1 = MIN_PRICE, $2 = MAX_PRICE, $3 = MIN_VOLUME, $4 = LIMIT, $5 = forceIds
 *
 * Parameter layout (per-type path):
 *   $1 = MIN_PRICE, $2 = MAX_PRICE, $3 = MIN_VOLUME, $4 = forceIds.
 *   The per-type LIMITs and type names are interpolated into the SQL string
 *   directly because pg does not bind LIMIT or table names. Both are
 *   operator-controlled (env var) so SQL injection is not a concern — but
 *   defensively, type names are sanitised to ^[a-z_]+$ before interpolation.
 */
export function buildFetchSQL(
  fetchBudgets: Map<string, number>,
): { sql: string; perTypeMode: boolean } {
  const baseFilters = `
        m.is_active = true
    AND m.is_resolved = false
    AND COALESCE(m.tracking_status, 'active') != 'cold'
    AND m.clob_token_id_yes IS NOT NULL AND m.clob_token_id_yes != ''
    AND m.current_price_yes > $1
    AND m.current_price_yes < $2
    AND m.volume_24h >= $3
    AND EXISTS (
      SELECT 1 FROM price_history ph
      WHERE ph.token_id = m.clob_token_id_yes
        AND ph.time > NOW() - INTERVAL '24 hours'
      LIMIT 1
    )`;

  const selectCols = `
    m.id, m.condition_id, m.question, m.category,
    m.clob_token_id_yes, m.clob_token_id_no,
    m.current_price_yes, m.current_price_no,
    m.volume_24h, m.liquidity, m.end_date, m.is_active,
    m.market_type,
    m.tracking_status,
    m.market_score`;

  if (fetchBudgets.size === 0) {
    // Legacy single-query path.
    const sql = `
      SELECT ${selectCols}
      FROM markets m
      WHERE ${baseFilters}
        OR m.id = ANY($5::varchar[])
      ORDER BY m.volume_24h DESC NULLS LAST
      LIMIT $4
    `;
    return { sql, perTypeMode: false };
  }

  // Per-type UNION ALL path.
  const TYPE_SAFE_RE = /^[a-z_]+$/;
  const branches: string[] = [];
  for (const [type, budget] of fetchBudgets) {
    if (!TYPE_SAFE_RE.test(type)) {
      console.warn(`[PolymarketService] Skipping unsafe market_type in budget: '${type}'`);
      continue;
    }
    const safeBudget = Math.max(1, Math.floor(budget));
    branches.push(`
      (SELECT ${selectCols}
       FROM markets m
       WHERE ${baseFilters}
         AND m.market_type = '${type}'
       ORDER BY m.volume_24h DESC NULLS LAST
       LIMIT ${safeBudget})
    `);
  }
  // Always append a force-include branch (skips volume + price-history filters).
  branches.push(`
    (SELECT ${selectCols}
     FROM markets m
     WHERE m.id = ANY($4::varchar[])
       AND m.is_active = true
       AND m.is_resolved = false
       AND m.clob_token_id_yes IS NOT NULL)
  `);

  const sql = branches.join('\n      UNION ALL\n');
  return { sql, perTypeMode: true };
}
```

- [ ] **Step 3: Add tests for `buildFetchSQL`**

Append to `packages/dashboard/src/services/PolymarketService.test.ts`:

```typescript
import { buildFetchSQL } from './PolymarketService.js';

describe('buildFetchSQL', () => {
  it('returns the legacy single-query SQL when budgets is empty', () => {
    const { sql, perTypeMode } = buildFetchSQL(new Map());
    expect(perTypeMode).toBe(false);
    expect(sql).toContain('ORDER BY m.volume_24h DESC NULLS LAST');
    expect(sql).toContain('LIMIT $4');
    expect(sql).toContain('m.id = ANY($5::varchar[])');
    expect(sql).not.toContain('UNION ALL');
  });

  it('builds one sub-query per type plus a force-include branch', () => {
    const budgets = new Map([['crypto_daily', 8], ['event_short', 12]]);
    const { sql, perTypeMode } = buildFetchSQL(budgets);
    expect(perTypeMode).toBe(true);
    expect(sql).toContain("m.market_type = 'crypto_daily'");
    expect(sql).toContain("m.market_type = 'event_short'");
    expect(sql).toContain('LIMIT 8');
    expect(sql).toContain('LIMIT 12');
    expect(sql).toContain('m.id = ANY($4::varchar[])');
    // 3 branches (2 types + 1 force-include) → 2 UNION ALL joins.
    expect(sql.split('UNION ALL').length).toBe(3);
  });

  it('drops types with unsafe characters from the SQL (defence in depth)', () => {
    const budgets = new Map([
      ['crypto_daily', 5],
      ["bobby'; DROP TABLE--", 5],  // SQL injection attempt
    ]);
    const { sql } = buildFetchSQL(budgets);
    expect(sql).toContain("m.market_type = 'crypto_daily'");
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).not.toContain('bobby');
  });

  it('floors fractional budgets and clamps to a minimum of 1', () => {
    const budgets = new Map([['event_short', 0.5]]);
    const { sql } = buildFetchSQL(budgets);
    expect(sql).toContain('LIMIT 1');
  });
});
```

- [ ] **Step 4: Run the new tests to verify they fail**

Run: `pnpm vitest run packages/dashboard/src/services/PolymarketService.test.ts`
Expected: PASS for the existing `selectByTypeBudget` tests, FAIL for `buildFetchSQL` (function not yet exported in PolymarketService.ts).

- [ ] **Step 5: Re-run the tests after Step 2's `buildFetchSQL` is in place**

The implementation from Step 2 already added the function; re-running confirms it. If you split Step 2 and Step 3 across commits, you can skip this and proceed to wiring.

Run: `pnpm vitest run packages/dashboard/src/services/PolymarketService.test.ts`
Expected: all PASS.

- [ ] **Step 6: Wire `buildFetchSQL` into `fetchMarketsFromDb`**

In `packages/dashboard/src/services/PolymarketService.ts`, locate the SQL block in `fetchMarketsFromDb` (around lines 471-502). Replace it with:

```typescript
      const fetchBudgets = parsePerTypeBudget(process.env.SIGNAL_FETCH_BUDGET_PER_TYPE);
      const { sql: fetchSQL, perTypeMode } = buildFetchSQL(fetchBudgets);

      const fetchParams = perTypeMode
        ? [MIN_PRICE, MAX_PRICE, this.config.minVolume24h, forceIds]
        : [MIN_PRICE, MAX_PRICE, this.config.minVolume24h, this.config.marketsToFetch, forceIds];

      const marketsResult = await query<{
        id: string;
        condition_id: string;
        question: string;
        category: string;
        clob_token_id_yes: string;
        clob_token_id_no: string;
        current_price_yes: string;
        current_price_no: string;
        volume_24h: string;
        liquidity: string;
        end_date: Date;
        is_active: boolean;
        market_type: string | null;
        tracking_status: string | null;
        market_score: string | null;
      }>(fetchSQL, fetchParams);

      console.log(`[PolymarketService] Found ${marketsResult.rows.length} markets with recent price data (filtered by price_history, perTypeMode=${perTypeMode})`);
```

Verify `forceIds` is defined in scope. In the existing code (around line 449), `forceIds` is computed once via `parseForceIncludeIds(...)` and used. If the variable is local to a different scope, hoist its computation to before `fetchBudgets`.

- [ ] **Step 7: TypeScript build check**

Run: `pnpm --filter dashboard build`
Expected: build green.

- [ ] **Step 8: Re-run the full dashboard test suite**

Run: `pnpm vitest run packages/dashboard/src/services/`
Expected: all PASS, including the new `buildFetchSQL` tests.

- [ ] **Step 9: Commit**

```bash
git add packages/dashboard/src/services/PolymarketService.ts packages/dashboard/src/services/PolymarketService.test.ts
git commit -m "feat(polymarket-service): per-market_type sub-query union in fetchMarketsFromDb"
```

---

## Task 5: docker-compose env wiring

**Files:**
- Modify: `docker-compose.gcp.yml` — add the two new env vars to the `dashboard-api` service.

- [ ] **Step 1: Read the dashboard-api environment block**

Read `docker-compose.gcp.yml` from line 125 to line 200 (the dashboard-api service definition) to find the right insertion point near `MAX_SIGNAL_MARKETS`.

- [ ] **Step 2: Add the two env vars**

In `docker-compose.gcp.yml`, after the existing `MAX_SIGNAL_MARKETS: "45"` line (around line 146), insert:

```yaml
      # Per-`market_type` allocation for the SignalEngine feed pipeline.
      # Spec: docs/superpowers/specs/2026-05-26-signalengine-per-type-allocation-design.md
      # SIGNAL_FETCH_BUDGET_PER_TYPE: per-type LIMIT in the candidate fetch
      #   UNION ALL — guarantees event_short candidates enter the pool even
      #   though their volume_24h is lower than event_long.
      # SIGNAL_SLOTS_PER_TYPE: per-type slot allocation in selectDiversifiedMarkets
      #   — guarantees each market_type gets its share of MAX_SIGNAL_MARKETS.
      # Unset both vars to fall back to legacy volume-sorted single-query
      # behaviour (backward-compatible default).
      # Defaults sized for ALLOWED_MARKET_TYPES (crypto_intraday + crypto_daily +
      # event_financial + event_short) + a smaller event_long share for FLB
      # shadow measurement. Sum of slots = 50, raise MAX_SIGNAL_MARKETS to match.
      SIGNAL_FETCH_BUDGET_PER_TYPE: "crypto_intraday:30,crypto_daily:30,event_financial:40,event_short:40,event_long:60"
      SIGNAL_SLOTS_PER_TYPE: "crypto_intraday:8,crypto_daily:8,event_financial:12,event_short:12,event_long:10"
```

Also adjust the existing `MAX_SIGNAL_MARKETS: "45"` to `MAX_SIGNAL_MARKETS: "50"` (sum of `SIGNAL_SLOTS_PER_TYPE` = 8+8+12+12+10 = 50).

- [ ] **Step 3: YAML syntax check**

Run: `docker compose -f docker-compose.gcp.yml config > /dev/null && echo "compose YAML valid"`
Expected: `compose YAML valid` (or no error output).

- [ ] **Step 4: Commit**

```bash
git add docker-compose.gcp.yml
git commit -m "chore(compose): enable per-market_type SignalEngine allocation env vars"
```

---

## Task 6: Open PR and run CI

**Files:** (none — git operations only)

- [ ] **Step 1: Verify the branch is up to date**

Run: `git status` and confirm a clean working tree on the feature branch.

- [ ] **Step 2: Push branch and open PR**

```bash
gh auth status   # must show JaviMaligno
git push -u origin feat/signalengine-per-type-allocation
gh pr create --title "feat(signal-engine): per-market_type allocation for fair feed coverage" --body "$(cat <<'EOF'
## Summary

Closes the SignalEngine feed bug surfaced in daily-review #266: event_short was tracked + priced (18 markets, 229 bars/24h avg) but produced **0 generator predictions in any 24h window**. Three layers in the feed pipeline ignored \`market_type\`, each biasing toward high-volume types and collectively starving event_short.

Implementation per spec `docs/superpowers/specs/2026-05-26-signalengine-per-type-allocation-design.md`:
- **L1 (\`fetchMarketsFromDb\`)**: per-type sub-query UNION ALL with per-type LIMIT, replaces the single \`ORDER BY volume_24h DESC LIMIT N\` that excluded low-volume types from the candidate pool.
- **L2 (\`selectDiversifiedMarkets\`)**: \`byMarketType\` primary axis with ALLOWED_MARKET_TYPES-first underfill redistribution. Falls back to legacy \`byCategory\` path when env var unset.
- **L3 (\`computeSignals\`)**: round-robin per-type slice replaces \`activeMarkets.slice(0, N)\` so per-cycle distribution is guaranteed even if upstream feed is biased.

New helpers (all pure, unit-tested): \`parsePerTypeBudget\`, \`selectByTypeBudget\`, \`buildFetchSQL\`, \`pickMarketsForCycle\`.

Env vars (defaults proportional to ALLOWED_MARKET_TYPES, event_long minor share for FLB measurement):
- \`SIGNAL_FETCH_BUDGET_PER_TYPE\`: candidate-pool budget per type (sum ≈ 200).
- \`SIGNAL_SLOTS_PER_TYPE\`: per-cycle slot allocation per type (sum = 50 = MAX_SIGNAL_MARKETS).

## Patch vs root-cause classification

\`root-cause\` — fixes the structural bias in all 3 layers. Backward-compatible default (both env vars unset → legacy behaviour preserved) means rollback is a compose-only change, not a code revert.

## Test plan

- [x] Unit tests for all 4 new pure functions (parsePerTypeBudget, selectByTypeBudget, buildFetchSQL, pickMarketsForCycle) — see *.test.ts files in this PR.
- [x] Backward-compatibility verified by leaving existing PolymarketService tests untouched and re-running.
- [x] TypeScript build green.
- [ ] Post-deploy: \`generator_predictions\` for event_short produces > 0 rows in the first hour. Coverage query in plan Task 7 step 2.
- [ ] Post-deploy: \`event_long\` predictions reduced from ~27/hour to ~10/hour but still > 0 (expected — slot reallocation).
- [ ] Post-deploy (48h later): \`EdgeCapacityRefresher\` writes a fresh \`generator_edge\` row for event_short (the 201h-stale alarm clears).

## Spec

Approved and committed at \`docs/superpowers/specs/2026-05-26-signalengine-per-type-allocation-design.md\`. Implementation plan at \`docs/superpowers/plans/2026-05-26-signalengine-per-type-allocation.md\`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Wait for CI to pass**

Use: `gh pr checks <PR_NUMBER> --watch`
Expected: all checks green.

---

## Task 7: Post-deploy verification on the VM

**Files:** (none — verification only)

After the PR is merged and CI deploys to the VM:

- [ ] **Step 1: Verify the env vars are present on the VM**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker exec polymarket-dashboard-api env | grep SIGNAL_"
```
Expected output includes:
```
SIGNAL_FETCH_BUDGET_PER_TYPE=crypto_intraday:30,...
SIGNAL_SLOTS_PER_TYPE=crypto_intraday:8,...
MAX_SIGNAL_MARKETS=50
```

- [ ] **Step 2: Verify predictions are being generated for event_short**

Wait 1 hour after deploy for one full signal cycle, then:
```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"SELECT m.market_type, COUNT(DISTINCT g.market_id) markets, COUNT(*) preds FROM generator_predictions g JOIN markets m ON m.id::text=g.market_id::text WHERE g.time > NOW() - INTERVAL '1 hour' GROUP BY 1 ORDER BY 1\""
```
Expected: event_short row present with `markets > 0` and `preds > 0`. Before this PR the row was missing (0/0); a non-zero count is the success signal.

- [ ] **Step 3: Confirm `event_long` did not collapse**

The reduction from ~37 markets to 10 slots will reduce event_long predictions per cycle. Confirm it is still > 0 and not a downstream regression:
```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"SELECT m.market_type, COUNT(DISTINCT g.market_id) markets, COUNT(*) preds FROM generator_predictions g JOIN markets m ON m.id::text=g.market_id::text WHERE g.time > NOW() - INTERVAL '1 hour' GROUP BY 1 ORDER BY 1\""
```
Expected: event_long row with `markets ~ 10`, `preds > 0`.

- [ ] **Step 4: Confirm `EdgeCapacityRefresher` will measure event_short on the next nightly cron**

After 48h (one cron cycle past deploy):
```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"SELECT market_type, MAX(measured_at) latest, COUNT(*) n FROM generator_edge GROUP BY 1 ORDER BY 2 DESC\""
```
Expected: event_short row with `latest` within the last 24h (replacing the previous 2026-05-17 value).

- [ ] **Step 5: Update memory with the verification result**

If steps 1-4 succeed, add a short note to `project_session_2026-05-26_roadmap.md`:
```
## SignalEngine per-type allocation — DEPLOYED
- Verified <date>: event_short produces N predictions/h, event_long M, event_financial K.
- generator_edge for event_short refreshed at <timestamp> (gap closed from 201h pre-deploy).
```

If steps 1-4 fail, document the failure mode and decide: rollback (revert compose env vars to unset) or escalate.

---

## Spec coverage check

Cross-referencing the spec sections against the tasks:

- **L1 — DB fetch per-type sub-query union**: Task 4 (`buildFetchSQL`).
- **L2 — `selectDiversifiedMarkets` byMarketType**: Task 3 (`selectByTypeBudget` + wiring).
- **L3 — Cycle round-robin slice**: Task 2 (`pickMarketsForCycle`).
- **`parsePerTypeBudget` util**: Task 1.
- **Env vars + backward-compat default**: Tasks 1 (parser returns empty for unset), 3 (legacy path retained), 4 (legacy SQL retained), 5 (compose values).
- **Validation rules**: Task 1 covers `parsePerTypeBudget` malformed input. The "sum > maxTotal" cap is enforced in `selectByTypeBudget` Step 5 of Task 3. "Sum < total" is a warn (operator chooses to leave gaps); no code change needed.
- **Force-include semantics**: Task 3 explicitly excludes force-included from per-type budget. Task 4's force-include branch always appended.
- **Tests #1–#7 from spec**: covered by Task 1 (#1 parser), Task 4 (#2 SQL builder), Task 3 (#3 selector), Task 2 (#4 round-robin slice), Task 3/4 (#5 backward-compat via no-env-set tests inherited), Task 7 (#6 e2e on VM), Task 7 step 4 (#7 EdgeCapacityRefresher).

No spec section is uncovered. The integration test (#6 in the spec) is replaced by Tasks 7 step 2-4 — manual verification on the live VM with real data is more informative than a synthetic DB fixture for this particular pipeline.
