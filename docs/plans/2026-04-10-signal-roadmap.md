# Signal System Roadmap

**Date:** 2026-04-10
**Status:** Active roadmap
**Context:** Current microstructure signals (mean_reversion, OFI, MLOFI, Hawkes) don't produce alpha in prediction markets with realistic execution costs (1-5% slippage). Need information-driven signals.

## Problem

Backtester with realistic execution shows negative returns for all parameter configurations. The signals detect micro-movements (0.1-0.5%) that evaporate with spread + slippage costs. Prediction markets need signals that predict >2% moves to be profitable.

## Signal Types (by priority)

### 1. News/Sentiment Pipeline [NEXT]

**Edge:** Information arrives in news before prediction markets fully price it.

**Sources:**
- Google News RSS (free, unlimited, all categories)
- Finnhub news API (free tier, financial/crypto with pre-computed sentiment)
- Future: additional RSS feeds, Twitter/X API, specialized sources

**Evaluation:** LLM-agnostic (Anthropic Haiku initially, future: GLM, open-source). Pre-filter with entity matching to reduce LLM costs.

**Market types:** All — sports, politics, crypto, culture.

**Implementation phases:**
- Phase 1: Collector + Finnhub sentiment (crypto) + Google News RSS + simple sentiment (non-crypto) + signal store + SignalEngine integration
- Phase 2: Entity-based pre-filter + LLM evaluation (Haiku batch) + relevance scoring + directional impact

### 2. Probability Models

**Edge:** Build independent probability estimates and trade when market price diverges from model.

**Models by category:**
- Sports: ELO/Glicko ratings, historical matchup data, injury reports
- Politics: Polling aggregation, historical base rates, incumbency models
- Crypto: On-chain metrics, correlation with BTC/ETH, funding rates

**Market types:** Category-specific. Each model applies to its category.

### 3. Cross-Market Arbitrage

**Edge:** Logical inconsistencies between related markets.

**Examples:**
- "X wins championship" > "X wins next match" (must hold)
- Sum of exclusive outcomes > 100% (overround)
- Conditional probabilities that violate Bayes

**Market types:** Any markets with logical relationships.

### 4. On-Chain / Whale Signals

**Edge:** Large players have information. Follow smart money.

**Sources:**
- Polymarket wallet tracking (public blockchain)
- Large order detection in CLOB
- New wallet activity correlated with outcomes

**Market types:** All Polymarket markets.

### 5. Microstructure (Recalibrated)

**Edge:** Current signals (OFI, MLOFI, Hawkes, mean_reversion) may work for high-liquidity crypto markets with tight spreads.

**Condition:** Only activate for markets where spread < 1% and daily volume > $50K. Currently no such markets are active.

**Market types:** Crypto only (when available via market rotation).

## Per-Market-Type Signal Routing

The `WeightedAverageCombiner` already supports per-type weights and per-type direction multipliers. Each market type should use signals appropriate for it:

| Market Type | Primary Signals | Secondary Signals |
|---|---|---|
| event_short (resolves <7d) | News/sentiment, cross-market | Probability model |
| event_long (resolves >7d) | Probability model, news/sentiment | Cross-market |
| crypto_intraday | Microstructure (if liquid), news/sentiment | On-chain/whale |
| crypto_daily | News/sentiment, on-chain/whale | Probability model |

## Architecture Principle

All signals implement `ISignal` interface via `BaseSignal`. New signal types plug into `SignalEngine` without changing the combiner or executor. Data pipelines (news collector, on-chain monitor) run independently and store results in DB tables that signal generators read.

## LLM Provider Agnosticism

All LLM-dependent components use an `LLMProvider` interface. Initial implementation: Anthropic (Haiku for evaluation, Sonnet for complex analysis). Future: swap to GLM, Llama, Mistral via env var `LLM_PROVIDER`.
