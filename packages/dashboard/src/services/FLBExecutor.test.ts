import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('../database/index.js', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  isDatabaseConfigured: () => true,
}));

import { FLBExecutor } from './FLBExecutor.js';
import { getFLBConfig } from './FLBConfig.js';

beforeEach(() => { queryMock.mockReset(); });

// Route SELECTs by SQL fragment.
function routeReads(opts: { initialCapital?: number; locked?: number; open?: any[]; weeks?: any[] }) {
  queryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM paper_account')) {
      return { rows: [{ initial_capital: String(opts.initialCapital ?? 10000),
                         flb_locked_capital: String(opts.locked ?? 0) }] };
    }
    if (sql.includes("status = 'open'") && sql.includes('market_id')) {
      return { rows: opts.open ?? [] };
    }
    if (sql.includes('GROUP BY') && sql.includes('end_date')) {
      return { rows: opts.weeks ?? [] };
    }
    if (sql.startsWith('INSERT INTO flb_positions')) return { rowCount: 1, rows: [] };
    if (sql.startsWith('UPDATE paper_account')) return { rowCount: 1, rows: [] };
    return { rows: [] };
  });
}

describe('FLBExecutor.executeCandidates', () => {
  it('inserts a position and locks capital for a qualifying candidate', async () => {
    routeReads({ initialCapital: 10000, locked: 0 });
    const exec = new FLBExecutor();
    const result = await exec.executeCandidates([{
      marketId: 'm1', marketType: 'event_short', yesPrice: 0.05, spread: 0.01,
      ttrHours: 96, noTokenId: 'noTok', endDate: '2026-09-01T00:00:00Z',
    }], getFLBConfig());

    expect(result.opened).toBe(1);
    const insert = queryMock.mock.calls.find(c => String(c[0]).startsWith('INSERT INTO flb_positions'));
    expect(insert).toBeTruthy();
    const lock = queryMock.mock.calls.find(c =>
      String(c[0]).startsWith('UPDATE paper_account') && String(c[0]).includes('flb_locked_capital'));
    expect(lock).toBeTruthy();
    expect(Number((lock as any[])[1][0])).toBeCloseTo(21, 6); // stake added to locked
  });

  it('skips and does not lock capital when a gate rejects', async () => {
    routeReads({ initialCapital: 10000, locked: 0 });
    const exec = new FLBExecutor();
    const result = await exec.executeCandidates([{
      marketId: 'm2', marketType: 'event_short', yesPrice: 0.50, spread: 0.01, // out of band
      ttrHours: 96, noTokenId: 'noTok', endDate: '2026-09-01T00:00:00Z',
    }], getFLBConfig());

    expect(result.opened).toBe(0);
    expect(result.rejected).toBe(1);
    expect(queryMock.mock.calls.some(c => String(c[0]).startsWith('INSERT INTO flb_positions'))).toBe(false);
  });

  it('does not insert in dry-run mode', async () => {
    routeReads({ initialCapital: 10000, locked: 0 });
    process.env.FLB_DRY_RUN = 'true';
    const exec = new FLBExecutor();
    const result = await exec.executeCandidates([{
      marketId: 'm3', marketType: 'event_short', yesPrice: 0.05, spread: 0.01,
      ttrHours: 96, noTokenId: 'noTok', endDate: '2026-09-01T00:00:00Z',
    }], getFLBConfig());
    delete process.env.FLB_DRY_RUN;

    expect(result.opened).toBe(0);
    expect(result.dryRunIntents).toBe(1);
    expect(queryMock.mock.calls.some(c => String(c[0]).startsWith('INSERT INTO flb_positions'))).toBe(false);
  });
});
