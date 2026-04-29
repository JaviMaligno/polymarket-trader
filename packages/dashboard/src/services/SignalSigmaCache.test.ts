import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../database/index.js', () => ({
  query: vi.fn(),
  isDatabaseConfigured: vi.fn(() => true),
}));

import { query } from '../database/index.js';
import { SignalSigmaCache } from './SignalSigmaCache.js';

describe('SignalSigmaCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 0.3 fallback for any marketType before refresh', () => {
    const cache = new SignalSigmaCache();
    expect(cache.getSigma('event_financial')).toBe(0.3);
    expect(cache.getSigma('crypto_intraday')).toBe(0.3);
    expect(cache.getSigma('totally_unknown')).toBe(0.3);
  });

  it('populates per-type sigma after refresh', async () => {
    (query as any).mockResolvedValueOnce({
      rows: [
        { market_type: 'event_financial', sigma: '0.353' },
        { market_type: 'crypto_intraday', sigma: '0.308' },
      ],
    });

    const cache = new SignalSigmaCache();
    await cache.refresh();

    expect(cache.getSigma('event_financial')).toBeCloseTo(0.353);
    expect(cache.getSigma('crypto_intraday')).toBeCloseTo(0.308);
    expect(cache.getSigma('event_long')).toBe(0.3); // not in result → fallback
  });

  it('keeps prior values if refresh throws', async () => {
    (query as any).mockResolvedValueOnce({
      rows: [{ market_type: 'event_financial', sigma: '0.353' }],
    });
    const cache = new SignalSigmaCache();
    await cache.refresh();

    (query as any).mockRejectedValueOnce(new Error('db down'));
    await cache.refresh(); // does not throw

    expect(cache.getSigma('event_financial')).toBeCloseTo(0.353);
  });

  it('ignores rows where sigma is null or non-positive', async () => {
    (query as any).mockResolvedValueOnce({
      rows: [
        { market_type: 'event_financial', sigma: '0.353' },
        { market_type: 'sparse_type', sigma: null },
        { market_type: 'zero_type', sigma: '0' },
      ],
    });
    const cache = new SignalSigmaCache();
    await cache.refresh();

    expect(cache.getSigma('event_financial')).toBeCloseTo(0.353);
    expect(cache.getSigma('sparse_type')).toBe(0.3); // null → fallback
    expect(cache.getSigma('zero_type')).toBe(0.3);   // 0 → fallback
  });
});
