# MarketRotator Warming Demotion

**Date:** 2026-04-14
**Status:** Approved

## Problem

Warming markets with extreme prices (< 5% or > 95%) cannot be promoted to active (`selectPromotions` rejects them) but have no path back to cold. They accumulate and clog the tracked market pool, preventing new candidates from entering. On Apr 13, 75 warming markets were stuck with extreme prices, leaving 0 slots for crypto markets.

Similarly, warming markets that never receive price data (0 bars in 24h) occupy slots without contributing value.

## Design

### New method: `selectWarmingDemotions(warming: MarketRow[]): MarketRow[]`

Returns warming markets that should be demoted to cold based on two criteria:

1. **Extreme price**: `isExtremePrice(m)` returns true (price < 5% or > 95%). These markets are near resolution and will never be promoted — holding them in warming wastes a slot.

2. **No progress**: `bars_24h === 0` AND time in warming exceeds `warmingStaleHours` (default 6h). These markets entered warming but never accumulated price data, indicating the data-collector can't sample them (missing token_id, delisted, API issue).

Markets with open positions are skipped (same as active demotion) — demoting would cut off price data needed for position management. These markets stay in warming until the position closes.

No cap on demotion count per hour. Unlike active→cooling demotions (which need hysteresis to prevent thrashing), stuck warming markets are definitively unpromotiable — clearing them all at once is the correct behavior.

### Config addition

Add `warmingStaleHours: number` to `RotationConfig`, default 6 (consistent with `coolingTimeoutHours: 6`).

### Integration in `rotate()`

New Step 2b between existing steps:

```
Step 2:  Expire cooling → cold
Step 2b: Demote stuck warming → cold          ← NEW
Step 3:  Promote eligible warming → active
Step 4:  Fetch cold candidates
Step 5:  Demote active (hysteresis)
Step 6:  Fill warming from cold
```

Demoting stuck warming BEFORE promoting ensures freed slots are immediately available for Step 6 (fill warming from cold).

### RotationResult addition

Add `warmingDemoted: number` to `RotationResult` and include in the log message.

### Files

- Modify: `packages/data-collector/src/services/MarketRotator.ts` — new method, config field, step 2b in rotate()
- Modify: `packages/data-collector/src/services/MarketRotator.test.ts` — tests for selectWarmingDemotions

## Non-Goals

- Warming demotion based on score drop (already handled at promotion time by `selectPromotions`)
- Market-type-aware warming priority (separate concern for future work)
- Changing the maxTracked enforcement (currently soft cap, separate issue)
