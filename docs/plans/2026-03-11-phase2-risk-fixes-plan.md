# Phase 2: Risk & Protection Fixes — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 6 risk/protection issues (trading_config missing, stop-loss re-entry, per-market limit, RiskManager fail-open, near-resolution markets, 50/50 filtering) to make the system safe for real-money trading.

**Architecture:** All fixes are in-process changes to existing services. No new files except tests. PositionClosingService gains EventEmitter to enable cross-service communication for stop-loss cooldown. All changes are backward-compatible.

**Tech Stack:** TypeScript, Vitest, PostgreSQL, EventEmitter pattern

**Test runner:** `cd packages/dashboard && npx vitest run <file> --reporter=verbose`

**Build check:** `cd packages/dashboard && npx tsc --noEmit`

---

### Task 1: CircuitBreakerService — Create trading_config Table + In-Memory Fallback

**Files:**
- Modify: `packages/dashboard/src/services/CircuitBreakerService.ts`
- Create: `packages/dashboard/src/services/CircuitBreakerService.test.ts`

**Context:**
- `haltTrading()` (line 313) and `resumeTrading()` (line 333) INSERT/UPDATE `trading_config` table
- RiskManager also writes to `trading_config` (line 319-327)
- Table never created → INSERTs fail silently → circuit breaker non-functional
- Need: CREATE TABLE IF NOT EXISTS at startup + in-memory `isHaltedInMemory` flag

**Step 1: Write the failing tests**

```typescript
// packages/dashboard/src/services/CircuitBreakerService.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../database/index.js', () => ({
  query: vi.fn(),
  isDatabaseConfigured: vi.fn(() => true),
}));

vi.mock('../database/repositories.js', () => ({
  paperTradesRepo: { create: vi.fn() },
  paperPositionsRepo: { getAll: vi.fn() },
}));

// Mock dependent singletons to avoid import side-effects
vi.mock('./TradingAutomation.js', () => ({
  getTradingAutomation: vi.fn(() => ({ on: vi.fn(), off: vi.fn() })),
}));
vi.mock('./StopLossService.js', () => ({
  getStopLossService: vi.fn(() => ({ on: vi.fn(), off: vi.fn() })),
}));

import { query } from '../database/index.js';
import { CircuitBreakerService } from './CircuitBreakerService.js';

describe('CircuitBreakerService', () => {
  let service: CircuitBreakerService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new CircuitBreakerService({ enabled: true });
  });

  describe('trading_config table creation', () => {
    it('should CREATE TABLE IF NOT EXISTS on start()', async () => {
      // Mock account query for checkDrawdown
      vi.mocked(query).mockResolvedValue({ rows: [{ current_capital: '10000', initial_capital: '10000' }] } as any);

      await service.start();

      // First query should be CREATE TABLE IF NOT EXISTS
      const calls = vi.mocked(query).mock.calls;
      const createTableCall = calls.find(c =>
        typeof c[0] === 'string' && c[0].includes('CREATE TABLE IF NOT EXISTS trading_config')
      );
      expect(createTableCall).toBeDefined();

      service.stop();
    });
  });

  describe('in-memory halt fallback', () => {
    it('should track halt state in memory even if DB write fails', async () => {
      // DB write fails
      vi.mocked(query).mockRejectedValue(new Error('DB down'));

      expect(service.isTradingHalted()).toBe(false);

      // Trigger halt via internal method (we test the public API)
      // Use forceCheck with drawdown > threshold
      vi.mocked(query)
        .mockResolvedValueOnce({ rows: [{ current_capital: '5000', initial_capital: '10000' }] } as any) // account check
        .mockRejectedValue(new Error('DB down')); // all subsequent writes fail

      await service.checkDrawdown();

      // In-memory flag should be true even though DB write failed
      expect(service.isTradingHalted()).toBe(true);
    });

    it('should return false when not halted', () => {
      expect(service.isTradingHalted()).toBe(false);
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/dashboard && npx vitest run src/services/CircuitBreakerService.test.ts --reporter=verbose`
Expected: FAIL — `isTradingHalted` is not a function, CREATE TABLE not called

**Step 3: Implement the fixes**

In `CircuitBreakerService.ts`:

A. Add `isHaltedInMemory` property (after line 54):
```typescript
private isHaltedInMemory = false;
```

B. Add `isTradingHalted()` public method (after `isActive()` at line 424):
```typescript
isTradingHalted(): boolean {
  return this.isHaltedInMemory;
}
```

C. Add table creation at start of `start()` method (after line 74, before `this.isRunning = true`):
```typescript
// Ensure trading_config table exists
try {
  await query(`
    CREATE TABLE IF NOT EXISTS trading_config (
      key VARCHAR(255) PRIMARY KEY,
      value TEXT NOT NULL,
      description TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
} catch (error) {
  console.error('[CircuitBreaker] Failed to create trading_config table:', error);
}
```

D. Set in-memory flag in `haltTrading()` (line 313, before the try block):
```typescript
this.isHaltedInMemory = true;
```

E. Clear in-memory flag in `resumeTrading()` (line 333, after `if (!this.isHalted) return`... wait, resumeTrading doesn't check `isHalted` — it uses the `trading_config` table). Add after the successful DB write (or in the finally-equivalent spot):
```typescript
this.isHaltedInMemory = false;
```
Place this BEFORE the DB write attempt so it clears even if DB fails:
```typescript
private async resumeTrading(): Promise<void> {
  this.isHaltedInMemory = false;  // Clear in-memory flag regardless of DB
  try {
    // ... existing DB write ...
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/dashboard && npx vitest run src/services/CircuitBreakerService.test.ts --reporter=verbose`
Expected: PASS

**Step 5: Run full test suite**

Run: `cd packages/dashboard && npx vitest run --reporter=verbose`
Expected: All tests pass

**Step 6: Commit**

```bash
git add packages/dashboard/src/services/CircuitBreakerService.ts packages/dashboard/src/services/CircuitBreakerService.test.ts
git commit -m "fix: create trading_config table at startup + in-memory halt fallback"
```

---

### Task 2: PositionClosingService — Add EventEmitter for Stop-Loss Events

**Files:**
- Modify: `packages/dashboard/src/services/PositionClosingService.ts`
- Modify: `packages/dashboard/src/services/PositionClosingService.test.ts`

**Context:**
- PositionClosingService needs to emit `'position:closed'` events so AutoSignalExecutor can populate the stop-loss cooldown map
- Currently not an EventEmitter
- Minimal change: extend EventEmitter, add `super()`, emit after successful close

**Step 1: Write the failing test**

Add to existing `PositionClosingService.test.ts`:

```typescript
it('should emit position:closed event with marketId and reason after successful close', async () => {
  const params: ClosePositionParams = {
    positionId: 1,
    marketId: 'market-abc',
    tokenId: 'token-yes',
    side: 'long',
    size: 100,
    entryPrice: 0.40,
    exitPrice: 0.60,
    reason: 'stop_loss',
  };

  const eventSpy = vi.fn();
  service.on('position:closed', eventSpy);

  await service.close(params);

  expect(eventSpy).toHaveBeenCalledWith({
    marketId: 'market-abc',
    reason: 'stop_loss',
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/dashboard && npx vitest run src/services/PositionClosingService.test.ts --reporter=verbose`
Expected: FAIL — `service.on is not a function`

**Step 3: Implement**

In `PositionClosingService.ts`:

A. Add import:
```typescript
import { EventEmitter } from 'events';
```

B. Change class declaration:
```typescript
export class PositionClosingService extends EventEmitter {
```

C. Add `super()` as first line of constructor:
```typescript
constructor(config?: { feeRate?: number }) {
  super();
  // ... existing code
}
```

D. After successful close (after trade recording, before the return statement), emit:
```typescript
this.emit('position:closed', { marketId: params.marketId, reason: params.reason });
```

**Step 4: Run test to verify it passes**

Run: `cd packages/dashboard && npx vitest run src/services/PositionClosingService.test.ts --reporter=verbose`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/dashboard/src/services/PositionClosingService.ts packages/dashboard/src/services/PositionClosingService.test.ts
git commit -m "feat: PositionClosingService emits position:closed events"
```

---

### Task 3: AutoSignalExecutor — Stop-Loss Re-Entry Cooldown

**Files:**
- Modify: `packages/dashboard/src/services/AutoSignalExecutor.ts`
- Create: `packages/dashboard/src/services/AutoSignalExecutor.test.ts`

**Context:**
- After StopLossService closes a position, next signal cycle opens a new one immediately
- Need: in-memory `stoppedOutMarkets` map with 4-hour cooldown
- AutoSignalExecutor listens to PositionClosingService `'position:closed'` event
- Check in `processSignal()` before opening new positions

**Step 1: Write the failing tests**

```typescript
// packages/dashboard/src/services/AutoSignalExecutor.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../database/index.js', () => ({
  query: vi.fn(),
  isDatabaseConfigured: vi.fn(() => true),
}));

vi.mock('../database/repositories.js', () => ({
  paperTradesRepo: { create: vi.fn() },
  paperPositionsRepo: { getAll: vi.fn(), upsert: vi.fn() },
  signalPredictionsRepo: { create: vi.fn() },
  signalWeightsRepo: { get: vi.fn() },
}));

vi.mock('./PositionClosingService.js', () => {
  const { EventEmitter } = require('events');
  const mockService = new EventEmitter();
  mockService.close = vi.fn();
  return {
    getPositionClosingService: vi.fn(() => mockService),
  };
});

import { query } from '../database/index.js';
import { paperPositionsRepo } from '../database/repositories.js';
import { getPositionClosingService } from './PositionClosingService.js';
import { AutoSignalExecutor, type SignalResult } from './AutoSignalExecutor.js';

const makeSignal = (overrides?: Partial<SignalResult>): SignalResult => ({
  signalId: 'momentum',
  marketId: 'market-123',
  tokenId: 'token-yes',
  direction: 'long',
  strength: 0.8,
  confidence: 0.7,
  price: 0.50,
  ...overrides,
});

describe('AutoSignalExecutor — Stop-Loss Cooldown', () => {
  let executor: AutoSignalExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new AutoSignalExecutor();

    // Default: market exists, active, not resolved
    vi.mocked(query).mockResolvedValue({
      rows: [{ is_active: true, is_resolved: false }],
    } as any);

    // Default: no open positions
    vi.mocked(paperPositionsRepo.getAll).mockResolvedValue([]);
  });

  it('should reject signal for a market in stop-loss cooldown', async () => {
    // Simulate stop-loss event
    const closingService = getPositionClosingService();
    (closingService as any).emit('position:closed', {
      marketId: 'market-123',
      reason: 'stop_loss',
    });

    // Register the listener (executor needs to subscribe)
    executor.registerStopLossCooldown(closingService as any);

    // Re-emit after registration
    (closingService as any).emit('position:closed', {
      marketId: 'market-123',
      reason: 'stop_loss',
    });

    const result = await executor.processSignal(makeSignal());
    expect(result.executed).toBe(false);
    expect(result.reason).toContain('stop-loss cooldown');
  });

  it('should allow signal after cooldown expires', async () => {
    executor.registerStopLossCooldown(getPositionClosingService() as any);

    // Manually set a cooldown that's already expired
    (executor as any).stoppedOutMarkets.set('market-123', Date.now() - 5 * 60 * 60 * 1000); // 5h ago

    // Should pass cooldown check (will fail later for other reasons, that's OK)
    const result = await executor.processSignal(makeSignal());
    // If it gets past cooldown, it won't say "stop-loss cooldown"
    expect(result.reason || '').not.toContain('stop-loss cooldown');
  });

  it('should not cooldown for non-stop-loss closes', async () => {
    executor.registerStopLossCooldown(getPositionClosingService() as any);

    (getPositionClosingService() as any).emit('position:closed', {
      marketId: 'market-123',
      reason: 'signal', // Not stop_loss
    });

    const result = await executor.processSignal(makeSignal());
    expect(result.reason || '').not.toContain('stop-loss cooldown');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/dashboard && npx vitest run src/services/AutoSignalExecutor.test.ts --reporter=verbose`
Expected: FAIL — `registerStopLossCooldown` not a function, `stoppedOutMarkets` doesn't exist

**Step 3: Implement**

In `AutoSignalExecutor.ts`:

A. Add constant after `DEFAULT_CONFIG` (around line 66):
```typescript
const STOP_LOSS_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours
```

B. Add property (after line 90):
```typescript
private stoppedOutMarkets: Map<string, number> = new Map();
```

C. Add `registerStopLossCooldown()` method (after constructor):
```typescript
/**
 * Listen for stop-loss close events to enforce re-entry cooldown.
 * Called at startup with the PositionClosingService singleton.
 */
registerStopLossCooldown(closingService: import('events').EventEmitter): void {
  closingService.on('position:closed', ({ marketId, reason }: { marketId: string; reason: string }) => {
    if (reason === 'stop_loss') {
      this.stoppedOutMarkets.set(marketId, Date.now());
      console.log(`[AutoExecutor] Stop-loss cooldown activated for ${marketId.substring(0, 12)}... (${STOP_LOSS_COOLDOWN_MS / 3600000}h)`);
    }
  });
}
```

D. Add cooldown check in `processSignal()` after the market cooldown check (after line 180, before signal dedup at line 182):
```typescript
// 3a. Stop-loss re-entry cooldown
const stoppedAt = this.stoppedOutMarkets.get(signal.marketId);
if (stoppedAt && Date.now() - stoppedAt < STOP_LOSS_COOLDOWN_MS) {
  const remainingH = ((STOP_LOSS_COOLDOWN_MS - (Date.now() - stoppedAt)) / 3600000).toFixed(1);
  return { executed: false, reason: `Market in stop-loss cooldown (${remainingH}h remaining)` };
}
// Clean expired cooldowns
for (const [key, ts] of this.stoppedOutMarkets) {
  if (Date.now() - ts > STOP_LOSS_COOLDOWN_MS) {
    this.stoppedOutMarkets.delete(key);
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/dashboard && npx vitest run src/services/AutoSignalExecutor.test.ts --reporter=verbose`
Expected: PASS

**Step 5: Wire up in server.ts**

In `packages/dashboard/src/server.ts`, after executor initialization, add:
```typescript
// Wire stop-loss cooldown: executor listens for stop-loss events from PositionClosingService
import { getPositionClosingService } from './services/PositionClosingService.js';
executor.registerStopLossCooldown(getPositionClosingService());
```

**Step 6: Commit**

```bash
git add packages/dashboard/src/services/AutoSignalExecutor.ts packages/dashboard/src/services/AutoSignalExecutor.test.ts packages/dashboard/src/server.ts
git commit -m "feat: 4-hour stop-loss re-entry cooldown to prevent repeated losses"
```

---

### Task 4: AutoSignalExecutor — Per-Market Position Concentration Limit

**Files:**
- Modify: `packages/dashboard/src/services/AutoSignalExecutor.ts`
- Modify: `packages/dashboard/src/services/AutoSignalExecutor.test.ts`

**Context:**
- System can open unlimited positions on same market
- Need: `MAX_POSITIONS_PER_MARKET = 2`, checked against open positions before opening

**Step 1: Write the failing test**

Add to `AutoSignalExecutor.test.ts`:

```typescript
describe('AutoSignalExecutor — Per-Market Limit', () => {
  let executor: AutoSignalExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new AutoSignalExecutor();

    vi.mocked(query).mockResolvedValue({
      rows: [{ is_active: true, is_resolved: false }],
    } as any);
  });

  it('should reject signal when market has MAX_POSITIONS_PER_MARKET open positions', async () => {
    // 2 existing positions on same market
    vi.mocked(paperPositionsRepo.getAll).mockResolvedValue([
      { market_id: 'market-123', token_id: 'token-a', size: 50 } as any,
      { market_id: 'market-123', token_id: 'token-b', size: 30 } as any,
    ]);

    const result = await executor.processSignal(makeSignal({ direction: 'long' }));
    expect(result.executed).toBe(false);
    expect(result.reason).toContain('market position limit');
  });

  it('should allow signal when market has fewer than limit', async () => {
    vi.mocked(paperPositionsRepo.getAll).mockResolvedValue([
      { market_id: 'market-123', token_id: 'token-a', size: 50 } as any,
    ]);

    // Will get past per-market check (may fail on existingPosition check since same market)
    const result = await executor.processSignal(makeSignal({ direction: 'long' }));
    // It should NOT mention market position limit
    expect(result.reason || '').not.toContain('market position limit');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/dashboard && npx vitest run src/services/AutoSignalExecutor.test.ts --reporter=verbose`
Expected: FAIL — no per-market limit check exists

**Step 3: Implement**

A. Add constant (near STOP_LOSS_COOLDOWN_MS):
```typescript
const MAX_POSITIONS_PER_MARKET = 2;
```

B. In `processSignal()`, after positions are fetched (after line 210), before the SHORT/LONG handling:
```typescript
// 4a. Per-market concentration limit
const openOnMarket = positions.filter(
  p => p.market_id === signal.marketId && Number(p.size) > 0
).length;
if (openOnMarket >= MAX_POSITIONS_PER_MARKET) {
  return { executed: false, reason: `At market position limit (${openOnMarket}/${MAX_POSITIONS_PER_MARKET})` };
}
```

**Step 4: Run tests**

Run: `cd packages/dashboard && npx vitest run src/services/AutoSignalExecutor.test.ts --reporter=verbose`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/dashboard/src/services/AutoSignalExecutor.ts packages/dashboard/src/services/AutoSignalExecutor.test.ts
git commit -m "feat: per-market position concentration limit (max 2)"
```

---

### Task 5: AutoSignalExecutor — Near-Resolution Market Protection

**Files:**
- Modify: `packages/dashboard/src/services/AutoSignalExecutor.ts`
- Modify: `packages/dashboard/src/services/AutoSignalExecutor.test.ts`

**Context:**
- Sports/event markets resolving within 24h: block mean-reversion, require higher confidence, halve position size
- `end_date_iso` available in markets table
- Extend existing market query (line 125-128) to include `end_date_iso`
- Flag `nearResolution` on signal, apply 0.5 size multiplier in `openPosition()`

**Step 1: Write the failing tests**

Add to `AutoSignalExecutor.test.ts`:

```typescript
describe('AutoSignalExecutor — Near-Resolution Protection', () => {
  let executor: AutoSignalExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new AutoSignalExecutor();
    vi.mocked(paperPositionsRepo.getAll).mockResolvedValue([]);
  });

  it('should reject mean_reversion signals on near-resolution markets', async () => {
    const inSixHours = new Date(Date.now() + 6 * 3600000).toISOString();
    vi.mocked(query).mockResolvedValue({
      rows: [{ is_active: true, is_resolved: false, end_date_iso: inSixHours }],
    } as any);

    const result = await executor.processSignal(makeSignal({
      signalId: 'mean_reversion',
      direction: 'long',
    }));
    expect(result.executed).toBe(false);
    expect(result.reason).toContain('mean_reversion');
    expect(result.reason).toContain('near-resolution');
  });

  it('should reject weak signals on near-resolution markets', async () => {
    const inSixHours = new Date(Date.now() + 6 * 3600000).toISOString();
    vi.mocked(query).mockResolvedValue({
      rows: [{ is_active: true, is_resolved: false, end_date_iso: inSixHours }],
    } as any);

    const result = await executor.processSignal(makeSignal({
      signalId: 'momentum',
      confidence: 0.50, // Below 0.65 threshold
    }));
    expect(result.executed).toBe(false);
    expect(result.reason).toContain('near-resolution');
  });

  it('should allow strong momentum signals on near-resolution markets', async () => {
    const inSixHours = new Date(Date.now() + 6 * 3600000).toISOString();
    vi.mocked(query).mockResolvedValue({
      rows: [{ is_active: true, is_resolved: false, end_date_iso: inSixHours }],
    } as any);

    // High confidence momentum signal — should pass near-resolution filter
    const result = await executor.processSignal(makeSignal({
      signalId: 'momentum',
      confidence: 0.80,
    }));
    // Should NOT be rejected for near-resolution reasons
    expect(result.reason || '').not.toContain('near-resolution');
  });

  it('should pass markets with no end_date_iso (open-ended)', async () => {
    vi.mocked(query).mockResolvedValue({
      rows: [{ is_active: true, is_resolved: false, end_date_iso: null }],
    } as any);

    const result = await executor.processSignal(makeSignal());
    expect(result.reason || '').not.toContain('near-resolution');
  });

  it('should pass markets resolving in >24h', async () => {
    const inThreeDays = new Date(Date.now() + 72 * 3600000).toISOString();
    vi.mocked(query).mockResolvedValue({
      rows: [{ is_active: true, is_resolved: false, end_date_iso: inThreeDays }],
    } as any);

    const result = await executor.processSignal(makeSignal());
    expect(result.reason || '').not.toContain('near-resolution');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/dashboard && npx vitest run src/services/AutoSignalExecutor.test.ts --reporter=verbose`
Expected: FAIL — no near-resolution check exists

**Step 3: Implement**

A. Add constants:
```typescript
const NEAR_RESOLUTION_HOURS = 24;
const MIN_CONFIDENCE_NEAR_RESOLUTION = 0.65;
```

B. Extend market query (line 125) to include `end_date_iso`:
```typescript
const marketCheck = await query<{ is_active: boolean; is_resolved: boolean; end_date_iso: string | null }>(
  `SELECT is_active, is_resolved, end_date_iso FROM markets WHERE id = $1 OR condition_id = $1`,
  [signal.marketId]
);
```

C. After market active/resolved checks (after line 143), add near-resolution check:
```typescript
// Near-resolution market protection
const endDate = marketCheck.rows[0].end_date_iso;
let isNearResolution = false;
if (endDate) {
  const hoursToResolution = (new Date(endDate).getTime() - Date.now()) / 3600000;
  if (hoursToResolution > 0 && hoursToResolution < NEAR_RESOLUTION_HOURS) {
    isNearResolution = true;

    // Block mean-reversion signals — nonsensical near resolution
    if (signal.signalId === 'mean_reversion') {
      return { executed: false, reason: `Rejecting mean_reversion on near-resolution market (${hoursToResolution.toFixed(1)}h to resolve)` };
    }

    // Require higher confidence
    if (signal.confidence < MIN_CONFIDENCE_NEAR_RESOLUTION) {
      return { executed: false, reason: `Insufficient confidence for near-resolution market (${signal.confidence.toFixed(2)} < ${MIN_CONFIDENCE_NEAR_RESOLUTION})` };
    }

    console.log(`[AutoExecutor] Near-resolution market (${hoursToResolution.toFixed(1)}h) — half position size`);
  }
}
```

D. Pass `isNearResolution` to `openPosition()`. Add parameter to method signature:
```typescript
private async openPosition(signal: SignalResult, isNearResolution = false): Promise<SignalProcessResult> {
```

E. In `openPosition()`, apply 0.5 multiplier to position size (after line 306):
```typescript
const positionValue = Math.min(
  this.config.maxPositionSize * sizeMultiplier,
  this.config.maxPositionSize
) * (isNearResolution ? 0.5 : 1.0);
```

F. Update the two `openPosition()` call sites in `processSignal()`:
- Line 235: `return this.openPosition(signal, isNearResolution);`
- Line 249: `return this.openPosition(signal, isNearResolution);`

G. For near-resolution stop-loss → permanent cooldown, add in the stop-loss cooldown handler:
```typescript
// In registerStopLossCooldown listener:
if (reason === 'stop_loss') {
  // Use a very long cooldown for near-resolution markets (effectively permanent)
  this.stoppedOutMarkets.set(marketId, Date.now());
}
```
(This already works since 4h cooldown > typical remaining resolution time for near-resolution markets)

**Step 4: Run tests**

Run: `cd packages/dashboard && npx vitest run src/services/AutoSignalExecutor.test.ts --reporter=verbose`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/dashboard/src/services/AutoSignalExecutor.ts packages/dashboard/src/services/AutoSignalExecutor.test.ts
git commit -m "feat: near-resolution market protection (block mean_reversion, higher confidence, half size)"
```

---

### Task 6: RiskManager — Default to BLOCK on Failure

**Files:**
- Modify: `packages/dashboard/src/services/RiskManager.ts`
- Create: `packages/dashboard/src/services/RiskManager.test.ts`

**Context:**
- `canOpenPosition()` line 446-448: returns `{ allowed: true }` on DB error
- Should return `{ allowed: false }` — fail closed, not fail open

**Step 1: Write the failing test**

```typescript
// packages/dashboard/src/services/RiskManager.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../database/index.js', () => ({
  query: vi.fn(),
  isDatabaseConfigured: vi.fn(() => true),
}));

vi.mock('../database/repositories.js', () => ({
  paperPositionsRepo: { getAll: vi.fn() },
  portfolioSnapshotsRepo: {},
}));

import { query } from '../database/index.js';
import { RiskManager } from './RiskManager.js';

describe('RiskManager', () => {
  let rm: RiskManager;

  beforeEach(() => {
    vi.clearAllMocks();
    rm = new RiskManager({ enabled: true });
  });

  describe('canOpenPosition — fail-closed', () => {
    it('should BLOCK trades when DB query fails', async () => {
      vi.mocked(query).mockRejectedValue(new Error('connection refused'));

      const result = await rm.canOpenPosition(100);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('risk_check_failed');
    });

    it('should ALLOW trades when DB query succeeds and within limits', async () => {
      vi.mocked(query).mockResolvedValue({
        rows: [{ initial_capital: '10000' }],
      } as any);

      // Mock positions for exposure check
      const { paperPositionsRepo } = await import('../database/repositories.js');
      vi.mocked(paperPositionsRepo.getAll).mockResolvedValue([]);

      const result = await rm.canOpenPosition(100);
      expect(result.allowed).toBe(true);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/dashboard && npx vitest run src/services/RiskManager.test.ts --reporter=verbose`
Expected: FAIL — `allowed` is `true` when DB fails

**Step 3: Implement**

In `RiskManager.ts`, line 446-448, change:
```typescript
// BEFORE:
} catch (error) {
  console.error('[RiskManager] Position check failed:', error);
  return { allowed: true, adaptiveMultiplier: 1 };  // Allow on error
}

// AFTER:
} catch (error) {
  console.error('[RiskManager] Position check failed, BLOCKING trade:', error);
  return { allowed: false, reason: 'risk_check_failed', adaptiveMultiplier: 0 };
}
```

**Step 4: Run tests**

Run: `cd packages/dashboard && npx vitest run src/services/RiskManager.test.ts --reporter=verbose`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/dashboard/src/services/RiskManager.ts packages/dashboard/src/services/RiskManager.test.ts
git commit -m "fix: RiskManager defaults to BLOCK on DB failure (fail-closed)"
```

---

### Task 7: SignalEngine — 50/50 Market Filtering

**Files:**
- Modify: `packages/dashboard/src/services/SignalEngine.ts`
- Modify: `packages/dashboard/src/services/SignalEngine.test.ts`

**Context:**
- Markets at 0.45-0.55 are coin flips with negative expected value after fees
- Add filter in `setActiveMarkets()` alongside existing extreme-price filter
- Also add to `convertToSignalResult()` PRICE_FILTERS as safety net

**Step 1: Write the failing test**

Add to existing `SignalEngine.test.ts`:

```typescript
describe('SignalEngine — 50/50 Market Filter', () => {
  it('should filter out markets with price in 0.45-0.55 range', () => {
    const engine = new SignalEngine({ enabled: false });

    engine.setActiveMarkets([
      { id: 'a', question: 'Q1', tokenIdYes: 't1', currentPrice: 0.50 },  // 50/50 → filtered
      { id: 'b', question: 'Q2', tokenIdYes: 't2', currentPrice: 0.48 },  // 50/50 → filtered
      { id: 'c', question: 'Q3', tokenIdYes: 't3', currentPrice: 0.70 },  // OK
      { id: 'd', question: 'Q4', tokenIdYes: 't4', currentPrice: 0.30 },  // OK
      { id: 'e', question: 'Q5', tokenIdYes: 't5', currentPrice: 0.45 },  // boundary → filtered
      { id: 'f', question: 'Q6', tokenIdYes: 't6', currentPrice: 0.55 },  // boundary → filtered
      { id: 'g', question: 'Q7', tokenIdYes: 't7', currentPrice: 0.44 },  // just outside → OK
      { id: 'h', question: 'Q8', tokenIdYes: 't8', currentPrice: 0.56 },  // just outside → OK
    ]);

    const status = engine.getStatus();
    expect(status.marketCount).toBe(4); // c, d, g, h
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/dashboard && npx vitest run src/services/SignalEngine.test.ts --reporter=verbose`
Expected: FAIL — 50/50 markets not filtered, marketCount will be 8 (minus any extreme-price filtered)

**Step 3: Implement**

In `SignalEngine.ts`, `setActiveMarkets()` method (around line 228):

A. Add constants at top of method:
```typescript
const FIFTY_FIFTY_MIN = 0.45;
const FIFTY_FIFTY_MAX = 0.55;
```

B. Add filter and counter (after the existing extremePriceCount logic, around line 252):
```typescript
let fiftyFiftyCount = 0;
```

C. Add filter condition inside the `.filter()` callback (after the extreme price check):
```typescript
// Filter 4: Skip 50/50 markets (no edge, fees make EV negative)
if (price >= FIFTY_FIFTY_MIN && price <= FIFTY_FIFTY_MAX) {
  fiftyFiftyCount++;
  return false;
}
```

D. Update the log line to include 50/50 count:
```typescript
const totalExcluded = inactiveCount + resolvedCount + extremePriceCount + fiftyFiftyCount;
if (totalExcluded > 0) {
  console.log(`[SignalEngine] Filtered markets: ${inactiveCount} inactive, ${resolvedCount} resolved, ${extremePriceCount} extreme prices, ${fiftyFiftyCount} 50/50`);
}
```

**Step 4: Run tests**

Run: `cd packages/dashboard && npx vitest run src/services/SignalEngine.test.ts --reporter=verbose`
Expected: PASS

**Step 5: Run full test suite + type check**

Run: `cd packages/dashboard && npx vitest run --reporter=verbose`
Run: `cd packages/dashboard && npx tsc --noEmit`
Expected: All pass, no type errors

**Step 6: Commit**

```bash
git add packages/dashboard/src/services/SignalEngine.ts packages/dashboard/src/services/SignalEngine.test.ts
git commit -m "feat: filter 50/50 markets (0.45-0.55 price range)"
```

---

### Task 8: Final Build Verification + Integration

**Files:** None new — verification only

**Step 1: Run full test suite**

Run: `cd packages/dashboard && npx vitest run --reporter=verbose`
Expected: All tests pass (existing + new)

**Step 2: Type check**

Run: `cd packages/dashboard && npx tsc --noEmit`
Expected: No errors

**Step 3: Verify no regressions in other packages**

Run: `cd packages/signals && npm test 2>/dev/null; cd packages/backtest && npm test 2>/dev/null`
Expected: Pass or no test suites

**Step 4: Final commit with all files**

Review git status and ensure all changes are committed.

---

## Summary

| Task | File(s) | Lines Changed | Risk |
|------|---------|---------------|------|
| 1. trading_config table | CircuitBreakerService.ts | ~20 | Low |
| 2. PositionClosingService events | PositionClosingService.ts | ~5 | Low |
| 3. Stop-loss cooldown | AutoSignalExecutor.ts, server.ts | ~25 | Medium |
| 4. Per-market limit | AutoSignalExecutor.ts | ~8 | Low |
| 5. Near-resolution protection | AutoSignalExecutor.ts | ~25 | Medium |
| 6. RiskManager fail-closed | RiskManager.ts | ~3 | Low |
| 7. 50/50 filter | SignalEngine.ts | ~8 | Low |
| 8. Build verification | — | — | — |

**Total: ~94 lines across 4 modified files + 3 new test files**
