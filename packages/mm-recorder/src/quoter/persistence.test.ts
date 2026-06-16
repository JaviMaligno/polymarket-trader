import { describe, it, expect, vi } from 'vitest';
import { QuoterPersistence } from './persistence.js';

const fill = {
  time: new Date('2026-06-12T10:00:00Z'), tokenId: 'T', marketId: 'M',
  side: -1 as const, bound: 'trades' as const, price: 0.48, size: 20,
  queueInitial: 30, spreadAtPlacement: 0.04, volAtPlacement: 0.01,
  flags: '', midAtFill: 0.50,
};

describe('QuoterPersistence', () => {
  it('ensureSchema creates the four tables idempotently', async () => {
    const exec = vi.fn().mockResolvedValue({ rows: [] });
    await new QuoterPersistence(exec).ensureSchema();
    const sql = exec.mock.calls.map((c) => c[0]).join('\n');
    for (const t of ['mm_shadow_fills', 'mm_quoter_state', 'mm_quote_eligibility', 'mm_shadow_pnl']) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${t}`);
    }
  });

  it('insertFill writes all fill columns', async () => {
    const exec = vi.fn().mockResolvedValue({ rows: [] });
    await new QuoterPersistence(exec).insertFill(fill);
    const [sql, params] = exec.mock.calls[0];
    expect(sql).toContain('INSERT INTO mm_shadow_fills');
    expect(params).toEqual([
      fill.time, 'T', 'M', -1, 'trades', 0.48, 20, 30, 0.04, 0.01, '', 0.50,
    ]);
  });

  it('upsertState merges json state under a key', async () => {
    const exec = vi.fn().mockResolvedValue({ rows: [] });
    await new QuoterPersistence(exec).upsertState('engine', { mode: 'shadow', fills: 3 });
    const [sql, params] = exec.mock.calls[0];
    expect(sql).toContain('INSERT INTO mm_quoter_state');
    expect(sql).toContain('ON CONFLICT (key)');
    expect(params[0]).toBe('engine');
    expect(JSON.parse(params[1] as string)).toEqual({ mode: 'shadow', fills: 3 });
  });

  it('insertEligibility and insertPnl write hourly rows', async () => {
    const exec = vi.fn().mockResolvedValue({ rows: [] });
    const p = new QuoterPersistence(exec);
    await p.insertEligibility({ hour: fill.time, marketId: 'M', eligibleMinutes: 50, quotedMinutes: 60 }, 1.25);
    await p.insertPnl({ hour: fill.time, marketId: 'M', bound: 'trades', spreadPnl: 0.4, inventoryPnl: -0.1, estRewards: 1.25, fills: 3, replaces: 7 });
    expect(exec.mock.calls[0][0]).toContain('INSERT INTO mm_quote_eligibility');
    expect(exec.mock.calls[1][0]).toContain('INSERT INTO mm_shadow_pnl');
  });

  // Bug 2026-06-16: flushHourly runs every 5 min (sub-hourly), so several flushes hit
  // the SAME (hour,market,bound) key within one hour. insertPnl persists per-flush DELTAS,
  // so the ON CONFLICT clause MUST accumulate (add EXCLUDED), not overwrite — otherwise
  // each hour keeps only the last ~5-min slice and fills/PnL undercount ~12x.
  it('insertPnl accumulates the additive columns on conflict (must not overwrite)', async () => {
    const exec = vi.fn().mockResolvedValue({ rows: [] });
    await new QuoterPersistence(exec).insertPnl({
      hour: fill.time, marketId: 'M', bound: 'trades',
      spreadPnl: 0.4, inventoryPnl: -0.1, estRewards: 1.25, fills: 3, replaces: 7,
    });
    const sql = exec.mock.calls[0][0] as string;
    expect(sql).toContain('ON CONFLICT (hour,market_id,bound)');
    expect(sql).toContain('spread_pnl = mm_shadow_pnl.spread_pnl + EXCLUDED.spread_pnl');
    expect(sql).toContain('inventory_pnl = mm_shadow_pnl.inventory_pnl + EXCLUDED.inventory_pnl');
    expect(sql).toContain('fills = mm_shadow_pnl.fills + EXCLUDED.fills');
    expect(sql).toContain('replaces = mm_shadow_pnl.replaces + EXCLUDED.replaces');
    expect(sql).toContain('est_rewards = EXCLUDED.est_rewards');
  });
});
