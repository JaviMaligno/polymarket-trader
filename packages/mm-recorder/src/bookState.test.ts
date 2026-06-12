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

  it('delta on the SELL side upserts the ask ladder and looks up ask size', () => {
    const s = new BookState();
    s.apply(snap([[0.40, 100]], [[0.42, 80], [0.43, 20]]));
    // best ask level removed -> feed reports new best_ask 0.43; ladder has its size 20
    const row = s.apply(delta(0.42, 0, 'SELL', 0.40, 0.43));
    expect(row).not.toBeNull();
    expect(row!.bestAsk).toBe(0.43);
    expect(row!.bestAskSize).toBe(20);
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

describe('levelSize', () => {
  it('returns the ladder size at a price level and null when unknown', () => {
    const s = new BookState();
    s.apply({
      time: new Date('2026-06-12T10:00:00Z'), tokenId: 'T', marketId: 'M',
      eventType: 'book',
      bids: [{ price: 0.49, size: 100 }, { price: 0.48, size: 50 }],
      asks: [{ price: 0.51, size: 80 }],
    });
    expect(s.levelSize('T', -1, 0.49)).toBe(100);
    expect(s.levelSize('T', -1, 0.48)).toBe(50);
    expect(s.levelSize('T', 1, 0.51)).toBe(80);
    expect(s.levelSize('T', -1, 0.40)).toBeNull();
    expect(s.levelSize('X', -1, 0.49)).toBeNull();
  });

  it('tracks deltas: a price_change updates the level size', () => {
    const s = new BookState();
    s.apply({
      time: new Date('2026-06-12T10:00:00Z'), tokenId: 'T', marketId: 'M',
      eventType: 'book', bids: [{ price: 0.49, size: 100 }], asks: [{ price: 0.51, size: 80 }],
    });
    s.apply({
      time: new Date('2026-06-12T10:00:01Z'), tokenId: 'T', marketId: 'M',
      eventType: 'price_change', price: 0.49, size: 30, side: 'BUY',
      reportedBestBid: 0.49, reportedBestAsk: 0.51,
    });
    expect(s.levelSize('T', -1, 0.49)).toBe(30);
  });
});
