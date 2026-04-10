import { pino } from 'pino';
import { GoogleNewsRSSSource, type NewsArticle } from './sources/GoogleNewsRSSSource.js';
import { FinnhubNewsSource } from './sources/FinnhubNewsSource.js';
import { SentimentScorer } from './sources/SentimentScorer.js';
import { EntityMatcher } from './sources/EntityMatcher.js';
import { query } from '../database/connection.js';

const logger = pino({ name: 'news-collector' });

const MAX_SEEN_URLS = 5000;

export class NewsCollector {
  private rssSource: GoogleNewsRSSSource;
  private finnhubSource: FinnhubNewsSource;
  private scorer: SentimentScorer;
  private matcher: EntityMatcher;
  private seenUrls: Set<string> = new Set();

  constructor() {
    this.rssSource = new GoogleNewsRSSSource();
    this.finnhubSource = new FinnhubNewsSource(process.env.FINNHUB_API_KEY || '');
    this.scorer = new SentimentScorer();
    this.matcher = new EntityMatcher();
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
        `SELECT id, question FROM markets WHERE is_active = true`
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

    // Step 4: score, store, match, write signals
    let signalCount = 0;

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

        // Match against markets
        const matches = this.matcher.matchHeadline(article.title);

        for (const match of matches) {
          // Direction logic: positive sentiment + direct mention = LONG
          // negative sentiment = SHORT, competitor mention flips it
          const adjustedSentiment = sentiment * (match.isCompetitorMention ? -1 : 1);
          const direction = adjustedSentiment >= 0 ? 'LONG' : 'SHORT';

          // Signal value = sentiment * (competitor ? -1 : 1)
          const signalValue = adjustedSentiment;

          // Confidence = relevanceScore * min(1, abs(sentiment) + 0.3)
          const confidence = match.relevanceScore * Math.min(1, Math.abs(sentiment) + 0.3);

          const metadata = {
            articleCount: 1,
            headline: article.title,
            url: article.url,
            direction,
            relevance: match.relevanceScore,
            matchedEntities: match.matchedEntities,
            isCompetitor: match.isCompetitorMention,
          };

          await query(
            `INSERT INTO external_signals (market_id, source, signal_type, signal_value, confidence, direction, metadata, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
            [
              match.marketId,
              'news_pipeline',
              'sentiment',
              signalValue,
              confidence,
              direction,
              JSON.stringify(metadata),
            ]
          );

          signalCount++;
        }
      } catch (error) {
        logger.error({ error, url: article.url }, 'Failed to process article');
      }
    }

    logger.info({ signalCount, articlesProcessed: newArticles.length }, 'News collection cycle complete');
    return signalCount;
  }
}
