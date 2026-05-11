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

  it('uses stored peak_equity as denominator when peak > initialCapital', async () => {
    // After wins push equity above initial: peak=11500, current=10350, no positions
    // → drawdown 10% (uses stored peak, not initial)
    vi.mocked(query)
      .mockResolvedValueOnce({
        rows: [{ available_capital: '10350', current_capital: '10350', peak_equity: '11500' }],
        rowCount: 1,
      } as any)
      .mockResolvedValueOnce({ rows: [{ total_exposure: '0' }], rowCount: 1 } as any);

    const dd = await computeEquityDrawdown(10000);
    expect(dd!.peakEquity).toBe(11500);
    expect(dd!.drawdownPct).toBeCloseTo(10, 2);
  });

  it('floors peakEquity at initialCapital when stored peak is lower (2026-05-11 bug class)', async () => {
    // Pre-floor: peak=8897.79, current=8695 → drawdown 2.28% (hides slow bleed)
    // Post-floor: peak=max(8897.79, 10000)=10000 → drawdown 13.05% (fires at 15% gate)
    //
    // Stored peak below initial only happens after a partial reset path that
    // resets current_capital but not peak_equity. Without the floor, the CB
    // silently loses its cumulative-loss protection — observed on 2026-05-11
    // when realised drawdown was 16.1% but CB still reported 6.34%.
    vi.mocked(query)
      .mockResolvedValueOnce({
        rows: [{ available_capital: '8695', current_capital: '8695.16', peak_equity: '8897.79' }],
        rowCount: 1,
      } as any)
      .mockResolvedValueOnce({ rows: [{ total_exposure: '0' }], rowCount: 1 } as any);

    const dd = await computeEquityDrawdown(10000);
    expect(dd!.peakEquity).toBe(10000); // floored
    expect(dd!.drawdownPct).toBeCloseTo(13.05, 1);
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
