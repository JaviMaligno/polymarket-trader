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
    const topicMap: Record<string, string> = {
      sports: 'CAAqJggKIiBDQkFTRWdvSUwyMHZNRFp1ZEdvU0FtVnVHZ0pWVXlnQVAB',
      world: 'CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx1YlY4U0FtVnVHZ0pWVXlnQVAB',
      business: 'CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtVnVHZ0pWVXlnQVAB',
      technology: 'CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0FtVnVHZ0pWVXlnQVAB',
      entertainment: 'CAAqJggKIiBDQkFTRWdvSUwyMHZNREpxYW5RU0FtVnVHZ0pWVXlnQVAB',
    };
    const topic = topicMap[category] || topicMap.world;
    return `https://news.google.com/rss/topics/${topic}?hl=en-US&gl=US&ceid=US:en&topic=${category}`;
  }

  parseItem(item: Record<string, unknown>, category: string): NewsArticle {
    return {
      title: (item.title as string) || '',
      url: (item.link as string) || (item.guid as string) || '',
      publishedAt: item.pubDate ? new Date(item.pubDate as string) : new Date(),
      source: 'google_rss',
      category,
      description: (item.contentSnippet as string) || (item.content as string) || undefined,
    };
  }

  async fetchCategory(category: Category | string): Promise<NewsArticle[]> {
    try {
      const url = this.buildFeedUrl(category);
      const feed = await this.parser.parseURL(url);
      const articles = (feed.items || []).map(item => this.parseItem(item as Record<string, unknown>, category));
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
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return results;
  }
}
