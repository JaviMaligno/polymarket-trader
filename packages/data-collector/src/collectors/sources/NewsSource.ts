import axios from 'axios';
import { pino } from 'pino';

const logger = pino({ name: 'news-source' });

export interface NewsArticle {
  title: string;
  description: string;
  source: string;
  publishedAt: Date;
  url: string;
}

const POSITIVE_WORDS = new Set([
  'wins', 'passes', 'approved', 'rises', 'confirms', 'gains',
  'leads', 'victory', 'success', 'surges', 'advances', 'agrees', 'supports',
]);

const NEGATIVE_WORDS = new Set([
  'loses', 'fails', 'rejected', 'falls', 'denies', 'drops',
  'trails', 'defeat', 'crash', 'declines', 'opposes', 'blocks', 'cancels',
]);

export class NewsSource {
  private apiKey: string;
  private readonly baseUrl = 'https://gnews.io/api/v4';
  private dailyRequestCount = 0;
  private readonly dailyLimit = 50;
  private lastResetDate: string = new Date().toDateString();

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async fetchHeadlines(keywords: string[], maxResults = 5): Promise<NewsArticle[]> {
    this.resetIfNewDay();

    if (this.dailyRequestCount >= this.dailyLimit) {
      return [];
    }

    try {
      const response = await axios.get(`${this.baseUrl}/search`, {
        params: {
          q: keywords.join(' '),
          lang: 'en',
          max: maxResults,
          token: this.apiKey,
        },
        timeout: 10000,
      });

      const articles: unknown[] = response.data?.articles ?? [];
      const mapped: NewsArticle[] = articles.map((a: any) => ({
        title: a.title,
        description: a.description,
        source: a.source?.name ?? '',
        publishedAt: new Date(a.publishedAt),
        url: a.url,
      }));

      this.dailyRequestCount += 1;
      return mapped;
    } catch (error) {
      logger.error({ error }, 'Error fetching news headlines');
      return [];
    }
  }

  scoreSentiment(articles: NewsArticle[]): number {
    if (articles.length === 0) return 0;

    let total = 0;
    for (const article of articles) {
      const text = `${article.title} ${article.description}`.toLowerCase();
      const tokens = text.split(/\s+/);
      let positiveCount = 0;
      let negativeCount = 0;
      for (const token of tokens) {
        // Strip non-alpha chars for matching
        const word = token.replace(/[^a-z]/g, '');
        if (POSITIVE_WORDS.has(word)) positiveCount++;
        if (NEGATIVE_WORDS.has(word)) negativeCount++;
      }
      const diff = positiveCount - negativeCount;
      if (diff > 0) total += 1;
      else if (diff < 0) total -= 1;
    }

    return total / articles.length;
  }

  getRemainingRequests(): number {
    this.resetIfNewDay();
    return this.dailyLimit - this.dailyRequestCount;
  }

  private resetIfNewDay(): void {
    const today = new Date().toDateString();
    if (today !== this.lastResetDate) {
      this.dailyRequestCount = 0;
      this.lastResetDate = today;
    }
  }
}
