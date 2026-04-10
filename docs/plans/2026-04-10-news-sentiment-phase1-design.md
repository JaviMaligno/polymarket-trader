# Design: News/Sentiment Signal Pipeline — Phase 1

**Date:** 2026-04-10
**Status:** Approved
**Context:** Microstructure signals don't produce alpha with realistic execution costs. Information-driven signals needed. This is the first signal type in the roadmap (`docs/plans/2026-04-10-signal-roadmap.md`).

## Problem

Current signal generators (mean_reversion, OFI, MLOFI, Hawkes, momentum) detect micro-price-movements of 0.1-0.5% that evaporate with 1-5% execution costs in Polymarket. The system needs signals that predict moves >2%, driven by real-world information (news, events, results).

## Phase 1 Scope

Build the news ingestion pipeline, simple sentiment scoring, entity-based market matching, and integration with SignalEngine. No LLM evaluation — that's Phase 2.

**Sources:**
- Google News RSS (free, unlimited, all categories: sports, world, business, technology, entertainment)
- Finnhub news API (free tier, 60 calls/min, financial/crypto news with pre-computed sentiment)

**Out of scope (Phase 2):**
- LLM evaluation of article relevance/impact
- Entity-based pre-filter for LLM cost reduction
- Advanced directional analysis

## Architecture

```
[Google News RSS] ──15min──→ [NewsCollector] → [Dedup] → [Entity Matcher] → [news_market_signals]
[Finnhub API]    ──15min──→      ↓                              ↓
                          [news_articles]              [NewsSentimentGenerator]
                                                              ↓
                                                        [SignalEngine]
```

### NewsCollector

Runs inside the existing `data-collector` service (not a new container). Adds ~20MB memory overhead.

**Polling:** Every 15 minutes, uniform for all categories. Analysis only runs when new articles are found (dedup by URL).

**Google News RSS poller:**
- Parses RSS feeds by category: sports, world, business, technology, entertainment
- Extracts: title, url, published date, category
- Rate limit: max 1 request/minute per category (conservative, no documented limit)

**Finnhub news poller:**
- Fetches general + crypto news categories
- Extracts: title, url, published date, sentiment score (pre-computed by Finnhub), category
- Rate limit: 60 calls/min free tier, uses ~4 calls/hour

**Dedup:** By URL. If article already in `news_articles`, skip all processing.

### Sentiment Scoring

**Finnhub articles:** Use pre-computed sentiment score directly (already normalized).

**Google News RSS articles:** Use AFINN-165 lexicon via npm package `afinn-165` (~50KB, zero dependencies). Scores words -5 to +5, normalize to [-1, +1]. Simple but functional for clear headlines ("X wins", "Y eliminated", "Z injured").

### Entity Extraction & Market Matching

**Library:** `wink-nlp` (~10KB minified, 650K tokens/sec, NER included, zero external dependencies).

**Entity extraction from `market.question`:** Run NER on each active market's question. Extract named entities (people, organizations, locations) + event keywords. Cache in memory — questions don't change frequently. Refresh when `activeMarkets` list changes.

**Matching:**
For each new article, compare extracted entities against all active market entity sets.

Relevance score = proportion of market entities found in headline:
- 0 entities → skip (not relevant)
- 1 entity → relevance 0.3
- 2+ entities → relevance 0.7+

**Direction logic:**
- `sentiment > 0` + headline contains market subject → LONG (good for YES outcome)
- `sentiment < 0` + headline contains market subject → SHORT (bad for YES outcome)
- Headline contains a known competitor (from other markets in same event) with positive sentiment → SHORT

Competitor detection: if multiple markets share the same event context (e.g., "Will Arsenal win CL?" and "Will PSG win CL?"), each market's subject is a competitor of the others.

### Signal Store

**`news_articles` table (hypertable):**
```sql
time TIMESTAMPTZ NOT NULL,
source VARCHAR(50) NOT NULL,        -- 'google_rss', 'finnhub'
title TEXT NOT NULL,
url TEXT NOT NULL UNIQUE,
category VARCHAR(50),               -- 'sports', 'business', 'crypto', 'politics', 'general'
raw_sentiment DECIMAL(5,4),         -- AFINN score or Finnhub score, normalized to [-1, +1]
language VARCHAR(10) DEFAULT 'en',
metadata JSONB DEFAULT '{}'
```

**`news_market_signals` table (hypertable):**
```sql
time TIMESTAMPTZ NOT NULL,
article_url TEXT NOT NULL,
market_id VARCHAR(128) NOT NULL,
relevance_score DECIMAL(5,4),       -- 0-1
direction VARCHAR(8),               -- 'LONG', 'SHORT', 'NEUTRAL'
impact_score DECIMAL(5,4),          -- 0-1, derived from sentiment magnitude
signal_strength DECIMAL(5,4),       -- relevance * impact * |sentiment|
match_method VARCHAR(20)            -- 'entity_match', 'finnhub_direct'
```

Retention: 7 days for `news_articles`, 30 days for `news_market_signals`.

### SignalEngine Integration

The existing `NewsSentimentGenerator` (`packages/signals/src/signals/external/NewsSentimentGenerator.ts`) currently reads from `context.custom.newsSentiment`. Change it to query `news_market_signals` directly for the given market, returning the most recent signal within a configurable window (default: 1 hour).

The generator is already registered in SignalEngine but listed as "inactive" (skipped in weight sync). Activate it by ensuring it has a weight in `signal_weights` table.

## Resource Constraints (e2-micro, 1GB RAM)

| Component | Memory | CPU |
|---|---|---|
| wink-nlp | ~10MB | Negligible (650K tokens/sec) |
| AFINN lexicon | ~1MB | Negligible |
| RSS parsing | Negligible | Negligible |
| Entity cache | ~1MB (35 markets) | Refresh on market change |
| Total overhead | ~20MB | Minimal |

Current data-collector: 120MB. After: ~140MB. Within 150MB container limit.

## What Does NOT Change

- SignalEngine architecture (combiner, executor, position management)
- WeightedAverageCombiner (news_sentiment is just another signal with a weight)
- Market rotation (MarketRotator decides what markets are active)
- Other signal generators (OFI, MLOFI, Hawkes continue running)
- Optimizer (can optimize news_sentiment weight like any other)

## Testing Strategy

Each component is independently testable:

1. **RSS parser:** Mock RSS XML → verify articles extracted correctly
2. **Finnhub poller:** Mock API response → verify sentiment scores mapped
3. **AFINN scorer:** Known headlines → expected sentiment scores
4. **Entity extractor:** Known market questions → expected entities
5. **Market matcher:** Known articles + known entities → expected relevance + direction
6. **NewsSentimentGenerator:** Mock `news_market_signals` rows → expected signal output
7. **Integration:** End-to-end with mock news source → verify signal reaches SignalEngine

## Success Criteria

1. `news_articles` populated with articles from Google News RSS and Finnhub
2. `news_market_signals` populated with market-matched signals
3. `NewsSentimentGenerator` produces non-null signals for markets with relevant news
4. No increase in container memory beyond 150MB for data-collector
5. Zero impact on existing signal pipeline performance
