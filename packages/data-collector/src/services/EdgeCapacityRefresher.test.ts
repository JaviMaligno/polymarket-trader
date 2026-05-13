/**
 * Phase 4 PR-D — tests for the TS port of edge_capacity computation
 * (mirrors scripts/measure-edge-capacity.test.js test suite).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../database/connection.js', () => ({
  query: vi.fn(),
}));

import { computeEdgeCapacity, refreshEdgeCapacity } from './EdgeCapacityRefresher.js';
import { query } from '../database/connection.js';

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

describe('refreshEdgeCapacity (integration)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('runs SELECT then UPSERTs one row per market_type with measurable cells', async () => {
    let upsertCount = 0;
    (query as any).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('FROM generator_predictions')) {
        return {
          rows: [
            { signal_id: 'mean_reversion', market_type: 'crypto_intraday', direction: 'short', n: 126, gross_pct: 1.369, t_gross: 10.14 },
            { signal_id: 'momentum', market_type: 'event_financial', direction: 'long', n: 4200, gross_pct: 0.20, t_gross: 11 },
          ],
        };
      }
      if (typeof sql === 'string' && sql.startsWith('INSERT INTO market_type_edge_capacity')) {
        upsertCount++;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const { upserts, perType } = await refreshEdgeCapacity({ defaultRtCost: 0.0108, minN: 50 });
    expect(upserts).toBe(2);
    expect(upsertCount).toBe(2);
    expect(perType.has('crypto_intraday')).toBe(true);
    expect(perType.has('event_financial')).toBe(true);
  });

  it('passes window/horizon into the SQL', async () => {
    const capturedSql: string[] = [];
    (query as any).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string') capturedSql.push(sql);
      return { rows: [], rowCount: 0 };
    });

    await refreshEdgeCapacity({ windowDays: 3, horizonHours: 6, minN: 100 });

    const selectStmt = capturedSql.find(s => s.includes('FROM generator_predictions'));
    expect(selectStmt).toBeDefined();
    expect(selectStmt).toContain("INTERVAL '3 days'");
    expect(selectStmt).toContain("INTERVAL '6 hours'");
    expect(selectStmt).toContain("INTERVAL '7 hours'");
  });
});
