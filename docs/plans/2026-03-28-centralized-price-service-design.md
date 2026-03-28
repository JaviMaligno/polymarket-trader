# Centralized Price Service — Design

**Goal:** Eliminate recurring price inversion bugs by centralizing token price lookup and adding defense-in-depth validation in PositionClosingService.

**Problem:** The Yes↔No price inversion (`1 - yesPrice`) is implemented independently in 6+ code paths. Any new path or modification can forget the inversion, producing phantom PnL. This caused 3 of 5 account resets.

**Architecture:** Two layers of protection:
1. `PriceService.getTokenPrice()` — single function for correct token price lookup
2. `PositionClosingService` validation — rejects closes where `entry + exit ≈ 1.0` on short-held positions

## Components

### PriceService (`packages/dashboard/src/services/PriceService.ts`)

New file, ~30 lines. Single exported function:

```typescript
async function getTokenPrice(marketId: string, side: 'long' | 'short'): Promise<number | null>
```

- Queries `price_history` via `markets.clob_token_id_yes` (always Yes token)
- Returns `yesPrice` for LONG, `1 - yesPrice` for SHORT
- Returns `null` if no price data available

### SQL helper for batch queries

For StopLossService (processes N positions in one query), a shared SQL fragment:

```sql
CASE WHEN pp.side = 'short' THEN 1 - ph.close ELSE ph.close END
```

Extracted as a constant/comment reference, not duplicated.

### PositionClosingService validation

Before PnL calculation in `close()`:

```typescript
const inversionScore = Math.abs(entryPrice + exitPrice - 1.0);
if (inversionScore < 0.05 && holdTimeSeconds < 1800) {
  // BLOCK: likely inverted exit price
  return null;
}
```

Threshold: `|entry + exit - 1.0| < 0.05` AND position held < 30 minutes.

### Caller migration

| Caller | Strategy | Reason |
|--------|----------|--------|
| AutoSignalExecutor.closePosition | JS: `getTokenPrice()` | Processes 1 position at a time |
| CircuitBreakerService | JS: `getTokenPrice()` | Processes 1 position at a time |
| PositionCleanupService | JS: `getTokenPrice()` | Processes 1 position at a time |
| StopLossService | SQL CASE (shared fragment) | Batch query, N positions at once |

### AutoSignalExecutor.closePosition fallback chain

After migration:
1. `getTokenPrice(marketId, position.side)` — primary (centralized, correct)
2. `position.current_price` — last known correct price
3. `correctedSignalPrice` — signal.price adjusted for position side (existing fix from commit 6a2bdb6)

## Testing

### Unit tests for PriceService
- LONG returns yesPrice directly
- SHORT returns 1 - yesPrice
- Returns null when no price data
- Handles DB errors gracefully

### Integration test for inversion guard
- Attempt to close with inverted price → blocked
- Attempt to close with correct price → succeeds
- Edge case: legitimate market reversal (hold > 30 min) → not blocked

### Regression tests
- All existing tests must pass (523 tests)
- Add test: SHORT signal closing LONG position with DB timeout → correct price used
