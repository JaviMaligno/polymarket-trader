import { describe, it, expect } from 'vitest';
import { parseMessage } from './parser.js';

const tsMs = '1717790400000'; // ms epoch string, as the feed sends

describe('parseMessage', () => {
  it('parses a book frame into a snapshot with all levels', () => {
    const raw = JSON.stringify({
      event_type: 'book', asset_id: 'TKN', market: 'MKT', timestamp: tsMs,
      bids: [{ price: '0.40', size: '100' }, { price: '0.39', size: '50' }],
      asks: [{ price: '0.42', size: '80' }, { price: '0.43', size: '20' }],
    });
    const out = parseMessage(raw);
    expect(out).toHaveLength(1);
    if (out[0].kind !== 'book' || out[0].event.eventType !== 'book') return;
    const e = out[0].event;
    expect(e.tokenId).toBe('TKN');
    expect(e.bids).toEqual([{ price: 0.4, size: 100 }, { price: 0.39, size: 50 }]);
    expect(e.asks).toEqual([{ price: 0.42, size: 80 }, { price: 0.43, size: 20 }]);
  });

  it('parses an ARRAY frame of book snapshots (initial subscribe)', () => {
    const raw = JSON.stringify([
      { event_type: 'book', asset_id: 'A', market: 'M', timestamp: tsMs, bids: [{ price: '0.30' }], asks: [{ price: '0.32' }] },
      { event_type: 'book', asset_id: 'B', market: 'M', timestamp: tsMs, bids: [{ price: '0.10' }], asks: [{ price: '0.12' }] },
    ]);
    const out = parseMessage(raw);
    expect(out).toHaveLength(2);
    expect(out.map((o) => (o.kind === 'book' ? o.event.tokenId : null))).toEqual(['A', 'B']);
    if (out[0].kind !== 'book' || out[0].event.eventType !== 'book') return;
    expect(out[0].event.bids).toEqual([{ price: 0.3, size: null }]); // size omitted -> null
  });

  it('parses price_change into deltas carrying the changed level + reported best', () => {
    const raw = JSON.stringify({
      event_type: 'price_change', market: 'MKT', timestamp: tsMs,
      price_changes: [
        { asset_id: 'YES', price: '0.13', size: '0', side: 'BUY', best_bid: '0.27', best_ask: '0.28' },
        { asset_id: 'NO', price: '0.87', size: '5', side: 'SELL', best_bid: '0.72', best_ask: '0.73' },
      ],
    });
    const out = parseMessage(raw);
    expect(out).toHaveLength(2);
    if (out[0].kind !== 'book' || out[0].event.eventType !== 'price_change') return;
    const d0 = out[0].event;
    expect(d0.tokenId).toBe('YES');
    expect(d0.price).toBe(0.13);
    expect(d0.size).toBe(0);
    expect(d0.side).toBe('BUY');
    expect(d0.reportedBestBid).toBe(0.27);
    expect(d0.reportedBestAsk).toBe(0.28);
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
