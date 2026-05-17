import { describe, it, expect } from 'vitest';
import {
  parseForceIncludeIds,
  parseVolumeWeight,
  rankMarketsByVolumeScoreBlend,
  DEFAULT_VOLUME_WEIGHT,
  type RankableMarket,
} from './MarketSelector.js';

describe('parseForceIncludeIds', () => {
  it('returns empty set when env is unset', () => {
    expect(parseForceIncludeIds(undefined).size).toBe(0);
  });

  it('returns empty set for empty string', () => {
    expect(parseForceIncludeIds('').size).toBe(0);
  });

  it('parses single id', () => {
    const ids = parseForceIncludeIds('abc');
    expect(ids.has('abc')).toBe(true);
    expect(ids.size).toBe(1);
  });

  it('parses comma-separated ids', () => {
    const ids = parseForceIncludeIds('abc,def,ghi');
    expect(ids.size).toBe(3);
    expect(ids.has('abc')).toBe(true);
    expect(ids.has('def')).toBe(true);
    expect(ids.has('ghi')).toBe(true);
  });

  it('trims whitespace around ids', () => {
    const ids = parseForceIncludeIds('  abc  ,   def , ghi  ');
    expect(ids.size).toBe(3);
    expect(ids.has('abc')).toBe(true);
  });

  it('ignores empty entries from trailing commas', () => {
    const ids = parseForceIncludeIds('abc,,def,');
    expect(ids.size).toBe(2);
  });
});

describe('parseVolumeWeight', () => {
  it('returns default when env unset', () => {
    expect(parseVolumeWeight(undefined)).toBe(DEFAULT_VOLUME_WEIGHT);
  });

  it('parses valid number in [0, 1]', () => {
    expect(parseVolumeWeight('0.3')).toBeCloseTo(0.3);
    expect(parseVolumeWeight('0.0')).toBe(0);
    expect(parseVolumeWeight('1.0')).toBe(1);
  });

  it('clamps below 0 to 0', () => {
    expect(parseVolumeWeight('-0.5')).toBe(0);
  });

  it('clamps above 1 to 1', () => {
    expect(parseVolumeWeight('1.5')).toBe(1);
    expect(parseVolumeWeight('10')).toBe(1);
  });

  it('returns default on non-numeric input (typo-safe)', () => {
    expect(parseVolumeWeight('abc')).toBe(DEFAULT_VOLUME_WEIGHT);
    expect(parseVolumeWeight('')).toBe(DEFAULT_VOLUME_WEIGHT);
  });
});

describe('rankMarketsByVolumeScoreBlend', () => {
  const make = (id: string, volume: number, marketScore?: number): RankableMarket => ({
    id, volume, marketScore,
  });

  it('returns empty array for empty input', () => {
    expect(rankMarketsByVolumeScoreBlend([], 0.5)).toEqual([]);
  });

  it('weight=1 sorts purely by volume desc', () => {
    const m = [make('a', 100, 0.1), make('b', 300, 0.9), make('c', 200, 0.5)];
    const ranked = rankMarketsByVolumeScoreBlend(m, 1);
    expect(ranked.map(r => r.market.id)).toEqual(['b', 'c', 'a']);
  });

  it('weight=0 sorts purely by marketScore desc (missing scores go last)', () => {
    const m = [make('a', 999, 0.1), make('b', 1, 0.9), make('c', 500, undefined)];
    const ranked = rankMarketsByVolumeScoreBlend(m, 0);
    expect(ranked[0].market.id).toBe('b');
    expect(ranked[1].market.id).toBe('a');
    expect(ranked[2].market.id).toBe('c');  // missing score → last
  });

  it('weight=0.5 blends both: a high-volume-low-score and high-score-low-volume both rank high', () => {
    // Volume rank:  big_vol=1, med=2, low_vol_high_score=3, small=4
    // Score rank:   low_vol_high_score=1, big_vol=2, med=3, small=4
    // Blended:      big_vol=1.5, low_vol_high_score=2.0, med=2.5, small=4.0
    const m = [
      make('big_vol', 1000, 0.5),
      make('med', 500, 0.3),
      make('low_vol_high_score', 100, 0.95),
      make('small', 50, 0.1),
    ];
    const ranked = rankMarketsByVolumeScoreBlend(m, 0.5);
    expect(ranked[0].market.id).toBe('big_vol');
    expect(ranked[1].market.id).toBe('low_vol_high_score');
    expect(ranked[2].market.id).toBe('med');
    expect(ranked[3].market.id).toBe('small');
  });

  it('attaches diagnostic info: blendedRank, volumeRank, scoreRank', () => {
    const m = [make('a', 100, 0.5), make('b', 200, 0.9)];
    const ranked = rankMarketsByVolumeScoreBlend(m, 0.5);
    expect(ranked[0].blendedRank).toBeDefined();
    expect(ranked[0].volumeRank).toBeDefined();
    expect(ranked[0].scoreRank).toBeDefined();
    expect(ranked[0].blendedRank).toBeLessThanOrEqual(ranked[1].blendedRank);
  });

  it('handles ties in volume deterministically', () => {
    const m = [make('a', 100, 0.5), make('b', 100, 0.5)];
    const ranked = rankMarketsByVolumeScoreBlend(m, 0.5);
    // Both should be present, order is determined by sort stability + input order
    expect(ranked).toHaveLength(2);
    expect(new Set(ranked.map(r => r.market.id))).toEqual(new Set(['a', 'b']));
  });

  it('missing marketScore on all markets — score rank determined by input order, blend still works', () => {
    // Volume rank: b=1, c=2, a=3 (sorted by volume desc).
    // Score rank: all -Infinity → stable sort keeps input order a=1, b=2, c=3.
    // Blended @0.5: a=(3+1)/2/3=0.667  b=(1+2)/2/3=0.5  c=(2+3)/2/3=0.833.
    // Best (lowest blended) → b; then a; then c.
    const m = [make('a', 100), make('b', 300), make('c', 200)];
    const ranked = rankMarketsByVolumeScoreBlend(m, 0.5);
    expect(ranked[0].market.id).toBe('b');
    expect(ranked[1].market.id).toBe('a');
    expect(ranked[2].market.id).toBe('c');
  });
});
