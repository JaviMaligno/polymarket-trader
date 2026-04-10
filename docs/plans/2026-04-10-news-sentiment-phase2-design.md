# Design: News/Sentiment Pipeline Phase 2 — LLM Evaluation + Refinements

**Date:** 2026-04-10
**Status:** Approved
**Context:** Phase 1 deployed. Pipeline ingests ~280 articles/cycle, produces 1311 signals, but most are false positives from generic entity matches. Phase 2 adds LLM evaluation and fixes Phase 1 quality issues.

## Problem

Phase 1 entity matching is too liberal: generic entities ("US", "March", "World") match almost every headline to 4-5 markets, and many signals have zero sentiment (no directional information). The pipeline needs precision filtering + LLM evaluation for accurate directional signals.

## Scope

1. **Refine entity matcher** — filter generic entities, minimum length, neutral sentiment filter
2. **LLM evaluation** — Haiku evaluates pre-filtered headlines against markets via structured output (tool_use)
3. **LLM-agnostic interface** — swap provider by env var
4. **Error handling** — graceful degradation to AFINN-only on LLM failure
5. **Finnhub activation** — configure API key for crypto/financial news
6. **Budget control** — daily token spend limit

## Architecture

```
[NewsCollector.collect()]
  → [Entity Matcher (refined)] → relevance > 0, entity >= 4 chars
    → |sentiment| >= 0.05 → [LLM Evaluator batch] → structured output → [external_signals]
    → |sentiment| < 0.05 → discard (no directional information)
    → LLM failure → [AFINN fallback, confidence * 0.5] → [external_signals]
```

## Entity Matcher Refinements

Four changes to reduce false positives:

**1. Entity stoplist:** Filter entities that are too generic to be useful:
- Length <= 2 characters ("US", "UK")
- Month names ("March", "April", "June")
- Common words that wink-nlp extracts as entities ("World", "Game", "Time", "First", "New")

**2. Minimum entity length:** At least one matched entity must have >= 4 characters for the match to count.

**3. Neutral signal filter:** Don't write to `external_signals` when `|sentiment| < 0.05`. No directional information = noise.

**4. Minimum relevance for LLM:** Only send to LLM headlines with `relevance >= 0.3` (at least 1 meaningful entity matched).

Expected reduction: ~1300 signals/cycle → ~50-100 relevant, ~10-20 sent to LLM.

## LLM Provider Interface

```typescript
interface HeadlineEvaluation {
  headlineId: string;
  marketId: string;
  direction: 'LONG' | 'SHORT';
  impact: number;      // 0-1
  reasoning?: string;
}

interface LLMProvider {
  evaluateHeadlines(headlines: Headline[], markets: Market[]): Promise<HeadlineEvaluation[]>;
  getName(): string;
  isAvailable(): boolean;
}
```

Each provider implements structured output internally:
- `AnthropicProvider`: tool_use with JSON schema
- Future `GLMProvider`, `OllamaProvider`: function_calling or JSON mode

Selected by env var `LLM_PROVIDER` (default: `anthropic`).

## LLM Evaluation (AnthropicProvider)

**Model:** claude-haiku-4-5 (cheapest, fastest)

**Input:** Batch prompt with pre-filtered headlines + active markets (question + current price).

**Output:** Structured via tool_use:
```json
{
  "matches": [
    {
      "headline_id": "A",
      "market_id": "1569627",
      "direction": "SHORT",
      "impact": 0.8,
      "reasoning": "direct elimination from tournament"
    }
  ]
}
```

Tool schema enforces valid JSON with required fields. No parsing needed.

**Signal writing:** For each LLM match:
- `value = impact * (direction == 'LONG' ? 1 : -1)`
- `confidence = impact * 0.8` (LLM evaluation is higher quality than AFINN)
- `metadata.match_method = 'llm_eval'`

For AFINN-only fallback:
- `confidence = relevanceScore * min(1, |sentiment| + 0.3) * 0.5` (halved)
- `metadata.match_method = 'afinn_fallback'`

## Error Handling

| Error | Handling |
|---|---|
| LLM API timeout | Retry 1x with 5s backoff. If fails, AFINN fallback |
| LLM rate limit (429) | Exponential backoff (5s, 15s, 45s). After 3 attempts, AFINN fallback |
| LLM response malformed | Should not happen with structured output. If it does, log + discard headline |
| LLM provider down (3 consecutive failures in cycle) | Disable LLM for 1 hour, AFINN-only mode. Log warning |
| Daily budget exceeded | AFINN-only until midnight UTC reset |
| Entity matcher returns 0 candidates | Skip LLM call, log, return 0 signals |

**Principle:** Pipeline never stops due to LLM failure. AFINN is the degraded but functional fallback.

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `LLM_PROVIDER` | `anthropic` | LLM provider for evaluation |
| `ANTHROPIC_API_KEY` | (exists in .env) | Haiku API key |
| `LLM_DAILY_BUDGET_USD` | `1.0` | Max daily LLM spend. AFINN-only when exceeded |
| `FINNHUB_API_KEY` | (empty) | Finnhub news API key |
| `NEWS_MIN_ENTITY_LENGTH` | `4` | Min chars for entity to count as match |
| `NEWS_MIN_SENTIMENT` | `0.05` | Min |sentiment| to write signal |

**Budget tracking and enforcement:**

The `LLMProvider` wraps a `BudgetTracker` that controls when LLM calls are allowed:

```
class BudgetTracker {
  private spentUSD: number = 0;
  private lastResetDate: string = '';
  private limitUSD: number;  // from LLM_DAILY_BUDGET_USD

  canSpend(): boolean  // returns false if spentUSD >= limitUSD
  record(inputTokens: number, outputTokens: number): void  // adds cost to spentUSD
  resetIfNewDay(): void  // resets spentUSD to 0 at midnight UTC
}
```

**Where it's checked:** In `NewsCollector.collect()`, before calling `llmProvider.evaluateHeadlines()`:
1. Call `budgetTracker.resetIfNewDay()`
2. If `budgetTracker.canSpend()` is false → skip LLM, use AFINN fallback for all headlines
3. If true → call LLM, then `budgetTracker.record(inputTokens, outputTokens)` from API response usage

**Cost calculation:** Haiku pricing ($0.25/M input, $1.25/M output). `record()` computes: `inputTokens * 0.25e-6 + outputTokens * 1.25e-6`.

In-memory only. Reset on container restart (worst case: double spend one day — acceptable at ~$0.05/day).

## File Map

| Action | File | Responsibility |
|---|---|---|
| Create | `packages/data-collector/src/collectors/sources/LLMProvider.ts` | Interface + AnthropicProvider implementation |
| Create | `packages/data-collector/src/collectors/sources/LLMProvider.test.ts` | Tests |
| Create | `packages/data-collector/src/collectors/sources/BudgetTracker.ts` | Daily spend tracking + enforcement |
| Create | `packages/data-collector/src/collectors/sources/BudgetTracker.test.ts` | Tests |
| Modify | `packages/data-collector/src/collectors/sources/EntityMatcher.ts` | Add stoplist, min length, entity filtering |
| Modify | `packages/data-collector/src/collectors/sources/EntityMatcher.test.ts` | Update tests |
| Modify | `packages/data-collector/src/collectors/NewsCollector.ts` | Integrate LLM evaluation, neutral filter, fallback logic |
| Modify | `packages/data-collector/src/collectors/NewsCollector.test.ts` | Update tests |

## What Does NOT Change

- Google News RSS source (GoogleNewsRSSSource.ts)
- Finnhub source (FinnhubNewsSource.ts) — only needs API key config
- SentimentScorer (AFINN) — still used as fallback
- SignalEngine / NewsSentimentGenerator — reads from external_signals unchanged
- Database schema — no new tables, external_signals and news_articles unchanged

## Testing Strategy

1. **Entity matcher refinements:** Test that generic entities are filtered, min length enforced, stoplist works
2. **LLM Provider interface:** Mock Anthropic API, verify structured output parsed correctly
3. **AnthropicProvider:** Test tool_use call construction, response mapping
4. **NewsCollector integration:** Mock LLM provider, verify fallback on failure, verify budget enforcement
5. **Budget tracker:** Test counter increment, daily reset, limit enforcement

## Success Criteria

1. False positive rate drops significantly (from ~1300 to <100 signals per cycle)
2. LLM-evaluated signals have `match_method: 'llm_eval'` in metadata
3. AFINN fallback activates automatically on LLM failure
4. Budget counter prevents runaway spending
5. Pipeline continues functioning when LLM provider is unavailable
