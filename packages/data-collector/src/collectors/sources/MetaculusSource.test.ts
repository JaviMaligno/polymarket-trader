import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGet = vi.fn();

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => ({ get: mockGet })),
  },
}));

import { MetaculusSource } from './MetaculusSource.js';

describe('MetaculusSource', () => {
  let source: MetaculusSource;

  beforeEach(() => {
    mockGet.mockReset();
    source = new MetaculusSource();
  });

  it('parses Metaculus API response correctly', async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        results: [
          {
            id: 42,
            title: 'Will X happen by 2027?',
            community_prediction: { full: { q2: 0.72 } },
          },
          {
            id: 99,
            title: 'Will Y happen?',
            community_prediction: null,
          },
        ],
      },
    });

    const results = await source.fetchActiveQuestions(2);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      id: '42',
      question: 'Will X happen by 2027?',
      platform: 'metaculus',
      probability: 0.72,
      fetchedAt: expect.any(Date),
    });
    expect(results[1]).toEqual({
      id: '99',
      question: 'Will Y happen?',
      platform: 'metaculus',
      probability: null,
      fetchedAt: expect.any(Date),
    });
  });

  it('returns empty array on API error', async () => {
    mockGet.mockRejectedValueOnce(new Error('Network error'));

    const results = await source.fetchActiveQuestions();

    expect(results).toEqual([]);
  });

  it('returns null from fetchQuestionById on error', async () => {
    mockGet.mockRejectedValueOnce(new Error('Not found'));

    const result = await source.fetchQuestionById('123');

    expect(result).toBeNull();
  });
});
