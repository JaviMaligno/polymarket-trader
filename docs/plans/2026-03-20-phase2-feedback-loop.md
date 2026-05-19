# Phase 2: Category Feedback Loop Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Multiply market scores by a learned performance prior per category (crypto_intraday, crypto_daily, event_short, event_long), so categories that produce profitable trades get boosted (+50% max) and unprofitable ones get penalized (-50% max).

**Architecture:** A `MarketPerformanceTracker` service in data-collector queries closed trades grouped by `markets.market_type`, computes Sharpe ratio per category, derives a prior via sigmoid, and writes it to a `category_performance` table. MarketScorer reads these priors and multiplies `score × prior` in both Pass 1 (SQL) and Pass 2 (enrichment). A daily cron job triggers the recomputation.

**Tech Stack:** TypeScript, PostgreSQL, vitest, existing `query()` from `packages/data-collector/src/database/connection.ts`.

---

## Context

- `markets.market_type` column (`VARCHAR(20)`) is populated by `MarketClassifier` (in dashboard package) via regex/Haiku. Values: `crypto_intraday`, `crypto_daily`, `event_short`, `event_long`. Some markets have `NULL` market_type (unclassified).
- `paper_positions` has `market_id` (= `markets.id`), `realized_pnl`, `closed_at`.
- Prior formula (corrected from design doc): `prior = 0.5 + sigmoid(sharpe × 2)`, bounded [0.5, 1.5]. At sharpe=0 → prior=1.0 (neutral). Design doc wrote `0.5 + 0.5 × sigmoid(...)` but that gives 0.75 at sharpe=0, contradicting the comment "neutral → 1.0".
- Categories with <5 closed trades use default prior 1.0.
- `MarketScorer.scoreAllMarkets()` already loads weights from DB at the start. Priors follow the same pattern.

---

### Task 1: Migration `008_category_performance.sql`

**Files:**
- Create: `packages/data-collector/src/database/init/008_category_performance.sql`

**Step 1: Create the migration file**

```sql
-- 008_category_performance.sql
-- Stores per-category performance metrics and computed priors.
-- MarketPerformanceTracker writes here daily; MarketScorer reads priors at scoring time.
CREATE TABLE IF NOT EXISTS category_performance (
  market_type  VARCHAR(20) PRIMARY KEY,
  win_rate     FLOAT,
  avg_pnl      FLOAT,
  sharpe_ratio FLOAT,
  n_trades     INT NOT NULL DEFAULT 0,
  prior        FLOAT NOT NULL DEFAULT 1.0,
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Seed with default priors for the 4 known categories
INSERT INTO category_performance (market_type, prior) VALUES
  ('crypto_intraday', 1.0),
  ('crypto_daily', 1.0),
  ('event_short', 1.0),
  ('event_long', 1.0)
ON CONFLICT (market_type) DO NOTHING;
```

**Step 2: Commit**

```bash
git add packages/data-collector/src/database/init/008_category_performance.sql
git commit -m "feat: add category_performance table for Phase 2 feedback loop"
```

---

### Task 2: `MarketPerformanceTracker` service

**Files:**
- Create: `packages/data-collector/src/services/MarketPerformanceTracker.ts`
- Create: `packages/data-collector/src/services/MarketPerformanceTracker.test.ts`

**Step 1: Write failing tests**

Create `packages/data-collector/src/services/MarketPerformanceTracker.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { computePrior, MIN_CATEGORY_TRADES } from './MarketPerformanceTracker.js';

describe('computePrior', () => {
  it('returns 1.0 for sharpe = 0 (neutral)', () => {
    expect(computePrior(0)).toBeCloseTo(1.0);
  });

  it('returns ~0.5 for very negative sharpe', () => {
    expect(computePrior(-10)).toBeCloseTo(0.5, 1);
  });

  it('returns ~1.5 for very positive sharpe', () => {
    expect(computePrior(10)).toBeCloseTo(1.5, 1);
  });

  it('is bounded to [0.5, 1.5]', () => {
    expect(computePrior(-100)).toBeGreaterThanOrEqual(0.5);
    expect(computePrior(100)).toBeLessThanOrEqual(1.5);
  });

  it('is monotonically increasing', () => {
    expect(computePrior(-1)).toBeLessThan(computePrior(0));
    expect(computePrior(0)).toBeLessThan(computePrior(1));
  });
});

describe('MIN_CATEGORY_TRADES', () => {
  it('is 5', () => {
    expect(MIN_CATEGORY_TRADES).toBe(5);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd C:/Users/Usuario/GitHub/polymarket-trader && pnpm test --filter data-collector 2>&1 | tail -15
```

**Step 3: Implement `MarketPerformanceTracker.ts`**

```typescript
import { pino } from 'pino';
import { query } from '../database/connection.js';

const logger = pino({ name: 'MarketPerformanceTracker' });

export const MIN_CATEGORY_TRADES = 5;

// ── Pure helpers (exported for testing) ────────────────────────────────────

/** prior = 0.5 + sigmoid(sharpe × 2), bounded [0.5, 1.5] */
export function computePrior(sharpe: number): number {
  const sigmoid = 1 / (1 + Math.exp(-sharpe * 2));
  return Math.min(1.5, Math.max(0.5, 0.5 + sigmoid));
}

// ── Types ──────────────────────────────────────────────────────────────────

interface CategoryStats {
  market_type: string;
  n_trades: number;
  win_rate: number;
  avg_pnl: number;
  sharpe_ratio: number;
}

// ── Main entry point ───────────────────────────────────────────────────────

export async function updateCategoryPriors(): Promise<void> {
  const result = await query<{
    market_type: string;
    n_trades: string;
    win_rate: string;
    avg_pnl: string;
    sharpe_ratio: string;
  }>(`
    SELECT m.market_type,
           COUNT(*)::text AS n_trades,
           AVG(CASE WHEN p.realized_pnl > 0 THEN 1.0 ELSE 0.0 END)::text AS win_rate,
           AVG(p.realized_pnl)::text AS avg_pnl,
           CASE WHEN STDDEV(p.realized_pnl) > 0
                THEN (AVG(p.realized_pnl) / STDDEV(p.realized_pnl))::text
                ELSE '0' END AS sharpe_ratio
    FROM paper_positions p
    JOIN markets m ON p.market_id = m.id
    WHERE p.closed_at IS NOT NULL
      AND p.realized_pnl IS NOT NULL
      AND m.market_type IS NOT NULL
    GROUP BY m.market_type
  `);

  logger.info({ categories: result.rows.length }, 'Computed category performance');

  for (const row of result.rows) {
    const nTrades = parseInt(row.n_trades, 10);
    const sharpe = parseFloat(row.sharpe_ratio);
    const prior = nTrades >= MIN_CATEGORY_TRADES ? computePrior(sharpe) : 1.0;

    await query(
      `INSERT INTO category_performance (market_type, win_rate, avg_pnl, sharpe_ratio, n_trades, prior, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (market_type) DO UPDATE SET
         win_rate = $2, avg_pnl = $3, sharpe_ratio = $4, n_trades = $5, prior = $6, updated_at = NOW()`,
      [row.market_type, parseFloat(row.win_rate), parseFloat(row.avg_pnl), sharpe, nTrades, prior],
    );

    logger.info({ market_type: row.market_type, nTrades, sharpe: sharpe.toFixed(3), prior: prior.toFixed(3) },
      'Updated category prior');
  }
}
```

**Step 4: Run tests**

```bash
pnpm test 2>&1 | tail -10
```

**Step 5: Commit**

```bash
git add packages/data-collector/src/services/MarketPerformanceTracker.ts \
        packages/data-collector/src/services/MarketPerformanceTracker.test.ts
git commit -m "feat: add MarketPerformanceTracker with category-level Sharpe priors"
```

---

### Task 3: MarketScorer loads and applies category priors

**Files:**
- Modify: `packages/data-collector/src/services/MarketScorer.ts`
- Test: `packages/data-collector/src/services/MarketScorer.test.ts`

**Step 1: Write failing tests**

Add to `MarketScorer.test.ts`:
```typescript
describe('loadCategoryPriors', () => {
  it('returns empty map when DB query throws', async () => {
    vi.spyOn(connection, 'query').mockRejectedValueOnce(new Error('DB down'));
    const priors = await MarketScorer.loadCategoryPriors();
    expect(priors.size).toBe(0);
    vi.restoreAllMocks();
  });

  it('returns map of market_type → prior from DB', async () => {
    vi.spyOn(connection, 'query').mockResolvedValueOnce({
      rows: [
        { market_type: 'crypto_daily', prior: 1.2 },
        { market_type: 'event_short', prior: 0.8 },
      ],
      rowCount: 2,
    } as any);
    const priors = await MarketScorer.loadCategoryPriors();
    expect(priors.get('crypto_daily')).toBeCloseTo(1.2);
    expect(priors.get('event_short')).toBeCloseTo(0.8);
    expect(priors.get('unknown_type')).toBeUndefined();
    vi.restoreAllMocks();
  });
});
```

**Step 2: Run tests — expect failure**

**Step 3: Implement `loadCategoryPriors` static method**

Add to `MarketScorer` class:
```typescript
static async loadCategoryPriors(): Promise<Map<string, number>> {
  try {
    const result = await query<{ market_type: string; prior: number }>(
      `SELECT market_type, prior FROM category_performance WHERE n_trades >= 5`,
    );
    const map = new Map<string, number>();
    for (const row of result.rows) {
      map.set(row.market_type, row.prior);
    }
    return map;
  } catch {
    return new Map();
  }
}
```

**Step 4: Wire priors into `scoreAllMarkets()`**

At the start of `scoreAllMarkets()`, after `loadWeights()`:
```typescript
const categoryPriors = await MarketScorer.loadCategoryPriors();
```

In Pass 1 SQL, multiply by prior using a LEFT JOIN:
```sql
UPDATE markets SET market_score = (
  ... existing formula ...
) / ${NORM} * COALESCE(cp.prior, 1.0)
FROM category_performance cp
WHERE cp.market_type = markets.market_type
  AND markets.is_active = true
  AND markets.is_resolved = false
  AND markets.clob_token_id_yes IS NOT NULL
```

IMPORTANT: The current Pass 1 SQL uses a plain WHERE clause. Adding the JOIN changes the structure. Read the current SQL carefully and adapt. Markets with `NULL` market_type or no matching `category_performance` row should get `prior = 1.0` (no effect). This may require restructuring the UPDATE to use a subquery or CTE instead of a direct FROM join.

Alternative (simpler): Apply priors as a separate Pass 1b after Pass 1:
```sql
UPDATE markets SET market_score = market_score * COALESCE(
  (SELECT prior FROM category_performance WHERE market_type = markets.market_type),
  1.0
)
WHERE is_active = true AND is_resolved = false AND clob_token_id_yes IS NOT NULL
```

In Pass 2 enrichment, apply the prior to the compositeScore result:
```typescript
const prior = categoryPriors.get(row.market_type) ?? 1.0;
const score = MarketScorer.compositeScore({ tradeability, liquidity, volatility, ttr, dataQuality }, weights) * prior;
```

Also add `m.market_type` to the Pass 2 SELECT and the trackedResult type. Thread `market_type` through the enrichUpdates type (add to `EnrichUpdate` interface).

**Step 5: Run tests**

```bash
pnpm test 2>&1 | tail -10
```

**Step 6: Commit**

```bash
git add packages/data-collector/src/services/MarketScorer.ts \
        packages/data-collector/src/services/MarketScorer.test.ts
git commit -m "feat: MarketScorer loads and applies category performance priors"
```

---

### Task 4: Wire into Scheduler as daily job

**Files:**
- Modify: `packages/data-collector/src/services/Scheduler.ts`

**Step 1: Add the daily job**

Import `updateCategoryPriors`:
```typescript
import { updateCategoryPriors } from './MarketPerformanceTracker.js';
```

Add job definition in constructor (after existing jobs):
```typescript
this.defineJob('compute-market-priors', '45 2 * * *', this.computeMarketPriors.bind(this));
```

Add case in `runJob` switch:
```typescript
case 'compute-market-priors':
  await this.computeMarketPriors();
  break;
```

Add private handler method:
```typescript
/**
 * Compute category performance priors from closed trade outcomes.
 * Updates category_performance table; MarketScorer reads priors at next scoring run.
 * Daily at 02:45 UTC.
 */
private async computeMarketPriors(): Promise<void> {
  await updateCategoryPriors();
}
```

**Step 2: Run tests**

```bash
pnpm test 2>&1 | tail -10
```

**Step 3: Commit**

```bash
git add packages/data-collector/src/services/Scheduler.ts
git commit -m "feat: run category prior computation daily at 02:45 UTC"
```

---

### Task 5: Apply migration to VM + verify

**Step 1: Push to remote**

```bash
gh auth switch --user JaviMaligno
git push origin main
```

Wait for CI deploy.

**Step 2: Apply migration manually to VM**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="
docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"
CREATE TABLE IF NOT EXISTS category_performance (
  market_type  VARCHAR(20) PRIMARY KEY,
  win_rate     FLOAT,
  avg_pnl      FLOAT,
  sharpe_ratio FLOAT,
  n_trades     INT NOT NULL DEFAULT 0,
  prior        FLOAT NOT NULL DEFAULT 1.0,
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO category_performance (market_type, prior) VALUES
  ('crypto_intraday', 1.0),
  ('crypto_daily', 1.0),
  ('event_short', 1.0),
  ('event_long', 1.0)
ON CONFLICT (market_type) DO NOTHING;
\""
```

**Step 3: Verify table**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="
docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"
SELECT * FROM category_performance;\""
```

**Step 4: Verify containers healthy + job registered**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="
docker logs polymarket-data-collector --since 5m 2>&1 | grep -i 'compute-market-priors\|category'"
```

**Step 5: Verify scoring uses priors after next :17 run**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="
docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"
SELECT market_type, prior, n_trades, updated_at FROM category_performance;\""
```

Initially all priors should be 1.0 (default). After the first 02:45 UTC run, categories with ≥5 trades will get computed priors.

---

## Notes

- The prior formula was corrected from the design doc: `0.5 + sigmoid(sharpe × 2)` instead of `0.5 + 0.5 × sigmoid(...)`. The original formula gives 0.75 at neutral sharpe, not 1.0.
- Categories with `NULL` market_type or <5 trades get prior 1.0 (no effect).
- The prior is intentionally bounded [0.5, 1.5] — feedback adjusts ±50%, never dominates the base score.
- Phase 2.5 (already deployed) can later optimize the prior bounds and sigmoid factor via Optuna.
