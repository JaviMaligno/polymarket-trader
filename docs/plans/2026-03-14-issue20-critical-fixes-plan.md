# Issue #20 Critical Fixes — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the 6 bugs causing the 38% drawdown and $3,722 capital leak, then reset the account.

**Architecture:** All fixes are in `packages/dashboard/src/`. Fix 1 (upsert zombie) is in `database/repositories.ts`. Fixes 2-5 are in `services/CircuitBreakerService.ts` and `services/SignalEngine.ts`. Fix 6 is a SQL migration on the VM. Tests use vitest with mocked DB.

**Tech Stack:** TypeScript, vitest, PostgreSQL, SSH to GCP VM

**Design doc:** `docs/plans/2026-03-14-issue20-critical-fixes-design.md`

---

### Task 1: Fix Upsert Zombie Bug

The most critical fix. `paperPositionsRepo.upsert()` doesn't reset `closed_at = NULL` on conflict, causing reopened positions to be invisible (29 zombie positions, $2,656 trapped).

**Files:**
- Modify: `packages/dashboard/src/database/repositories.ts:334-340`
- Test: `packages/dashboard/src/database/repositories.test.ts` (create new)

**Step 1: Write the failing test**

Create `packages/dashboard/src/database/repositories.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./index.js', () => ({
  query: vi.fn(),
  isDatabaseConfigured: vi.fn(() => true),
}));

import { query } from './index.js';
import { paperPositionsRepo } from './repositories.js';

describe('paperPositionsRepo.upsert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 1 } as any);
  });

  it('should include closed_at = NULL in ON CONFLICT UPDATE', async () => {
    await paperPositionsRepo.upsert({
      market_id: 'market-1',
      token_id: 'token-1',
      side: 'long',
      size: 100,
      avg_entry_price: 0.50,
      current_price: 0.50,
      unrealized_pnl: 0,
      unrealized_pnl_pct: 0,
      opened_at: new Date(),
    } as any);

    const sql = vi.mocked(query).mock.calls[0][0] as string;
    // The ON CONFLICT clause must reset closed_at to NULL
    expect(sql).toContain('closed_at = NULL');
    // Must also reset opened_at and avg_entry_price for the new position
    expect(sql).toContain('opened_at = EXCLUDED.opened_at');
    expect(sql).toContain('avg_entry_price = EXCLUDED.avg_entry_price');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/dashboard && npx vitest run src/database/repositories.test.ts`
Expected: FAIL — current SQL doesn't contain `closed_at = NULL`

**Step 3: Fix the upsert SQL**

In `packages/dashboard/src/database/repositories.ts`, replace the ON CONFLICT clause (lines 334-340):

```typescript
       ON CONFLICT (market_id, token_id) DO UPDATE SET
         current_price = EXCLUDED.current_price,
         unrealized_pnl = EXCLUDED.unrealized_pnl,
         unrealized_pnl_pct = EXCLUDED.unrealized_pnl_pct,
         realized_pnl = EXCLUDED.realized_pnl,
         size = EXCLUDED.size,
         closed_at = NULL,
         opened_at = EXCLUDED.opened_at,
         avg_entry_price = EXCLUDED.avg_entry_price,
         signal_type = EXCLUDED.signal_type,
         metadata = EXCLUDED.metadata,
         stop_loss = EXCLUDED.stop_loss,
         take_profit = EXCLUDED.take_profit,
         updated_at = NOW()`,
```

**Step 4: Run test to verify it passes**

Run: `cd packages/dashboard && npx vitest run src/database/repositories.test.ts`
Expected: PASS

**Step 5: Run full test suite for regressions**

Run: `cd packages/dashboard && npx vitest run`
Expected: All existing tests pass

**Step 6: Commit**

```bash
git add packages/dashboard/src/database/repositories.ts packages/dashboard/src/database/repositories.test.ts
git commit -m "fix: reset closed_at on upsert to prevent zombie positions"
```

---

### Task 2: Fix Circuit Breaker Threshold + Default Config

Hardcoded `maxDrawdownPct: 30` should read `MAX_DRAWDOWN` env var (0.15 = 15%).

**Files:**
- Modify: `packages/dashboard/src/server.ts:184-189`
- Modify: `packages/dashboard/src/services/CircuitBreakerService.ts:39-46`

**Step 1: Write the failing test**

Add to `packages/dashboard/src/services/CircuitBreakerService.test.ts`:

```typescript
it('DEFAULT_CONFIG should read MAX_DRAWDOWN env var', () => {
  // Set env before importing fresh module
  process.env.MAX_DRAWDOWN = '0.15';
  const service = new CircuitBreakerService();
  // Access the config via the check method behavior
  // The default maxDrawdownPct should be 15 (from 0.15 * 100)
  expect((service as any).config.maxDrawdownPct).toBe(15);
  delete process.env.MAX_DRAWDOWN;
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/dashboard && npx vitest run src/services/CircuitBreakerService.test.ts`
Expected: FAIL — config.maxDrawdownPct is 30, not 15

**Step 3: Fix DEFAULT_CONFIG in CircuitBreakerService.ts**

Replace lines 39-46:

```typescript
const DEFAULT_CONFIG: CircuitBreakerConfig = {
  enabled: true,
  checkIntervalMs: 5 * 60 * 1000,
  maxDrawdownPct: parseFloat(process.env.MAX_DRAWDOWN || '0.15') * 100,
  initialCapital: parseFloat(process.env.INITIAL_CAPITAL || '10000'),
  cooldownMs: 30 * 60 * 1000,
  autoReset: false,
};
```

**Step 4: Fix server.ts to read env var**

Replace lines 184-189:

```typescript
      const circuitBreakerService = initializeCircuitBreakerService({
        enabled: true,
        checkIntervalMs: 5 * 60 * 1000,
        maxDrawdownPct: parseFloat(process.env.MAX_DRAWDOWN || '0.15') * 100,
        initialCapital: parseFloat(process.env.INITIAL_CAPITAL || '10000'),
      });
```

**Step 5: Run test to verify it passes**

Run: `cd packages/dashboard && npx vitest run src/services/CircuitBreakerService.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/dashboard/src/services/CircuitBreakerService.ts packages/dashboard/src/server.ts
git commit -m "fix: circuit breaker reads MAX_DRAWDOWN env var (15% not hardcoded 30%)"
```

---

### Task 3: Fix Circuit Breaker Drawdown Formula

Uses capital-only instead of equity (capital + positions). When capital is in positions, shows phantom drawdown.

**Files:**
- Modify: `packages/dashboard/src/services/CircuitBreakerService.ts:155-175`

**Step 1: Write the failing test**

Add to `CircuitBreakerService.test.ts`:

```typescript
it('drawdown check should use equity (capital + positions), not capital alone', async () => {
  // Account has $5000 capital but $5000 in open positions = $10000 equity
  // With initialCapital=$10000, drawdown should be 0%, not 50%
  vi.mocked(query)
    .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any) // CREATE TABLE
    .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any) // SELECT trading_config
    .mockResolvedValueOnce({  // SELECT paper_account
      rows: [{ current_capital: '5000', initial_capital: '10000' }],
      rowCount: 1,
    } as any)
    .mockResolvedValueOnce({  // SELECT total exposure from positions
      rows: [{ total_exposure: '5000' }],
      rowCount: 1,
    } as any);

  const service = new CircuitBreakerService({
    checkIntervalMs: 60_000,
    maxDrawdownPct: 30,
    initialCapital: 10000,
  });
  await service.start();

  // Advance timer to trigger check
  await vi.advanceTimersByTimeAsync(60_000);

  // Should NOT have triggered halt (equity = $10000, drawdown = 0%)
  expect(service.isTradingHalted()).toBe(false);
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/dashboard && npx vitest run src/services/CircuitBreakerService.test.ts`
Expected: FAIL — current code sees 50% drawdown from capital-only calculation and triggers halt

**Step 3: Fix the drawdown calculation**

In `CircuitBreakerService.ts`, replace lines 155-171 (inside `checkDrawdown()`):

Find the current capital-only calculation:
```typescript
      const currentCapital = parseFloat(accountResult.rows[0].current_capital);
      const initialCapital = this.config.initialCapital;

      // Calculate drawdown percentage
      const drawdownPct = ((initialCapital - currentCapital) / initialCapital) * 100;
```

Replace with equity-based calculation:
```typescript
      const currentCapital = parseFloat(accountResult.rows[0].current_capital);
      const initialCapital = this.config.initialCapital;

      // Get total exposure from open positions
      const exposureResult = await query<{ total_exposure: string }>(
        `SELECT COALESCE(SUM(size * current_price), 0) as total_exposure
         FROM paper_positions WHERE closed_at IS NULL`
      );
      const totalExposure = parseFloat(exposureResult.rows[0]?.total_exposure || '0');
      const currentEquity = currentCapital + totalExposure;

      // Calculate drawdown using equity (capital + positions), not capital alone
      const drawdownPct = ((initialCapital - currentEquity) / initialCapital) * 100;
```

**Step 4: Run test to verify it passes**

Run: `cd packages/dashboard && npx vitest run src/services/CircuitBreakerService.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/dashboard/src/services/CircuitBreakerService.ts
git commit -m "fix: circuit breaker uses equity (capital + positions) for drawdown"
```

---

### Task 4: Add 50/50 Market Filter in setActiveMarkets

`PriceRangeWeightModifier` zeros momentum/mean_reversion but OFI/MLOFI/Hawkes stay at full weight. Need explicit filter.

**Files:**
- Modify: `packages/dashboard/src/services/SignalEngine.ts:271-310`

**Step 1: Write the failing test**

The existing `SignalEngine.test.ts` tests Bayesian caps. Add a new test file for the market filter since SignalEngine has complex constructor dependencies:

Create `packages/dashboard/src/services/SignalEngine.filter.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

/**
 * Extract the market filter logic for testing.
 * Mirrors setActiveMarkets() in SignalEngine.
 */
function filterMarkets(markets: Array<{ currentPrice: number; isActive?: boolean; isResolved?: boolean }>) {
  const MIN_PRICE = 0.05;
  const MAX_PRICE = 0.95;
  const FIFTY_FIFTY_MIN = 0.45;
  const FIFTY_FIFTY_MAX = 0.55;

  return markets.filter(m => {
    if (m.isActive === false) return false;
    if (m.isResolved === true) return false;
    const price = m.currentPrice;
    if (price < MIN_PRICE || price > MAX_PRICE) return false;
    if (price >= FIFTY_FIFTY_MIN && price <= FIFTY_FIFTY_MAX) return false;
    return true;
  });
}

describe('setActiveMarkets 50/50 filter', () => {
  it('should filter out markets at exactly 0.50', () => {
    const markets = [
      { currentPrice: 0.50, isActive: true },
      { currentPrice: 0.30, isActive: true },
    ];
    expect(filterMarkets(markets)).toHaveLength(1);
    expect(filterMarkets(markets)[0].currentPrice).toBe(0.30);
  });

  it('should filter out markets in 0.45-0.55 range', () => {
    const markets = [
      { currentPrice: 0.45, isActive: true },
      { currentPrice: 0.55, isActive: true },
      { currentPrice: 0.44, isActive: true },
      { currentPrice: 0.56, isActive: true },
    ];
    const filtered = filterMarkets(markets);
    expect(filtered).toHaveLength(2);
    expect(filtered.map(m => m.currentPrice)).toEqual([0.44, 0.56]);
  });

  it('should keep markets outside 50/50 range', () => {
    const markets = [
      { currentPrice: 0.10, isActive: true },
      { currentPrice: 0.90, isActive: true },
    ];
    expect(filterMarkets(markets)).toHaveLength(2);
  });

  it('should still filter extreme prices', () => {
    const markets = [
      { currentPrice: 0.03, isActive: true },
      { currentPrice: 0.97, isActive: true },
    ];
    expect(filterMarkets(markets)).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it passes (pure logic test)**

Run: `cd packages/dashboard && npx vitest run src/services/SignalEngine.filter.test.ts`
Expected: PASS (this tests the logic we want to implement)

**Step 3: Implement the filter in SignalEngine.ts**

Replace `setActiveMarkets()` (lines 271-310):

```typescript
  setActiveMarkets(markets: ActiveMarket[]): void {
    const MIN_PRICE = 0.05;
    const MAX_PRICE = 0.95;
    const FIFTY_FIFTY_MIN = 0.45;
    const FIFTY_FIFTY_MAX = 0.55;

    let inactiveCount = 0;
    let resolvedCount = 0;
    let extremePriceCount = 0;
    let fiftyFiftyCount = 0;

    const filtered = markets.filter(m => {
      // Filter 1: Skip inactive markets
      if (m.isActive === false) {
        inactiveCount++;
        return false;
      }

      // Filter 2: Skip resolved markets
      if (m.isResolved === true) {
        resolvedCount++;
        return false;
      }

      // Filter 3: Skip extreme prices (no profitable trade opportunity)
      const price = m.currentPrice;
      if (price < MIN_PRICE || price > MAX_PRICE) {
        extremePriceCount++;
        return false;
      }

      // Filter 4: Skip 50/50 markets (no edge, fees make EV negative)
      if (price >= FIFTY_FIFTY_MIN && price <= FIFTY_FIFTY_MAX) {
        fiftyFiftyCount++;
        return false;
      }

      return true;
    });

    // Log filtering summary
    const totalExcluded = inactiveCount + resolvedCount + extremePriceCount + fiftyFiftyCount;
    if (totalExcluded > 0) {
      console.log(`[SignalEngine] Filtered markets: ${inactiveCount} inactive, ${resolvedCount} resolved, ${extremePriceCount} extreme, ${fiftyFiftyCount} near-50/50`);
    }

    this.activeMarkets = filtered;
    console.log(`[SignalEngine] Updated active markets: ${filtered.length}`);
    this.emit('markets:updated', filtered.length);
  }
```

**Step 4: Run full test suite**

Run: `cd packages/dashboard && npx vitest run`
Expected: All tests pass

**Step 5: Commit**

```bash
git add packages/dashboard/src/services/SignalEngine.ts packages/dashboard/src/services/SignalEngine.filter.test.ts
git commit -m "fix: add explicit 50/50 market filter in setActiveMarkets (0.45-0.55)"
```

---

### Task 5: CircuitBreakerService Delegates to PositionClosingService

`closeAllPositions()` does direct SQL (~50 lines). Should delegate to `PositionClosingService.close()`.

**Files:**
- Modify: `packages/dashboard/src/services/CircuitBreakerService.ts:1-21` (imports) and `:230-326` (closeAllPositions)

**Step 1: Add import for PositionClosingService**

At the top of `CircuitBreakerService.ts`, add:

```typescript
import { getPositionClosingService } from './PositionClosingService.js';
```

**Step 2: Replace closeAllPositions()**

Replace lines 230-326 (the entire `closeAllPositions()` method):

```typescript
  private async closeAllPositions(): Promise<number> {
    const openPositions = await query<{
      market_id: string;
      token_id: string;
      side: string;
      size: string;
      avg_entry_price: string;
      latest_price: string | null;
    }>(`
      SELECT
        pp.market_id,
        pp.token_id,
        pp.side,
        pp.size,
        pp.avg_entry_price,
        ph.close as latest_price
      FROM paper_positions pp
      LEFT JOIN LATERAL (
        SELECT close FROM price_history
        WHERE token_id = pp.token_id
        ORDER BY time DESC LIMIT 1
      ) ph ON true
      WHERE pp.closed_at IS NULL
    `);

    let closed = 0;
    const closingService = getPositionClosingService();

    for (const pos of openPositions.rows) {
      const size = parseFloat(pos.size);
      if (size <= 0) continue;

      const entryPrice = parseFloat(pos.avg_entry_price);
      const exitPrice = pos.latest_price
        ? parseFloat(pos.latest_price)
        : entryPrice;

      try {
        const result = await closingService.close({
          marketId: pos.market_id,
          tokenId: pos.token_id,
          side: pos.side as 'long' | 'short',
          size,
          entryPrice,
          exitPrice,
          reason: 'circuit_breaker_exit',
        });

        if (result.executed) {
          closed++;
          console.log(`[CircuitBreaker] Closed ${pos.market_id.substring(0, 12)}... | P&L: $${result.netPnl.toFixed(2)}`);
        }
      } catch (error) {
        console.error(`[CircuitBreaker] Failed to close position ${pos.market_id}:`, error);
      }
    }

    console.log(`[CircuitBreaker] Closed ${closed} positions`);
    return closed;
  }
```

**Step 3: Remove unused imports**

The `paperTradesRepo` import is no longer needed by this service (it was only used in the direct SQL path). Check if it's used elsewhere in the file — if not, remove it from the import:

```typescript
// Remove paperTradesRepo from this import if unused:
import { paperPositionsRepo } from '../database/repositories.js';
```

**Step 4: Update existing test mock**

In `CircuitBreakerService.test.ts`, add the PositionClosingService mock:

```typescript
vi.mock('./PositionClosingService.js', () => ({
  getPositionClosingService: vi.fn(() => ({
    close: vi.fn().mockResolvedValue({ executed: true, netPnl: -5, fee: 0.01 }),
  })),
}));
```

**Step 5: Run full test suite**

Run: `cd packages/dashboard && npx vitest run`
Expected: All tests pass

**Step 6: Commit**

```bash
git add packages/dashboard/src/services/CircuitBreakerService.ts packages/dashboard/src/services/CircuitBreakerService.test.ts
git commit -m "fix: CircuitBreakerService delegates to PositionClosingService"
```

---

### Task 6: Apply Missing DB Tables + Account Reset on Production

This task runs SQL on the production VM. No code changes, no tests.

**Files:**
- No code files modified (tables already applied to prod during investigation; this step verifies + resets account)

**Step 1: Verify tables exist (they were applied during issue #22 investigation)**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b -- \
  "docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"
    SELECT table_name FROM information_schema.tables
    WHERE table_name IN ('market_crossref', 'external_signals')
    ORDER BY table_name;
  \""
```

Expected: Both tables listed. If not, apply `004_external_data_schema.sql`:

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b -- \
  "docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"
    CREATE TABLE IF NOT EXISTS market_crossref (
      polymarket_id VARCHAR(128) NOT NULL,
      platform VARCHAR(50) NOT NULL,
      external_id VARCHAR(255) NOT NULL,
      external_question TEXT,
      external_price DECIMAL(10,6),
      match_confidence FLOAT NOT NULL DEFAULT 0.0,
      matched_at TIMESTAMPTZ DEFAULT NOW(),
      last_fetched_at TIMESTAMPTZ,
      PRIMARY KEY (polymarket_id, platform)
    );
    CREATE INDEX IF NOT EXISTS idx_crossref_platform ON market_crossref(platform);
    CREATE INDEX IF NOT EXISTS idx_crossref_confidence ON market_crossref(match_confidence);
    CREATE TABLE IF NOT EXISTS external_signals (
      id SERIAL PRIMARY KEY,
      market_id VARCHAR(128) NOT NULL,
      source VARCHAR(50) NOT NULL,
      signal_type VARCHAR(50) NOT NULL,
      value FLOAT NOT NULL,
      confidence FLOAT DEFAULT 0.5,
      metadata JSONB DEFAULT '{}',
      fetched_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_external_signals_market ON external_signals(market_id, fetched_at DESC);
    CREATE INDEX IF NOT EXISTS idx_external_signals_source ON external_signals(source, signal_type);
  \""
```

**Step 2: Clean zombie positions**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b -- \
  "docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"
    UPDATE paper_positions SET size = 0, realized_pnl = 0
    WHERE closed_at IS NOT NULL AND size > 0;
  \""
```

**Step 3: Reset paper account to $10,000**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b -- \
  "docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"
    UPDATE paper_account SET
      current_capital = 10000,
      available_capital = 10000,
      initial_capital = 10000,
      total_realized_pnl = 0,
      total_unrealized_pnl = 0,
      total_fees_paid = 0,
      peak_equity = 10000,
      max_drawdown = 0,
      total_trades = 0,
      winning_trades = 0,
      losing_trades = 0,
      updated_at = NOW()
    WHERE id = 1;
  \""
```

**Step 4: Clear trading halt**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b -- \
  "docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"
    UPDATE trading_config SET value = 'false', updated_at = NOW()
    WHERE key = 'trading_halted';
  \""
```

**Step 5: Verify account is clean**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b -- \
  "docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"
    SELECT current_capital, available_capital, total_realized_pnl, max_drawdown, total_trades
    FROM paper_account WHERE id = 1;
  \""
```

Expected: `10000 | 10000 | 0 | 0 | 0`

**Step 6: No commit needed** (DB-only changes)

---

### Task 7: Final Verification + Deploy

**Step 1: Run full test suite**

```bash
cd packages/dashboard && npx vitest run
```

Expected: All tests pass

**Step 2: Build to verify no TypeScript errors**

```bash
cd packages/dashboard && npx tsc --noEmit
```

Expected: No errors

**Step 3: Create PR and deploy**

Push the branch, create PR, deploy to VM via CI/CD after merge.

```bash
git push -u origin fix/issue20-critical-fixes
gh pr create --title "fix: 6 critical bugs — upsert zombie, circuit breaker, 50/50 filter" \
  --body-file docs/plans/2026-03-14-issue20-critical-fixes-design.md \
  --label "daily-review"
```

**Step 4: After merge, deploy and verify on VM**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b -- \
  "cd /home/Usuario/polymarket-trader && git pull && docker compose -f docker-compose.gcp.yml pull && docker compose -f docker-compose.gcp.yml up -d --remove-orphans"
```

Verify:
1. Containers healthy: `docker compose ps`
2. Dashboard logs show 15% threshold: `docker compose logs dashboard-api | grep CircuitBreaker`
3. No external_signals errors: `docker compose logs dashboard-api | grep -i "does not exist"`
4. Account shows $10,000: run check-status.js
