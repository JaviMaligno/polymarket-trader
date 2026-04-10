import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('rss-parser', () => {
  const MockParser = vi.fn(function (this: Record<string, unknown>) {
    this.parseURL = vi.fn();
  });
  return { default: MockParser };
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
