# Risk Protection System Design

## Problem

A single position caused 93% of losses ($-113 of $-124 total unrealized PnL). The system kept buying a falling market (mean_reversion signals on a trending market), accumulating 4,211 shares as price dropped from $0.169 to $0.115.

## Solution

Multi-layered protection system with optimizable parameters.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    TRADE FILTER PIPELINE                     │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. POSITION LIMITS (A)                                      │
│     └─ Max exposure per market: 3% of capital                │
│     └─ Max open positions: 20                                │
│                                                              │
│  2. STOP-LOSS CHECK (B)                                      │
│     └─ Trailing stop: -15% from high water mark              │
│     └─ Hard stop: -25% from entry (never exceed)             │
│                                                              │
│  3. ENTRY FILTER (C) - Cascading Logic                       │
│     ┌─────────────────────────────────────────┐              │
│     │ Has 50+ price bars?                     │              │
│     │   YES → Hurst Regime Detection (C1)     │              │
│     │   NO  → Fallback Filter (C2+C3)         │              │
│     └─────────────────────────────────────────┘              │
│     ┌─────────────────────────────────────────┐              │
│     │ Has volume data?                        │              │
│     │   YES → Volume Proxy Confirmation (C4)  │              │
│     │   NO  → Skip volume check               │              │
│     └─────────────────────────────────────────┘              │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Components

### A) Position Limits

Fixed limits (not optimizable - safety constraints):

```typescript
interface PositionLimits {
  maxExposurePerMarket: 0.03,    // 3% of capital per market
  maxTotalExposure: 0.60,        // 60% max invested
  maxOpenPositions: 20,          // Max 20 positions
  minPositionSize: 5,            // Min $5 per trade
}
```

### B) Stop-Loss

Optimizable within safe ranges:

```typescript
interface StopLossConfig {
  // Optimizable
  trailingStopPct: [0.10, 0.15, 0.20, 0.25],
  hardStopPct: [0.20, 0.25, 0.30],
  takeProfitPct: [0.15, 0.20, 0.30, 0.50],

  // Fixed safety limits
  absoluteMaxLoss: 0.35,         // Never lose more than 35%
  checkIntervalMs: 60000,        // Check every minute
}
```

### C1) Hurst Regime Detection

Used when 50+ price bars available:

```typescript
interface HurstConfig {
  // Optimizable
  windowSize: [20, 30, 40],
  meanReversionThreshold: [0.40, 0.45, 0.50],
  trendingThreshold: [0.55, 0.60, 0.65],

  // Fixed
  minBars: 50,                   // Required for valid calculation
}
```

**Logic:**
- H < meanReversionThreshold → ALLOW mean_reversion signals
- H > trendingThreshold → BLOCK mean_reversion signals (trending market)
- In between → REDUCE position size 50%

### C2) RSI with Momentum Confirmation

Fallback when < 50 bars:

```typescript
interface RSIConfig {
  // Optimizable
  period: [10, 14, 20],
  oversoldThreshold: [25, 30, 35],
  momentumBars: [2, 3, 5],
}
```

**Logic:**
- RSI < oversold + RSI rising → ALLOW (reversal starting)
- RSI < oversold + RSI falling → BLOCK (still falling)
- RSI 30-40 + RSI rising → REDUCE 50%

### C3) Z-Score with Volatility Filter

Combined with RSI for fallback:

```typescript
interface ZScoreConfig {
  // Optimizable
  maPeriod: [15, 20, 30],
  entryZScore: [-1.5, -2.0, -2.5],
  maxVolatilityRatio: [1.3, 1.5, 2.0],

  // Fixed
  volatilityLookback: 30,
}
```

**Logic:**
- zScore < entry + normal volatility → ALLOW
- zScore < entry + high volatility → BLOCK (crash in progress)
- High volatility = current vol > maxRatio × historical vol

### C4) Volume Proxy (Limited)

Polymarket API limitation: No per-bar volume data available.

**Workaround:**
- Track delta of `volume_24h` between market syncs
- Track `liquidity` changes
- Use as additional signal, not blocking criterion

## Optimization Strategy

### 2-Phase Approach

**Phase 1: Optimize Protection (signals fixed)**
- Fix signal parameters at reasonable defaults
- Optimize: stops, Hurst thresholds, RSI, Z-Score
- Objective: Minimize losses in extreme cases

**Phase 2: Optimize Signals (protection fixed)**
- Use best protection from Phase 1
- Optimize signal parameters
- Objective: Maximize risk-adjusted returns

### Fitness Function

```typescript
function calculateFitness(params, results): number {
  const { totalReturn, maxDrawdown, sharpeRatio, winRate } = results;

  // Heavily penalize large drawdowns
  const drawdownPenalty = maxDrawdown > 0.25 ? (maxDrawdown - 0.25) * 5 : 0;

  return (
    totalReturn * 0.3 +
    sharpeRatio * 0.3 +
    winRate * 0.2 +
    (1 - maxDrawdown) * 0.2
  ) - drawdownPenalty;
}
```

## Files to Create/Modify

```
packages/signals/src/
  └── filters/
      ├── PositionLimits.ts
      ├── StopLossManager.ts
      ├── HurstFilter.ts
      ├── RSIMomentumFilter.ts
      ├── ZScoreVolatilityFilter.ts
      └── EntryFilterPipeline.ts

packages/trader/src/
  └── orchestrator/
      └── StrategyOrchestrator.ts (integrate pipeline)

packages/backtest/src/
  └── optimizer/
      └── RiskParamsOptimizer.ts

packages/dashboard/src/
  └── services/
      └── RiskManager.ts (add stop-loss checking)
```

## Expected Impact

Applied to the problematic case ($-113 loss on single position):

| Protection | Effect | Estimated Loss |
|------------|--------|----------------|
| None (current) | 4,211 shares at -31% | $113 |
| Position Limits only | Max ~$300 invested | ~$50 |
| Stop-Loss -25% only | Exit at $0.127 | ~$42 |
| Hurst Filter only | Block buys (H > 0.55) | ~$10-15 |
| **All combined** | Limited entry + early exit | **~$15-25** |

## Implementation Priority

1. **High**: Position Limits (A) + Stop-Loss (B) - immediate risk reduction
2. **High**: Hurst Filter (C1) - prevents buying falling knives
3. **Medium**: RSI + Z-Score Fallback (C2+C3) - covers low-data scenarios
4. **Medium**: Optimizer v2 with risk params
5. **Low**: Volume Proxy (C4) - limited data availability
