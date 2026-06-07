import { describe, it, expect } from 'vitest';
import { parseMessage } from './parser.js';

const tsMs = '1717790400000'; // 2024-06-07T20:00:00Z in ms (string, as the feed sends)

describe('parseMessage', () => {
  it('extracts best bid/ask/mid from a book event', () => {
    const raw = JSON.stringify({
      event_type: 'book', asset_id: 'TKN', market: 'MKT', timestamp: tsMs,
      bids: [{ price: '0.40', size: '100' }, { price: '0.39', size: '50' }],
      asks: [{ price: '0.42', size: '80' }, { price: '0.43', size: '20' }],
    });
    const out = parseMessage(raw);
    expect(out.kind).toBe('book');
    if (out.kind !== 'book') return;
    expect(out.event.bestBid).toBe(0.4);
    expect(out.event.bestAsk).toBe(0.42);
    expect(out.event.mid).toBeCloseTo(0.41, 6);
    expect(out.event.tokenId).toBe('TKN');
  });

  it('parses a last_trade_price event', () => {
    const raw = JSON.stringify({
      event_type: 'last_trade_price', asset_id: 'TKN', market: 'MKT',
      price: '0.41', size: '25', side: 'BUY', timestamp: tsMs,
    });
    const out = parseMessage(raw);
    expect(out.kind).toBe('trade');
    if (out.kind !== 'trade') return;
    expect(out.event.price).toBe(0.41);
    expect(out.event.size).toBe(25);
    expect(out.event.side).toBe('BUY');
  });

  it('ignores unrelated event types', () => {
    expect(parseMessage(JSON.stringify({ event_type: 'tick_size_change' })).kind).toBe('ignore');
  });

  it('ignores non-JSON / PONG frames', () => {
    expect(parseMessage('PONG').kind).toBe('ignore');
  });
});
