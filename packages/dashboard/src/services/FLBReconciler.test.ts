import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('../database/index.js', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  transaction: async (fn: (client: any) => Promise<unknown>) => fn({ query: (...a: unknown[]) => queryMock(...a) }),
  isDatabaseConfigured: () => true,
}));

import { FLBReconciler } from './FLBReconciler.js';

beforeEach(() => { queryMock.mockReset(); });

function openRow(over: Record<string, unknown> = {}) {
  return {
    id: 1, market_id: 'm1', no_size: '105.0', no_stake: '100.0', fee_paid: '0',
    opened_at: '2026-06-01T00:00:00Z', end_date: '2026-09-01T00:00:00Z',
    is_resolved: false, outcome: null, resolved_at: null, ...over,
  };
}

describe('FLBReconciler.run', () => {
  it('settles a NO resolution: status resolved, positive net, capital released', async () => {
    const writes: { sql: string; params: unknown[] }[] = [];
    queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("status = 'open'")) return { rows: [openRow({
        is_resolved: true, outcome: 'no', resolved_at: '2026-06-08T00:00:00Z' })] };
      writes.push({ sql, params }); return { rowCount: 1, rows: [] };
    });

    const r = await new FLBReconciler().run();
    expect(r.settled).toBe(1);

    const posUpd = writes.find(w => w.sql.startsWith('UPDATE flb_positions'));
    expect(posUpd!.params).toContain('resolved');
    expect(posUpd!.params.some(p => Number(p) === 5)).toBe(true); // net = 105-100-0

    const acctUpd = writes.find(w => w.sql.startsWith('UPDATE paper_account'));
    expect(acctUpd!.params.map(Number)).toEqual(expect.arrayContaining([100, 5])); // release 100, realized +5
  });

  it('settles a YES resolution as a full wipeout', async () => {
    const writes: { sql: string; params: unknown[] }[] = [];
    queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("status = 'open'")) return { rows: [openRow({
        is_resolved: true, outcome: 'yes', resolved_at: '2026-06-08T00:00:00Z' })] };
      writes.push({ sql, params }); return { rowCount: 1, rows: [] };
    });
    await new FLBReconciler().run();
    const posUpd = writes.find(w => w.sql.startsWith('UPDATE flb_positions'));
    expect(posUpd!.params.some(p => Number(p) === -100)).toBe(true); // net = -100
  });

  it('voids a market resolved to neither yes nor no, refunding the stake', async () => {
    const writes: { sql: string; params: unknown[] }[] = [];
    queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("status = 'open'")) return { rows: [openRow({
        is_resolved: true, outcome: 'invalid', resolved_at: '2026-06-08T00:00:00Z' })] };
      writes.push({ sql, params }); return { rowCount: 1, rows: [] };
    });
    const r = await new FLBReconciler().run();
    expect(r.voided).toBe(1);
    const posUpd = writes.find(w => w.sql.startsWith('UPDATE flb_positions'));
    expect(posUpd!.params).toContain('voided');
    expect(posUpd!.params).toContain('invalid'); // resolution_outcome set on void (change #2)
    const acctUpd = writes.find(w => w.sql.startsWith('UPDATE paper_account'));
    expect(acctUpd!.params.some(p => Number(p) === 100)).toBe(true); // release = noStake 100 + fee 0
  });

  it('alerts (does not settle) an overdue-unresolved position', async () => {
    const writes: { sql: string; params: unknown[] }[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("status = 'open'")) return { rows: [openRow({
        is_resolved: false, end_date: '2026-01-01T00:00:00Z' })] };
      writes.push({ sql, params }); return { rowCount: 1, rows: [] };
    });
    const r = await new FLBReconciler().run();
    expect(r.alerts).toBe(1);
    expect(r.settled).toBe(0);
    expect(writes.some(w => w.sql.startsWith('UPDATE flb_positions'))).toBe(false);
    warn.mockRestore();
  });

  it('leaves an unresolved, not-yet-overdue position untouched', async () => {
    const writes: { sql: string; params: unknown[] }[] = [];
    queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("status = 'open'")) return { rows: [openRow()] };
      writes.push({ sql, params }); return { rowCount: 1, rows: [] };
    });
    const r = await new FLBReconciler().run();
    expect(r.settled + r.voided + r.alerts).toBe(0);
    expect(writes.length).toBe(0);
  });

  it('settles a NO resolution with a nonzero entry fee', async () => {
    const writes: { sql: string; params: unknown[] }[] = [];
    queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("status = 'open'")) return { rows: [openRow({
        is_resolved: true, outcome: 'no', resolved_at: '2026-06-08T00:00:00Z',
        fee_paid: '2', no_size: '105', no_stake: '100' })] };
      writes.push({ sql, params }); return { rowCount: 1, rows: [] };
    });
    const r = await new FLBReconciler().run();
    expect(r.settled).toBe(1);
    const acctUpd = writes.find(w => w.sql.startsWith('UPDATE paper_account'));
    // release = noStake(100) + feePaid(2) = 102; net_pnl = 105 - 100 - 2 = 3
    expect(acctUpd!.params.some(p => Number(p) === 102)).toBe(true);
    expect(acctUpd!.params.some(p => Number(p) === 3)).toBe(true);
  });
});
