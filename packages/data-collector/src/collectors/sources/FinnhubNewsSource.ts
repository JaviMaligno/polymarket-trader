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
