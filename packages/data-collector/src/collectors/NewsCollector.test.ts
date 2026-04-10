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
});
