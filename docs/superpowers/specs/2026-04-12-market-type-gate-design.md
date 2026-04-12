# Market Type Execution Gate + Shadow Trading

**Date:** 2026-04-12
**Status:** Approved

## Problem

The trading system generates signals and executes trades across all market types indiscriminately. Microsignals (OFI, MLOFI, Hawkes, spread compression, etc.) work well in markets with continuous price discovery (crypto), but poorly in event/news markets where price moves are driven by discrete information. Mixing PnL from both obscures whether the system is profitable where it should be.

## Goals

1. **Isolate live trading** to market types where microsignals are effective (crypto initially)
2. **Collect shadow data** for blocked market types to evaluate when they're ready for live trading
3. **Surface per-type statistics** across all diagnostic scripts for better analysis
4. Keep tracking and signal generation for all market types (data accumulation for backtesting/shadow analysis)

## Non-Goals

- Refining the MarketClassifier taxonomy (future work informed by shadow trade data)
- Hot-toggle of allowed types via API (env var is sufficient)
- Shadow portfolio with in-memory position tracking (too heavy for e2-micro VM)
- Closing existing positions in blocked types (they close normally via signals/stop-loss)

## Design

### 1. Execution Gate

**Config:** Environment variable `ALLOWED_MARKET_TYPES` (comma-separated list of market types).

- Default: unset (no filtering — backward compatible)
- Initial deployment: `ALLOWED_MARKET_TYPES=crypto_intraday,crypto_daily`

**Integration point:** `AutoSignalExecutor.processSignal()`

- New check early in the rejection chain (after circuit breaker, before strength checks)
- Only applies to **new position openings** — exits/closes of existing positions are never blocked
- Rejection reason: `"market_type_not_allowed"`
- Logged like any other rejection (visible in docker logs and daily review)

**Data flow change:** `SignalResult` interface currently lacks `marketType`. Must be added and propagated from `SignalEngine.convertToSignalResult()` where `market.marketType` is already available.

**Files modified:**
- `packages/dashboard/src/services/AutoSignalExecutor.ts` — add `marketType` to `SignalResult`, add gate check, parse env var
- `packages/dashboard/src/services/SignalEngine.ts` — propagate `market.marketType` to `SignalResult`
- `docker-compose.gcp.yml` — add `ALLOWED_MARKET_TYPES` env var to dashboard-api

### 2. Shadow Trading

When the execution gate rejects a signal, record what the system *would have done* for offline analysis.

**Table: `shadow_trades`**

```sql
CREATE TABLE shadow_trades (
  id SERIAL PRIMARY KEY,
  time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  market_id VARCHAR(255) NOT NULL,
  market_type VARCHAR(20) NOT NULL,
  direction VARCHAR(5) NOT NULL,        -- 'long' or 'short'
  entry_price FLOAT NOT NULL,
  theoretical_size FLOAT NOT NULL,      -- computed same as real executor
  signal_strength FLOAT NOT NULL,
  signal_confidence FLOAT NOT NULL,
  signal_type VARCHAR(100),             -- contributing signal names
  resolved_at TIMESTAMPTZ,              -- filled when market resolves
  resolution_price FLOAT,               -- 0 or 1
  theoretical_pnl FLOAT                 -- computed at resolution
);

CREATE INDEX idx_shadow_trades_market_type ON shadow_trades(market_type);
CREATE INDEX idx_shadow_trades_time ON shadow_trades(time DESC);
CREATE INDEX idx_shadow_trades_unresolved ON shadow_trades(resolved_at) WHERE resolved_at IS NULL;
```

**Insert flow:**
- `AutoSignalExecutor.processSignal()` — when rejecting for `market_type_not_allowed`, compute theoretical position size and INSERT into `shadow_trades`
- Fire-and-forget (async, no await, doesn't block signal processing)
- Position size calculation reuses the existing sizing logic in the executor

**Resolution flow:**
- `MarketPerformanceTracker` (runs daily at 02:45 UTC) — new step after `updateCategoryPriors()`:
  - Query `shadow_trades WHERE resolved_at IS NULL`
  - JOIN with `markets WHERE is_resolved = true`
  - Compute `theoretical_pnl`: for LONG, `pnl = (resolution_price - entry_price) * theoretical_size`; for SHORT, `pnl = (entry_price - resolution_price) * theoretical_size`. Resolution price is 1.0 (YES wins) or 0.0 (NO wins).
  - UPDATE `resolved_at`, `resolution_price`, `theoretical_pnl`

**Analysis script: `scripts/check-shadow-trades.js`**
- Total shadow trades by type
- Win rate and theoretical PnL by type (resolved only)
- Comparison: shadow performance vs real trading performance
- Recent unresolved shadow trades
- **Readiness tiers** per market type (see section 3a)

**Files:**
- New: SQL migration for `shadow_trades` table
- New: `scripts/check-shadow-trades.js`
- Modified: `AutoSignalExecutor.ts` — shadow insert on type gate rejection
- Modified: `MarketPerformanceTracker.ts` — shadow resolution step

### 3a. Readiness Tiers for Shadow Market Types

`check-shadow-trades.js` computes a readiness tier for each market type based on resolved shadow trades. This is presentation logic only — no runtime overhead.

**Tier definitions (initial thresholds, optimizable later):**

| Tier | Label | Criteria |
|------|-------|----------|
| 1 | **Ready** | Sharpe > 0.5, win_rate > 55%, resolved trades >= 20 |
| 2 | **Promising** | Positive theoretical PnL, but Sharpe <= 0.5 or trades < 20 |
| 3 | **Insufficient data** | Fewer than 10 resolved trades |
| 4 | **Not viable** | Sharpe <= 0 with >= 10 resolved trades |

**Output example:**
```
=== SHADOW READINESS TIERS ===
event_short    | Tier 2 (Promising)       | 14 trades | win 57% | sharpe 0.31
event_long     | Tier 3 (Insufficient)    |  4 trades | win 50% | sharpe -
financial_*    | Tier 3 (Insufficient)    |  0 trades | -       | -
```

**No auto-promotion.** Tiers are advisory — adding a type to `ALLOWED_MARKET_TYPES` is always a manual decision.

### 3b. Per-Type Statistics in Diagnostic Scripts

Surface `market_type` breakdown across all existing diagnostic scripts.

**`scripts/check-trades.js`** — new section "Performance by Market Type":
- JOIN `paper_positions` + `markets` GROUP BY `market_type`
- Show: trade count, win_rate, total_pnl, avg_pnl per type
- Filter by post-reset trades (`paper_account.last_reset_at`)

**`scripts/check-status.js`** — new section "Market Distribution by Type":
- Count active/tracked markets grouped by `market_type`
- Shows how many of each type are currently in the pipeline

**`scripts/check-activity.js`** — new section "Signals by Market Type":
- Signals generated in last hours grouped by `market_type`
- Shows which types are actively producing signals vs blocked

**`scripts/daily-review.sh`** — new section:
- Query `category_performance` table (already computed daily)
- 24h trade breakdown by `market_type`
- Shadow trade summary (if any resolved)

**Files modified:** `scripts/check-trades.js`, `scripts/check-status.js`, `scripts/check-activity.js`, `scripts/daily-review.sh`

### 4. Deployment

**docker-compose.gcp.yml changes:**
```yaml
dashboard-api:
  environment:
    - ALLOWED_MARKET_TYPES=crypto_intraday,crypto_daily
```

**Migration:** `shadow_trades` table creation runs via the existing `CREATE TABLE IF NOT EXISTS` pattern at startup, or as a new numbered migration file.

**Rollback:** Remove or unset `ALLOWED_MARKET_TYPES` → system reverts to trading all types. Shadow trades table remains but no new inserts.

## Future Work (out of scope)

- **Classifier refinement:** Add `financial_short`, `financial_long` types when shadow data shows which event subtypes have profitable microsignals
- **Hot-toggle API:** Move `ALLOWED_MARKET_TYPES` to `trading_config` DB table for runtime changes
- **Shadow portfolio:** Full in-memory position tracking with exits for richer PnL analysis
- **Auto-promotion:** Automatically allow a market type when its shadow Sharpe exceeds a threshold
