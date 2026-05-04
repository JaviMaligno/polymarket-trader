import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../database/index.js', () => ({
  query: vi.fn(),
}));

import { query } from '../database/index.js';
import { computeEquityDrawdown } from './drawdown.js';

describe('computeEquityDrawdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when paper_account is empty', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    expect(await computeEquityDrawdown(10000)).toBeNull();
  });

  it('uses peak_equity as denominator (the deadlock scenario from issue #173)', async () => {
    // current=8695, peak=8898, no open positions → drawdown 2.28% (not 13.05%)
    vi.mocked(query)
      .mockResolvedValueOnce({
        rows: [{ available_capital: '8695', current_capital: '8695.16', peak_equity: '8897.79' }],
        rowCount: 1,
      } as any)
      .mockResolvedValueOnce({ rows: [{ total_exposure: '0' }], rowCount: 1 } as any);

    const dd = await computeEquityDrawdown(10000);
    expect(dd).not.toBeNull();
    expect(dd!.drawdownPct).toBeCloseTo(2.28, 1);
    expect(dd!.peakEquity).toBeCloseTo(8897.79, 2);
    expect(dd!.totalExposure).toBe(0);
  });

  it('falls back to initialCapital when peak_equity is null (fresh account)', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce({
        rows: [{ available_capital: '5000', current_capital: '5000', peak_equity: null }],
        rowCount: 1,
      } as any)
      .mockResolvedValueOnce({ rows: [{ total_exposure: '0' }], rowCount: 1 } as any);

    const dd = await computeEquityDrawdown(10000);
    expect(dd!.peakEquity).toBe(10000);
    expect(dd!.drawdownPct).toBe(50);  // (10000 - 5000) / 10000
  });

  it('falls back to initialCapital when peak_equity is "0" string', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce({
        rows: [{ available_capital: '8000', current_capital: '8000', peak_equity: '0' }],
        rowCount: 1,
      } as any)
      .mockResolvedValueOnce({ rows: [{ total_exposure: '0' }], rowCount: 1 } as any);

    const dd = await computeEquityDrawdown(10000);
    expect(dd!.peakEquity).toBe(10000);
    expect(dd!.drawdownPct).toBe(20);
  });

  it('includes open-position exposure in currentEquity', async () => {
    // capital=5000, peak=10000, exposure=4000 → currentEquity=9000 → drawdown 10%
    vi.mocked(query)
      .mockResolvedValueOnce({
        rows: [{ available_capital: '5000', current_capital: '5000', peak_equity: '10000' }],
        rowCount: 1,
      } as any)
      .mockResolvedValueOnce({ rows: [{ total_exposure: '4000' }], rowCount: 1 } as any);

    const dd = await computeEquityDrawdown(10000);
    expect(dd!.currentEquity).toBe(9000);
    expect(dd!.drawdownPct).toBe(10);
  });

  it('returns 0% drawdown when peakEquity is 0 and initialCapital is 0', async () => {
    // Pathological — neither peak nor initial → guard returns 0 instead of NaN/Infinity.
    vi.mocked(query)
      .mockResolvedValueOnce({
        rows: [{ available_capital: '0', current_capital: '0', peak_equity: '0' }],
        rowCount: 1,
      } as any)
      .mockResolvedValueOnce({ rows: [{ total_exposure: '0' }], rowCount: 1 } as any);

    const dd = await computeEquityDrawdown(0);
    expect(dd!.drawdownPct).toBe(0);
  });
});
