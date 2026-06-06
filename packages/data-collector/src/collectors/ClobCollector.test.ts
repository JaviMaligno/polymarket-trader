import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../database/connection.js', () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock('../services/RateLimiter.js', () => ({
  getRateLimiter: () => ({ acquire: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock('axios', () => {
  const get = vi.fn();
  return { default: { get, create: () => ({ get }) } };
});

import axios from 'axios';
import { query } from '../database/connection.js';
import { ClobCollector } from './ClobCollector.js';

const YES = '11111111111111111111111111111111111111111111111111111111111111111111111111111';
const NO  = '22222222222222222222222222222222222222222222222222222222222222222222222222222';
const OTHER = '99999999999999999999999999999999999999999999999999999999999999999999999999999';
const COND = '0xcond';

function trade(asset: string, side: string, price: string, ts: number, tx: string) {
  return { asset, side, price, size: '10', timestamp: ts, transactionHash: tx, proxyWallet: '0xw' };
}

beforeEach(() => {
  vi.clearAllMocks();
  (query as any).mockResolvedValue({ rowCount: 0, rows: [] });
});

describe('ClobCollector.fetchTrades', () => {
  it('queries the data-api by market (conditionId), not asset_id', async () => {
    (axios.get as any).mockResolvedValue({ data: [] });
    const c = new ClobCollector();
    await c.fetchTrades(COND);
    const [, opts] = (axios.get as any).mock.calls[0];
    expect(opts.params.market).toBe(COND);
    expect(opts.params).not.toHaveProperty('asset_id');
  });
});

describe('ClobCollector.syncTradesToDb', () => {
  const market = { id: 'mkt1', condition_id: COND, clob_token_id_yes: YES, clob_token_id_no: NO };

  it('stores each trade under its real asset (token_id) with the market id', async () => {
    (axios.get as any).mockResolvedValue({ data: [
      trade(YES, 'BUY', '0.93', 1000, '0xa'),
      trade(NO, 'SELL', '0.07', 1001, '0xb'),
    ] });
    const c = new ClobCollector();
    await c.syncTradesToDb(market);
    const insertCall = (query as any).mock.calls.find((c0: any[]) => /INSERT INTO trades/.test(c0[0]));
    expect(insertCall).toBeTruthy();
    const params = insertCall[1] as any[];
    expect(params).toContain(YES);
    expect(params).toContain(NO);
    expect(params).toContain('mkt1');
  });

  it('skips trades whose asset is neither of the market two tokens', async () => {
    (axios.get as any).mockResolvedValue({ data: [ trade(OTHER, 'BUY', '0.5', 1000, '0xc') ] });
    const c = new ClobCollector();
    const res = await c.syncTradesToDb(market);
    expect(res.inserted).toBe(0);
    const insertCall = (query as any).mock.calls.find((c0: any[]) => /INSERT INTO trades/.test(c0[0]));
    expect(insertCall).toBeFalsy();
  });

  it('inserts with ON CONFLICT on the dedup key', async () => {
    (axios.get as any).mockResolvedValue({ data: [ trade(YES, 'BUY', '0.93', 1000, '0xa') ] });
    const c = new ClobCollector();
    await c.syncTradesToDb(market);
    const insertCall = (query as any).mock.calls.find((c0: any[]) => /INSERT INTO trades/.test(c0[0]));
    expect(insertCall[0]).toMatch(/ON CONFLICT \(time, tx_hash, token_id, side, price, size\) DO NOTHING/);
  });
});
