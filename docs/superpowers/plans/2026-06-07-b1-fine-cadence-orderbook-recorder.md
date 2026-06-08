# B1 Fine-Cadence Orderbook Recorder + B2 Maker Fill-Sim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture the event-driven top-of-book + trade stream for a handful of liquid `event_financial` markets, then simulate passive-maker fills offline to decide whether H-MM-1's ~35bps/fill survives realistic fills.

**Architecture:** A new standalone TS package `packages/mm-recorder` connects to the Polymarket CLOB market websocket (`ws` raw client), tracks top-of-book in memory, and batch-writes raw events to three new tables. A new Python validator in the existing `scripts/edge-research` harness reads those tables (via a SQL export, same pattern as `mm_trade_spreads.sql`) and computes the maker edge over a (cohort × horizon × queue-proxy) grid. Raw capture and offline sim are decoupled (Architecture A) so the fill model iterates without re-capturing.

**Tech Stack:** Node 20 + TypeScript + `ws` 8.14 + `pg` 8.11 + vitest 1.0 (recorder); Python 3.13 + numpy + pandas (B2, in the edge-research harness); TimescaleDB / local Postgres.

**Spec:** `docs/superpowers/specs/2026-06-07-b1-fine-cadence-orderbook-recorder-design.md`

---

## File Structure

```
packages/mm-recorder/
  package.json                 # new workspace package
  tsconfig.json
  src/
    db.ts                      # pg Pool + query() helper (DATABASE_URL, SSL detect)
    schema.sql                 # mm_book_events / mm_trade_events / mm_capture_gaps
    migrate.ts                 # applies schema.sql (idempotent)
    types.ts                   # BookEvent, TradeEvent, normalized shapes
    parser.ts                  # raw ws message -> BookEvent[] | TradeEvent[]
    bookState.ts               # in-memory top-of-book; emits change events
    sink.ts                    # batch buffer + flush to the 3 tables
    wsClient.ts                # connect/subscribe/ping/reconnect + gap recording
    selectUniverse.ts          # runs the universe SQL, prints asset_ids
    selectUniverse.sql
    index.ts                   # entrypoint: wire selector->ws->bookState->sink
  src/parser.test.ts
  src/bookState.test.ts
  src/sink.test.ts
  src/wsClient.test.ts

scripts/edge-research/
  mm_fine_fills.sql            # export: per crossing trade, maker_price + mid_after@{10s,60s,300s}
  validators/mm_fine.py        # H-MM-3 maker fill-sim validator
  tests/test_mm_fine.py
  registry.yaml                # +1 line: H-MM-3
  data.py                      # +loader for mm_fine_fills.csv

docs/runbooks/
  mm-recorder-taster.md        # local taster runbook
  mm-recorder-vm-campaign.md   # VM campaign runbook (compose + mem_limit)
```

**Checkpoint between Part 1 and Part 2:** after the recorder is built (Tasks 1-9), run the local taster for a few hours, confirm tables populate and RAM footprint is small, THEN build B2 (Tasks 10-13) against the taster data.

---

## Part 1 — The recorder (`packages/mm-recorder`)

### Task 1: Scaffold the package

**Files:**
- Create: `packages/mm-recorder/package.json`
- Create: `packages/mm-recorder/tsconfig.json`
- Create: `packages/mm-recorder/src/db.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@polymarket-trader/mm-recorder",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "migrate": "tsx src/migrate.ts",
    "select-universe": "tsx src/selectUniverse.ts",
    "start": "tsx src/index.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "pg": "^8.11.3",
    "pino": "^8.17.1",
    "ws": "^8.14.2"
  },
  "devDependencies": {
    "@types/node": "^20.10.4",
    "@types/pg": "^8.10.9",
    "@types/ws": "^8.5.10",
    "tsx": "^4.6.2",
    "typescript": "^5.3.3",
    "vitest": "^1.0.4"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`** (mirror data-collector's compiler options)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

- [ ] **Step 3: Create `src/db.ts`** (simplified clone of `data-collector/src/database/connection.ts`)

```typescript
import { Pool } from 'pg';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const connectionString =
      process.env.DATABASE_URL ||
      'postgresql://polymarket:polymarket_dev@localhost:5432/polymarket_trading';
    const isCloudDb =
      connectionString.includes('tsdb.cloud.timescale.com') ||
      connectionString.includes('sslmode=require');
    pool = new Pool({
      connectionString,
      max: parseInt(process.env.DB_POOL_MAX || '4', 10),
      ssl: isCloudDb ? { rejectUnauthorized: false } : undefined,
    });
  }
  return pool;
}

export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await getPool().query(text, params as never[]);
  return res.rows as T[];
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
```

- [ ] **Step 4: Install and verify the workspace resolves**

Run: `pnpm install`
Expected: installs `@polymarket-trader/mm-recorder` deps, no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/mm-recorder/package.json packages/mm-recorder/tsconfig.json packages/mm-recorder/src/db.ts pnpm-lock.yaml
git commit -m "chore(mm-recorder): scaffold package + db helper"
```

---

### Task 2: Schema + migration

**Files:**
- Create: `packages/mm-recorder/src/schema.sql`
- Create: `packages/mm-recorder/src/migrate.ts`

- [ ] **Step 1: Create `src/schema.sql`**

```sql
-- B1 fine-cadence recorder tables. Separate from orderbook_snapshots (prod).
-- create_hypertable is wrapped so this file also works on a plain Postgres
-- (local taster) where TimescaleDB is absent.

CREATE TABLE IF NOT EXISTS mm_book_events (
  time        TIMESTAMPTZ NOT NULL,
  token_id    VARCHAR(128) NOT NULL,
  market_id   VARCHAR(128) NOT NULL,
  event_type  TEXT NOT NULL,
  best_bid    DECIMAL(10,6),
  best_ask    DECIMAL(10,6),
  mid         DECIMAL(10,6)
);
CREATE INDEX IF NOT EXISTS idx_mm_book_token_time ON mm_book_events (token_id, time);

CREATE TABLE IF NOT EXISTS mm_trade_events (
  time        TIMESTAMPTZ NOT NULL,
  token_id    VARCHAR(128) NOT NULL,
  market_id   VARCHAR(128) NOT NULL,
  price       DECIMAL(10,6) NOT NULL,
  size        DECIMAL(20,6),
  side        TEXT
);
CREATE INDEX IF NOT EXISTS idx_mm_trade_token_time ON mm_trade_events (token_id, time);

CREATE TABLE IF NOT EXISTS mm_capture_gaps (
  token_id    VARCHAR(128),
  gap_start   TIMESTAMPTZ NOT NULL,
  gap_end     TIMESTAMPTZ NOT NULL,
  reason      TEXT
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('mm_book_events', 'time', chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);
    PERFORM create_hypertable('mm_trade_events', 'time', chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);
  END IF;
END $$;
```

- [ ] **Step 2: Create `src/migrate.ts`**

```typescript
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getPool, closePool } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const sql = readFileSync(join(here, 'schema.sql'), 'utf8');
  await getPool().query(sql);
  // eslint-disable-next-line no-console
  console.log('mm-recorder schema applied');
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Apply against a local Postgres and verify tables exist**

Run: `DATABASE_URL=postgresql://polymarket:polymarket_dev@localhost:5432/polymarket_trading pnpm --filter @polymarket-trader/mm-recorder migrate`
Expected: prints `mm-recorder schema applied`; `psql ... -c '\dt mm_*'` lists the 3 tables.

- [ ] **Step 4: Commit**

```bash
git add packages/mm-recorder/src/schema.sql packages/mm-recorder/src/migrate.ts
git commit -m "feat(mm-recorder): schema + migration for capture tables"
```

---

### Task 3: Event parser (TDD)

**Files:**
- Create: `packages/mm-recorder/src/types.ts`
- Create: `packages/mm-recorder/src/parser.ts`
- Test: `packages/mm-recorder/src/parser.test.ts`

The CLOB market channel sends JSON with an `event_type`. Relevant shapes (confirmed from Polymarket docs):
- `book`: `{ event_type:"book", asset_id, market, bids:[{price,size}], asks:[{price,size}], timestamp }`
- `price_change`: `{ event_type:"price_change", asset_id, market, changes:[{price,side,size}], timestamp }`
- `last_trade_price`: `{ event_type:"last_trade_price", asset_id, market, price, size, side, timestamp }`

- [ ] **Step 1: Create `src/types.ts`**

```typescript
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
```

- [ ] **Step 2: Write the failing test `src/parser.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { parseMessage } from './parser.js';

const tsMs = '1717790400000'; // 2024-06-07T20:00:00Z in ms (string, as the feed sends)

describe('parseMessage', () => {
  it('extracts best bid/ask/mid from a book event', () => {
    const raw = JSON.stringify({
      event_type: 'book', asset_id: 'TKN', market: 'MKT', timestamp: tsMs,
      bids: [{ price: '0.40', size: '100' }, { price: '0.39', size: '50' }],
      asks: [{ price: '0.42', size: '80' }, { price: '0.43', size: '20' }],
    });
    const out = parseMessage(raw);
    expect(out.kind).toBe('book');
    if (out.kind !== 'book') return;
    expect(out.event.bestBid).toBe(0.4);
    expect(out.event.bestAsk).toBe(0.42);
    expect(out.event.mid).toBeCloseTo(0.41, 6);
    expect(out.event.tokenId).toBe('TKN');
  });

  it('parses a last_trade_price event', () => {
    const raw = JSON.stringify({
      event_type: 'last_trade_price', asset_id: 'TKN', market: 'MKT',
      price: '0.41', size: '25', side: 'BUY', timestamp: tsMs,
    });
    const out = parseMessage(raw);
    expect(out.kind).toBe('trade');
    if (out.kind !== 'trade') return;
    expect(out.event.price).toBe(0.41);
    expect(out.event.size).toBe(25);
    expect(out.event.side).toBe('BUY');
  });

  it('ignores unrelated event types', () => {
    expect(parseMessage(JSON.stringify({ event_type: 'tick_size_change' })).kind).toBe('ignore');
  });

  it('ignores non-JSON / PONG frames', () => {
    expect(parseMessage('PONG').kind).toBe('ignore');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @polymarket-trader/mm-recorder test parser`
Expected: FAIL — `parseMessage` not exported.

- [ ] **Step 4: Create `src/parser.ts`**

```typescript
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @polymarket-trader/mm-recorder test parser`
Expected: PASS (4 tests).

> NOTE during implementation: `price_change` carries `changes:[{price,side,size}]`, not full `bids/asks`. The book-state tracker (Task 4) applies those deltas; `parseMessage` returns `bestBid/bestAsk=null` for `price_change` and the tracker keeps the last known book. Adjust the parser to surface `changes` if Task 4 needs them — covered there.

- [ ] **Step 6: Commit**

```bash
git add packages/mm-recorder/src/types.ts packages/mm-recorder/src/parser.ts packages/mm-recorder/src/parser.test.ts
git commit -m "feat(mm-recorder): ws event parser (book/trade) with tests"
```

---

### Task 4: Top-of-book state tracker (TDD)

**Files:**
- Create: `packages/mm-recorder/src/bookState.ts`
- Test: `packages/mm-recorder/src/bookState.test.ts`

Responsibility: hold the latest top-of-book per token; given a `BookEvent`, decide whether top-of-book actually changed (dedup no-op repeats) and return the row to persist, or `null` if unchanged.

- [ ] **Step 1: Write the failing test `src/bookState.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { BookState } from './bookState.js';
import type { BookEvent } from './types.js';

const ev = (bid: number | null, ask: number | null): BookEvent => ({
  time: new Date('2024-06-07T20:00:00Z'), tokenId: 'TKN', marketId: 'MKT',
  eventType: 'book', bestBid: bid, bestAsk: ask,
  mid: bid !== null && ask !== null ? (bid + ask) / 2 : null,
});

describe('BookState', () => {
  it('emits a row on first observation', () => {
    const s = new BookState();
    expect(s.apply(ev(0.40, 0.42))).not.toBeNull();
  });

  it('suppresses an unchanged top-of-book', () => {
    const s = new BookState();
    s.apply(ev(0.40, 0.42));
    expect(s.apply(ev(0.40, 0.42))).toBeNull();
  });

  it('emits again when the touch moves', () => {
    const s = new BookState();
    s.apply(ev(0.40, 0.42));
    expect(s.apply(ev(0.41, 0.42))).not.toBeNull();
  });

  it('returns the current mid for a token', () => {
    const s = new BookState();
    s.apply(ev(0.40, 0.42));
    expect(s.midOf('TKN')).toBeCloseTo(0.41, 6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @polymarket-trader/mm-recorder test bookState`
Expected: FAIL — `BookState` not found.

- [ ] **Step 3: Create `src/bookState.ts`**

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @polymarket-trader/mm-recorder test bookState`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/mm-recorder/src/bookState.ts packages/mm-recorder/src/bookState.test.ts
git commit -m "feat(mm-recorder): top-of-book state tracker with dedup"
```

---

### Task 5: Persistence sink (TDD)

**Files:**
- Create: `packages/mm-recorder/src/sink.ts`
- Test: `packages/mm-recorder/src/sink.test.ts`

Responsibility: buffer book/trade rows, flush in batches via a injected `query`-like function (so the test uses a fake, no DB). Flush on size threshold or on explicit `flush()`.

- [ ] **Step 1: Write the failing test `src/sink.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { BatchSink } from './sink.js';
import type { BookEvent, TradeEvent } from './types.js';

const book: BookEvent = {
  time: new Date('2024-06-07T20:00:00Z'), tokenId: 'TKN', marketId: 'MKT',
  eventType: 'book', bestBid: 0.4, bestAsk: 0.42, mid: 0.41,
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
  });

  it('auto-flushes when buffer reaches threshold', async () => {
    const exec = vi.fn().mockResolvedValue([]);
    const sink = new BatchSink(exec, 2);
    sink.addBook(book);
    await sink.addBook(book); // threshold reached -> flush
    expect(exec).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @polymarter-trader/mm-recorder test sink` (note: use the real package name `@polymarket-trader/mm-recorder`)
Expected: FAIL — `BatchSink` not found.

- [ ] **Step 3: Create `src/sink.ts`**

```typescript
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
        const o = i * 7;
        values.push(e.time, e.tokenId, e.marketId, e.eventType, e.bestBid, e.bestAsk, e.mid);
        return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7})`;
      });
      await this.exec(
        `INSERT INTO mm_book_events(time,token_id,market_id,event_type,best_bid,best_ask,mid) VALUES ${tuples.join(',')}`,
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @polymarket-trader/mm-recorder test sink`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/mm-recorder/src/sink.ts packages/mm-recorder/src/sink.test.ts
git commit -m "feat(mm-recorder): batch persistence sink with tests"
```

---

### Task 6: Websocket client with reconnect + gap recording (TDD on the testable core)

**Files:**
- Create: `packages/mm-recorder/src/wsClient.ts`
- Test: `packages/mm-recorder/src/wsClient.test.ts`

The live socket is integration-tested by the taster. Unit-test the pure pieces: the subscribe payload builder and the backoff schedule.

- [ ] **Step 1: Write the failing test `src/wsClient.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { buildSubscribe, backoffMs } from './wsClient.js';

describe('wsClient helpers', () => {
  it('builds the market-channel subscribe payload', () => {
    const p = JSON.parse(buildSubscribe(['A', 'B']));
    expect(p.type).toBe('market');
    expect(p.assets_ids).toEqual(['A', 'B']);
    expect(p.custom_feature_enabled).toBe(true);
  });

  it('backoff grows and caps at 30s', () => {
    expect(backoffMs(0)).toBe(1000);
    expect(backoffMs(1)).toBe(2000);
    expect(backoffMs(2)).toBe(4000);
    expect(backoffMs(10)).toBe(30000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @polymarket-trader/mm-recorder test wsClient`
Expected: FAIL — helpers not exported.

- [ ] **Step 3: Create `src/wsClient.ts`**

```typescript
import WebSocket from 'ws';
import { pino } from 'pino';
import type { BookState } from './bookState.js';
import type { BatchSink } from './sink.js';
import { parseMessage } from './parser.js';

const logger = pino({ name: 'mm-ws' });
const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

export function buildSubscribe(assetIds: string[]): string {
  return JSON.stringify({ assets_ids: assetIds, type: 'market', custom_feature_enabled: true });
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
      const out = parseMessage(raw);
      if (out.kind === 'book') {
        const row = deps.state.apply(out.event);
        if (row) await deps.sink.addBook(row);
      } else if (out.kind === 'trade') {
        await deps.sink.addTrade(out.event);
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @polymarket-trader/mm-recorder test wsClient`
Expected: PASS (2 tests). The `runRecorder` live path is exercised by the taster (Task 9).

- [ ] **Step 5: Commit**

```bash
git add packages/mm-recorder/src/wsClient.ts packages/mm-recorder/src/wsClient.test.ts
git commit -m "feat(mm-recorder): ws client with reconnect/backoff + gap recording"
```

---

### Task 7: Universe selector

**Files:**
- Create: `packages/mm-recorder/src/selectUniverse.sql`
- Create: `packages/mm-recorder/src/selectUniverse.ts`

- [ ] **Step 1: Create `src/selectUniverse.sql`** (rank liquid event_financial markets; param `$1` = N)

```sql
-- Top-N liquid event_financial markets to subscribe. Liquid = tight recent book
-- AND active recent trade flow. Emits both YES and NO tokens per market.
WITH recent_book AS (
  SELECT token_id, AVG(best_ask - best_bid) AS avg_spread, COUNT(*) AS n_snap
  FROM orderbook_snapshots
  WHERE time > NOW() - INTERVAL '24 hours'
    AND best_bid IS NOT NULL AND best_ask IS NOT NULL
  GROUP BY token_id
),
recent_trades AS (
  SELECT token_id, COUNT(*) AS n_trades
  FROM trades WHERE time > NOW() - INTERVAL '24 hours'
  GROUP BY token_id
),
ranked AS (
  SELECT m.id AS market_id, m.clob_token_id_yes, m.clob_token_id_no,
         rb.avg_spread, COALESCE(rt.n_trades, 0) AS n_trades
  FROM markets m
  JOIN recent_book rb ON rb.token_id = m.clob_token_id_yes
  LEFT JOIN recent_trades rt ON rt.token_id = m.clob_token_id_yes
  WHERE m.market_type = 'event_financial'
    AND m.tracking_status = 'active'
    AND rb.avg_spread <= 0.05
  ORDER BY rb.avg_spread ASC, n_trades DESC
  LIMIT $1
)
SELECT market_id, clob_token_id_yes AS token_id FROM ranked
UNION ALL
SELECT market_id, clob_token_id_no AS token_id FROM ranked;
```

- [ ] **Step 2: Create `src/selectUniverse.ts`**

```typescript
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { query, closePool } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));

export async function selectUniverse(n: number): Promise<{ market_id: string; token_id: string }[]> {
  const sql = readFileSync(join(here, 'selectUniverse.sql'), 'utf8');
  return query<{ market_id: string; token_id: string }>(sql, [n]);
}

async function main() {
  const n = parseInt(process.env.MM_UNIVERSE_N || '15', 10);
  const rows = await selectUniverse(n);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(rows.map((r) => r.token_id)));
  await closePool();
}

// Run as a script only when invoked directly.
if (process.argv[1] && process.argv[1].endsWith('selectUniverse.ts')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 3: Verify against the VM DB (read-only)**

Run: `MM_UNIVERSE_N=15 DATABASE_URL=... pnpm --filter @polymarket-trader/mm-recorder select-universe`
Expected: prints a JSON array of ~30 token_ids (15 markets × YES/NO). If fewer, lower the spread threshold or N is fine.

- [ ] **Step 4: Commit**

```bash
git add packages/mm-recorder/src/selectUniverse.sql packages/mm-recorder/src/selectUniverse.ts
git commit -m "feat(mm-recorder): liquid event_financial universe selector"
```

---

### Task 8: Entrypoint wiring

**Files:**
- Create: `packages/mm-recorder/src/index.ts`

- [ ] **Step 1: Create `src/index.ts`**

```typescript
import { pino } from 'pino';
import { getPool, closePool, query } from './db.js';
import { selectUniverse } from './selectUniverse.js';
import { BookState } from './bookState.js';
import { BatchSink } from './sink.js';
import { runRecorder } from './wsClient.js';

const logger = pino({ name: 'mm-recorder' });

async function recordGap(start: Date, end: Date, reason: string): Promise<void> {
  await query('INSERT INTO mm_capture_gaps(token_id,gap_start,gap_end,reason) VALUES (NULL,$1,$2,$3)', [start, end, reason]);
}

async function main() {
  const n = parseInt(process.env.MM_UNIVERSE_N || '15', 10);
  const universe = await selectUniverse(n);
  const assetIds = universe.map((r) => r.token_id);
  if (assetIds.length === 0) throw new Error('empty universe — check selector / DB');

  const marketByToken = new Map(universe.map((r) => [r.token_id, r.market_id]));
  const state = new BookState();
  const exec = (sql: string, params: unknown[]) => getPool().query(sql, params as never[]);
  const sink = new BatchSink(exec, parseInt(process.env.MM_BATCH || '200', 10));

  // periodic flush so low-traffic windows still persist
  const flushTimer = setInterval(() => sink.flush().catch(() => undefined), 2000);

  // marketId enrichment: the feed gives market hash; prefer our market_id from the map
  const stateProxy = {
    apply: (e: Parameters<BookState['apply']>[0]) => {
      const row = state.apply(e);
      if (row) row.marketId = marketByToken.get(row.tokenId) ?? row.marketId;
      return row;
    },
    midOf: (t: string) => state.midOf(t),
  } as BookState;

  const handle = runRecorder({ assetIds, state: stateProxy, sink, recordGap });
  logger.info({ markets: n, tokens: assetIds.length }, 'recorder started');

  const shutdown = async () => {
    handle.stop();
    clearInterval(flushTimer);
    await sink.flush().catch(() => undefined);
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => { logger.error({ e }, 'fatal'); process.exit(1); });
```

- [ ] **Step 2: Type-check**

Run: `pnpm --filter @polymarket-trader/mm-recorder build`
Expected: compiles with no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/mm-recorder/src/index.ts
git commit -m "feat(mm-recorder): entrypoint wiring selector->ws->sink"
```

---

### Task 9: Local taster runbook + smoke run

**Files:**
- Create: `docs/runbooks/mm-recorder-taster.md`

- [ ] **Step 1: Create the runbook**

````markdown
# mm-recorder — local taster

Prereq: a local Postgres (or SSH tunnel to the VM DB) with the project schema, so
`orderbook_snapshots` / `trades` / `markets` exist for the selector. The taster needs
the prod DB read access for the universe; capture writes the 3 new tables.

```bash
# 1. apply schema (creates mm_book_events / mm_trade_events / mm_capture_gaps)
DATABASE_URL=<db> pnpm --filter @polymarket-trader/mm-recorder migrate

# 2. sanity-check the universe
MM_UNIVERSE_N=15 DATABASE_URL=<db> pnpm --filter @polymarket-trader/mm-recorder select-universe

# 3. run the recorder for a few hours, then Ctrl-C
MM_UNIVERSE_N=15 DATABASE_URL=<db> pnpm --filter @polymarket-trader/mm-recorder start
```

Validate after ~2-4h:
```sql
SELECT count(*) FROM mm_book_events;           -- > 0, growing
SELECT count(*) FROM mm_trade_events;          -- > 0
SELECT count(*) FROM mm_capture_gaps;          -- ideally 0-few
SELECT token_id, count(*) FROM mm_book_events GROUP BY 1 ORDER BY 2 DESC LIMIT 5;
```
Watch RAM: the node process should sit in low tens of MB. If it grows unbounded, the
sink isn't flushing — investigate before the VM campaign.
````

- [ ] **Step 2: Run the smoke test (manual, a few hours) and confirm rows land**

This is the **Part 1 → Part 2 checkpoint.** Do not start Part 2 until the taster has
produced non-trivial `mm_book_events` + `mm_trade_events` and the RAM footprint is small.

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/mm-recorder-taster.md
git commit -m "docs(mm-recorder): local taster runbook"
```

---

## Part 2 — B2 maker fill-sim (`scripts/edge-research`)

> Build this against the taster data from Task 9.

### Task 10: Fill-candidate SQL export

**Files:**
- Create: `scripts/edge-research/mm_fine_fills.sql`

For each trade, find the prevailing top-of-book just before it, decide the side a maker
would be filled on (trade below mid → it hit the bid → a maker resting at the bid is
filled), and capture the mid at +10s/+60s/+300s for the adverse-selection horizons.

- [ ] **Step 1: Create the SQL**

```sql
-- B2 export: per trade, the maker fill candidate + forward mids. 100% of trades.
-- WINDOW override: psql -v win='7 days' (default 7 days).
\if :{?win}
\else
  \set win '7 days'
\endif

CREATE TEMP TABLE be AS
  SELECT token_id, time AS bt, best_bid, best_ask, mid
  FROM mm_book_events
  WHERE time > NOW() - INTERVAL :'win' AND best_bid IS NOT NULL AND best_ask IS NOT NULL;
CREATE INDEX ON be (token_id, bt);
ANALYZE be;

CREATE TEMP TABLE te AS
  SELECT token_id, market_id, time AS tt, price, size
  FROM mm_trade_events WHERE time > NOW() - INTERVAL :'win';

COPY (
  WITH j AS (
    SELECT t.market_id, t.token_id, t.tt, t.price, t.size,
           b.best_bid, b.best_ask, b.mid AS mid_before
    FROM te t
    LEFT JOIN LATERAL (
      SELECT best_bid, best_ask, mid FROM be
      WHERE be.token_id = t.token_id AND be.bt <= t.tt
      ORDER BY be.bt DESC LIMIT 1) b ON true
  ),
  withmids AS (
    SELECT j.*,
      (SELECT mid FROM be WHERE be.token_id=j.token_id AND be.bt > j.tt AND be.bt <= j.tt + INTERVAL '10 seconds'  ORDER BY be.bt ASC LIMIT 1) AS mid_10s,
      (SELECT mid FROM be WHERE be.token_id=j.token_id AND be.bt > j.tt AND be.bt <= j.tt + INTERVAL '60 seconds'  ORDER BY be.bt DESC LIMIT 1) AS mid_60s,
      (SELECT mid FROM be WHERE be.token_id=j.token_id AND be.bt > j.tt AND be.bt <= j.tt + INTERVAL '300 seconds' ORDER BY be.bt DESC LIMIT 1) AS mid_300s
    FROM j
  )
  SELECT w.market_id, m.market_type, w.token_id, w.tt AS time, w.size, w.price,
         w.best_bid, w.best_ask, w.mid_before, w.mid_10s, w.mid_60s, w.mid_300s,
         -- maker side: trade price below mid => hit the bid => maker_price = best_bid (+1 sign);
         -- above mid => lifted the ask => maker_price = best_ask (-1 sign)
         CASE WHEN w.price < w.mid_before THEN w.best_bid ELSE w.best_ask END AS maker_price,
         CASE WHEN w.price < w.mid_before THEN 1 ELSE -1 END AS maker_sign
  FROM withmids w JOIN markets m ON m.id = w.market_id
  WHERE w.mid_before IS NOT NULL AND w.price <> w.mid_before
) TO STDOUT WITH CSV HEADER;
```

- [ ] **Step 2: Smoke-run against the taster DB and eyeball the CSV**

Run: `psql <db> -f scripts/edge-research/mm_fine_fills.sql | head`
Expected: CSV header + rows with `maker_price`, `maker_sign`, `mid_10s/60s/300s`.

- [ ] **Step 3: Commit**

```bash
git add scripts/edge-research/mm_fine_fills.sql
git commit -m "feat(edge-research): B2 fill-candidate SQL export (mm_fine_fills)"
```

---

### Task 11: H-MM-3 maker fill-sim validator (TDD)

**Files:**
- Create: `scripts/edge-research/validators/mm_fine.py`
- Test: `scripts/edge-research/tests/test_mm_fine.py`

Edge per fill at horizon h: `retained = maker_sign * (maker_price - mid_after_h)`. Report
mean + bootstrap CI per `(market_type × horizon)`, plus a queue-proxy pass restricted to
large trades (`size >= p75`) — if the edge deteriorates there, adverse selection bites when
big informed flow fills you. Pass = positive + bootstrap lo>0 on the pooled tradeable
cohort at the 60s horizon, all-fills.

- [ ] **Step 1: Write the failing test `scripts/edge-research/tests/test_mm_fine.py`**

```python
import pandas as pd
from validators.mm_fine import MMFineValidator

class Ctx:
    def __init__(self, df):
        self.datasets = {"mm_fine_fills": df}
        self.computed_at = "2026-06-07T00:00:00Z"
        self.seed = 0

def _row(mt, maker_price, mid60, sign, size=10.0):
    return {"market_type": mt, "maker_price": maker_price, "mid_60s": mid60,
            "mid_10s": mid60, "mid_300s": mid60, "maker_sign": sign,
            "size": size, "mid_before": 0.5}

def test_positive_retained_spread_passes():
    # maker buys at 0.40 (sign +1), mid drifts to 0.405 -> retained = +1*(0.40-0.405) = -0.005? 
    # No: retained should be maker_price - mid_after for a SELL-perspective; use the validator's sign.
    # Construct: sign +1, maker_price 0.41, mid_60s 0.40 -> retained = +1*(0.41-0.40)=+0.01 (>0)
    rows = [_row("event_financial", 0.41, 0.40, 1) for _ in range(300)]
    v = MMFineValidator()
    out = {f"{r.meta.get('cohort')}": r for r in v.run(Ctx(pd.DataFrame(rows)))}
    fin = next(r for r in v.run(Ctx(pd.DataFrame(rows))) if r.meta.get("cohort") == "event_financial:60s:all")
    assert fin.status == "pass"
    assert fin.edge > 0

def test_below_floor_is_inconclusive():
    rows = [_row("event_financial", 0.41, 0.40, 1) for _ in range(10)]
    v = MMFineValidator()
    res = [r for r in v.run(Ctx(pd.DataFrame(rows))) if r.meta.get("cohort") == "event_financial:60s:all"]
    assert res[0].status == "inconclusive"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/edge-research && python -m pytest tests/test_mm_fine.py -q`
Expected: FAIL — `validators.mm_fine` not found.

- [ ] **Step 3: Create `scripts/edge-research/validators/mm_fine.py`**

```python
from __future__ import annotations
import numpy as np
from verdict import Verdict
from validators.base import bootstrap_ci

_CAVEAT = ("fine-cadence maker fill-sim; fill = trade crossed the touch (queue not "
           "observable); excludes inventory + rewards (H-MM-2)")
_HORIZONS = [("10s", "mid_10s"), ("60s", "mid_60s"), ("300s", "mid_300s")]


class MMFineValidator:
    """H-MM-3 — passive-maker retained spread at fine cadence with realistic fills."""

    hypothesis_id = "H-MM-3"
    hclass = "market_making"

    def required_inputs(self) -> list[str]:
        return ["mm_fine_fills"]

    def run(self, ctx) -> list[Verdict]:
        df = ctx.datasets["mm_fine_fills"].copy()
        df["tradeable"] = df["market_type"] != "event_long"
        p75 = df["size"].quantile(0.75) if len(df) else 0.0
        out: list[Verdict] = []
        groups = [("headline:tradeable", df[df["tradeable"]])]
        for mt in sorted(df["market_type"].dropna().unique()):
            groups.append((mt, df[df["market_type"] == mt]))
        for label, sub in groups:
            for hname, hcol in _HORIZONS:
                out.append(self._cohort(ctx, f"{label}:{hname}:all", sub, hcol))
                out.append(self._cohort(ctx, f"{label}:{hname}:large", sub[sub["size"] >= p75], hcol))
        return out

    def _cohort(self, ctx, label, sub, hcol) -> Verdict:
        floor = getattr(ctx, "mm_min_n", 200)
        s = sub.dropna(subset=[hcol, "maker_price", "maker_sign"])
        n = len(s)
        if n < floor:
            return Verdict(self.hypothesis_id, self.hclass, n, None, None, None,
                           "full", {"cohort": label}, "maker_fee_0", "inconclusive",
                           [_CAVEAT, f"n={n} below floor {floor}"], ctx.computed_at)
        retained = (s["maker_sign"].to_numpy(float) *
                    (s["maker_price"].to_numpy(float) - s[hcol].to_numpy(float)))
        edge = float(retained.mean())
        lo, hi = bootstrap_ci(retained, seed=ctx.seed)
        status = "pass" if (edge > 0 and lo > 0) else "fail"
        return Verdict(self.hypothesis_id, self.hclass, n, edge, edge,
                       float((hi - lo) / 2), "full", {"cohort": label}, "maker_fee_0",
                       status, [_CAVEAT], ctx.computed_at)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/edge-research && python -m pytest tests/test_mm_fine.py -q`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/edge-research/validators/mm_fine.py scripts/edge-research/tests/test_mm_fine.py
git commit -m "feat(edge-research): H-MM-3 fine-cadence maker fill-sim validator"
```

---

### Task 12: Wire H-MM-3 into the harness

**Files:**
- Modify: `scripts/edge-research/registry.yaml`
- Modify: `scripts/edge-research/data.py:122` area (CSV loader)
- Modify: `scripts/edge-research/run.py` (validator dispatch — confirm pattern first)

- [ ] **Step 1: Add the registry line** after the `H-MM-2` entry in `registry.yaml`:

```yaml
- {id: H-MM-3, class: market_making, name: Fine-cadence maker fill-sim, required_data: [mm_fine_fills], status: planned, priority: 2, depends_on: []}
```

- [ ] **Step 2: Add the CSV loader** in `data.py` `load_all_datasets_from_dir`, mirroring the `mm_trade_spreads` block:

```python
    try:
        fine = _read_raw_csv(d / "mm_fine_fills.csv", ["time"])
        out["mm_fine_fills"] = fine if len(fine) else None
    except Exception:
        out["mm_fine_fills"] = None
```

- [ ] **Step 3: Register the validator** — open `run.py`, find where validators are instantiated/dispatched by hypothesis id (same place `MMSpreadValidator` is wired), and add `MMFineValidator`. Show the exact edit after reading the file:

```python
# in run.py, alongside the existing market_making validator import/registration:
from validators.mm_fine import MMFineValidator
# ... and add MMFineValidator() to the list/dispatch that run.py iterates.
```

- [ ] **Step 4: Run the full harness against a taster export and read H-MM-3**

```bash
psql <taster-db> -f scripts/edge-research/mm_fine_fills.sql > /tmp/edge/mm_fine_fills.csv
# also copy the other CSVs that already exist, or accept their inconclusive rows
python scripts/edge-research/run.py --datasets-dir /tmp/edge --out scripts/edge-research/out --computed-at 2026-06-07T00:00:00Z
grep H-MM-3 scripts/edge-research/out/scoreboard.md
```
Expected: H-MM-3 rows per `(cohort × horizon × {all,large})`. On taster data n will likely be `inconclusive` (short capture) — that is the expected preliminary state; the VM campaign fills n.

- [ ] **Step 5: Run all edge-research tests**

Run: `cd scripts/edge-research && python -m pytest -q`
Expected: PASS (existing 9 + new 2).

- [ ] **Step 6: Commit**

```bash
git add scripts/edge-research/registry.yaml scripts/edge-research/data.py scripts/edge-research/run.py
git commit -m "feat(edge-research): wire H-MM-3 into registry/loader/dispatch"
```

---

### Task 13: VM campaign runbook + isolated compose service

**Files:**
- Create: `docs/runbooks/mm-recorder-vm-campaign.md`

- [ ] **Step 1: Create the runbook** (on-demand container, own mem_limit, never a permanent cron)

````markdown
# mm-recorder — VM capture campaign

Run only AFTER the local taster + a preliminary H-MM-3 read justify a 1-2 week capture.
The recorder runs as a SEPARATE, on-demand container on the e2-micro and is removed when
the campaign ends. It is not added to the always-on stack.

```bash
# build image (or reuse a node image + bind-mount the repo)
gcloud compute ssh polymarket-vm --zone=us-east1-b

# inside the VM, in the repo dir, apply schema once:
docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading \
  -f - < packages/mm-recorder/src/schema.sql

# run as a throwaway container with a hard memory cap, env to the local TS DB:
docker run -d --name mm-recorder --memory=80m --restart=unless-stopped \
  -e DATABASE_URL="postgres://polymarket:polymarket_prod@timescaledb:5432/polymarket_trading?sslmode=disable" \
  -e MM_UNIVERSE_N=15 \
  --network <compose-network> \
  <node-image> sh -c "cd /app/packages/mm-recorder && pnpm start"

# monitor
docker stats --no-stream mm-recorder       # expect low tens of MB
docker logs -f mm-recorder

# end the campaign
docker rm -f mm-recorder
```

Daily health check during the campaign:
```sql
SELECT date_trunc('hour', time) h, count(*) FROM mm_book_events
WHERE time > now() - interval '24h' GROUP BY 1 ORDER BY 1 DESC LIMIT 6;
SELECT count(*) FROM mm_capture_gaps WHERE gap_start > now() - interval '24h';
```

When done, export + run B2 for the robust verdict:
```bash
docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading \
  -f /tmp/mm_fine_fills.sql > C:/Users/Usuario/edge-datasets/mm_fine_fills.csv
python scripts/edge-research/run.py --datasets-dir C:/Users/Usuario/edge-datasets \
  --out scripts/edge-research/out --computed-at <ts>
grep H-MM-3 scripts/edge-research/out/scoreboard.md
```
Verdict: positive + bootstrap-significant on `headline:tradeable:60s:all` with a `:large`
that does NOT collapse → market-making edge survives realistic fills → proceed to B3
(rewards) / B4 (quoting engine). Otherwise → market-making closed.
````

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/mm-recorder-vm-campaign.md
git commit -m "docs(mm-recorder): VM capture campaign runbook"
```

---

## Self-review notes (addressed)

- **Spec §2.1 universe selector** → Task 7. **§2.2 recorder** → Tasks 3-6,8. **§2.3 tables** → Task 2.
  **§2.4 + §3 fill model** → Tasks 10-11. **§4 robustness** → Task 6 (reconnect/gaps), Task 8
  (periodic flush), Task 13 (mem_limit). **§5 testing** → Tasks 3-6,11. **§6 flow** → Tasks 9,13.
- **`@polymarket/real-time-data-client` correction**: the plan uses raw `ws` (spec §2.2 updated).
- **`q` grid materialised** as the `:all` vs `:large` queue-proxy split (Task 11), since queue
  depth is unobservable; this is the honest, computable form of the spec's fill-rate grid.
- **Type consistency**: `BookEvent`/`TradeEvent` (Task 3) used identically in Tasks 4,5,6,8;
  `parseMessage`→`BookState.apply`→`BatchSink.addBook/addTrade`→`runRecorder` chain matches.
- **H-MM-3** id chosen (H-MM-1 = 10min proxy, H-MM-2 = rewards, H-MM-3 = fine fill-sim).
