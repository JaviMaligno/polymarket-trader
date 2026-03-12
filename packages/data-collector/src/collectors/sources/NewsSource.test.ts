import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));

vi.mock('axios', () => ({
  default: {
    get: mockGet,
  },
}));

import { NewsSource } from './NewsSource.js';

describe('NewsSource', () => {
  let source: NewsSource;

  beforeEach(() => {
    mockGet.mockReset();
    source = new NewsSource('test-api-key');
  });

  it('fetchHeadlines parses GNews API response correctly', async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        articles: [
          {
            title: 'Bitcoin surges to new high',
            description: 'Crypto market gains momentum',
            source: { name: 'CryptoNews' },
            publishedAt: '2026-03-12T10:00:00Z',
            url: 'https://example.com/article1',
          },
          {
            title: 'Ethereum gains ground',
            description: 'Second largest crypto advances',
            source: { name: 'CoinDesk' },
            publishedAt: '2026-03-12T09:00:00Z',
            url: 'https://example.com/article2',
          },
        ],
      },
    });

    const articles = await source.fetchHeadlines(['bitcoin'], 2);

    expect(articles).toHaveLength(2);
    expect(articles[0]).toEqual({
      title: 'Bitcoin surges to new high',
      description: 'Crypto market gains momentum',
      source: 'CryptoNews',
      publishedAt: new Date('2026-03-12T10:00:00Z'),
      url: 'https://example.com/article1',
    });
    expect(articles[1]).toEqual({
      title: 'Ethereum gains ground',
      description: 'Second largest crypto advances',
      source: 'CoinDesk',
      publishedAt: new Date('2026-03-12T09:00:00Z'),
      url: 'https://example.com/article2',
    });
  });

  it('fetchHeadlines returns empty array on API error', async () => {
    mockGet.mockRejectedValueOnce(new Error('Network error'));

    const articles = await source.fetchHeadlines(['bitcoin']);

    expect(articles).toEqual([]);
  });

  it('fetchHeadlines returns empty array when daily limit reached', async () => {
    // Exhaust the limit (dailyLimit = 50)
    for (let i = 0; i < 50; i++) {
      mockGet.mockResolvedValueOnce({ data: { articles: [] } });
      await source.fetchHeadlines([`query${i}`]);
    }
    // Next call should short-circuit without hitting axios
    mockGet.mockReset();
    const articles = await source.fetchHeadlines(['overflow']);
    expect(articles).toEqual([]);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('scoreSentiment returns positive score for positive headlines', () => {
    const articles = [
      {
        title: 'Bitcoin wins approval',
        description: 'Crypto gains support from regulators',
        source: 'CryptoNews',
        publishedAt: new Date(),
        url: 'https://example.com/1',
      },
      {
        title: 'Ethereum advances strongly',
        description: 'Market surges on good news',
        source: 'CoinDesk',
        publishedAt: new Date(),
        url: 'https://example.com/2',
      },
    ];

    const score = source.scoreSentiment(articles);
    expect(score).toBeGreaterThan(0);
  });

  it('scoreSentiment returns negative score for negative headlines', () => {
    const articles = [
      {
        title: 'Bitcoin crash deepens',
        description: 'Market declines sharply',
        source: 'CryptoNews',
        publishedAt: new Date(),
        url: 'https://example.com/1',
      },
      {
        title: 'Ethereum drops further',
        description: 'Regulators blocks crypto growth',
        source: 'CoinDesk',
        publishedAt: new Date(),
        url: 'https://example.com/2',
      },
    ];

    const score = source.scoreSentiment(articles);
    expect(score).toBeLessThan(0);
  });

  it('scoreSentiment returns 0 for empty array', () => {
    const score = source.scoreSentiment([]);
    expect(score).toBe(0);
  });
});
