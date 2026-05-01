import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { computePrior, MIN_CATEGORY_TRADES } from './MarketPerformanceTracker.js';

vi.mock('../database/connection.js', () => ({
  query: vi.fn(),
}));

import { query } from '../database/connection.js';
import { updateShadowCategoryPerformance } from './MarketPerformanceTracker.js';

describe('computePrior', () => {
  it('returns 1.0 for sharpe = 0 (neutral)', () => {
    expect(computePrior(0)).toBeCloseTo(1.0);
  });

  it('returns ~0.5 for very negative sharpe', () => {
    expect(computePrior(-10)).toBeCloseTo(0.5, 1);
  });

  it('returns ~1.5 for very positive sharpe', () => {
    expect(computePrior(10)).toBeCloseTo(1.5, 1);
  });

  it('is bounded to [0.5, 1.5]', () => {
    expect(computePrior(-100)).toBeGreaterThanOrEqual(0.5);
    expect(computePrior(100)).toBeLessThanOrEqual(1.5);
  });

  it('is monotonically increasing', () => {
    expect(computePrior(-1)).toBeLessThan(computePrior(0));
    expect(computePrior(0)).toBeLessThan(computePrior(1));
  });
});

describe('MIN_CATEGORY_TRADES', () => {
  it('is 5', () => {
    expect(MIN_CATEGORY_TRADES).toBe(5);
  });
});

describe('updateShadowCategoryPerformance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SHADOW_HAIRCUT;
    delete process.env.CATEGORY_MIN_SHADOW_N;
  });
  afterEach(() => {
    delete process.env.SHADOW_HAIRCUT;
    delete process.env.CATEGORY_MIN_SHADOW_N;
  });

  it('applies default haircut 0.33 to raw shadow Sharpe before upsert', async () => {
    (query as any)
      .mockResolvedValueOnce({  // SELECT
        rows: [
          { market_type: 'event_short', n_trades: '444', win_rate: '0.5',
            avg_pnl: '383', raw_sharpe: '2.03' },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });  // INSERT

    await updateShadowCategoryPerformance();

    expect(query).toHaveBeenCalledTimes(2);
    const insertCall = (query as any).mock.calls[1];
    const insertSql = insertCall[0] as string;
    const insertParams = insertCall[1] as unknown[];
    expect(insertSql).toMatch(/INSERT INTO category_performance_shadow/);
    expect(insertSql).toMatch(/ON CONFLICT \(market_type\) DO UPDATE/);
    // Param order: (market_type, win_rate, avg_pnl, sharpe_ratio, n_trades, prior, haircut_applied)
    expect(insertParams[0]).toBe('event_short');
    expect(insertParams[3]).toBeCloseTo(2.03 * 0.33, 4);
    expect(insertParams[4]).toBe(444);
    expect(insertParams[6]).toBeCloseTo(0.33, 4);
  });

  it('skips upsert when n_trades < CATEGORY_MIN_SHADOW_N (default 30)', async () => {
    (query as any).mockResolvedValueOnce({
      rows: [
        { market_type: 'crypto_intraday', n_trades: '20', win_rate: '0.5',
          avg_pnl: '5', raw_sharpe: '0.4' },
      ],
    });
    await updateShadowCategoryPerformance();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('honors SHADOW_HAIRCUT env var override', async () => {
    process.env.SHADOW_HAIRCUT = '0.5';
    (query as any)
      .mockResolvedValueOnce({
        rows: [
          { market_type: 'event_short', n_trades: '444', win_rate: '0.5',
            avg_pnl: '383', raw_sharpe: '2.0' },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    await updateShadowCategoryPerformance();

    const insertCall = (query as any).mock.calls[1];
    const insertParams = insertCall[1] as unknown[];
    expect(insertParams[3]).toBeCloseTo(2.0 * 0.5, 4);
    expect(insertParams[6]).toBeCloseTo(0.5, 4);
  });

  it('honors CATEGORY_MIN_SHADOW_N env var override', async () => {
    process.env.CATEGORY_MIN_SHADOW_N = '10';
    (query as any)
      .mockResolvedValueOnce({
        rows: [
          { market_type: 'event_short', n_trades: '15', win_rate: '0.5',
            avg_pnl: '50', raw_sharpe: '0.4' },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    await updateShadowCategoryPerformance();

    expect(query).toHaveBeenCalledTimes(2);
  });
});
