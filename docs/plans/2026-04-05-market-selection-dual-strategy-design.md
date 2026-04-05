# Market Selection Fix + Dual Strategy Design

**Date:** 2026-04-05
**Status:** Approved
**Author:** Javi + Claude

## Problem

The system trades exclusively low-probability sports markets (5-15% price) and achieves a 3.7% win rate on 129 trades post-reset. Two design bugs cause this:

1. **MarketScorer.tradeabilityScore()** gives 0 to 40-60% range, preventing 24,771 balanced markets from being tracked. The 40 tracking slots fill with long-shot sports bets.
2. **SignalEngine** filters out 45-55% range entirely, blocking signal generation even if those markets were tracked.

### Empirical Evidence

Autocorrelation analysis (114k observations, 536 markets, non-overlapping returns):

| Timescale | Autocorrelation | n |
|-----------|----------------|---|
| 5 min | -0.38 | 114,210 |
| 30 min | -0.41 | 18,289 |
| 1 hour | -0.36 | 8,830 |
| 4 hours | -0.17 | 1,907 |
| 12 hours | -0.09 | 894 |
| 24 hours | -0.01 | 275 |

Mean reversion is the dominant dynamic at all intraday timescales. Momentum is anti-correlated (3.9% win rate when used as trend-following). Inverting momentum produces a contrarian signal.

## Solution: Three Changes

### 1. Fix MarketScorer tradeability curve

**File:** `packages/data-collector/src/services/MarketScorer.ts:76-92`

Replace the current tradeability function (which zeros 40-60%) with an inverted curve that rewards balanced markets:

```
Price Range    Old Score    New Score
0-5%              0            0        (near-certain, no edge)
5-15%          ramp 0→1       0.5       (extreme, tradeable with contrarian)
15-30%           1.0          0.7       (moderate)
30-70%         0→1→0→1→0      1.0       (maximum uncertainty = maximum opportunity)
70-85%           1.0          0.7       (moderate)
85-95%         ramp 1→0       0.5       (extreme, tradeable with contrarian)
95-100%           0            0        (near-certain, no edge)
```

### 2. Remove 50/50 filter in SignalEngine

**File:** `packages/dashboard/src/services/SignalEngine.ts:304-307`

Delete the filter that excludes 45-55% from signal generation. Keep the 5%/95% extreme filters.

### 3. Dual strategy via negative momentum weight

**File:** `packages/signals/src/combiners/WeightedAverageCombiner.ts:38-43`

Re-add MomentumSignal with negative weights. The combiner already multiplies `signal.strength * weight`, so a negative weight inverts the direction automatically.

```typescript
const DEFAULT_TYPE_WEIGHTS = {
  crypto_intraday: { momentum: -0.3, mean_reversion: 0.5, ofi: 0.5, mlofi: 0.5, hawkes: 0.4 },
  crypto_daily:    { momentum: -0.3, mean_reversion: 0.6, ofi: 0.4, mlofi: 0.4, hawkes: 0.3 },
  event_short:     { momentum: -0.4, mean_reversion: 0.6, ofi: 0.3, mlofi: 0.3, hawkes: 0.2 },
  event_long:      { momentum: -0.4, mean_reversion: 0.6, ofi: 0.2, mlofi: 0.2, hawkes: 0.1 },
};
```

Weight rationale:
- **momentum -0.3/-0.4**: Proportional to measured autocorrelation (-0.38). Lower for crypto (more efficient books).
- **mean_reversion 0.5/0.6**: Primary signal. Conservative start; optimizer will likely increase for balanced markets.
- **OFI/MLOFI 0.2-0.5**: Order flow signals. Higher for crypto (deeper books). No empirical data yet.
- **Hawkes 0.1-0.4**: Trade clustering. More useful in crypto (frequent trading).

## All File Changes

| # | File | Change |
|---|------|--------|
| 1 | `packages/data-collector/src/services/MarketScorer.ts:76-92` | New tradeability curve |
| 2 | `packages/dashboard/src/services/SignalEngine.ts:147` | Re-add `MomentumSignal` to initializeSignals() |
| 3 | `packages/dashboard/src/services/SignalEngine.ts:304-307` | Remove 45-55% filter |
| 4 | `packages/signals/src/combiners/WeightedAverageCombiner.ts:38-43` | Update DEFAULT_TYPE_WEIGHTS with negative momentum |
| 5 | `packages/dashboard/src/services/OptimizationScheduler.ts` | Re-add `combiner.momentumWeight` to WEIGHT_PARAM_MAP |
| 6 | `packages/optimizer/src/core/ParameterSpace.ts` | momentumWeight bounds: [-1.5, 1.5] |
| 7 | DB (VM) | INSERT momentum into signal_weights with weight=-0.4 |

## What Does NOT Change

- PositionClosingService, PaperTradingService, AutoSignalExecutor, RiskManager
- Trade execution pipeline
- Fee calculation, PnL tracking, risk management

## Expected Outcome

1. MarketRotator promotes 40-60% markets to top ranking within ~6h
2. >50% of tracked markets should be in 30-70% range
3. Mean_reversion dominates on balanced markets (correct regime)
4. Contrarian momentum operates on remaining extreme-price markets
5. Optimizer explores [-1.5, 1.5] for momentum weight

## Success Criteria

- After 24h: tracked market distribution shifts (>50% in 30-70%)
- After 48h: win rate significantly above 3.7% on balanced markets
- Optimizer finds better scores than 0.0585

## Monitoring

- Check market distribution: `SELECT CASE WHEN current_price_yes BETWEEN 0.3 AND 0.7 THEN 'balanced' ELSE 'extreme' END, COUNT(*) FROM markets WHERE tracking_status='tracked' GROUP BY 1`
- Check win rate by price bucket post-deploy
- Check DB timeouts remain at 0
- Check weight sync includes momentum
