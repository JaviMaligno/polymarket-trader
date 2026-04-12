# Market Type Execution Gate + Shadow Trading — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restrict live trading to crypto market types, record shadow trades for blocked types, and surface per-type statistics across all diagnostic scripts.

**Architecture:** Execution gate in AutoSignalExecutor filters by `ALLOWED_MARKET_TYPES` env var. Blocked signals insert into `shadow_trades` table for offline analysis. MarketPerformanceTracker resolves shadow trades when markets resolve. Diagnostic scripts add per-type breakdowns.

**Tech Stack:** TypeScript (Node.js), PostgreSQL/TimescaleDB, Bash (daily-review.sh)

**Spec:** `docs/superpowers/specs/2026-04-12-market-type-gate-design.md`

---

### Task 1: Add `marketType` to SignalResult and propagate from SignalEngine

**Files:**
- Modify: `packages/dashboard/src/services/AutoSignalExecutor.ts:65-74`
- Modify: `packages/dashboard/src/services/SignalEngine.ts:1018-1028`

- [ ] **Step 1: Add `marketType` to `SignalResult` interface**

In `packages/dashboard/src/services/AutoSignalExecutor.ts`, add the field to the interface:

```typescript
export interface SignalResult {
  signalId: string;
  marketId: string;
  tokenId: string;
  direction: 'long' | 'short';
  strength: number;      // 0-1
  confidence: number;    // 0-1
  price: number;
  marketType?: string;   // crypto_intraday, crypto_daily, event_short, event_long
  metadata?: Record<string, unknown>;
}
```

- [ ] **Step 2: Propagate `marketType` in `SignalEngine.convertToSignalResult()`**

In `packages/dashboard/src/services/SignalEngine.ts`, add `marketType` to the returned object (around line 1018-1028):

```typescript
    return {
      signalId: output.signalId,
      marketId: output.marketId,
      tokenId,
      direction,
      strength,
      confidence: output.confidence,
      price,
      marketType: market.marketType,
      metadata: output.metadata,
    };
```

- [ ] **Step 3: Verify build passes**

Run: `cd packages/dashboard && npx tsc --noEmit`
Expected: No new errors (marketType is optional so all existing callers are fine)

- [ ] **Step 4: Commit**

```bash
git add packages/dashboard/src/services/AutoSignalExecutor.ts packages/dashboard/src/services/SignalEngine.ts
git commit -m "feat: propagate marketType through signal pipeline"
```

---

### Task 2: Add execution gate in AutoSignalExecutor

**Files:**
- Modify: `packages/dashboard/src/services/AutoSignalExecutor.ts:240-315`

- [ ] **Step 1: Parse `ALLOWED_MARKET_TYPES` env var**

Add after the existing constants (around line 130, after `NEAR_RESOLVED_LOWER`):

```typescript
// Market type gate: only allow trades for these market types (comma-separated)
// If unset, all types are allowed (backward compatible)
const ALLOWED_MARKET_TYPES: Set<string> | null = process.env.ALLOWED_MARKET_TYPES
  ? new Set(process.env.ALLOWED_MARKET_TYPES.split(',').map(t => t.trim()))
  : null;
```

- [ ] **Step 2: Add the gate check in `processSignal()`**

Insert after the near-resolution time guard block (after line 311, before `// Reset daily counter if new day`). The gate must only block new opens, not closes. At this point in the code we don't yet know if it's a close, so we check position existence here:

```typescript
    // 0d. Market type gate: restrict new opens to allowed types
    if (ALLOWED_MARKET_TYPES && signal.marketType && !ALLOWED_MARKET_TYPES.has(signal.marketType)) {
      // Check if this is a close of an existing position — always allow closes
      try {
        const openPositions = await paperPositionsRepo.getAll();
        const hasOpenPosition = openPositions.some(p => p.market_id === signal.marketId);
        if (!hasOpenPosition) {
          console.log(`[AutoExecutor] REJECTED ${signal.marketId.substring(0, 12)}... : market_type_not_allowed (${signal.marketType})`);
          // Fire-and-forget shadow trade insert
          this.insertShadowTrade(signal).catch(() => {});
          return { executed: false, reason: `market_type_not_allowed: ${signal.marketType}` };
        }
      } catch {
        // If we can't check positions, block the trade for safety
        console.log(`[AutoExecutor] REJECTED ${signal.marketId.substring(0, 12)}... : market_type_not_allowed (${signal.marketType}, position check failed)`);
        return { executed: false, reason: `market_type_not_allowed: ${signal.marketType}` };
      }
    }
```

Note: `insertShadowTrade` will be implemented in Task 3. For now it will cause a type error — that's fine, we'll add it next.

- [ ] **Step 3: Commit**

```bash
git add packages/dashboard/src/services/AutoSignalExecutor.ts
git commit -m "feat: add market type execution gate in AutoSignalExecutor"
```

---

### Task 3: Create `shadow_trades` table and insert logic

**Files:**
- Create: `packages/data-collector/src/database/init/016_shadow_trades.sql`
- Modify: `packages/dashboard/src/services/AutoSignalExecutor.ts`

- [ ] **Step 1: Create migration file**

Create `packages/data-collector/src/database/init/016_shadow_trades.sql`:

```sql
-- 016_shadow_trades.sql
-- Records what the system would have traded for market types blocked by the execution gate.
-- AutoSignalExecutor inserts on rejection; MarketPerformanceTracker resolves when market closes.
CREATE TABLE IF NOT EXISTS shadow_trades (
  id SERIAL PRIMARY KEY,
  time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  market_id VARCHAR(255) NOT NULL,
  market_type VARCHAR(20) NOT NULL,
  direction VARCHAR(5) NOT NULL,
  entry_price FLOAT NOT NULL,
  theoretical_size FLOAT NOT NULL,
  signal_strength FLOAT NOT NULL,
  signal_confidence FLOAT NOT NULL,
  signal_type VARCHAR(100),
  resolved_at TIMESTAMPTZ,
  resolution_price FLOAT,
  theoretical_pnl FLOAT
);

CREATE INDEX IF NOT EXISTS idx_shadow_trades_market_type ON shadow_trades(market_type);
CREATE INDEX IF NOT EXISTS idx_shadow_trades_time ON shadow_trades(time DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_trades_unresolved ON shadow_trades(resolved_at) WHERE resolved_at IS NULL;
```

- [ ] **Step 2: Add `insertShadowTrade` method to AutoSignalExecutor**

Add as a private method in the `AutoSignalExecutor` class (after `persistCooldown`, around line 200):

```typescript
  /**
   * Record a shadow trade for a signal blocked by the market type gate.
   * Fire-and-forget — errors are logged but don't affect signal processing.
   */
  private async insertShadowTrade(signal: SignalResult): Promise<void> {
    // Compute theoretical position size using the same logic as openPosition
    let weight = 0.5;
    try {
      const weightRecord = await signalWeightsRepo.get(signal.signalId);
      if (weightRecord) weight = Number(weightRecord.weight);
    } catch { /* use default */ }

    const sizeMultiplier = signal.confidence * Math.abs(signal.strength) * weight;
    const positionValue = Math.min(
      this.config.maxPositionSize * sizeMultiplier,
      this.config.maxPositionSize
    );
    const shares = Math.floor(positionValue / signal.price);
    if (shares < 1) return; // Too small to record

    await query(
      `INSERT INTO shadow_trades (time, market_id, market_type, direction, entry_price, theoretical_size, signal_strength, signal_confidence, signal_type)
       VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        signal.marketId,
        signal.marketType,
        signal.direction,
        signal.price,
        shares,
        Math.abs(signal.strength),
        signal.confidence,
        signal.signalId,
      ]
    );
  }
```

- [ ] **Step 3: Verify build passes**

Run: `cd packages/dashboard && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add packages/data-collector/src/database/init/016_shadow_trades.sql packages/dashboard/src/services/AutoSignalExecutor.ts
git commit -m "feat: shadow_trades table and insert on market type rejection"
```

---

### Task 4: Shadow trade resolution in MarketPerformanceTracker

**Files:**
- Modify: `packages/data-collector/src/services/MarketPerformanceTracker.ts`

- [ ] **Step 1: Add `resolveShadowTrades` function**

Add after the existing `updateCategoryPriors` function:

```typescript
/**
 * Resolve shadow trades whose markets have been resolved.
 * For LONG: pnl = (resolution_price - entry_price) * theoretical_size
 * For SHORT: pnl = (entry_price - resolution_price) * theoretical_size
 * Resolution price is 1.0 (YES outcome) or 0.0 (NO outcome).
 */
export async function resolveShadowTrades(): Promise<void> {
  const result = await query<{
    id: string;
    direction: string;
    entry_price: string;
    theoretical_size: string;
    resolution_price: string;
  }>(`
    SELECT st.id, st.direction, st.entry_price, st.theoretical_size,
           CASE WHEN m.outcome = 'Yes' THEN 1.0 ELSE 0.0 END AS resolution_price
    FROM shadow_trades st
    JOIN markets m ON st.market_id = m.id
    WHERE st.resolved_at IS NULL
      AND m.is_resolved = true
  `);

  if (result.rows.length === 0) return;

  logger.info({ count: result.rows.length }, 'Resolving shadow trades');

  for (const row of result.rows) {
    const entryPrice = parseFloat(row.entry_price);
    const size = parseFloat(row.theoretical_size);
    const resolutionPrice = parseFloat(row.resolution_price);
    const pnl = row.direction === 'long'
      ? (resolutionPrice - entryPrice) * size
      : (entryPrice - resolutionPrice) * size;

    await query(
      `UPDATE shadow_trades SET resolved_at = NOW(), resolution_price = $1, theoretical_pnl = $2 WHERE id = $3`,
      [resolutionPrice, pnl, parseInt(row.id, 10)]
    );
  }

  logger.info({ resolved: result.rows.length }, 'Shadow trades resolved');
}
```

- [ ] **Step 2: Verify build passes**

Run: `cd packages/data-collector && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Wire into the scheduler**

In `packages/data-collector/src/services/Scheduler.ts`:

Update the import at line 12:
```typescript
import { updateCategoryPriors, resolveShadowTrades } from './MarketPerformanceTracker.js';
```

Update `computeMarketPriors()` at line 435:
```typescript
  private async computeMarketPriors(): Promise<void> {
    await updateCategoryPriors();
    await resolveShadowTrades();
  }
```

- [ ] **Step 4: Commit**

```bash
git add packages/data-collector/src/services/MarketPerformanceTracker.ts packages/data-collector/src/services/Scheduler.ts
git commit -m "feat: resolve shadow trades when markets close"
```

---

### Task 5: Per-type stats in `check-status.js`

**Files:**
- Modify: `scripts/check-status.js`

- [ ] **Step 1: Add market distribution by type section**

Add after the "POSICIONES ABIERTAS" section (after line 61), before the "SEÑALES USADAS" section:

```javascript
  // Market distribution by type
  const typeDistribution = await pool.query(`
    SELECT
      COALESCE(market_type, 'unclassified') as type,
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE tracking_status = 'active') as active,
      COUNT(*) FILTER (WHERE tracking_status = 'warming') as warming
    FROM markets
    WHERE tracking_status IN ('active', 'warming', 'cooling')
    GROUP BY market_type
    ORDER BY active DESC
  `);
  console.log('\n=== MERCADOS POR TIPO ===');
  if (typeDistribution.rows.length === 0) {
    console.log('(sin mercados trackeados)');
  } else {
    console.table(typeDistribution.rows.map(r => ({
      type: r.type,
      active: r.active,
      warming: r.warming,
      total: r.total
    })));
  }
```

- [ ] **Step 2: Test locally**

Run: `NODE_TLS_REJECT_UNAUTHORIZED=0 DATABASE_URL="..." node scripts/check-status.js`
Expected: New section "MERCADOS POR TIPO" appears with type breakdown

- [ ] **Step 3: Commit**

```bash
git add scripts/check-status.js
git commit -m "feat: add market type distribution to check-status.js"
```

---

### Task 6: Per-type stats in `check-trades.js`

**Files:**
- Modify: `scripts/check-trades.js`

- [ ] **Step 1: Add performance by market type section**

Add after the "SEÑALES USADAS" section (after line 64), before `pool.end()`:

```javascript
  // Performance by market type (post-reset)
  const resetDate = await pool.query(`SELECT last_reset_at FROM paper_account LIMIT 1`);
  const resetAt = resetDate.rows[0]?.last_reset_at || '2026-04-07';

  const typePerf = await pool.query(`
    SELECT
      COALESCE(m.market_type, 'unclassified') as type,
      COUNT(*) as trades,
      ROUND(AVG(CASE WHEN p.realized_pnl > 0 THEN 1.0 ELSE 0.0 END) * 100, 1) as win_pct,
      ROUND(SUM(p.realized_pnl)::numeric, 2) as total_pnl,
      ROUND(AVG(p.realized_pnl)::numeric, 2) as avg_pnl
    FROM paper_positions p
    JOIN markets m ON p.market_id = m.id
    WHERE p.closed_at IS NOT NULL
      AND p.closed_at >= $1
      AND p.realized_pnl IS NOT NULL
    GROUP BY m.market_type
    ORDER BY total_pnl DESC
  `, [resetAt]);
  console.log('\n=== PERFORMANCE POR TIPO (post-reset) ===');
  if (typePerf.rows.length === 0) {
    console.log('(sin trades cerrados post-reset)');
  } else {
    console.table(typePerf.rows.map(r => ({
      type: r.type,
      trades: r.trades,
      win: r.win_pct + '%',
      total_pnl: '$' + parseFloat(r.total_pnl).toFixed(2),
      avg_pnl: '$' + parseFloat(r.avg_pnl).toFixed(2)
    })));
  }
```

- [ ] **Step 2: Test locally**

Run: `NODE_TLS_REJECT_UNAUTHORIZED=0 DATABASE_URL="..." node scripts/check-trades.js`
Expected: New section "PERFORMANCE POR TIPO" appears

- [ ] **Step 3: Commit**

```bash
git add scripts/check-trades.js
git commit -m "feat: add per-type performance to check-trades.js"
```

---

### Task 7: Per-type stats in `check-activity.js`

**Files:**
- Modify: `scripts/check-activity.js`

- [ ] **Step 1: Add signals by market type section**

Add after the "CURRENT SIGNAL WEIGHTS" section (after line 59), before `pool.end()`:

```javascript
    // Signals by market type (from trades, last 24h)
    const signalsByType = await pool.query(`
      SELECT
        COALESCE(m.market_type, 'unclassified') as type,
        COUNT(*) as signals,
        COUNT(DISTINCT pt.market_id) as markets
      FROM paper_trades pt
      JOIN markets m ON pt.market_id = m.id
      WHERE pt.time > NOW() - INTERVAL '24 hours'
      GROUP BY m.market_type
      ORDER BY signals DESC
    `);
    console.log('\n=== TRADES POR TIPO DE MERCADO (24h) ===');
    if (signalsByType.rows.length === 0) {
      console.log('(sin trades en 24h)');
    } else {
      console.table(signalsByType.rows.map(r => ({
        type: r.type,
        trades: r.signals,
        markets: r.markets
      })));
    }
```

- [ ] **Step 2: Test locally**

Run: `NODE_TLS_REJECT_UNAUTHORIZED=0 DATABASE_URL="..." node scripts/check-activity.js`
Expected: New section "TRADES POR TIPO DE MERCADO" appears

- [ ] **Step 3: Commit**

```bash
git add scripts/check-activity.js
git commit -m "feat: add per-type signal breakdown to check-activity.js"
```

---

### Task 8: Per-type stats in `daily-review.sh`

**Files:**
- Modify: `scripts/daily-review.sh`

- [ ] **Step 1: Add category performance query**

Add before the `# ── save review history` section (before line 497):

```bash
# ── per-type performance ────────────────────────────────────────────────────

category_performance=$(query_json "
  SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM (
    SELECT market_type, win_rate, avg_pnl, sharpe_ratio, n_trades, prior,
           updated_at
    FROM category_performance
    ORDER BY n_trades DESC
  ) t;
")

trades_by_type=$(query_json "
  SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM (
    SELECT COALESCE(m.market_type, 'unclassified') AS market_type,
           COUNT(*) AS trades_24h,
           ROUND(AVG(CASE WHEN p.realized_pnl > 0 THEN 1.0 ELSE 0.0 END)::numeric * 100, 1) AS win_pct,
           ROUND(SUM(p.realized_pnl)::numeric, 2) AS pnl_24h
    FROM paper_positions p
    JOIN markets m ON p.market_id = m.id
    WHERE p.closed_at >= NOW() - INTERVAL '24 hours'
      AND p.realized_pnl IS NOT NULL
    GROUP BY m.market_type
    ORDER BY pnl_24h DESC
  ) t;
")

shadow_summary=$(query_json "
  SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM (
    SELECT market_type,
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE resolved_at IS NOT NULL) AS resolved,
           ROUND(AVG(theoretical_pnl) FILTER (WHERE resolved_at IS NOT NULL)::numeric, 2) AS avg_pnl
    FROM shadow_trades
    GROUP BY market_type
  ) t;
")
```

- [ ] **Step 2: Add to the final JSON assembly**

In the `jq -n` block (around line 527), add the new variables:

After `--argjson real_pnl_check "$real_pnl_check" \` add:
```bash
  --argjson category_performance "$category_performance" \
  --argjson trades_by_type "$trades_by_type" \
  --argjson shadow_summary "$shadow_summary" \
```

And in the JSON object body, after `real_pnl_check: $real_pnl_check,` add:
```
    category_performance: $category_performance,
    trades_by_type: $trades_by_type,
    shadow_summary: $shadow_summary,
```

- [ ] **Step 3: Commit**

```bash
git add scripts/daily-review.sh
git commit -m "feat: add per-type performance and shadow trades to daily review"
```

---

### Task 9: Create `check-shadow-trades.js` with readiness tiers

**Files:**
- Create: `scripts/check-shadow-trades.js`

- [ ] **Step 1: Create the script**

Create `scripts/check-shadow-trades.js`:

```javascript
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function computeTier(stats) {
  if (stats.resolved < 10) return { tier: 3, label: 'Insufficient data' };
  if (stats.sharpe <= 0) return { tier: 4, label: 'Not viable' };
  if (stats.sharpe > 0.5 && stats.winPct > 55 && stats.resolved >= 20) return { tier: 1, label: 'Ready' };
  return { tier: 2, label: 'Promising' };
}

async function check() {
  // Summary by market type
  const summary = await pool.query(`
    SELECT
      market_type,
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE resolved_at IS NOT NULL) as resolved,
      COUNT(*) FILTER (WHERE resolved_at IS NULL) as pending,
      ROUND(AVG(CASE WHEN theoretical_pnl > 0 THEN 1.0 ELSE 0.0 END) FILTER (WHERE resolved_at IS NOT NULL) * 100, 1) as win_pct,
      ROUND(SUM(theoretical_pnl) FILTER (WHERE resolved_at IS NOT NULL)::numeric, 2) as total_pnl,
      ROUND(AVG(theoretical_pnl) FILTER (WHERE resolved_at IS NOT NULL)::numeric, 2) as avg_pnl,
      CASE WHEN STDDEV(theoretical_pnl) FILTER (WHERE resolved_at IS NOT NULL) > 0
           THEN ROUND((AVG(theoretical_pnl) FILTER (WHERE resolved_at IS NOT NULL)
                      / STDDEV(theoretical_pnl) FILTER (WHERE resolved_at IS NOT NULL))::numeric, 3)
           ELSE 0 END as sharpe
    FROM shadow_trades
    GROUP BY market_type
    ORDER BY total DESC
  `);

  console.log('=== SHADOW TRADES POR TIPO ===');
  if (summary.rows.length === 0) {
    console.log('(sin shadow trades registrados)');
    await pool.end();
    return;
  }
  console.table(summary.rows.map(r => ({
    type: r.market_type,
    total: r.total,
    resolved: r.resolved,
    pending: r.pending,
    win: r.win_pct ? r.win_pct + '%' : '-',
    total_pnl: r.total_pnl ? '$' + parseFloat(r.total_pnl).toFixed(2) : '-',
    avg_pnl: r.avg_pnl ? '$' + parseFloat(r.avg_pnl).toFixed(2) : '-',
    sharpe: parseFloat(r.sharpe) || '-'
  })));

  // Readiness tiers
  console.log('\n=== READINESS TIERS ===');
  for (const r of summary.rows) {
    const stats = {
      resolved: parseInt(r.resolved),
      winPct: parseFloat(r.win_pct) || 0,
      sharpe: parseFloat(r.sharpe) || 0,
    };
    const { tier, label } = computeTier(stats);
    const winStr = stats.resolved > 0 ? `win ${r.win_pct}%` : '-';
    const sharpeStr = stats.resolved >= 10 ? `sharpe ${r.sharpe}` : '-';
    console.log(`  ${r.market_type.padEnd(18)} | Tier ${tier} (${label.padEnd(19)}) | ${r.resolved} resolved | ${winStr} | ${sharpeStr}`);
  }

  // Comparison with real trading
  const realPerf = await pool.query(`
    SELECT
      COALESCE(m.market_type, 'unclassified') as market_type,
      COUNT(*) as trades,
      ROUND(AVG(CASE WHEN p.realized_pnl > 0 THEN 1.0 ELSE 0.0 END) * 100, 1) as win_pct,
      ROUND(SUM(p.realized_pnl)::numeric, 2) as total_pnl
    FROM paper_positions p
    JOIN markets m ON p.market_id = m.id
    WHERE p.closed_at IS NOT NULL AND p.realized_pnl IS NOT NULL
    GROUP BY m.market_type
    ORDER BY total_pnl DESC
  `);
  console.log('\n=== REAL TRADING (comparación) ===');
  if (realPerf.rows.length === 0) {
    console.log('(sin trades reales)');
  } else {
    console.table(realPerf.rows.map(r => ({
      type: r.market_type,
      trades: r.trades,
      win: r.win_pct + '%',
      total_pnl: '$' + parseFloat(r.total_pnl).toFixed(2)
    })));
  }

  // Recent shadow trades (last 10)
  const recent = await pool.query(`
    SELECT time, market_type, direction, entry_price, theoretical_size, signal_confidence, signal_type
    FROM shadow_trades
    ORDER BY time DESC
    LIMIT 10
  `);
  console.log('\n=== ÚLTIMOS 10 SHADOW TRADES ===');
  if (recent.rows.length === 0) {
    console.log('(ninguno)');
  } else {
    console.table(recent.rows.map(r => ({
      time: new Date(r.time).toISOString().slice(11, 19),
      type: r.market_type,
      dir: r.direction,
      price: parseFloat(r.entry_price).toFixed(4),
      size: r.theoretical_size,
      conf: parseFloat(r.signal_confidence).toFixed(2),
      signal: r.signal_type
    })));
  }

  await pool.end();
}
check().catch(e => console.error(e.message));
```

- [ ] **Step 2: Test locally**

Run: `NODE_TLS_REJECT_UNAUTHORIZED=0 DATABASE_URL="..." node scripts/check-shadow-trades.js`
Expected: Script runs without error. Shows "(sin shadow trades registrados)" initially (table doesn't exist until deployed — will show an error which is fine for local test without the table).

- [ ] **Step 3: Commit**

```bash
git add scripts/check-shadow-trades.js
git commit -m "feat: add check-shadow-trades.js with readiness tiers"
```

---

### Task 10: Deploy — update docker-compose.gcp.yml

**Files:**
- Modify: `docker-compose.gcp.yml`

- [ ] **Step 1: Add `ALLOWED_MARKET_TYPES` env var**

In `docker-compose.gcp.yml`, in the `dashboard-api.environment` section, after the `EXECUTOR_NEAR_RESOLVED_LOWER` line (around line 149):

```yaml
      # Market type gate: only trade these types live, shadow-trade the rest
      ALLOWED_MARKET_TYPES: "crypto_intraday,crypto_daily"
```

- [ ] **Step 2: Commit**

```bash
git add docker-compose.gcp.yml
git commit -m "deploy: enable market type gate for crypto-only live trading"
```

---

### Task 11: Final verification

- [ ] **Step 1: Full build check**

```bash
cd packages/dashboard && npx tsc --noEmit
cd ../data-collector && npx tsc --noEmit
```

Expected: Both pass with no errors.

- [ ] **Step 2: Verify the complete signal flow**

Trace the full path mentally:
1. `SignalEngine.convertToSignalResult()` now includes `marketType` ✓
2. `AutoSignalExecutor.processSignal()` checks `ALLOWED_MARKET_TYPES` early ✓
3. Blocked signals call `insertShadowTrade()` before rejecting ✓
4. Closes of existing positions bypass the gate ✓
5. `MarketPerformanceTracker.resolveShadowTrades()` resolves on market close ✓
6. All 4 diagnostic scripts show per-type breakdowns ✓
7. `check-shadow-trades.js` shows tiers ✓
8. `daily-review.sh` includes new sections ✓

- [ ] **Step 3: Commit any remaining changes**

If any fixes were needed during verification:

```bash
git add -A
git commit -m "fix: address issues found during final verification"
```
