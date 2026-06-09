import { describe, it, expect } from 'vitest';
import { BookState } from './bookState.js';
import type { BookSnapshot, BookDelta } from './types.js';

const t = new Date('2024-06-07T20:00:00Z');
const snap = (bids: [number, number | null][], asks: [number, number | null][]): BookSnapshot => ({
  time: t, tokenId: 'TKN', marketId: 'MKT', eventType: 'book',
  bids: bids.map(([price, size]) => ({ price, size })),
  asks: asks.map(([price, size]) => ({ price, size })),
});
const delta = (price: number, size: number, side: string, bb: number | null, ba: number | null): BookDelta => ({
  time: t, tokenId: 'TKN', marketId: 'MKT', eventType: 'price_change',
  price, size, side, reportedBestBid: bb, reportedBestAsk: ba,
});

describe('BookState', () => {
  it('emits best price + size from a snapshot', () => {
    const s = new BookState();
    const row = s.apply(snap([[0.40, 100], [0.39, 50]], [[0.42, 80], [0.43, 20]]));
    expect(row).not.toBeNull();
    expect(row!.bestBid).toBe(0.40);
    expect(row!.bestBidSize).toBe(100);
    expect(row!.bestAsk).toBe(0.42);
    expect(row!.bestAskSize).toBe(80);
    expect(row!.mid).toBeCloseTo(0.41, 6);
  });

  it('suppresses an unchanged top-of-book (price AND size)', () => {
    const s = new BookState();
    s.apply(snap([[0.40, 100]], [[0.42, 80]]));
    expect(s.apply(snap([[0.40, 100]], [[0.42, 80]]))).toBeNull();
  });

  it('emits again when only the touch size changes', () => {
    const s = new BookState();
    s.apply(snap([[0.40, 100]], [[0.42, 80]]));
    const row = s.apply(snap([[0.40, 60]], [[0.42, 80]]));
    expect(row).not.toBeNull();
    expect(row!.bestBidSize).toBe(60);
  });

  it('delta uses reported best for price, ladder for size', () => {
    const s = new BookState();
    s.apply(snap([[0.40, 100], [0.39, 50]], [[0.42, 80]]));
    const row = s.apply(delta(0.40, 0, 'BUY', 0.39, 0.42));
    expect(row).not.toBeNull();
    expect(row!.bestBid).toBe(0.39);
    expect(row!.bestBidSize).toBe(50);
  });

  it('delta size lookup is null when the reported best price is unknown to the ladder', () => {
    const s = new BookState();
    s.apply(snap([[0.40, 100]], [[0.42, 80]]));
    const row = s.apply(delta(0.41, 30, 'BUY', 0.41, 0.42));
    expect(row!.bestBid).toBe(0.41);
    expect(row!.bestBidSize).toBe(30);
    const row2 = s.apply(delta(0.405, 0, 'BUY', 0.405, 0.42));
    expect(row2!.bestBid).toBe(0.405);
    expect(row2!.bestBidSize).toBeNull();
  });

  it('returns the current mid for a token', () => {
    const s = new BookState();
    s.apply(snap([[0.40, 100]], [[0.42, 80]]));
    expect(s.midOf('TKN')).toBeCloseTo(0.41, 6);
  });
});
