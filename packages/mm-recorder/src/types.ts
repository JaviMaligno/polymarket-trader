export interface BookLevel {
  price: number;
  size: number | null;
}

// A `book` frame: full ladder snapshot for one asset.
export interface BookSnapshot {
  time: Date;
  tokenId: string;
  marketId: string;
  eventType: 'book';
  bids: BookLevel[];
  asks: BookLevel[];
}

// A `price_change` entry: one level changed; the feed also reports the
// resulting touch (best_bid/best_ask) which we treat as authoritative for price.
export interface BookDelta {
  time: Date;
  tokenId: string;
  marketId: string;
  eventType: 'price_change';
  price: number;
  size: number;
  side: string; // 'BUY' -> bid ladder, 'SELL' -> ask ladder
  reportedBestBid: number | null;
  reportedBestAsk: number | null;
}

export type BookInput = BookSnapshot | BookDelta;

// Persisted row (existing shape + two queue sizes).
export interface BookEvent {
  time: Date;
  tokenId: string;
  marketId: string;
  eventType: string;
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  bestBidSize: number | null;
  bestAskSize: number | null;
}

export interface TradeEvent {
  time: Date;
  tokenId: string;
  marketId: string;
  price: number;
  size: number | null;
  side: string | null;
}

export type ParsedEvent =
  | { kind: 'book'; event: BookInput }
  | { kind: 'trade'; event: TradeEvent };
