import type { BookEvent } from './types.js';

export class BookState {
  private last = new Map<string, { bid: number | null; ask: number | null }>();

  /** Returns the event to persist, or null if top-of-book is unchanged. */
  apply(e: BookEvent): BookEvent | null {
    if (e.bestBid === null && e.bestAsk === null) return null;
    const prev = this.last.get(e.tokenId);
    if (prev && prev.bid === e.bestBid && prev.ask === e.bestAsk) return null;
    this.last.set(e.tokenId, { bid: e.bestBid, ask: e.bestAsk });
    return e;
  }

  midOf(tokenId: string): number | null {
    const p = this.last.get(tokenId);
    if (!p || p.bid === null || p.ask === null) return null;
    return (p.bid + p.ask) / 2;
  }
}
