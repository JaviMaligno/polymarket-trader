import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('../database/index.js', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  isDatabaseConfigured: () => true,
}));

import { FLBScanner } from './FLBScanner.js';
import { getFLBConfig } from './FLBConfig.js';

beforeEach(() => { queryMock.mockReset(); });

describe('FLBScanner.scan', () => {
  it('maps DB rows to candidates and passes band/ttr/types as params', async () => {
    queryMock.mockResolvedValue({ rows: [{
      id: 'm1', market_type: 'event_short', current_price_yes: '0.05',
      spread: '0.01', clob_token_id_no: 'noTok', end_date: '2026-09-01T00:00:00Z',
      ttr_hours: '96.5',
    }] });

    const scanner = new FLBScanner();
    const cands = await scanner.scan(getFLBConfig());

    expect(cands).toHaveLength(1);
    expect(cands[0]).toMatchObject({
      marketId: 'm1', marketType: 'event_short', yesPrice: 0.05,
      spread: 0.01, noTokenId: 'noTok', ttrHours: 96.5,
    });
    const [, params] = queryMock.mock.calls[0];
    expect(params[0]).toBe(0.02);  // lo
    expect(params[1]).toBe(0.10);  // hi
    expect(params[2]).toBe(48);    // minTtrHours
    expect(params[3]).toEqual(['crypto_daily','event_financial','event_short','event_long']);
  });

  it('returns [] when no markets qualify', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    expect(await new FLBScanner().scan(getFLBConfig())).toEqual([]);
  });

  it('maps a null spread to null (not NaN)', async () => {
    queryMock.mockResolvedValue({ rows: [{
      id: 'm2', market_type: 'crypto_daily', current_price_yes: '0.07',
      spread: null, clob_token_id_no: 'noTok2', end_date: '2026-10-01T00:00:00Z',
      ttr_hours: '120',
    }] });
    const cands = await new FLBScanner().scan(getFLBConfig());
    expect(cands[0].spread).toBeNull();
  });
});
