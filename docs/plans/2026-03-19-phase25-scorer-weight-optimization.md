# Phase 2.5 — MarketScorer Weight Optimization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Optimize the 5 MarketScorer dimension weights (tradeability, liquidity, volatility, ttr, dataQuality) using closed trade outcomes, so markets are scored in a way that predicts profitable trades.

**Architecture:** A new `scorer_weights` DB table stores the current weights; MarketScorer loads them at scoring time (with fallback to hardcoded defaults). A new `ScorerWeightOptimizer` service runs a random-search optimization: for each trial it recomputes every closed trade's score using trial weights, then maximizes Pearson correlation(score, realized_pnl). A weekly scheduler job triggers it once ≥ 30 closed trades with score dimensions are available.

**Tech Stack:** TypeScript, PostgreSQL/TimescaleDB, vitest, existing `query()` helper from `packages/data-collector/src/database/connection.ts`.

---

## Context

- `paper_positions.score_dimensions_at_entry` (JSONB) — captures `{tradeability, liquidity, ttr, volatility: null, dataQuality: null}` when a position is opened. `volatility` and `dataQuality` are null because they require the price_history LATERAL JOIN that only MarketScorer has.
- Since only 3 dims are captured at entry, the optimizer only tunes the relative weight of those 3. Volatility and dataQuality weights stay at their current defaults in the DB row.
- `compositeScore()` already handles null dims by normalizing `sumW` over available dims — so passing partial dims (null volatility/dataQuality) to the objective is safe.
- Current hardcoded weights: `{ tradeability: 0.30, liquidity: 0.25, volatility: 0.20, ttr: 0.15, dataQuality: 0.10 }`

---

### Task 1: DB migration + `ScorerWeights` interface + `compositeScore` accepts weights

**Files:**
- Create: `packages/data-collector/src/database/init/007_scorer_weights.sql`
- Modify: `packages/data-collector/src/services/MarketScorer.ts` (types + compositeScore signature)
- Test: `packages/data-collector/src/services/MarketScorer.test.ts` (add compositeScore with custom weights tests)

**Step 1: Create the migration file**

```sql
-- packages/data-collector/src/database/init/007_scorer_weights.sql
-- Stores the current MarketScorer dimension weights (single-row table).
-- MarketScorer reads from here at each scoring run; fallback to code defaults.
CREATE TABLE IF NOT EXISTS scorer_weights (
  id             SERIAL PRIMARY KEY,
  tradeability   FLOAT NOT NULL DEFAULT 0.30,
  liquidity      FLOAT NOT NULL DEFAULT 0.25,
  volatility     FLOAT NOT NULL DEFAULT 0.20,
  ttr            FLOAT NOT NULL DEFAULT 0.15,
  data_quality   FLOAT NOT NULL DEFAULT 0.10,
  n_trades       INT,        -- trades used in last optimization
  n_trials       INT,        -- trials run in last optimization
  best_value     FLOAT,      -- best Pearson correlation achieved
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Seed default row (only if table is empty)
INSERT INTO scorer_weights (tradeability, liquidity, volatility, ttr, data_quality)
SELECT 0.30, 0.25, 0.20, 0.15, 0.10
WHERE NOT EXISTS (SELECT 1 FROM scorer_weights);
```

**Step 2: Add `ScorerWeights` interface and update `compositeScore` in MarketScorer.ts**

In `packages/data-collector/src/services/MarketScorer.ts`:

Add `ScorerWeights` interface right after `ScoreDimensions` (around line 28):
```typescript
export interface ScorerWeights {
  tradeability: number;
  liquidity: number;
  volatility: number;
  ttr: number;
  dataQuality: number;
}
```

Change `compositeScore` signature to accept optional weights (find this method — it iterates over available dims and normalizes by sumW):
```typescript
static compositeScore(dims: ScoreDimensions, weights: ScorerWeights = WEIGHTS): number {
  const available: Array<[number, number]> = [
    [weights.tradeability, dims.tradeability],
    [weights.liquidity, dims.liquidity],
    [weights.volatility, dims.volatility ?? NaN],
    [weights.ttr, dims.ttr],
    [weights.dataQuality, dims.dataQuality ?? NaN],
  ].filter(([, v]) => !isNaN(v) && v != null) as Array<[number, number]>;
  const sumW = available.reduce((s, [w]) => s + w, 0);
  if (sumW === 0) return 0;
  return available.reduce((s, [w, v]) => s + w * v, 0) / sumW;
}
```

Note: look at the actual current implementation to preserve its null-handling logic — just add the `weights` parameter.

**Step 3: Write failing tests**

Add to `packages/data-collector/src/services/MarketScorer.test.ts`:
```typescript
describe('compositeScore with custom weights', () => {
  it('uses provided weights instead of defaults', () => {
    const dims: ScoreDimensions = {
      tradeability: 1.0,
      liquidity: 0.0,
      volatility: null,
      ttr: 0.0,
      dataQuality: null,
    };
    // With default weights: tradeability=0.30 dominates over ttr=0.15 with nulls removed
    // With custom weights: tradeability=0.0 → score should be 0
    const customWeights: ScorerWeights = {
      tradeability: 0.0,
      liquidity: 1.0,
      volatility: 0.20,
      ttr: 0.15,
      dataQuality: 0.10,
    };
    expect(MarketScorer.compositeScore(dims, customWeights)).toBe(0);
  });

  it('falls back to default weights when no weights provided', () => {
    const dims: ScoreDimensions = {
      tradeability: 1.0, liquidity: 0.0, volatility: null, ttr: 0.0, dataQuality: null,
    };
    const withDefault = MarketScorer.compositeScore(dims);
    const withExplicit = MarketScorer.compositeScore(dims, WEIGHTS);
    expect(withDefault).toBe(withExplicit);
  });
});
```

**Step 4: Run tests**

```bash
pnpm test --filter data-collector
```
Expected: new tests FAIL (compositeScore doesn't accept weights yet)

**Step 5: Implement the change**

Make the edit to `MarketScorer.ts` as described in Step 2. Preserve all existing behavior — only change the signature and replace hardcoded `WEIGHTS` references inside `compositeScore` with the parameter.

**Step 6: Run tests again**

```bash
pnpm test --filter data-collector
```
Expected: all tests PASS

**Step 7: Commit**

```bash
git add packages/data-collector/src/database/init/007_scorer_weights.sql \
        packages/data-collector/src/services/MarketScorer.ts \
        packages/data-collector/src/services/MarketScorer.test.ts
git commit -m "feat: add scorer_weights table and compositeScore accepts custom weights"
```

---

### Task 2: `MarketScorer.loadWeights()` + `scoreAllMarkets` uses DB weights

**Files:**
- Modify: `packages/data-collector/src/services/MarketScorer.ts`
- Test: `packages/data-collector/src/services/MarketScorer.test.ts`

**Step 1: Write failing test for loadWeights fallback**

In `MarketScorer.test.ts`, add a test that mocks `query` to throw and expects the hardcoded defaults:
```typescript
import { vi } from 'vitest';
import * as connection from '../database/connection.js';

describe('loadWeights', () => {
  it('returns hardcoded WEIGHTS when DB query fails', async () => {
    vi.spyOn(connection, 'query').mockRejectedValueOnce(new Error('DB down'));
    const weights = await MarketScorer.loadWeights();
    expect(weights.tradeability).toBe(WEIGHTS.tradeability);
    expect(weights.liquidity).toBe(WEIGHTS.liquidity);
    expect(weights.ttr).toBe(WEIGHTS.ttr);
    vi.restoreAllMocks();
  });

  it('returns hardcoded WEIGHTS when scorer_weights table is empty', async () => {
    vi.spyOn(connection, 'query').mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    const weights = await MarketScorer.loadWeights();
    expect(weights.tradeability).toBe(WEIGHTS.tradeability);
    vi.restoreAllMocks();
  });
});
```

**Step 2: Run tests**

```bash
pnpm test --filter data-collector
```
Expected: FAIL with "loadWeights is not a function"

**Step 3: Implement `loadWeights` static method**

Add to `MarketScorer` class (before `scoreAllMarkets`):
```typescript
static async loadWeights(): Promise<ScorerWeights> {
  try {
    const result = await query<{
      tradeability: number;
      liquidity: number;
      volatility: number;
      ttr: number;
      data_quality: number;
    }>(
      `SELECT tradeability, liquidity, volatility, ttr, data_quality
       FROM scorer_weights
       ORDER BY id DESC LIMIT 1`,
    );
    if (result.rows.length > 0) {
      const r = result.rows[0];
      return {
        tradeability: r.tradeability,
        liquidity: r.liquidity,
        volatility: r.volatility,
        ttr: r.ttr,
        dataQuality: r.data_quality,
      };
    }
  } catch {
    // Table may not exist yet — fall through to defaults
  }
  return { ...WEIGHTS };
}
```

**Step 4: Update `scoreAllMarkets` to load weights from DB**

At the start of `scoreAllMarkets()`, after the logger call, add:
```typescript
const weights = await MarketScorer.loadWeights();
const NORM = weights.tradeability + weights.liquidity + weights.ttr;
```

Then replace all `WEIGHTS.tradeability`, `WEIGHTS.liquidity`, `WEIGHTS.ttr` in the Pass 1 SQL template literals with `weights.tradeability`, `weights.liquidity`, `weights.ttr`.

In Pass 2, change the `compositeScore` call to pass weights:
```typescript
const score = MarketScorer.compositeScore({
  tradeability,
  liquidity,
  volatility,
  ttr,
  dataQuality,
}, weights);
```

**Step 5: Run tests**

```bash
pnpm test --filter data-collector
```
Expected: all tests PASS

**Step 6: Commit**

```bash
git add packages/data-collector/src/services/MarketScorer.ts \
        packages/data-collector/src/services/MarketScorer.test.ts
git commit -m "feat: MarketScorer loads dimension weights from DB (fallback to hardcoded)"
```

---

### Task 3: `ScorerWeightOptimizer` service

**Files:**
- Create: `packages/data-collector/src/services/ScorerWeightOptimizer.ts`
- Create: `packages/data-collector/src/services/ScorerWeightOptimizer.test.ts`

**Step 1: Write failing tests**

Create `packages/data-collector/src/services/ScorerWeightOptimizer.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { pearsonCorrelation, computeObjective, MIN_TRADES } from './ScorerWeightOptimizer.js';
import type { ScorerWeights } from './MarketScorer.js';

describe('pearsonCorrelation', () => {
  it('returns 1.0 for perfectly correlated series', () => {
    expect(pearsonCorrelation([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1.0);
  });

  it('returns -1.0 for perfectly inversely correlated series', () => {
    expect(pearsonCorrelation([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1.0);
  });

  it('returns 0 for constant series (no variance)', () => {
    expect(pearsonCorrelation([1, 1, 1], [1, 2, 3])).toBe(0);
  });
});

describe('computeObjective', () => {
  const weights: ScorerWeights = {
    tradeability: 0.30, liquidity: 0.25, volatility: 0.20, ttr: 0.15, dataQuality: 0.10,
  };

  it('returns correlation of recomputed scores with pnl', () => {
    const trades = [
      { dims: { tradeability: 1.0, liquidity: 0.8, ttr: 0.9, volatility: null, dataQuality: null }, pnl: 10 },
      { dims: { tradeability: 0.1, liquidity: 0.1, ttr: 0.2, volatility: null, dataQuality: null }, pnl: -5 },
      { dims: { tradeability: 0.8, liquidity: 0.7, ttr: 0.8, volatility: null, dataQuality: null }, pnl: 7 },
    ];
    const result = computeObjective(weights, trades);
    expect(result).toBeGreaterThan(0); // high-score trades have positive pnl
    expect(result).toBeLessThanOrEqual(1);
  });

  it('returns 0 when all pnl are identical (no variance)', () => {
    const trades = [
      { dims: { tradeability: 0.5, liquidity: 0.5, ttr: 0.5, volatility: null, dataQuality: null }, pnl: 5 },
      { dims: { tradeability: 0.8, liquidity: 0.8, ttr: 0.8, volatility: null, dataQuality: null }, pnl: 5 },
    ];
    expect(computeObjective(weights, trades)).toBe(0);
  });
});

describe('MIN_TRADES', () => {
  it('is 30', () => {
    expect(MIN_TRADES).toBe(30);
  });
});
```

**Step 2: Run tests**

```bash
pnpm test --filter data-collector
```
Expected: FAIL with import errors (file not created yet)

**Step 3: Implement `ScorerWeightOptimizer.ts`**

Create `packages/data-collector/src/services/ScorerWeightOptimizer.ts`:
```typescript
import { pino } from 'pino';
import { query } from '../database/connection.js';
import { MarketScorer, WEIGHTS, type ScorerWeights, type ScoreDimensions } from './MarketScorer.js';

const logger = pino({ name: 'ScorerWeightOptimizer' });

export const MIN_TRADES = 30;
const N_TRIALS = 300;

// ── Types ──────────────────────────────────────────────────────────────────

interface ClosedTrade {
  dims: ScoreDimensions;
  pnl: number;
}

// ── Pure helpers (exported for testing) ────────────────────────────────────

export function pearsonCorrelation(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n === 0) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const num = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
  const dx = Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0));
  const dy = Math.sqrt(ys.reduce((s, y) => s + (y - my) ** 2, 0));
  if (dx === 0 || dy === 0) return 0;
  return num / (dx * dy);
}

export function computeObjective(weights: ScorerWeights, trades: ClosedTrade[]): number {
  const scores = trades.map((t) => MarketScorer.compositeScore(t.dims, weights));
  const pnls = trades.map((t) => t.pnl);
  return pearsonCorrelation(scores, pnls);
}

// ── Random-search optimizer ────────────────────────────────────────────────

function randomWeights(): ScorerWeights {
  // Sample 3 positive floats for the dims we can optimize (ttr, tradeability, liquidity)
  // volatility and dataQuality stay at current defaults
  const r = () => Math.random() * 0.6 + 0.05; // uniform [0.05, 0.65]
  return {
    tradeability: r(),
    liquidity:    r(),
    volatility:   WEIGHTS.volatility,
    ttr:          r(),
    dataQuality:  WEIGHTS.dataQuality,
  };
}

// ── DB helpers ─────────────────────────────────────────────────────────────

async function loadClosedTrades(): Promise<ClosedTrade[]> {
  const result = await query<{
    score_dimensions_at_entry: Record<string, number | null>;
    realized_pnl: string;
  }>(
    `SELECT score_dimensions_at_entry, realized_pnl
     FROM paper_positions
     WHERE closed_at IS NOT NULL
       AND score_dimensions_at_entry IS NOT NULL
       AND realized_pnl IS NOT NULL`,
  );
  return result.rows.map((r) => {
    const d = r.score_dimensions_at_entry;
    return {
      dims: {
        tradeability: d.tradeability ?? 0,
        liquidity:    d.liquidity    ?? 0,
        volatility:   d.volatility   ?? null,
        ttr:          d.ttr          ?? 0,
        dataQuality:  d.dataQuality  ?? null,
      },
      pnl: parseFloat(r.realized_pnl),
    };
  });
}

async function saveWeights(weights: ScorerWeights, meta: { nTrades: number; nTrials: number; bestValue: number }): Promise<void> {
  await query(
    `UPDATE scorer_weights
     SET tradeability = $1, liquidity = $2, volatility = $3, ttr = $4, data_quality = $5,
         n_trades = $6, n_trials = $7, best_value = $8, updated_at = NOW()
     WHERE id = (SELECT id FROM scorer_weights ORDER BY id DESC LIMIT 1)`,
    [
      weights.tradeability, weights.liquidity, weights.volatility,
      weights.ttr, weights.dataQuality,
      meta.nTrades, meta.nTrials, meta.bestValue,
    ],
  );
}

// ── Main entry point ───────────────────────────────────────────────────────

export async function optimizeScorerWeights(): Promise<void> {
  const trades = await loadClosedTrades();
  logger.info({ n: trades.length }, 'Loaded closed trades for scorer weight optimization');

  if (trades.length < MIN_TRADES) {
    logger.info({ n: trades.length, required: MIN_TRADES }, 'Not enough trades — skipping optimization');
    return;
  }

  let bestValue = -Infinity;
  let bestWeights: ScorerWeights = { ...WEIGHTS };

  for (let i = 0; i < N_TRIALS; i++) {
    const candidate = randomWeights();
    const value = computeObjective(candidate, trades);
    if (value > bestValue) {
      bestValue = value;
      bestWeights = candidate;
    }
  }

  logger.info({ bestValue, bestWeights }, 'Optimization complete');

  await saveWeights(bestWeights, { nTrades: trades.length, nTrials: N_TRIALS, bestValue });
  logger.info('Scorer weights updated in DB');
}
```

**Step 4: Run tests**

```bash
pnpm test --filter data-collector
```
Expected: all tests PASS

**Step 5: Commit**

```bash
git add packages/data-collector/src/services/ScorerWeightOptimizer.ts \
        packages/data-collector/src/services/ScorerWeightOptimizer.test.ts
git commit -m "feat: add ScorerWeightOptimizer with Pearson correlation objective"
```

---

### Task 4: Wire optimizer into data-collector scheduler as weekly job

**Files:**
- Modify: `packages/data-collector/src/services/Scheduler.ts` (or wherever jobs are registered)

**Step 1: Find where jobs are registered**

```bash
grep -r "sync-markets\|prune-zombies\|addJob\|schedule" packages/data-collector/src --include="*.ts" -l
```

Open the Scheduler file and read how existing jobs are registered (the `sync-markets` job runs at `:17` hourly — follow the same pattern).

**Step 2: Add the weekly job**

In the scheduler file, import `optimizeScorerWeights`:
```typescript
import { optimizeScorerWeights } from './ScorerWeightOptimizer.js';
```

Add the job (after existing jobs):
```typescript
// Every Monday at 03:17 UTC — optimize MarketScorer dimension weights
scheduler.addJob('optimize-scorer-weights', '17 3 * * 1', async () => {
  await optimizeScorerWeights();
});
```

(Adjust the `addJob` call to match the actual API used by the existing jobs.)

**Step 3: Run tests**

```bash
pnpm test
```
Expected: all 447+ tests pass

**Step 4: Commit**

```bash
git add packages/data-collector/src/services/Scheduler.ts
git commit -m "feat: run scorer weight optimization weekly (Mon 03:17 UTC)"
```

---

### Task 5: Apply migration to VM + verify

**Step 1: Push to remote**

```bash
gh auth switch --user JaviMaligno
git push origin main
```

Wait for CI deploy to complete:
```bash
gh run watch $(gh run list --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status
```

**Step 2: Apply migration manually to VM**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="
docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"
CREATE TABLE IF NOT EXISTS scorer_weights (
  id SERIAL PRIMARY KEY,
  tradeability FLOAT NOT NULL DEFAULT 0.30,
  liquidity FLOAT NOT NULL DEFAULT 0.25,
  volatility FLOAT NOT NULL DEFAULT 0.20,
  ttr FLOAT NOT NULL DEFAULT 0.15,
  data_quality FLOAT NOT NULL DEFAULT 0.10,
  n_trades INT, n_trials INT, best_value FLOAT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO scorer_weights (tradeability, liquidity, volatility, ttr, data_quality)
SELECT 0.30, 0.25, 0.20, 0.15, 0.10
WHERE NOT EXISTS (SELECT 1 FROM scorer_weights);
\""
```

**Step 3: Verify table created and seeded**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="
docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"
SELECT tradeability, liquidity, volatility, ttr, data_quality, updated_at FROM scorer_weights;\""
```

Expected:
```
 tradeability | liquidity | volatility |  ttr  | data_quality |          updated_at
--------------+-----------+------------+-------+--------------+-------------------------------
         0.30 |      0.25 |       0.20 |  0.15 |         0.10 | 2026-03-19 ...
```

**Step 4: Verify containers restarted and MarketScorer loads from DB**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="
docker logs polymarket-data-collector --tail=50 | grep -i 'scorer\|weight\|pass 1\|scoring'"
```

Expected to see: scoring log line (at next :17) with no errors. If the table exists and has a row, `loadWeights` returns DB values (same as defaults for now).

**Step 5: Confirm next scoring run uses DB weights**

After the :17 scoring run:
```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="
docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"
SELECT COUNT(*), MAX(time) FROM market_score_history;\""
```

Expected: `MAX(time)` updated to current hour :17. ✅

**Step 6: Commit any final fixes, then done.**

---

## Notes for Phase 3 (future)

- Capture `volatility` and `dataQuality` at entry by running the price_history LATERAL JOIN in `openPosition()` — this would let the optimizer tune all 5 weights.
- Upgrade random search to Optuna (call existing Render optimizer endpoint) once >100 trades available.
- Add `scorer_weights_history` hypertable to track weight evolution over time.
- Consider using Spearman instead of Pearson correlation once outlier PnL values become a concern.
