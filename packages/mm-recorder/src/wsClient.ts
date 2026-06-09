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

export interface RecorderDeps {
  assetIds: string[];
  state: BookState;
  sink: BatchSink;
  recordGap: (start: Date, end: Date, reason: string) => Promise<void>;
}

export function runRecorder(deps: RecorderDeps): { stop: () => void } {
  let attempt = 0;
  let ws: WebSocket | null = null;
  let pingTimer: NodeJS.Timeout | null = null;
  let lastUp = new Date();
  let stopped = false;

  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(WS_URL);

    ws.on('open', () => {
      attempt = 0;
      ws!.send(buildSubscribe(deps.assetIds));
      pingTimer = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send('PING'), 10000);
      logger.info({ n: deps.assetIds.length }, 'subscribed');
    });

    ws.on('message', async (data) => {
      const raw = data.toString();
      if (raw === 'PONG') return;
      // A frame can carry many events (the initial book snapshot is an array;
      // a price_change holds one entry per affected asset).
      for (const out of parseMessage(raw)) {
        if (out.kind === 'book') {
          const row = deps.state.apply(out.event);
          if (row) await deps.sink.addBook(row);
        } else if (out.kind === 'trade') {
          await deps.sink.addTrade(out.event);
        }
      }
    });

    const onDown = async (why: string) => {
      if (pingTimer) clearInterval(pingTimer);
      await deps.sink.flush().catch(() => undefined);
      const now = new Date();
      await deps.recordGap(lastUp, now, why).catch(() => undefined);
      lastUp = now;
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
