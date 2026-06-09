import { describe, it, expect, vi } from 'vitest';
import { BatchSink } from './sink.js';
import type { BookEvent, TradeEvent } from './types.js';

const book: BookEvent = {
  time: new Date('2024-06-07T20:00:00Z'), tokenId: 'TKN', marketId: 'MKT',
  eventType: 'book', bestBid: 0.4, bestAsk: 0.42, mid: 0.41,
  bestBidSize: 100, bestAskSize: 80,
};
const trade: TradeEvent = {
  time: new Date('2024-06-07T20:00:01Z'), tokenId: 'TKN', marketId: 'MKT',
  price: 0.41, size: 10, side: 'BUY',
};

describe('BatchSink', () => {
  it('does not write before the threshold', async () => {
    const exec = vi.fn().mockResolvedValue([]);
    const sink = new BatchSink(exec, 5);
    sink.addBook(book);
    expect(exec).not.toHaveBeenCalled();
  });

  it('flushes book + trade rows on explicit flush()', async () => {
    const exec = vi.fn().mockResolvedValue([]);
    const sink = new BatchSink(exec, 100);
    sink.addBook(book);
    sink.addTrade(trade);
    await sink.flush();
    // one INSERT for books, one for trades
    expect(exec).toHaveBeenCalledTimes(2);
    const sqls = exec.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('mm_book_events'))).toBe(true);
    expect(sqls.some((s) => s.includes('mm_trade_events'))).toBe(true);
    const bookSql = sqls.find((s) => s.includes('mm_book_events'))!;
    expect(bookSql).toContain('best_bid_size');
    expect(bookSql).toContain('best_ask_size');
  });

  it('auto-flushes when buffer reaches threshold', async () => {
    const exec = vi.fn().mockResolvedValue([]);
    const sink = new BatchSink(exec, 2);
    sink.addBook(book);
    await sink.addBook(book); // threshold reached -> flush
    expect(exec).toHaveBeenCalled();
  });
});
