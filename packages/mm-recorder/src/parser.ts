import type { ParsedEvent, BookEvent, TradeEvent } from './types.js';

// Polymarket CLOB market-channel frames (confirmed live 2026-06-08):
//   - a frame may be a SINGLE object or an ARRAY of objects (the initial `book`
//     snapshot arrives as an array, one element per subscribed asset).
//   - book:             { event_type:"book", asset_id, market, bids:[{price,size}], asks:[...], timestamp }
//   - price_change:     { event_type:"price_change", market, timestamp,
//                         price_changes:[{ asset_id, price, side, size, best_bid, best_ask }] }
//                       (asset_id + best_bid/best_ask live INSIDE each price_changes entry, NOT at top level)
//   - last_trade_price: { event_type:"last_trade_price", asset_id, market, price, size, side, timestamp }
//   - anything else (new_market, tick_size_change, ...) is ignored.

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

function mid(bid: number | null, ask: number | null): number | null {
  return bid !== null && ask !== null ? (bid + ask) / 2 : null;
}

function bookEvent(
  tokenId: string, market: unknown, ts: unknown, eventType: string,
  bestBid: number | null, bestAsk: number | null,
): ParsedEvent | null {
  if (!tokenId) return null;
  if (bestBid === null && bestAsk === null) return null;
  const event: BookEvent = {
    time: toDate(ts), tokenId, marketId: String(market ?? ''),
    eventType, bestBid, bestAsk, mid: mid(bestBid, bestAsk),
  };
  return { kind: 'book', event };
}

function parseFrame(m: Record<string, unknown>): ParsedEvent[] {
  const eventType = m.event_type;

  if (eventType === 'book') {
    const e = bookEvent(String(m.asset_id ?? ''), m.market, m.timestamp, 'book',
      bestOf(m.bids, 'max'), bestOf(m.asks, 'min'));
    return e ? [e] : [];
  }

  if (eventType === 'price_change') {
    const changes = Array.isArray(m.price_changes) ? m.price_changes : [];
    const out: ParsedEvent[] = [];
    for (const c of changes) {
      const ch = c as Record<string, unknown>;
      const e = bookEvent(String(ch.asset_id ?? ''), m.market, m.timestamp, 'price_change',
        num(ch.best_bid), num(ch.best_ask));
      if (e) out.push(e);
    }
    return out;
  }

  if (eventType === 'last_trade_price') {
    const tokenId = String(m.asset_id ?? '');
    const price = num(m.price);
    if (!tokenId || price === null) return [];
    const event: TradeEvent = {
      time: toDate(m.timestamp), tokenId, marketId: String(m.market ?? ''),
      price, size: num(m.size), side: m.side != null ? String(m.side) : null,
    };
    return [{ kind: 'trade', event }];
  }

  return [];
}

/** Parse one raw websocket frame into zero or more normalized events.
 *  A frame may be a single object or an array of objects. */
export function parseMessage(raw: string): ParsedEvent[] {
  if (raw === 'PONG') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const frames = Array.isArray(parsed) ? parsed : [parsed];
  const out: ParsedEvent[] = [];
  for (const f of frames) {
    if (f && typeof f === 'object') out.push(...parseFrame(f as Record<string, unknown>));
  }
  return out;
}
