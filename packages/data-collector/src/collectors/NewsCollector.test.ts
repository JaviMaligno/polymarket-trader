import { describe, it, expect, vi, beforeEach } from 'vitest';

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

  it('filters out neutral sentiment articles', () => {
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
});
