# H-MM-3 Queue-Reactive Fill-Sim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace H-MM-3's optimistic 100%-fill assumption with a queue-reactive continuous-quoting fill model (front/back bounds), fed by top-of-queue sizes the recorder reconstructs from the L2 feed, and expand the recorder universe to event_financial + event_long + event_short.

**Architecture:** The `mm-recorder` parser stops pre-reducing book frames to best bid/ask; instead it emits per-level inputs (`BookInput`). `BookState` maintains a per-token L2 ladder, derives best price (authoritative from the feed) + best size (from the ladder), dedups, and persists `best_bid_size`/`best_ask_size` alongside the existing columns. The edge-research export adds those sizes asof each trade; the `mm_fine.py` validator walks each token's trades chronologically as a two-sided maker, filling only once adverse aggressor volume clears the queue ahead (back bound) or immediately (front bound ≈ today's model).

**Tech Stack:** TypeScript (mm-recorder, vitest), Postgres/TimescaleDB (psql scripts), Python 3.13 (edge-research harness, pytest, pandas/numpy), Docker Compose on GCP e2-micro.

**Spec:** `docs/superpowers/specs/2026-06-09-h-mm-3-queue-reactive-fillsim-design.md`

---

## File Structure

**Recorder (`packages/mm-recorder/src/`):**
- `types.ts` — Modify: add `BookLevel`, `BookSnapshot`, `BookDelta`, `BookInput`; add `bestBidSize`/`bestAskSize` to `BookEvent`; change `ParsedEvent` `book` payload to `BookInput`.
- `parser.ts` — Modify: emit `BookInput` (levels + reported best) instead of pre-reduced `BookEvent`.
- `bookState.ts` — Modify: maintain per-token L2 ladder, compute best price + size, dedup on top-of-book incl. sizes.
- `sink.ts` — Modify: persist the two new columns.
- `schema.sql` — Modify: idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for the two sizes.
- `selectUniverse.sql` — Modify: 3 market types.
- Tests: `parser.test.ts`, `bookState.test.ts`, `sink.test.ts` — Modify alongside.

**Harness (`scripts/edge-research/`):**
- `mm_fine_fills.sql` — Modify: export `best_bid_size`/`best_ask_size` asof.
- `validators/mm_fine.py` — Modify: queue-reactive walk + front/back × size split.
- `tests/test_mm_fine.py` — Modify: walk tests.
- `tests/test_data.py` — Modify: loader test with new columns.

**Deploy:** `MM_UNIVERSE_N` in `docker-compose.gcp.yml`; runbook (no code).

**Ordering note:** Tasks 1–6 (recorder + schema + universe) must deploy and accumulate ~3–5 days of fresh capture before the validator's **back** bound has data (legacy rows have NULL sizes). Tasks 7–9 (export + validator + tests) can be written immediately; the **front** bound works on all history.

---

## Task 1: Recorder types — per-level book inputs + sizes on BookEvent

**Files:**
- Modify: `packages/mm-recorder/src/types.ts`

- [ ] **Step 1: Replace types.ts with the level-aware types**

```typescript
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
```

- [ ] **Step 2: Typecheck the package**

Run: `cd packages/mm-recorder && npx tsc --noEmit`
Expected: errors ONLY in `parser.ts`, `bookState.ts`, `sink.ts`, and their tests (they still use the old shapes) — these are fixed in Tasks 2–4. No errors elsewhere.

- [ ] **Step 3: Commit**

```bash
git add packages/mm-recorder/src/types.ts
git commit -m "refactor(mm-recorder): level-aware BookInput types + queue sizes on BookEvent"
```

---

## Task 2: Parser — emit per-level BookInput

**Files:**
- Modify: `packages/mm-recorder/src/parser.ts`
- Test: `packages/mm-recorder/src/parser.test.ts`

- [ ] **Step 1: Rewrite the parser.test.ts book/price_change cases to expect BookInput**

Replace the first three `it(...)` blocks (the `book` single, `book` array, and `price_change` cases) with:

```typescript
  it('parses a book frame into a snapshot with all levels', () => {
    const raw = JSON.stringify({
      event_type: 'book', asset_id: 'TKN', market: 'MKT', timestamp: tsMs,
      bids: [{ price: '0.40', size: '100' }, { price: '0.39', size: '50' }],
      asks: [{ price: '0.42', size: '80' }, { price: '0.43', size: '20' }],
    });
    const out = parseMessage(raw);
    expect(out).toHaveLength(1);
    if (out[0].kind !== 'book' || out[0].event.eventType !== 'book') return;
    const e = out[0].event;
    expect(e.tokenId).toBe('TKN');
    expect(e.bids).toEqual([{ price: 0.4, size: 100 }, { price: 0.39, size: 50 }]);
    expect(e.asks).toEqual([{ price: 0.42, size: 80 }, { price: 0.43, size: 20 }]);
  });

  it('parses an ARRAY frame of book snapshots (initial subscribe)', () => {
    const raw = JSON.stringify([
      { event_type: 'book', asset_id: 'A', market: 'M', timestamp: tsMs, bids: [{ price: '0.30' }], asks: [{ price: '0.32' }] },
      { event_type: 'book', asset_id: 'B', market: 'M', timestamp: tsMs, bids: [{ price: '0.10' }], asks: [{ price: '0.12' }] },
    ]);
    const out = parseMessage(raw);
    expect(out).toHaveLength(2);
    expect(out.map((o) => (o.kind === 'book' ? o.event.tokenId : null))).toEqual(['A', 'B']);
    if (out[0].kind !== 'book' || out[0].event.eventType !== 'book') return;
    expect(out[0].event.bids).toEqual([{ price: 0.3, size: null }]); // size omitted -> null
  });

  it('parses price_change into deltas carrying the changed level + reported best', () => {
    const raw = JSON.stringify({
      event_type: 'price_change', market: 'MKT', timestamp: tsMs,
      price_changes: [
        { asset_id: 'YES', price: '0.13', size: '0', side: 'BUY', best_bid: '0.27', best_ask: '0.28' },
        { asset_id: 'NO', price: '0.87', size: '5', side: 'SELL', best_bid: '0.72', best_ask: '0.73' },
      ],
    });
    const out = parseMessage(raw);
    expect(out).toHaveLength(2);
    if (out[0].kind !== 'book' || out[0].event.eventType !== 'price_change') return;
    const d0 = out[0].event;
    expect(d0.tokenId).toBe('YES');
    expect(d0.price).toBe(0.13);
    expect(d0.size).toBe(0);
    expect(d0.side).toBe('BUY');
    expect(d0.reportedBestBid).toBe(0.27);
    expect(d0.reportedBestAsk).toBe(0.28);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/mm-recorder && npx vitest run src/parser.test.ts`
Expected: FAIL — the parser still emits the old reduced `BookEvent` (no `bids`/`price` fields).

- [ ] **Step 3: Rewrite parser.ts book/price_change branches**

Replace the `bestOf`, `mid`, `bookEvent`, and `parseFrame` book/price_change sections with level emission. Keep `num`, `toDate`, the `last_trade_price` branch, and `parseMessage` unchanged. New `parseFrame`:

```typescript
function levels(raw: unknown): BookLevel[] {
  if (!Array.isArray(raw)) return [];
  const out: BookLevel[] = [];
  for (const l of raw) {
    const price = num((l as { price?: unknown }).price);
    if (price === null) continue;
    out.push({ price, size: num((l as { size?: unknown }).size) });
  }
  return out;
}

function parseFrame(m: Record<string, unknown>): ParsedEvent[] {
  const eventType = m.event_type;

  if (eventType === 'book') {
    const tokenId = String(m.asset_id ?? '');
    if (!tokenId) return [];
    const snap: BookSnapshot = {
      time: toDate(m.timestamp), tokenId, marketId: String(m.market ?? ''),
      eventType: 'book', bids: levels(m.bids), asks: levels(m.asks),
    };
    return [{ kind: 'book', event: snap }];
  }

  if (eventType === 'price_change') {
    const changes = Array.isArray(m.price_changes) ? m.price_changes : [];
    const out: ParsedEvent[] = [];
    for (const c of changes) {
      const ch = c as Record<string, unknown>;
      const tokenId = String(ch.asset_id ?? '');
      const price = num(ch.price);
      if (!tokenId || price === null) continue;
      const delta: BookDelta = {
        time: toDate(m.timestamp), tokenId, marketId: String(m.market ?? ''),
        eventType: 'price_change', price, size: num(ch.size) ?? 0,
        side: String(ch.side ?? ''),
        reportedBestBid: num(ch.best_bid), reportedBestAsk: num(ch.best_ask),
      };
      out.push({ kind: 'book', event: delta });
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
```

Update the import line at the top of `parser.ts` to:

```typescript
import type { ParsedEvent, BookLevel, BookSnapshot, BookDelta, TradeEvent } from './types.js';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/mm-recorder && npx vitest run src/parser.test.ts`
Expected: PASS (all parser tests).

- [ ] **Step 5: Commit**

```bash
git add packages/mm-recorder/src/parser.ts packages/mm-recorder/src/parser.test.ts
git commit -m "refactor(mm-recorder): parser emits per-level BookInput (snapshot/delta)"
```

---

## Task 3: BookState — L2 ladder reconstruction + best sizes

**Files:**
- Modify: `packages/mm-recorder/src/bookState.ts`
- Test: `packages/mm-recorder/src/bookState.test.ts`

- [ ] **Step 1: Rewrite bookState.test.ts for ladder-based input**

```typescript
import { describe, it, expect } from 'vitest';
import { BookState } from './bookState.js';
import type { BookSnapshot, BookDelta } from './types.js';

const t = new Date('2024-06-07T20:00:00Z');
const snap = (bids: [number, number | null][], asks: [number, number | null][]): BookSnapshot => ({
  time: t, tokenId: 'TKN', marketId: 'MKT', eventType: 'book',
  bids: bids.map(([price, size]) => ({ price, size })),
  asks: asks.map(([price, size]) => ({ price, size })),
});
const delta = (price: number, size: number, side: string, bb: number | null, ba: number | null): BookDelta => ({
  time: t, tokenId: 'TKN', marketId: 'MKT', eventType: 'price_change',
  price, size, side, reportedBestBid: bb, reportedBestAsk: ba,
});

describe('BookState', () => {
  it('emits best price + size from a snapshot', () => {
    const s = new BookState();
    const row = s.apply(snap([[0.40, 100], [0.39, 50]], [[0.42, 80], [0.43, 20]]));
    expect(row).not.toBeNull();
    expect(row!.bestBid).toBe(0.40);
    expect(row!.bestBidSize).toBe(100);
    expect(row!.bestAsk).toBe(0.42);
    expect(row!.bestAskSize).toBe(80);
    expect(row!.mid).toBeCloseTo(0.41, 6);
  });

  it('suppresses an unchanged top-of-book (price AND size)', () => {
    const s = new BookState();
    s.apply(snap([[0.40, 100]], [[0.42, 80]]));
    expect(s.apply(snap([[0.40, 100]], [[0.42, 80]]))).toBeNull();
  });

  it('emits again when only the touch size changes', () => {
    const s = new BookState();
    s.apply(snap([[0.40, 100]], [[0.42, 80]]));
    const row = s.apply(snap([[0.40, 60]], [[0.42, 80]]));
    expect(row).not.toBeNull();
    expect(row!.bestBidSize).toBe(60);
  });

  it('delta uses reported best for price, ladder for size', () => {
    const s = new BookState();
    s.apply(snap([[0.40, 100], [0.39, 50]], [[0.42, 80]]));
    // best bid level removed -> feed reports new best_bid 0.39, ladder has its size 50
    const row = s.apply(delta(0.40, 0, 'BUY', 0.39, 0.42));
    expect(row).not.toBeNull();
    expect(row!.bestBid).toBe(0.39);
    expect(row!.bestBidSize).toBe(50);
  });

  it('delta size lookup is null when the reported best price is unknown to the ladder', () => {
    const s = new BookState();
    s.apply(snap([[0.40, 100]], [[0.42, 80]]));
    // feed jumps best_bid to a price we never saw added
    const row = s.apply(delta(0.41, 30, 'BUY', 0.41, 0.42));
    expect(row!.bestBid).toBe(0.41);
    expect(row!.bestBidSize).toBe(30); // we DID see 0.41 added with size 30
    const row2 = s.apply(delta(0.405, 0, 'BUY', 0.405, 0.42)); // 0.405 never added
    expect(row2!.bestBid).toBe(0.405);
    expect(row2!.bestBidSize).toBeNull();
  });

  it('returns the current mid for a token', () => {
    const s = new BookState();
    s.apply(snap([[0.40, 100]], [[0.42, 80]]));
    expect(s.midOf('TKN')).toBeCloseTo(0.41, 6);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/mm-recorder && npx vitest run src/bookState.test.ts`
Expected: FAIL — `apply` still takes the old `BookEvent` and has no ladder/sizes.

- [ ] **Step 3: Rewrite bookState.ts**

```typescript
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
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/mm-recorder && npx vitest run src/bookState.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mm-recorder/src/bookState.ts packages/mm-recorder/src/bookState.test.ts
git commit -m "feat(mm-recorder): L2 ladder reconstruction + best_bid/ask sizes"
```

---

## Task 4: Sink + schema — persist the two sizes

**Files:**
- Modify: `packages/mm-recorder/src/sink.ts`
- Modify: `packages/mm-recorder/src/schema.sql`
- Test: `packages/mm-recorder/src/sink.test.ts`

- [ ] **Step 1: Update sink.test.ts book fixture + assert 9-column insert**

Replace the `book` fixture and add a column assertion to the flush test:

```typescript
const book: BookEvent = {
  time: new Date('2024-06-07T20:00:00Z'), tokenId: 'TKN', marketId: 'MKT',
  eventType: 'book', bestBid: 0.4, bestAsk: 0.42, mid: 0.41,
  bestBidSize: 100, bestAskSize: 80,
};
```

In the `flushes book + trade rows` test, after the existing assertions, add:

```typescript
    const bookSql = sqls.find((s) => s.includes('mm_book_events'))!;
    expect(bookSql).toContain('best_bid_size');
    expect(bookSql).toContain('best_ask_size');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/mm-recorder && npx vitest run src/sink.test.ts`
Expected: FAIL — insert SQL lacks the size columns (and `BookEvent` fixture now has extra fields the old insert ignores).

- [ ] **Step 3: Update the book INSERT in sink.ts**

Replace the book-flush block (the `if (this.books.length) { ... }` body) with a 9-column insert:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/mm-recorder && npx vitest run src/sink.test.ts`
Expected: PASS.

- [ ] **Step 5: Add idempotent ALTER to schema.sql**

Append after the `mm_book_events` `CREATE INDEX` line (after line 14):

```sql
ALTER TABLE mm_book_events ADD COLUMN IF NOT EXISTS best_bid_size DECIMAL(20,6);
ALTER TABLE mm_book_events ADD COLUMN IF NOT EXISTS best_ask_size DECIMAL(20,6);
```

Also add the two columns to the inline `CREATE TABLE IF NOT EXISTS mm_book_events` definition (for fresh installs), so the block reads:

```sql
CREATE TABLE IF NOT EXISTS mm_book_events (
  time          TIMESTAMPTZ NOT NULL,
  token_id      VARCHAR(128) NOT NULL,
  market_id     VARCHAR(128) NOT NULL,
  event_type    TEXT NOT NULL,
  best_bid      DECIMAL(10,6),
  best_ask      DECIMAL(10,6),
  mid           DECIMAL(10,6),
  best_bid_size DECIMAL(20,6),
  best_ask_size DECIMAL(20,6)
);
```

- [ ] **Step 6: Run the full recorder suite + typecheck**

Run: `cd packages/mm-recorder && npx tsc --noEmit && npx vitest run`
Expected: PASS, no type errors. (wsClient.ts compiles because `state.apply(out.event)` now takes a `BookInput` and `out.event` is a `BookInput`.)

- [ ] **Step 7: Commit**

```bash
git add packages/mm-recorder/src/sink.ts packages/mm-recorder/src/sink.test.ts packages/mm-recorder/src/schema.sql
git commit -m "feat(mm-recorder): persist best_bid_size/best_ask_size; idempotent schema ALTER"
```

---

## Task 5: Expand recorder universe to three types

**Files:**
- Modify: `packages/mm-recorder/src/selectUniverse.sql`
- Modify: `docker-compose.gcp.yml:380` (`MM_UNIVERSE_N`)

- [ ] **Step 1: Change the market_type filter in selectUniverse.sql**

Replace line 21 (`WHERE m.market_type = 'event_financial'`) with:

```sql
  WHERE m.market_type IN ('event_financial', 'event_long', 'event_short')
```

Update the header comment (lines 1–2) to:

```sql
-- Top-N liquid market-making candidates to subscribe (event_financial +
-- event_long + event_short). Liquid = tight recent book AND active recent trade
-- flow. Emits both YES and NO tokens per market.
```

- [ ] **Step 2: Bump MM_UNIVERSE_N in docker-compose.gcp.yml**

Change `MM_UNIVERSE_N: "15"` (line ~380, under the `mm-recorder` service) to:

```yaml
      MM_UNIVERSE_N: "45"
```

(Covers today's ~41 quoteable markets across the three types; 45 markets → ~90 tokens, within the 120M mem_limit. Re-check `docker stats` after deploy per Task 9.)

- [ ] **Step 3: Verify the SQL parses against the VM (read-only check)**

Run (local, reads VM):
```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command='docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -t -c "SELECT COUNT(*) FROM markets m WHERE m.market_type IN ('"'"'event_financial'"'"','"'"'event_long'"'"','"'"'event_short'"'"') AND m.tracking_status='"'"'active'"'"'"'
```
Expected: a non-zero count (≈37 today). This only sanity-checks the predicate; the full ranked query runs at recorder start.

- [ ] **Step 4: Commit**

```bash
git add packages/mm-recorder/src/selectUniverse.sql docker-compose.gcp.yml
git commit -m "feat(mm-recorder): expand universe to event_financial+long+short, N=45"
```

---

## Task 6: Export — add best_bid_size/best_ask_size to mm_fine_fills.sql

**Files:**
- Modify: `scripts/edge-research/mm_fine_fills.sql`

- [ ] **Step 1: Add the touch sizes to the `be` temp table and the asof lateral**

In `mm_fine_fills.sql`, change the `be` temp table SELECT to also carry the sizes:

```sql
CREATE TEMP TABLE be AS
  SELECT token_id, time AS bt, best_bid, best_ask, mid, best_bid_size, best_ask_size
  FROM mm_book_events
  WHERE time > NOW() - INTERVAL :'win' AND best_bid IS NOT NULL AND best_ask IS NOT NULL;
```

In the `j` CTE's `LEFT JOIN LATERAL` that selects `mid_before`, add the two sizes:

```sql
    LEFT JOIN LATERAL (
      SELECT best_bid, best_ask, mid, best_bid_size, best_ask_size FROM be
      WHERE be.token_id = t.token_id AND be.bt <= t.tt
      ORDER BY be.bt DESC LIMIT 1) b ON true
```

In the `withmids` CTE, pass them through (it already does `SELECT j.*`), and add to the final `SELECT` column list (after `w.mid_before`):

```sql
         w.best_bid_size, w.best_ask_size,
```

- [ ] **Step 2: Verify the export runs and emits the new columns (local, reads VM)**

```bash
gcloud compute scp scripts/edge-research/mm_fine_fills.sql polymarket-vm:/tmp/mm_ff_check.sql --zone=us-east1-b
gcloud compute ssh polymarket-vm --zone=us-east1-b --command='docker exec -i polymarket-timescaledb psql -U polymarket -d polymarket_trading -q < /tmp/mm_ff_check.sql' | head -1
gcloud compute ssh polymarket-vm --zone=us-east1-b --command='rm -f /tmp/mm_ff_check.sql'
```
Expected: header line ends with `...,best_bid_size,best_ask_size` (sizes will be NULL on pre-Task-1..5-deploy rows — that is expected).

- [ ] **Step 3: Commit**

```bash
git add scripts/edge-research/mm_fine_fills.sql
git commit -m "feat(edge-research): export touch queue sizes in mm_fine_fills"
```

---

## Task 7: Loader test for the new export columns

**Files:**
- Modify: `scripts/edge-research/tests/test_data.py`

The loader (`load_all_datasets_from_dir`) reads `mm_fine_fills.csv` with date-col parsing only and passes numeric columns through, so no `data.py` change is needed. This task locks that the extra columns load.

- [ ] **Step 1: Extend the mixed-timestamp regression test to include sizes**

In `test_load_from_dir_mm_fine_fills_mixed_timestamp_formats`, add the two columns to the DataFrame dict (before `.to_csv`):

```python
        "best_bid_size": [500.0, 250.0],
        "best_ask_size": [400.0, 300.0],
```

And after the existing asserts, add:

```python
    assert {"best_bid_size", "best_ask_size"}.issubset(out["mm_fine_fills"].columns)
```

- [ ] **Step 2: Run the test**

Run: `cd scripts/edge-research && python -m pytest -q tests/test_data.py`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add scripts/edge-research/tests/test_data.py
git commit -m "test(edge-research): mm_fine_fills loader carries touch-size columns"
```

---

## Task 8: Validator — queue-reactive walk with front/back bounds

**Files:**
- Modify: `scripts/edge-research/validators/mm_fine.py`
- Test: `scripts/edge-research/tests/test_mm_fine.py`

The walk: per token, two-sided maker. `maker_sign == -1` ⇒ the trade hit the BID (maker bought at best_bid); `maker_sign == +1` ⇒ hit the ASK. The trade's `size` reduces `size_ahead` on that side; when it reaches ≤0 the maker fills (record retained for each horizon), then re-places with `size_ahead =` that side's touch size (`best_bid_size`/`best_ask_size`) for the **back** bound, or 0 for the **front** bound.

- [ ] **Step 1: Write failing tests in test_mm_fine.py**

Read the existing `tests/test_mm_fine.py` first to match its construction helpers, then add:

```python
import pandas as pd, types
from validators.mm_fine import MMFineValidator


def _ctx(df, min_n=1):
    return types.SimpleNamespace(datasets={"mm_fine_fills": df}, cost=0.005,
                                 computed_at="x", n_bins=10, min_n=200,
                                 mm_min_n=min_n, seed=7)


def _row(tt, maker_sign, size, touch_size, maker_price, mid_after):
    # one trade row; mid_before set so price-vs-mid is consistent with maker_sign
    mid_before = 0.50
    price = 0.40 if maker_sign == -1 else 0.60
    return {
        "market_id": "0xabc", "market_type": "event_financial", "token_id": "T",
        "time": pd.Timestamp(tt, tz="UTC"), "size": size, "price": price,
        "best_bid": 0.49, "best_ask": 0.51, "mid_before": mid_before,
        "mid_10s": mid_after, "mid_60s": mid_after, "mid_300s": mid_after,
        "maker_price": maker_price, "maker_sign": maker_sign,
        "best_bid_size": touch_size, "best_ask_size": touch_size,
    }


def test_front_bound_fills_every_adverse_trade():
    # 3 bid-side trades; front bound (size_ahead=0) fills on all 3.
    df = pd.DataFrame([
        _row("2026-06-09T10:00:00", -1, 10, 1000, 0.49, 0.50),
        _row("2026-06-09T10:00:01", -1, 10, 1000, 0.49, 0.50),
        _row("2026-06-09T10:00:02", -1, 10, 1000, 0.49, 0.50),
    ])
    out = MMFineValidator().run(_ctx(df))
    front = [v for v in out if v.class_metric["cohort"] == "event_financial:10s:all:front"]
    assert len(front) == 1
    assert front[0].n == 3


def test_back_bound_waits_for_queue_to_clear():
    # touch queue = 1000; trades of 10 each. Back bound: 100 trades of 10 needed
    # to clear the queue before the maker's first fill. With only 3 trades -> 0 fills.
    df = pd.DataFrame([
        _row("2026-06-09T10:00:00", -1, 10, 1000, 0.49, 0.50),
        _row("2026-06-09T10:00:01", -1, 10, 1000, 0.49, 0.50),
        _row("2026-06-09T10:00:02", -1, 10, 1000, 0.49, 0.50),
    ])
    out = MMFineValidator().run(_ctx(df))
    back = [v for v in out if v.class_metric["cohort"] == "event_financial:10s:all:back"]
    assert len(back) == 1
    assert back[0].n == 0  # queue never cleared


def test_back_bound_fills_after_volume_exceeds_queue():
    # queue 20; a 25-size trade clears it (25 >= 20) and fills the maker on that trade.
    df = pd.DataFrame([_row("2026-06-09T10:00:00", -1, 25, 20, 0.49, 0.50)])
    out = MMFineValidator().run(_ctx(df))
    back = [v for v in out if v.class_metric["cohort"] == "event_financial:10s:all:back"]
    assert back[0].n == 1


def test_emits_front_and_back_size_split_cohorts():
    df = pd.DataFrame([_row("2026-06-09T10:00:00", -1, 10, 5, 0.49, 0.50)])
    labels = {v.class_metric["cohort"] for v in MMFineValidator().run(_ctx(df))}
    for bound in ("front", "back"):
        for size in ("all", "large"):
            assert f"event_financial:10s:{size}:{bound}" in labels
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd scripts/edge-research && python -m pytest -q tests/test_mm_fine.py`
Expected: FAIL — current validator has no walk, no `:front`/`:back` cohorts.

- [ ] **Step 3: Rewrite mm_fine.py**

```python
from __future__ import annotations
import numpy as np
from verdict import Verdict
from validators.base import bootstrap_ci

_CAVEAT = ("fine-cadence maker fill-sim, queue-reactive (front/back bounds); exact "
           "queue position unobservable without live orders; excludes inventory + "
           "rewards (H-MM-2)")
_HORIZONS = [("10s", "mid_10s"), ("60s", "mid_60s"), ("300s", "mid_300s")]


class MMFineValidator:
    """H-MM-3 — passive-maker retained spread, queue-reactive fills (front/back)."""

    hypothesis_id = "H-MM-3"
    hclass = "market_making"

    def required_inputs(self) -> list[str]:
        return ["mm_fine_fills"]

    def run(self, ctx) -> list[Verdict]:
        df = ctx.datasets["mm_fine_fills"].copy()
        df["tradeable"] = df["market_type"] != "event_long"
        p75 = df["size"].quantile(0.75) if len(df) else 0.0

        # Walk each token once per bound; collect fill records.
        fills = []  # dicts: market_type, tradeable, size, retained per horizon
        for bound in ("front", "back"):
            for _tok, sub in df.sort_values("time").groupby("token_id", sort=False):
                fills.extend(self._walk(sub, bound))
        fdf = self._to_frame(fills)

        groups = [("headline:tradeable", lambda d: d["tradeable"])]
        for mt in sorted(df["market_type"].dropna().unique()):
            groups.append((mt, (lambda m: (lambda d: d["market_type"] == m))(mt)))

        out: list[Verdict] = []
        for label, mask in groups:
            base = fdf[mask(fdf)] if len(fdf) else fdf
            for hname, hcol in _HORIZONS:
                for size_label in ("all", "large"):
                    sized = base if size_label == "all" else base[base["size"] >= p75]
                    for bound in ("front", "back"):
                        cohort = f"{label}:{hname}:{size_label}:{bound}"
                        sub = sized[sized["bound"] == bound]
                        out.append(self._verdict(ctx, cohort, sub, hcol))
        return out

    def _walk(self, sub, bound) -> list[dict]:
        """Continuous two-sided maker over one token's trades (time-sorted).
        Returns a fill record per fill for this bound."""
        size_ahead = {-1: None, 1: None}  # -1 bid side, +1 ask side; None = not placed
        out = []
        for r in sub.itertuples(index=False):
            sign = int(r.maker_sign)
            if sign not in (-1, 1):
                continue
            touch = r.best_bid_size if sign == -1 else r.best_ask_size
            if size_ahead[sign] is None:  # (re)place
                size_ahead[sign] = 0.0 if bound == "front" else self._queue(touch)
            tsize = float(r.size) if r.size == r.size else 0.0  # NaN-safe
            size_ahead[sign] -= tsize
            if size_ahead[sign] <= 0:  # fill
                out.append({
                    "market_type": r.market_type, "tradeable": bool(r.tradeable),
                    "size": float(r.size) if r.size == r.size else 0.0, "bound": bound,
                    "ret_10s": self._ret(r, r.mid_10s), "ret_60s": self._ret(r, r.mid_60s),
                    "ret_300s": self._ret(r, r.mid_300s),
                })
                size_ahead[sign] = None  # re-place next adverse trade at the back
        return out

    @staticmethod
    def _queue(touch) -> float:
        # null/NaN touch size (legacy rows, or best price unknown to the ladder) ->
        # degrade to front (0) for that placement; honest, since we cannot claim a
        # conservative queue we never observed.
        return float(touch) if touch is not None and touch == touch else 0.0

    @staticmethod
    def _ret(r, mid_after):
        if mid_after != mid_after:  # NaN
            return float("nan")
        return float(r.maker_sign) * (float(r.maker_price) - float(mid_after))

    @staticmethod
    def _to_frame(fills):
        import pandas as pd
        cols = ["market_type", "tradeable", "size", "bound", "ret_10s", "ret_60s", "ret_300s"]
        return pd.DataFrame(fills, columns=cols)

    def _verdict(self, ctx, cohort, sub, hcol) -> Verdict:
        floor = getattr(ctx, "mm_min_n", 200)
        retcol = {"mid_10s": "ret_10s", "mid_60s": "ret_60s", "mid_300s": "ret_300s"}[hcol]
        vals = sub[retcol].dropna().to_numpy(float) if len(sub) else np.array([])
        n = int(vals.size)
        if n < floor:
            return Verdict(self.hypothesis_id, self.hclass, n, None, None, None,
                           "full", {"cohort": cohort}, "maker_fee_0", "inconclusive",
                           [_CAVEAT, f"n={n} below floor {floor}"], ctx.computed_at)
        edge = float(vals.mean())
        lo, hi = bootstrap_ci(vals, seed=ctx.seed)
        status = "pass" if (edge > 0 and lo > 0) else "fail"
        return Verdict(self.hypothesis_id, self.hclass, n, edge, edge,
                       float((hi - lo) / 2), "full", {"cohort": cohort}, "maker_fee_0",
                       status, [_CAVEAT], ctx.computed_at)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd scripts/edge-research && python -m pytest -q tests/test_mm_fine.py`
Expected: PASS.

- [ ] **Step 5: Run the full edge-research suite**

Run: `cd scripts/edge-research && python -m pytest -q`
Expected: PASS (no regressions in other validators / data / scoreboard tests).

- [ ] **Step 6: Commit**

```bash
git add scripts/edge-research/validators/mm_fine.py scripts/edge-research/tests/test_mm_fine.py
git commit -m "feat(edge-research): H-MM-3 queue-reactive walk with front/back bounds"
```

---

## Task 9: Deploy recorder + re-capture runbook (no code)

**Files:** none (operational). Requires `gh auth switch --user JaviMaligno` before pushing.

- [ ] **Step 1: Merge to main and let CI build the recorder image**

```bash
gh auth switch --user JaviMaligno
git checkout main && git merge --ff-only <feature-branch>
git push origin main
```
The `Deploy to GCP` workflow builds `ghcr.io/javimaligno/polymarket-trader/mm-recorder:latest`. Confirm green:
```bash
gh run list --workflow="Deploy to GCP" --limit 1
```

- [ ] **Step 2: Apply the schema ALTER on the VM (idempotent)**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command='docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c "ALTER TABLE mm_book_events ADD COLUMN IF NOT EXISTS best_bid_size DECIMAL(20,6); ALTER TABLE mm_book_events ADD COLUMN IF NOT EXISTS best_ask_size DECIMAL(20,6);"'
```
Expected: `ALTER TABLE` ×2 (or no-op if already present). No TRUNCATE — legacy rows keep NULL sizes; the back bound naturally starts from fresh post-deploy rows.

- [ ] **Step 3: Pull the new image and restart the capture service**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command='cd /home/Usuario/polymarket-trader && git pull && docker compose -f docker-compose.gcp.yml --profile capture pull mm-recorder && docker compose -f docker-compose.gcp.yml --profile capture up -d mm-recorder'
```

- [ ] **Step 4: Verify capture health (sizes populating, RAM within limit)**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command='docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -t -c "SELECT COUNT(*) total, COUNT(best_bid_size) with_bidsize, COUNT(DISTINCT token_id) toks, COUNT(DISTINCT market_id) mkts FROM mm_book_events WHERE time > NOW() - INTERVAL '"'"'15 min'"'"';"'
gcloud compute ssh polymarket-vm --zone=us-east1-b --command='docker stats --no-stream --format "{{.Name}} {{.MemUsage}}" polymarket-mm-recorder'
```
Expected: `with_bidsize > 0` (new rows carry sizes), `mkts` ≈ 30–45 (three types), recorder mem well under 120M. If mem is near the limit, lower `MM_UNIVERSE_N` and redeploy.

- [ ] **Step 5: Update memory with the deploy + re-capture-clock note**

Append to `project_next_levers_and_automation.md`: queue-reactive H-MM-3 deployed YYYY-MM-DD; back-bound n≥200 clock restarts now (~3–5 days); front bound covers history. Re-flag the verdict date.

---

## Self-Review

**Spec coverage:**
- §Componente 1 (recorder reconstruction + sizes) → Tasks 1–4. ✅
- §Componente 2 (universe 3 types) → Task 5. ✅
- §Componente 3 (export touch sizes) → Task 6. ✅
- §Componente 4 (validator walk front/back × size split) → Task 8. ✅ Cohorts `cohort×horizon×{all,large}×{front,back}` emitted; `tradeable = market_type != 'event_long'` preserved.
- §Componente 5 (tests) → Tasks 2,3,4,7,8. ✅
- §Componente 6 (deploy + re-capture) → Task 9. ✅
- **Spec refinement noted:** the spec's "cross-check reconstructed-vs-reported best, log gap on drift" is implemented as the simpler, equivalent-correctness rule **"price always from the feed's reported best; size best-effort from the ladder (NULL when unknown)"** (Task 3). This achieves the same goal (never persist a wrong best price; sizes honest) without the BookState↔wsClient gap-recording boundary churn. Drift only degrades a size to NULL, which the validator's back bound handles via `_queue()`.

**Placeholder scan:** No TBD/TODO; every code step shows full code; commands have expected output. `<feature-branch>` in Task 9 is an intentional runtime value (the worktree/branch name), not a code placeholder.

**Type consistency:** `BookInput`/`BookSnapshot`/`BookDelta`/`BookLevel` defined in Task 1, consumed in Tasks 2 (parser emits) and 3 (BookState applies). `BookEvent.bestBidSize`/`bestAskSize` defined in Task 1, set in Task 3, persisted in Task 4. Validator cohort string format `"{label}:{hname}:{size_label}:{bound}"` consistent between `run()` and the Task 8 tests. `mm_min_n` ctx attr used by `_verdict` and set by the test `_ctx`.
