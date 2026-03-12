import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGet = vi.fn();

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => ({ get: mockGet })),
  },
}));

import { ManifoldSource } from './ManifoldSource.js';

describe('ManifoldSource', () => {
  let source: ManifoldSource;

  beforeEach(() => {
    mockGet.mockReset();
    source = new ManifoldSource();
  });

  it('parses Manifold API response correctly', async () => {
    mockGet.mockResolvedValueOnce({
      data: [
        {
          id: 'abc123',
          question: 'Will Z win the election?',
          outcomeType: 'BINARY',
          probability: 0.55,
        },
      ],
    });

    const results = await source.fetchActiveMarkets(1);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      id: 'abc123',
      question: 'Will Z win the election?',
      platform: 'manifold',
      probability: 0.55,
      fetchedAt: expect.any(Date),
    });
  });

  it('filters out non-BINARY markets', async () => {
    mockGet.mockResolvedValueOnce({
      data: [
        {
          id: 'm1',
          question: 'Binary market',
          outcomeType: 'BINARY',
          probability: 0.4,
        },
        {
          id: 'm2',
          question: 'Multiple choice market',
          outcomeType: 'MULTIPLE_CHOICE',
          probability: null,
        },
        {
          id: 'm3',
          question: 'Free response market',
          outcomeType: 'FREE_RESPONSE',
          probability: 0.1,
        },
      ],
    });

    const results = await source.fetchActiveMarkets(3);

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('m1');
  });

  it('returns empty array on API error', async () => {
    mockGet.mockRejectedValueOnce(new Error('Service unavailable'));

    const results = await source.fetchActiveMarkets();

    expect(results).toEqual([]);
  });
});
