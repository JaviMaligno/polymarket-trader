import { describe, it, expect } from 'vitest';
import { pickMarketsForCycle, type ActiveMarketLike } from './SignalEngine.js';

// Helper: synthetic markets with just the fields the picker reads.
const m = (id: string, marketType: string): ActiveMarketLike => ({
  id, marketType,
  // Other fields irrelevant for the round-robin pick — keep minimal.
} as ActiveMarketLike);

describe('pickMarketsForCycle', () => {
  it('returns all markets when count <= maxMarketsPerCycle', () => {
    const ms = [m('a', 'event_long'), m('b', 'crypto_daily')];
    expect(pickMarketsForCycle(ms, 10).map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('returns empty array when input is empty', () => {
    expect(pickMarketsForCycle([], 10)).toEqual([]);
  });

  it('returns empty array when maxMarketsPerCycle is 0', () => {
    expect(pickMarketsForCycle([m('a', 'event_long')], 0)).toEqual([]);
  });

  it('round-robins across types when input is biased', () => {
    // Biased input: 6 event_long, 2 crypto_daily, 1 event_short
    const ms = [
      m('l1', 'event_long'), m('l2', 'event_long'), m('l3', 'event_long'),
      m('l4', 'event_long'), m('l5', 'event_long'), m('l6', 'event_long'),
      m('c1', 'crypto_daily'), m('c2', 'crypto_daily'),
      m('s1', 'event_short'),
    ];
    const picked = pickMarketsForCycle(ms, 6).map((x) => x.id);
    // Expect round-robin: l1, c1, s1, l2, c2, l3 (one from each type per cycle
    // until that type is exhausted).
    expect(picked).toEqual(['l1', 'c1', 's1', 'l2', 'c2', 'l3']);
  });

  it('skips exhausted types and continues with the rest', () => {
    // event_short has 1 market, others have 3 — after 1 round, event_short is
    // exhausted and the remaining slots are filled from the survivors.
    const ms = [
      m('l1', 'event_long'), m('l2', 'event_long'), m('l3', 'event_long'),
      m('c1', 'crypto_daily'), m('c2', 'crypto_daily'), m('c3', 'crypto_daily'),
      m('s1', 'event_short'),
    ];
    const picked = pickMarketsForCycle(ms, 7).map((x) => x.id);
    // Round 1: l1, c1, s1. Round 2: l2, c2 (s exhausted). Round 3: l3, c3.
    expect(picked).toEqual(['l1', 'c1', 's1', 'l2', 'c2', 'l3', 'c3']);
  });

  it('treats markets with missing marketType as a single "unknown" bucket', () => {
    const ms = [
      m('a', 'event_long'),
      { id: 'b' } as ActiveMarketLike,           // no marketType
      { id: 'c', marketType: undefined } as ActiveMarketLike,
      m('d', 'event_long'),
    ];
    const picked = pickMarketsForCycle(ms, 3).map((x) => x.id);
    // Round 1: a (event_long), b (unknown). Round 2: d.
    // The 'unknown' bucket gets one slot per round just like any other type.
    expect(picked).toEqual(['a', 'b', 'd']);
  });

  it('preserves bucket-internal order (does not sort)', () => {
    const ms = [
      m('z', 'event_long'), m('a', 'event_long'),
      m('y', 'crypto_daily'), m('b', 'crypto_daily'),
    ];
    expect(pickMarketsForCycle(ms, 4).map((x) => x.id)).toEqual(['z', 'y', 'a', 'b']);
  });
});
