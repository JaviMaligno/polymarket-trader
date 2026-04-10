# News/Sentiment Signal Pipeline Phase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest news from Google News RSS and Finnhub, score sentiment, match to active markets via NER, and feed signals into the existing `external_signals` → `NewsSentimentGenerator` pipeline.

**Architecture:** NewsCollector (new) runs inside data-collector service. Two pollers (RSS + Finnhub) fetch articles every 15min. AFINN scores RSS headlines. wink-nlp extracts entities from market questions and matches against headlines. Matched signals write to `external_signals` table. The existing `SignalEngine` → `NewsSentimentGenerator` reads them automatically.

**Tech Stack:** TypeScript, `rss-parser` (RSS), `afinn-165` (sentiment), `wink-nlp` (NER), Finnhub REST API, PostgreSQL

**Spec:** `docs/plans/2026-04-10-news-sentiment-phase1-design.md`

**Existing code to reuse/modify:**
- `packages/data-collector/src/collectors/sources/NewsSource.ts` — replace GNews with RSS + Finnhub
- `packages/data-collector/src/collectors/ExternalDataCollector.ts` — add news collection method
- `packages/data-collector/src/services/Scheduler.ts` — add cron job
- `packages/dashboard/src/services/SignalEngine.ts:650-668` — already reads `external_signals` for sentiment (no changes needed)
- `packages/signals/src/signals/external/NewsSentimentGenerator.ts` — already reads `context.custom.newsSentiment` (no changes needed)

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `packages/data-collector/src/collectors/sources/GoogleNewsRSSSource.ts` | Parse Google News RSS feeds by category |
| Create | `packages/data-collector/src/collectors/sources/GoogleNewsRSSSource.test.ts` | Tests |
| Create | `packages/data-collector/src/collectors/sources/FinnhubNewsSource.ts` | Fetch Finnhub news API with sentiment |
| Create | `packages/data-collector/src/collectors/sources/FinnhubNewsSource.test.ts` | Tests |
| Create | `packages/data-collector/src/collectors/sources/SentimentScorer.ts` | AFINN-based headline sentiment scoring |
| Create | `packages/data-collector/src/collectors/sources/SentimentScorer.test.ts` | Tests |
| Create | `packages/data-collector/src/collectors/sources/EntityMatcher.ts` | wink-nlp entity extraction + market matching |
| Create | `packages/data-collector/src/collectors/sources/EntityMatcher.test.ts` | Tests |
| Create | `packages/data-collector/src/collectors/NewsCollector.ts` | Orchestrates sources → scoring → matching → DB write |
| Create | `packages/data-collector/src/collectors/NewsCollector.test.ts` | Tests |
| Create | `packages/data-collector/src/database/init/015_news_articles_table.sql` | Create `news_articles` table |
| Modify | `packages/data-collector/src/services/Scheduler.ts:40-54` | Add `collect-news` cron job |
| Modify | `packages/data-collector/src/index.ts` | Wire NewsCollector into startup |

---

### Task 1: Install dependencies

**Files:** `packages/data-collector/package.json`

- [ ] **Step 1: Install packages**

```bash
cd packages/data-collector
npm install rss-parser afinn-165 wink-nlp wink-eng-lite-web-model
```

Note: `wink-eng-lite-web-model` is the English language model for wink-nlp (~5MB).

- [ ] **Step 2: Verify installation**

```bash
node -e "require('rss-parser'); require('afinn-165'); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add packages/data-collector/package.json packages/data-collector/package-lock.json
git commit -m "chore: add rss-parser, afinn-165, wink-nlp for news pipeline"
```

---

### Task 2: Database migration — news_articles table

**Files:**
- Create: `packages/data-collector/src/database/init/015_news_articles_table.sql`

- [ ] **Step 1: Create migration**

```sql
-- Migration 015: Create news_articles table for dedup and audit trail
--
-- Stores fetched news articles from all sources (Google News RSS, Finnhub).
-- Used for deduplication (by URL) and audit trail of what news was processed.

CREATE TABLE IF NOT EXISTS news_articles (
    time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source VARCHAR(50) NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    category VARCHAR(50),
    raw_sentiment DECIMAL(5,4),
    language VARCHAR(10) DEFAULT 'en',
    metadata JSONB DEFAULT '{}'
);

-- Create hypertable for time-series storage
SELECT create_hypertable('news_articles', 'time',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists => TRUE
);

-- Unique index on URL to prevent duplicates
CREATE UNIQUE INDEX IF NOT EXISTS idx_news_articles_url ON news_articles (url);

-- Retention: 7 days
SELECT add_retention_policy('news_articles', INTERVAL '7 days', if_not_exists => TRUE);
```

- [ ] **Step 2: Apply on VM**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c 'CREATE TABLE IF NOT EXISTS news_articles (time TIMESTAMPTZ NOT NULL DEFAULT NOW(), source VARCHAR(50) NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL, category VARCHAR(50), raw_sentiment DECIMAL(5,4), language VARCHAR(10) DEFAULT '\''en'\'', metadata JSONB DEFAULT '\''{}'\''::jsonb); SELECT create_hypertable('\''news_articles'\'', '\''time'\'', chunk_time_interval => INTERVAL '\''1 day'\'', if_not_exists => TRUE); CREATE UNIQUE INDEX IF NOT EXISTS idx_news_articles_url ON news_articles (url);'"
```

- [ ] **Step 3: Activate news_sentiment weight**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"INSERT INTO signal_weights (signal_type, weight, is_enabled) VALUES ('news_sentiment', 0.10, true) ON CONFLICT (signal_type) DO UPDATE SET is_enabled = true;\""
```

- [ ] **Step 4: Commit**

```bash
git add packages/data-collector/src/database/init/015_news_articles_table.sql
git commit -m "feat: add news_articles table and activate news_sentiment weight"
```

---

### Task 3: SentimentScorer (AFINN)

**Files:**
- Create: `packages/data-collector/src/collectors/sources/SentimentScorer.ts`
- Create: `packages/data-collector/src/collectors/sources/SentimentScorer.test.ts`

- [ ] **Step 1: Write tests**

```typescript
import { describe, it, expect } from 'vitest';
import { SentimentScorer } from './SentimentScorer.js';

describe('SentimentScorer', () => {
  const scorer = new SentimentScorer();

  it('scores clearly positive headline', () => {
    const score = scorer.score('Manchester City wins Premier League title');
    expect(score).toBeGreaterThan(0);
  });

  it('scores clearly negative headline', () => {
    const score = scorer.score('PSG eliminated from Champions League');
    expect(score).toBeLessThan(0);
  });

  it('returns 0 for neutral headline', () => {
    const score = scorer.score('Match scheduled for Tuesday at 8pm');
    expect(score).toBe(0);
  });

  it('normalizes score to [-1, 1] range', () => {
    const score = scorer.score('Amazing wonderful fantastic brilliant superb excellent great');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('handles empty string', () => {
    expect(scorer.score('')).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /c/Users/Usuario/GitHub/polymarket-trader && npx vitest run packages/data-collector/src/collectors/sources/SentimentScorer.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement SentimentScorer**

```typescript
import afinn from 'afinn-165';

/**
 * Simple AFINN-165 sentiment scorer for headlines.
 * Returns a score normalized to [-1, +1].
 */
export class SentimentScorer {
  private lexicon: Record<string, number>;

  constructor() {
    this.lexicon = afinn as Record<string, number>;
  }

  /**
   * Score a headline string. Returns [-1, +1] where:
   *  -1 = very negative, 0 = neutral, +1 = very positive
   */
  score(text: string): number {
    if (!text) return 0;

    const words = text.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/);
    let total = 0;
    let scored = 0;

    for (const word of words) {
      const val = this.lexicon[word];
      if (val !== undefined) {
        total += val;
        scored++;
      }
    }

    if (scored === 0) return 0;

    // AFINN scores range -5 to +5 per word. Normalize by dividing by
    // max possible magnitude (5 * scored words) and clamp to [-1, 1]
    const normalized = total / (5 * scored);
    return Math.max(-1, Math.min(1, normalized));
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/data-collector/src/collectors/sources/SentimentScorer.test.ts`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add packages/data-collector/src/collectors/sources/SentimentScorer.ts packages/data-collector/src/collectors/sources/SentimentScorer.test.ts
git commit -m "feat: add AFINN-165 sentiment scorer for news headlines"
```

---

### Task 4: GoogleNewsRSSSource

**Files:**
- Create: `packages/data-collector/src/collectors/sources/GoogleNewsRSSSource.ts`
- Create: `packages/data-collector/src/collectors/sources/GoogleNewsRSSSource.test.ts`

- [ ] **Step 1: Write tests**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('rss-parser', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      parseURL: vi.fn(),
    })),
  };
});

import { GoogleNewsRSSSource } from './GoogleNewsRSSSource.js';

describe('GoogleNewsRSSSource', () => {
  let source: GoogleNewsRSSSource;

  beforeEach(() => {
    source = new GoogleNewsRSSSource();
  });

  it('constructs RSS URL for a category', () => {
    const url = source.buildFeedUrl('sports');
    expect(url).toContain('news.google.com/rss');
    expect(url).toContain('sports');
  });

  it('returns supported categories', () => {
    const categories = source.getCategories();
    expect(categories).toContain('sports');
    expect(categories).toContain('world');
    expect(categories).toContain('business');
    expect(categories).toContain('technology');
    expect(categories).toContain('entertainment');
  });

  it('parses RSS items into NewsArticle format', () => {
    const rawItem = {
      title: 'Arsenal beats PSG in Champions League',
      link: 'https://news.google.com/articles/123',
      pubDate: '2026-04-10T10:00:00Z',
      contentSnippet: 'Arsenal advanced to the finals...',
    };
    const article = source.parseItem(rawItem, 'sports');
    expect(article.title).toBe('Arsenal beats PSG in Champions League');
    expect(article.url).toBe('https://news.google.com/articles/123');
    expect(article.source).toBe('google_rss');
    expect(article.category).toBe('sports');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/data-collector/src/collectors/sources/GoogleNewsRSSSource.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement GoogleNewsRSSSource**

```typescript
import Parser from 'rss-parser';
import { pino } from 'pino';

const logger = pino({ name: 'google-news-rss' });

export interface NewsArticle {
  title: string;
  url: string;
  publishedAt: Date;
  source: string;
  category: string;
  description?: string;
}

const CATEGORIES = ['sports', 'world', 'business', 'technology', 'entertainment'] as const;
type Category = typeof CATEGORIES[number];

export class GoogleNewsRSSSource {
  private parser: Parser;

  constructor() {
    this.parser = new Parser({ timeout: 10000 });
  }

  getCategories(): readonly string[] {
    return CATEGORIES;
  }

  buildFeedUrl(category: Category | string): string {
    // Google News RSS topic feeds
    const topicMap: Record<string, string> = {
      sports: 'CAAqJggKIiBDQkFTRWdvSUwyMHZNRFp1ZEdvU0FtVnVHZ0pWVXlnQVAB',
      world: 'CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx1YlY4U0FtVnVHZ0pWVXlnQVAB',
      business: 'CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtVnVHZ0pWVXlnQVAB',
      technology: 'CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0FtVnVHZ0pWVXlnQVAB',
      entertainment: 'CAAqJggKIiBDQkFTRWdvSUwyMHZNREpxYW5RU0FtVnVHZ0pWVXlnQVAB',
    };
    const topic = topicMap[category] || topicMap.world;
    return `https://news.google.com/rss/topics/${topic}?hl=en-US&gl=US&ceid=US:en`;
  }

  parseItem(item: Record<string, any>, category: string): NewsArticle {
    return {
      title: item.title || '',
      url: item.link || item.guid || '',
      publishedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
      source: 'google_rss',
      category,
      description: item.contentSnippet || item.content || undefined,
    };
  }

  async fetchCategory(category: Category | string): Promise<NewsArticle[]> {
    try {
      const url = this.buildFeedUrl(category);
      const feed = await this.parser.parseURL(url);
      const articles = (feed.items || []).map(item => this.parseItem(item, category));
      logger.debug({ category, count: articles.length }, 'Fetched Google News RSS');
      return articles;
    } catch (error) {
      logger.error({ error, category }, 'Failed to fetch Google News RSS');
      return [];
    }
  }

  async fetchAll(): Promise<NewsArticle[]> {
    const results: NewsArticle[] = [];
    for (const category of CATEGORIES) {
      const articles = await this.fetchCategory(category);
      results.push(...articles);
      // Conservative rate: 1 category per second
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return results;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/data-collector/src/collectors/sources/GoogleNewsRSSSource.test.ts`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add packages/data-collector/src/collectors/sources/GoogleNewsRSSSource.ts packages/data-collector/src/collectors/sources/GoogleNewsRSSSource.test.ts
git commit -m "feat: add Google News RSS source with category-based feeds"
```

---

### Task 5: FinnhubNewsSource

**Files:**
- Create: `packages/data-collector/src/collectors/sources/FinnhubNewsSource.ts`
- Create: `packages/data-collector/src/collectors/sources/FinnhubNewsSource.test.ts`

- [ ] **Step 1: Write tests**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));
vi.mock('axios', () => ({ default: { get: mockGet } }));

import { FinnhubNewsSource } from './FinnhubNewsSource.js';

describe('FinnhubNewsSource', () => {
  let source: FinnhubNewsSource;

  beforeEach(() => {
    mockGet.mockReset();
    source = new FinnhubNewsSource('test-key');
  });

  it('fetches and parses market news', async () => {
    mockGet.mockResolvedValueOnce({
      data: [
        {
          headline: 'Bitcoin hits $100K',
          summary: 'Major milestone reached',
          url: 'https://example.com/btc',
          datetime: 1712764800,
          source: 'MarketWatch',
          category: 'crypto',
        },
      ],
    });

    const articles = await source.fetchNews('crypto');
    expect(articles).toHaveLength(1);
    expect(articles[0].title).toBe('Bitcoin hits $100K');
    expect(articles[0].source).toBe('finnhub');
    expect(articles[0].category).toBe('crypto');
    expect(articles[0].url).toBe('https://example.com/btc');
  });

  it('returns empty array on error', async () => {
    mockGet.mockRejectedValueOnce(new Error('API error'));
    const articles = await source.fetchNews('general');
    expect(articles).toEqual([]);
  });

  it('returns empty array when no API key', async () => {
    const noKeySource = new FinnhubNewsSource('');
    const articles = await noKeySource.fetchNews('general');
    expect(articles).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/data-collector/src/collectors/sources/FinnhubNewsSource.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement FinnhubNewsSource**

```typescript
import axios from 'axios';
import { pino } from 'pino';
import type { NewsArticle } from './GoogleNewsRSSSource.js';

const logger = pino({ name: 'finnhub-news' });

export class FinnhubNewsSource {
  private apiKey: string;
  private readonly baseUrl = 'https://finnhub.io/api/v1';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async fetchNews(category: 'general' | 'crypto' = 'general'): Promise<NewsArticle[]> {
    if (!this.apiKey) return [];

    try {
      const response = await axios.get(`${this.baseUrl}/news`, {
        params: { category, token: this.apiKey },
        timeout: 10000,
      });

      const items: any[] = response.data || [];
      return items.map((item): NewsArticle => ({
        title: item.headline || '',
        url: item.url || '',
        publishedAt: item.datetime ? new Date(item.datetime * 1000) : new Date(),
        source: 'finnhub',
        category: item.category || category,
        description: item.summary || undefined,
      }));
    } catch (error) {
      logger.error({ error, category }, 'Failed to fetch Finnhub news');
      return [];
    }
  }

  async fetchAll(): Promise<NewsArticle[]> {
    const [general, crypto] = await Promise.all([
      this.fetchNews('general'),
      this.fetchNews('crypto'),
    ]);
    return [...general, ...crypto];
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/data-collector/src/collectors/sources/FinnhubNewsSource.test.ts`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add packages/data-collector/src/collectors/sources/FinnhubNewsSource.ts packages/data-collector/src/collectors/sources/FinnhubNewsSource.test.ts
git commit -m "feat: add Finnhub news source for financial/crypto sentiment"
```

---

### Task 6: EntityMatcher (wink-nlp)

**Files:**
- Create: `packages/data-collector/src/collectors/sources/EntityMatcher.ts`
- Create: `packages/data-collector/src/collectors/sources/EntityMatcher.test.ts`

- [ ] **Step 1: Write tests**

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { EntityMatcher } from './EntityMatcher.js';

describe('EntityMatcher', () => {
  let matcher: EntityMatcher;

  beforeAll(() => {
    matcher = new EntityMatcher();
  });

  it('extracts entities from a market question', () => {
    const entities = matcher.extractEntities('Will Manchester City win the 2025-26 English Premier League?');
    expect(entities.some(e => e.toLowerCase().includes('manchester city'))).toBe(true);
  });

  it('matches headline to market when entities overlap', () => {
    matcher.setMarkets([
      { id: 'market-1', question: 'Will PSG win the 2025-26 Champions League?' },
      { id: 'market-2', question: 'Will Arsenal win the 2025-26 Champions League?' },
    ]);

    const matches = matcher.matchHeadline('PSG eliminated by Arsenal in semifinal');
    expect(matches.length).toBeGreaterThan(0);
    // Should match both markets (PSG and Arsenal are mentioned)
    const marketIds = matches.map(m => m.marketId);
    expect(marketIds).toContain('market-1');
    expect(marketIds).toContain('market-2');
  });

  it('returns empty matches for irrelevant headline', () => {
    matcher.setMarkets([
      { id: 'market-1', question: 'Will Bitcoin reach $100K by June 2026?' },
    ]);

    const matches = matcher.matchHeadline('Weather forecast shows rain tomorrow');
    expect(matches).toHaveLength(0);
  });

  it('detects competitor relationship', () => {
    matcher.setMarkets([
      { id: 'market-1', question: 'Will PSG win the 2025-26 Champions League?' },
      { id: 'market-2', question: 'Will Arsenal win the 2025-26 Champions League?' },
    ]);

    const matches = matcher.matchHeadline('Arsenal wins Champions League final');
    const psgMatch = matches.find(m => m.marketId === 'market-1');
    const arsenalMatch = matches.find(m => m.marketId === 'market-2');

    // Arsenal winning is SHORT for PSG market
    if (psgMatch) expect(psgMatch.isCompetitorMention).toBe(true);
    // Arsenal winning is direct for Arsenal market
    if (arsenalMatch) expect(arsenalMatch.isCompetitorMention).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/data-collector/src/collectors/sources/EntityMatcher.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement EntityMatcher**

```typescript
import winkNLP from 'wink-nlp';
import model from 'wink-eng-lite-web-model';
import { pino } from 'pino';

const logger = pino({ name: 'entity-matcher' });

export interface MarketEntitySet {
  id: string;
  question: string;
  entities: string[];       // Named entities extracted from question
  eventContext: string;      // Shared event (e.g., "Champions League") for competitor detection
}

export interface HeadlineMatch {
  marketId: string;
  relevanceScore: number;    // 0-1
  isCompetitorMention: boolean;  // headline mentions a competitor, not the subject
  matchedEntities: string[];
}

export class EntityMatcher {
  private nlp: ReturnType<typeof winkNLP>;
  private markets: MarketEntitySet[] = [];

  constructor() {
    this.nlp = winkNLP(model);
  }

  /**
   * Extract named entities from text using wink-nlp.
   * Returns an array of entity strings (people, orgs, locations, etc.)
   */
  extractEntities(text: string): string[] {
    const doc = this.nlp.readDoc(text);
    const entities: string[] = [];

    // Get custom entities (NER)
    doc.entities().each((e: any) => {
      entities.push(e.out());
    });

    // Also extract capitalized multi-word phrases as potential entities
    // (wink-nlp NER may miss some proper nouns)
    const tokens = text.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g) || [];
    for (const token of tokens) {
      if (token.length > 2 && !entities.includes(token) && !['Will', 'The', 'What', 'How', 'Who'].includes(token)) {
        entities.push(token);
      }
    }

    return [...new Set(entities)];
  }

  /**
   * Update the market list and extract entities for each.
   */
  setMarkets(markets: Array<{ id: string; question: string }>): void {
    this.markets = markets.map(m => {
      const entities = this.extractEntities(m.question);
      // Extract event context (shared context for competitor detection)
      // e.g., "Champions League", "Premier League", "presidential election"
      const eventPatterns = /(?:Champions League|Premier League|World Cup|Stanley Cup|NBA|NFL|Eurovision|election|nomination|primary)/i;
      const eventMatch = m.question.match(eventPatterns);
      const eventContext = eventMatch ? eventMatch[0].toLowerCase() : '';

      return { id: m.id, question: m.question, entities, eventContext };
    });

    logger.info({ marketCount: this.markets.length }, 'Updated entity cache for markets');
  }

  /**
   * Match a headline against all cached markets.
   */
  matchHeadline(headline: string): HeadlineMatch[] {
    const headlineLower = headline.toLowerCase();
    const headlineEntities = this.extractEntities(headline);
    const headlineEntitySet = new Set(headlineEntities.map(e => e.toLowerCase()));
    const matches: HeadlineMatch[] = [];

    for (const market of this.markets) {
      const matchedEntities: string[] = [];
      for (const entity of market.entities) {
        if (headlineLower.includes(entity.toLowerCase()) || headlineEntitySet.has(entity.toLowerCase())) {
          matchedEntities.push(entity);
        }
      }

      if (matchedEntities.length === 0) continue;

      // Determine if this is a competitor mention
      // A competitor is another market with the same eventContext whose subject appears in the headline
      let isCompetitorMention = false;
      if (market.eventContext) {
        const competitors = this.markets.filter(
          other => other.id !== market.id && other.eventContext === market.eventContext
        );
        for (const comp of competitors) {
          const compSubject = comp.entities[0]?.toLowerCase();
          if (compSubject && headlineLower.includes(compSubject)) {
            // Headline mentions a competitor — this is an indirect signal
            isCompetitorMention = !headlineLower.includes(market.entities[0]?.toLowerCase() || '');
            break;
          }
        }
      }

      const relevanceScore = Math.min(1.0, matchedEntities.length / Math.max(1, market.entities.length));

      matches.push({
        marketId: market.id,
        relevanceScore: relevanceScore < 0.3 ? 0.3 : relevanceScore,
        isCompetitorMention,
        matchedEntities,
      });
    }

    return matches;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/data-collector/src/collectors/sources/EntityMatcher.test.ts`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add packages/data-collector/src/collectors/sources/EntityMatcher.ts packages/data-collector/src/collectors/sources/EntityMatcher.test.ts
git commit -m "feat: add wink-nlp entity matcher for market-headline matching"
```

---

### Task 7: NewsCollector orchestrator

**Files:**
- Create: `packages/data-collector/src/collectors/NewsCollector.ts`
- Create: `packages/data-collector/src/collectors/NewsCollector.test.ts`

- [ ] **Step 1: Write tests**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock DB
vi.mock('../database/connection.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
}));

import { NewsCollector } from './NewsCollector.js';

describe('NewsCollector', () => {
  let collector: NewsCollector;

  beforeEach(() => {
    collector = new NewsCollector();
  });

  it('constructs without error', () => {
    expect(collector).toBeDefined();
  });

  it('deduplicates articles by URL', () => {
    const articles = [
      { title: 'A', url: 'https://a.com', publishedAt: new Date(), source: 'google_rss', category: 'sports' },
      { title: 'B', url: 'https://a.com', publishedAt: new Date(), source: 'google_rss', category: 'sports' },
      { title: 'C', url: 'https://b.com', publishedAt: new Date(), source: 'google_rss', category: 'sports' },
    ];
    const deduped = collector.dedup(articles);
    expect(deduped).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/data-collector/src/collectors/NewsCollector.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement NewsCollector**

```typescript
import { pino } from 'pino';
import { query } from '../database/connection.js';
import { GoogleNewsRSSSource, type NewsArticle } from './sources/GoogleNewsRSSSource.js';
import { FinnhubNewsSource } from './sources/FinnhubNewsSource.js';
import { SentimentScorer } from './sources/SentimentScorer.js';
import { EntityMatcher } from './sources/EntityMatcher.js';

const logger = pino({ name: 'news-collector' });

export class NewsCollector {
  private rssSource: GoogleNewsRSSSource;
  private finnhubSource: FinnhubNewsSource;
  private sentimentScorer: SentimentScorer;
  private entityMatcher: EntityMatcher;
  private seenUrls: Set<string> = new Set();

  constructor(finnhubApiKey?: string) {
    this.rssSource = new GoogleNewsRSSSource();
    this.finnhubSource = new FinnhubNewsSource(finnhubApiKey || process.env.FINNHUB_API_KEY || '');
    this.sentimentScorer = new SentimentScorer();
    this.entityMatcher = new EntityMatcher();
  }

  /**
   * Deduplicate articles by URL.
   */
  dedup(articles: NewsArticle[]): NewsArticle[] {
    const seen = new Set<string>();
    return articles.filter(a => {
      if (seen.has(a.url) || this.seenUrls.has(a.url)) return false;
      seen.add(a.url);
      return true;
    });
  }

  /**
   * Refresh entity cache from active markets in DB.
   */
  async refreshMarkets(): Promise<void> {
    try {
      const result = await query<{ id: string; question: string }>(
        `SELECT id, question FROM markets
         WHERE is_active = true AND is_resolved = false
           AND COALESCE(tracking_status, 'active') != 'cold'
         ORDER BY volume_24h DESC LIMIT 50`
      );
      this.entityMatcher.setMarkets(result.rows);
    } catch (error) {
      logger.error({ error }, 'Failed to refresh markets for entity matching');
    }
  }

  /**
   * Main collection cycle. Returns number of new signals written.
   */
  async collect(): Promise<number> {
    // 1. Refresh market entities
    await this.refreshMarkets();

    // 2. Fetch from all sources
    const [rssArticles, finnhubArticles] = await Promise.all([
      this.rssSource.fetchAll(),
      this.finnhubSource.fetchAll(),
    ]);

    const allArticles = [...rssArticles, ...finnhubArticles];
    logger.info({ rss: rssArticles.length, finnhub: finnhubArticles.length }, 'Fetched news articles');

    // 3. Dedup
    const newArticles = this.dedup(allArticles);
    if (newArticles.length === 0) {
      logger.debug('No new articles found');
      return 0;
    }

    logger.info({ new: newArticles.length, total: allArticles.length }, 'New articles after dedup');

    // 4. Score sentiment + match to markets + write signals
    let signalsWritten = 0;

    for (const article of newArticles) {
      // Score sentiment (AFINN for RSS, Finnhub has its own)
      const sentiment = article.source === 'finnhub'
        ? 0  // Finnhub sentiment comes via metadata, handled separately
        : this.sentimentScorer.score(article.title);

      // Store article
      try {
        await query(
          `INSERT INTO news_articles (time, source, title, url, category, raw_sentiment, metadata)
           VALUES (NOW(), $1, $2, $3, $4, $5, $6)
           ON CONFLICT (url) DO NOTHING`,
          [article.source, article.title, article.url, article.category, sentiment, JSON.stringify({})]
        );
        this.seenUrls.add(article.url);
      } catch (error) {
        // Dedup collision — skip
        continue;
      }

      // Match against markets
      const matches = this.entityMatcher.matchHeadline(article.title);

      for (const match of matches) {
        // Determine direction: positive sentiment + direct mention = LONG
        // Negative sentiment + direct mention = SHORT
        // Competitor mention flips direction
        let direction: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
        if (sentiment > 0.1) direction = match.isCompetitorMention ? 'SHORT' : 'LONG';
        else if (sentiment < -0.1) direction = match.isCompetitorMention ? 'LONG' : 'SHORT';

        const signalValue = sentiment * (match.isCompetitorMention ? -1 : 1);
        const confidence = match.relevanceScore * Math.min(1, Math.abs(sentiment) + 0.3);

        try {
          await query(
            `INSERT INTO external_signals (market_id, source, signal_type, value, confidence, metadata)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              match.marketId,
              'news_pipeline',
              'sentiment',
              signalValue,
              confidence,
              JSON.stringify({
                articleCount: 1,
                headline: article.title,
                url: article.url,
                direction,
                relevance: match.relevanceScore,
                matchedEntities: match.matchedEntities,
                isCompetitor: match.isCompetitorMention,
              }),
            ]
          );
          signalsWritten++;
        } catch (error) {
          logger.warn({ error, marketId: match.marketId }, 'Failed to write news signal');
        }
      }
    }

    logger.info({ signalsWritten, articlesProcessed: newArticles.length }, 'News collection cycle complete');

    // Trim seenUrls to prevent memory leak (keep last 5000)
    if (this.seenUrls.size > 5000) {
      const arr = [...this.seenUrls];
      this.seenUrls = new Set(arr.slice(-3000));
    }

    return signalsWritten;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/data-collector/src/collectors/NewsCollector.test.ts`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add packages/data-collector/src/collectors/NewsCollector.ts packages/data-collector/src/collectors/NewsCollector.test.ts
git commit -m "feat: add NewsCollector orchestrator — fetch, score, match, write signals"
```

---

### Task 8: Wire into Scheduler + index.ts

**Files:**
- Modify: `packages/data-collector/src/services/Scheduler.ts:40-54`
- Modify: `packages/data-collector/src/index.ts`

- [ ] **Step 1: Add NewsCollector import and cron job to Scheduler**

In `Scheduler.ts`, add import at top:

```typescript
import { NewsCollector } from '../collectors/NewsCollector.js';
```

Add property to class:

```typescript
  private newsCollector: NewsCollector;
```

In constructor, initialize and add job after existing jobs (after line 54):

```typescript
    this.newsCollector = new NewsCollector();
    this.defineJob('collect-news', '*/15 * * * *', this.collectNews.bind(this));  // Every 15 minutes
```

Add the handler method:

```typescript
  private async collectNews(): Promise<void> {
    const signalsWritten = await this.newsCollector.collect();
    logger.info({ signalsWritten }, 'News collection completed');
  }
```

- [ ] **Step 2: Run all tests**

Run: `cd /c/Users/Usuario/GitHub/polymarket-trader && npx vitest run`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add packages/data-collector/src/services/Scheduler.ts
git commit -m "feat: add news collection cron job every 15 minutes"
```

---

### Task 9: Deploy and verify

- [ ] **Step 1: Push**

```bash
gh auth switch --user JaviMaligno
git push origin main
```

- [ ] **Step 2: Deploy to VM**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="cd /home/Usuario/polymarket-trader && git pull && docker compose -f docker-compose.gcp.yml pull && docker compose -f docker-compose.gcp.yml up -d --remove-orphans"
```

- [ ] **Step 3: Verify news collection running**

Wait ~15 minutes, then:

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker logs polymarket-data-collector 2>&1 | grep -i 'news\|Fetched.*articles\|signals.*written' | tail -10"
```

Expected: Log lines showing article fetches and signal writes.

- [ ] **Step 4: Verify articles in DB**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c 'SELECT source, category, count(*) FROM news_articles GROUP BY source, category;'"
```

Expected: Rows for google_rss with various categories.

- [ ] **Step 5: Verify signals in external_signals**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"SELECT market_id, value, confidence, metadata->>'headline' as headline FROM external_signals WHERE source = 'news_pipeline' ORDER BY fetched_at DESC LIMIT 5;\""
```

Expected: Signals matched to markets with headlines.

- [ ] **Step 6: Verify NewsSentimentGenerator active**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker compose -f /home/Usuario/polymarket-trader/docker-compose.gcp.yml logs --tail=50 dashboard-api 2>&1 | grep -i 'news_sentiment\|newsSentiment'"
```

Expected: No longer in "Skipped for inactive generators" list.
