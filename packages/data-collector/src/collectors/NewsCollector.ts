import { pino } from 'pino';
import { GoogleNewsRSSSource, type NewsArticle } from './sources/GoogleNewsRSSSource.js';
import { FinnhubNewsSource } from './sources/FinnhubNewsSource.js';
import { SentimentScorer } from './sources/SentimentScorer.js';
import { EntityMatcher, type HeadlineMatch } from './sources/EntityMatcher.js';
import { AnthropicProvider, type LLMProvider, type Headline, type Market } from './sources/LLMProvider.js';
import { BudgetTracker } from './sources/BudgetTracker.js';
import { query } from '../database/connection.js';

const logger = pino({ name: 'news-collector' });

const MAX_SEEN_URLS = 5000;
const MIN_SENTIMENT = 0.05;
const LLM_DISABLE_DURATION_MS = 60 * 60 * 1000; // 1 hour
const MAX_CONSECUTIVE_LLM_FAILURES = 3;

export class NewsCollector {
  private rssSource: GoogleNewsRSSSource;
  private finnhubSource: FinnhubNewsSource;
  private scorer: SentimentScorer;
  private matcher: EntityMatcher;
  private seenUrls: Set<string> = new Set();
  private llmProvider: LLMProvider | null;
  private budgetTracker: BudgetTracker;
  private consecutiveLLMFailures = 0;
  private llmDisabledUntil = 0;

  constructor() {
    this.rssSource = new GoogleNewsRSSSource();
    this.finnhubSource = new FinnhubNewsSource(process.env.FINNHUB_API_KEY || '');
    this.scorer = new SentimentScorer();
    this.matcher = new EntityMatcher();

    const anthropicKey = process.env.ANTHROPIC_API_KEY || '';
    const provider = new AnthropicProvider(anthropicKey);
    this.llmProvider = provider.isAvailable() ? provider : null;
    this.budgetTracker = new BudgetTracker();
    logger.info({ llmAvailable: this.llmProvider !== null, keyLength: anthropicKey.length }, 'NewsCollector initialized');
  }

  /**
   * Deduplicate articles by URL, also filtering out previously seen URLs.
   */
  dedup(articles: NewsArticle[]): NewsArticle[] {
    const seen = new Set<string>();
    const result: NewsArticle[] = [];

    for (const article of articles) {
      if (!article.url) continue;
      if (seen.has(article.url)) continue;
      if (this.seenUrls.has(article.url)) continue;
      seen.add(article.url);
      result.push(article);
    }

    return result;
  }

  /**
   * Query active markets from DB and update the entity matcher cache.
   */
  async refreshMarkets(): Promise<void> {
    try {
      const result = await query<{ id: string; question: string }>(
        `SELECT id, question FROM markets
         WHERE is_active = true AND is_resolved = false
           AND COALESCE(tracking_status, 'active') IN ('active', 'hot', 'warming')
         ORDER BY volume_24h DESC NULLS LAST LIMIT 50`
      );
      this.matcher.setMarkets(result.rows);
      logger.info({ marketCount: result.rows.length }, 'Refreshed market entities');
    } catch (error) {
      logger.error({ error }, 'Failed to refresh markets');
    }
  }

  /**
   * Orchestrate the full news collection cycle:
   * 1. Refresh market entities from DB
   * 2. Fetch from all sources in parallel
   * 3. Dedup new articles
   * 4. Score sentiment, store articles, match markets, write signals
   * Returns the count of external_signals written.
   */
  async collect(): Promise<number> {
    // Step 1: refresh market entities
    await this.refreshMarkets();

    // Step 2: fetch from all sources in parallel
    const [rssArticles, finnhubArticles] = await Promise.all([
      this.rssSource.fetchAll().catch((err) => {
        logger.error({ err }, 'RSS fetch failed');
        return [] as NewsArticle[];
      }),
      this.finnhubSource.fetchAll().catch((err) => {
        logger.error({ err }, 'Finnhub fetch failed');
        return [] as NewsArticle[];
      }),
    ]);

    const allArticles = [...rssArticles, ...finnhubArticles];
    logger.info(
      { rss: rssArticles.length, finnhub: finnhubArticles.length, total: allArticles.length },
      'Fetched articles from all sources'
    );

    // Step 3: dedup
    const newArticles = this.dedup(allArticles);
    if (newArticles.length === 0) {
      logger.info('No new articles after dedup');
      return 0;
    }

    logger.info({ newCount: newArticles.length }, 'New articles after dedup');

    // Mark all new URLs as seen
    for (const article of newArticles) {
      this.seenUrls.add(article.url);
    }

    // Trim seenUrls to prevent memory leak
    if (this.seenUrls.size > MAX_SEEN_URLS) {
      const excess = this.seenUrls.size - MAX_SEEN_URLS;
      const iter = this.seenUrls.values();
      for (let i = 0; i < excess; i++) {
        this.seenUrls.delete(iter.next().value!);
      }
    }

    // Step 4: score, store, collect LLM candidates
    let signalCount = 0;

    // Candidates for LLM evaluation: articles with non-neutral sentiment and entity matches
    interface LLMCandidate {
      article: NewsArticle;
      sentiment: number;
      matches: HeadlineMatch[];
    }
    const llmCandidates: LLMCandidate[] = [];

    for (const article of newArticles) {
      try {
        const sentiment = this.scorer.score(article.title);

        // Store in news_articles (dedup by url — ON CONFLICT not supported on hypertable without time, use catch)
        await query(
          `INSERT INTO news_articles (time, source, title, url, category, raw_sentiment, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            article.publishedAt,
            article.source,
            article.title,
            article.url,
            article.category,
            sentiment,
            JSON.stringify({ description: article.description || null }),
          ]
        );

        // Filter out neutral sentiment
        if (Math.abs(sentiment) < MIN_SENTIMENT) continue;

        // Match against markets
        const matches = this.matcher.matchHeadline(article.title);
        if (matches.length === 0) continue;

        logger.info({ headline: article.title.substring(0, 80), matchCount: matches.length, markets: matches.map(m => m.marketId) }, 'Headline matched markets');

        llmCandidates.push({ article, sentiment, matches });
      } catch (error) {
        logger.error({ error, url: article.url }, 'Failed to process article');
      }
    }

    if (llmCandidates.length === 0) {
      logger.info({ articlesProcessed: newArticles.length }, 'No LLM candidates after filtering');
      return 0;
    }

    // Step 5: attempt LLM evaluation or fallback to AFINN
    const shouldUseLLM = this.llmProvider != null
      && this.budgetTracker.canSpend()
      && Date.now() > this.llmDisabledUntil;

    logger.info({
      shouldUseLLM,
      hasProvider: this.llmProvider != null,
      canSpend: this.budgetTracker.canSpend(),
      notDisabled: Date.now() > this.llmDisabledUntil,
      candidates: llmCandidates.length,
    }, 'LLM decision');

    let usedLLM = false;

    if (shouldUseLLM) {
      try {
        // Build headline and market arrays for LLM
        const headlineMap = new Map<string, LLMCandidate>();
        const headlines: Headline[] = [];
        const marketMap = new Map<string, Market>();
        const markets: Market[] = [];

        for (const candidate of llmCandidates) {
          const hId = candidate.article.url;
          if (!headlineMap.has(hId)) {
            headlineMap.set(hId, candidate);
            headlines.push({ id: hId, title: candidate.article.title });
          }
          for (const match of candidate.matches) {
            if (!marketMap.has(match.marketId)) {
              const mkt: Market = { id: match.marketId, question: '', currentPrice: 0.5 };
              marketMap.set(match.marketId, mkt);
              markets.push(mkt);
            }
          }
        }

        // Fetch market questions/prices for the LLM
        if (markets.length > 0) {
          const marketIds = markets.map(m => m.id);
          const res = await query<{ id: string; question: string }>(
            `SELECT id, question FROM markets WHERE id = ANY($1)`,
            [marketIds]
          );
          for (const row of res.rows) {
            const mkt = marketMap.get(row.id);
            if (mkt) mkt.question = row.question;
          }
        }

        logger.info({ headlines: headlines.length, markets: markets.length }, 'Sending batch to LLM');
        const result = await this.llmProvider!.evaluateHeadlines(headlines, markets);

        // Record budget usage
        this.budgetTracker.record(result.usage.inputTokens, result.usage.outputTokens);
        this.consecutiveLLMFailures = 0;

        // Write LLM-evaluated signals
        for (const evaluation of result.evaluations) {
          const candidate = headlineMap.get(evaluation.headlineId);
          if (!candidate) continue;

          const confidence = evaluation.impact * 0.8;
          const metadata = {
            articleCount: 1,
            headline: candidate.article.title,
            url: candidate.article.url,
            direction: evaluation.direction,
            match_method: 'llm_eval',
            impact: evaluation.impact,
            reasoning: evaluation.reasoning,
          };

          await query(
            `INSERT INTO external_signals (market_id, source, signal_type, value, confidence, metadata)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              evaluation.marketId,
              'news_pipeline',
              'sentiment',
              evaluation.direction === 'LONG' ? evaluation.impact : -evaluation.impact,
              confidence,
              JSON.stringify(metadata),
            ]
          );
          signalCount++;
        }

        usedLLM = true;
        logger.info({ signalCount, evaluations: result.evaluations.length }, 'LLM evaluation complete');
      } catch (error) {
        this.consecutiveLLMFailures++;
        logger.error({ error, failures: this.consecutiveLLMFailures }, 'LLM evaluation failed');
        if (this.consecutiveLLMFailures >= MAX_CONSECUTIVE_LLM_FAILURES) {
          this.llmDisabledUntil = Date.now() + LLM_DISABLE_DURATION_MS;
          logger.warn({ disabledUntil: new Date(this.llmDisabledUntil).toISOString() }, 'LLM disabled for 1 hour after consecutive failures');
        }
      }
    }

    // Fallback: write AFINN-based signals if LLM was not used or failed
    if (!usedLLM) {
      for (const candidate of llmCandidates) {
        for (const match of candidate.matches) {
          const adjustedSentiment = candidate.sentiment * (match.isCompetitorMention ? -1 : 1);
          const direction = adjustedSentiment >= 0 ? 'LONG' : 'SHORT';
          const signalValue = adjustedSentiment;

          // AFINN fallback: confidence halved
          const confidence = match.relevanceScore * Math.min(1, Math.abs(candidate.sentiment) + 0.3) * 0.5;

          const metadata = {
            articleCount: 1,
            headline: candidate.article.title,
            url: candidate.article.url,
            direction,
            relevance: match.relevanceScore,
            matchedEntities: match.matchedEntities,
            isCompetitor: match.isCompetitorMention,
            match_method: 'afinn_fallback',
          };

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
                JSON.stringify(metadata),
              ]
            );
            signalCount++;
          } catch (error) {
            logger.error({ error, marketId: match.marketId }, 'Failed to write AFINN fallback signal');
          }
        }
      }
      logger.info({ signalCount, method: 'afinn_fallback' }, 'AFINN fallback signals written');
    }

    logger.info({ signalCount, articlesProcessed: newArticles.length, usedLLM }, 'News collection cycle complete');
    return signalCount;
  }
}
