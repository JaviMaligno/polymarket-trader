# Score History Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Capture market score at trade entry and persist hourly score snapshots so Phase 2.5 (Optuna weight optimization) has the data it needs.

**Architecture:** Three changes: (1) SQL migration adds `market_score_at_entry` + `score_dimensions_at_entry` to `paper_positions` and creates `market_score_history` hypertable; (2) `MarketScorer.scoreAllMarkets()` writes a snapshot of tracked + top-50 cold markets after each scoring run; (3) `AutoSignalExecutor.openPosition()` queries the markets table and stores the composite score + 3 cheap dimensions (tradeability, liquidity, ttr) in the position row at the moment of entry.

**Tech Stack:** TypeScript, PostgreSQL/TimescaleDB, no new packages.

---

### Task 1: Migration SQL

**Files:**
- Create: `packages/data-collector/src/database/init/006_score_history.sql`

**Step 1: Write the migration**

```sql
-- Score capture on positions (for Optuna Phase 2.5)
ALTER TABLE paper_positions
  ADD COLUMN IF NOT EXISTS market_score_at_entry FLOAT,
  ADD COLUMN IF NOT EXISTS score_dimensions_at_entry JSONB;

-- market_score_history: hourly snapshots of tracked + top-50 cold markets
CREATE TABLE IF NOT EXISTS market_score_history (
  time                  TIMESTAMPTZ  NOT NULL,
  condition_id          VARCHAR      NOT NULL,
  tracking_status       VARCHAR(10),
  market_score          FLOAT,
  score_tradeability    FLOAT,
  score_liquidity       FLOAT,
  score_ttr             FLOAT,
  score_volatility      FLOAT,
  score_data_quality    FLOAT,
  current_price_yes     FLOAT,
  volume_24h            FLOAT
);

SELECT create_hypertable('market_score_history', 'time',
  chunk_time_interval => INTERVAL '7 days',
  if_not_exists => TRUE
);

-- Retention: 90 days is enough for Optuna
SELECT add_retention_policy('market_score_history', INTERVAL '90 days', if_not_exists => TRUE);

-- Compress chunks older than 7 days
ALTER TABLE market_score_history SET (
  timescaledb.compress,
  timescaledb.compress_orderby = 'time DESC',
  timescaledb.compress_segmentby = 'condition_id'
);
SELECT add_compression_policy('market_score_history', INTERVAL '7 days', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_msh_condition_time
  ON market_score_history (condition_id, time DESC);
```

**Step 2: Apply manually to VM** (init scripts don't re-run)

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b -- \
  "docker exec -i polymarket-timescaledb psql -U polymarket -d polymarket_trading" \
  < packages/data-collector/src/database/init/006_score_history.sql
```

Verify:
```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b -- \
  "docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \
  \"SELECT column_name FROM information_schema.columns WHERE table_name='paper_positions' AND column_name LIKE 'score%'; SELECT hypertable_name FROM timescaledb_information.hypertables WHERE hypertable_name='market_score_history';\""
```

Expected: rows for `market_score_at_entry`, `score_dimensions_at_entry`, and `market_score_history`.

**Step 3: Commit**

```bash
git add packages/data-collector/src/database/init/006_score_history.sql
git commit -m "feat: add score history migration (paper_positions + market_score_history hypertable)"
```

---

### Task 2: MarketScorer — write to market_score_history

**Files:**
- Modify: `packages/data-collector/src/services/MarketScorer.ts`

**Context:** `scoreAllMarkets()` already has `enrichUpdates` built during the Pass 2 loop (lines 281–312). Each element has `conditionId` and `score`. We need to extend it with dimension data and then insert all tracked + top-50 cold into `market_score_history`.

**Step 1: Extend the enrichUpdates type and data collection**

In `scoreAllMarkets()`, change the `enrichUpdates` array type (line 281) and extend each push in the loop to include dimensions and market data:

Old type:
```typescript
const enrichUpdates: Array<{ conditionId: string; score: number }> = [];
```

New type:
```typescript
const enrichUpdates: Array<{
  conditionId: string;
  score: number;
  tradeability: number;
  liquidity: number;
  ttr: number;
  volatility: number | null;
  dataQuality: number | null;
  currentPriceYes: number | null;
  volume24h: number | null;
}> = [];
```

And at the `enrichUpdates.push(...)` call (line 311), change to:
```typescript
enrichUpdates.push({
  conditionId: row.condition_id,
  score,
  tradeability,
  liquidity,
  ttr,
  volatility,
  dataQuality,
  currentPriceYes: row.current_price_yes != null ? Number(row.current_price_yes) : null,
  volume24h: row.volume_24h != null ? Number(row.volume_24h) : null,
});
```

**Step 2: Add private method `writeScoreHistory`**

After `batchUpdateScores`, add a new private method:

```typescript
private async writeScoreHistory(
  tracked: Array<{
    conditionId: string;
    score: number;
    tradeability: number;
    liquidity: number;
    ttr: number;
    volatility: number | null;
    dataQuality: number | null;
    currentPriceYes: number | null;
    volume24h: number | null;
  }>,
): Promise<void> {
  // Top 50 cold markets by score (no dimension breakdown — Pass 1 SQL doesn't return them)
  const coldResult = await query<{
    condition_id: string;
    market_score: number | null;
    current_price_yes: number | null;
    volume_24h: number | null;
  }>(`
    SELECT condition_id, market_score, current_price_yes, volume_24h
    FROM   markets
    WHERE  is_active = true
      AND  is_resolved = false
      AND  tracking_status = 'cold'
      AND  market_score > 0
    ORDER  BY market_score DESC
    LIMIT  50
  `);

  const now = new Date();

  // Build rows: tracked (with dimensions) + cold top-50 (dimensions null)
  const trackedRows = tracked.map((u) => ({
    time: now,
    condition_id: u.conditionId,
    tracking_status: null as string | null, // enriched separately
    market_score: u.score,
    score_tradeability: u.tradeability,
    score_liquidity: u.liquidity,
    score_ttr: u.ttr,
    score_volatility: u.volatility,
    score_data_quality: u.dataQuality,
    current_price_yes: u.currentPriceYes,
    volume_24h: u.volume24h,
  }));

  const coldRows = coldResult.rows.map((r) => ({
    time: now,
    condition_id: r.condition_id,
    tracking_status: 'cold' as string | null,
    market_score: r.market_score != null ? Number(r.market_score) : null,
    score_tradeability: null as number | null,
    score_liquidity: null as number | null,
    score_ttr: null as number | null,
    score_volatility: null as number | null,
    score_data_quality: null as number | null,
    current_price_yes: r.current_price_yes != null ? Number(r.current_price_yes) : null,
    volume_24h: r.volume_24h != null ? Number(r.volume_24h) : null,
  }));

  const all = [...trackedRows, ...coldRows];
  if (all.length === 0) return;

  // Single multi-row INSERT
  const values = all
    .map((_, i) => {
      const base = i * 11;
      return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10},$${base+11})`;
    })
    .join(', ');

  const params = all.flatMap((r) => [
    r.time, r.condition_id, r.tracking_status,
    r.market_score, r.score_tradeability, r.score_liquidity, r.score_ttr,
    r.score_volatility, r.score_data_quality, r.current_price_yes, r.volume_24h,
  ]);

  await query(
    `INSERT INTO market_score_history
       (time, condition_id, tracking_status, market_score,
        score_tradeability, score_liquidity, score_ttr,
        score_volatility, score_data_quality, current_price_yes, volume_24h)
     VALUES ${values}`,
    params,
  );

  logger.info({ tracked: trackedRows.length, cold: coldRows.length }, 'Score history written');
}
```

**Step 3: Call writeScoreHistory from scoreAllMarkets**

After `await this.batchUpdateScores(enrichUpdates);` and before `const enriched = enrichUpdates.length;`, add:

```typescript
// Write score history snapshot (fire-and-forget — don't block scoring)
this.writeScoreHistory(enrichUpdates).catch((err) =>
  logger.warn({ err }, 'writeScoreHistory failed — non-critical'),
);
```

**Step 4: Run build and tests**

```bash
cd C:\Users\Usuario\GitHub\polymarket-trader
pnpm build
npx vitest --run packages/data-collector
```

Expected: clean build, all tests pass.

**Step 5: Commit**

```bash
git add packages/data-collector/src/services/MarketScorer.ts
git commit -m "feat: write hourly score snapshots to market_score_history"
```

---

### Task 3: repositories.ts — add score fields to PaperPosition

**Files:**
- Modify: `packages/dashboard/src/database/repositories.ts`

**Context:** `PaperPosition` type is around line 310. The `upsert` INSERT is at line 329. The ON CONFLICT update must NOT overwrite `market_score_at_entry` if it's already set (position updates happen throughout the life of a position).

**Step 1: Add fields to PaperPosition type**

Find the `PaperPosition` interface (around line 305) and add:
```typescript
market_score_at_entry?: number | null;
score_dimensions_at_entry?: Record<string, unknown> | null;
```

**Step 2: Update INSERT in upsert()**

Change the INSERT column list to include the new fields:
```sql
INSERT INTO paper_positions
 (market_id, token_id, side, size, avg_entry_price, current_price,
  unrealized_pnl, unrealized_pnl_pct, realized_pnl, stop_loss, take_profit,
  opened_at, signal_type, metadata, market_score_at_entry, score_dimensions_at_entry)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
ON CONFLICT (market_id, token_id) DO UPDATE SET
  ...existing fields...,
  market_score_at_entry = COALESCE(paper_positions.market_score_at_entry, EXCLUDED.market_score_at_entry),
  score_dimensions_at_entry = COALESCE(paper_positions.score_dimensions_at_entry, EXCLUDED.score_dimensions_at_entry)
```

`COALESCE(existing, new)` means: keep the original entry value if already set, only write on first insert.

Add `position.market_score_at_entry ?? null` and `position.score_dimensions_at_entry ? JSON.stringify(position.score_dimensions_at_entry) : null` to the params array.

**Step 3: Run build and tests**

```bash
pnpm build
npx vitest --run packages/dashboard
```

**Step 4: Commit**

```bash
git add packages/dashboard/src/database/repositories.ts
git commit -m "feat: add market_score_at_entry and score_dimensions_at_entry to PaperPosition"
```

---

### Task 4: AutoSignalExecutor — capture score at entry

**Files:**
- Modify: `packages/dashboard/src/services/AutoSignalExecutor.ts`

**Context:** `openPosition()` starts at line 338. At line 474, it calls `paperPositionsRepo.upsert()`. We need to add a markets query just before that upsert, compute 3 dimensions inline, and pass them.

**Step 1: Add markets query before the upsert (around line 471)**

Between the capital check (line 416) and the signal prediction recording (line 421), add:

```typescript
// Fetch market score for entry capture (non-critical — don't fail trade if missing)
let marketScoreAtEntry: number | null = null;
let scoreDimensionsAtEntry: Record<string, unknown> | null = null;
try {
  const mktResult = await query<{
    market_score: string | null;
    current_price_yes: string | null;
    volume_24h: string | null;
    spread: string | null;
    end_date: string | null;
  }>(
    `SELECT market_score, current_price_yes, volume_24h, spread, end_date
     FROM   markets
     WHERE  condition_id = $1`,
    [signal.marketId],
  );
  if (mktResult.rows.length > 0) {
    const m = mktResult.rows[0];
    marketScoreAtEntry = m.market_score != null ? Number(m.market_score) : null;

    // Compute 3 cheap dimensions inline (mirrors MarketScorer static methods)
    const price = m.current_price_yes != null ? Number(m.current_price_yes) : null;
    const vol = m.volume_24h != null ? Number(m.volume_24h) : null;
    const sprd = m.spread != null ? Number(m.spread) : null;
    const endDate = m.end_date ? new Date(m.end_date) : null;

    const tradeability = computeTradeability(price);
    const liquidity = computeLiquidity(vol, sprd);
    const ttr = computeTtr(endDate);

    scoreDimensionsAtEntry = { tradeability, liquidity, ttr, volatility: null, dataQuality: null };
  }
} catch (err) {
  // Non-critical — trade proceeds without score capture
}
```

**Step 2: Add the 3 inline helper functions** (module-level, before the class)

```typescript
function clamp01(v: number): number { return Math.min(1, Math.max(0, v)); }

function computeTradeability(price: number | null): number {
  if (price === null) return 0;
  if (price < 0.05 || price > 0.95) return 0;
  if (price >= 0.45 && price <= 0.55) return 0;
  if (price >= 0.15 && price <= 0.40) return 1.0;
  if (price >= 0.60 && price <= 0.85) return 1.0;
  if (price >= 0.05 && price < 0.15) return clamp01((price - 0.05) / 0.10);
  if (price > 0.40 && price < 0.45) return clamp01((0.45 - price) / 0.05);
  if (price > 0.55 && price < 0.60) return clamp01((price - 0.55) / 0.05);
  if (price > 0.85 && price <= 0.95) return clamp01((0.95 - price) / 0.10);
  return 0;
}

const MAX_VOLUME_REF = 30_000_000;
function computeLiquidity(volume: number | null, spread: number | null): number {
  if (volume === null || volume <= 0) return 0;
  const raw = clamp01(Math.log(volume) / Math.log(MAX_VOLUME_REF));
  return spread !== null && spread > 0.03 ? raw * 0.5 : raw;
}

function computeTtr(endDate: Date | null): number {
  if (endDate === null) return 0.5;
  const days = (endDate.getTime() - Date.now()) / 86_400_000;
  if (days <= 0) return 0;
  if (days < 1) return 0.1;
  if (days <= 7) return 0.1 + 0.9 * (days - 1) / 6;
  if (days <= 60) return 1.0;
  if (days <= 180) return 1.0 - 0.5 * (days - 60) / 120;
  return 0.5;
}
```

**Step 3: Pass the score fields into the upsert call (line 474)**

```typescript
await paperPositionsRepo.upsert({
  market_id: signal.marketId,
  token_id: signal.tokenId,
  side: signal.direction === 'long' ? 'long' : 'short',
  size: shares,
  avg_entry_price: signal.price,
  current_price: signal.price,
  unrealized_pnl: 0,
  opened_at: new Date(),
  signal_type: signal.signalId,
  market_score_at_entry: marketScoreAtEntry,
  score_dimensions_at_entry: scoreDimensionsAtEntry ?? undefined,
});
```

**Step 4: Run build and tests**

```bash
pnpm build
npx vitest --run packages/dashboard
```

**Step 5: Commit and push**

```bash
git add packages/dashboard/src/services/AutoSignalExecutor.ts
git commit -m "feat: capture market_score_at_entry and score dimensions when opening position"
git push origin main
```

---

### Task 5: VM deploy and verify

**Step 1: Wait for CI to build and deploy** (or force manually if needed)

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b -- \
  "cd /home/Usuario/polymarket-trader && git pull origin main && \
   docker compose -f docker-compose.gcp.yml pull && \
   docker compose -f docker-compose.gcp.yml up -d --remove-orphans"
```

**Step 2: Verify migration columns exist**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b -- \
  "docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \
  \"SELECT column_name, data_type FROM information_schema.columns WHERE table_name='paper_positions' AND column_name LIKE '%score%';\""
```

Expected: `market_score_at_entry | double precision`, `score_dimensions_at_entry | jsonb`

**Step 3: Verify market_score_history exists and is a hypertable**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b -- \
  "docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \
  \"SELECT hypertable_name, num_chunks FROM timescaledb_information.hypertables WHERE hypertable_name='market_score_history';\""
```

**Step 4: After next scoring run (:17), verify rows were written**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b -- \
  "docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \
  \"SELECT COUNT(*), MAX(time), AVG(market_score) FROM market_score_history WHERE time > NOW() - INTERVAL '2 hours';\""
```

**Step 5: After next trade, verify score was captured**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b -- \
  "docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \
  \"SELECT market_id, market_score_at_entry, score_dimensions_at_entry FROM paper_positions WHERE market_score_at_entry IS NOT NULL ORDER BY opened_at DESC LIMIT 5;\""
```

---

## Summary

| Task | What it does | Package |
|------|-------------|---------|
| 1 | SQL migration: new columns + hypertable | data-collector (migration) |
| 2 | MarketScorer writes hourly snapshots | data-collector |
| 3 | PaperPosition type + upsert updated | dashboard |
| 4 | Score captured at trade entry | dashboard |
| 5 | VM deploy + verification | ops |

**Data lost without this**: every trade opened before this is deployed has no score history. Each day of delay = data lost forever.
