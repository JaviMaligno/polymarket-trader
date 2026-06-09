import type { BookEvent, TradeEvent } from './types.js';

type Exec = (sql: string, params: unknown[]) => Promise<unknown>;

export class BatchSink {
  private books: BookEvent[] = [];
  private trades: TradeEvent[] = [];

  constructor(private exec: Exec, private threshold = 200) {}

  addBook(e: BookEvent): Promise<void> {
    this.books.push(e);
    return this.maybeFlush();
  }

  addTrade(e: TradeEvent): Promise<void> {
    this.trades.push(e);
    return this.maybeFlush();
  }

  private async maybeFlush(): Promise<void> {
    if (this.books.length + this.trades.length >= this.threshold) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.books.length) {
      const rows = this.books;
      this.books = [];
      const values: unknown[] = [];
      const tuples = rows.map((e, i) => {
        const o = i * 9;
        values.push(e.time, e.tokenId, e.marketId, e.eventType, e.bestBid, e.bestAsk, e.mid, e.bestBidSize, e.bestAskSize);
        return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9})`;
      });
      await this.exec(
        `INSERT INTO mm_book_events(time,token_id,market_id,event_type,best_bid,best_ask,mid,best_bid_size,best_ask_size) VALUES ${tuples.join(',')}`,
        values,
      );
    }
    if (this.trades.length) {
      const rows = this.trades;
      this.trades = [];
      const values: unknown[] = [];
      const tuples = rows.map((e, i) => {
        const o = i * 6;
        values.push(e.time, e.tokenId, e.marketId, e.price, e.size, e.side);
        return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6})`;
      });
      await this.exec(
        `INSERT INTO mm_trade_events(time,token_id,market_id,price,size,side) VALUES ${tuples.join(',')}`,
        values,
      );
    }
  }
}
