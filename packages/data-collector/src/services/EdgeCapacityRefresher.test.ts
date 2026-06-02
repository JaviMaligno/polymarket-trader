/**
 * Phase 4 PR-D — tests for the TS port of edge_capacity computation
 * (mirrors scripts/measure-edge-capacity.test.js test suite).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../database/connection.js', () => ({
  query: vi.fn(),
}));

import { computeEdgeCapacity, refreshEdgeCapacity, getLatestEdgePerCell, resolveEdgeRefreshConfig } from './EdgeCapacityRefresher.js';
import { query } from '../database/connection.js';

describe('resolveEdgeRefreshConfig (env-overridable per-type timeout backstop)', () => {
  it('empty env → default timeout 600s', () => {
    expect(resolveEdgeRefreshConfig({})).toEqual({ perTypeTimeoutMs: 600_000 });
  });
  it('valid env value is honored', () => {
    expect(resolveEdgeRefreshConfig({ EDGE_REFRESH_PER_TYPE_TIMEOUT_MS: '900000' }))
      .toEqual({ perTypeTimeoutMs: 900_000 });
  });
  it('invalid env values fall back to default', () => {
    expect(resolveEdgeRefreshConfig({ EDGE_REFRESH_PER_TYPE_TIMEOUT_MS: '0' }).perTypeTimeoutMs).toBe(600_000);
    expect(resolveEdgeRefreshConfig({ EDGE_REFRESH_PER_TYPE_TIMEOUT_MS: 'abc' }).perTypeTimeoutMs).toBe(600_000);
  });
});

describe('computeEdgeCapacity (TS port)', () => {
  it('empty input → empty map', () => {
    const got = computeEdgeCapacity([], null, 0.01, 50);
    expect(got.size).toBe(0);
  });

  it('single positive net cell → edge_capacity > 0', () => {
    // mean_reversion crypto_intraday SHORT 2026-05-13:
    // gross=+1.369%, t_gross=+10.14, n=126. With rt=1.08% → t_net ≈ 2.14
    const got = computeEdgeCapacity(
      [{ signal_id: 'mean_reversion', market_type: 'crypto_intraday', direction: 'short', n: 126, gross_pct: 1.369, t_gross: 10.14 }],
      null, 0.0108, 50,
    );
    const e = got.get('crypto_intraday')!;
    expect(e.sum).toBeCloseTo(2.14, 1);
    expect(e.positive).toBe(1);
    expect(e.measured).toBe(1);
  });

  it('cells under min_n are dropped', () => {
    const got = computeEdgeCapacity(
      [{ signal_id: 'x', market_type: 'event_short', direction: 'long', n: 30, gross_pct: 1.0, t_gross: 5 }],
      null, 0.01, 50,
    );
    expect(got.size).toBe(0);
  });

  it('anti-edge cells contribute 0, not negative', () => {
    const got = computeEdgeCapacity(
      [
        { signal_id: 'mean_reversion', market_type: 'crypto_intraday', direction: 'short', n: 126, gross_pct: 1.369, t_gross: 10.14 },
        { signal_id: 'momentum', market_type: 'crypto_intraday', direction: 'long', n: 3000, gross_pct: -0.06, t_gross: -3.25 },
      ],
      null, 0.0108, 50,
    );
    const e = got.get('crypto_intraday')!;
    expect(e.sum).toBeCloseTo(2.14, 1);
    expect(e.positive).toBe(1);
    expect(e.measured).toBe(2);
  });

  it('all cells anti-edge → edge_capacity = 0', () => {
    const got = computeEdgeCapacity(
      [
        { signal_id: 'mean_reversion', market_type: 'event_financial', direction: 'long', n: 4200, gross_pct: 0.552, t_gross: 16.94 },
        { signal_id: 'momentum', market_type: 'event_financial', direction: 'long', n: 7661, gross_pct: 0.203, t_gross: 11.31 },
      ],
      null, 0.0108, 50,
    );
    const e = got.get('event_financial')!;
    expect(e.sum).toBe(0);
    expect(e.positive).toBe(0);
    expect(e.measured).toBe(2);
  });

  it('zero-information cells (gross=0) are measured but contribute 0', () => {
    const got = computeEdgeCapacity(
      [{ signal_id: 'mean_reversion', market_type: 'event_short', direction: 'long', n: 336, gross_pct: 0, t_gross: 0 }],
      null, 0.01, 50,
    );
    const e = got.get('event_short')!;
    expect(e.sum).toBe(0);
    expect(e.positive).toBe(0);
    expect(e.measured).toBe(1);
  });

  it('per-type rt_cost map override is honored', () => {
    const cheap = computeEdgeCapacity(
      [{ signal_id: 's', market_type: 'aaa', direction: 'long', n: 100, gross_pct: 0.6, t_gross: 5 }],
      new Map([['aaa', 0.005]]), 0.05, 50,
    );
    const expensive = computeEdgeCapacity(
      [{ signal_id: 's', market_type: 'aaa', direction: 'long', n: 100, gross_pct: 0.6, t_gross: 5 }],
      new Map([['aaa', 0.015]]), 0.05, 50,
    );
    expect(cheap.get('aaa')!.sum).toBeGreaterThan(0);
    expect(expensive.get('aaa')!.sum).toBe(0);
  });
});

describe('refreshEdgeCapacity (integration, Phase 5 Pilar 1-A per-type sampling)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('iterates types from markets and UPSERTs one row per type with measurable cells', async () => {
    let upsertCount = 0;
    (query as any).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('SELECT DISTINCT market_type')) {
        return { rows: [
          { market_type: 'crypto_intraday' },
          { market_type: 'event_financial' },
        ]};
      }
      // Per-type t-stat query: returns cells for the specific market_type param
      if (typeof sql === 'string' && sql.includes('FROM generator_prediction_outcomes')) {
        const mt = String(params?.[0]);
        if (mt === 'crypto_intraday') {
          return { rows: [
            { signal_id: 'mean_reversion', market_type: 'crypto_intraday', direction: 'short', n: 126, gross_pct: 1.369, t_gross: 10.14 },
          ]};
        }
        if (mt === 'event_financial') {
          return { rows: [
            { signal_id: 'momentum', market_type: 'event_financial', direction: 'long', n: 4200, gross_pct: 0.20, t_gross: 11 },
          ]};
        }
        return { rows: [] };
      }
      if (typeof sql === 'string' && sql.startsWith('INSERT INTO market_type_edge_capacity')) {
        upsertCount++;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const { upserts, perType, skipped } = await refreshEdgeCapacity({ defaultRtCost: 0.0108, minN: 50 });
    expect(upserts).toBe(2);
    expect(upsertCount).toBe(2);
    expect(perType.has('crypto_intraday')).toBe(true);
    expect(perType.has('event_financial')).toBe(true);
    expect(skipped).toEqual([]);
  });

  it('skips a type whose per-type query throws (continues with the next)', async () => {
    (query as any).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('SELECT DISTINCT market_type')) {
        return { rows: [
          { market_type: 'event_long' },
          { market_type: 'event_financial' },
        ]};
      }
      if (typeof sql === 'string' && sql.includes('FROM generator_prediction_outcomes')) {
        const mt = String(params?.[0]);
        if (mt === 'event_long') throw new Error('simulated DB error');
        return { rows: [
          { signal_id: 'mean_reversion', market_type: mt, direction: 'long', n: 200, gross_pct: 0.5, t_gross: 5 },
        ]};
      }
      return { rows: [], rowCount: 0 };
    });

    const { upserts, perType, skipped } = await refreshEdgeCapacity({ minN: 50 });
    // event_long failed → skipped; event_financial succeeded → upsert
    expect(skipped).toEqual(['event_long']);
    expect(upserts).toBe(1);
    expect(perType.has('event_financial')).toBe(true);
  });

  it('per-type SQL reads generator_prediction_outcomes with window + horizon filter, no price_history, no random()', async () => {
    const capturedSql: string[] = [];
    (query as any).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('SELECT DISTINCT market_type')) {
        return { rows: [{ market_type: 'event_long' }] };
      }
      if (typeof sql === 'string') capturedSql.push(sql);
      return { rows: [], rowCount: 0 };
    });

    await refreshEdgeCapacity({ windowDays: 3, horizonHours: 6, minN: 100 });

    const stmt = capturedSql.find(s => s.includes('FROM generator_prediction_outcomes'));
    expect(stmt).toBeDefined();
    expect(stmt).toContain("INTERVAL '3 days'");
    expect(stmt).toContain('horizon_hours = 6');
    expect(stmt).toContain('y1 IS NOT NULL');
    expect(stmt).not.toContain('price_history');
    expect(stmt).not.toContain('random()');
    expect(stmt).not.toContain('FROM generator_predictions g');
  });

  // ─── Phase 5 Pilar 1-B: generator_edge persistence ──────────────────
  it('persists each measured cell to generator_edge with computed t_net', async () => {
    const insertedRows: any[][] = [];
    (query as any).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('SELECT DISTINCT market_type')) {
        return { rows: [{ market_type: 'event_long' }] };
      }
      if (typeof sql === 'string' && sql.includes('FROM generator_prediction_outcomes')) {
        return { rows: [
          // cell with positive t_gross → t_net should be t_gross × (gross-rtPct)/gross
          { signal_id: 'spread_compression', market_type: 'event_long', direction: 'long', n: 99, gross_pct: 0.88, t_gross: 1.71 },
          // cell with gross=0 → t_net=0
          { signal_id: 'mean_reversion', market_type: 'event_long', direction: 'long', n: 100, gross_pct: 0, t_gross: 0 },
          // cell under minN → should NOT be persisted
          { signal_id: 'tiny', market_type: 'event_long', direction: 'short', n: 5, gross_pct: 1, t_gross: 5 },
        ]};
      }
      if (typeof sql === 'string' && sql.startsWith('INSERT INTO generator_edge')) {
        insertedRows.push(params ?? []);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    await refreshEdgeCapacity({ defaultRtCost: 0.01, minN: 50 });
    expect(insertedRows.length).toBe(2);  // 'tiny' filtered out
    // First row: t_net = 1.71 × (0.88-1) / 0.88 ≈ -0.233
    const firstParams = insertedRows[0];
    // params: signal_id, market_type, direction, window_days, horizon_hours,
    //         sample_size, n, gross_pct, t_gross, rt_cost_pct, t_net, source
    expect(firstParams[0]).toBe('spread_compression');
    expect(firstParams[10]).toBeCloseTo(-0.233, 2);
    // Second row: gross_pct=0 → t_net=0
    expect(insertedRows[1][10]).toBe(0);
  });

  it('skips types not in allowedTypes when allowedTypes is non-empty', async () => {
    const queriedTypes: string[] = [];
    (query as any).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('SELECT DISTINCT market_type')) {
        return { rows: [
          { market_type: 'crypto_daily' },
          { market_type: 'event_long' },
          { market_type: 'event_financial' },
        ]};
      }
      if (typeof sql === 'string' && sql.includes('FROM generator_prediction_outcomes')) {
        queriedTypes.push(String(params?.[0]));
        return { rows: [
          { signal_id: 'momentum', market_type: String(params?.[0]), direction: 'long', n: 100, gross_pct: 0.5, t_gross: 2 },
        ]};
      }
      return { rows: [], rowCount: 1 };
    });
    const { upserts, skipped } = await refreshEdgeCapacity({
      minN: 50,
      allowedTypes: ['crypto_daily', 'event_financial'],
    });
    // event_long should be skipped entirely — not queried, not upserted
    expect(queriedTypes).not.toContain('event_long');
    expect(queriedTypes).toContain('crypto_daily');
    expect(queriedTypes).toContain('event_financial');
    expect(upserts).toBe(2);
    expect(skipped).not.toContain('event_long');
  });

  it('measures all discovered types when allowedTypes is empty (backward compat)', async () => {
    const queriedTypes: string[] = [];
    (query as any).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('SELECT DISTINCT market_type')) {
        return { rows: [{ market_type: 'crypto_daily' }, { market_type: 'event_long' }] };
      }
      if (typeof sql === 'string' && sql.includes('FROM generator_prediction_outcomes')) {
        queriedTypes.push(String(params?.[0]));
        return { rows: [
          { signal_id: 'momentum', market_type: String(params?.[0]), direction: 'long', n: 100, gross_pct: 0.5, t_gross: 2 },
        ]};
      }
      return { rows: [], rowCount: 1 };
    });
    await refreshEdgeCapacity({ minN: 50, allowedTypes: [] });
    expect(queriedTypes).toContain('crypto_daily');
    expect(queriedTypes).toContain('event_long');
  });

  it('persistence failure does not abort the per-type loop', async () => {
    let insertCalls = 0;
    (query as any).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('SELECT DISTINCT market_type')) {
        return { rows: [{ market_type: 'event_long' }] };
      }
      if (typeof sql === 'string' && sql.includes('FROM generator_prediction_outcomes')) {
        return { rows: [
          { signal_id: 'mean_reversion', market_type: 'event_long', direction: 'long', n: 200, gross_pct: 0.5, t_gross: 3 },
        ]};
      }
      if (typeof sql === 'string' && sql.startsWith('INSERT INTO generator_edge')) {
        insertCalls++;
        throw new Error('simulated history insert failure');
      }
      return { rows: [], rowCount: 1 };
    });
    const { upserts } = await refreshEdgeCapacity({ minN: 50 });
    // The market_type_edge_capacity upsert should still happen even if
    // generator_edge inserts failed.
    expect(upserts).toBe(1);
    expect(insertCalls).toBeGreaterThanOrEqual(1);
  });
});

describe('getLatestEdgePerCell (Phase 5 Pilar 1-B reporting)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns rows sorted by t_net DESC (positive edge first)', async () => {
    (query as any).mockResolvedValueOnce({
      rows: [
        { signal_id: 'a', market_type: 't', direction: 'long', n: 100, gross_pct: 0.5, t_gross: 2, t_net: -1.0, rt_cost_pct: 1, measured_at: new Date('2026-05-15') },
        { signal_id: 'b', market_type: 't', direction: 'short', n: 100, gross_pct: 1.5, t_gross: 10, t_net: 3.5, rt_cost_pct: 1, measured_at: new Date('2026-05-15') },
        { signal_id: 'c', market_type: 't', direction: 'long', n: 100, gross_pct: 0.0, t_gross: 0, t_net: 0, rt_cost_pct: 1, measured_at: new Date('2026-05-15') },
      ],
    });
    const out = await getLatestEdgePerCell();
    expect(out.map(r => r.signal_id)).toEqual(['b', 'c', 'a']);  // 3.5, 0, -1.0
  });

  it('issues a DISTINCT ON query to fetch latest per cell', async () => {
    let capturedSql = '';
    (query as any).mockImplementation(async (sql: string) => {
      capturedSql = sql;
      return { rows: [] };
    });
    await getLatestEdgePerCell();
    expect(capturedSql).toContain('DISTINCT ON (signal_id, market_type, direction)');
    expect(capturedSql).toContain('measured_at DESC');
  });
});
