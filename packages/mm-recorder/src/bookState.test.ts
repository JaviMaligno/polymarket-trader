import { describe, it, expect } from 'vitest';
import { BookState } from './bookState.js';
import type { BookEvent } from './types.js';

const ev = (bid: number | null, ask: number | null): BookEvent => ({
  time: new Date('2024-06-07T20:00:00Z'), tokenId: 'TKN', marketId: 'MKT',
  eventType: 'book', bestBid: bid, bestAsk: ask,
  mid: bid !== null && ask !== null ? (bid + ask) / 2 : null,
});

describe('BookState', () => {
  it('emits a row on first observation', () => {
    const s = new BookState();
    expect(s.apply(ev(0.40, 0.42))).not.toBeNull();
  });

  it('suppresses an unchanged top-of-book', () => {
    const s = new BookState();
    s.apply(ev(0.40, 0.42));
    expect(s.apply(ev(0.40, 0.42))).toBeNull();
  });

  it('emits again when the touch moves', () => {
    const s = new BookState();
    s.apply(ev(0.40, 0.42));
    expect(s.apply(ev(0.41, 0.42))).not.toBeNull();
  });

  it('returns the current mid for a token', () => {
    const s = new BookState();
    s.apply(ev(0.40, 0.42));
    expect(s.midOf('TKN')).toBeCloseTo(0.41, 6);
  });
});
