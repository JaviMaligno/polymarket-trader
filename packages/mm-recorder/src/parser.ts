import type { ParsedEvent, BookEvent, TradeEvent } from './types.js';

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function toDate(ts: unknown): Date {
  const n = num(ts);
  return n !== null ? new Date(n) : new Date();
}

function bestOf(levels: unknown, pick: 'max' | 'min'): number | null {
  if (!Array.isArray(levels)) return null;
  const prices = levels.map((l) => num((l as { price?: unknown }).price)).filter((p): p is number => p !== null);
  if (prices.length === 0) return null;
  return pick === 'max' ? Math.max(...prices) : Math.min(...prices);
}

export function parseMessage(raw: string): ParsedEvent {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { kind: 'ignore' };
  }
  const eventType = msg.event_type;
  const tokenId = String(msg.asset_id ?? '');
  const marketId = String(msg.market ?? '');
  if (!tokenId) return { kind: 'ignore' };

  if (eventType === 'book' || eventType === 'price_change' || eventType === 'best_bid_ask') {
    const bestBid = bestOf(msg.bids, 'max');
    const bestAsk = bestOf(msg.asks, 'min');
    const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
    const event: BookEvent = {
      time: toDate(msg.timestamp), tokenId, marketId,
      eventType: String(eventType), bestBid, bestAsk, mid,
    };
    return { kind: 'book', event };
  }

  if (eventType === 'last_trade_price') {
    const price = num(msg.price);
    if (price === null) return { kind: 'ignore' };
    const event: TradeEvent = {
      time: toDate(msg.timestamp), tokenId, marketId,
      price, size: num(msg.size), side: msg.side != null ? String(msg.side) : null,
    };
    return { kind: 'trade', event };
  }

  return { kind: 'ignore' };
}
