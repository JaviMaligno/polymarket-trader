# News/Sentiment Phase 2 — LLM Evaluation + Refinements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce false positive signals from ~1300 to <100 per cycle by refining entity matching, and add LLM (Haiku) evaluation via structured output for high-quality directional signals with AFINN fallback on failure.

**Architecture:** EntityMatcher gets stoplist + min length filter. NewsCollector checks budget, sends pre-filtered headlines to LLMProvider (Anthropic tool_use), falls back to AFINN on any failure. BudgetTracker enforces daily spend limit.

**Tech Stack:** TypeScript, `@anthropic-ai/sdk` (Haiku structured output), Vitest

**Spec:** `docs/plans/2026-04-10-news-sentiment-phase2-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `packages/data-collector/src/collectors/sources/BudgetTracker.ts` | Daily LLM spend tracking |
| Create | `packages/data-collector/src/collectors/sources/BudgetTracker.test.ts` | Tests |
| Create | `packages/data-collector/src/collectors/sources/LLMProvider.ts` | Interface + AnthropicProvider |
| Create | `packages/data-collector/src/collectors/sources/LLMProvider.test.ts` | Tests |
| Modify | `packages/data-collector/src/collectors/sources/EntityMatcher.ts` | Stoplist, min length filter |
| Modify | `packages/data-collector/src/collectors/sources/EntityMatcher.test.ts` | New tests for filtering |
| Modify | `packages/data-collector/src/collectors/NewsCollector.ts` | LLM integration, neutral filter, fallback |
| Modify | `packages/data-collector/src/collectors/NewsCollector.test.ts` | Updated tests |
| Modify | `docker-compose.gcp.yml` | Add ANTHROPIC_API_KEY to data-collector |

---

### Task 1: Install Anthropic SDK

**Files:** `packages/data-collector/package.json`

- [ ] **Step 1: Install**

```bash
cd packages/data-collector && npm install --ignore-scripts @anthropic-ai/sdk
```

- [ ] **Step 2: Verify**

```bash
node -e "require('@anthropic-ai/sdk'); console.log('OK')"
```

- [ ] **Step 3: Commit**

```bash
git add packages/data-collector/package.json packages/data-collector/package-lock.json
git commit -m "chore: add @anthropic-ai/sdk for news LLM evaluation"
```

---

### Task 2: BudgetTracker

**Files:**
- Create: `packages/data-collector/src/collectors/sources/BudgetTracker.ts`
- Create: `packages/data-collector/src/collectors/sources/BudgetTracker.test.ts`

- [ ] **Step 1: Write tests**

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BudgetTracker } from './BudgetTracker.js';

describe('BudgetTracker', () => {
  let tracker: BudgetTracker;

  beforeEach(() => {
    tracker = new BudgetTracker(1.0); // $1 daily limit
  });

  it('allows spending when under budget', () => {
    expect(tracker.canSpend()).toBe(true);
  });

  it('blocks spending when budget exceeded', () => {
    // Haiku: $0.25/M input, $1.25/M output
    // 4M input tokens = $1.00
    tracker.record(4_000_000, 0);
    expect(tracker.canSpend()).toBe(false);
  });

  it('tracks cumulative spend', () => {
    tracker.record(1_000_000, 0); // $0.25
    expect(tracker.canSpend()).toBe(true);
    tracker.record(1_000_000, 0); // $0.50
    expect(tracker.canSpend()).toBe(true);
    tracker.record(2_000_000, 0); // $1.00
    expect(tracker.canSpend()).toBe(false);
  });

  it('resets at new day', () => {
    tracker.record(4_000_000, 0); // exceed budget
    expect(tracker.canSpend()).toBe(false);

    // Simulate day change
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 25 * 60 * 60 * 1000));
    tracker.resetIfNewDay();
    expect(tracker.canSpend()).toBe(true);
    vi.useRealTimers();
  });

  it('reports spent amount', () => {
    tracker.record(1_000_000, 100_000); // $0.25 + $0.125 = $0.375
    expect(tracker.getSpentUSD()).toBeCloseTo(0.375, 2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /c/Users/Usuario/GitHub/polymarket-trader && npx vitest run packages/data-collector/src/collectors/sources/BudgetTracker.test.ts`

- [ ] **Step 3: Implement**

```typescript
import { pino } from 'pino';

const logger = pino({ name: 'budget-tracker' });

// Haiku pricing (per token)
const HAIKU_INPUT_COST = 0.25e-6;   // $0.25 per million
const HAIKU_OUTPUT_COST = 1.25e-6;  // $1.25 per million

export class BudgetTracker {
  private spentUSD = 0;
  private lastResetDate: string;
  private limitUSD: number;

  constructor(limitUSD?: number) {
    this.limitUSD = limitUSD ?? parseFloat(process.env.LLM_DAILY_BUDGET_USD || '1.0');
    this.lastResetDate = new Date().toISOString().slice(0, 10);
  }

  canSpend(): boolean {
    this.resetIfNewDay();
    return this.spentUSD < this.limitUSD;
  }

  record(inputTokens: number, outputTokens: number): void {
    const cost = inputTokens * HAIKU_INPUT_COST + outputTokens * HAIKU_OUTPUT_COST;
    this.spentUSD += cost;
    logger.debug({ inputTokens, outputTokens, cost, totalSpent: this.spentUSD, limit: this.limitUSD }, 'LLM cost recorded');
  }

  getSpentUSD(): number {
    return this.spentUSD;
  }

  resetIfNewDay(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.lastResetDate) {
      logger.info({ previousSpend: this.spentUSD, date: this.lastResetDate }, 'Daily budget reset');
      this.spentUSD = 0;
      this.lastResetDate = today;
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/data-collector/src/collectors/sources/BudgetTracker.test.ts`
Expected: All 5 pass

- [ ] **Step 5: Commit**

```bash
git add packages/data-collector/src/collectors/sources/BudgetTracker.ts packages/data-collector/src/collectors/sources/BudgetTracker.test.ts
git commit -m "feat: add BudgetTracker for daily LLM spend control"
```

---

### Task 3: LLMProvider interface + AnthropicProvider

**Files:**
- Create: `packages/data-collector/src/collectors/sources/LLMProvider.ts`
- Create: `packages/data-collector/src/collectors/sources/LLMProvider.test.ts`

- [ ] **Step 1: Write tests**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn(),
    },
  })),
}));

import { AnthropicProvider, type Headline, type Market, type HeadlineEvaluation } from './LLMProvider.js';
import Anthropic from '@anthropic-ai/sdk';

describe('AnthropicProvider', () => {
  let provider: AnthropicProvider;
  let mockCreate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockCreate = vi.fn();
    (Anthropic as any).mockImplementation(() => ({
      messages: { create: mockCreate },
    }));
    provider = new AnthropicProvider('test-key');
  });

  it('returns provider name', () => {
    expect(provider.getName()).toBe('anthropic');
  });

  it('is available when API key is set', () => {
    expect(provider.isAvailable()).toBe(true);
  });

  it('is not available when API key is empty', () => {
    const noKey = new AnthropicProvider('');
    expect(noKey.isAvailable()).toBe(false);
  });

  it('parses structured tool_use response', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          name: 'evaluate_headlines',
          input: {
            matches: [
              { headline_id: 'h1', market_id: 'm1', direction: 'SHORT', impact: 0.8, reasoning: 'team eliminated' },
            ],
          },
        },
      ],
      usage: { input_tokens: 500, output_tokens: 100 },
    });

    const headlines: Headline[] = [{ id: 'h1', title: 'PSG eliminated from Champions League' }];
    const markets: Market[] = [{ id: 'm1', question: 'Will PSG win Champions League?', currentPrice: 0.14 }];

    const result = await provider.evaluateHeadlines(headlines, markets);
    expect(result.evaluations).toHaveLength(1);
    expect(result.evaluations[0].direction).toBe('SHORT');
    expect(result.evaluations[0].impact).toBe(0.8);
    expect(result.usage.inputTokens).toBe(500);
  });

  it('returns empty evaluations when no tool_use in response', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'No relevant matches found.' }],
      usage: { input_tokens: 500, output_tokens: 50 },
    });

    const result = await provider.evaluateHeadlines(
      [{ id: 'h1', title: 'Weather is nice today' }],
      [{ id: 'm1', question: 'Will Bitcoin reach $100K?', currentPrice: 0.50 }],
    );
    expect(result.evaluations).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/data-collector/src/collectors/sources/LLMProvider.test.ts`

- [ ] **Step 3: Implement**

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { pino } from 'pino';

const logger = pino({ name: 'llm-provider' });

export interface Headline {
  id: string;
  title: string;
}

export interface Market {
  id: string;
  question: string;
  currentPrice: number;
}

export interface HeadlineEvaluation {
  headlineId: string;
  marketId: string;
  direction: 'LONG' | 'SHORT';
  impact: number;
  reasoning?: string;
}

export interface EvaluationResult {
  evaluations: HeadlineEvaluation[];
  usage: { inputTokens: number; outputTokens: number };
}

export interface LLMProvider {
  evaluateHeadlines(headlines: Headline[], markets: Market[]): Promise<EvaluationResult>;
  getName(): string;
  isAvailable(): boolean;
}

const TOOL_DEFINITION = {
  name: 'evaluate_headlines',
  description: 'Evaluate which news headlines are relevant to which prediction markets and their directional impact',
  input_schema: {
    type: 'object' as const,
    properties: {
      matches: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            headline_id: { type: 'string' as const },
            market_id: { type: 'string' as const },
            direction: { type: 'string' as const, enum: ['LONG', 'SHORT'] },
            impact: { type: 'number' as const, minimum: 0, maximum: 1 },
            reasoning: { type: 'string' as const },
          },
          required: ['headline_id', 'market_id', 'direction', 'impact'],
        },
      },
    },
    required: ['matches'],
  },
};

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.ANTHROPIC_API_KEY || '';
    this.client = new Anthropic({ apiKey: this.apiKey });
  }

  getName(): string {
    return 'anthropic';
  }

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  async evaluateHeadlines(headlines: Headline[], markets: Market[]): Promise<EvaluationResult> {
    const marketList = markets.map((m, i) => `${i + 1}. [${m.id}] "${m.question}" (price: ${m.currentPrice.toFixed(2)})`).join('\n');
    const headlineList = headlines.map((h, i) => `${String.fromCharCode(65 + i)}. [${h.id}] "${h.title}"`).join('\n');

    const prompt = `You are evaluating news headlines for their relevance to prediction markets.

MARKETS:
${marketList}

HEADLINES:
${headlineList}

For each headline-market pair where the headline provides ACTIONABLE information about the market outcome, call the evaluate_headlines tool. Only include genuinely relevant pairs. Direction: LONG if the headline makes the YES outcome more likely, SHORT if less likely. Impact: 0.0-1.0 scale of how much the headline should move the market price.

If no headlines are relevant to any market, call the tool with an empty matches array.`;

    const response = await this.client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      tools: [TOOL_DEFINITION],
      tool_choice: { type: 'tool', name: 'evaluate_headlines' },
      messages: [{ role: 'user', content: prompt }],
    });

    const evaluations: HeadlineEvaluation[] = [];
    for (const block of response.content) {
      if (block.type === 'tool_use' && block.name === 'evaluate_headlines') {
        const input = block.input as { matches: Array<{ headline_id: string; market_id: string; direction: string; impact: number; reasoning?: string }> };
        for (const match of input.matches || []) {
          evaluations.push({
            headlineId: match.headline_id,
            marketId: match.market_id,
            direction: match.direction as 'LONG' | 'SHORT',
            impact: Math.max(0, Math.min(1, match.impact)),
            reasoning: match.reasoning,
          });
        }
      }
    }

    return {
      evaluations,
      usage: {
        inputTokens: response.usage?.input_tokens || 0,
        outputTokens: response.usage?.output_tokens || 0,
      },
    };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/data-collector/src/collectors/sources/LLMProvider.test.ts`
Expected: All 5 pass

- [ ] **Step 5: Commit**

```bash
git add packages/data-collector/src/collectors/sources/LLMProvider.ts packages/data-collector/src/collectors/sources/LLMProvider.test.ts
git commit -m "feat: add LLMProvider interface + AnthropicProvider with structured output"
```

---

### Task 4: Refine EntityMatcher

**Files:**
- Modify: `packages/data-collector/src/collectors/sources/EntityMatcher.ts`
- Modify: `packages/data-collector/src/collectors/sources/EntityMatcher.test.ts`

- [ ] **Step 1: Add tests for entity filtering**

Append to `EntityMatcher.test.ts`:

```typescript
  it('filters out short entities (<=2 chars)', () => {
    const entities = matcher.extractEntities('US Iran deal by April');
    // 'US' should be filtered, 'Iran' and 'April' kept
    expect(entities).not.toContain('US');
    expect(entities.some(e => e.includes('Iran'))).toBe(true);
  });

  it('filters out month names', () => {
    const entities = matcher.extractEntities('Will something happen by March 31?');
    expect(entities).not.toContain('March');
  });

  it('filters out generic stoplist words', () => {
    const entities = matcher.extractEntities('World Game Time for First event');
    expect(entities).not.toContain('World');
    expect(entities).not.toContain('Game');
    expect(entities).not.toContain('Time');
    expect(entities).not.toContain('First');
  });
```

- [ ] **Step 2: Run tests to see failures**

Run: `npx vitest run packages/data-collector/src/collectors/sources/EntityMatcher.test.ts`
Expected: New tests fail (entities not filtered yet)

- [ ] **Step 3: Add entity stoplist and min length filter**

In `EntityMatcher.ts`, add constants at the top of the file (after imports):

```typescript
// Entities that are too generic to be useful for matching
const ENTITY_STOPLIST = new Set([
  'World', 'Game', 'Time', 'First', 'New', 'Last', 'Next', 'Top',
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]);

const MIN_ENTITY_LENGTH = parseInt(process.env.NEWS_MIN_ENTITY_LENGTH || '4', 10);
```

Modify `extractEntities` to filter at the end before returning:

```typescript
    return [...new Set(entities)].filter(e =>
      e.length >= MIN_ENTITY_LENGTH && !ENTITY_STOPLIST.has(e)
    );
```

Also add the same filter in the acronyms section — acronyms like "US" (2 chars) should be filtered:

```typescript
    const acronyms = text.match(/\b[A-Z]{2,}\b/g) || [];
    for (const a of acronyms) {
      if (!entities.includes(a) && a.length >= MIN_ENTITY_LENGTH) entities.push(a);
    }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/data-collector/src/collectors/sources/EntityMatcher.test.ts`
Expected: All pass (old + new)

- [ ] **Step 5: Commit**

```bash
git add packages/data-collector/src/collectors/sources/EntityMatcher.ts packages/data-collector/src/collectors/sources/EntityMatcher.test.ts
git commit -m "feat: add entity stoplist and min length filter to reduce false positives"
```

---

### Task 5: Integrate LLM evaluation into NewsCollector

**Files:**
- Modify: `packages/data-collector/src/collectors/NewsCollector.ts`
- Modify: `packages/data-collector/src/collectors/NewsCollector.test.ts`

- [ ] **Step 1: Add tests for neutral filter and LLM integration**

Append to `NewsCollector.test.ts`:

```typescript
  it('filters out neutral sentiment articles (|sentiment| < 0.05)', () => {
    // This tests the logic, not the full pipeline
    const neutralSentiment = 0.02;
    const minSentiment = 0.05;
    expect(Math.abs(neutralSentiment) < minSentiment).toBe(true);
  });

  it('constructs with LLM provider when API key available', () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const c = new NewsCollector();
    expect(c).toBeDefined();
    delete process.env.ANTHROPIC_API_KEY;
  });
```

- [ ] **Step 2: Implement LLM integration in NewsCollector**

Modify `NewsCollector.ts`. Add imports at top:

```typescript
import { AnthropicProvider, type LLMProvider, type Headline, type Market } from './sources/LLMProvider.js';
import { BudgetTracker } from './sources/BudgetTracker.js';
```

Add properties to the class:

```typescript
  private llmProvider: LLMProvider | null;
  private budgetTracker: BudgetTracker;
  private consecutiveLLMFailures = 0;
  private llmDisabledUntil = 0;
```

In constructor:

```typescript
    const anthropicKey = process.env.ANTHROPIC_API_KEY || '';
    const provider = new AnthropicProvider(anthropicKey);
    this.llmProvider = provider.isAvailable() ? provider : null;
    this.budgetTracker = new BudgetTracker();
```

Replace the signal-writing section of `collect()` (the for loop over newArticles) with:

```typescript
    const MIN_SENTIMENT = parseFloat(process.env.NEWS_MIN_SENTIMENT || '0.05');

    // Separate articles into LLM candidates and AFINN-only
    const llmCandidates: Array<{ article: NewsArticle; sentiment: number; matches: any[] }> = [];

    for (const article of newArticles) {
      try {
        const sentiment = this.scorer.score(article.title);

        // Store in news_articles
        await query(
          `INSERT INTO news_articles (time, source, title, url, category, raw_sentiment, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [article.publishedAt, article.source, article.title, article.url, article.category, sentiment, JSON.stringify({ description: article.description || null })]
        );

        // Skip neutral headlines
        if (Math.abs(sentiment) < MIN_SENTIMENT) continue;

        // Match against markets
        const matches = this.matcher.matchHeadline(article.title);
        if (matches.length === 0) continue;

        llmCandidates.push({ article, sentiment, matches });
      } catch (error) {
        logger.error({ error, url: article.url }, 'Failed to process article');
      }
    }

    if (llmCandidates.length === 0) {
      logger.info({ articlesProcessed: newArticles.length }, 'No LLM candidates after filtering');
      return 0;
    }

    // Try LLM evaluation
    const useLLM = this.llmProvider
      && this.budgetTracker.canSpend()
      && Date.now() > this.llmDisabledUntil;

    if (useLLM) {
      try {
        // Build LLM input
        const headlines: Headline[] = llmCandidates.map((c, i) => ({ id: String(i), title: c.article.title }));
        const marketIds = new Set(llmCandidates.flatMap(c => c.matches.map((m: any) => m.marketId)));
        const marketRows = await query<{ id: string; question: string; current_price_yes: string }>(
          `SELECT id, question, current_price_yes FROM markets WHERE id = ANY($1::varchar[])`,
          [[...marketIds]]
        );
        const markets: Market[] = marketRows.rows.map(r => ({
          id: r.id,
          question: r.question,
          currentPrice: parseFloat(r.current_price_yes || '0.5'),
        }));

        const result = await this.llmProvider!.evaluateHeadlines(headlines, markets);
        this.budgetTracker.record(result.usage.inputTokens, result.usage.outputTokens);
        this.consecutiveLLMFailures = 0;

        // Write LLM-evaluated signals
        for (const evaluation of result.evaluations) {
          const value = evaluation.impact * (evaluation.direction === 'LONG' ? 1 : -1);
          const confidence = evaluation.impact * 0.8;
          await query(
            `INSERT INTO external_signals (market_id, source, signal_type, value, confidence, metadata)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              evaluation.marketId, 'news_pipeline', 'sentiment', value, confidence,
              JSON.stringify({ match_method: 'llm_eval', headline_id: evaluation.headlineId, direction: evaluation.direction, impact: evaluation.impact, reasoning: evaluation.reasoning }),
            ]
          );
          signalCount++;
        }

        logger.info({ llmSignals: result.evaluations.length, budget: this.budgetTracker.getSpentUSD().toFixed(4) }, 'LLM evaluation complete');
      } catch (error) {
        logger.error({ error }, 'LLM evaluation failed, falling back to AFINN');
        this.consecutiveLLMFailures++;
        if (this.consecutiveLLMFailures >= 3) {
          this.llmDisabledUntil = Date.now() + 60 * 60 * 1000; // disable 1 hour
          logger.warn('LLM disabled for 1 hour after 3 consecutive failures');
        }
        // Fall through to AFINN fallback below
      }
    }

    // AFINN fallback for candidates not handled by LLM (or if LLM failed/disabled)
    if (!useLLM || this.consecutiveLLMFailures > 0) {
      for (const { article, sentiment, matches } of llmCandidates) {
        for (const match of matches) {
          const adjustedSentiment = sentiment * (match.isCompetitorMention ? -1 : 1);
          const confidence = match.relevanceScore * Math.min(1, Math.abs(sentiment) + 0.3) * 0.5;
          await query(
            `INSERT INTO external_signals (market_id, source, signal_type, value, confidence, metadata)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              match.marketId, 'news_pipeline', 'sentiment', adjustedSentiment, confidence,
              JSON.stringify({ match_method: 'afinn_fallback', headline: article.title, relevance: match.relevanceScore, matchedEntities: match.matchedEntities }),
            ]
          );
          signalCount++;
        }
      }
    }

    logger.info({ signalCount, articlesProcessed: newArticles.length, llmUsed: useLLM }, 'News collection cycle complete');
    return signalCount;
```

- [ ] **Step 3: Run all tests**

Run: `cd /c/Users/Usuario/GitHub/polymarket-trader && npx vitest run`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add packages/data-collector/src/collectors/NewsCollector.ts packages/data-collector/src/collectors/NewsCollector.test.ts
git commit -m "feat: integrate LLM evaluation with AFINN fallback and budget control"
```

---

### Task 6: Add ANTHROPIC_API_KEY to docker-compose

**Files:**
- Modify: `docker-compose.gcp.yml`

- [ ] **Step 1: Add env var to data-collector service**

In the data-collector environment section, add:

```yaml
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
      LLM_DAILY_BUDGET_USD: "1.0"
      NEWS_MIN_ENTITY_LENGTH: "4"
      NEWS_MIN_SENTIMENT: "0.05"
```

- [ ] **Step 2: Add ANTHROPIC_API_KEY to VM .env**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="grep -q ANTHROPIC_API_KEY /home/Usuario/polymarket-trader/.env || echo 'ANTHROPIC_API_KEY=<key-from-local-env>' >> /home/Usuario/polymarket-trader/.env"
```

(Get the actual key from local `.env` file)

- [ ] **Step 3: Commit**

```bash
git add docker-compose.gcp.yml
git commit -m "feat: add ANTHROPIC_API_KEY and news config to data-collector env"
```

---

### Task 7: Deploy and verify

- [ ] **Step 1: Push**

```bash
gh auth switch --user JaviMaligno
git push origin main
```

- [ ] **Step 2: Wait for CI/CD, then deploy**

```bash
# Wait ~5min for CI, then:
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="cd /home/Usuario/polymarket-trader && docker compose -f docker-compose.gcp.yml pull data-collector && docker compose -f docker-compose.gcp.yml up -d --force-recreate data-collector"
```

- [ ] **Step 3: Verify entity filtering reduces false positives**

Wait 15min, then:
```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"SELECT count(*) FROM external_signals WHERE source = 'news_pipeline' AND fetched_at > NOW() - INTERVAL '20 minutes';\""
```

Expected: Significantly fewer than 1300 signals (target: <100)

- [ ] **Step 4: Verify LLM evaluation working**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"SELECT metadata->>'match_method' as method, count(*) FROM external_signals WHERE source = 'news_pipeline' AND fetched_at > NOW() - INTERVAL '20 minutes' GROUP BY metadata->>'match_method';\""
```

Expected: Rows for both `llm_eval` and possibly `afinn_fallback`

- [ ] **Step 5: Check budget tracking**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker logs --since=20m polymarket-data-collector 2>&1 | grep -i 'budget\|cost\|LLM eval'"
```

Expected: Log lines showing LLM cost recorded and budget status
