import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../database/repositories.js', () => ({
  tradingConfigRepo: {
    get: vi.fn(),
    set: vi.fn().mockResolvedValue(undefined),
  },
}));

import { tradingConfigRepo } from '../database/repositories.js';
import { wipeDirectionMultiplierSegments } from './wipeDirectionMultiplierSegments.js';

describe('wipeDirectionMultiplierSegments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('wipes segments when existing policy has populated segments', async () => {
    (tradingConfigRepo.get as any).mockResolvedValueOnce({
      global: -1,
      minMultiplier: -1.25,
      maxMultiplier: 1,
      segments: [
        { id: 'seg-1', multiplier: 0.68, marketTypes: ['event_financial'] },
        { id: 'seg-2', multiplier: 0.27, marketTypes: ['event_financial'] },
      ],
    });

    await wipeDirectionMultiplierSegments();

    expect(tradingConfigRepo.set).toHaveBeenCalledTimes(1);
    const [key, value] = (tradingConfigRepo.set as any).mock.calls[0];
    expect(key).toBe('direction_multiplier_policy');
    expect(value.segments).toEqual([]);
    expect(value.global).toBe(-1);
    expect(value.minMultiplier).toBe(-1.25);
    expect(value.maxMultiplier).toBe(1);
  });

  it('preserves perMarketType when present', async () => {
    (tradingConfigRepo.get as any).mockResolvedValueOnce({
      global: -1,
      segments: [{ id: 'seg-1', multiplier: 0.5 }],
      perMarketType: { event_financial: 1, crypto_intraday: -1 },
    });

    await wipeDirectionMultiplierSegments();

    const [, value] = (tradingConfigRepo.set as any).mock.calls[0];
    expect(value.perMarketType).toEqual({ event_financial: 1, crypto_intraday: -1 });
  });

  it('uses defaults when existing policy is null', async () => {
    (tradingConfigRepo.get as any).mockResolvedValueOnce(null);

    await wipeDirectionMultiplierSegments();

    expect(tradingConfigRepo.set).toHaveBeenCalledTimes(1);
    const [, value] = (tradingConfigRepo.set as any).mock.calls[0];
    expect(value.segments).toEqual([]);
    // 2026-05-04: default global flipped -1 → +1 (see DirectionMultiplierPolicy.ts header).
    expect(value.global).toBe(1.0);
  });

  it('parses the JSON string returned by tradingConfigRepo.get (TEXT column)', async () => {
    // tradingConfigRepo.get returns a string because trading_config.value is TEXT.
    // Pre-fix this caused the whole policy to be silently overwritten with defaults
    // on every server restart. Regression test for the 2026-05-04 reset of the +1 flip.
    (tradingConfigRepo.get as any).mockResolvedValueOnce(
      '{"global":1,"minMultiplier":-1,"maxMultiplier":1,"segments":[{"id":"x","multiplier":0.5}]}'
    );

    await wipeDirectionMultiplierSegments();

    expect(tradingConfigRepo.set).toHaveBeenCalledTimes(1);
    const [, value] = (tradingConfigRepo.set as any).mock.calls[0];
    expect(value.global).toBe(1);            // preserved from parsed string, not from default
    expect(value.minMultiplier).toBe(-1);    // preserved
    expect(value.maxMultiplier).toBe(1);     // preserved
    expect(value.segments).toEqual([]);      // wiped
  });

  it('skips the write when segments is already empty (idempotent no-op)', async () => {
    (tradingConfigRepo.get as any).mockResolvedValueOnce({
      global: -1,
      minMultiplier: -1.25,
      maxMultiplier: 1,
      segments: [],
    });

    await wipeDirectionMultiplierSegments();

    expect(tradingConfigRepo.set).not.toHaveBeenCalled();
  });
});
