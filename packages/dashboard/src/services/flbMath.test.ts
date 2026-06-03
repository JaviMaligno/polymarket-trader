import { describe, it, expect } from 'vitest';
import {
  computeEntryCostPct, computeExecutedNoPrice, computeStake, settle, isoWeekKey,
} from './flbMath.js';

describe('flbMath entry pricing', () => {
  it('entry cost pct = (spread/2)/no_mid * 100', () => {
    expect(computeEntryCostPct(0.01, 0.05)).toBeCloseTo(0.5263, 3);
  });
  it('executed no price = no_mid + spread/2', () => {
    expect(computeExecutedNoPrice(0.05, 0.01)).toBeCloseTo(0.955, 6);
  });
  it('stake = (maxPositionPct/100) * initial', () => {
    expect(computeStake(10000, 0.21)).toBeCloseTo(21, 6);
  });
});

describe('flbMath settle', () => {
  it('NO resolution: gross = no_size - stake, net subtracts fee', () => {
    const noSize = 21 / 0.955;
    const r = settle(21, noSize, 0.05, 'no');
    expect(r.grossPnl).toBeCloseTo(noSize - 21, 6);
    expect(r.netPnl).toBeCloseTo(r.grossPnl - 0.05, 6);
  });
  it('YES resolution: full wipeout minus fee', () => {
    // noSize arg (21.99) is irrelevant on YES — only noStake and feePaid matter
    const r = settle(21, 21.99, 0.1, 'yes');
    expect(r.grossPnl).toBeCloseTo(-21, 6);
    expect(r.netPnl).toBeCloseTo(-21.1, 6);
  });
});

describe('flbMath isoWeekKey', () => {
  it('returns YYYY-Www for a known date (2026-06-03 is ISO week 23)', () => {
    expect(isoWeekKey(new Date('2026-06-03T00:00:00Z'))).toBe('2026-W23');
  });
  it('year-boundary: 2025-12-29 is the Monday of ISO week 1 of 2026', () => {
    expect(isoWeekKey(new Date('2025-12-29T00:00:00Z'))).toBe('2026-W01');
  });
});
