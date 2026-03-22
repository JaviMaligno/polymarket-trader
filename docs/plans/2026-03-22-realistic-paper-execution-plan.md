# Realistic Paper Trading Execution — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make paper trading simulate realistic execution using real order book data, so PnL reflects what real trading would produce.

**Architecture:** New `OrderBookExecutionSimulator` service queries `orderbook_snapshots` for real market depth, walks the book to compute fill price/size, falls back to calibrated proportional model when no fresh snapshot exists. Wired into `AutoSignalExecutor` at both open and close paths.

**Tech Stack:** TypeScript, PostgreSQL (TimescaleDB), existing `orderbook_snapshots` table, Vitest for tests.

---

### Task 1: DB Migration — Add columns to paper_trades

**Files:**
- Create: `packages/data-collector/src/database/init/010_realistic_execution_columns.sql`

**Step 1: Write the migration**

```sql
-- Migration 010: Add realistic execution tracking columns
-- Supports OrderBookExecutionSimulator: tracks whether execution used
-- real order book data or estimated model, snapshot freshness, and liquidity.

ALTER TABLE paper_trades
  ADD COLUMN IF NOT EXISTS fill_source VARCHAR(20) DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS snapshot_age_ms INTEGER,
  ADD COLUMN IF NOT EXISTS available_depth DECIMAL(20,6);

ALTER TABLE paper_positions
  ADD COLUMN IF NOT EXISTS fill_source VARCHAR(20) DEFAULT 'legacy';
```

**Step 2: Commit**

```bash
git add packages/data-collector/src/database/init/010_realistic_execution_columns.sql
git commit -m "feat: add fill_source, snapshot_age_ms, available_depth columns for realistic execution"
```

---

### Task 2: OrderBookExecutionSimulator — Walk-the-book (test first)

**Files:**
- Create: `packages/dashboard/src/services/OrderBookExecutionSimulator.ts`
- Create: `packages/dashboard/src/services/OrderBookExecutionSimulator.test.ts`

**Step 1: Write the failing tests for walk-the-book**

```typescript
// OrderBookExecutionSimulator.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrderBookExecutionSimulator } from './OrderBookExecutionSimulator';

// Mock the database query
vi.mock('../database/repositories', () => ({
  query: vi.fn(),
}));

import { query } from '../database/repositories';
const mockQuery = vi.mocked(query);

describe('OrderBookExecutionSimulator', () => {
  let simulator: OrderBookExecutionSimulator;

  beforeEach(() => {
    vi.clearAllMocks();
    simulator = new OrderBookExecutionSimulator();
  });

  describe('walkTheBook', () => {
    it('computes correct avg price walking multiple ask levels', async () => {
      // Snapshot: asks at [0.87/50, 0.88/100, 0.89/200]
      mockQuery.mockResolvedValueOnce({
        rows: [{
          best_bid: '0.86', best_ask: '0.87', spread: '0.01',
          asks: JSON.stringify([
            { price: '0.87', size: '50' },
            { price: '0.88', size: '100' },
            { price: '0.89', size: '200' },
          ]),
          bids: JSON.stringify([
            { price: '0.86', size: '80' },
            { price: '0.85', size: '150' },
          ]),
          ask_depth_10pct: '350',
          bid_depth_10pct: '230',
          snapshot_age_ms: '5000',
        }],
        rowCount: 1,
      } as any);

      const result = await simulator.simulateBuy('m1', 't1', 219, 0.87);

      expect(result.executed).toBe(true);
      expect(result.fillSource).toBe('orderbook');
      expect(result.executedSize).toBe(219);
      // 50*0.87 + 100*0.88 + 69*0.89 = 43.5 + 88 + 61.41 = 192.91
      // avg = 192.91 / 219 = 0.8808...
      expect(result.executedPrice).toBeCloseTo(0.881, 2);
      expect(result.slippagePct).toBeGreaterThan(0);
      expect(result.bestAsk).toBe(0.87);
      expect(result.availableDepth).toBe(350);
    });

    it('returns partial fill when book depth insufficient', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          best_bid: '0.86', best_ask: '0.87', spread: '0.01',
          asks: JSON.stringify([
            { price: '0.87', size: '30' },
            { price: '0.88', size: '20' },
          ]),
          bids: JSON.stringify([]),
          ask_depth_10pct: '50',
          bid_depth_10pct: '0',
          snapshot_age_ms: '2000',
        }],
        rowCount: 1,
      } as any);

      const result = await simulator.simulateBuy('m1', 't1', 200, 0.87);

      expect(result.executed).toBe(true);
      expect(result.executedSize).toBe(50); // only 50 available
      expect(result.fillSource).toBe('orderbook');
    });

    it('rejects when partial fill < 50% of requested', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          best_bid: '0.86', best_ask: '0.87', spread: '0.01',
          asks: JSON.stringify([
            { price: '0.87', size: '10' },
          ]),
          bids: JSON.stringify([]),
          ask_depth_10pct: '10',
          bid_depth_10pct: '0',
          snapshot_age_ms: '3000',
        }],
        rowCount: 1,
      } as any);

      const result = await simulator.simulateBuy('m1', 't1', 200, 0.87);

      expect(result.executed).toBe(false);
      expect(result.rejectReason).toContain('insufficient');
    });

    it('rejects when slippage exceeds 5%', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          best_bid: '0.50', best_ask: '0.51', spread: '0.01',
          asks: JSON.stringify([
            { price: '0.51', size: '5' },
            { price: '0.60', size: '5' },
            { price: '0.70', size: '500' },
          ]),
          bids: JSON.stringify([]),
          ask_depth_10pct: '510',
          bid_depth_10pct: '0',
          snapshot_age_ms: '1000',
        }],
        rowCount: 1,
      } as any);

      const result = await simulator.simulateBuy('m1', 't1', 100, 0.51);

      expect(result.executed).toBe(false);
      expect(result.rejectReason).toContain('slippage');
    });

    it('simulateSell walks bids (descending price)', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          best_bid: '0.86', best_ask: '0.87', spread: '0.01',
          asks: JSON.stringify([]),
          bids: JSON.stringify([
            { price: '0.86', size: '100' },
            { price: '0.85', size: '100' },
          ]),
          ask_depth_10pct: '0',
          bid_depth_10pct: '200',
          snapshot_age_ms: '4000',
        }],
        rowCount: 1,
      } as any);

      const result = await simulator.simulateSell('m1', 't1', 150, 0.86);

      expect(result.executed).toBe(true);
      expect(result.fillSource).toBe('orderbook');
      // 100*0.86 + 50*0.85 = 86 + 42.5 = 128.5 / 150 = 0.8567
      expect(result.executedPrice).toBeCloseTo(0.857, 2);
    });
  });

  describe('estimated mode (no fresh snapshot)', () => {
    it('uses proportional model when no snapshot exists', async () => {
      // No snapshot found
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      // volume_24h query
      mockQuery.mockResolvedValueOnce({
        rows: [{ volume_24h: '50000' }],
        rowCount: 1,
      } as any);

      const result = await simulator.simulateBuy('m1', 't1', 219, 0.50);

      expect(result.executed).toBe(true);
      expect(result.fillSource).toBe('estimated');
      expect(result.executedPrice).toBeGreaterThan(0.50); // slippage applied
      expect(result.slippagePct).toBeGreaterThanOrEqual(1.0); // 1% floor
      expect(result.snapshotAgeMs).toBeNull();
    });

    it('uses proportional model when snapshot too old', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          best_bid: '0.86', best_ask: '0.87', spread: '0.01',
          asks: JSON.stringify([{ price: '0.87', size: '100' }]),
          bids: JSON.stringify([]),
          ask_depth_10pct: '100',
          bid_depth_10pct: '0',
          snapshot_age_ms: '120000', // 120s > 60s threshold
        }],
        rowCount: 1,
      } as any);
      // volume_24h query
      mockQuery.mockResolvedValueOnce({
        rows: [{ volume_24h: '50000' }],
        rowCount: 1,
      } as any);

      const result = await simulator.simulateBuy('m1', 't1', 100, 0.87);

      expect(result.fillSource).toBe('estimated');
    });

    it('rejects when no snapshot AND no volume data', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await simulator.simulateBuy('m1', 't1', 100, 0.50);

      expect(result.executed).toBe(false);
      expect(result.rejectReason).toContain('no market data');
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/dashboard/src/services/OrderBookExecutionSimulator.test.ts`
Expected: FAIL (module not found)

**Step 3: Implement OrderBookExecutionSimulator**

```typescript
// OrderBookExecutionSimulator.ts
import { query } from '../database/repositories';

export interface SimulationConfig {
  maxSnapshotAgeMs: number;
  estimatedSlippageFloor: number;
  estimatedBaseRate: number;
  estimatedVolumeFactor: number;
  feeRate: number;
  maxSlippagePct: number;
  minFillRatio: number;
}

export interface SimulationResult {
  executed: boolean;
  executedPrice: number;
  executedSize: number;
  slippagePct: number;
  fee: number;
  fillSource: 'orderbook' | 'estimated';
  snapshotAgeMs: number | null;
  availableDepth: number;
  bestBid: number | null;
  bestAsk: number | null;
  rejectReason?: string;
}

const DEFAULT_CONFIG: SimulationConfig = {
  maxSnapshotAgeMs: 60_000,
  estimatedSlippageFloor: 0.01,
  estimatedBaseRate: 0.002,
  estimatedVolumeFactor: 0.10,
  feeRate: 0.001,
  maxSlippagePct: 0.05,
  minFillRatio: 0.50,
};

export class OrderBookExecutionSimulator {
  private config: SimulationConfig;

  constructor(config?: Partial<SimulationConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async simulateBuy(
    marketId: string, tokenId: string, size: number, signalPrice: number
  ): Promise<SimulationResult> {
    return this.simulate(marketId, tokenId, size, signalPrice, 'buy');
  }

  async simulateSell(
    marketId: string, tokenId: string, size: number, signalPrice: number
  ): Promise<SimulationResult> {
    return this.simulate(marketId, tokenId, size, signalPrice, 'sell');
  }

  private async simulate(
    marketId: string, tokenId: string, size: number, signalPrice: number, side: 'buy' | 'sell'
  ): Promise<SimulationResult> {
    const snapshot = await this.getLatestSnapshot(marketId, tokenId);

    if (snapshot && snapshot.snapshotAgeMs <= this.config.maxSnapshotAgeMs) {
      return this.executeWithOrderBook(snapshot, size, signalPrice, side);
    }

    return this.executeWithEstimate(marketId, size, signalPrice, side);
  }

  private async getLatestSnapshot(marketId: string, tokenId: string) {
    const result = await query<{
      best_bid: string; best_ask: string; spread: string;
      asks: string; bids: string;
      ask_depth_10pct: string; bid_depth_10pct: string;
      snapshot_age_ms: string;
    }>(
      `SELECT best_bid, best_ask, spread,
              asks::text, bids::text,
              ask_depth_10pct, bid_depth_10pct,
              EXTRACT(EPOCH FROM (NOW() - time)) * 1000 AS snapshot_age_ms
       FROM orderbook_snapshots
       WHERE market_id = $1 AND token_id = $2
       ORDER BY time DESC LIMIT 1`,
      [marketId, tokenId]
    );

    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      bestBid: parseFloat(row.best_bid) || null,
      bestAsk: parseFloat(row.best_ask) || null,
      asks: JSON.parse(row.asks || '[]') as { price: string; size: string }[],
      bids: JSON.parse(row.bids || '[]') as { price: string; size: string }[],
      askDepth: parseFloat(row.ask_depth_10pct) || 0,
      bidDepth: parseFloat(row.bid_depth_10pct) || 0,
      snapshotAgeMs: Math.round(parseFloat(row.snapshot_age_ms)),
    };
  }

  private executeWithOrderBook(
    snapshot: NonNullable<Awaited<ReturnType<typeof this.getLatestSnapshot>>>,
    size: number, signalPrice: number, side: 'buy' | 'sell'
  ): SimulationResult {
    const levels = side === 'buy' ? snapshot.asks : snapshot.bids;
    const bestPrice = side === 'buy' ? snapshot.bestAsk : snapshot.bestBid;
    const availableDepth = side === 'buy' ? snapshot.askDepth : snapshot.bidDepth;

    if (!bestPrice || levels.length === 0) {
      return this.rejectResult(snapshot, 'no orderbook levels available');
    }

    // Walk the book
    let filled = 0;
    let totalCost = 0;
    for (const level of levels) {
      const levelPrice = parseFloat(level.price);
      const levelSize = parseFloat(level.size);
      const remaining = size - filled;

      if (remaining <= 0) break;

      const fillAtLevel = Math.min(remaining, levelSize);
      totalCost += fillAtLevel * levelPrice;
      filled += fillAtLevel;
    }

    // Check minimum fill ratio
    if (filled < size * this.config.minFillRatio) {
      return {
        executed: false,
        executedPrice: 0,
        executedSize: filled,
        slippagePct: 0,
        fee: 0,
        fillSource: 'orderbook',
        snapshotAgeMs: snapshot.snapshotAgeMs,
        availableDepth,
        bestBid: snapshot.bestBid,
        bestAsk: snapshot.bestAsk,
        rejectReason: `insufficient liquidity: ${filled}/${size} shares (${Math.round(filled/size*100)}%)`,
      };
    }

    const avgPrice = totalCost / filled;
    const slippagePct = Math.abs(avgPrice - bestPrice) / bestPrice * 100;

    // Check max slippage
    if (slippagePct / 100 > this.config.maxSlippagePct) {
      return {
        executed: false,
        executedPrice: avgPrice,
        executedSize: filled,
        slippagePct,
        fee: 0,
        fillSource: 'orderbook',
        snapshotAgeMs: snapshot.snapshotAgeMs,
        availableDepth,
        bestBid: snapshot.bestBid,
        bestAsk: snapshot.bestAsk,
        rejectReason: `slippage ${slippagePct.toFixed(2)}% exceeds max ${this.config.maxSlippagePct * 100}%`,
      };
    }

    const fee = filled * avgPrice * this.config.feeRate;

    return {
      executed: true,
      executedPrice: avgPrice,
      executedSize: filled,
      slippagePct,
      fee,
      fillSource: 'orderbook',
      snapshotAgeMs: snapshot.snapshotAgeMs,
      availableDepth,
      bestBid: snapshot.bestBid,
      bestAsk: snapshot.bestAsk,
    };
  }

  private async executeWithEstimate(
    marketId: string, size: number, signalPrice: number, side: 'buy' | 'sell'
  ): Promise<SimulationResult> {
    // Get volume for proportional model
    const volResult = await query<{ volume_24h: string }>(
      `SELECT volume_24h FROM markets WHERE id = $1`,
      [marketId]
    );

    if (volResult.rows.length === 0 || !volResult.rows[0].volume_24h) {
      return {
        executed: false, executedPrice: 0, executedSize: 0,
        slippagePct: 0, fee: 0, fillSource: 'estimated',
        snapshotAgeMs: null, availableDepth: 0,
        bestBid: null, bestAsk: null,
        rejectReason: 'no market data available (no snapshot, no volume)',
      };
    }

    const volume24h = parseFloat(volResult.rows[0].volume_24h);
    const orderValue = size * signalPrice;
    const volumeRatio = volume24h > 0 ? orderValue / volume24h : 1;

    const slippage = Math.max(
      this.config.estimatedSlippageFloor,
      this.config.estimatedBaseRate + volumeRatio * this.config.estimatedVolumeFactor
    );

    // Check max slippage
    if (slippage > this.config.maxSlippagePct) {
      return {
        executed: false, executedPrice: 0, executedSize: 0,
        slippagePct: slippage * 100, fee: 0, fillSource: 'estimated',
        snapshotAgeMs: null, availableDepth: 0,
        bestBid: null, bestAsk: null,
        rejectReason: `estimated slippage ${(slippage * 100).toFixed(2)}% exceeds max ${this.config.maxSlippagePct * 100}%`,
      };
    }

    const executedPrice = side === 'buy'
      ? signalPrice * (1 + slippage)
      : signalPrice * (1 - slippage);

    const fee = size * executedPrice * this.config.feeRate;

    return {
      executed: true,
      executedPrice,
      executedSize: size,
      slippagePct: slippage * 100,
      fee,
      fillSource: 'estimated',
      snapshotAgeMs: null,
      availableDepth: 0,
      bestBid: null,
      bestAsk: null,
    };
  }

  private rejectResult(
    snapshot: NonNullable<Awaited<ReturnType<typeof this.getLatestSnapshot>>>,
    reason: string
  ): SimulationResult {
    return {
      executed: false, executedPrice: 0, executedSize: 0,
      slippagePct: 0, fee: 0, fillSource: 'orderbook',
      snapshotAgeMs: snapshot.snapshotAgeMs,
      availableDepth: 0,
      bestBid: snapshot.bestBid, bestAsk: snapshot.bestAsk,
      rejectReason: reason,
    };
  }

  /** Update config (e.g., from calibration results in DB) */
  updateConfig(partial: Partial<SimulationConfig>): void {
    this.config = { ...this.config, ...partial };
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/dashboard/src/services/OrderBookExecutionSimulator.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add packages/dashboard/src/services/OrderBookExecutionSimulator.ts \
       packages/dashboard/src/services/OrderBookExecutionSimulator.test.ts
git commit -m "feat: add OrderBookExecutionSimulator with walk-the-book and estimated mode"
```

---

### Task 3: Wire into AutoSignalExecutor — openPosition

**Files:**
- Modify: `packages/dashboard/src/services/AutoSignalExecutor.ts:143-148` (constructor), `581-597` (trade creation)

**Step 1: Write failing test for simulated execution on open**

Add to existing `AutoSignalExecutor.test.ts` (or create a new test file if it doesn't exist):

```typescript
// In AutoSignalExecutor test file
it('uses OrderBookExecutionSimulator for paper trade execution price', async () => {
  // This test verifies that openPosition passes through the simulator
  // and uses the simulated price instead of signal.price
  // Test structure depends on existing test patterns — adapt as needed
});
```

> Note: The executor has complex dependencies (DB, services, etc.). The primary verification will be via integration testing after deployment. For this step, focus on the code change and run the full test suite to ensure no regressions.

**Step 2: Modify AutoSignalExecutor constructor to accept simulator**

At line 131-148, add the simulator as an optional dependency:

```typescript
// Add import at top of file
import { OrderBookExecutionSimulator, SimulationResult } from './OrderBookExecutionSimulator';

// Modify constructor (line 143-148):
constructor(config?: Partial<ExecutorConfig>, simulator?: OrderBookExecutionSimulator) {
  super();
  this.config = { ...DEFAULT_CONFIG, ...config };
  this.simulator = simulator || new OrderBookExecutionSimulator();
  this.lastDayReset = new Date();
  this.lastDayReset.setHours(0, 0, 0, 0);
}
```

Add field declaration near other private fields:
```typescript
private simulator: OrderBookExecutionSimulator;
```

**Step 3: Replace direct trade creation in openPosition**

Replace lines 581-597 (the `paperTradesRepo.create()` call) with:

```typescript
    // Simulate realistic execution
    const sim = await this.simulator.simulateBuy(
      signal.marketId, signal.tokenId, shares, signal.price
    );

    if (!sim.executed) {
      console.log(`[AutoExecutor] Trade rejected by simulator: ${sim.rejectReason}`);
      return { executed: false, reason: `Simulator rejected: ${sim.rejectReason}` };
    }

    // Use simulated values instead of signal.price
    const actualShares = sim.executedSize;
    const actualPrice = sim.executedPrice;
    const actualFee = sim.fee;
    const actualValue = actualShares * actualPrice;

    const trade = await paperTradesRepo.create({
      time: new Date(),
      market_id: signal.marketId,
      token_id: signal.tokenId,
      side: 'buy',
      requested_size: shares,
      executed_size: actualShares,
      requested_price: signal.price,
      executed_price: actualPrice,
      slippage_pct: sim.slippagePct,
      fee: actualFee,
      value_usd: actualValue,
      signal_id: prediction?.id,
      signal_type: signal.signalId,
      order_type: 'market',
      fill_type: actualShares < shares ? 'partial' : 'full',
      best_bid: sim.bestBid,
      best_ask: sim.bestAsk,
      fill_source: sim.fillSource,
      snapshot_age_ms: sim.snapshotAgeMs,
      available_depth: sim.availableDepth,
      execution_mode: executionMode,
    });
```

Also update the capital deduction and position creation that follows (use `actualShares`, `actualPrice`, `actualFee` instead of `shares`, `signal.price`, `fee`).

**Step 4: Update paperTradesRepo.create() to accept new fields**

In `repositories.ts`, find the `paperTradesRepo.create()` method and add the 3 new columns to its INSERT statement. The type interface `PaperTrade` also needs the new fields.

**Step 5: Run full test suite**

Run: `pnpm test`
Expected: ALL PASS (497+ tests)

**Step 6: Commit**

```bash
git add packages/dashboard/src/services/AutoSignalExecutor.ts \
       packages/dashboard/src/database/repositories.ts
git commit -m "feat: wire OrderBookExecutionSimulator into openPosition"
```

---

### Task 4: Wire into AutoSignalExecutor — closePosition

**Files:**
- Modify: `packages/dashboard/src/services/AutoSignalExecutor.ts:691-772`

**Step 1: Add sell simulation before PositionClosingService call**

After the exit price is determined (line ~714), add simulation:

```typescript
    // Simulate realistic sell execution
    const sim = await this.simulator.simulateSell(
      signal.marketId, position.token_id, shares, exitPrice
    );

    if (!sim.executed) {
      console.log(`[AutoExecutor] Close rejected by simulator: ${sim.rejectReason}`);
      return { executed: false, reason: `Simulator rejected close: ${sim.rejectReason}` };
    }

    // Use simulated exit price
    exitPrice = sim.executedPrice;
```

Then at the sell trade recording (after PositionClosingService.close()), populate the new fields:

```typescript
    // Record sell trade with simulation data
    await paperTradesRepo.create({
      // ... existing fields ...
      slippage_pct: sim.slippagePct,
      best_bid: sim.bestBid,
      best_ask: sim.bestAsk,
      fill_source: sim.fillSource,
      snapshot_age_ms: sim.snapshotAgeMs,
      available_depth: sim.availableDepth,
    });
```

**Step 2: Run full test suite**

Run: `pnpm test`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add packages/dashboard/src/services/AutoSignalExecutor.ts
git commit -m "feat: wire OrderBookExecutionSimulator into closePosition"
```

---

### Task 5: Verify order book data quality

**Files:**
- No code changes — investigation task

**Step 1: Check if CLOB API returns valid books for tradeable markets**

SSH into VM and manually call the CLOB API for a known active market:

```bash
# Get an active market's token ID
docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -t -c \
  "SELECT id, clob_token_id_yes, current_price_yes FROM markets WHERE tracking_status = 'active' AND current_price_yes > 0.10 AND current_price_yes < 0.90 LIMIT 3;"

# Call the CLOB API directly
curl -s "https://clob.polymarket.com/book?token_id=<TOKEN_ID>" | python3 -m json.tool | head -30
```

**Step 2: Compare API response with stored snapshot**

If the API returns reasonable bid/ask (spread < 0.20) but our DB shows spread=0.98, there's a parsing bug. If the API also returns spread=0.98, these markets genuinely have thin CLOBs.

**Step 3: Document findings**

If thin CLOBs are normal:
- Most trades will use `estimated` mode — this is OK
- The `orderbook` mode will activate for high-liquidity markets (crypto, popular events)
- No code change needed

If parsing bug found:
- Fix in ClobCollector
- Commit the fix

**Step 4: Commit findings (if code change needed)**

```bash
git add packages/data-collector/src/collectors/ClobCollector.ts
git commit -m "fix: correct order book parsing in ClobCollector"
```

---

### Task 6: Update TradingAutomation to pass simulator

**Files:**
- Modify: `packages/dashboard/src/server.ts:274-278` (or wherever AutoSignalExecutor is created)
- Check: `packages/dashboard/src/services/TradingAutomation.ts`

**Step 1: Find where AutoSignalExecutor is instantiated in TradingAutomation**

The executor is created inside TradingAutomation. Modify it to create and inject the simulator:

```typescript
import { OrderBookExecutionSimulator } from './OrderBookExecutionSimulator';

// In TradingAutomation constructor or init:
const simulator = new OrderBookExecutionSimulator();
this.executor = new AutoSignalExecutor(executorConfig, simulator);
```

**Step 2: Run tests**

Run: `pnpm test`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add packages/dashboard/src/services/TradingAutomation.ts
git commit -m "feat: inject OrderBookExecutionSimulator into TradingAutomation"
```

---

### Task 7: Build, verify, and deploy

**Step 1: Run full test suite**

```bash
pnpm test
```

Expected: ALL PASS (497+ tests)

**Step 2: Build Docker images**

```bash
pnpm build
```

Expected: No TypeScript errors

**Step 3: Push and let CI/CD deploy**

```bash
git push origin main
```

**Step 4: Verify on VM after CI/CD completes**

```bash
# Wait for deployment (~3-5 min)
# Check containers healthy
gcloud compute ssh polymarket-vm --zone=us-east1-b --command='docker ps --format "{{.Names}}: {{.Status}}"'

# Check migration ran (new columns exist)
gcloud compute ssh polymarket-vm --zone=us-east1-b --command='docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c "\d paper_trades" | grep -E "(fill_source|snapshot_age|available_depth)"'

# Wait for a trade cycle (~60s) and check logs
gcloud compute ssh polymarket-vm --zone=us-east1-b --command='docker compose -f /home/Usuario/polymarket-trader/docker-compose.gcp.yml logs --tail=30 dashboard-api | grep -i "simulator\|simulated\|slippage\|rejected"'

# Check if trades are recording new fields
gcloud compute ssh polymarket-vm --zone=us-east1-b --command='docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -t -c "SELECT fill_source, slippage_pct, snapshot_age_ms, best_bid, best_ask FROM paper_trades ORDER BY time DESC LIMIT 5;"'
```

**Step 5: Commit any hotfixes if needed**

---

### Task 8: Monitoring query for post-deploy evaluation

**Files:**
- Create: `scripts/check-execution-quality.js`

**Step 1: Write the monitoring script**

```javascript
// scripts/check-execution-quality.js
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  // Fill source distribution
  const sources = await pool.query(`
    SELECT fill_source, COUNT(*) as trades,
           ROUND(AVG(slippage_pct)::numeric, 4) as avg_slippage_pct,
           ROUND(AVG(snapshot_age_ms)::numeric, 0) as avg_snapshot_age_ms,
           COUNT(CASE WHEN executed_size < requested_size THEN 1 END) as partial_fills
    FROM paper_trades
    WHERE fill_source IS NOT NULL AND fill_source != 'legacy'
    GROUP BY fill_source;
  `);
  console.log('\n=== Fill Source Distribution ===');
  console.table(sources.rows);

  // Rejection rate (trades that were attempted but rejected)
  // This would need a separate log or counter — for now check logs

  // Slippage histogram
  const slippage = await pool.query(`
    SELECT
      CASE
        WHEN slippage_pct < 0.5 THEN '<0.5%'
        WHEN slippage_pct < 1.0 THEN '0.5-1%'
        WHEN slippage_pct < 2.0 THEN '1-2%'
        WHEN slippage_pct < 5.0 THEN '2-5%'
        ELSE '>5%'
      END as bucket,
      COUNT(*) as count
    FROM paper_trades
    WHERE slippage_pct IS NOT NULL AND fill_source != 'legacy'
    GROUP BY 1 ORDER BY MIN(slippage_pct);
  `);
  console.log('\n=== Slippage Distribution ===');
  console.table(slippage.rows);

  await pool.end();
}
main().catch(console.error);
```

**Step 2: Commit**

```bash
git add scripts/check-execution-quality.js
git commit -m "feat: add execution quality monitoring script"
```
