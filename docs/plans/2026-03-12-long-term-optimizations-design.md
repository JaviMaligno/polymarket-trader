# Long-Term Optimizations Design

**Date**: 2026-03-12
**Source**: Issue #14 (remaining items after PRs #15, #16)
**Status**: Design approved

## Overview

Three optimizations for the Polymarket trading system:

1. **CPU Safeguards** — Daily review CPU alerts + adaptive sync frequency in data-collector
2. **Signal-Duration Intelligence** — Adapt signal generation to market time horizon, including new external data signals for long-duration markets
3. **Optimization Duration Fix** — Compute `duration_seconds` on completion in all code paths

## Scope

### In Scope

- Fix `end_date_iso` → `end_date` bug in AutoSignalExecutor
- Signal-duration compatibility matrix with weight multipliers per duration band
- 3 new market-structure signal generators (volume anomaly, spread compression, cross-market correlation)
- 3 new external-data signal generators (price divergence, attention spike, news sentiment)
- External data ingestion from free sources (Metaculus, Manifold, Google Trends, GNews)
- Haiku-powered cross-platform market matching
- Adaptive sync frequency with event loop lag monitoring and job overlap detection
- CPU alerts in daily review
- Optimization duration_seconds bug fix

### Out of Scope

- Paid data APIs (Twitter/X, Nansen)
- Real-time streaming (all external fetches are periodic)
- ML models on-VM
- Polling aggregator scraping (legal grey area)
- Default hold time for long-duration positions (only if memory becomes a problem)

---

## Architecture — External Data Ingestion

New component in data-collector: `ExternalDataCollector` service that periodically fetches from free external sources and stores normalized data.

```
data-collector/
├── collectors/
│   ├── GammaCollector.ts        (existing)
│   ├── ClobCollector.ts         (existing)
│   ├── ExternalDataCollector.ts (NEW - orchestrates all external fetches)
│   ├── sources/
│   │   ├── MetaculusSource.ts   (NEW)
│   │   ├── ManifoldSource.ts    (NEW)
│   │   ├── GoogleTrendsSource.ts(NEW)
│   │   └── NewsSource.ts        (NEW)
│   └── MarketMatcher.ts         (NEW - Haiku-powered cross-platform matching)
```

### Data Flow

1. `ExternalDataCollector` runs on hourly cron (not 5min — external sources don't update that fast, free tiers have rate limits)
2. Each source adapter fetches data → normalizes to a common `ExternalSignalData` shape
3. Stored in `external_signals` table (market_id, source, signal_type, value, confidence, fetched_at)
4. `MarketMatcher` runs daily — fetches questions from Metaculus/Manifold APIs, uses Haiku to match against Polymarket long-duration markets, stores mappings in `market_crossref` table

### New DB Tables

```sql
-- Cross-platform market mappings
CREATE TABLE market_crossref (
  polymarket_id VARCHAR(128) REFERENCES markets(id),
  platform VARCHAR(50),        -- 'metaculus', 'manifold'
  external_id VARCHAR(255),
  external_question TEXT,
  match_confidence FLOAT,      -- Haiku's confidence in the match
  matched_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (polymarket_id, platform)
);

-- External signal data
CREATE TABLE external_signals (
  id SERIAL PRIMARY KEY,
  market_id VARCHAR(128) REFERENCES markets(id),
  source VARCHAR(50),          -- 'metaculus', 'manifold', 'google_trends', 'news'
  signal_type VARCHAR(50),     -- 'price_divergence', 'attention_spike', 'sentiment'
  value FLOAT,
  metadata JSONB,
  fetched_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Memory Budget

ExternalDataCollector is lightweight (HTTP fetches + JSON parsing). Runs hourly, not continuous. Estimated +5-10MB peak during fetches, well within the data-collector's 120MB limit.

---

## Signal-Duration Compatibility Matrix

### Duration Bands

| Band | Resolution | Description |
|------|-----------|-------------|
| **immediate** | < 7 days | Short-term, all current signals effective |
| **short** | 7 - 30 days | Most signals work, momentum starts losing edge |
| **medium** | 30 - 90 days | Price-pattern signals unreliable, flow/structure signals still useful |
| **long** | > 90 days | Only event-driven and external signals meaningful |

### Weight Multiplier Matrix

| Signal | immediate | short | medium | long |
|--------|-----------|-------|--------|------|
| **momentum** | 1.0 | 0.5 | 0 | 0 |
| **mean_reversion** | 1.0 | 1.0 | 0.3 | 0 |
| **OFI** | 1.0 | 1.0 | 1.0 | 0.5 |
| **MLOFI** | 1.0 | 1.0 | 1.0 | 0.5 |
| **Hawkes** | 1.0 | 1.0 | 1.0 | 1.0 |
| **volume_anomaly** (new) | 0.3 | 0.7 | 1.0 | 1.0 |
| **spread_compression** (new) | 0.3 | 0.7 | 1.0 | 1.0 |
| **cross_market_corr** (new) | 0 | 0.5 | 1.0 | 1.0 |
| **price_divergence** (new) | 0 | 0 | 0.8 | 1.0 |
| **attention_spike** (new) | 0 | 0.3 | 0.8 | 1.0 |
| **news_sentiment** (new) | 0 | 0.3 | 0.8 | 1.0 |

Values are **weight multipliers** applied to each signal's output before combination. 0 = signal is not run for that band.

Applied in `WeightedAverageCombiner` — each signal's weight gets multiplied by its duration factor before normalization.

Markets with `end_date = NULL` default to **short** band (conservative — assumes weeks, not months).

### Implementation

New `DurationWeightModifier` in SignalEngine that:
1. Reads `end_date` from the market
2. Computes duration band
3. Looks up the multiplier matrix (stored as config, not hardcoded — allows tuning via optimizer later)
4. Passes modified weights to the combiner

---

## New Signal Generators — Market Structure (existing data)

### 1. VolumeAnomalyGenerator

- Computes rolling 7-day mean and stddev of daily volume per market
- Fires when current volume > mean + 2σ
- Strength proportional to z-score (2σ = 0.5, 3σ = 0.8, 4σ+ = 1.0)
- Direction: LONG if price rising with volume, SHORT if falling
- Data source: `price_history` (already collected)

### 2. SpreadCompressionGenerator

- Monitors bid-ask spread from `order_books` table
- Fires when spread compresses to <50% of its 7-day rolling average
- Indicates informed traders entering with conviction
- Direction: inferred from which side (bid vs ask) has more depth
- Data source: `order_books` (already collected every 10min)

### 3. CrossMarketCorrelationGenerator

- Groups markets by event (e.g., all "X wins World Cup" markets)
- When one market moves significantly, checks if correlated markets have followed
- If not → generates signal for the lagging market (momentum contagion)
- Uses `events` table to identify related markets
- Data source: `price_history` + `events` (already collected)

---

## New Signal Generators — External Data

### 4. PriceDivergenceGenerator

- Compares Polymarket price against matched platforms (Metaculus, Manifold) via `market_crossref` + `external_signals`
- Fires when divergence > 5 percentage points (e.g., Polymarket 15%, Metaculus 22%)
- Strength proportional to divergence magnitude (5pp = 0.4, 10pp = 0.7, 20pp+ = 1.0)
- Direction: LONG if Polymarket price is lower than consensus, SHORT if higher
- Confidence scaled by `match_confidence` from Haiku matching — a 0.7 match confidence caps signal confidence at 0.7
- Fetch frequency: hourly

### 5. AttentionSpikeGenerator

- Uses Google Trends API to track search interest for keywords extracted from market questions
- Baseline: 30-day rolling average of search interest
- Fires when current interest > 2× baseline
- Strength proportional to spike magnitude (2× = 0.4, 5× = 0.7, 10×+ = 1.0)
- Direction: Does NOT determine direction alone — acts as a **confidence multiplier** (1.0-1.5×) on other signals firing for the same market
- Fetch frequency: every 4 hours (Google Trends unofficial API has aggressive rate limits)
- Keyword extraction: split market question, remove stop words, use top 2-3 entities
- Keyword rotation when rate-limited: prioritize markets with active signals or recent price movement

### 6. NewsSentimentGenerator

- Fetches headlines from GNews API (free tier: 100 req/day) matching market keywords
- Scores sentiment per headline using simple keyword-based approach (no LLM — save Haiku budget for matching):
  - Positive words (wins, passes, approved, rises, confirms) → +1
  - Negative words (loses, fails, rejected, falls, denies) → -1
  - Aggregate across headlines, normalize to [-1, 1]
- Fires when |sentiment| > 0.3 and headline count > 2 (avoids single-article noise)
- Direction: LONG if positive sentiment, SHORT if negative
- Strength: |sentiment_score| × min(headline_count / 5, 1.0)
- Fetch frequency: every 2 hours (fits within 100 req/day budget with batched keyword queries)

### Rate Limit Budget (daily)

| Source | Free limit | Our usage | Headroom |
|--------|-----------|-----------|----------|
| Metaculus | No published limit | ~40 req/hr = 960/day | Generous |
| Manifold | 1000/10min | ~40 req/hr = 960/day | Generous |
| Google Trends | ~50-100/day (unofficial) | 6 fetches × 10 keyword batches = 60/day | Tight — keyword rotation when needed |
| GNews | 100 req/day | ~50 req/day (batch queries) | 50% headroom |
| Haiku (matching) | Pay per token | ~40 markets × 5 candidates = 200 calls/day ≈ $0.02/day | Negligible cost |

### Degradation Strategy

If any external source returns 429/errors, that source's signals are simply absent for that cycle — no crash, no retry storm. The combiner works with whatever signals are available.

---

## Signal Pipeline Integration

### Current Flow

```
SignalEngine.computeSignals() → [5 generators] → WeightedAverageCombiner → AutoSignalExecutor
```

### New Flow

```
SignalEngine.computeSignals()
  → [5 existing generators]
  → [3 new market-structure generators]
  → [3 new external-data generators (read from external_signals table)]
  → DurationWeightModifier (applies matrix multipliers per market)
  → WeightedAverageCombiner
  → AutoSignalExecutor
```

External generators don't fetch live — they read from `external_signals` table populated by `ExternalDataCollector` on its own schedule. This keeps signal computation fast (~seconds) and decouples it from external API latency.

### Market Matching (Haiku)

- Runs daily as a batch job in `ExternalDataCollector`
- Fetches questions from Metaculus/Manifold APIs for long-duration markets
- Sends each candidate pair to Haiku: "Are these the same prediction?"
- Stores confirmed matches in `market_crossref` with confidence score
- ~200 Haiku calls/day ≈ $0.02/day

---

## CPU Safeguards

### A) Daily Review CPU Alerts

Add to `scripts/daily-review.sh` a new section:
- ⚠️ Warning: any container > 70% CPU
- 🔴 Critical: any container > 90% CPU
- 🔴 Critical: TimescaleDB > 300% CPU

Integrates into existing GitHub Issue / Gmail / Slack pipeline.

### B) Adaptive Sync Frequency

New `AdaptiveSyncManager` wrapping the existing `Scheduler`.

#### Job Overlap Detection (immediate protection)

- Before starting a job, check `isRunning` flag (already exists per job)
- If previous instance still running → skip, log warning, increment `skipped_count`
- If `skipped_count` for a job reaches 3 consecutive skips → trigger interval stretch

#### Event Loop Lag Monitoring (gradual adaptation)

- Sample `perf_hooks.monitorEventLoopDelay()` every 10 seconds
- Track rolling 1-minute average
- Thresholds:
  - lag > 500ms sustained for 3 checks → double all sync intervals
  - lag > 1000ms → triple intervals + log critical alert
  - lag < 200ms for 5 minutes → restore original intervals
  - Minimum interval floor: original value (never faster than configured)
  - Maximum interval ceiling: 4× original (never slower than 20min for prices)

#### State Machine

```
NORMAL (5min/10min)
  → lag>500ms×3 or 3 consecutive skips → DEGRADED (10min/20min)
  → lag>1000ms → CRITICAL (15min/30min)
  → lag<200ms for 5min → NORMAL
```

Every state transition logs to stdout (picked up by `docker logs`). Daily review script can grep for these transitions.

Memory impact: negligible — one histogram object + a few counters.

---

## Bug Fixes

### end_date_iso → end_date (AutoSignalExecutor)

`packages/dashboard/src/services/AutoSignalExecutor.ts` line 154:

```sql
-- Current (broken — column doesn't exist):
SELECT is_active, is_resolved, end_date_iso FROM markets WHERE id = $1

-- Fixed:
SELECT is_active, is_resolved, end_date FROM markets WHERE id = $1
```

This silently broke the near-resolution protection (block mean_reversion, require 0.65 confidence, half position size for markets <24h from resolution).

### Optimization duration_seconds

**StrategyOptimizer** (`packages/optimizer/src/core/StrategyOptimizer.ts` ~line 370):
```sql
UPDATE optimization_runs SET status='completed', completed_at=NOW(),
  duration_seconds=EXTRACT(EPOCH FROM (NOW() - started_at)), ...
WHERE id = $4
```

**OptimizationStore** (`packages/optimizer/src/storage/OptimizationStore.ts`):
```typescript
if (['completed', 'failed', 'cancelled'].includes(updates.status)) {
  fields.push(`completed_at = NOW()`);
  fields.push(`duration_seconds = EXTRACT(EPOCH FROM (NOW() - started_at))`);
}
```

**OptimizationScheduler** (`packages/dashboard/src/services/OptimizationScheduler.ts`):
- Remove JS-side `durationSeconds` calculation
- Let DB compute: `duration_seconds = EXTRACT(EPOCH FROM (completed_at - started_at))`
- Pass actual optimization start time, not `new Date()` at save time

---

## Implementation Phases

### Phase 1 — Bug fixes & quick wins (standalone)

1. Fix `end_date_iso` → `end_date` in AutoSignalExecutor
2. Fix `duration_seconds` in all 3 optimizer code paths
3. Add CPU alert section to `daily-review.sh`

### Phase 2 — Adaptive sync (data-collector only)

4. `AdaptiveSyncManager` — event loop lag monitoring + job overlap skip logic
5. State machine (NORMAL → DEGRADED → CRITICAL → NORMAL)
6. Logging integration for daily review grep

### Phase 3 — Duration weight system (dashboard, no new data needed)

7. `DurationWeightModifier` — reads `end_date`, computes band, applies matrix multipliers
8. Wire into `SignalEngine.computeSignals()` before combiner
9. Config-driven matrix (stored in DB or JSON, tunable by optimizer later)

### Phase 4 — New market-structure signals (dashboard, existing data)

10. `VolumeAnomalyGenerator` — price_history rolling stats
11. `SpreadCompressionGenerator` — order_books spread analysis
12. `CrossMarketCorrelationGenerator` — events table grouping
13. Register all 3 in SignalEngine, add to combiner weights

### Phase 5 — External data infrastructure (data-collector)

14. `external_signals` and `market_crossref` DB tables
15. `ExternalDataCollector` service + hourly cron
16. `MarketMatcher` — Haiku-powered daily cross-platform matching
17. Source adapters: `MetaculusSource`, `ManifoldSource`

### Phase 6 — External data signals (data-collector + dashboard)

18. `GoogleTrendsSource` with keyword rotation
19. `NewsSource` (GNews) with budget management
20. `PriceDivergenceGenerator` — reads market_crossref + external_signals
21. `AttentionSpikeGenerator` — confidence multiplier mode
22. `NewsSentimentGenerator` — keyword sentiment scoring
23. Register all 3 in SignalEngine

### Phase Dependencies

```
Phase 1 ─── standalone
Phase 2 ─── standalone
Phase 3 ─── standalone (benefits from Phase 1 end_date fix)
Phase 4 ─── after Phase 3 (needs duration weights to avoid noise)
Phase 5 ─── standalone (infra only, no signal impact)
Phase 6 ─── after Phase 4 + Phase 5
```

Phases 1, 2, 3, and 5 can run in parallel. Phase 4 needs 3. Phase 6 needs 4+5.

### Estimated Scope

- ~15 new files
- ~5 modified files
- No changes to data-collector's core collection logic — only additions
