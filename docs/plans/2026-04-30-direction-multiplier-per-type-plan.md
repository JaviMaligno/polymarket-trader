# directionMultiplier per-(market_type) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `directionMultiplier` from a global pinned `-1.0` to a per-(market_type) categorical `{-1, +1}` chosen by the existing per-type optimizer. Bootstrap `event_financial=+1` immediately to stop the 7-day 17% WR bleed. Categorical-only domain prevents the continuous-drift class that motivated PR #104.

**Architecture:** Extend `DirectionMultiplierPolicy` with `perMarketType` field. Slot a new branch into `resolveDirectionMultiplier()` between segment match and global fallback. Compose the policy from `trading_config` (legacy) plus `signal_weights` (new). Add categorical entry to `PER_TYPE_PARAMETER_SPACE` and wire dm through the optimizer feedback loop (`mapOptunaParamsToRequest` + `BacktestService`).

**Tech Stack:** TypeScript + Vitest, pnpm monorepo (`packages/{dashboard,optimizer,data-collector,signals}`), PostgreSQL/TimescaleDB. Spec: `docs/plans/2026-04-30-direction-multiplier-per-type-design.md`.

---

## File Structure

| Path | Change | Responsibility |
|---|---|---|
| `packages/data-collector/src/database/init/028_direction_multiplier_per_type_seed.sql` | Create | Bootstrap rows in `signal_weights` for `signal_type='direction_multiplier'`, one per allowed market_type. Idempotent. |
| `packages/dashboard/src/services/DirectionMultiplierPolicy.ts` | Modify | Add `perMarketType?: Record<string, number>` to interface. Extend `sanitizeDirectionMultiplierPolicy` to clamp/filter perMarketType values. Extend `resolveDirectionMultiplier` with per-type branch between segment match and global. |
| `packages/dashboard/src/services/DirectionMultiplierPolicy.test.ts` | Modify | Add tests for per-type priority and sanitization. |
| `packages/dashboard/src/server.ts` | Modify (`policyProvider` closure ~line 584; bootstrap section near top) | Compose `perMarketType` from `signalWeightsRepo`. Add idempotent INSERT for bootstrap rows on startup. |
| `packages/optimizer/src/core/ParameterSpace.ts` | Modify (PER_TYPE_PARAMETER_SPACE export) | Add `combiner.directionMultiplier` as `categorical` with `choices: [-1.0, 1.0]`, PER_TYPE only. |
| `packages/optimizer/src/core/ParameterSpace.test.ts` | Modify | Add 2 regression tests: PER_TYPE includes dm as categorical with exact choices; never as float/int. |
| `packages/dashboard/src/services/OptimizationScheduler.ts` | Modify (`mapOptunaParamsToRequest` ~line 574; `WEIGHT_PARAM_MAP` ~line 907) | Forward `params['combiner.directionMultiplier']` to `combinerConfig.directionMultiplier`. Add `'combiner.directionMultiplier' → 'direction_multiplier'` to WEIGHT_PARAM_MAP. Optional min-lift gate. |
| `packages/dashboard/src/services/OptimizationScheduler.test.ts` | Modify | Tests for forward + WEIGHT_PARAM_MAP write + min-lift rejection. |
| `packages/dashboard/src/services/BacktestService.ts` | Modify (interface ~line 71; `createBacktest` ~line 181) | Add `directionMultiplier?: number` to `combinerConfig` interface. Apply via `combiner.setDirectionMultiplier()` after construction. |
| `packages/dashboard/src/services/BacktestService.test.ts` | Modify (or create if missing) | Test that combinerConfig.directionMultiplier propagates to combiner. |

No new services. No new tables. No frontend changes.

---

## Pre-flight: confirm working tree clean and on the right branch

- [ ] **Step 0: Verify state**

```bash
git status
git rev-parse --abbrev-ref HEAD
```

Expected: branch `feat/direction-multiplier-per-type`. Working tree shows the spec already committed in the previous step. No other staged or unstaged tracked changes.

If on a different branch:
```bash
git fetch origin main
git checkout -b feat/direction-multiplier-per-type origin/main
```

---

### Task 1: Migration `028_direction_multiplier_per_type_seed.sql`

**Files:**
- Create: `packages/data-collector/src/database/init/028_direction_multiplier_per_type_seed.sql`

- [ ] **Step 1: Write the migration**

Create `packages/data-collector/src/database/init/028_direction_multiplier_per_type_seed.sql`:

```sql
-- Bootstrap directionMultiplier per-(market_type) rows in signal_weights.
-- See docs/plans/2026-04-30-direction-multiplier-per-type-design.md for rationale.
--
-- crypto_*, event_short, event_long: -1 (status quo or shadow-validated).
-- event_financial: +1 (live 7d evidence: dm=-1 produces WR=17%; estimated WR=81% with +1).

INSERT INTO signal_weights (signal_type, market_type, weight, updated_at, is_enabled)
VALUES
  ('direction_multiplier', 'crypto_intraday', -1.0, NOW(), true),
  ('direction_multiplier', 'crypto_daily',    -1.0, NOW(), true),
  ('direction_multiplier', 'event_short',     -1.0, NOW(), true),
  ('direction_multiplier', 'event_long',      -1.0, NOW(), true),
  ('direction_multiplier', 'event_financial', 1.0,  NOW(), true)
ON CONFLICT (signal_type, market_type) DO NOTHING;
```

- [ ] **Step 2: Verify file contents**

```bash
cat packages/data-collector/src/database/init/028_direction_multiplier_per_type_seed.sql
```

Expected: file shows the INSERT block and the `ON CONFLICT DO NOTHING` clause.

- [ ] **Step 3: Verify the migration runs against a fresh database**

The init/*.sql files run on first volume creation. Sanity-check syntax by spinning up a throwaway TimescaleDB and applying every init file:

```bash
docker run --rm -d --name pm-init-check \
  -e POSTGRES_DB=pm -e POSTGRES_USER=pm -e POSTGRES_PASSWORD=pm \
  -p 25432:5432 timescale/timescaledb:latest-pg15
sleep 5
for f in packages/data-collector/src/database/init/*.sql; do
  echo "=== $f ===" && \
  docker exec -e PGPASSWORD=pm pm-init-check psql -U pm -d pm -f /dev/stdin < "$f" || break
done
docker exec -e PGPASSWORD=pm pm-init-check psql -U pm -d pm -c \
  "SELECT signal_type, market_type, weight FROM signal_weights WHERE signal_type='direction_multiplier' ORDER BY market_type;"
docker rm -f pm-init-check
```

Expected output of the final SELECT: 5 rows with weights `-1, -1, -1, -1, 1` for the listed market types.

- [ ] **Step 4: Commit**

```bash
git add packages/data-collector/src/database/init/028_direction_multiplier_per_type_seed.sql
git commit -m "feat(db): bootstrap direction_multiplier per-(market_type) rows (028)"
```

---

### Task 2: Runtime startup hook for existing deployments

**Files:**
- Modify: `packages/dashboard/src/server.ts` (near other migration/bootstrap inserts; the existing `signal_weights` per-type bootstrap from PR #143 is the reference pattern)

The init SQL only runs on first volume creation, so production VMs that have been running for months will not pick up new rows from a new `028_*.sql`. We add an idempotent runtime INSERT at dashboard-api startup. This mirrors the pattern used by migration `025_signal_weights_per_type.sql`.

- [ ] **Step 1: Locate the existing per-type bootstrap pattern**

```bash
grep -n "INSERT INTO signal_weights" packages/dashboard/src/server.ts || true
grep -rn "INSERT INTO signal_weights" packages/dashboard/src/ | head -5
```

Identify the file and line where the existing per-type bootstrap inserts run on startup. If it lives in a helper (e.g. `bootstrapSignalWeights.ts` or similar), add the new rows there. If it lives inline in `server.ts`, add them next to it.

- [ ] **Step 2: Write the failing test**

Locate or create `packages/dashboard/src/services/bootstrapDirectionMultiplier.test.ts` (the test file lives next to whatever helper holds the bootstrap insert; if the bootstrap is inline in server.ts, lift it into a small helper as described below).

If a helper does **not** exist, create `packages/dashboard/src/services/bootstrapDirectionMultiplier.ts` with this signature:

```typescript
import { query } from '../database/index.js';

export async function bootstrapDirectionMultiplierRows(): Promise<void> {
  await query(
    `INSERT INTO signal_weights (signal_type, market_type, weight, updated_at, is_enabled)
     VALUES
       ('direction_multiplier', 'crypto_intraday', -1.0, NOW(), true),
       ('direction_multiplier', 'crypto_daily',    -1.0, NOW(), true),
       ('direction_multiplier', 'event_short',     -1.0, NOW(), true),
       ('direction_multiplier', 'event_long',      -1.0, NOW(), true),
       ('direction_multiplier', 'event_financial', 1.0,  NOW(), true)
     ON CONFLICT (signal_type, market_type) DO NOTHING`
  );
}
```

Then create `packages/dashboard/src/services/bootstrapDirectionMultiplier.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../database/index.js', () => ({
  query: vi.fn(),
}));

import { query } from '../database/index.js';
import { bootstrapDirectionMultiplierRows } from './bootstrapDirectionMultiplier.js';

describe('bootstrapDirectionMultiplierRows', () => {
  beforeEach(() => vi.clearAllMocks());

  it('issues an INSERT … ON CONFLICT DO NOTHING for the 5 market types', async () => {
    (query as any).mockResolvedValueOnce({ rows: [] });
    await bootstrapDirectionMultiplierRows();
    expect(query).toHaveBeenCalledTimes(1);
    const sql = (query as any).mock.calls[0][0] as string;
    expect(sql).toMatch(/INSERT INTO signal_weights/);
    expect(sql).toMatch(/'direction_multiplier'/);
    expect(sql).toMatch(/'event_financial'.*1\.0/s);
    expect(sql).toMatch(/'crypto_intraday'.*-1\.0/s);
    expect(sql).toMatch(/ON CONFLICT \(signal_type, market_type\) DO NOTHING/);
  });
});
```

- [ ] **Step 3: Run test, verify it fails**

```bash
cd packages/dashboard
pnpm test bootstrapDirectionMultiplier.test.ts
```

Expected: FAIL — module `./bootstrapDirectionMultiplier.js` not found.

- [ ] **Step 4: Implement helper**

Save the helper code from Step 2 to `packages/dashboard/src/services/bootstrapDirectionMultiplier.ts`.

- [ ] **Step 5: Run test, verify it passes**

```bash
cd packages/dashboard
pnpm test bootstrapDirectionMultiplier.test.ts
```

Expected: PASS.

- [ ] **Step 6: Wire helper into server startup**

Modify `packages/dashboard/src/server.ts`. Locate the section where other startup bootstraps run (search for `signalWeightsRepo` or other init-time DB calls). Add:

```typescript
import { bootstrapDirectionMultiplierRows } from './services/bootstrapDirectionMultiplier.js';

// ...inside the main async startup block, alongside other startup INSERTs:
try {
  await bootstrapDirectionMultiplierRows();
  console.log('[server] direction_multiplier per-type bootstrap rows ensured');
} catch (err) {
  console.error('[server] Failed to bootstrap direction_multiplier rows:', err);
}
```

The block uses try/catch because failure here must not prevent dashboard startup — the rows may already exist or the DB may be temporarily unavailable; both cases are recoverable on the next boot.

- [ ] **Step 7: Type-check + run dashboard tests**

```bash
cd packages/dashboard
pnpm tsc --noEmit
pnpm test
```

Expected: tsc clean, all dashboard tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/dashboard/src/services/bootstrapDirectionMultiplier.ts \
        packages/dashboard/src/services/bootstrapDirectionMultiplier.test.ts \
        packages/dashboard/src/server.ts
git commit -m "feat(server): idempotent bootstrap of direction_multiplier per-type rows on startup"
```

---

### Task 3: Extend `DirectionMultiplierPolicy` interface + sanitize

**Files:**
- Modify: `packages/dashboard/src/services/DirectionMultiplierPolicy.ts`
- Modify: `packages/dashboard/src/services/DirectionMultiplierPolicy.test.ts`

- [ ] **Step 1: Write failing tests for sanitize**

Append to `packages/dashboard/src/services/DirectionMultiplierPolicy.test.ts`:

```typescript
import { sanitizeDirectionMultiplierPolicy } from './DirectionMultiplierPolicy.js';

describe('sanitizeDirectionMultiplierPolicy — perMarketType', () => {
  const baseInput = {
    global: -1,
    minMultiplier: -1.25,
    maxMultiplier: 1,
    segments: [],
  };

  it('passes through valid perMarketType values', () => {
    const result = sanitizeDirectionMultiplierPolicy({
      ...baseInput,
      perMarketType: { event_financial: 1, crypto_intraday: -1 },
    });
    expect(result.perMarketType).toEqual({ event_financial: 1, crypto_intraday: -1 });
  });

  it('clamps perMarketType values to [minMultiplier, maxMultiplier]', () => {
    const result = sanitizeDirectionMultiplierPolicy({
      ...baseInput,
      perMarketType: { event_financial: 5, crypto_intraday: -10 },
    });
    expect(result.perMarketType?.event_financial).toBe(1);     // maxMultiplier
    expect(result.perMarketType?.crypto_intraday).toBe(-1.25); // minMultiplier
  });

  it('drops NaN and Infinity entries from perMarketType', () => {
    const result = sanitizeDirectionMultiplierPolicy({
      ...baseInput,
      perMarketType: { good: 1, nan: NaN, inf: Infinity, neginf: -Infinity },
    });
    expect(result.perMarketType).toEqual({ good: 1 });
  });

  it('returns perMarketType undefined when input has no perMarketType', () => {
    const result = sanitizeDirectionMultiplierPolicy({ ...baseInput });
    expect(result.perMarketType).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, verify failure**

```bash
cd packages/dashboard
pnpm test DirectionMultiplierPolicy.test.ts
```

Expected: FAIL — `result.perMarketType` is undefined or test type errors because the interface lacks `perMarketType`.

- [ ] **Step 3: Extend interface**

In `packages/dashboard/src/services/DirectionMultiplierPolicy.ts`, locate the `DirectionMultiplierPolicy` interface and add the field:

```typescript
export interface DirectionMultiplierPolicy {
  global: number;
  perMarketType?: Record<string, number>;   // NEW
  minMultiplier: number;
  maxMultiplier: number;
  maxPositiveMultiplier?: number;
  segments: DirectionMultiplierSegment[];
  // ...other existing fields
}
```

- [ ] **Step 4: Extend `sanitizeDirectionMultiplierPolicy`**

In the same file, locate `sanitizeDirectionMultiplierPolicy` and add perMarketType handling. Insert (preserving existing logic for global/segments/etc.):

```typescript
export function sanitizeDirectionMultiplierPolicy(
  raw: Partial<DirectionMultiplierPolicy>
): DirectionMultiplierPolicy {
  // ...existing sanitization for global, segments, minMultiplier, maxMultiplier...
  const minMultiplier = /* existing */ -1.25;
  const maxMultiplier = /* existing */ 1;

  let perMarketType: Record<string, number> | undefined;
  if (raw.perMarketType && typeof raw.perMarketType === 'object') {
    perMarketType = {};
    for (const [marketType, value] of Object.entries(raw.perMarketType)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        perMarketType[marketType] = Math.max(minMultiplier, Math.min(maxMultiplier, value));
      }
      // NaN, Infinity, non-numbers → dropped
    }
    if (Object.keys(perMarketType).length === 0) perMarketType = undefined;
  }

  return {
    // ...existing fields,
    perMarketType,
  };
}
```

The exact integration depends on the existing sanitize structure; do not duplicate clamps that already exist for `global`. Read the function before editing.

- [ ] **Step 5: Run tests, verify pass**

```bash
cd packages/dashboard
pnpm test DirectionMultiplierPolicy.test.ts
```

Expected: PASS for all four new tests + existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/src/services/DirectionMultiplierPolicy.ts \
        packages/dashboard/src/services/DirectionMultiplierPolicy.test.ts
git commit -m "feat(direction-policy): add perMarketType field to DirectionMultiplierPolicy"
```

---

### Task 4: Extend `resolveDirectionMultiplier` with per-type branch

**Files:**
- Modify: `packages/dashboard/src/services/DirectionMultiplierPolicy.ts` (function `resolveDirectionMultiplier` ~line 165)
- Modify: `packages/dashboard/src/services/DirectionMultiplierPolicy.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/dashboard/src/services/DirectionMultiplierPolicy.test.ts`:

```typescript
import { resolveDirectionMultiplier } from './DirectionMultiplierPolicy.js';

describe('resolveDirectionMultiplier — perMarketType priority', () => {
  const ctx = {
    marketType: 'event_financial',
    currentPrice: 0.55,
    endDate: new Date('2026-12-31'),
    currentTime: new Date('2026-04-30'),
    question: 'Will X happen by Y?',
  };

  it('returns perMarketType[marketType] when no segment matches and a per-type entry exists', () => {
    const result = resolveDirectionMultiplier(
      {
        global: -1,
        perMarketType: { event_financial: 1 },
        segments: [],
        minMultiplier: -1.25,
        maxMultiplier: 1,
      } as any,
      ctx
    );
    expect(result.multiplier).toBe(1);
    expect(result.segmentId).toBeNull();
  });

  it('falls through to policy.global when perMarketType has no entry for the type', () => {
    const result = resolveDirectionMultiplier(
      {
        global: -1,
        perMarketType: { other_type: 1 },
        segments: [],
        minMultiplier: -1.25,
        maxMultiplier: 1,
      } as any,
      ctx
    );
    expect(result.multiplier).toBe(-1);
    expect(result.segmentId).toBeNull();
  });

  it('falls through to policy.global when perMarketType is undefined', () => {
    const result = resolveDirectionMultiplier(
      { global: -1, segments: [], minMultiplier: -1.25, maxMultiplier: 1 } as any,
      ctx
    );
    expect(result.multiplier).toBe(-1);
  });

  it('segment match still wins over perMarketType', () => {
    const segment = {
      id: 'seg-1',
      multiplier: 0.5,
      marketTypes: ['event_financial'],
      priceRange: { min: 0.5, max: 0.6 },
      durationBands: [],
      questionPatterns: [],
    };
    const result = resolveDirectionMultiplier(
      {
        global: -1,
        perMarketType: { event_financial: 1 },
        segments: [segment],
        minMultiplier: -1.25,
        maxMultiplier: 1,
      } as any,
      ctx
    );
    expect(result.multiplier).toBe(0.5);
    expect(result.segmentId).toBe('seg-1');
  });
});
```

- [ ] **Step 2: Run, verify failure**

```bash
cd packages/dashboard
pnpm test DirectionMultiplierPolicy.test.ts
```

Expected: FAIL on the first test — current implementation returns `policy.global = -1` because perMarketType branch does not exist.

- [ ] **Step 3: Add per-type branch**

In `packages/dashboard/src/services/DirectionMultiplierPolicy.ts`, locate `resolveDirectionMultiplier`. After the `if (!bestMatch)` line, replace the existing `return { multiplier: policy.global, ... }` block with:

```typescript
if (!bestMatch) {
  const perType = policy.perMarketType?.[context.marketType];
  if (perType !== undefined && Number.isFinite(perType)) {
    return {
      multiplier: perType,
      contextKey: buildDirectionContextKey(context),
      segmentId: null,
    };
  }
  return {
    multiplier: policy.global,
    contextKey: buildDirectionContextKey(context),
    segmentId: null,
  };
}
```

The segment-match branch (after `if (!bestMatch)`) stays unchanged.

- [ ] **Step 4: Run tests, verify all pass**

```bash
cd packages/dashboard
pnpm test DirectionMultiplierPolicy.test.ts
```

Expected: PASS for all 4 new tests + all existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/services/DirectionMultiplierPolicy.ts \
        packages/dashboard/src/services/DirectionMultiplierPolicy.test.ts
git commit -m "feat(direction-policy): perMarketType branch in resolveDirectionMultiplier"
```

---

### Task 5: Compose `perMarketType` from `signal_weights` in `policyProvider`

**Files:**
- Modify: `packages/dashboard/src/server.ts` (`policyProvider` closure ~line 584)

- [ ] **Step 1: Read the existing policyProvider**

```bash
sed -n '578,600p' packages/dashboard/src/server.ts
```

Familiarise yourself with the closure: it caches the policy with 60s TTL, reads `direction_multiplier_policy` from `tradingConfigRepo`, and sanitises before returning.

- [ ] **Step 2: Modify the closure to compose perMarketType**

Locate the `policyProvider` definition (around line 584). Replace its body with:

```typescript
const policyProvider = async (): Promise<DirectionMultiplierPolicy> => {
  const now = Date.now();
  if (cachedPolicy && now - cachedPolicy.fetchedAt < POLICY_TTL_MS) return cachedPolicy.data;

  const rawPolicy = await tradingConfigRepo.get<DirectionMultiplierPolicy>('direction_multiplier_policy');
  const allPerType = await signalWeightsRepo.getAllPerType();
  const perMarketType: Record<string, number> = {};
  for (const [marketType, signals] of Object.entries(allPerType)) {
    if (signals['direction_multiplier'] !== undefined) {
      perMarketType[marketType] = signals['direction_multiplier'];
    }
  }

  const merged: Partial<DirectionMultiplierPolicy> = {
    ...(rawPolicy ?? DEFAULT_DIRECTION_MULTIPLIER_POLICY),
    perMarketType: Object.keys(perMarketType).length > 0 ? perMarketType : undefined,
  };
  const data = sanitizeDirectionMultiplierPolicy(merged);
  cachedPolicy = { data, fetchedAt: now };
  return data;
};
```

The `signalWeightsRepo` import probably already exists in `server.ts`. If not:

```typescript
import { signalWeightsRepo } from './database/repositories.js';
```

- [ ] **Step 3: Type-check**

```bash
cd packages/dashboard
pnpm tsc --noEmit
```

Expected: clean.

- [ ] **Step 4: Run all dashboard tests**

```bash
cd packages/dashboard
pnpm test
```

Expected: PASS.

- [ ] **Step 5: Manual sanity check**

```bash
grep -A 18 "const policyProvider" packages/dashboard/src/server.ts | head -25
```

Confirm the closure now reads from `signalWeightsRepo.getAllPerType()` and merges into `perMarketType`.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/src/server.ts
git commit -m "feat(server): compose policy.perMarketType from signal_weights direction_multiplier rows"
```

---

### Task 6: ParameterSpace per-type entry + regression tests

**Files:**
- Modify: `packages/optimizer/src/core/ParameterSpace.ts`
- Modify: `packages/optimizer/src/core/ParameterSpace.test.ts`

- [ ] **Step 1: Write failing regression tests**

Append to `packages/optimizer/src/core/ParameterSpace.test.ts`:

```typescript
import { PER_TYPE_PARAMETER_SPACE } from './ParameterSpace.js';

describe('PER_TYPE_PARAMETER_SPACE — directionMultiplier', () => {
  it('exposes combiner.directionMultiplier as categorical with choices [-1, 1] only', () => {
    const dm = PER_TYPE_PARAMETER_SPACE.find(p => p.name === 'combiner.directionMultiplier');
    expect(dm).toBeDefined();
    expect(dm!.type).toBe('categorical');
    expect((dm as any).choices).toEqual([-1.0, 1.0]);
  });

  it('never exposes combiner.directionMultiplier as continuous (float/int)', () => {
    const dm = PER_TYPE_PARAMETER_SPACE.find(p => p.name === 'combiner.directionMultiplier');
    expect(dm?.type).not.toBe('float');
    expect(dm?.type).not.toBe('int');
  });
});
```

- [ ] **Step 2: Run, verify failure**

```bash
cd packages/optimizer
pnpm test ParameterSpace.test.ts
```

Expected: FAIL — `dm` is `undefined` because PER_TYPE_PARAMETER_SPACE does not currently include directionMultiplier.

- [ ] **Step 3: Add categorical entry to PER_TYPE_PARAMETER_SPACE**

In `packages/optimizer/src/core/ParameterSpace.ts`, locate the export `PER_TYPE_PARAMETER_SPACE`. Append to the array:

```typescript
{
  name: 'combiner.directionMultiplier',
  type: 'categorical',
  choices: [-1.0, 1.0],
  category: 'combiner',
  description: 'Sign of signal-to-side mapping. Per-market-type categorical to prevent continuous drift (issue #109).',
},
```

If the `categorical` type is not already in the `ParameterDefinition` discriminated union, also extend it to include `{ type: 'categorical'; choices: number[]; }`. Search for `type: 'float'` to find the union definition.

- [ ] **Step 4: Run tests**

```bash
cd packages/optimizer
pnpm test ParameterSpace.test.ts
```

Expected: PASS for the 2 new tests + existing 3 PR #104 tests still pass (FULL/MINIMAL spaces still exclude dm).

- [ ] **Step 5: Type-check from monorepo root**

```bash
pnpm tsc --noEmit
```

Expected: clean (no types broken in consumers of `ParameterDefinition`).

- [ ] **Step 6: Commit**

```bash
git add packages/optimizer/src/core/ParameterSpace.ts \
        packages/optimizer/src/core/ParameterSpace.test.ts
git commit -m "feat(optimizer): categorical directionMultiplier in PER_TYPE_PARAMETER_SPACE"
```

---

### Task 7: Wire dm through the optimizer feedback loop

**Files:**
- Modify: `packages/dashboard/src/services/OptimizationScheduler.ts`
- Modify: `packages/dashboard/src/services/OptimizationScheduler.test.ts`

This task closes the optimizer feedback loop: `mapOptunaParamsToRequest` forwards the trial's dm into `combinerConfig`, and `WEIGHT_PARAM_MAP` writes the optimizer's choice to `signal_weights`.

- [ ] **Step 1: Write failing test for `mapOptunaParamsToRequest` forward**

Append to `packages/dashboard/src/services/OptimizationScheduler.test.ts`:

```typescript
import { OptimizationScheduler } from './OptimizationScheduler.js';

describe('OptimizationScheduler.mapOptunaParamsToRequest — directionMultiplier forward', () => {
  it('forwards combiner.directionMultiplier to combinerConfig.directionMultiplier', () => {
    const scheduler = new OptimizationScheduler();
    const params = {
      'combiner.directionMultiplier': 1.0,
      'combiner.momentumWeight': 0.5,
      'risk.maxPositionSizePct': 5,
      'risk.stopLossPct': 25,
      'combiner.minCombinedConfidence': 0.4,
      'combiner.minCombinedStrength': 0.3,
    };
    const start = new Date('2026-04-20');
    const end = new Date('2026-04-30');
    const req = (scheduler as any).mapOptunaParamsToRequest(params, start, end);
    expect(req.combinerConfig.directionMultiplier).toBe(1.0);
  });

  it('passes undefined when combiner.directionMultiplier is absent (FULL strategy)', () => {
    const scheduler = new OptimizationScheduler();
    const params = {
      'combiner.momentumWeight': 0.5,
      'risk.maxPositionSizePct': 5,
      'risk.stopLossPct': 25,
      'combiner.minCombinedConfidence': 0.4,
      'combiner.minCombinedStrength': 0.3,
    };
    const start = new Date('2026-04-20');
    const end = new Date('2026-04-30');
    const req = (scheduler as any).mapOptunaParamsToRequest(params, start, end);
    expect(req.combinerConfig.directionMultiplier).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, verify failure**

```bash
cd packages/dashboard
pnpm test OptimizationScheduler.test.ts
```

Expected: FAIL — `req.combinerConfig.directionMultiplier` is undefined because the mapping does not exist.

- [ ] **Step 3: Add the forward**

In `packages/dashboard/src/services/OptimizationScheduler.ts` around line 574 (inside `mapOptunaParamsToRequest`'s `combinerConfig` literal), add:

```typescript
combinerConfig: {
  // existing fields...
  onlyDirection: params['combiner.onlyDirection'],
  directionMultiplier: params['combiner.directionMultiplier'] as number | undefined,
},
```

- [ ] **Step 4: Run tests, verify pass**

```bash
cd packages/dashboard
pnpm test OptimizationScheduler.test.ts
```

Expected: PASS for the 2 new tests + the existing PR #104 test ("excludes combiner.directionMultiplier from the Optuna parameter space" for FULL strategy) still passes.

- [ ] **Step 5: Write failing test for WEIGHT_PARAM_MAP write**

Append to `packages/dashboard/src/services/OptimizationScheduler.test.ts`:

```typescript
import { signalWeightsRepo } from '../database/repositories.js';

vi.mock('../database/repositories.js', () => ({
  signalWeightsRepo: {
    update: vi.fn(),
    updatePerType: vi.fn(),
  },
  tradingConfigRepo: { get: vi.fn(), set: vi.fn() },
}));

describe('OptimizationScheduler.applyPerTypeWeights — directionMultiplier write', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes direction_multiplier per-type when Optuna result includes it', async () => {
    const scheduler = new OptimizationScheduler();
    await (scheduler as any).applyPerTypeWeights('event_financial', {
      params: {
        'combiner.momentumWeight': 0.5,
        'combiner.directionMultiplier': 1.0,
      },
      sharpe: 0.4,
    });
    expect(signalWeightsRepo.updatePerType).toHaveBeenCalledWith(
      'direction_multiplier',
      'event_financial',
      1.0,
      expect.stringContaining('event_financial'),
    );
  });
});
```

The exact private method name to call (`applyPerTypeWeights` or similar) is whatever wraps the `WEIGHT_PARAM_MAP` loop in OptimizationScheduler.ts. Read the file to confirm and update the test accordingly.

- [ ] **Step 6: Run, verify failure**

```bash
cd packages/dashboard
pnpm test OptimizationScheduler.test.ts
```

Expected: FAIL — `direction_multiplier` is not in WEIGHT_PARAM_MAP.

- [ ] **Step 7: Add to WEIGHT_PARAM_MAP**

In `packages/dashboard/src/services/OptimizationScheduler.ts` around line 907, add the entry:

```typescript
const WEIGHT_PARAM_MAP: Record<string, string> = {
  'combiner.momentumWeight': 'momentum',
  'combiner.meanReversionWeight': 'mean_reversion',
  'combiner.ofiWeight': 'ofi',
  'combiner.hawkesWeight': 'hawkes',
  'combiner.volumeAnomalyWeight': 'volume_anomaly',
  'combiner.mlofiWeight': 'mlofi',
  'combiner.spreadCompressionWeight': 'spread_compression',
  'combiner.directionMultiplier': 'direction_multiplier',  // NEW
};
```

The `MIN_WEIGHT = -1.5; MAX_WEIGHT = 3.0` clamp around line 917 already covers `{-1, +1}` correctly — values stay within bounds untouched.

- [ ] **Step 8: Run tests**

```bash
cd packages/dashboard
pnpm test OptimizationScheduler.test.ts
```

Expected: PASS for the new test + all existing tests still pass.

- [ ] **Step 9: Add optional min-lift gate**

Still in `applyPerTypeWeights` (or whichever method runs the WEIGHT_PARAM_MAP loop), add the min-lift check **before** the `updatePerType` call for `direction_multiplier`:

```typescript
const MIN_LIFT = parseFloat(process.env.OPTIMIZER_DM_FLIP_MIN_LIFT ?? '0');
// ...inside the loop:
for (const [paramKey, signalType] of Object.entries(WEIGHT_PARAM_MAP)) {
  const rawWeight = result.params[paramKey];
  if (rawWeight === undefined || rawWeight === null) continue;
  const weight = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, Number(rawWeight)));

  // Min-lift gate for direction_multiplier flips:
  if (signalType === 'direction_multiplier' && MIN_LIFT > 0) {
    const currentDm = await signalWeightsRepo.getPerType('direction_multiplier', marketType);
    if (currentDm !== null && currentDm !== weight) {
      // sharpe lift comes from result.sharpe (this trial) vs result.previousSharpe (prior cycle).
      // If previousSharpe is unavailable (first cycle for this type), allow the flip.
      const lift = (result.sharpe ?? 0) - (result.previousSharpe ?? -Infinity);
      if (lift < MIN_LIFT) {
        console.log(
          `[OptimizationScheduler] Skipping direction_multiplier flip for ${marketType}: ` +
          `lift=${lift.toFixed(3)} < min_lift=${MIN_LIFT}`
        );
        continue;
      }
    }
  }

  try {
    await signalWeightsRepo.updatePerType(signalType, marketType, weight, /* reason */);
    // existing logging
  } catch (err) { /* existing */ }
}
```

`signalWeightsRepo.getPerType(signalType, marketType)` may not exist yet. Add it to `packages/dashboard/src/database/repositories.ts`:

```typescript
async getPerType(signalType: string, marketType: string): Promise<number | null> {
  const result = await query<{ weight: number }>(
    `SELECT weight FROM signal_weights
     WHERE signal_type = $1 AND market_type = $2 AND is_enabled = true`,
    [signalType, marketType]
  );
  return result.rows[0] ? Number(result.rows[0].weight) : null;
},
```

The gate is gated itself: `MIN_LIFT > 0` only — default `0` means flips proceed unconditionally, no behaviour change.

- [ ] **Step 10: Write failing test for min-lift rejection**

Append to `packages/dashboard/src/services/OptimizationScheduler.test.ts`:

```typescript
describe('OptimizationScheduler — direction_multiplier min-lift gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPTIMIZER_DM_FLIP_MIN_LIFT = '0.10';
  });
  afterEach(() => {
    delete process.env.OPTIMIZER_DM_FLIP_MIN_LIFT;
  });

  it('skips direction_multiplier flip when sharpe lift < OPTIMIZER_DM_FLIP_MIN_LIFT', async () => {
    (signalWeightsRepo as any).getPerType = vi.fn().mockResolvedValueOnce(-1.0);
    const scheduler = new OptimizationScheduler();
    await (scheduler as any).applyPerTypeWeights('crypto_intraday', {
      params: { 'combiner.directionMultiplier': 1.0 },
      sharpe: 0.50,
      previousSharpe: 0.45, // lift = 0.05 < 0.10
    });
    const dmCalls = (signalWeightsRepo.updatePerType as any).mock.calls.filter(
      (c: any[]) => c[0] === 'direction_multiplier'
    );
    expect(dmCalls).toHaveLength(0);
  });

  it('proceeds with flip when lift exceeds the threshold', async () => {
    (signalWeightsRepo as any).getPerType = vi.fn().mockResolvedValueOnce(-1.0);
    const scheduler = new OptimizationScheduler();
    await (scheduler as any).applyPerTypeWeights('crypto_intraday', {
      params: { 'combiner.directionMultiplier': 1.0 },
      sharpe: 0.80,
      previousSharpe: 0.45, // lift = 0.35 > 0.10
    });
    expect(signalWeightsRepo.updatePerType).toHaveBeenCalledWith(
      'direction_multiplier',
      'crypto_intraday',
      1.0,
      expect.any(String),
    );
  });
});
```

- [ ] **Step 11: Run tests, verify pass**

```bash
cd packages/dashboard
pnpm test OptimizationScheduler.test.ts
```

Expected: PASS for the 2 new gate tests + all earlier OptimizationScheduler tests.

- [ ] **Step 12: Commit**

```bash
git add packages/dashboard/src/services/OptimizationScheduler.ts \
        packages/dashboard/src/services/OptimizationScheduler.test.ts \
        packages/dashboard/src/database/repositories.ts
git commit -m "feat(optimizer): wire direction_multiplier through per-type feedback loop with min-lift gate"
```

---

### Task 8: BacktestService applies dm to trial combiner

**Files:**
- Modify: `packages/dashboard/src/services/BacktestService.ts` (interface ~line 71; `createBacktest` ~line 181)
- Modify or create: `packages/dashboard/src/services/BacktestService.test.ts`

- [ ] **Step 1: Locate or create the test file**

```bash
ls packages/dashboard/src/services/BacktestService.test.ts 2>/dev/null \
  || echo "not found — create it"
```

If it does not exist, create a minimal file with the imports needed for this test. If it does exist, append a new `describe` block.

- [ ] **Step 2: Write failing test**

```typescript
// packages/dashboard/src/services/BacktestService.test.ts
import { describe, it, expect, vi } from 'vitest';
import { BacktestService } from './BacktestService.js';

// Mock external deps minimally:
vi.mock('../database/index.js', () => ({ query: vi.fn(() => Promise.resolve({ rows: [] })) }));
vi.mock('@polymarket-trader/backtest', () => ({
  createBacktestEngine: vi.fn(() => ({
    run: vi.fn(() => Promise.resolve({ /* minimal result */ })),
  })),
}));

describe('BacktestService — combinerConfig.directionMultiplier propagates', () => {
  it('applies directionMultiplier to combiner before backtest run when provided', async () => {
    const setDirectionMultiplierSpy = vi.fn();

    // Inject a combiner factory or capture the constructed combiner.
    // The cleanest route: spy on the WeightedAverageCombiner.setDirectionMultiplier
    // method via prototype after the BacktestService constructs the combiner.

    const service = new BacktestService(/* config */);
    const request = {
      startDate: '2026-04-20',
      endDate: '2026-04-30',
      initialCapital: 10000,
      signalTypes: ['momentum'],
      combinerConfig: {
        momentumWeight: 0.5,
        directionMultiplier: 1.0,
      },
    };

    // Capture the combiner the service builds: easiest is to instrument
    // WeightedAverageCombiner.prototype.setDirectionMultiplier before
    // calling createBacktest.
    const { WeightedAverageCombiner } = await import('@polymarket-trader/signals');
    const original = WeightedAverageCombiner.prototype.setDirectionMultiplier;
    WeightedAverageCombiner.prototype.setDirectionMultiplier = setDirectionMultiplierSpy;

    try {
      await (service as any).createBacktest('test', request);
      expect(setDirectionMultiplierSpy).toHaveBeenCalledWith(1.0);
    } finally {
      WeightedAverageCombiner.prototype.setDirectionMultiplier = original;
    }
  });

  it('does not call setDirectionMultiplier when directionMultiplier is undefined', async () => {
    const setDirectionMultiplierSpy = vi.fn();
    const service = new BacktestService(/* config */);
    const request = {
      startDate: '2026-04-20',
      endDate: '2026-04-30',
      initialCapital: 10000,
      signalTypes: ['momentum'],
      combinerConfig: { momentumWeight: 0.5 },
    };
    const { WeightedAverageCombiner } = await import('@polymarket-trader/signals');
    const original = WeightedAverageCombiner.prototype.setDirectionMultiplier;
    WeightedAverageCombiner.prototype.setDirectionMultiplier = setDirectionMultiplierSpy;
    try {
      await (service as any).createBacktest('test', request);
      expect(setDirectionMultiplierSpy).not.toHaveBeenCalled();
    } finally {
      WeightedAverageCombiner.prototype.setDirectionMultiplier = original;
    }
  });
});
```

If the existing `BacktestService.test.ts` setup is more elaborate (with full mocks for engine, market data, etc.), reuse those mocks. The two new tests can be added alongside existing ones.

- [ ] **Step 3: Run, verify failure**

```bash
cd packages/dashboard
pnpm test BacktestService.test.ts
```

Expected: FAIL — TS compile error because `directionMultiplier` is not on `combinerConfig` interface; or runtime expectation fails because the service does not call `setDirectionMultiplier`.

- [ ] **Step 4: Add field to interface**

In `packages/dashboard/src/services/BacktestService.ts` around line 71:

```typescript
combinerConfig?: {
  momentumWeight?: number;
  meanReversionWeight?: number;
  ofiWeight?: number;
  hawkesWeight?: number;
  volumeAnomalyWeight?: number;
  mlofiWeight?: number;
  spreadCompressionWeight?: number;
  minCombinedConfidence?: number;
  minCombinedStrength?: number;
  onlyDirection?: string | null;
  conflictResolution?: string;
  consensusDiscountFloor?: number;
  directionMultiplier?: number;  // NEW
};
```

- [ ] **Step 5: Apply dm after combiner construction**

In `packages/dashboard/src/services/BacktestService.ts` around line 181 (after `const combiner = new WeightedAverageCombiner(...)`):

```typescript
const combiner = new WeightedAverageCombiner(weights, cc ? { ... } : undefined);
if (cc?.directionMultiplier !== undefined && Number.isFinite(cc.directionMultiplier)) {
  combiner.setDirectionMultiplier(cc.directionMultiplier);
}
```

- [ ] **Step 6: Run tests, verify pass**

```bash
cd packages/dashboard
pnpm test BacktestService.test.ts
```

Expected: PASS for the 2 new tests + all existing BacktestService tests still pass.

- [ ] **Step 7: Commit**

```bash
git add packages/dashboard/src/services/BacktestService.ts \
        packages/dashboard/src/services/BacktestService.test.ts
git commit -m "feat(backtest): apply directionMultiplier from trial combinerConfig to combiner"
```

---

### Task 9: Integration smoke — full type-check + test sweep

**Files:**
- None (verification only)

- [ ] **Step 1: Full monorepo type-check**

```bash
pnpm tsc --noEmit
```

Expected: clean, no type errors anywhere.

- [ ] **Step 2: Full test sweep**

```bash
pnpm test
```

Expected: all tests across `packages/{dashboard,optimizer,signals,backtest,data-collector}` pass.

- [ ] **Step 3: Verify regression tests still hold**

```bash
cd packages/optimizer
pnpm test ParameterSpace.test.ts
cd ../dashboard
pnpm test OptimizationScheduler.test.ts -- -t "excludes combiner.directionMultiplier"
pnpm test OptimizationScheduler.test.ts -- -t "always enforces direction_multiplier to -1.0"
```

Expected:
- PR #104 regression test "excludes combiner.directionMultiplier from the Optuna parameter space" (FULL strategy) → PASS unchanged.
- PR #104 regression test "always enforces direction_multiplier to -1.0 after a successful optimization" (FULL strategy) → PASS unchanged.
- 2 new tests in `ParameterSpace.test.ts` (PER_TYPE includes dm as categorical) → PASS.

These four tests jointly enforce: dm is **never** continuous, **only** categorical in PER_TYPE, and the FULL strategy still pins dm globally.

- [ ] **Step 4: Build dashboard image locally (optional sanity)**

```bash
docker build -t polymarket-dashboard-api:dm-per-type -f packages/dashboard/Dockerfile .
```

Expected: build succeeds.

- [ ] **Step 5: Commit any leftover lint fixes**

```bash
git status
# if anything remains, fix and commit:
git add -p && git commit -m "chore: lint/format fixes"
```

---

### Task 10: Pre-PR checklist + PR creation

- [ ] **Step 1: Re-read the design spec and verify each §11 file is covered**

```bash
cat docs/plans/2026-04-30-direction-multiplier-per-type-design.md | sed -n '/^## 11/,/^## /p'
```

Walk through the file list. For each, confirm a Task above either creates or modifies it. The expected coverage:

| Spec §11 entry | Task |
|---|---|
| `028_direction_multiplier_per_type_seed.sql` | Task 1 |
| `ParameterSpace.ts` + `.test.ts` | Task 6 |
| `DirectionMultiplierPolicy.ts` + `.test.ts` | Tasks 3, 4 |
| `server.ts` (policyProvider + bootstrap) | Tasks 2, 5 |
| `OptimizationScheduler.ts` + `.test.ts` | Task 7 |
| `BacktestService.ts` + `.test.ts` | Task 8 |

- [ ] **Step 2: Push branch + open PR**

```bash
gh auth switch --user JaviMaligno
git push -u origin feat/direction-multiplier-per-type
gh pr create --title "feat: directionMultiplier per-(market_type) categorical via per-type optimizer" \
  --body-file - <<'EOF'
## Summary

Move `directionMultiplier` from a global pinned `-1.0` to per-(market_type) categorical `{-1, +1}` chosen by the existing per-type optimizer. Bootstrap `event_financial=+1` immediately.

Spec: `docs/plans/2026-04-30-direction-multiplier-per-type-design.md`
Plan: `docs/plans/2026-04-30-direction-multiplier-per-type-plan.md`

## Why

`event_financial` 7d WR = 17.4% under global `dm=-1`. Estimated 81% with `dm=+1`. Other types (crypto_*, event_short) keep `-1` because that's status-quo or shadow-validated.

The historical drift events (PR #97 / #104) were caused by **continuous-domain** dm in optimizer over small backtest windows. Categorical-only `{-1, +1}` makes drift impossible by construction; the regression tests from PR #104 still pass.

## Architecture

Extend `DirectionMultiplierPolicy` with `perMarketType?: Record<string, number>`. Slot a new branch into `resolveDirectionMultiplier()` between segment match and global fallback. Compose policy from `trading_config` (legacy) + `signal_weights` (new). Wire dm through optimizer feedback loop (`mapOptunaParamsToRequest` + `BacktestService`).

Zero changes to `WeightedAverageCombiner`, `DirectionResolver`, `BacktestEngine`, `SignalEngine`. Concentrated in pure functions and one bootstrap helper.

## Guardrails

- Categorical-only domain in optimizer — drift physically impossible.
- OOS gate intact — bad dm cannot reach production.
- New `OPTIMIZER_DM_FLIP_MIN_LIFT` env var (default `0`, disabled). When `> 0`, requires Sharpe lift > threshold to flip a market_type's existing dm.
- Bootstrap idempotent (`ON CONFLICT DO NOTHING`).

## Verification post-deploy

See spec §9. Quick check immediately after deploy:

```sql
SELECT signal_type, market_type, weight FROM signal_weights
WHERE signal_type = 'direction_multiplier' ORDER BY market_type;
-- Expect 5 rows; event_financial = 1, others = -1.
```

After 24h:

```sql
SELECT m.market_type, pp.applied_direction_multiplier, COUNT(*) trades,
       COUNT(*) FILTER (WHERE realized_pnl > 0) wins
FROM paper_positions pp JOIN markets m ON pp.market_id = m.id
WHERE pp.opened_at > '<deploy_time>' AND pp.realized_pnl IS NOT NULL
GROUP BY m.market_type, pp.applied_direction_multiplier;
-- Expect event_financial trades to show applied_direction_multiplier = 1.
```

## Test plan

- [x] Migration parses against fresh TimescaleDB.
- [x] `DirectionMultiplierPolicy` per-type priority tests (segment > perMarketType > global).
- [x] `sanitizeDirectionMultiplierPolicy` clamps + drops invalid perMarketType entries.
- [x] `policyProvider` composes from `signalWeightsRepo`.
- [x] `PER_TYPE_PARAMETER_SPACE` exposes dm as categorical with choices `[-1, 1]` only; never as float/int.
- [x] FULL/MINIMAL spaces still exclude dm (PR #104 regression tests).
- [x] FULL-strategy `updateStrategy` still pins dm to `-1.0` (PR #104 regression).
- [x] `mapOptunaParamsToRequest` forwards `combiner.directionMultiplier`.
- [x] WEIGHT_PARAM_MAP writes `direction_multiplier` per market_type.
- [x] Min-lift gate skips flip when lift < threshold; proceeds when above.
- [x] BacktestService applies `combinerConfig.directionMultiplier` to combiner before run.
- [ ] Post-deploy: `event_financial` 7d WR rises from 17% to >50%.
- [ ] Post-deploy: no regression in crypto_*, event_short WR.

## Out of scope

- Deprecating `DirectionMultiplierLearningService` (PR-2, +1 week contingent on success).
- Removing `applied_direction_multiplier_segment` etc. (PR-3, +2-3 weeks).
- Sub-segmentation by priceBucket × durationBand (deferred until volume justifies).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

Note: the active GitHub account must be `JaviMaligno` for the merge push to trigger Deploy to GCP — `JavierSapiraAI` is on-org and would 403 on workflow_dispatch.

- [ ] **Step 3: Confirm CI passes**

```bash
gh pr checks
```

Wait for the typecheck + test workflow. If anything fails, address the failure on the same branch and push a fix.

---

## Self-review checklist (post-merge)

After the PR is merged and Deploy to GCP fires:

- [ ] On VM: `git log --oneline -3` shows the merge commit at HEAD.
- [ ] On VM: `docker compose ps` shows `dashboard-api` and `data-collector` healthy.
- [ ] DB: `SELECT * FROM signal_weights WHERE signal_type='direction_multiplier'` returns 5 rows with bootstrap values.
- [ ] Logs: `docker logs polymarket-dashboard-api | grep "direction_multiplier per-type bootstrap"` shows the boot message once.
- [ ] After ~6h (first per-type cycle): `signal_weights` row for at least one type shows `updated_at > deploy_time`.
- [ ] After ~24h: `paper_positions.applied_direction_multiplier` for `event_financial` trades shows `1.0` (post-deploy).
- [ ] After 7d: event_financial 7d WR > 50% (success criterion, see spec §9).
