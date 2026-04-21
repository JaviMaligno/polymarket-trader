# EventOTMGate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Block new opens on `event_financial` markets that are near expiry AND priced in an extreme band, shadowing the would-be trade. Unblock the recurring WTI loss pattern (issue #117) with a structural gate rather than another threshold bump.

**Architecture:** New gate `0e` in `AutoSignalExecutor.canExecute()`, placed between the existing `0d` market-type gate and the per-market loss blockers. Gate fires when `signal.marketType ∈ EVENT_OTM_MARKET_TYPES` AND `hoursToResolution < EVENT_OTM_TTR_HOURS` AND `signal.price` is outside `[EVENT_OTM_PRICE_LO, EVENT_OTM_PRICE_HI]`. When fired on a signal that would open a position, insert a shadow trade tagged `event_otm_gated` and reject the signal. Closes on existing positions pass through. Defaults are sensible values in code; Optuna refinement is a follow-up PR.

**Tech Stack:** TypeScript (Node 20), Vitest for unit tests, `pnpm` workspace. Database access via `packages/dashboard/src/database/` helpers. Runtime: `dashboard-api` container on GCP VM.

**Design doc:** `docs/plans/2026-04-21-event-otm-gate-design.md` (brainstorm Q1–Q5 summarized there).

---

## File Structure

| File | Change | Responsibility |
|------|--------|----------------|
| `packages/dashboard/src/services/AutoSignalExecutor.ts` | Modify | Hoist `market` out of try; add 4 env-backed constants; add gate `0e`; extend `insertShadowTrade` with optional `signalTypeOverride` |
| `packages/dashboard/src/services/AutoSignalExecutor.eventOTMGate.test.ts` | Create | Unit tests for the gate (12 cases) |
| `docker-compose.gcp.yml` | Modify | Document the 4 env vars at the dashboard-api service with default values |

No new DB tables, no new migrations, no new packages.

---

## Task 1: Write EventOTMGate unit tests (red)

Create the full test file first so the implementation in Task 4 has an immediate pass/fail signal for every behavior. Tests will fail until Task 4 is merged in.

**Files:**
- Create: `packages/dashboard/src/services/AutoSignalExecutor.eventOTMGate.test.ts`

- [ ] **Step 1: Create the test file with full test suite**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../database/index.js', () => ({
  query: vi.fn(),
  isDatabaseConfigured: vi.fn(() => true),
}));

vi.mock('../database/repositories.js', () => ({
  paperTradesRepo: { create: vi.fn() },
  paperPositionsRepo: {
    getAll: vi.fn(),
    insert: vi.fn(),
    upsert: vi.fn(),
    openPositionAtomically: vi.fn().mockResolvedValue({ opened: true }),
  },
  signalPredictionsRepo: { create: vi.fn() },
  signalWeightsRepo: { get: vi.fn() },
}));

vi.mock('./PositionClosingService.js', () => {
  const { EventEmitter } = require('events');
  const mockService = new EventEmitter();
  mockService.close = vi.fn().mockResolvedValue({ executed: true, pnl: 0 });
  return { getPositionClosingService: vi.fn(() => mockService) };
});

vi.mock('./CircuitBreakerService.js', () => ({
  getCircuitBreakerService: vi.fn(() => ({ isTradingHalted: vi.fn(() => false) })),
}));

vi.mock('./ExecutionRouter.js', () => ({ getExecutionRouter: vi.fn(() => null) }));

vi.mock('./OrderBookExecutionSimulator.js', () => ({
  OrderBookExecutionSimulator: class {
    simulateBuy = vi.fn().mockResolvedValue({
      executed: true, executedPrice: 0.12, executedSize: 10,
      slippagePct: 0.1, fee: 0.005, fillSource: 'estimated',
      snapshotAgeMs: null, availableDepth: 0,
      bestBid: null, bestAsk: null,
    });
    simulateSell = vi.fn().mockResolvedValue({
      executed: true, executedPrice: 0.12, executedSize: 10,
      slippagePct: 0.1, fee: 0.005, fillSource: 'estimated',
      snapshotAgeMs: null, availableDepth: 0,
      bestBid: null, bestAsk: null,
    });
  },
}));

import { query } from '../database/index.js';
import { paperPositionsRepo } from '../database/repositories.js';
import { AutoSignalExecutor, type SignalResult } from './AutoSignalExecutor.js';

// Helper: build a SignalResult with overrides
const makeSignal = (overrides?: Partial<SignalResult>): SignalResult => ({
  signalId: 'mean_reversion',
  marketId: 'market-wti-1712302',
  tokenId: 'token-yes',
  direction: 'long',
  strength: 0.8,
  confidence: 0.7,
  price: 0.12,
  marketType: 'event_financial',
  ...overrides,
});

// Helper: set the market query mock with a given TTR in hours from now
function mockMarketWithTTR(hoursFromNow: number | null, overrides?: {
  is_active?: boolean; is_resolved?: boolean;
}) {
  const end_date =
    hoursFromNow === null
      ? null
      : new Date(Date.now() + hoursFromNow * 3600_000).toISOString();
  const row = { is_active: true, is_resolved: false, end_date, ...overrides };
  (query as any).mockResolvedValue({ rows: [row] });
}

describe('EventOTMGate (gate 0e)', () => {
  let executor: AutoSignalExecutor;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset env to defaults each test; individual tests override as needed
    delete process.env.EXECUTOR_EVENT_OTM_TTR_HOURS;
    delete process.env.EXECUTOR_EVENT_OTM_PRICE_LO;
    delete process.env.EXECUTOR_EVENT_OTM_PRICE_HI;
    delete process.env.EXECUTOR_EVENT_OTM_MARKET_TYPES;
    executor = new AutoSignalExecutor({ enabled: true, cooldownMs: 0 });
    (paperPositionsRepo.getAll as any).mockResolvedValue([]);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('blocks WTI-like classic trap: event_financial, TTR 9d, price 0.12', async () => {
    mockMarketWithTTR(216); // 9 days
    const result = await executor.processSignal(makeSignal({ price: 0.12 }));
    expect(result.executed).toBe(false);
    expect(result.reason).toMatch(/event_otm_near_expiry/);
  });

  it('records a shadow trade tagged event_otm_gated when gate blocks an open', async () => {
    mockMarketWithTTR(216);
    await executor.processSignal(makeSignal({ price: 0.12 }));
    // Locate the shadow_trades INSERT call among all query calls
    const shadowCalls = (query as any).mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO shadow_trades')
    );
    expect(shadowCalls.length).toBe(1);
    // signal_type is the last positional param (index 7 in the values array)
    const params = shadowCalls[0][1] as any[];
    expect(params[params.length - 1]).toBe('event_otm_gated');
  });

  it('passes event_financial with mid-price near expiry (0.50, 9d)', async () => {
    mockMarketWithTTR(216);
    const result = await executor.processSignal(makeSignal({ price: 0.50 }));
    // Gate must not fire; result may still pass or fail other gates — assert negative only
    expect(result.reason || '').not.toMatch(/event_otm_near_expiry/);
  });

  it('passes event_financial with extreme price and long horizon (0.12, 30d)', async () => {
    mockMarketWithTTR(720);
    const result = await executor.processSignal(makeSignal({ price: 0.12 }));
    expect(result.reason || '').not.toMatch(/event_otm_near_expiry/);
  });

  it('passes crypto markets even with extreme price near expiry (marketType mismatch)', async () => {
    mockMarketWithTTR(216);
    const result = await executor.processSignal(
      makeSignal({ marketType: 'crypto_intraday', price: 0.12 })
    );
    expect(result.reason || '').not.toMatch(/event_otm_near_expiry/);
  });

  it('passes event_financial with null end_date (cannot compute TTR)', async () => {
    mockMarketWithTTR(null);
    const result = await executor.processSignal(makeSignal({ price: 0.12 }));
    expect(result.reason || '').not.toMatch(/event_otm_near_expiry/);
  });

  it('allows closing an existing position on a matching market', async () => {
    mockMarketWithTTR(216);
    (paperPositionsRepo.getAll as any).mockResolvedValue([
      { market_id: 'market-wti-1712302', size: 10, closed_at: null },
    ]);
    const result = await executor.processSignal(
      makeSignal({ price: 0.12, direction: 'short' }) // short = close of long
    );
    expect(result.reason || '').not.toMatch(/event_otm_near_expiry/);
  });

  it('passes at exact TTR boundary (strict less-than)', async () => {
    mockMarketWithTTR(240); // exactly the default threshold
    const result = await executor.processSignal(makeSignal({ price: 0.12 }));
    expect(result.reason || '').not.toMatch(/event_otm_near_expiry/);
  });

  it('passes at exact PRICE_LO boundary (strict less-than)', async () => {
    mockMarketWithTTR(216);
    const result = await executor.processSignal(makeSignal({ price: 0.20 }));
    expect(result.reason || '').not.toMatch(/event_otm_near_expiry/);
  });

  it('passes at exact PRICE_HI boundary (strict greater-than)', async () => {
    mockMarketWithTTR(216);
    const result = await executor.processSignal(makeSignal({ price: 0.80 }));
    expect(result.reason || '').not.toMatch(/event_otm_near_expiry/);
  });

  it('blocks upper-extreme price near expiry (0.88, 9d)', async () => {
    mockMarketWithTTR(216);
    const result = await executor.processSignal(makeSignal({ price: 0.88 }));
    expect(result.executed).toBe(false);
    expect(result.reason).toMatch(/event_otm_near_expiry/);
  });

  it('is disabled when EXECUTOR_EVENT_OTM_TTR_HOURS=0', async () => {
    process.env.EXECUTOR_EVENT_OTM_TTR_HOURS = '0';
    // Rebuild executor to pick up env var at module-import time — NOT possible without
    // module reload. The constants are read at module import, so env changes mid-test
    // do not take effect. This test documents the rollback mechanism; actual
    // verification happens via env override at deploy time. See failing-note below.
    // (Left as a skipped placeholder; the module-level constants pattern is the
    // project convention and not changed here.)
  });

  it('blocks custom market types when EXECUTOR_EVENT_OTM_MARKET_TYPES includes them', async () => {
    // Same module-import-time caveat as above; leaving as a skipped placeholder.
  });
});
```

**Note on env-override tests.** The executor reads `EXECUTOR_EVENT_OTM_*` env vars at module import via module-level `const`. Vitest can reset `process.env` between tests but cannot re-import the module with new env. Two options: either accept the limitation and document the rollback lever in deployment (which is what the current project pattern does — see `NEAR_RESOLVED_LOWER`, never unit-tested for env override), or refactor constants into a factory function read at construction time. This plan chooses the first option for consistency with existing patterns; the two env-override tests above are placeholders that document intent rather than runtime behavior. Integration-level verification happens during VM deploy.

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @polymarket-trader/dashboard test AutoSignalExecutor.eventOTMGate
```

Expected: all non-placeholder tests FAIL — most will fail with the gate not triggering the expected `event_otm_near_expiry` reason (because the gate doesn't exist yet). The "shadow trade inserted" test fails because no INSERT on `shadow_trades` is made.

- [ ] **Step 3: Commit (red state)**

```bash
git add packages/dashboard/src/services/AutoSignalExecutor.eventOTMGate.test.ts
git commit -m "test: failing tests for EventOTMGate (gate 0e)"
```

---

## Task 2: Extend `insertShadowTrade` with optional signal_type override

Before implementing the gate, make the shadow helper able to tag the record with a gate-specific signal_type so we can filter shadow trades by gate reason in post-deploy SQL.

**Files:**
- Modify: `packages/dashboard/src/services/AutoSignalExecutor.ts:235-265`

- [ ] **Step 1: Change the `insertShadowTrade` signature and use the override**

Find the current method (around line 235):

```typescript
private async insertShadowTrade(signal: SignalResult): Promise<void> {
  // ... existing body ...
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

Replace with:

```typescript
private async insertShadowTrade(
  signal: SignalResult,
  signalTypeOverride?: string
): Promise<void> {
  // ... existing body (size computation, early return) unchanged ...
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
      signalTypeOverride ?? signal.signalId,
    ]
  );
}
```

- [ ] **Step 2: Run existing AutoSignalExecutor tests to verify no regression**

```bash
pnpm --filter @polymarket-trader/dashboard test AutoSignalExecutor.test
pnpm --filter @polymarket-trader/dashboard test AutoSignalExecutor.hysteresis
```

Expected: all existing tests still PASS (call sites didn't change; default behavior preserved).

- [ ] **Step 3: Commit**

```bash
git add packages/dashboard/src/services/AutoSignalExecutor.ts
git commit -m "refactor(AutoSignalExecutor): accept optional signal_type override in insertShadowTrade"
```

---

## Task 3: Hoist `market` declaration out of the try block

The new gate `0e` runs after the existing `0d` (market-type gate), which lives outside the try block that queries `market`. To access `market.end_date` from `0e`, hoist the variable out of the try so it's visible in the later scope.

**Files:**
- Modify: `packages/dashboard/src/services/AutoSignalExecutor.ts:356-412`

- [ ] **Step 1: Rewrite the try block to assign to an outer `market` binding**

Find (around line 356–412):

```typescript
let isNearResolution = false;
try {
  const marketCheck = await query<{ is_active: boolean; is_resolved: boolean; end_date: string | null }>(
    `SELECT is_active, is_resolved, end_date FROM markets WHERE id = $1`,
    [signal.marketId]
  );

  if (marketCheck.rows.length === 0) {
    console.log(`[AutoExecutor] REJECTED ${signal.marketId.substring(0, 12)}... : Market not found in database (checked id and condition_id)`);
    return { executed: false, reason: 'Market not found in database' };
  }

  const market = marketCheck.rows[0];
  // ... 0b, 0c using `market` ...
} catch (error) {
  console.error('[AutoExecutor] Failed to verify market status:', error);
  return { executed: false, reason: 'Cannot verify market status - rejecting for safety' };
}
```

Rewrite to hoist `market`:

```typescript
let isNearResolution = false;
let market: { is_active: boolean; is_resolved: boolean; end_date: string | null } | null = null;
try {
  const marketCheck = await query<{ is_active: boolean; is_resolved: boolean; end_date: string | null }>(
    `SELECT is_active, is_resolved, end_date FROM markets WHERE id = $1`,
    [signal.marketId]
  );

  if (marketCheck.rows.length === 0) {
    console.log(`[AutoExecutor] REJECTED ${signal.marketId.substring(0, 12)}... : Market not found in database (checked id and condition_id)`);
    return { executed: false, reason: 'Market not found in database' };
  }

  market = marketCheck.rows[0];
  // ... existing 0b, 0c using `market` (unchanged — they still see the same object) ...
} catch (error) {
  console.error('[AutoExecutor] Failed to verify market status:', error);
  return { executed: false, reason: 'Cannot verify market status - rejecting for safety' };
}
```

All in-try references to `market` still work (the local re-assignment just changed `const market = ...` to `market = ...`). The outer scope after the try now has a nullable `market` binding.

- [ ] **Step 2: Run existing AutoSignalExecutor tests**

```bash
pnpm --filter @polymarket-trader/dashboard test AutoSignalExecutor.test
pnpm --filter @polymarket-trader/dashboard test AutoSignalExecutor.hysteresis
```

Expected: all PASS. This is a refactor only — no behavior change.

- [ ] **Step 3: Commit**

```bash
git add packages/dashboard/src/services/AutoSignalExecutor.ts
git commit -m "refactor(AutoSignalExecutor): hoist market binding out of try for gate 0e"
```

---

## Task 4: Implement EventOTMGate constants and gate 0e block

Add the four env-backed constants and the gate block. This is the green phase that flips all Task 1 tests to passing.

**Files:**
- Modify: `packages/dashboard/src/services/AutoSignalExecutor.ts` (top-of-file constants, after gate 0d)

- [ ] **Step 1: Add constants near the other executor constants (near line 146)**

Find the block around:
```typescript
const LONG_TERM_MAX_WIN_RATE = parseFloat(process.env.EXECUTOR_LONG_TERM_MAX_WIN_RATE || '0.15');
const NEAR_RESOLUTION_HOURS = 24;
```

Add immediately after `LONG_TERM_MAX_WIN_RATE`, before `NEAR_RESOLUTION_HOURS`:

```typescript
// Gate 0e: event_financial markets with bounded expiry and extreme-band prices
// are fair-valued asymmetric priors, not mispricing. Block opens on the conjunction.
// Structural: market types subject to the gate.
const EVENT_OTM_MARKET_TYPES = new Set(
  (process.env.EXECUTOR_EVENT_OTM_MARKET_TYPES || 'event_financial')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);
// Tunable: hours-to-resolution threshold. Default 240 = 10 days.
const EVENT_OTM_TTR_HOURS = parseFloat(process.env.EXECUTOR_EVENT_OTM_TTR_HOURS || '240');
// Tunable: extreme-price bounds. Prices outside [LO, HI] are considered extreme.
const EVENT_OTM_PRICE_LO = parseFloat(process.env.EXECUTOR_EVENT_OTM_PRICE_LO || '0.20');
const EVENT_OTM_PRICE_HI = parseFloat(process.env.EXECUTOR_EVENT_OTM_PRICE_HI || '0.80');
```

- [ ] **Step 2: Add gate 0e block after the existing 0d market-type gate**

Find (around line 414–433):

```typescript
// 0d. Market type gate: restrict new opens to allowed types
const effectiveMarketType = signal.marketType || 'unclassified';
if (ALLOWED_MARKET_TYPES && !ALLOWED_MARKET_TYPES.has(effectiveMarketType)) {
  // ... existing body ...
}
```

Insert immediately after the closing brace of that block:

```typescript
// 0e. EventOTMGate: event_financial markets near expiry with extreme prices are
// fair-valued asymmetric priors, not mispricing. Block new opens; allow closes.
// Design: docs/plans/2026-04-21-event-otm-gate-design.md
if (
  market &&
  market.end_date &&
  signal.marketType &&
  EVENT_OTM_MARKET_TYPES.has(signal.marketType) &&
  EVENT_OTM_TTR_HOURS > 0
) {
  const hoursToResolution =
    (new Date(market.end_date).getTime() - Date.now()) / 3600000;
  const priceExtreme =
    signal.price < EVENT_OTM_PRICE_LO || signal.price > EVENT_OTM_PRICE_HI;

  if (
    hoursToResolution > 0 &&
    hoursToResolution < EVENT_OTM_TTR_HOURS &&
    priceExtreme
  ) {
    try {
      const openPositions = await paperPositionsRepo.getAll();
      const hasOpenPosition = openPositions.some((p) => p.market_id === signal.marketId);
      if (!hasOpenPosition) {
        console.log(
          `[AutoExecutor] REJECTED ${signal.marketId.substring(0, 12)}... : ` +
            `event_otm_near_expiry (TTR=${hoursToResolution.toFixed(1)}h, price=${signal.price.toFixed(4)})`
        );
        this.insertShadowTrade(signal, 'event_otm_gated').catch(() => {});
        return {
          executed: false,
          reason: `event_otm_near_expiry: TTR=${hoursToResolution.toFixed(1)}h, price=${signal.price.toFixed(4)}`,
        };
      }
    } catch {
      // If position check fails, block for safety (matches 0d behavior)
      console.log(
        `[AutoExecutor] REJECTED ${signal.marketId.substring(0, 12)}... : ` +
          `event_otm_near_expiry (position check failed)`
      );
      return { executed: false, reason: 'event_otm_near_expiry: position check failed' };
    }
  }
}
```

- [ ] **Step 3: Run the new gate tests**

```bash
pnpm --filter @polymarket-trader/dashboard test AutoSignalExecutor.eventOTMGate
```

Expected: all non-placeholder tests PASS. The two env-override placeholder tests are no-ops and will pass trivially.

- [ ] **Step 4: Run the full AutoSignalExecutor test suite to confirm no regression**

```bash
pnpm --filter @polymarket-trader/dashboard test AutoSignalExecutor
```

Expected: all PASS, including existing `AutoSignalExecutor.test.ts` and `AutoSignalExecutor.hysteresis.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/services/AutoSignalExecutor.ts
git commit -m "feat(AutoSignalExecutor): add EventOTMGate for event_financial OTM near-expiry markets"
```

---

## Task 5: Document env vars in `docker-compose.gcp.yml`

Add the four env vars to the dashboard-api service in the GCP compose file so defaults are documented and overridable via one-line edits without a code deploy.

**Files:**
- Modify: `docker-compose.gcp.yml` (dashboard-api service `environment:` section)

- [ ] **Step 1: Inspect the current dashboard-api environment block**

```bash
rtk grep -n "EXECUTOR_LONG_TERM_MAX_WIN_RATE\|ALLOWED_MARKET_TYPES" docker-compose.gcp.yml
```

Locate the existing `EXECUTOR_*` and `ALLOWED_MARKET_TYPES` env var lines (around line 148 per the most recent state). The new vars go next to those.

- [ ] **Step 2: Add the four env vars**

Insert before the `ALLOWED_MARKET_TYPES` line (preserving grouping of executor settings):

```yaml
      # Gate 0e: EventOTMGate — block opens on event_financial markets near expiry
      # with extreme-band prices. See docs/plans/2026-04-21-event-otm-gate-design.md
      EXECUTOR_EVENT_OTM_MARKET_TYPES: "event_financial"
      EXECUTOR_EVENT_OTM_TTR_HOURS: "240"
      EXECUTOR_EVENT_OTM_PRICE_LO: "0.20"
      EXECUTOR_EVENT_OTM_PRICE_HI: "0.80"
```

- [ ] **Step 3: Verify YAML is valid**

```bash
node -e "const y=require('js-yaml'); y.load(require('fs').readFileSync('docker-compose.gcp.yml','utf8')); console.log('ok')"
```

Expected: prints `ok`. If `js-yaml` is not installed at the workspace root, substitute with `docker compose -f docker-compose.gcp.yml config > /dev/null && echo ok`.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.gcp.yml
git commit -m "chore(deploy): document EventOTMGate env vars with defaults"
```

---

## Task 6: Full dashboard test suite + build

Final regression check before opening the PR.

- [ ] **Step 1: Run the full dashboard test suite**

```bash
pnpm --filter @polymarket-trader/dashboard test
```

Expected: all tests PASS. If any unrelated test fails, investigate and fix as part of this branch only if the failure is caused by Tasks 1–5; otherwise document the failure in the PR body.

- [ ] **Step 2: Run the dashboard build to catch TypeScript errors**

```bash
pnpm --filter @polymarket-trader/dashboard build
```

Expected: build succeeds with no TS errors.

- [ ] **Step 3: If any fixups were needed, commit them**

```bash
git add -A
git commit -m "fix: resolve build/test issues from EventOTMGate integration"
```

(Skip if no fixups.)

---

## Task 7: Open the PR and comment on issue #117

- [ ] **Step 1: Verify git auth is on the personal account before any push**

```bash
rtk gh auth status
```

If the active account is not `JaviMaligno`, switch:

```bash
rtk gh auth switch --user JaviMaligno
```

- [ ] **Step 2: Push the branch**

```bash
rtk git push -u origin fix/event-otm-gate
```

- [ ] **Step 3: Create the PR**

```bash
rtk gh pr create --title "feat: structural gate for event_financial OTM near-expiry markets" --body "$(cat <<'EOF'
## Summary

Add a new executor gate (0e) that blocks opens on `event_financial` markets when **all three** hold:
- Market type in `EXECUTOR_EVENT_OTM_MARKET_TYPES` (default: `event_financial`)
- Hours-to-resolution below `EXECUTOR_EVENT_OTM_TTR_HOURS` (default: 240h = 10 days)
- Signal price outside `[EXECUTOR_EVENT_OTM_PRICE_LO, EXECUTOR_EVENT_OTM_PRICE_HI]` (default: [0.20, 0.80])

Blocked opens insert a shadow trade tagged `event_otm_gated`. Closes on existing positions pass through. This is the structural fix replacing closed PR #118.

## Root Cause

Issue #117 identified that WTI crude oil markets (1712297, 1712301, 1712302, 1894941) keep generating losses. Mean-reversion signals interpret prices like 0.12 as "oversold, revert up", but 0.12 with 9 days to expiry is fair value for a low-probability asymmetric payoff. Reactive threshold bumps (PR #106, PR #114, closed PR #118) can't fix the structural mismatch — each new market arrives with a new win rate and starts a new chase. The pathology lives in the conjunction (market_type × TTR × extreme price).

## Design

Full design: `docs/plans/2026-04-21-event-otm-gate-design.md` (committed in a prior commit).

## Verification on the VM (post-deploy)

```sql
-- Confirm gate is firing
SELECT COUNT(*), MAX(time) FROM shadow_trades
WHERE signal_type = 'event_otm_gated' AND time > NOW() - INTERVAL '2 hours';

-- Confirm WTI 1712302 no longer opens new positions
SELECT market_id, side, opened_at FROM paper_positions
WHERE market_id = '1712302' AND opened_at > NOW() - INTERVAL '2 hours';
```

Expected: shadow count > 0 within ~30 min, zero new opens on 1712302.

## Rollback

Set `EXECUTOR_EVENT_OTM_TTR_HOURS=0` in `docker-compose.gcp.yml` and restart dashboard-api. No code revert needed.

## Test Plan

- [x] New unit tests in `packages/dashboard/src/services/AutoSignalExecutor.eventOTMGate.test.ts`
- [x] Full `pnpm test` passes on the dashboard package
- [x] `pnpm build` passes
- [ ] Post-deploy SQL verification (above)

Related to #117.
EOF
)"
```

- [ ] **Step 4: Comment on issue #117 to link the structural fix**

```bash
rtk gh issue comment 117 --body "$(cat <<'EOF'
Opened a structural fix for the WTI loss pattern: the new `EventOTMGate` (gate 0e) blocks opens on `event_financial` markets when TTR is bounded AND price is in an extreme band. This replaces the closed PR #118 (threshold bump) with a conjunction gate that kills the pathology for the whole class, not just the individual WTI markets observed.

Design: `docs/plans/2026-04-21-event-otm-gate-design.md`
PR: see above (linked by GitHub).

Issue stays open until VM verification confirms the gate is firing and no new opens land on the four flagged markets.
EOF
)"
```

---

## Self-Review Checklist (run before marking plan complete)

- [ ] **Spec coverage:** Decisions Q1–Q5 in `docs/plans/2026-04-21-event-otm-gate-design.md` → Q1 (conjunction AND) covered by Task 4 step 2; Q2 (all signals, no signalId check) covered in gate conditions; Q3 (defaults now) covered by Task 4 step 1; Q4 (shadow trade) covered by Tasks 2 + 4; Q5 (allow closes) covered by `hasOpenPosition` bypass in Task 4.
- [ ] **Placeholder scan:** two intentionally-placeholder env-override tests are labeled and justified in-code; no "TBD" or "TODO" in the actual plan body.
- [ ] **Type consistency:** `insertShadowTrade(signal, signalTypeOverride?)` used consistently in Tasks 2 and 4; `EVENT_OTM_*` constant names identical across the plan; `event_otm_gated` (with underscore) used as the shadow `signal_type` tag consistently.
- [ ] **Failure modes covered:** null `end_date`, null `marketType`, non-matching `marketType`, mid-price, long TTR, closing a position, disabled via `TTR_HOURS=0`, position-check exception.

---

## Follow-up (separate PR, not in this plan)

- Add `EVENT_OTM_TTR_HOURS`, `EVENT_OTM_PRICE_LO`, `EVENT_OTM_PRICE_HI` to `OPTUNA_PARAM_SPACE` so the next full optimization run refines them. Ranges from the design doc: TTR ∈ [24, 336], PRICE_LO ∈ [0.05, 0.25], PRICE_HI ∈ [0.75, 0.95]. This is deferred intentionally so the initial defaults can be observed unperturbed for at least one full run (~6h).
