# Phase 2: Risk & Protection Fixes — 2026-03-11

## Context

After Phase 1 (PR #6) fixed PnL accounting, signal generation, and optimization pipeline, GitHub issues #5 and #7 surfaced 6 remaining problems. Ordered by severity.

---

## 1. CRITICAL: trading_config Table Missing — CircuitBreaker Non-Functional

**Problem:** `CircuitBreakerService` writes to `trading_config` table, but the table was never created. INSERT fails silently → circuit breaker never halts trading, even during cascading losses.

**Design:**

Add `CREATE TABLE IF NOT EXISTS` at CircuitBreakerService startup:

```sql
CREATE TABLE IF NOT EXISTS trading_config (
  key VARCHAR(255) PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

Plus in-memory fallback: `this.isHalted: boolean` flag. When DB write fails, set the flag. `shouldHalt()` checks flag OR DB. This way even a DB outage can't bypass the breaker.

**Scope:** ~15 lines in `CircuitBreakerService.ts`.

---

## 2. CRITICAL: No Stop-Loss Re-Entry Cooldown

**Problem:** After StopLossService closes a position (e.g., Chelsea EPL at -15%), the next signal cycle finds no open position → opens a new one → stopped out again. Observed 30+ re-entries on same market.

**Design:**

In-memory cooldown map in `AutoSignalExecutor`:

```typescript
private stoppedOutMarkets: Map<string, number> = new Map(); // marketId → timestamp

// On position close event (from PositionClosingService):
if (reason === 'stop_loss') {
  this.stoppedOutMarkets.set(marketId, Date.now());
}

// In processSignal(), before opening:
const stoppedAt = this.stoppedOutMarkets.get(signal.marketId);
if (stoppedAt && Date.now() - stoppedAt < STOP_LOSS_COOLDOWN_MS) {
  logger.info(`Cooldown active for ${signal.marketId}, skipping`);
  return;
}
```

**Constants:**
- `STOP_LOSS_COOLDOWN_MS = 4 * 60 * 60 * 1000` (4 hours)

**In-memory is acceptable** — cooldown loss on restart means at most one extra re-entry before the map rebuilds. Not worth DB persistence for this.

**Scope:** ~15 lines in `AutoSignalExecutor.ts`.

---

## 3. HIGH: No Per-Market Position Concentration Limit

**Problem:** System can open unlimited positions on the same market. Combined with issue #2, this concentrates risk on a single losing market.

**Design:**

Check in `AutoSignalExecutor.processSignal()` before opening:

```typescript
const openOnMarket = positions.filter(
  p => p.market_id === signal.marketId && p.size > 0
).length;
if (openOnMarket >= MAX_POSITIONS_PER_MARKET) {
  logger.info(`Market ${signal.marketId} at position limit (${openOnMarket})`);
  return;
}
```

**Constants:**
- `MAX_POSITIONS_PER_MARKET = 2`

**Scope:** ~5 lines in `AutoSignalExecutor.ts`.

---

## 4. HIGH: RiskManager Defaults to ALLOW on Failure

**Problem:** `RiskManager.canOpenPosition()` (line 446-449) catches DB errors and returns `{ allowed: true }`. During DB outage, all risk checks are bypassed — positions open unchecked.

**Design:**

Change catch blocks to BLOCK:

```typescript
// canOpenPosition() catch block:
catch (error) {
  logger.error('Risk check failed, BLOCKING trade:', error);
  return { allowed: false, reason: 'risk_check_failed' };
}

// checkRisk() catch block — return degraded status:
catch (error) {
  logger.error('checkRisk failed, returning degraded:', error);
  return { status: 'degraded', allowed: false };
}
```

**Trade-off:** DB hiccup = no trades until recovery. Correct for real money — missing an opportunity beats opening unchecked positions.

**Scope:** ~4 lines changed in `RiskManager.ts`.

---

## 5. MEDIUM: Sports/Rapid-Resolution Market Protection

**Problem:** Sports markets resolve within hours. Our technical indicators (RSI, Bollinger, MACD) aren't designed for binary-resolution markets. Mean reversion is nonsensical on a market trending toward 0 or 1.

**Design:**

When market resolves within 24 hours, apply stricter controls instead of blocking entirely:

```typescript
const market = await this.getMarketDetails(signal.marketId);
if (market.end_date_iso) {
  const hoursToResolution = (new Date(market.end_date_iso).getTime() - Date.now()) / 3600000;

  if (hoursToResolution < NEAR_RESOLUTION_HOURS) {
    // Block mean-reversion signals — nonsensical near resolution
    if (signal.signalType === 'mean_reversion') return;

    // Require higher confidence
    if (signal.confidence < MIN_CONFIDENCE_NEAR_RESOLUTION) return;

    // Flag for half position size
    signal.nearResolution = true;
  }
}
```

**Constants:**
- `NEAR_RESOLUTION_HOURS = 24`
- `MIN_CONFIDENCE_NEAR_RESOLUTION = 0.65` (~1.5x normal threshold)
- Position size `* 0.5` when `nearResolution === true`
- Stop-loss on near-resolution market → permanent cooldown (no re-entry, via Section 2 mechanism)

**`end_date_iso` null** → passes filter (open-ended market, no imminent resolution risk).

**Scope:** ~20 lines in `processSignal()`, ~3 lines in sizing logic.

---

## 6. LOW: 50/50 Market Filtering

**Problem:** Markets at 0.45-0.55 are coin flips. Technical indicators produce noise signals, and fees (~2% roundtrip) make expected value negative.

**Design:**

Add filter alongside existing extreme-price filter in `SignalEngine.generateSignals()`:

```typescript
if (price > 0.45 && price < 0.55) {
  logger.debug(`Skipping 50/50 market ${marketId} (price=${price})`);
  continue;
}
```

**Constants:**
- `FIFTY_FIFTY_BAND = [0.45, 0.55]`

**Scope:** 3 lines in `SignalEngine.ts`.

---

## Files Affected

| File | Change |
|------|--------|
| `packages/dashboard/src/services/CircuitBreakerService.ts` | Create `trading_config` table at init + in-memory fallback |
| `packages/dashboard/src/services/AutoSignalExecutor.ts` | Stop-loss cooldown map, per-market limit, near-resolution controls |
| `packages/dashboard/src/services/RiskManager.ts` | Default to BLOCK on failure |
| `packages/dashboard/src/services/SignalEngine.ts` | 50/50 market filter |

**Total: 4 files modified, 0 new files. ~60 lines added.**

---

## Roadmap: Dedicated Pre-Resolution Signal Model

The near-resolution controls (Section 5) and 50/50 filter (Section 6) are stopgaps. Both assume our current technical indicators can't handle these market types — which is correct today.

**Next phase:** Build a dedicated signal generator for markets approaching resolution:

- **Data sources:** External odds (bookmaker APIs), news sentiment, social volume, historical resolution patterns
- **Model type:** Not technical indicators. Probability estimation from fundamental data.
- **When it's ready:**
  - Near-resolution markets (Section 5) would use this model instead of momentum-only with high confidence threshold
  - 50/50 markets (Section 6) could be unblocked if the model has fundamental edge — the 50/50 filter would only apply to technical signals, not fundamental ones
- **Trigger:** After Phase 2 is stable and generating consistent positive PnL with current signal types

This should be the immediate priority after Phase 2 stabilizes.
