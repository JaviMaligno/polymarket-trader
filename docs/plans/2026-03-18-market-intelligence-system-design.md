# Market Intelligence System (MIS) — Design Document

**Date**: 2026-03-18
**Status**: Design approved, pending implementation
**Problem**: Zero signals for 2+ days — data-collector tracks markets by volume only, all 40 slots filled with extreme/50-50 markets

## Root Cause Analysis

### Evidence (collected 2026-03-18 via SSH)

```sql
-- Market price distribution (all active, unresolved, with token_id)
        price_range         | count
----------------------------+-------
 fifty_fifty (0.45-0.55)    | 22716
 extreme_low (<0.05)        | 12903
 tradeable_low (0.05-0.45)  | 10684
 extreme_high (>0.95)       |  3881
 tradeable_high (0.55-0.95) |  3452
 no_price                   |    56

-- Filter funnel
 total_active | pass_extreme | pass_5050 | pass_volume
--------------+--------------+-----------+-------------
        53692 |        36852 |     14136 |        1840

-- Dashboard logs
[PolymarketService] Found 7 markets with recent price data (filtered by price_history)
[SignalEngine] Filtered markets: 0 inactive, 0 resolved, 0 extreme prices, 7 near-50/50
[SignalEngine] Updated active markets: 0
```

### Diagnosis

1. Data-collector selects top 40 markets by `volume_24h DESC` — no price range filter
2. High-volume Polymarket markets are dominated by resolved events (extreme prices) and stagnant political markets (50/50)
3. All 7 markets with recent price_history fall in filtered ranges
4. SignalEngine requires `EXISTS (price_history last 24h)` → only sees those 7
5. All 7 filtered out → 0 active markets → 0 signals → 0 trades

**1,840 markets** in the DB pass all filters but have no price data collected.

---

## Solution: Market Intelligence System

Three phases, each building on the previous.

### Phase 1: Smart Scoring + Dynamic Rotation

Unblocks trading immediately by selecting tradeable markets.

### Phase 2: Feedback Loop

Learns which market categories are profitable and adjusts scoring.

### Phase 2.5: Parameter Optimization

Connects optimizable parameters to Optuna for automated tuning.

### Phase 3: Review System Fix

Ensures the daily auto-review investigates rather than speculates.

---

## Phase 1: MarketScorer

### Composite Score

Each market receives a score (0-1) computed by a single SQL query, executed once per hour inside the existing `sync-markets` job.

**5 dimensions:**

| Dimension | Weight | Measures | Computation |
|-----------|--------|----------|-------------|
| Tradeability | 0.30 | Is the price in a profitable range? | Distance to optimal ranges [0.15-0.40] ∪ [0.60-0.85]. Max score in those ranges, decays toward extremes and 50/50 |
| Liquidity | 0.25 | Can we enter/exit without slippage? | `log(volume_24h)` normalized. Penalty if spread > 3% |
| Volatility | 0.20 | Is there price movement for signals? | Stddev of price over last 24h from price_history. Penalizes both 0 (dead market) and >0.15 (likely resolving) |
| Time-to-Resolution | 0.15 | Is there useful life remaining? | Based on `end_date_iso`. Optimal: 7-60 days. Penalizes <24h and >180 days |
| Data Quality | 0.10 | Do we have real data? | Ratio of informative bars (source='api' or price changed) vs flat snapshots |

**All weights are initial defaults — will be connected to Optuna in Phase 2.5.**

### Tradeability Curve

```
Score
1.0 |          ┌────────┐          ┌────────┐
    |         /          \        /          \
0.5 |        /            \      /            \
    |       /              \    /              \
0.0 |──────/                \──/                \──────
    0.0  0.05  0.15   0.40 0.45 0.55 0.60   0.85 0.95 1.0
         │     └─ optimal ─┘│    │└─ optimal ─┘     │
         extreme            50/50               extreme
```

### Storage

- New column: `market_score FLOAT DEFAULT 0` on `markets` table
- No new tables, no extra memory
- Query execution: ~50ms (indexed on is_active, is_resolved)

---

## Phase 1: MarketRotator

### Market Tracking States

```
                    score rises
    ┌──────────┐   ──────────>   ┌──────────┐   accumulates   ┌──────────┐
    │   COLD   │                 │ WARMING  │   3+ real bars  │  ACTIVE  │
    │ (no data)│                 │ (collects│   ──────────>   │(generates│
    └──────────┘                 │  data)   │                 │ signals) │
                                 └──────────┘                 └──────────┘
                                      │                            │
                                      │ score drops                │ score drops
                                      ▼                            ▼
                                 ┌──────────┐                 ┌──────────┐
                                 │ DROPPED  │   if position   │ COOLING  │
                                 │(exits now│   open          │(keeps    │
                                 └──────────┘   ──────────>   │data 1h)  │
                                                              └──────────┘
```

### Rotation Rules

| Rule | Description |
|------|-------------|
| **Entry** | Top N markets by `market_score` not currently tracked enter as WARMING |
| **Promotion** | WARMING → ACTIVE when they accumulate >=3 real bars in price_history |
| **Re-eval on promotion** | Score rechecked before promoting. If score dropped below threshold, drop instead |
| **Protection** | Markets with open positions NEVER dropped — move to COOLING |
| **Cooling** | COOLING maintains data collection for 1 more hour for clean position exits |
| **Cooling timeout** | After 6h in COOLING, notify StopLossService but keep tracking |
| **Hysteresis** | ACTIVE market only exits if score < 60% of worst waiting candidate's score. Prevents flip-flop |
| **Budget** | Max 5 rotations per hour under normal conditions |
| **Emergency fill** | If ACTIVE count < 20, disable rotation limit and fill aggressively from WARMING |

### Slot Distribution (40 total)

| Type | Slots | Purpose |
|------|-------|---------|
| ACTIVE | 25-35 | Generate signals |
| WARMING | 3-8 | Entry pipeline |
| COOLING | 0-5 | Graceful exit |
| Reserve | 2 | High-score opportunities |

### Storage

- New column: `tracking_status VARCHAR(10) DEFAULT 'cold'` on `markets` table
  - Values: 'cold', 'warming', 'active', 'cooling'
- Lives inside existing `sync-markets` job — score first, then rotate

---

## Phase 1: Edge Cases

| Edge Case | Solution |
|-----------|----------|
| **Resolution avalanche** (15+ ACTIVE resolve at once) | Emergency fill: if ACTIVE < 20, bypass 5/hour limit |
| **Price drift during WARMING** | Re-evaluate score at promotion time. Drop if below threshold |
| **Flash crash/pump** | SignalEngine already filters extreme prices every 60s. Rotator doesn't need to be reactive |
| **No tradeable markets anywhere** | Accept 0 signals as legitimate. Log "No tradeable markets available (best score: X)" for review system to distinguish from bugs |
| **COOLING position never closes** | 6h timeout. After that, alert StopLossService but maintain tracking |

---

## Phase 2: Feedback Loop

### Architecture

```
Closed trades ──> MarketPerformanceTracker ──> category_performance table
                          │
                          │ every 24h
                          ▼
                    Performance Priors ──> MarketScorer
                          │                (score × prior)
                          │
                    Bootstrap:
                    clean pre-reset trades
                    + manual priors
```

### Category-Level Tracking

Uses existing MarketClassifier. Evaluates categories, not individual markets (too short-lived).

| Category | Example | Initial Prior |
|----------|---------|---------------|
| crypto_intraday | BTC > $90k today | 1.0 |
| crypto_daily | ETH > $4k this week | 1.0 |
| event_short | Arsenal win tomorrow | 1.0 |
| event_long | Netanyahu out by March | 1.0 |
| sports | (new subcategory) | 1.0 |
| politics | (new subcategory) | 1.0 |

### Metrics per Category

Computed from `paper_trades` + `paper_positions`:

| Metric | Formula |
|--------|---------|
| Win rate | winning trades / total trades |
| Avg PnL | mean(realized_pnl) |
| Signal accuracy | signals that predicted correct direction / total signals |
| Sharpe ratio | avg_pnl / stddev_pnl |

### Performance Prior

```
prior = 0.5 + 0.5 × sigmoid(sharpe_ratio × 2)
```

- Very negative Sharpe → prior ≈ 0.5 (penalizes but doesn't kill)
- Neutral Sharpe → prior ≈ 1.0 (no effect)
- Positive Sharpe → prior ≈ 1.5 (boost)

**Bounded to [0.5, 1.5]** — feedback adjusts ±50% of base score, never dominates.

**All parameters (bounds, sigmoid factor) are initial defaults — will be connected to Optuna in Phase 2.5.**

### Clean Data Bootstrap

For pre-reset trades:
```sql
SELECT t.* FROM paper_trades t
JOIN paper_positions p ON t.position_id = p.id
WHERE p.closed_at IS NOT NULL    -- complete lifecycle
  AND p.size = 0                 -- not zombie
  AND t.side IN ('buy','sell')   -- both sides exist
  AND p.realized_pnl IS NOT NULL -- PnL recorded
```

Categories with <5 clean trades fall back to manual priors.

### Storage

- New table: `category_performance` (~6 rows, updated daily)
- Query on existing trade data, no new collection needed
- Prior cached in memory in MarketScorer — zero per-market overhead

---

## Phase 2.5: Parameter Optimization

### Optimizable Parameters (connect to Optuna)

| Parameter | Current Value | Optimize Against |
|-----------|--------------|-----------------|
| Scorer dimension weights | tradeability=0.30, liquidity=0.25, volatility=0.20, ttr=0.15, quality=0.10 | Rate of profitable signals generated |
| Tradeability curve shape | Optimal [0.15-0.40] ∪ [0.60-0.85] | Win rate by price range |
| Volatility penalty threshold | 0 and >0.15 | Signal accuracy by volatility level |
| Optimal TTR range | 7-60 days | PnL by time-to-resolution |
| Rotator hysteresis | 60% of worst candidate | Pool stability vs market quality |
| Feedback prior bounds | [0.5, 1.5] and sigmoid ×2 | Portfolio Sharpe ratio |
| Combiner thresholds | confidence=0.43, strength=0.27 | Already partially in Optuna |
| Bayesian cap floor | 0.15 | Trade quality vs quantity |

### Structural Parameters (NOT optimized — safety/operational)

| Parameter | Value | Reason |
|-----------|-------|--------|
| MAX_TRACKED_MARKETS | 40 | e2-micro RAM constraint |
| Max rotations/hour | 5 | Stability, prevents flip-flop |
| COOLING timeout | 6h | Safety margin for position closing |
| Min bars for promotion | 3 | SignalEngine hard requirement |
| Emergency fill threshold | ACTIVE < 20 | Operational safety |
| WARMING slots | 3-8 | Always need entry pipeline |
| Reserve slots | 2 | Buffer for sudden opportunities |
| Min trades for significance | 5 | Statistical minimum |
| Feedback update frequency | 24h | Data accumulation constraint |

### Implementation

Add scorer/rotator parameters as hyperparameters in the existing Optuna study on Render. The optimizer already runs trials against the DB — extending it to include market selection parameters is a natural fit.

---

## Phase 3: Review System Fix

### Problem

The daily auto-review (scripts/daily-review-prompt.md) uses speculative language ("likely excluding", "may be", "appears to be") instead of investigating. Two days of 0 signals were classified as "expected behavior" without evidence.

### Fix 1: Remove the "easy out"

**Current** (Alert Guidance section):
```
0 signals generated → Info if markets correctly filtered (50/50 range, price-range modifier)
Markets filtered by 50/50 → Expected behavior — not an alert
```

**New**:
```
0 signals generated → MUST investigate before classifying severity.
  Required: Run SQL to check actual price distribution of tracked markets.
  If ALL markets genuinely in 50/50 or extreme range → Info, but report the
  distribution and flag that MarketRotator should have prevented this.
  If markets exist in tradeable range but signals still 0 → Critical.
  NEVER write "likely" or "probably" — show the query and the numbers.
```

### Fix 2: Evidence-first investigation rule

**New section in prompt**:

```
INVESTIGATION RULE: Every anomaly (metric out of range, zero where >0 expected,
discrepancy in numbers) requires at least ONE SQL query or log check before
classifying severity. Report the query result as evidence. Without evidence,
severity is "Unknown — requires manual investigation" with a specific next step.

Examples of adequate investigation:
- 0 signals → check price distribution of tracked markets
- Capital discrepancy → check SUM of closed position PnLs vs account field
- High trade count → check for duplicate trades in same market/minute
- Container restarts → check OOM kill logs
These are examples, not an exhaustive list. Apply the same rigor to any anomaly.
```

### Fix 3: Language rule

**New rule in prompt**:
```
LANGUAGE RULE: Never use "likely", "probably", "may be", "suggests that",
"appears to be" when describing root causes. Either:
1. You investigated and know the cause → state it with evidence
2. You couldn't investigate → say "Unknown — requires manual investigation"
   with a specific next step the human can take
Speculation disguised as analysis is worse than admitting ignorance.
```

---

## Implementation Plan

### Phase 1 (Immediate — unblocks trading)

1. Add `market_score` and `tracking_status` columns to markets table
2. Implement `MarketScorer` class in data-collector with SQL scoring query
3. Implement `MarketRotator` class in data-collector with state machine
4. Wire into existing `sync-markets` scheduler job
5. Update `ClobCollector` queries to use `tracking_status IN ('warming','active','cooling')` instead of raw `LIMIT 40`
6. Deploy, verify markets rotate into tradeable ranges

### Phase 2 (After Phase 1 generates trades)

7. Create `category_performance` table
8. Implement `MarketPerformanceTracker` in dashboard
9. Bootstrap with clean pre-reset trade data
10. Wire performance prior into MarketScorer
11. Add daily update job

### Phase 2.5 (After Phase 2 accumulates data)

12. Add scorer parameters to Optuna study definition
13. Extend optimization trials to include market selection quality
14. Monitor and validate optimized parameters

### Phase 3 (Parallel with Phase 1)

15. Update `scripts/daily-review-prompt.md` with the three fixes
16. Monitor next 3-5 daily reviews for compliance
17. Iterate on prompt if model still takes shortcuts

---

## Constraints

- **Memory**: All computations via SQL queries + small in-memory caches. No new services.
- **CPU**: Scoring runs 1x/hour (~50ms). Rotation runs 1x/hour (~10ms). Negligible.
- **Storage**: 2 new columns on existing table + 1 small table (~6 rows). Negligible.
- **Compatibility**: SignalEngine, AutoSignalExecutor, PositionClosingService unchanged. Only data-collector market selection changes.
