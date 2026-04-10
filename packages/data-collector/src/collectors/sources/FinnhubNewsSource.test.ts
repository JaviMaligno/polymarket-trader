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
