import { describe, it, expect, vi } from 'vitest';
import { parseRewards, chunk, fetchGammaMarkets, snapshotRewards } from './rewards.js';

const TODAY = '2026-06-10';

describe('parseRewards', () => {
  it('extracts quoting params and the active daily rate', () => {
    const m = {
      conditionId: '0xabc',
      rewardsMinSize: 50,
      rewardsMaxSpread: 4.5,
      clobRewards: [
        { rewardsDailyRate: 1, startDate: '2026-06-08', endDate: '2500-12-31' },
      ],
    };
    expect(parseRewards(m, TODAY)).toEqual({
      marketId: '0xabc', minSize: 50, maxSpread: 4.5, dailyRate: 1,
    });
  });

  it('sums multiple concurrently-active reward programs', () => {
    const m = {
      conditionId: '0xabc', rewardsMinSize: 20, rewardsMaxSpread: 3.5,
      clobRewards: [
        { rewardsDailyRate: 1, startDate: '2026-01-01', endDate: '2500-12-31' },
        { rewardsDailyRate: 2.5, startDate: '2026-06-01', endDate: '2026-12-31' },
      ],
    };
    expect(parseRewards(m, TODAY)!.dailyRate).toBe(3.5);
  });

  it('ignores expired and not-yet-started programs', () => {
    const m = {
      conditionId: '0xabc', rewardsMinSize: 50, rewardsMaxSpread: 4.5,
      clobRewards: [
        { rewardsDailyRate: 9, startDate: '2026-01-01', endDate: '2026-06-09' },
        { rewardsDailyRate: 7, startDate: '2026-06-11', endDate: '2026-12-31' },
      ],
    };
    expect(parseRewards(m, TODAY)!.dailyRate).toBeNull();
  });

  it('zero quoting params are kept as 0 (no program), missing map to null', () => {
    const zero = parseRewards({ conditionId: '0x1', rewardsMinSize: 0, rewardsMaxSpread: 0 }, TODAY)!;
    expect(zero.minSize).toBe(0);
    expect(zero.maxSpread).toBe(0);
    expect(zero.dailyRate).toBeNull();
    const missing = parseRewards({ conditionId: '0x2' }, TODAY)!;
    expect(missing.minSize).toBeNull();
    expect(missing.maxSpread).toBeNull();
  });

  it('returns null without a conditionId', () => {
    expect(parseRewards({ rewardsMinSize: 50 }, TODAY)).toBeNull();
  });
});

describe('chunk', () => {
  it('splits into fixed-size chunks', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });
});

describe('fetchGammaMarkets', () => {
  it('queries gamma with repeated condition_ids params, one request per chunk', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => [{ conditionId: 'x' }] } as never;
    });
    const ids = Array.from({ length: 25 }, (_, i) => `0x${i}`);
    const out = await fetchGammaMarkets(ids, fetchImpl as never);
    expect(calls.length).toBe(2); // chunks of 20
    expect(calls[0]).toContain('condition_ids=0x0');
    expect(calls[0]).toContain('condition_ids=0x19');
    expect(calls[1]).toContain('condition_ids=0x20');
    expect(out.length).toBe(2);
  });

  it('a failed chunk is skipped, the rest still return', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error('boom');
      return { ok: true, json: async () => [{ conditionId: 'ok' }] } as never;
    });
    const ids = Array.from({ length: 25 }, (_, i) => `0x${i}`);
    const out = await fetchGammaMarkets(ids, fetchImpl as never);
    expect(out.length).toBe(1);
  });
});

describe('snapshotRewards', () => {
  it('ensures the table and inserts one row per parsed market', async () => {
    const exec = vi.fn(async () => ({ rows: [] }));
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => [
        { conditionId: '0xa', rewardsMinSize: 50, rewardsMaxSpread: 4.5, clobRewards: [] },
        { conditionId: '0xb', rewardsMinSize: 0, rewardsMaxSpread: 0 },
      ],
    })) as never;
    const n = await snapshotRewards(exec as never, ['0xa', '0xb'], fetchImpl);
    expect(n).toBe(2);
    const sqls = (exec.mock.calls as unknown as [string, unknown[]][]).map((c) => c[0]);
    expect(sqls[0]).toContain('CREATE TABLE IF NOT EXISTS mm_reward_snapshots');
    expect(sqls.some((s) => s.includes('CREATE INDEX IF NOT EXISTS idx_mm_rewards_market_time'))).toBe(true);
    expect(sqls.filter((s) => s.includes('INSERT INTO mm_reward_snapshots')).length).toBe(2);
  });
});
