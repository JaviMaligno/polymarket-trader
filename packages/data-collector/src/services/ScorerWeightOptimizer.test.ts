import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { pearsonCorrelation, computeObjective, MIN_TRADES, optimizeScorerWeights } from './ScorerWeightOptimizer.js';
import type { ScorerWeights } from './MarketScorer.js';

vi.mock('../database/connection.js', () => ({
  query: vi.fn(),
}));

import { query } from '../database/connection.js';

describe('pearsonCorrelation', () => {
  it('returns 1.0 for perfectly correlated series', () => {
    expect(pearsonCorrelation([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1.0);
  });

  it('returns -1.0 for perfectly inversely correlated series', () => {
    expect(pearsonCorrelation([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1.0);
  });

  it('returns 0 for constant series (no variance)', () => {
    expect(pearsonCorrelation([1, 1, 1], [1, 2, 3])).toBe(0);
  });

  it('returns 0 for empty arrays', () => {
    expect(pearsonCorrelation([], [])).toBe(0);
  });
});

describe('computeObjective', () => {
  const weights: ScorerWeights = {
    tradeability: 0.30, liquidity: 0.25, volatility: 0.20, ttr: 0.15, dataQuality: 0.10, typeExpectedValue: 0.20,
  };

  it('returns positive correlation when high-score trades have positive pnl', () => {
    const trades = [
      { dims: { tradeability: 1.0, liquidity: 0.8, ttr: 0.9, volatility: null, dataQuality: null, typeExpectedValue: 0.5 }, pnl: 10 },
      { dims: { tradeability: 0.1, liquidity: 0.1, ttr: 0.2, volatility: null, dataQuality: null, typeExpectedValue: 0.5 }, pnl: -5 },
      { dims: { tradeability: 0.8, liquidity: 0.7, ttr: 0.8, volatility: null, dataQuality: null, typeExpectedValue: 0.5 }, pnl: 7 },
    ];
    const result = computeObjective(weights, trades);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(1);
  });

  it('returns 0 when all pnl are identical (no variance)', () => {
    const trades = [
      { dims: { tradeability: 0.5, liquidity: 0.5, ttr: 0.5, volatility: null, dataQuality: null, typeExpectedValue: 0.5 }, pnl: 5 },
      { dims: { tradeability: 0.8, liquidity: 0.8, ttr: 0.8, volatility: null, dataQuality: null, typeExpectedValue: 0.5 }, pnl: 5 },
    ];
    expect(computeObjective(weights, trades)).toBe(0);
  });
});

describe('MIN_TRADES', () => {
  it('is 30', () => {
    expect(MIN_TRADES).toBe(30);
  });
});

describe('optimizeScorerWeights per-type', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('skips types with fewer than MIN_TRADES trades', async () => {
    (query as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT DISTINCT market_type FROM markets')) {
        return { rows: [{ market_type: 'crypto_daily' }] };
      }
      if (sql.includes('FROM paper_positions pp')) {
        // Regardless of filter, return empty — not enough trades
        return { rows: [] };
      }
      if (sql.startsWith('INSERT INTO scorer_weights')) {
        return { rowCount: 1, rows: [] };
      }
      return { rows: [], rowCount: 0 };
    });

    await optimizeScorerWeights();

    const inserts = (query as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).startsWith('INSERT INTO scorer_weights'),
    );
    // crypto_daily has no trades → skipped. Only the __global__ fallback attempted,
    // and since pooled is also empty, even global is skipped.
    expect(inserts.length).toBe(0);
  });

  it('runs optimization per eligible type and writes the global row', async () => {
    const syntheticTrades = Array.from({ length: 50 }, () => ({
      score_dimensions_at_entry: {
        tradeability: 0.5, liquidity: 0.5, ttr: 0.5, typeExpectedValue: 0.7,
      },
      realized_pnl: '10',
    }));

    (query as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT DISTINCT market_type FROM markets')) {
        return { rows: [{ market_type: 'event_long' }, { market_type: 'event_financial' }] };
      }
      if (sql.includes('FROM paper_positions pp')) {
        return { rows: syntheticTrades };
      }
      return { rowCount: 1, rows: [] };
    });

    await optimizeScorerWeights();

    const inserts = (query as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).startsWith('INSERT INTO scorer_weights'),
    );
    const marketTypes = inserts.map((c: unknown[]) => (c[1] as unknown[])[0] as string).sort();
    expect(marketTypes).toEqual(['__global__', 'event_financial', 'event_long']);
  });

  it('isolates errors per type — one failing type does not block others', async () => {
    let callIdx = 0;
    (query as unknown as Mock).mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT DISTINCT market_type FROM markets')) {
        return { rows: [{ market_type: 'event_long' }, { market_type: 'broken_type' }, { market_type: 'event_financial' }] };
      }
      if (sql.includes('FROM paper_positions pp')) {
        callIdx++;
        // Throw on the 'broken_type' call (second per-type call)
        if (callIdx === 2) throw new Error('simulated DB error');
        return { rows: Array.from({ length: 50 }, () => ({
          score_dimensions_at_entry: { tradeability: 0.5, liquidity: 0.5, ttr: 0.5, typeExpectedValue: 0.7 },
          realized_pnl: '10',
        })) };
      }
      return { rowCount: 1, rows: [] };
    });

    // Should NOT throw
    await expect(optimizeScorerWeights()).resolves.not.toThrow();

    const inserts = (query as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).startsWith('INSERT INTO scorer_weights'),
    );
    const marketTypes = inserts.map((c: unknown[]) => (c[1] as unknown[])[0] as string).sort();
    // event_long + event_financial + __global__ all succeed; broken_type skipped
    expect(marketTypes).toEqual(['__global__', 'event_financial', 'event_long']);
  });
});
