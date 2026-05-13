/**
 * PR-B 2026-05-13: signalWeightsRepo.getAllPerDirection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./index.js', () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

import { query } from './index.js';
import { signalWeightsRepo } from './repositories.js';

describe('signalWeightsRepo.getAllPerDirection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queries only direction IN ('long','short') and excludes __global__", async () => {
    (query as any).mockResolvedValueOnce({ rows: [] });
    await signalWeightsRepo.getAllPerDirection();
    const [sql] = (query as any).mock.calls[0];
    expect(sql).toMatch(/market_type != '__global__'/);
    expect(sql).toMatch(/direction IN \('long','short'\)/);
    expect(sql).toMatch(/is_enabled = true/);
  });

  it('groups rows into { marketType: { signalType: { direction: weight } } }', async () => {
    (query as any).mockResolvedValueOnce({
      rows: [
        { signal_type: 'mean_reversion', market_type: 'crypto_intraday', direction: 'short', weight: 1.5 },
        { signal_type: 'mean_reversion', market_type: 'crypto_intraday', direction: 'long', weight: 0.2 },
        { signal_type: 'momentum', market_type: 'event_financial', direction: 'long', weight: 0.0 },
      ],
    });
    const out = await signalWeightsRepo.getAllPerDirection();
    expect(out.crypto_intraday.mean_reversion.long).toBe(0.2);
    expect(out.crypto_intraday.mean_reversion.short).toBe(1.5);
    expect(out.event_financial.momentum.long).toBe(0.0);
    expect(out.event_financial.momentum.short).toBeUndefined();
  });

  it('returns an empty object when there are no per-direction rows', async () => {
    (query as any).mockResolvedValueOnce({ rows: [] });
    const out = await signalWeightsRepo.getAllPerDirection();
    expect(out).toEqual({});
  });
});
