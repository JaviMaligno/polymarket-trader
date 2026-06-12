import type { BookEvent, BookInput } from './types.js';

interface Ladder {
  bids: Map<number, number | null>;
  asks: Map<number, number | null>;
}
interface Top {
  bid: number | null; ask: number | null;
  bidSize: number | null; askSize: number | null;
}

export class BookState {
  private books = new Map<string, Ladder>();
  private lastTop = new Map<string, Top>();

  /** Apply a parsed book input; returns the row to persist, or null if the
   *  top-of-book (price or size) is unchanged. */
  apply(input: BookInput): BookEvent | null {
    const ladder = this.books.get(input.tokenId) ?? { bids: new Map(), asks: new Map() };

    let bestBid: number | null;
    let bestAsk: number | null;

    if (input.eventType === 'book') {
      ladder.bids = new Map();
      ladder.asks = new Map();
      for (const l of input.bids) ladder.bids.set(l.price, l.size);
      for (const l of input.asks) ladder.asks.set(l.price, l.size);
      bestBid = ladder.bids.size ? Math.max(...ladder.bids.keys()) : null;
      bestAsk = ladder.asks.size ? Math.min(...ladder.asks.keys()) : null;
    } else {
      const side = input.side === 'BUY' ? ladder.bids : ladder.asks;
      if (input.size <= 0) side.delete(input.price);
      else side.set(input.price, input.size);
      // price is authoritative from the feed; size is best-effort from the ladder
      bestBid = input.reportedBestBid;
      bestAsk = input.reportedBestAsk;
    }

    this.books.set(input.tokenId, ladder);

    if (bestBid === null && bestAsk === null) return null;

    const bestBidSize = bestBid !== null ? (ladder.bids.get(bestBid) ?? null) : null;
    const bestAskSize = bestAsk !== null ? (ladder.asks.get(bestAsk) ?? null) : null;

    const prev = this.lastTop.get(input.tokenId);
    if (prev && prev.bid === bestBid && prev.ask === bestAsk &&
        prev.bidSize === bestBidSize && prev.askSize === bestAskSize) {
      return null;
    }
    this.lastTop.set(input.tokenId, { bid: bestBid, ask: bestAsk, bidSize: bestBidSize, askSize: bestAskSize });

    const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
    return {
      time: input.time, tokenId: input.tokenId, marketId: input.marketId,
      eventType: input.eventType, bestBid, bestAsk, mid, bestBidSize, bestAskSize,
    };
  }

  midOf(tokenId: string): number | null {
    const p = this.lastTop.get(tokenId);
    if (!p || p.bid === null || p.ask === null) return null;
    return (p.bid + p.ask) / 2;
  }

  /** Size actual del nivel `price` en el lado `side` (-1 bids, +1 asks);
   *  null si el token o el nivel no se conocen. */
  levelSize(tokenId: string, side: -1 | 1, price: number): number | null {
    const ladder = this.books.get(tokenId);
    if (!ladder) return null;
    const m = side === -1 ? ladder.bids : ladder.asks;
    const v = m.get(price);
    return v ?? null;
  }
}
