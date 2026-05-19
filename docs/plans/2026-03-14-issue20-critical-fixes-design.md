# Issue #20 Critical Fixes — Design Document

**Date:** 2026-03-14
**Issue:** [#20 — Daily Review 2026-03-14: Critical — 38% Drawdown, Circuit Breaker Threshold Bug, Missing DB Tables](https://github.com/JaviMaligno/polymarket-trader/issues/20)
**Status:** Design

---

## Problem Summary

The trading system lost 38% of capital ($3,815 of $10,000) due to a combination of 6 bugs:

1. **Upsert Zombie Bug** — positions re-opened on same market become invisible, trapping capital permanently
2. **Circuit breaker threshold** — hardcoded at 30% instead of reading MAX_DRAWDOWN env var (15%)
3. **Circuit breaker drawdown formula** — uses capital-only, not equity (capital + positions)
4. **50/50 market filter missing** — order flow signals bypass PriceRangeWeightModifier at $0.50
5. **CircuitBreakerService bypasses PositionClosingService** — direct SQL, no events, potential inconsistency
6. **Missing DB tables** — external_signals and market_crossref never applied to production

### Accounting Gap Investigation

**DB evidence (2026-03-14):**
- `paper_account.total_realized_pnl = -$79.97` but positions sum to `+$324.52`
- **29 zombie positions** with `size > 0` AND `closed_at IS NOT NULL` → **$2,656.80 trapped**
- 253 buys vs only 78 sells — massive imbalance
- Expected capital from position PnL: $10,324.52 vs actual: $6,185.11 → **$4,139 gap**

**Root cause:** `paperPositionsRepo.upsert()` uses `ON CONFLICT (market_id, token_id) DO UPDATE` but does NOT reset `closed_at = NULL`. When a new BUY fires for a previously-closed position:
1. Capital deducted from account
2. `size` overwritten with new value
3. `closed_at` stays set (from previous close)
4. `getAll()` filters `WHERE closed_at IS NULL` → position invisible
5. No service can see it → capital permanently trapped

This bug has been active since the system started and explains why the accounting gap keeps growing across account resets.

---

## Fix 1: Upsert Zombie Bug

**File:** `packages/dashboard/src/database/repositories.ts:327-358`

**Current code (line 334):**
```sql
ON CONFLICT (market_id, token_id) DO UPDATE SET
  current_price = EXCLUDED.current_price,
  unrealized_pnl = EXCLUDED.unrealized_pnl,
  unrealized_pnl_pct = EXCLUDED.unrealized_pnl_pct,
  realized_pnl = EXCLUDED.realized_pnl,
  size = EXCLUDED.size,
  updated_at = NOW()
```

**Fix — add `closed_at = NULL` and reset open fields:**
```sql
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
  updated_at = NOW()
```

**Why each field:** When a new BUY re-uses a market_id+token_id, it's a brand new position. All fields must reflect the new entry — not carry stale data from the previous close. `closed_at = NULL` is the critical one (makes it visible), but `opened_at`, `avg_entry_price`, `signal_type`, `metadata`, `stop_loss`, `take_profit` must also reset to avoid stale data.

**Test:** Open position → close it → open new position on same market → verify `closed_at IS NULL` and position appears in `getAll()`.

---

## Fix 2: Circuit Breaker Threshold

**Files:**
- `packages/dashboard/src/server.ts:187`
- `packages/dashboard/src/services/CircuitBreakerService.ts:42`

**Current:** `maxDrawdownPct: 30` (hardcoded)

**Fix in server.ts:**
```typescript
const circuitBreakerService = initializeCircuitBreakerService({
  enabled: true,
  checkIntervalMs: 5 * 60 * 1000,
  maxDrawdownPct: parseFloat(process.env.MAX_DRAWDOWN || '0.15') * 100,
  initialCapital: parseFloat(process.env.INITIAL_CAPITAL || '10000'),
});
```

**Fix in CircuitBreakerService.ts DEFAULT_CONFIG:**
```typescript
const DEFAULT_CONFIG: CircuitBreakerConfig = {
  enabled: true,
  checkIntervalMs: 5 * 60 * 1000,
  maxDrawdownPct: parseFloat(process.env.MAX_DRAWDOWN || '0.15') * 100,  // 15% default
  initialCapital: parseFloat(process.env.INITIAL_CAPITAL || '10000'),
  cooldownMs: 30 * 60 * 1000,
  autoReset: false,
};
```

This reads `MAX_DRAWDOWN=0.15` (decimal) and converts to `15` (percentage) to match the field name `maxDrawdownPct`.

---

## Fix 3: Circuit Breaker Drawdown Formula

**File:** `packages/dashboard/src/services/CircuitBreakerService.ts:160-171`

**Current (line 171):**
```typescript
const drawdownPct = ((initialCapital - currentCapital) / initialCapital) * 100;
```

This only uses `currentCapital` (cash). When $5,000 is in positions, it shows 50% drawdown even though equity is $10,000.

**Fix — use equity (capital + positions), matching RiskManager:**
```typescript
// Get total exposure from open positions
const exposureResult = await query<{ total_exposure: string }>(
  `SELECT COALESCE(SUM(size * current_price), 0) as total_exposure
   FROM paper_positions WHERE closed_at IS NULL`
);
const totalExposure = parseFloat(exposureResult.rows[0]?.total_exposure || '0');
const currentEquity = currentCapital + totalExposure;
const drawdownPct = ((initialCapital - currentEquity) / initialCapital) * 100;
```

---

## Fix 4: 50/50 Market Filter in setActiveMarkets

**File:** `packages/dashboard/src/services/SignalEngine.ts:271-310`

The `PriceRangeWeightModifier` zeros momentum/mean_reversion for 0.45-0.55 but OFI, MLOFI, Hawkes stay at weight 1.0. This allows trades at $0.50 where there's no edge.

**Fix — add explicit filter in `setActiveMarkets()`:**
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
    if (m.isActive === false) { inactiveCount++; return false; }
    if (m.isResolved === true) { resolvedCount++; return false; }

    const price = m.currentPrice;
    if (price < MIN_PRICE || price > MAX_PRICE) { extremePriceCount++; return false; }

    // Filter 4: Skip 50/50 markets (no edge, fees make EV negative)
    if (price >= FIFTY_FIFTY_MIN && price <= FIFTY_FIFTY_MAX) {
      fiftyFiftyCount++;
      return false;
    }

    return true;
  });

  const totalExcluded = inactiveCount + resolvedCount + extremePriceCount + fiftyFiftyCount;
  if (totalExcluded > 0) {
    console.log(`[SignalEngine] Filtered markets: ${inactiveCount} inactive, ${resolvedCount} resolved, ${extremePriceCount} extreme, ${fiftyFiftyCount} near-50/50`);
  }

  this.activeMarkets = filtered;
  console.log(`[SignalEngine] Updated active markets: ${filtered.length}`);
  this.emit('markets:updated', filtered.length);
}
```

**Note:** `PriceRangeWeightModifier` stays as defense-in-depth — it handles transitional bands (0.40-0.45, 0.55-0.60) where signals should be reduced but not eliminated.

---

## Fix 5: CircuitBreakerService → PositionClosingService

**File:** `packages/dashboard/src/services/CircuitBreakerService.ts:270-326`

Currently `closeAllPositions()` does direct SQL for each position (lines 291-314). This bypasses PositionClosingService and doesn't emit `position:closed` events.

**Fix — delegate to PositionClosingService:**
```typescript
private async closeAllPositions(): Promise<number> {
  const positions = await query<any>(
    'SELECT * FROM paper_positions WHERE closed_at IS NULL'
  );

  let closed = 0;
  const closingService = getPositionClosingService();

  for (const pos of positions.rows) {
    const exitPrice = parseFloat(pos.current_price) || parseFloat(pos.avg_entry_price);
    const result = await closingService.close({
      marketId: pos.market_id,
      tokenId: pos.token_id,
      exitPrice,
      reason: 'circuit_breaker_exit',
      size: parseFloat(pos.size),
    });
    if (result.executed) {
      closed++;
      console.log(`[CircuitBreaker] Closed ${pos.market_id.substring(0, 12)}... | P&L: $${result.netPnl.toFixed(2)}`);
    }
  }

  console.log(`[CircuitBreaker] Closed ${closed} positions`);
  return closed;
}
```

This removes ~50 lines of duplicated SQL and ensures consistent fee/PnL handling plus event emission.

---

## Fix 6: Missing DB Tables

**File:** `packages/data-collector/src/database/init/004_external_data_schema.sql`

The schema exists but was never applied to the production database. Apply it via SSH:

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

**Also:** Add `CREATE TABLE IF NOT EXISTS` for both tables in the dashboard-api startup (database init) so they auto-create on future deployments.

---

## Post-Fix: Account Reset

After deploying all 6 fixes:

1. Reset paper_account to $10,000
2. Close all zombie positions (29 with `size > 0 AND closed_at IS NOT NULL`)
3. Clear max_drawdown to 0
4. Reset peak_equity to $10,000
5. Reset trade counters

```sql
-- Clean zombies
UPDATE paper_positions SET size = 0, realized_pnl = 0 WHERE closed_at IS NOT NULL AND size > 0;

-- Reset account
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

-- Clear halt status
UPDATE trading_config SET value = 'false', updated_at = NOW() WHERE key = 'trading_halted';
```

---

## Implementation Order

| Step | Fix | Risk if skipped | Effort |
|------|-----|----------------|--------|
| 1 | Fix 1: Upsert zombie | Capital keeps leaking | Small (1 SQL line) |
| 2 | Fix 2: CB threshold | System allows 30% loss | Small (2 lines) |
| 3 | Fix 3: CB drawdown formula | Phantom triggers when capital in positions | Small (5 lines) |
| 4 | Fix 4: 50/50 filter | Trades with no edge | Small (8 lines) |
| 5 | Fix 5: CB → PositionClosingService | Inconsistent closes | Medium (refactor method) |
| 6 | Fix 6: Missing DB tables | Log noise, data gaps | Small (apply SQL) |
| 7 | Account reset | Corrupted data | Small (run SQL) |

All fixes are independent and can be implemented in any order. Recommended: deploy fixes 1-5 as a single commit, apply fix 6 + reset on production DB separately.

---

## Testing Strategy

1. **Unit test for upsert zombie** — open, close, re-open same market, verify `closed_at IS NULL`
2. **Unit test for CB threshold** — verify it reads `MAX_DRAWDOWN` env var
3. **Unit test for CB drawdown** — mock positions with exposure, verify equity-based calculation
4. **Integration test for 50/50 filter** — set market at 0.50, verify excluded from `setActiveMarkets()`
5. **Existing tests** — run full test suite to verify no regressions
