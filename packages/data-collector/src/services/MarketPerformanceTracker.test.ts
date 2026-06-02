import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { computePrior, MIN_CATEGORY_TRADES } from './MarketPerformanceTracker.js';

vi.mock('../database/connection.js', () => ({
  query: vi.fn(),
}));

import { query } from '../database/connection.js';
import { updateShadowCategoryPerformance, materializePredictionOutcomes } from './MarketPerformanceTracker.js';

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

describe('materializePredictionOutcomes', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('materializes a matured prediction with a forward price', async () => {
    const inserts: any[][] = [];
    (query as any).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM generator_predictions g')) {
        return { rows: [{
          id: '101', time: new Date('2026-06-02T00:00:00Z'), market_id: 'm1',
          market_type: 'event_short', signal_id: 'momentum', direction: 'long',
          yes_price_at_signal: '0.40', age_hours: '6',
        }]};
      }
      if (sql.includes('FROM price_history')) {
        return { rows: [{ close: 0.47 }] };
      }
      if (sql.startsWith('INSERT INTO generator_prediction_outcomes')) {
        inserts.push(params ?? []);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await materializePredictionOutcomes();
    expect(res.materialized).toBe(1);
    expect(res.noPrice).toBe(0);
    expect(inserts).toHaveLength(1);
    expect(inserts[0][0]).toBe('101');
    expect(inserts[0][7]).toBe(0.47);          // y1
    expect(inserts[0][9]).toBe(false);         // no_forward_price
  });

  it('marks no_forward_price=true when matured >8h with no forward price', async () => {
    const inserts: any[][] = [];
    (query as any).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM generator_predictions g')) {
        return { rows: [{
          id: '102', time: new Date('2026-06-01T00:00:00Z'), market_id: 'm2',
          market_type: 'event_long', signal_id: 'ofi', direction: 'short',
          yes_price_at_signal: '0.30', age_hours: '20',
        }]};
      }
      if (sql.includes('FROM price_history')) return { rows: [] };
      if (sql.startsWith('INSERT INTO generator_prediction_outcomes')) {
        inserts.push(params ?? []);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await materializePredictionOutcomes();
    expect(res.materialized).toBe(0);
    expect(res.noPrice).toBe(1);
    expect(inserts[0][7]).toBe(null);          // y1
    expect(inserts[0][9]).toBe(true);          // no_forward_price
  });

  it('skips a matured-but-young prediction (<8h) with no price yet (retried later)', async () => {
    const inserts: any[][] = [];
    (query as any).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM generator_predictions g')) {
        return { rows: [{
          id: '103', time: new Date('2026-06-02T06:00:00Z'), market_id: 'm3',
          market_type: 'event_short', signal_id: 'hawkes', direction: 'long',
          yes_price_at_signal: '0.50', age_hours: '6',
        }]};
      }
      if (sql.includes('FROM price_history')) return { rows: [] };
      if (sql.startsWith('INSERT INTO generator_prediction_outcomes')) {
        inserts.push(params ?? []);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await materializePredictionOutcomes();
    expect(res.materialized).toBe(0);
    expect(res.noPrice).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it('a failing forward-seek does not abort the batch', async () => {
    let inserts = 0;
    (query as any).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM generator_predictions g')) {
        return { rows: [
          { id: '201', time: new Date('2026-06-02T00:00:00Z'), market_id: 'mA', market_type: 'event_short', signal_id: 's', direction: 'long', yes_price_at_signal: '0.4', age_hours: '6' },
          { id: '202', time: new Date('2026-06-02T00:00:00Z'), market_id: 'mB', market_type: 'event_short', signal_id: 's', direction: 'long', yes_price_at_signal: '0.4', age_hours: '6' },
        ]};
      }
      if (sql.includes('FROM price_history')) {
        throw new Error('simulated seek failure');
      }
      if (sql.startsWith('INSERT INTO generator_prediction_outcomes')) { inserts++; return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    });
    await expect(materializePredictionOutcomes()).resolves.toBeDefined();
    expect(inserts).toBe(0);
  });
});
