# Adaptive Market Expansion Design

## Problem

The signal engine processes only ~3-4 markets because:
1. `price_history` only has data for markets with recent CLOB trading activity
2. Dashboard and data-collector use different market selection criteria
3. Fixed price filters (5%-95%) exclude liquid crypto intraday markets
4. Fixed signal weights don't account for different market dynamics

## Solution

Expand market coverage with adaptive classification, dynamic filtering, Bayesian confidence scaling, and per-type signal weights.

## 1. Market Classification via Claude Haiku

New service: `MarketClassifier.ts`

Calls Claude Haiku to classify markets into 4 types based on question text and end_date:

| Type | Description | Example |
|------|-------------|---------|
| `crypto_intraday` | Crypto + resolves < 4h | "Bitcoin Up or Down 12:30-12:35PM" |
| `crypto_daily` | Crypto + resolves 4h-7d | "Will Bitcoin reach $70k on March 9?" |
| `event_short` | Non-crypto + resolves < 30d | "US strikes Iran by March 15?" |
| `event_long` | Non-crypto + resolves >= 30d | "Will Newsom win 2028 primary?" |

Implementation:
- Batch job every 30min: classifies markets where `market_type IS NULL`
- Caches in DB column `markets.market_type VARCHAR(20)`
- ~5-10 new markets/day, ~100 tokens each = ~$0.001/day
- Until classified, market uses `event_short` defaults (most conservative)

Haiku prompt:
```
Classify this prediction market into exactly one category.
Categories: crypto_intraday, crypto_daily, event_short, event_long

Market: "{question}"
End date: {end_date}

Rules:
- crypto_intraday: cryptocurrency price markets resolving within 4 hours
- crypto_daily: cryptocurrency markets resolving in 4 hours to 7 days
- event_short: non-crypto events resolving within 30 days
- event_long: non-crypto events resolving in 30+ days

Respond with ONLY the category name, nothing else.
```

## 2. Dynamic Price Filters by Market Type

Each type has its own price range for market selection:

| Type | Min Price | Max Price |
|------|-----------|-----------|
| `crypto_intraday` | 0.02 | 0.98 |
| `crypto_daily` | 0.03 | 0.97 |
| `event_short` | 0.05 | 0.95 |
| `event_long` | 0.08 | 0.92 |
| Unclassified (NULL) | 0.05 | 0.95 |

All 8 parameters (min/max x 4 types) are optimizable by Optuna.

Implementation in `PolymarketService.discoverMarkets()`:
- Replace single WHERE clause with type-aware filtering
- Markets without `market_type` use conservative defaults

## 3. Bayesian Confidence Scaling (Beta-Binomial)

Model signal reliability as unknown probability theta with Beta prior.

### Formula

```
alpha = alpha0 + informativeBars
beta = beta0 + (totalBars - informativeBars)
posteriorVar = (alpha * beta) / ((alpha + beta)^2 * (alpha + beta + 1))
priorVar = (alpha0 * beta0) / ((alpha0 + beta0)^2 * (alpha0 + beta0 + 1))
confidenceCap = 1 - (posteriorVar / priorVar)
```

Where:
- `alpha0 = 1, beta0 = 1` (uniform prior, default)
- `informativeBars` = bars where price changed vs previous bar
- `totalBars` = total bars available

### Properties

- 0 bars -> cap 0% (no data, no confidence)
- 3 informative bars -> ~57%
- 10 informative bars -> ~83%
- 30 informative bars -> ~94%
- Asymptotic to 100% (never fully certain -- Bayesian correct)
- Quality-aware: 20 flat bars (same price) contribute less than 20 varying bars

### Minimum bars

Absolute minimum: 3 bars (required for any signal computation).

### Optimizable parameters

- `alpha0, beta0`: prior shape. Optuna can adjust if markets are generally reliable.
- No artificial `fullConfidenceBars` -- curve emerges from the model.

### Application

Applied in `SignalEngine.buildCombinedSignal()` after combining all signals:
```typescript
combinedSignal.confidence *= confidenceCap;
```

## 4. Signal Weights by Market Type

Different signals have different value depending on market dynamics.

Default weights (all optimizable by Optuna):

| Signal | crypto_intraday | crypto_daily | event_short | event_long |
|--------|----------------|--------------|-------------|------------|
| momentum | 0.3 | 0.4 | 0.5 | 0.5 |
| mean_reversion | 0.1 | 0.3 | 0.5 | 0.5 |
| OFI | 0.5 | 0.4 | 0.2 | 0.1 |
| MLOFI | 0.5 | 0.4 | 0.2 | 0.1 |
| Hawkes | 0.4 | 0.3 | 0.2 | 0.1 |

Rationale:
- Crypto intraday: microstructure signals (OFI/MLOFI/Hawkes) dominate -- many trades/minute
- Event long: momentum/mean_reversion dominate -- moves are information-driven

Implementation: `WeightedAverageCombiner` receives `marketType` parameter and selects weight set accordingly.

Total optimizable parameters: 5 signals x 4 types = 20 weights.

## 5. Market Entry Flow

```
Market appears in Gamma API
  -> sync-markets inserts into DB (market_type = NULL)
  -> Classifier job (every 30min) calls Haiku -> market_type set
  -> sync-price-history collects bars (every 5min)
  -> discoverMarkets(): requires >= 3 bars + market_type != NULL
  -> Price filter applied based on market_type
  -> SignalEngine generates signals with Bayesian confidence cap
  -> As informative bars accumulate, confidence rises organically
  -> Optuna optimizes: weights per type, price filters, prior params
```

## Files Changed

### New files
- `packages/dashboard/src/services/MarketClassifier.ts`

### Modified files
| File | Change |
|------|--------|
| `001_schema.sql` | Add `market_type VARCHAR(20)` to markets |
| `PolymarketService.ts` | Dynamic price filters by type, relax minPriceBars to 3 |
| `SignalEngine.ts` | Bayesian confidence cap, count informativeBars |
| `WeightedAverageCombiner.ts` | Weights indexed by market_type |
| `optimization.ts` | New params: price filters x4, alpha0/beta0, weights x4 |
| `docker-compose.gcp.yml` | Add ANTHROPIC_API_KEY env var |

### No changes needed
- StopLossService, AutoSignalExecutor (already fixed for SHORT token pricing)
- Data-collector collectors (already collect data, only market selection changes)

## Implementation Order

1. ALTER TABLE markets ADD market_type (+ schema SQL)
2. MarketClassifier.ts with Haiku
3. Dynamic price filters in PolymarketService
4. Bayesian confidence cap in SignalEngine
5. Per-type weights in WeightedAverageCombiner
6. New parameters in optimizer

## Cost

- Haiku API: ~$0.001/day (5-10 classifications/day)
- RAM: ~0 extra (HTTP call, no local model)
- CPU: negligible
