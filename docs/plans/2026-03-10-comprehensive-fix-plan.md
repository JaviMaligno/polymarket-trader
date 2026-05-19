# Comprehensive Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all critical issues from the daily trade review: PnL accounting bugs, broken optimization pipeline, signal generation silence, and DB performance.

**Architecture:** Six independent work items across 4 phases. Phase 1 (diagnostics) runs first. Phase 2 (core fixes) and Phase 3 (optimization) can run in parallel. Phase 4 validates everything.

**Tech Stack:** TypeScript (Vitest for tests), Python (FastAPI + Optuna), PostgreSQL/TimescaleDB, Node.js scripts

**Design doc:** `docs/plans/2026-03-10-comprehensive-fix-design.md`

---

## Phase 1: Diagnostics

### Task 1: TimescaleDB CPU Diagnostic Script

**Files:**
- Create: `scripts/diagnose-db-cpu.js`

**Step 1: Write the diagnostic script**

```javascript
#!/usr/bin/env node
/**
 * TimescaleDB CPU Diagnostic Script
 * Run on VM or locally with DATABASE_URL pointing to TimescaleDB.
 * Identifies: long queries, seq scans, table bloat, connection count,
 * continuous aggregate jobs, missing indexes.
 */
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ? { rejectUnauthorized: false } : undefined,
});

async function run() {
  console.log('=== TimescaleDB CPU Diagnostics ===\n');

  // 1. Active queries
  console.log('--- Active Queries ---');
  const active = await pool.query(`
    SELECT pid, state, query_start, NOW() - query_start AS duration,
           LEFT(query, 120) AS query_preview
    FROM pg_stat_activity
    WHERE state != 'idle' AND pid != pg_backend_pid()
    ORDER BY query_start ASC
  `);
  console.table(active.rows);

  // 2. Long-running queries (>5s)
  console.log('\n--- Long-Running Queries (>5s) ---');
  const longRunning = await pool.query(`
    SELECT pid, state, NOW() - query_start AS duration,
           LEFT(query, 200) AS query_preview
    FROM pg_stat_activity
    WHERE state != 'idle' AND NOW() - query_start > INTERVAL '5 seconds'
      AND pid != pg_backend_pid()
  `);
  console.table(longRunning.rows);

  // 3. Table sizes
  console.log('\n--- Table Sizes ---');
  const sizes = await pool.query(`
    SELECT schemaname, tablename,
           pg_size_pretty(pg_total_relation_size(schemaname || '.' || tablename)) AS total_size,
           pg_total_relation_size(schemaname || '.' || tablename) AS size_bytes
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY pg_total_relation_size(schemaname || '.' || tablename) DESC
    LIMIT 15
  `);
  console.table(sizes.rows);

  // 4. Seq scans vs index scans on big tables
  console.log('\n--- Seq Scans vs Index Scans (top tables) ---');
  const scans = await pool.query(`
    SELECT relname, seq_scan, idx_scan,
           CASE WHEN seq_scan + idx_scan > 0
             THEN ROUND(100.0 * seq_scan / (seq_scan + idx_scan), 1)
             ELSE 0 END AS seq_scan_pct,
           seq_tup_read, idx_tup_fetch,
           n_live_tup
    FROM pg_stat_user_tables
    ORDER BY seq_tup_read DESC
    LIMIT 10
  `);
  console.table(scans.rows);

  // 5. Missing indexes (high seq scan tables with many rows)
  console.log('\n--- Potentially Missing Indexes ---');
  const missing = await pool.query(`
    SELECT relname, seq_scan, seq_tup_read, n_live_tup
    FROM pg_stat_user_tables
    WHERE seq_scan > 100 AND n_live_tup > 10000
    ORDER BY seq_tup_read DESC
    LIMIT 5
  `);
  console.table(missing.rows);

  // 6. Existing indexes on price_history
  console.log('\n--- Indexes on price_history ---');
  const indexes = await pool.query(`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE tablename = 'price_history'
  `);
  console.table(indexes.rows);

  // 7. price_history row count and date range
  console.log('\n--- price_history Stats ---');
  const phStats = await pool.query(`
    SELECT COUNT(*) AS row_count,
           MIN(time) AS oldest,
           MAX(time) AS newest,
           COUNT(DISTINCT token_id) AS unique_tokens
    FROM price_history
  `);
  console.table(phStats.rows);

  // 8. Connection count
  console.log('\n--- Connection Count ---');
  const conns = await pool.query(`
    SELECT state, COUNT(*) AS count
    FROM pg_stat_activity
    GROUP BY state
  `);
  console.table(conns.rows);

  // 9. Continuous aggregate / background jobs
  console.log('\n--- TimescaleDB Background Jobs ---');
  try {
    const jobs = await pool.query(`
      SELECT job_id, application_name, schedule_interval,
             last_run_status, last_run_started_at, last_run_duration,
             next_start
      FROM timescaledb_information.jobs
      WHERE application_name NOT LIKE 'Telemetry%'
      ORDER BY next_start ASC
    `);
    console.table(jobs.rows);
  } catch (e) {
    console.log('Could not query TimescaleDB jobs:', e.message);
  }

  // 10. Retention policies
  console.log('\n--- Retention Policies ---');
  try {
    const retention = await pool.query(`
      SELECT j.hypertable_name, j.schedule_interval,
             c.config
      FROM timescaledb_information.jobs j
      JOIN timescaledb_information.job_stats s ON j.job_id = s.job_id
      LEFT JOIN _timescaledb_config.bgw_job c ON j.job_id = c.id
      WHERE j.proc_name = 'policy_retention'
    `);
    console.table(retention.rows);
  } catch (e) {
    console.log('No retention policies found or query failed:', e.message);
  }

  await pool.end();
  console.log('\n=== Diagnostics Complete ===');
}

run().catch(err => { console.error(err); process.exit(1); });
```

**Step 2: Run on VM and save output**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b -- \
  'docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading' \
  < scripts/diagnose-db-cpu.js
```

Or locally:
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 DATABASE_URL="postgres://..." node scripts/diagnose-db-cpu.js
```

Expected: Table output showing bottlenecks. Look for: high seq_scan_pct on price_history, large row counts, missing indexes, frequent background jobs.

**Step 3: Commit**

```bash
git add scripts/diagnose-db-cpu.js
git commit -m "feat: add TimescaleDB CPU diagnostic script"
```

---

### Task 2: Account Reconciliation Script

**Files:**
- Create: `scripts/reconcile-account.js`

**Step 1: Write the reconciliation script**

```javascript
#!/usr/bin/env node
/**
 * Account Reconciliation Script
 * Identifies unexplained capital differences by comparing trade records
 * with current account balance. Finds orphaned BUY trades (DELETE bug victims).
 */
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ? { rejectUnauthorized: false } : undefined,
});

async function run() {
  console.log('=== Account Reconciliation ===\n');

  // 1. Current account state
  const account = await pool.query(`
    SELECT current_capital, available_capital, initial_capital,
           total_realized_pnl, total_fees_paid, total_trades,
           winning_trades, losing_trades
    FROM paper_account WHERE id = 1
  `);
  const acct = account.rows[0];
  console.log('--- Current Account ---');
  console.table([acct]);

  // 2. Sum all trades
  const buys = await pool.query(`
    SELECT COUNT(*) AS count, COALESCE(SUM(value_usd), 0) AS total_value,
           COALESCE(SUM(fee), 0) AS total_fees
    FROM paper_trades WHERE side = 'buy'
  `);
  const sells = await pool.query(`
    SELECT COUNT(*) AS count, COALESCE(SUM(value_usd), 0) AS total_value,
           COALESCE(SUM(fee), 0) AS total_fees
    FROM paper_trades WHERE side = 'sell'
  `);

  const buyTotal = parseFloat(buys.rows[0].total_value);
  const sellTotal = parseFloat(sells.rows[0].total_value);
  const totalFees = parseFloat(buys.rows[0].total_fees) + parseFloat(sells.rows[0].total_fees);

  console.log('\n--- Trade Totals ---');
  console.log(`BUY trades:  ${buys.rows[0].count} | Total: $${buyTotal.toFixed(2)} | Fees: $${parseFloat(buys.rows[0].total_fees).toFixed(2)}`);
  console.log(`SELL trades: ${sells.rows[0].count} | Total: $${sellTotal.toFixed(2)} | Fees: $${parseFloat(sells.rows[0].total_fees).toFixed(2)}`);
  console.log(`Total fees from trades: $${totalFees.toFixed(2)}`);

  // 3. Expected capital
  const initial = parseFloat(acct.initial_capital);
  const expectedCapital = initial - buyTotal + sellTotal - totalFees;
  const actualCapital = parseFloat(acct.current_capital);
  const diff = actualCapital - expectedCapital;

  console.log('\n--- Reconciliation ---');
  console.log(`Initial capital:  $${initial.toFixed(2)}`);
  console.log(`- Total bought:   $${buyTotal.toFixed(2)}`);
  console.log(`+ Total sold:     $${sellTotal.toFixed(2)}`);
  console.log(`- Total fees:     $${totalFees.toFixed(2)}`);
  console.log(`= Expected:       $${expectedCapital.toFixed(2)}`);
  console.log(`  Actual:         $${actualCapital.toFixed(2)}`);
  console.log(`  Difference:     $${diff.toFixed(2)}`);

  // 4. Open positions (capital tied up)
  const openPositions = await pool.query(`
    SELECT COUNT(*) AS count,
           COALESCE(SUM(size * avg_entry_price), 0) AS capital_locked
    FROM paper_positions
    WHERE closed_at IS NULL AND size > 0
  `);
  console.log(`\nOpen positions: ${openPositions.rows[0].count} | Capital locked: $${parseFloat(openPositions.rows[0].capital_locked).toFixed(2)}`);

  // 5. Orphaned BUYs: buy trades with no matching sell and no open position
  const orphaned = await pool.query(`
    SELECT bt.market_id, bt.token_id, bt.time, bt.value_usd, bt.executed_size, bt.executed_price
    FROM paper_trades bt
    WHERE bt.side = 'buy'
      AND NOT EXISTS (
        SELECT 1 FROM paper_trades st
        WHERE st.market_id = bt.market_id AND st.token_id = bt.token_id
          AND st.side = 'sell' AND st.time > bt.time
      )
      AND NOT EXISTS (
        SELECT 1 FROM paper_positions pp
        WHERE pp.market_id = bt.market_id AND pp.token_id = bt.token_id
          AND pp.closed_at IS NULL AND pp.size > 0
      )
    ORDER BY bt.time DESC
  `);

  console.log(`\n--- Orphaned BUYs (no matching SELL, no open position) ---`);
  console.log(`Count: ${orphaned.rows.length}`);
  let orphanedValue = 0;
  for (const row of orphaned.rows) {
    orphanedValue += parseFloat(row.value_usd);
    console.log(`  ${row.time} | ${row.market_id.substring(0, 30)}... | $${parseFloat(row.value_usd).toFixed(2)}`);
  }
  console.log(`Total orphaned value: $${orphanedValue.toFixed(2)}`);

  // 6. Recommendation
  const adjustment = expectedCapital - actualCapital;
  console.log('\n--- Recommendation ---');
  if (Math.abs(adjustment) > 1) {
    console.log(`Adjust capital by $${adjustment.toFixed(2)} to match trade records.`);
    console.log(`SQL (review before running):`);
    console.log(`  UPDATE paper_account SET`);
    console.log(`    current_capital = current_capital + ${adjustment.toFixed(2)},`);
    console.log(`    available_capital = available_capital + ${adjustment.toFixed(2)}`);
    console.log(`  WHERE id = 1;`);
  } else {
    console.log('Account is reconciled within $1. No adjustment needed.');
  }

  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
```

**Step 2: Run locally**

```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 DATABASE_URL="postgres://..." node scripts/reconcile-account.js
```

Expected: Report showing the $2,674.78 gap and the orphaned BUY trades that caused it.

**Step 3: Commit**

```bash
git add scripts/reconcile-account.js
git commit -m "feat: add account reconciliation script"
```

---

## Phase 2: Core Fixes

### Task 3: PositionClosingService

**Files:**
- Create: `packages/dashboard/src/services/PositionClosingService.ts`
- Create: `packages/dashboard/src/services/PositionClosingService.test.ts`
- Modify: `packages/dashboard/src/services/StopLossService.ts:354-416`
- Modify: `packages/dashboard/src/services/PositionCleanupService.ts:231-280`
- Modify: `packages/dashboard/src/services/AutoSignalExecutor.ts:447-584`

**Step 1: Write the failing test**

Create `packages/dashboard/src/services/PositionClosingService.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the database module before importing the service
vi.mock('../database/index.js', () => ({
  query: vi.fn(),
  transaction: vi.fn(),
  isDatabaseConfigured: vi.fn(() => true),
}));

vi.mock('../database/repositories.js', () => ({
  paperTradesRepo: {
    create: vi.fn(),
  },
}));

import { PositionClosingService, ClosePositionParams } from './PositionClosingService.js';
import { query, transaction } from '../database/index.js';
import { paperTradesRepo } from '../database/repositories.js';

describe('PositionClosingService', () => {
  let service: PositionClosingService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new PositionClosingService({ feeRate: 0.001 });

    // Default: transaction executes the callback with a mock client
    const mockClient = { query: vi.fn() };
    vi.mocked(transaction).mockImplementation(async (cb) => cb(mockClient as any));
    vi.mocked(paperTradesRepo.create).mockResolvedValue({ id: 'trade-1' } as any);
  });

  it('computes PnL correctly for a profitable LONG close', async () => {
    const params: ClosePositionParams = {
      positionId: 1,
      marketId: 'market-1',
      tokenId: 'token-yes',
      side: 'long',
      size: 100,
      entryPrice: 0.40,
      exitPrice: 0.60,
      reason: 'signal',
    };

    const result = await service.close(params);

    // exitValue = 100 * 0.60 = 60
    // fee = 60 * 0.001 = 0.06
    // netPnl = (0.60 - 0.40) * 100 - 0.06 = 19.94
    expect(result.netPnl).toBeCloseTo(19.94, 2);
    expect(result.fee).toBeCloseTo(0.06, 4);
    expect(result.executed).toBe(true);
  });

  it('computes PnL correctly for a losing SHORT close', async () => {
    const params: ClosePositionParams = {
      positionId: 2,
      marketId: 'market-2',
      tokenId: 'token-no',
      side: 'short',
      size: 50,
      entryPrice: 0.80,
      exitPrice: 0.70,
      reason: 'stop_loss',
    };

    const result = await service.close(params);

    // exitValue = 50 * 0.70 = 35
    // fee = 35 * 0.001 = 0.035
    // netPnl = (0.70 - 0.80) * 50 - 0.035 = -5.035
    expect(result.netPnl).toBeCloseTo(-5.035, 3);
    expect(result.fee).toBeCloseTo(0.035, 4);
    expect(result.executed).toBe(true);
  });

  it('deducts fees from capital update (proceeds - fee)', async () => {
    const mockClient = {
      query: vi.fn(),
    };
    vi.mocked(transaction).mockImplementation(async (cb) => cb(mockClient as any));

    await service.close({
      positionId: 1,
      marketId: 'm1',
      tokenId: 't1',
      side: 'long',
      size: 100,
      entryPrice: 0.50,
      exitPrice: 0.60,
      reason: 'signal',
    });

    // Check the paper_account UPDATE was called with proceeds - fee
    const accountUpdate = mockClient.query.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('paper_account')
    );
    expect(accountUpdate).toBeDefined();
    const params = accountUpdate![1];
    // proceeds - fee = (100 * 0.60) - (60 * 0.001) = 59.94
    expect(params[0]).toBeCloseTo(59.94, 2);
    // fee = 0.06
    expect(params[1]).toBeCloseTo(0.06, 4);
  });

  it('returns early without error for already-closed position (idempotent)', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValueOnce({ rowCount: 0 }), // position update returns 0 rows
    };
    vi.mocked(transaction).mockImplementation(async (cb) => cb(mockClient as any));

    const result = await service.close({
      positionId: 99,
      marketId: 'm1',
      tokenId: 't1',
      side: 'long',
      size: 100,
      entryPrice: 0.50,
      exitPrice: 0.60,
      reason: 'signal',
    });

    expect(result.executed).toBe(false);
    expect(result.reason).toContain('already closed');
  });

  it('records trade with correct reason/signal_type', async () => {
    await service.close({
      positionId: 1,
      marketId: 'm1',
      tokenId: 't1',
      side: 'long',
      size: 100,
      entryPrice: 0.50,
      exitPrice: 0.60,
      reason: 'take_profit',
    });

    expect(paperTradesRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        signal_type: 'take_profit',
        side: 'sell',
        fee: expect.closeTo(0.06, 4),
      })
    );
  });

  it('rejects close when exitPrice is null', async () => {
    const result = await service.close({
      positionId: 1,
      marketId: 'm1',
      tokenId: 't1',
      side: 'long',
      size: 100,
      entryPrice: 0.50,
      exitPrice: NaN,
      reason: 'signal',
    });

    expect(result.executed).toBe(false);
    expect(result.reason).toContain('invalid exit price');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run packages/dashboard/src/services/PositionClosingService.test.ts
```

Expected: FAIL — module `./PositionClosingService.js` not found.

**Step 3: Write the PositionClosingService implementation**

Create `packages/dashboard/src/services/PositionClosingService.ts`:

```typescript
import { transaction } from '../database/index.js';
import { paperTradesRepo } from '../database/repositories.js';
import type { PoolClient } from 'pg';

export type CloseReason = 'signal' | 'stop_loss' | 'take_profit' | 'time_exit' | 'cleanup_inactive' | 'cleanup_resolved';

export interface ClosePositionParams {
  positionId: number;
  marketId: string;
  tokenId: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  exitPrice: number;
  reason: CloseReason;
  signalId?: string;
  predictionId?: string;
}

export interface ClosePositionResult {
  executed: boolean;
  netPnl: number;
  fee: number;
  reason?: string;
  tradeId?: string;
}

export interface PositionClosingConfig {
  feeRate: number;
}

const DEFAULT_CONFIG: PositionClosingConfig = {
  feeRate: 0.001,
};

/**
 * Centralized service for closing paper trading positions.
 * Single source of truth for PnL computation, fee handling, and account updates.
 * All position closes go through this service to ensure consistent accounting.
 */
export class PositionClosingService {
  private config: PositionClosingConfig;

  constructor(config?: Partial<PositionClosingConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async close(params: ClosePositionParams): Promise<ClosePositionResult> {
    const { positionId, marketId, tokenId, side, size, entryPrice, exitPrice, reason } = params;

    // Validate exit price
    if (!exitPrice || isNaN(exitPrice) || exitPrice < 0) {
      return { executed: false, netPnl: 0, fee: 0, reason: 'invalid exit price' };
    }

    // Compute financials
    const exitValue = size * exitPrice;
    const fee = exitValue * this.config.feeRate;
    const grossPnl = (exitPrice - entryPrice) * size;
    const netPnl = grossPnl - fee;
    const proceeds = exitValue - fee;

    try {
      const result = await transaction(async (client: PoolClient) => {
        // 1. Close the position (UPDATE with WHERE closed_at IS NULL for idempotency)
        const posResult = await client.query(
          `UPDATE paper_positions SET
            closed_at = NOW(),
            realized_pnl = $1,
            current_price = $2,
            size = 0
          WHERE id = $3 AND closed_at IS NULL`,
          [netPnl, exitPrice, positionId]
        );

        if (posResult.rowCount === 0) {
          return { executed: false, reason: 'already closed or not found' };
        }

        // 2. Update paper account
        await client.query(
          `UPDATE paper_account SET
            current_capital = current_capital + $1,
            available_capital = available_capital + $1,
            total_fees_paid = total_fees_paid + $2,
            total_trades = total_trades + 1,
            total_realized_pnl = total_realized_pnl + $3,
            winning_trades = winning_trades + CASE WHEN $3 > 0 THEN 1 ELSE 0 END,
            losing_trades = losing_trades + CASE WHEN $3 < 0 THEN 1 ELSE 0 END,
            updated_at = NOW()
          WHERE id = 1`,
          [proceeds, fee, netPnl]
        );

        return { executed: true };
      });

      if (!result.executed) {
        return { executed: false, netPnl: 0, fee: 0, reason: result.reason };
      }

      // 3. Record trade (outside transaction — non-critical)
      let tradeId: string | undefined;
      try {
        const trade = await paperTradesRepo.create({
          time: new Date(),
          market_id: marketId,
          token_id: tokenId,
          side: 'sell',
          requested_size: size,
          executed_size: size,
          requested_price: exitPrice,
          executed_price: exitPrice,
          fee,
          value_usd: exitValue,
          signal_id: params.predictionId,
          signal_type: reason,
          order_type: 'market',
          fill_type: 'full',
        });
        tradeId = trade.id;
      } catch (error) {
        console.error('[PositionClosingService] Failed to record trade (position already closed):', error);
      }

      return { executed: true, netPnl, fee, tradeId };

    } catch (error) {
      console.error('[PositionClosingService] Transaction failed:', error);
      return { executed: false, netPnl: 0, fee: 0, reason: `transaction failed: ${error}` };
    }
  }
}

// Singleton
let instance: PositionClosingService | null = null;

export function getPositionClosingService(): PositionClosingService {
  if (!instance) {
    const feeRate = parseFloat(process.env.TRADING_FEE_RATE || '0.001');
    instance = new PositionClosingService({ feeRate });
  }
  return instance;
}
```

**Step 4: Run tests and verify they pass**

```bash
npx vitest run packages/dashboard/src/services/PositionClosingService.test.ts
```

Expected: All 5 tests PASS.

**Step 5: Commit**

```bash
git add packages/dashboard/src/services/PositionClosingService.ts packages/dashboard/src/services/PositionClosingService.test.ts
git commit -m "feat: add PositionClosingService with consolidated close logic and tests"
```

---

### Task 4: Wire StopLossService to PositionClosingService

**Files:**
- Modify: `packages/dashboard/src/services/StopLossService.ts:354-416`

**Step 1: Replace closePosition() in StopLossService**

In `packages/dashboard/src/services/StopLossService.ts`, add import at top:

```typescript
import { getPositionClosingService } from './PositionClosingService.js';
```

Replace the `closePosition()` method (lines 354-416) with:

```typescript
  private async closePosition(
    positionId: number,
    marketId: string,
    tokenId: string,
    size: number,
    entryPrice: number,
    exitPrice: number,
    reason: 'stop_loss' | 'take_profit' | 'time_exit'
  ): Promise<{ pnl: number }> {
    const result = await getPositionClosingService().close({
      positionId,
      marketId,
      tokenId,
      side: 'long', // StopLoss determines side from position, but close logic handles both
      size,
      entryPrice,
      exitPrice,
      reason,
    });

    if (result.executed) {
      this.emit('position:closed', {
        marketId,
        reason,
        entryPrice,
        exitPrice,
        pnl: result.netPnl,
        pnlPct: ((exitPrice - entryPrice) / entryPrice) * 100,
      });
    }

    return { pnl: result.netPnl };
  }
```

**Note:** The `side` parameter needs to come from the actual position. Check if StopLossService has access to position.side in the caller. If the caller passes position data, extract `side` from there. If not, we may need to add it to the method signature. Check the callers of `closePosition` in StopLossService to determine.

**Step 2: Check callers pass the right side**

Read lines 150-353 of StopLossService.ts to find how `closePosition` is called and whether position.side is available. The caller likely has the full position object — pass `position.side` through.

If the caller has `position.side`, update the method signature to accept it:

```typescript
  private async closePosition(
    positionId: number,
    marketId: string,
    tokenId: string,
    side: 'long' | 'short',
    size: number,
    entryPrice: number,
    exitPrice: number,
    reason: 'stop_loss' | 'take_profit' | 'time_exit'
  ): Promise<{ pnl: number }> {
```

And update callers to pass `position.side`.

**Step 3: Run full test suite**

```bash
npx vitest run
```

Expected: All existing tests still pass.

**Step 4: Commit**

```bash
git add packages/dashboard/src/services/StopLossService.ts
git commit -m "fix: wire StopLossService to PositionClosingService for correct fee handling"
```

---

### Task 5: Wire PositionCleanupService to PositionClosingService

**Files:**
- Modify: `packages/dashboard/src/services/PositionCleanupService.ts:231-280`

**Step 1: Replace closePosition() in PositionCleanupService**

Add import at top:

```typescript
import { getPositionClosingService } from './PositionClosingService.js';
```

Replace the `closePosition()` method (lines 231-280) with:

```typescript
  private async closePosition(
    positionId: number,
    marketId: string,
    tokenId: string,
    side: 'long' | 'short',
    size: number,
    exitPrice: number,
    pnl: number, // kept for API compat but recalculated internally
    reason: 'inactive' | 'resolved'
  ): Promise<void> {
    const entryPrice = exitPrice - (pnl / size); // reverse-engineer entry price

    await getPositionClosingService().close({
      positionId,
      marketId,
      tokenId,
      side,
      size,
      entryPrice,
      exitPrice,
      reason: reason === 'inactive' ? 'cleanup_inactive' : 'cleanup_resolved',
    });
  }
```

**Note:** The current PositionCleanupService receives `pnl` as a parameter (pre-computed by caller). We need entry price for the new service. Check caller to see if `avg_entry_price` is available — it likely is since the position object has it. If so, change the caller to pass `entryPrice` directly instead of `pnl`, and simplify:

```typescript
  private async closePosition(
    positionId: number,
    marketId: string,
    tokenId: string,
    side: 'long' | 'short',
    size: number,
    entryPrice: number,
    exitPrice: number,
    reason: 'inactive' | 'resolved'
  ): Promise<void> {
    await getPositionClosingService().close({
      positionId,
      marketId,
      tokenId,
      side,
      size,
      entryPrice,
      exitPrice,
      reason: reason === 'inactive' ? 'cleanup_inactive' : 'cleanup_resolved',
    });
  }
```

Update callers accordingly.

**Step 2: Run tests**

```bash
npx vitest run
```

**Step 3: Commit**

```bash
git add packages/dashboard/src/services/PositionCleanupService.ts
git commit -m "fix: wire PositionCleanupService to PositionClosingService for correct fee handling"
```

---

### Task 6: Wire AutoSignalExecutor to PositionClosingService

**Files:**
- Modify: `packages/dashboard/src/services/AutoSignalExecutor.ts:447-584`

**Step 1: Refactor AutoSignalExecutor.closePosition()**

Add import at top:

```typescript
import { getPositionClosingService } from './PositionClosingService.js';
```

Replace the closePosition() method (lines 447-584). Keep the price lookup logic (lines 453-480) since it's specific to signal-based exits, but delegate the actual close to PositionClosingService:

```typescript
  private async closePosition(position: PaperPosition, signal: SignalResult): Promise<SignalProcessResult> {
    const shares = Number(position.size);
    const entryPrice = Number(position.avg_entry_price);

    // Get exit price from price_history (same logic as before)
    let exitPrice = signal.price;
    try {
      const isShort = position.side === 'short';
      const priceResult = await query<{ close: string; price_age_seconds: string }>(
        `SELECT ph.close, EXTRACT(EPOCH FROM (NOW() - ph.time)) as price_age_seconds
         FROM markets m
         JOIN LATERAL (
           SELECT close, time FROM price_history
           WHERE token_id = m.clob_token_id_yes
           ORDER BY time DESC LIMIT 1
         ) ph ON true
         WHERE m.id = $1 OR m.condition_id = $1
         LIMIT 1`,
        [position.market_id]
      );
      if (priceResult.rows[0]) {
        const yesPrice = parseFloat(priceResult.rows[0].close);
        const latestPrice = isShort ? 1 - yesPrice : yesPrice;
        if (latestPrice > 0 && !isNaN(latestPrice)) {
          exitPrice = latestPrice;
        }
      }
    } catch (error) {
      console.warn('[AutoExecutor] Failed to get price_history price for exit, using signal price:', error);
    }

    // Record signal prediction
    let prediction: SignalPrediction | null = null;
    try {
      prediction = await signalPredictionsRepo.create({
        time: new Date(),
        market_id: signal.marketId,
        signal_type: signal.signalId,
        direction: signal.direction,
        strength: signal.strength,
        confidence: signal.confidence,
        price_at_signal: signal.price,
        metadata: { ...signal.metadata, action: 'close' },
      });
    } catch (error) {
      console.error('Failed to record prediction:', error);
    }

    // Delegate close to centralized service
    const closeResult = await getPositionClosingService().close({
      positionId: (position as any).id,
      marketId: signal.marketId,
      tokenId: position.token_id,
      side: position.side,
      size: shares,
      entryPrice,
      exitPrice,
      reason: 'signal',
      signalId: signal.signalId,
      predictionId: prediction?.id,
    });

    if (!closeResult.executed) {
      return { executed: false, reason: closeResult.reason || 'Close failed' };
    }

    // Track the trade
    this.recentTrades.push({ marketId: signal.marketId, timestamp: Date.now() });
    this.dailyTradeCount++;
    this.cleanupOldTrades();

    const pnlStr = closeResult.netPnl >= 0 ? `+$${closeResult.netPnl.toFixed(2)}` : `-$${Math.abs(closeResult.netPnl).toFixed(2)}`;
    this.emit('trade:executed', {
      signal,
      tradeId: closeResult.tradeId,
      prediction,
      shares,
      value: shares * exitPrice,
      action: 'close',
      pnl: closeResult.netPnl,
    });

    console.log(`[AutoExecutor] CLOSED: SELL ${shares} shares of ${signal.marketId.substring(0, 20)}... @ $${exitPrice.toFixed(4)} | P&L: ${pnlStr}`);

    return {
      executed: true,
      tradeId: closeResult.tradeId,
      predictionId: prediction?.id,
      action: 'close',
      pnl: closeResult.netPnl,
    };
  }
```

**Step 2: Run tests**

```bash
npx vitest run
```

**Step 3: Commit**

```bash
git add packages/dashboard/src/services/AutoSignalExecutor.ts
git commit -m "refactor: wire AutoSignalExecutor to PositionClosingService"
```

---

### Task 7: Bayesian Confidence Cap Fix

**Files:**
- Modify: `packages/dashboard/src/services/SignalEngine.ts:721-746` (Bayesian cap)
- Modify: `packages/dashboard/src/services/SignalEngine.ts:55-62` (default config)
- Modify: `packages/dashboard/src/server.ts:81-121` (startup thresholds)

**Step 1: Write test for new Bayesian cap behavior**

Create `packages/dashboard/src/services/SignalEngine.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

/**
 * Test the Bayesian confidence cap logic in isolation.
 * We extract the pure function to test it without starting the full SignalEngine.
 */

// Replicate the computation logic for testing
function computeBayesianConfidenceCap(
  priceBars: { close: number; source?: string }[],
  minCap: number = 0.15
): number {
  const totalBars = priceBars.length;
  if (totalBars === 0) return 0;

  let informativeBars = 0;
  for (let i = 1; i < priceBars.length; i++) {
    const priceChanged = Math.abs(priceBars[i].close - priceBars[i - 1].close) > 1e-8;
    const isRealTrade = priceBars[i].source === 'trade';

    if (priceChanged || isRealTrade) {
      informativeBars++;
    }
  }

  const alpha0 = 1;
  const beta0 = 1;
  const alpha = alpha0 + informativeBars;
  const beta = beta0 + (totalBars - informativeBars);

  const priorVar = (alpha0 * beta0) / ((alpha0 + beta0) ** 2 * (alpha0 + beta0 + 1));
  const posteriorVar = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));

  const cap = 1 - (posteriorVar / priorVar);
  return Math.max(minCap, Math.min(1, cap));
}

describe('Bayesian Confidence Cap', () => {
  it('returns minCap for all-identical snapshot prices', () => {
    const bars = Array.from({ length: 20 }, () => ({ close: 0.5, source: 'snapshot' }));
    const cap = computeBayesianConfidenceCap(bars);
    expect(cap).toBe(0.15); // floor, not 0
  });

  it('returns high cap when prices change frequently', () => {
    const bars = Array.from({ length: 20 }, (_, i) => ({
      close: 0.5 + i * 0.01,
      source: 'trade',
    }));
    const cap = computeBayesianConfidenceCap(bars);
    expect(cap).toBeGreaterThan(0.8);
  });

  it('counts trade-sourced bars as informative even if price unchanged', () => {
    const bars = Array.from({ length: 10 }, () => ({ close: 0.5, source: 'trade' }));
    const cap = computeBayesianConfidenceCap(bars);
    expect(cap).toBeGreaterThan(0.15); // trades count as informative
  });

  it('returns 0 for empty bars', () => {
    expect(computeBayesianConfidenceCap([])).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run packages/dashboard/src/services/SignalEngine.test.ts
```

Expected: Should pass (pure function test). This establishes the expected behavior.

**Step 3: Update SignalEngine.ts — Bayesian cap method**

Modify lines 721-746 in `packages/dashboard/src/services/SignalEngine.ts`:

```typescript
  private computeBayesianConfidenceCap(priceBars: { close: number; source?: string }[]): number {
    const totalBars = priceBars.length;
    if (totalBars === 0) return 0;

    const MIN_CAP = 0.15; // Floor: even with no informative bars, allow strong signals through

    // Count informative bars:
    // - Price changed from previous bar, OR
    // - Bar came from a real trade (not snapshot)
    let informativeBars = 0;
    for (let i = 1; i < priceBars.length; i++) {
      const priceChanged = Math.abs(priceBars[i].close - priceBars[i - 1].close) > 1e-8;
      const isRealTrade = (priceBars[i] as any).source === 'trade';

      if (priceChanged || isRealTrade) {
        informativeBars++;
      }
    }

    // Beta-Binomial: prior Beta(alpha0, beta0) = Beta(1, 1) = uniform
    const alpha0 = 1;
    const beta0 = 1;
    const alpha = alpha0 + informativeBars;
    const beta = beta0 + (totalBars - informativeBars);

    // Variance of Beta distribution: ab / ((a+b)^2 * (a+b+1))
    const priorVar = (alpha0 * beta0) / ((alpha0 + beta0) ** 2 * (alpha0 + beta0 + 1));
    const posteriorVar = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));

    // Confidence = reduction in uncertainty, with floor
    const cap = 1 - (posteriorVar / priorVar);
    return Math.max(MIN_CAP, Math.min(1, cap));
  }
```

**Step 4: Update default thresholds in SignalEngine config**

Modify lines 55-62 in `SignalEngine.ts`:

```typescript
  minCombinedConfidence: 0.43,   // Default: moderate confidence (optimizer can tune)
  minCombinedStrength: 0.27,     // Default: moderate strength (optimizer can tune)
```

**Step 5: Update server.ts to lower minimum thresholds**

Modify lines 82-83 in `server.ts`:

```typescript
      const MIN_CONFIDENCE = 0.43;  // Minimum confidence threshold
      const MIN_STRENGTH = 0.27;    // Minimum strength threshold
```

**Step 6: Verify price bars include source field**

Check that `buildSignalContext()` in SignalEngine.ts includes the `source` column when querying price_history. If not, add it to the SELECT. The query likely looks like:

```sql
SELECT time, open, high, low, close, volume FROM price_history WHERE ...
```

Add `source` to the SELECT:

```sql
SELECT time, open, high, low, close, volume, source FROM price_history WHERE ...
```

**Step 7: Run tests**

```bash
npx vitest run
```

**Step 8: Commit**

```bash
git add packages/dashboard/src/services/SignalEngine.ts packages/dashboard/src/services/SignalEngine.test.ts packages/dashboard/src/server.ts
git commit -m "fix: adjust Bayesian cap for snapshot data, lower default thresholds to 0.43/0.27"
```

---

## Phase 3: Optimization Pipeline

### Task 8: Optuna PostgreSQL Migration

**Files:**
- Modify: `services/optimizer-server/app/optuna_optimizer.py`
- Modify: `services/optimizer-server/app/main.py`
- Modify: `services/optimizer-server/requirements.txt`

**Step 1: Add psycopg2-binary to requirements**

In `services/optimizer-server/requirements.txt`, add:

```
psycopg2-binary==2.9.9
```

**Step 2: Rewrite optuna_optimizer.py for PostgreSQL storage**

Replace `services/optimizer-server/app/optuna_optimizer.py` with:

```python
"""
Optuna-based optimizer with PostgreSQL persistence.

Studies persist across server restarts via Optuna's native RDB backend.
"""

import os
import optuna
from optuna.samplers import TPESampler, CmaEsSampler, RandomSampler, GridSampler
from typing import Dict, List, Optional, Any
from dataclasses import dataclass
import logging
import numpy as np

# Suppress Optuna's verbose logging
optuna.logging.set_verbosity(optuna.logging.WARNING)

logger = logging.getLogger(__name__)


def get_storage_url() -> str:
    """Get PostgreSQL storage URL from environment."""
    url = os.environ.get("DATABASE_URL", "")
    if not url:
        raise RuntimeError("DATABASE_URL environment variable is required")
    return url


@dataclass
class ParameterDefinition:
    """Definition of a single parameter to optimize"""
    name: str
    param_type: str  # 'float', 'int', 'categorical'
    low: Optional[float] = None
    high: Optional[float] = None
    choices: Optional[List[Any]] = None
    log: bool = False  # use log scale


class OptunaOptimizer:
    """
    Wrapper around Optuna study with PostgreSQL persistence.

    Studies are stored in PostgreSQL, so they survive server restarts.
    """

    def __init__(
        self,
        name: str,
        parameters: List[ParameterDefinition],
        direction: str = "maximize",
        sampler: str = "tpe",
        n_startup_trials: int = 10,
        seed: Optional[int] = None,
        storage: Optional[str] = None
    ):
        self.name = name
        self.parameters = {p.name: p for p in parameters}
        self.direction = direction
        self._storage = storage or get_storage_url()

        # Create sampler
        if sampler == "tpe":
            sampler_obj = TPESampler(
                n_startup_trials=n_startup_trials,
                seed=seed
            )
        elif sampler == "cmaes":
            sampler_obj = CmaEsSampler(seed=seed)
        elif sampler == "random":
            sampler_obj = RandomSampler(seed=seed)
        elif sampler == "grid":
            search_space = self._build_grid_search_space()
            sampler_obj = GridSampler(search_space)
        else:
            raise ValueError(f"Unknown sampler: {sampler}")

        # Create study with PostgreSQL storage
        self.study = optuna.create_study(
            study_name=name,
            direction=direction,
            sampler=sampler_obj,
            storage=self._storage,
            load_if_exists=False  # New study for each optimization run
        )

        # Track running trials (in-memory, acceptable to lose on restart
        # since the dashboard will create a new optimizer session)
        self._running_trials: Dict[int, optuna.trial.Trial] = {}
        self._trial_metrics: Dict[int, Dict[str, float]] = {}

    @classmethod
    def load(cls, name: str, storage: Optional[str] = None) -> 'OptunaOptimizer':
        """Load an existing study from PostgreSQL."""
        storage_url = storage or get_storage_url()
        study = optuna.load_study(study_name=name, storage=storage_url)

        instance = cls.__new__(cls)
        instance.name = name
        instance.study = study
        instance._storage = storage_url
        instance.parameters = {}
        instance._running_trials = {}
        instance._trial_metrics = {}
        instance.direction = study.direction.name.lower()
        return instance

    def _build_grid_search_space(self) -> Dict[str, List[Any]]:
        """Build search space for grid sampler"""
        search_space = {}
        for name, param in self.parameters.items():
            if param.param_type == "categorical":
                search_space[name] = param.choices
            elif param.param_type == "int":
                n_points = min(10, int(param.high - param.low + 1))
                search_space[name] = list(range(int(param.low), int(param.high) + 1,
                    max(1, int((param.high - param.low) / n_points))))
            elif param.param_type == "float":
                if param.log:
                    search_space[name] = list(np.logspace(
                        np.log10(param.low), np.log10(param.high), 10
                    ))
                else:
                    search_space[name] = list(np.linspace(param.low, param.high, 10))
        return search_space

    def suggest(self, n_suggestions: int = 1) -> List[Dict[str, Any]]:
        """Get parameter suggestions for the next trials."""
        suggestions = []

        for _ in range(n_suggestions):
            trial = self.study.ask()

            params = {}
            for name, param in self.parameters.items():
                if param.param_type == "float":
                    params[name] = trial.suggest_float(
                        name, param.low, param.high, log=param.log
                    )
                elif param.param_type == "int":
                    params[name] = trial.suggest_int(
                        name, int(param.low), int(param.high), log=param.log
                    )
                elif param.param_type == "categorical":
                    params[name] = trial.suggest_categorical(name, param.choices)

            self._running_trials[trial.number] = trial

            suggestions.append({
                "trial_id": trial.number,
                "params": params
            })

        return suggestions

    def report(
        self,
        trial_id: int,
        score: float,
        metrics: Optional[Dict[str, float]] = None
    ):
        """Report the result of a trial."""
        if trial_id not in self._running_trials:
            raise ValueError(f"Unknown trial_id: {trial_id}")

        trial = self._running_trials[trial_id]

        if metrics:
            for key, value in metrics.items():
                trial.set_user_attr(key, value)
            self._trial_metrics[trial_id] = metrics

        self.study.tell(trial, score)
        del self._running_trials[trial_id]

    def get_best(self) -> Optional[Dict[str, Any]]:
        """Get the best parameters found so far"""
        if self.n_complete_trials == 0:
            return None

        best_trial = self.study.best_trial
        return {
            "params": best_trial.params,
            "score": best_trial.value,
            "trial_id": best_trial.number,
            "metrics": self._trial_metrics.get(best_trial.number, {})
        }

    def get_optimization_history(self) -> List[Dict[str, Any]]:
        """Get the optimization history"""
        history = []
        for trial in self.study.trials:
            if trial.state == optuna.trial.TrialState.COMPLETE:
                history.append({
                    "trial_id": trial.number,
                    "params": trial.params,
                    "score": trial.value,
                    "metrics": self._trial_metrics.get(trial.number, {})
                })
        return history

    def get_param_importances(self) -> Dict[str, float]:
        """Get parameter importance scores"""
        if self.n_complete_trials < 10:
            return {}

        try:
            importances = optuna.importance.get_param_importances(self.study)
            return dict(importances)
        except Exception as e:
            logger.warning(f"Could not compute parameter importances: {e}")
            return {}

    @property
    def n_trials(self) -> int:
        return len(self.study.trials)

    @property
    def n_complete_trials(self) -> int:
        return len([t for t in self.study.trials
                   if t.state == optuna.trial.TrialState.COMPLETE])

    @property
    def n_running_trials(self) -> int:
        return len(self._running_trials)

    @staticmethod
    def delete_study(name: str, storage: Optional[str] = None):
        """Delete a study from PostgreSQL storage."""
        storage_url = storage or get_storage_url()
        try:
            optuna.delete_study(study_name=name, storage=storage_url)
        except KeyError:
            pass  # Study doesn't exist, that's fine


# Keep predefined parameter spaces unchanged
def get_default_parameter_space() -> List[ParameterDefinition]:
    return [
        ParameterDefinition("combiner.minCombinedConfidence", "float", 0.1, 0.7),
        ParameterDefinition("combiner.minCombinedStrength", "float", 0.1, 0.7),
        ParameterDefinition("combiner.onlyDirection", "categorical", choices=[None, "LONG", "SHORT"]),
        ParameterDefinition("combiner.momentumWeight", "float", 0.0, 3.0),
        ParameterDefinition("combiner.meanReversionWeight", "float", 0.0, 3.0),
        ParameterDefinition("combiner.conflictResolution", "categorical", choices=["weighted", "strongest", "majority"]),
        ParameterDefinition("combiner.timeDecayFactor", "float", 0.5, 1.0),
        ParameterDefinition("combiner.maxSignalAgeMinutes", "int", 5, 60),
        ParameterDefinition("risk.maxPositionSizePct", "float", 1.0, 25.0),
        ParameterDefinition("risk.maxExposurePct", "float", 20.0, 100.0),
        ParameterDefinition("risk.stopLossPct", "float", 5.0, 40.0),
        ParameterDefinition("risk.takeProfitPct", "float", 10.0, 150.0),
        ParameterDefinition("risk.maxPositions", "int", 3, 30),
        ParameterDefinition("risk.maxDrawdownPct", "float", 10.0, 40.0),
        ParameterDefinition("risk.minCashBufferPct", "float", 5.0, 30.0),
        ParameterDefinition("sizing.method", "categorical", choices=["fixed", "kelly", "volatility_adjusted"]),
        ParameterDefinition("sizing.kellyFraction", "float", 0.1, 0.5),
        ParameterDefinition("sizing.volatilityLookback", "int", 10, 50),
        ParameterDefinition("momentum.rsiPeriod", "int", 5, 28),
        ParameterDefinition("momentum.rsiOverbought", "float", 60.0, 90.0),
        ParameterDefinition("momentum.rsiOversold", "float", 10.0, 40.0),
        ParameterDefinition("momentum.macdFast", "int", 6, 18),
        ParameterDefinition("momentum.macdSlow", "int", 18, 35),
        ParameterDefinition("momentum.macdSignal", "int", 5, 15),
        ParameterDefinition("momentum.trendLookback", "int", 10, 50),
        ParameterDefinition("momentum.minTrendStrength", "float", 0.0, 0.3),
        ParameterDefinition("meanReversion.bollingerPeriod", "int", 10, 40),
        ParameterDefinition("meanReversion.bollingerStdDev", "float", 1.0, 4.0),
        ParameterDefinition("meanReversion.zScorePeriod", "int", 5, 40),
        ParameterDefinition("meanReversion.zScoreThreshold", "float", 1.0, 4.0),
        ParameterDefinition("meanReversion.meanType", "categorical", choices=["sma", "ema", "wma"]),
        ParameterDefinition("marketFilters.minVolume24h", "float", 100.0, 10000.0, log=True),
        ParameterDefinition("marketFilters.minLiquidity", "float", 1000.0, 50000.0, log=True),
        ParameterDefinition("marketFilters.priceRangeMin", "float", 0.02, 0.15),
        ParameterDefinition("marketFilters.priceRangeMax", "float", 0.85, 0.98),
        ParameterDefinition("marketFilters.minDaysToExpiry", "int", 1, 14),
        ParameterDefinition("timing.tradingHoursStart", "int", 0, 12),
        ParameterDefinition("timing.tradingHoursEnd", "int", 12, 24),
        ParameterDefinition("timing.avoidWeekends", "categorical", choices=[True, False]),
        ParameterDefinition("timing.minBarsBetweenTrades", "int", 1, 24),
        ParameterDefinition("execution.slippageModel", "categorical", choices=["fixed", "proportional", "orderbook"]),
        ParameterDefinition("execution.fixedSlippageBps", "int", 10, 100),
        ParameterDefinition("execution.maxSlippagePct", "float", 0.5, 3.0),
    ]


def get_minimal_parameter_space() -> List[ParameterDefinition]:
    return [
        ParameterDefinition("combiner.minCombinedConfidence", "float", 0.1, 0.6),
        ParameterDefinition("combiner.minCombinedStrength", "float", 0.1, 0.6),
        ParameterDefinition("combiner.onlyDirection", "categorical", choices=[None, "LONG", "SHORT"]),
        ParameterDefinition("risk.maxPositionSizePct", "float", 2.0, 20.0),
        ParameterDefinition("risk.maxPositions", "int", 3, 20),
        ParameterDefinition("momentum.rsiPeriod", "int", 7, 21),
        ParameterDefinition("meanReversion.bollingerPeriod", "int", 15, 30),
        ParameterDefinition("meanReversion.zScoreThreshold", "float", 1.5, 3.0),
    ]
```

**Step 3: Rewrite main.py to use study names instead of in-memory dict**

Replace `services/optimizer-server/app/main.py`:

```python
"""
Polymarket Strategy Optimizer Server

FastAPI server that provides Bayesian optimization via Optuna
with PostgreSQL persistence for the TypeScript trading system.
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Dict, List, Optional, Any
import uuid
from datetime import datetime

from .optuna_optimizer import OptunaOptimizer, ParameterDefinition

app = FastAPI(
    title="Polymarket Strategy Optimizer",
    description="Bayesian optimization service with PostgreSQL persistence",
    version="2.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Track active optimizer names (for suggest/report with in-memory running trials)
# The actual study data is in PostgreSQL — this just maps IDs to loaded instances
_active_optimizers: Dict[str, OptunaOptimizer] = {}


# ============================================
# Request/Response Models (unchanged API contract)
# ============================================

class ParameterBounds(BaseModel):
    name: str
    type: str
    low: Optional[float] = None
    high: Optional[float] = None
    choices: Optional[List[Any]] = None
    log: bool = False

class CreateOptimizerRequest(BaseModel):
    name: str
    parameters: List[ParameterBounds]
    direction: str = "maximize"
    sampler: str = "tpe"
    n_startup_trials: int = 10

class CreateOptimizerResponse(BaseModel):
    optimizer_id: str
    name: str
    parameter_names: List[str]
    created_at: str

class SuggestRequest(BaseModel):
    optimizer_id: str
    n_suggestions: int = 1

class SuggestResponse(BaseModel):
    trial_ids: List[int]
    suggestions: List[Dict[str, Any]]

class ReportRequest(BaseModel):
    optimizer_id: str
    trial_id: int
    score: float
    metrics: Optional[Dict[str, float]] = None

class ReportResponse(BaseModel):
    recorded: bool
    best_score: Optional[float]
    best_params: Optional[Dict[str, Any]]
    n_trials: int

class BestParamsResponse(BaseModel):
    best_params: Optional[Dict[str, Any]]
    best_score: Optional[float]
    n_trials: int
    optimization_history: List[Dict[str, Any]]

class OptimizerStatusResponse(BaseModel):
    optimizer_id: str
    name: str
    n_trials: int
    n_complete: int
    n_running: int
    best_score: Optional[float]
    best_params: Optional[Dict[str, Any]]


# ============================================
# Helpers
# ============================================

def _get_optimizer(optimizer_id: str) -> OptunaOptimizer:
    """Get optimizer from active cache, or try to reload from DB."""
    if optimizer_id in _active_optimizers:
        return _active_optimizers[optimizer_id]

    # Try loading from PostgreSQL (study_name = optimizer_id)
    try:
        optimizer = OptunaOptimizer.load(optimizer_id)
        _active_optimizers[optimizer_id] = optimizer
        return optimizer
    except Exception:
        raise HTTPException(status_code=404, detail="Optimizer not found")


# ============================================
# Endpoints
# ============================================

@app.get("/health")
async def health_check():
    return {"status": "healthy", "timestamp": datetime.utcnow().isoformat()}


@app.post("/optimizer/create", response_model=CreateOptimizerResponse)
async def create_optimizer(request: CreateOptimizerRequest):
    """Create a new optimization session with PostgreSQL-backed study."""
    # Use a unique study name as the optimizer_id
    optimizer_id = f"{request.name}-{uuid.uuid4().hex[:8]}"

    param_defs = []
    for p in request.parameters:
        param_def = ParameterDefinition(
            name=p.name,
            param_type=p.type,
            low=p.low,
            high=p.high,
            choices=p.choices,
            log=p.log
        )
        param_defs.append(param_def)

    optimizer = OptunaOptimizer(
        name=optimizer_id,
        parameters=param_defs,
        direction=request.direction,
        sampler=request.sampler,
        n_startup_trials=request.n_startup_trials
    )

    _active_optimizers[optimizer_id] = optimizer

    return CreateOptimizerResponse(
        optimizer_id=optimizer_id,
        name=request.name,
        parameter_names=[p.name for p in request.parameters],
        created_at=datetime.utcnow().isoformat()
    )


@app.post("/optimizer/suggest", response_model=SuggestResponse)
async def suggest_params(request: SuggestRequest):
    optimizer = _get_optimizer(request.optimizer_id)
    suggestions = optimizer.suggest(request.n_suggestions)

    return SuggestResponse(
        trial_ids=[s["trial_id"] for s in suggestions],
        suggestions=[s["params"] for s in suggestions]
    )


@app.post("/optimizer/report", response_model=ReportResponse)
async def report_result(request: ReportRequest):
    optimizer = _get_optimizer(request.optimizer_id)
    optimizer.report(request.trial_id, request.score, request.metrics)

    best = optimizer.get_best()

    return ReportResponse(
        recorded=True,
        best_score=best["score"] if best else None,
        best_params=best["params"] if best else None,
        n_trials=optimizer.n_complete_trials
    )


@app.get("/optimizer/{optimizer_id}/best", response_model=BestParamsResponse)
async def get_best_params(optimizer_id: str):
    optimizer = _get_optimizer(optimizer_id)
    best = optimizer.get_best()
    history = optimizer.get_optimization_history()

    return BestParamsResponse(
        best_params=best["params"] if best else None,
        best_score=best["score"] if best else None,
        n_trials=optimizer.n_complete_trials,
        optimization_history=history
    )


@app.get("/optimizer/{optimizer_id}/status", response_model=OptimizerStatusResponse)
async def get_optimizer_status(optimizer_id: str):
    optimizer = _get_optimizer(optimizer_id)
    best = optimizer.get_best()

    return OptimizerStatusResponse(
        optimizer_id=optimizer_id,
        name=optimizer.name,
        n_trials=optimizer.n_trials,
        n_complete=optimizer.n_complete_trials,
        n_running=optimizer.n_running_trials,
        best_score=best["score"] if best else None,
        best_params=best["params"] if best else None
    )


@app.delete("/optimizer/{optimizer_id}")
async def delete_optimizer(optimizer_id: str):
    # Remove from active cache
    _active_optimizers.pop(optimizer_id, None)

    # Delete study from PostgreSQL
    OptunaOptimizer.delete_study(optimizer_id)

    return {"deleted": True}


@app.get("/optimizers")
async def list_optimizers():
    result = []
    for opt_id, optimizer in _active_optimizers.items():
        best = optimizer.get_best()
        result.append({
            "optimizer_id": opt_id,
            "name": optimizer.name,
            "n_trials": optimizer.n_complete_trials,
            "best_score": best["score"] if best else None
        })
    return {"optimizers": result}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
```

**Step 4: Deploy to Render**

Add `DATABASE_URL` environment variable to the Render service, pointing to TimescaleDB on the GCP VM. The URL format:

```
postgresql://polymarket:polymarket_prod@<VM_EXTERNAL_IP>:5432/polymarket_trading
```

**Note:** TimescaleDB must accept external connections. If it only listens on Docker network, you'll need to either:
- Expose port 5432 on the VM (add firewall rule, only allow Render IPs)
- Or use an SSH tunnel

If external access isn't feasible, an alternative is to deploy the optimizer on the GCP VM itself as a Docker container alongside TimescaleDB.

**Step 5: Commit**

```bash
git add services/optimizer-server/
git commit -m "feat: migrate Optuna to PostgreSQL-backed storage for restart resilience"
```

---

### Task 9: Wire Optimization Weights to signal_weights Table

**Files:**
- Modify: `packages/dashboard/src/services/OptimizationScheduler.ts:637-740`
- Modify: `packages/dashboard/src/server.ts:81-121`

**Step 1: Add weight application to updateStrategy()**

In `OptimizationScheduler.ts`, after line 678 (the DB save), add the weight extraction and application:

```typescript
    // Apply optimized signal weights to database
    const WEIGHT_PARAM_MAP: Record<string, string> = {
      'combiner.momentumWeight': 'momentum',
      'combiner.meanReversionWeight': 'mean_reversion',
    };

    const MIN_WEIGHT = 0.05;
    const MAX_WEIGHT = 0.95;

    for (const [paramKey, signalType] of Object.entries(WEIGHT_PARAM_MAP)) {
      const rawWeight = result.params[paramKey];
      if (rawWeight !== undefined && rawWeight !== null) {
        const weight = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, Number(rawWeight)));

        try {
          await signalWeightsRepo.update(signalType, weight, `optimization-${new Date().toISOString().slice(0, 10)}`);
          console.log(`[OptimizationScheduler] Updated signal weight: ${signalType} = ${weight.toFixed(4)}`);
        } catch (err) {
          console.error(`[OptimizationScheduler] Failed to update weight ${signalType}:`, err);
        }
      }
    }
```

Add import at top if not already present:

```typescript
import { signalWeightsRepo } from '../database/repositories.js';
```

**Step 2: Update server.ts to load signal weights from best_params on startup**

After the existing threshold loading in `server.ts` (around line 105), add:

```typescript
          // Also load optimized signal weights
          const weightMap: Record<string, string> = {
            'combiner.momentumWeight': 'momentum',
            'combiner.meanReversionWeight': 'mean_reversion',
          };
          for (const [paramKey, signalType] of Object.entries(weightMap)) {
            const w = params[paramKey];
            if (w !== undefined) {
              try {
                await signalWeightsRepo.update(signalType, Number(w), 'startup-load');
                console.log(`Loaded optimized weight: ${signalType} = ${w}`);
              } catch (err) {
                console.warn(`Failed to load weight ${signalType}:`, err);
              }
            }
          }
```

Add import:
```typescript
import { signalWeightsRepo } from './database/repositories.js';
```

**Step 3: Run tests**

```bash
npx vitest run
```

**Step 4: Commit**

```bash
git add packages/dashboard/src/services/OptimizationScheduler.ts packages/dashboard/src/server.ts
git commit -m "feat: wire optimization weights to signal_weights table"
```

---

## Phase 4: Validate

### Task 10: Apply DB Mitigations (Based on Phase 1 Findings)

This task depends on the output of Task 1 (TimescaleDB diagnostics). Based on findings, apply one or more of:

**If price_history has no retention policy:**

```sql
-- Add 30-day retention (run via psql on VM)
SELECT add_retention_policy('price_history', INTERVAL '30 days');
```

**If price_history missing indexes:**

```sql
-- Composite index for signal engine queries
CREATE INDEX IF NOT EXISTS idx_price_history_token_time
  ON price_history (token_id, time DESC);
```

**If continuous aggregate refresh is too frequent:**

```sql
-- Check current policy
SELECT * FROM timescaledb_information.jobs WHERE proc_name LIKE '%refresh%';

-- Reduce frequency if needed (example)
SELECT alter_job(<job_id>, schedule_interval => INTERVAL '30 minutes');
```

**If too many connections:**

Reduce `DB_POOL_MAX` in docker-compose.gcp.yml from 5 to 3 per service.

**Step 1: Run diagnostics, analyze output, apply fixes**

**Step 2: Commit any migration SQL files or docker-compose changes**

```bash
git commit -m "fix: apply TimescaleDB performance mitigations"
```

---

### Task 11: Account Reconciliation (Run and Apply)

**Step 1: Run the reconciliation script from Task 2**

```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 DATABASE_URL="..." node scripts/reconcile-account.js
```

**Step 2: Review the output**

Verify the orphaned BUYs match the expected ~$2,674.78 gap.

**Step 3: Apply the adjustment (after review)**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b -- \
  'docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c "
    UPDATE paper_account SET
      current_capital = current_capital + <ADJUSTMENT>,
      available_capital = available_capital + <ADJUSTMENT>
    WHERE id = 1;
  "'
```

---

### Task 12: Deploy and Monitor

**Step 1: Push changes and let CI/CD build images**

```bash
git push origin main
```

**Step 2: Deploy to VM**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b -- '
  cd /opt/polymarket-trader &&
  docker compose -f docker-compose.gcp.yml pull &&
  docker compose -f docker-compose.gcp.yml up -d --remove-orphans
'
```

**Step 3: Monitor for 24h**

Check these after deploy:
```bash
# Signals being generated
gcloud compute ssh polymarket-vm --zone=us-east1-b -- \
  'docker compose -f docker-compose.gcp.yml logs --tail=50 dashboard-api | grep -E "(signals generated|Signal|CLOSED|OPENED)"'

# DB CPU
gcloud compute ssh polymarket-vm --zone=us-east1-b -- \
  'docker stats --no-stream'

# Account health
NODE_TLS_REJECT_UNAUTHORIZED=0 DATABASE_URL="..." node scripts/check-status.js
```

**Step 4: Verify optimization runs successfully**

Wait for next scheduled optimization (every 6h) and check:
```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b -- \
  'docker compose -f docker-compose.gcp.yml logs --tail=100 dashboard-api | grep -i optim'
```

Expected: No more "Optimizer not found" 404 errors. Weights should update in signal_weights table.

---

## Summary

| Task | Phase | Estimated Steps | Key File |
|------|-------|----------------|----------|
| 1. DB Diagnostics | 1 | 3 | `scripts/diagnose-db-cpu.js` |
| 2. Account Reconciliation | 1 | 3 | `scripts/reconcile-account.js` |
| 3. PositionClosingService | 2 | 5 | `packages/dashboard/src/services/PositionClosingService.ts` |
| 4. Wire StopLossService | 2 | 4 | `packages/dashboard/src/services/StopLossService.ts` |
| 5. Wire PositionCleanupService | 2 | 3 | `packages/dashboard/src/services/PositionCleanupService.ts` |
| 6. Wire AutoSignalExecutor | 2 | 3 | `packages/dashboard/src/services/AutoSignalExecutor.ts` |
| 7. Bayesian Cap Fix | 2 | 8 | `packages/dashboard/src/services/SignalEngine.ts` |
| 8. Optuna PostgreSQL | 3 | 5 | `services/optimizer-server/app/main.py` |
| 9. Wire Weights | 3 | 4 | `packages/dashboard/src/services/OptimizationScheduler.ts` |
| 10. DB Mitigations | 4 | 2 | SQL on VM |
| 11. Account Fix | 4 | 3 | SQL on VM |
| 12. Deploy & Monitor | 4 | 4 | CI/CD |

**Parallel execution opportunities:**
- Tasks 1+2 (both diagnostic scripts)
- Tasks 3-6 and Task 7 (position closing vs signal engine — independent)
- Tasks 8+9 and Tasks 3-7 (optimization vs core fixes — different codepaths)
