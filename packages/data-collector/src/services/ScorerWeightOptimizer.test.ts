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
    tradeability: 0.30, liquidity: 0.25, volatility: 0.20, ttr: 0.15, dataQuality: 0.10,
    typeExpectedValue: 0.20, realizedVolatility: 0.05, shadowExpectedValue: 0.05,
  };

  it('returns positive correlation when high-score trades have positive pnl', () => {
    const trades = [
      { dims: { tradeability: 1.0, liquidity: 0.8, ttr: 0.9, volatility: null, dataQuality: null, typeExpectedValue: 0.5, realizedVolatility: null, shadowExpectedValue: 0.5 }, pnl: 10 },
      { dims: { tradeability: 0.1, liquidity: 0.1, ttr: 0.2, volatility: null, dataQuality: null, typeExpectedValue: 0.5, realizedVolatility: null, shadowExpectedValue: 0.5 }, pnl: -5 },
      { dims: { tradeability: 0.8, liquidity: 0.7, ttr: 0.8, volatility: null, dataQuality: null, typeExpectedValue: 0.5, realizedVolatility: null, shadowExpectedValue: 0.5 }, pnl: 7 },
    ];
    const result = computeObjective(weights, trades);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(1);
  });

  it('returns 0 when all pnl are identical (no variance)', () => {
    const trades = [
      { dims: { tradeability: 0.5, liquidity: 0.5, ttr: 0.5, volatility: null, dataQuality: null, typeExpectedValue: 0.5, realizedVolatility: null, shadowExpectedValue: 0.5 }, pnl: 5 },
      { dims: { tradeability: 0.8, liquidity: 0.8, ttr: 0.8, volatility: null, dataQuality: null, typeExpectedValue: 0.5, realizedVolatility: null, shadowExpectedValue: 0.5 }, pnl: 5 },
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
        tradeability: 0.5, liquidity: 0.5, ttr: 0.5, typeExpectedValue: 0.7, realizedVolatility: 0.4,
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
          score_dimensions_at_entry: { tradeability: 0.5, liquidity: 0.5, ttr: 0.5, typeExpectedValue: 0.7, realizedVolatility: 0.4 },
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

describe('optimizeScorerWeights — realizedVolatility', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('saveWeights INSERT includes realized_volatility column and param', async () => {
    const captured: Array<{ sql: string; params: unknown[] }> = [];
    (query as unknown as Mock).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.startsWith('INSERT INTO scorer_weights')) {
        captured.push({ sql, params: params ?? [] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT DISTINCT market_type FROM markets')) {
        return { rows: [{ market_type: 'event_long' }] };
      }
      if (typeof sql === 'string' && sql.includes('FROM paper_positions pp')) {
        return {
          rows: Array.from({ length: 50 }, () => ({
            score_dimensions_at_entry: {
              tradeability: 0.5, liquidity: 0.5, ttr: 0.5,
              typeExpectedValue: 0.7, realizedVolatility: 0.4,
            },
            realized_pnl: '10',
          })),
        };
      }
      return { rowCount: 1, rows: [] };
    });

    await optimizeScorerWeights();

    expect(captured.length).toBeGreaterThan(0);
    for (const c of captured) {
      expect(c.sql).toContain('realized_volatility');
      expect(c.sql).toContain('EXCLUDED.realized_volatility');
    }
  });

  it('loadClosedTrades filters by jsonb ? realizedVolatility', async () => {
    const capturedSql: string[] = [];
    (query as unknown as Mock).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('FROM paper_positions')) {
        capturedSql.push(sql);
        return { rows: [] };
      }
      if (typeof sql === 'string' && sql.includes('SELECT DISTINCT market_type')) {
        return { rows: [] };
      }
      return { rows: [], rowCount: 1 };
    });
    await optimizeScorerWeights();
    // Even if no rows returned, the SELECT should include the new filter
    const selectWithFilter = capturedSql.find(s => s.includes("? 'realizedVolatility'"));
    expect(selectWithFilter).toBeDefined();
  });
});

// ─── Phase 4: edgeCapacity in optimizer ──────────────────────────────────
describe('optimizeScorerWeights — edgeCapacity (Phase 4)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('saveWeights INSERT includes edge_capacity column and param', async () => {
    const captured: Array<{ sql: string; params: unknown[] }> = [];
    (query as unknown as Mock).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.startsWith('INSERT INTO scorer_weights')) {
        captured.push({ sql, params: params ?? [] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT DISTINCT market_type FROM markets')) {
        return { rows: [{ market_type: 'crypto_intraday' }] };
      }
      if (typeof sql === 'string' && sql.includes('FROM paper_positions pp')) {
        return {
          rows: Array.from({ length: 50 }, (_, i) => ({
            score_dimensions_at_entry: {
              tradeability: 0.5, liquidity: 0.5, ttr: 0.5,
              typeExpectedValue: 0.7, realizedVolatility: 0.4,
              // Some rows have edge_capacity (post-Phase-4 entries), others don't.
              ...(i % 2 === 0 ? { edgeCapacity: 0.2 } : {}),
            },
            realized_pnl: '10',
          })),
        };
      }
      return { rowCount: 1, rows: [] };
    });

    await optimizeScorerWeights();

    expect(captured.length).toBeGreaterThan(0);
    for (const c of captured) {
      // INSERT statement references the column
      expect(c.sql).toContain('edge_capacity');
      expect(c.sql).toContain('EXCLUDED.edge_capacity');
      // params[8] is edge_capacity in the new 12-param INSERT order.
      // Should be a non-null number (random sample, possibly normalized).
      expect(typeof c.params[8]).toBe('number');
      expect(Number.isFinite(c.params[8] as number)).toBe(true);
    }
  });

  it('normalization: saved weights sum to ~1.0 with edgeCapacity included', async () => {
    const captured: Array<{ params: unknown[] }> = [];
    (query as unknown as Mock).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.startsWith('INSERT INTO scorer_weights')) {
        captured.push({ params: params ?? [] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT DISTINCT market_type FROM markets')) {
        return { rows: [{ market_type: 'crypto_intraday' }] };
      }
      if (typeof sql === 'string' && sql.includes('FROM paper_positions pp')) {
        return {
          rows: Array.from({ length: 50 }, () => ({
            score_dimensions_at_entry: {
              tradeability: 0.5, liquidity: 0.5, ttr: 0.5,
              typeExpectedValue: 0.7, realizedVolatility: 0.4,
            },
            realized_pnl: '10',
          })),
        };
      }
      return { rowCount: 1, rows: [] };
    });

    await optimizeScorerWeights();
    expect(captured.length).toBeGreaterThan(0);
    for (const c of captured) {
      // params order in saveWeights:
      //   1:market_type, 2:tradeability, 3:liquidity, 4:volatility, 5:ttr,
      //   6:data_quality, 7:type_expected_value, 8:realized_volatility,
      //   9:edge_capacity, 10:n_trades, 11:n_trials, 12:best_value
      const sum =
        (c.params[1] as number) + (c.params[2] as number) + (c.params[3] as number) +
        (c.params[4] as number) + (c.params[5] as number) + (c.params[6] as number) +
        (c.params[7] as number) + (c.params[8] as number);
      // (shadowExpectedValue is fixed at WEIGHTS.shadowExpectedValue = 0.05,
      // not in saveWeights params — but the optimizable dims should normalize
      // so that all 9 fields would sum to 1 once shadow is added.)
      expect(sum + 0.05).toBeCloseTo(1.0, 2);
    }
  });
});
