import WebSocket from 'ws';
import { pino } from 'pino';
import type { BookState } from './bookState.js';
import type { BatchSink } from './sink.js';
import { parseMessage } from './parser.js';

const logger = pino({ name: 'mm-ws' });
const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

export function buildSubscribe(assetIds: string[]): string {
  // No custom_feature_enabled: it floods the stream with new_market catalog
  // frames (CS2/LoL/etc.) we don't need. Plain market subscription gives the
  // book / price_change / last_trade_price events for the subscribed assets.
  return JSON.stringify({ assets_ids: assetIds, type: 'market' });
}

export function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30000);
}

// A capture gap is the window WITHOUT data: [first disconnect, reconnect].
// Multiple downs before a successful reconnect extend the same gap.
export class GapTracker {
  private downAt: Date | null = null;
  private downWhy = '';

  down(at: Date, why: string): void {
    if (this.downAt === null) {
      this.downAt = at;
      this.downWhy = why;
    }
  }

  up(at: Date): { start: Date; end: Date; reason: string } | null {
    if (this.downAt === null) return null;
    const gap = { start: this.downAt, end: at, reason: this.downWhy };
    this.downAt = null;
    return gap;
  }
}

export interface RecorderDeps {
  assetIds: string[];
  state: BookState;
  sink: BatchSink;
  recordGap: (start: Date, end: Date, reason: string) => Promise<void>;
  /** Optional hook for additional consumers (QuoteEngine). Called AFTER applying
   *  the event to BookState. For book events, `row` is the BookEvent (or null if
   *  top-of-book unchanged); for trade events, `row` is null. */
  onEvent?: (kind: 'book' | 'trade', event: unknown, row: unknown) => void;
  /** Optional hook called when a reconnect gap is recorded. */
  onGap?: () => void;
}

/** Exported for testing: process one raw WS message against deps. */
export async function handleMessage(deps: RecorderDeps, raw: string): Promise<void> {
  if (raw === 'PONG') return;
  // A frame can carry many events (the initial book snapshot is an array;
  // a price_change holds one entry per affected asset).
  for (const out of parseMessage(raw)) {
    if (out.kind === 'book') {
      const row = deps.state.apply(out.event);
      if (row) await deps.sink.addBook(row);
      deps.onEvent?.('book', out.event, row);
    } else if (out.kind === 'trade') {
      await deps.sink.addTrade(out.event);
      deps.onEvent?.('trade', out.event, null);
    }
  }
}

export function runRecorder(deps: RecorderDeps): { stop: () => void } {
  let attempt = 0;
  let ws: WebSocket | null = null;
  let pingTimer: NodeJS.Timeout | null = null;
  const gaps = new GapTracker();
  let stopped = false;

  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(WS_URL);

    ws.on('open', () => {
      attempt = 0;
      ws!.send(buildSubscribe(deps.assetIds));
      pingTimer = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send('PING'), 10000);
      const gap = gaps.up(new Date());
      if (gap) {
        deps.recordGap(gap.start, gap.end, gap.reason).catch(() => undefined);
        deps.onGap?.();
      }
      logger.info({ n: deps.assetIds.length }, 'subscribed');
    });

    ws.on('message', (data) => void handleMessage(deps, data.toString()));

    const onDown = async (why: string) => {
      if (pingTimer) clearInterval(pingTimer);
      await deps.sink.flush().catch(() => undefined);
      gaps.down(new Date(), why);
      if (stopped) return;
      const wait = backoffMs(attempt++);
      logger.warn({ why, wait }, 'reconnecting');
      setTimeout(connect, wait);
    };

    ws.on('close', () => onDown('close'));
    ws.on('error', (err) => { logger.error({ err }, 'ws error'); ws?.close(); });
  };

  connect();
  return { stop: () => { stopped = true; if (pingTimer) clearInterval(pingTimer); ws?.close(); } };
}
