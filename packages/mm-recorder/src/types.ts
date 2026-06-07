export interface BookEvent {
  time: Date;
  tokenId: string;
  marketId: string;
  eventType: string;
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
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
  | { kind: 'book'; event: BookEvent }
  | { kind: 'trade'; event: TradeEvent }
  | { kind: 'ignore' };
