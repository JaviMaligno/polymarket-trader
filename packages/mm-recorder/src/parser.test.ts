import { describe, it, expect } from 'vitest';
import { parseMessage } from './parser.js';

const tsMs = '1717790400000'; // ms epoch string, as the feed sends

describe('parseMessage', () => {
  it('parses a book frame (best bid = max, best ask = min)', () => {
    const raw = JSON.stringify({
      event_type: 'book', asset_id: 'TKN', market: 'MKT', timestamp: tsMs,
      bids: [{ price: '0.40', size: '100' }, { price: '0.39', size: '50' }],
      asks: [{ price: '0.42', size: '80' }, { price: '0.43', size: '20' }],
    });
    const out = parseMessage(raw);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('book');
    if (out[0].kind !== 'book') return;
    expect(out[0].event.bestBid).toBe(0.4);
    expect(out[0].event.bestAsk).toBe(0.42);
    expect(out[0].event.mid).toBeCloseTo(0.41, 6);
    expect(out[0].event.tokenId).toBe('TKN');
  });

  it('parses an ARRAY frame of book snapshots (initial subscribe)', () => {
    const raw = JSON.stringify([
      { event_type: 'book', asset_id: 'A', market: 'M', timestamp: tsMs, bids: [{ price: '0.30' }], asks: [{ price: '0.32' }] },
      { event_type: 'book', asset_id: 'B', market: 'M', timestamp: tsMs, bids: [{ price: '0.10' }], asks: [{ price: '0.12' }] },
    ]);
    const out = parseMessage(raw);
    expect(out).toHaveLength(2);
    expect(out.map((o) => (o.kind === 'book' ? o.event.tokenId : null))).toEqual(['A', 'B']);
  });

  it('parses price_change: one book event per price_changes entry, best_bid/best_ask from the entry', () => {
    const raw = JSON.stringify({
      event_type: 'price_change', market: 'MKT', timestamp: tsMs,
      price_changes: [
        { asset_id: 'YES', price: '0.13', size: '0', side: 'BUY', best_bid: '0.27', best_ask: '0.28' },
        { asset_id: 'NO', price: '0.87', size: '0', side: 'SELL', best_bid: '0.72', best_ask: '0.73' },
      ],
    });
    const out = parseMessage(raw);
    expect(out).toHaveLength(2);
    if (out[0].kind !== 'book') return;
    expect(out[0].event.tokenId).toBe('YES');
    expect(out[0].event.bestBid).toBe(0.27);
    expect(out[0].event.bestAsk).toBe(0.28);
    expect(out[0].event.mid).toBeCloseTo(0.275, 6);
    expect(out[0].event.eventType).toBe('price_change');
    if (out[1].kind !== 'book') return;
    expect(out[1].event.tokenId).toBe('NO');
    expect(out[1].event.bestBid).toBe(0.72);
  });

  it('parses a last_trade_price event', () => {
    const raw = JSON.stringify({
      event_type: 'last_trade_price', asset_id: 'TKN', market: 'MKT',
      price: '0.41', size: '25', side: 'BUY', timestamp: tsMs,
    });
    const out = parseMessage(raw);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('trade');
    if (out[0].kind !== 'trade') return;
    expect(out[0].event.price).toBe(0.41);
    expect(out[0].event.size).toBe(25);
    expect(out[0].event.side).toBe('BUY');
  });

  it('ignores new_market and tick_size_change frames', () => {
    expect(parseMessage(JSON.stringify({ id: '1', question: 'x', market: 'M', slug: 's' }))).toEqual([]);
    expect(parseMessage(JSON.stringify({ event_type: 'tick_size_change', asset_id: 'T' }))).toEqual([]);
  });

  it('ignores empty arrays, PONG and non-JSON frames', () => {
    expect(parseMessage('[]')).toEqual([]);
    expect(parseMessage('PONG')).toEqual([]);
    expect(parseMessage('not json')).toEqual([]);
  });
});
