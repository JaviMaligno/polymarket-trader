import { describe, it, expect, vi } from 'vitest';
import { QuoteEngine } from './engine.js';
import { loadConfig } from './config.js';
import { BookState } from '../bookState.js';

const t = (s: number) => new Date(Date.UTC(2026, 5, 12, 10, 0, s));

function setup(over: Record<string, string> = {}) {
  const cfg = loadConfig({ MM_QUOTER_MODE: 'shadow', ...over });
  const state = new BookState();
  const persistence = {
    ensureSchema: vi.fn().mockResolvedValue(undefined),
    insertFill: vi.fn().mockResolvedValue(undefined),
    upsertState: vi.fn().mockResolvedValue(undefined),
    insertEligibility: vi.fn().mockResolvedValue(undefined),
    insertPnl: vi.fn().mockResolvedValue(undefined),
  };
  const engine = new QuoteEngine({
    cfg, state, persistence: persistence as never,
    marketByToken: new Map([['T', 'M']]),
    endDateByMarket: new Map([['M', new Date('2026-12-31T00:00:00Z')]]),
    rewardsByMarket: new Map(),
  });
  const book = (s: number, bid: number, ask: number, bidSize = 100, askSize = 100) => {
    const input = {
      time: t(s), tokenId: 'T', marketId: 'M', eventType: 'book' as const,
      bids: [{ price: bid, size: bidSize }], asks: [{ price: ask, size: askSize }],
    };
    const row = state.apply(input);
    engine.onBook(input, row);
  };
  return { engine, persistence, book };
}

describe('QuoteEngine', () => {
  it('places virtual quotes at the touch after a book event', () => {
    const { engine, book } = setup();
    book(0, 0.48, 0.52);
    expect(engine.activeQuote('T', -1)?.price).toBe(0.48);
    expect(engine.activeQuote('T', 1)?.price).toBe(0.52);
    expect(engine.activeQuote('T', -1)?.queueInitial).toBe(100); // cola = touch al colocar
  });

  it('a trade draining the queue produces persisted fills and inventory', async () => {
    const { engine, persistence, book } = setup();
    book(0, 0.48, 0.52, 10, 100);
    await engine.onTrade({ time: t(1), tokenId: 'T', marketId: 'M', price: 0.48, size: 50, side: 'SELL' });
    expect(persistence.insertFill).toHaveBeenCalled();
    const fill = persistence.insertFill.mock.calls[0][0];
    expect(fill.price).toBe(0.48);
    expect(engine.inventory('trades').position('M')).toBeGreaterThan(0);
  });

  it('re-quotes on price-out only after the hysteresis interval', () => {
    const { engine, book } = setup({ MM_REQUOTE_MIN_MS: '5000' });
    book(0, 0.48, 0.52);
    book(2, 0.49, 0.52);              // price-out a 2s < 5s -> mantiene
    expect(engine.activeQuote('T', -1)?.price).toBe(0.48);
    book(6, 0.49, 0.52);              // 6s >= 5s -> re-place al nuevo touch
    expect(engine.activeQuote('T', -1)?.price).toBe(0.49);
  });

  it('does not re-quote when our price is still the touch', () => {
    const { engine, book } = setup();
    book(0, 0.48, 0.52);
    const q0 = engine.activeQuote('T', -1);
    book(2, 0.48, 0.52, 500, 100);    // solo cambió el size
    expect(engine.activeQuote('T', -1)).toBe(q0); // misma quote, cola intacta
  });

  it('TTL expiry re-places with fresh queue', () => {
    const { engine, book } = setup({ MM_ORDER_TTL_MS: '10000' });
    book(0, 0.48, 0.52, 30, 100);
    book(11, 0.48, 0.52, 80, 100);    // TTL 10s superado -> re-place
    expect(engine.activeQuote('T', -1)?.queueInitial).toBe(80);
  });

  it('gap invalidates virtual quotes', () => {
    const { engine, book } = setup();
    book(0, 0.48, 0.52);
    engine.onGap();
    expect(engine.activeQuote('T', -1)).toBeUndefined();
  });
});

// Fix 1 regression: both sides quoted — partial at-level bid trade produces exactly ONE fill
describe('Fix 1: single-pass onTrade (no double-routing)', () => {
  it('partial bid fill with both sides quoted emits exactly one trades-bound fill', async () => {
    const { engine, persistence, book } = setup();
    // Place both sides: bidSize=30, askSize=100
    book(0, 0.48, 0.52, 30, 100);
    // Partial at-level trade on bid: size=35, queue=30 → overflow=5 → one fill of size 5
    await engine.onTrade({ time: t(1), tokenId: 'T', marketId: 'M', price: 0.48, size: 35, side: 'SELL' });
    const tradesBoundCalls = persistence.insertFill.mock.calls.filter(
      (c: unknown[]) => (c[0] as { bound: string }).bound === 'trades',
    );
    // With the bug a second ledger.onTrade call re-drains the bid and emits extra fills.
    expect(tradesBoundCalls).toHaveLength(1);
    expect(tradesBoundCalls[0][0].size).toBe(5);
    // Inventory must reflect exactly 5 shares bought
    expect(engine.inventory('trades').position('M')).toBe(5);
  });
});

// Fix 2 regression: insertFill rejection is contained
describe('Fix 2: insertFill error containment', () => {
  it('engine survives an insertFill rejection, increments droppedFills, inventory still applied', async () => {
    const cfg = loadConfig({ MM_QUOTER_MODE: 'shadow' });
    const state = new BookState();
    const persistence = {
      ensureSchema: vi.fn().mockResolvedValue(undefined),
      insertFill: vi.fn()
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValue(undefined),
      upsertState: vi.fn().mockResolvedValue(undefined),
      insertEligibility: vi.fn().mockResolvedValue(undefined),
      insertPnl: vi.fn().mockResolvedValue(undefined),
    };
    const engine = new QuoteEngine({
      cfg, state, persistence: persistence as never,
      marketByToken: new Map([['T', 'M']]),
      endDateByMarket: new Map([['M', new Date('2026-12-31T00:00:00Z')]]),
      rewardsByMarket: new Map(),
    });
    const input = {
      time: t(0), tokenId: 'T', marketId: 'M', eventType: 'book' as const,
      bids: [{ price: 0.48, size: 0 }], asks: [{ price: 0.52, size: 100 }],
    };
    engine.onBook(input, state.apply(input));
    // Should not throw despite rejection
    await expect(
      engine.onTrade({ time: t(1), tokenId: 'T', marketId: 'M', price: 0.45, size: 1, side: 'SELL' }),
    ).resolves.not.toThrow();
    // Inventory still applied even when persist failed
    expect(engine.inventory('trades').position('M')).toBeGreaterThan(0);
    // droppedFills reflected in upsertState payload on flush
    await engine.flushHourly(t(3700));
    const stateCall = persistence.upsertState.mock.calls.find(
      (c: unknown[]) => (c[0] as string) === 'engine',
    );
    expect(stateCall).toBeDefined();
    expect((stateCall![1] as { droppedFills: number }).droppedFills).toBe(1);
  });
});

// Fix 3 regression: post-fill requote without a subsequent book event
describe('Fix 3: post-fill requote gap', () => {
  it('full-fill on bid re-places bid quote without a further book event', async () => {
    const { engine, book } = setup();
    // Place both sides; bidSize=20 (quote is filled completely on a sweep)
    book(0, 0.48, 0.52, 20, 100);
    expect(engine.activeQuote('T', -1)).toBeDefined();
    // Sweep trade: price below bid → level swept, full fill
    await engine.onTrade({ time: t(1), tokenId: 'T', marketId: 'M', price: 0.45, size: 1, side: 'SELL' });
    // Without a further book event the bid must be re-placed (Fix 3)
    const rebid = engine.activeQuote('T', -1);
    expect(rebid).toBeDefined();
    expect(rebid!.queueInitial).toBeGreaterThanOrEqual(0); // fresh queue from current levelSize
  });
});

// Fix 6 regression (bug 2026-06-16): flushHourly is invoked every 5 min (sub-hourly),
// so several flushes land in the SAME wall-clock hour. The engine must attribute each
// per-flush delta to the CURRENT hour (floor(now/1h)), and persistence accumulates on
// conflict (verified in persistence.test.ts). The OLD code wrote to prevHour and the SQL
// overwrote → each hour kept only the last ~5-min slice → ~12x undercount + 1-hour offset.
describe('Fix 6: sub-hourly flushes accumulate into the current hour', () => {
  // Fake persistence modelling the real ON CONFLICT (hour,market_id,bound) accumulation.
  function accumulatingPersistence() {
    const table = new Map<string, { hour: string; marketId: string; bound: string; spreadPnl: number; inventoryPnl: number; fills: number; replaces: number }>();
    const insertPnl = vi.fn(async (r: { hour: Date; marketId: string; bound: string; spreadPnl: number; inventoryPnl: number; fills: number; replaces: number }) => {
      const k = `${r.hour.toISOString()}|${r.marketId}|${r.bound}`;
      const cur = table.get(k);
      if (cur) {
        cur.spreadPnl += r.spreadPnl; cur.inventoryPnl += r.inventoryPnl;
        cur.fills += r.fills; cur.replaces += r.replaces;
      } else {
        table.set(k, { hour: r.hour.toISOString(), marketId: r.marketId, bound: r.bound,
          spreadPnl: r.spreadPnl, inventoryPnl: r.inventoryPnl, fills: r.fills, replaces: r.replaces });
      }
    });
    const persistence = {
      ensureSchema: vi.fn().mockResolvedValue(undefined),
      insertFill: vi.fn().mockResolvedValue(undefined),
      upsertState: vi.fn().mockResolvedValue(undefined),
      insertEligibility: vi.fn().mockResolvedValue(undefined),
      insertPnl,
    };
    return { table, persistence };
  }

  it('three 5-min flushes in one hour sum fills into that hour, not prevHour', async () => {
    const cfg = loadConfig({ MM_QUOTER_MODE: 'shadow' });
    const state = new BookState();
    const { table, persistence } = accumulatingPersistence();
    const engine = new QuoteEngine({
      cfg, state, persistence: persistence as never,
      marketByToken: new Map([['T', 'M']]),
      endDateByMarket: new Map([['M', new Date('2026-12-31T00:00:00Z')]]),
      rewardsByMarket: new Map(),
    });
    // Bid at touch, queue 0 → at-level trades fill immediately.
    const bk = { time: t(0), tokenId: 'T', marketId: 'M', eventType: 'book' as const,
      bids: [{ price: 0.48, size: 0 }], asks: [{ price: 0.52, size: 100 }] };
    engine.onBook(bk, state.apply(bk));

    const at = (m: number) => new Date(Date.UTC(2026, 5, 12, 10, m, 0)); // 10:mm within hour 10:00

    await engine.onTrade({ time: t(1), tokenId: 'T', marketId: 'M', price: 0.48, size: 5, side: 'SELL' });
    await engine.flushHourly(at(5));
    await engine.onTrade({ time: t(2), tokenId: 'T', marketId: 'M', price: 0.48, size: 5, side: 'SELL' });
    await engine.flushHourly(at(10));
    await engine.onTrade({ time: t(3), tokenId: 'T', marketId: 'M', price: 0.48, size: 5, side: 'SELL' });
    await engine.flushHourly(at(15));

    const hour10 = new Date(Date.UTC(2026, 5, 12, 10, 0, 0)).toISOString();
    const row = table.get(`${hour10}|M|trades`);
    expect(row).toBeDefined();
    expect(row!.fills).toBe(3); // 3 fills total this hour, NOT 1 (last slice only)
  });

  it('a market with two tokens (Yes/No) is not double-counted under accumulation', async () => {
    // marketByToken maps BOTH tokens of a market to the same market id, so .values()
    // repeats it. With the accumulating ON CONFLICT, iterating raw values would write the
    // (hour,market,bound) row twice and double the fills. Dedupe → exactly one fill counted.
    const cfg = loadConfig({ MM_QUOTER_MODE: 'shadow' });
    const state = new BookState();
    const { table, persistence } = accumulatingPersistence();
    const engine = new QuoteEngine({
      cfg, state, persistence: persistence as never,
      marketByToken: new Map([['Y', 'M'], ['N', 'M']]), // two tokens, one market
      endDateByMarket: new Map([['M', new Date('2026-12-31T00:00:00Z')]]),
      rewardsByMarket: new Map(),
    });
    const bk = { time: t(0), tokenId: 'Y', marketId: 'M', eventType: 'book' as const,
      bids: [{ price: 0.48, size: 0 }], asks: [{ price: 0.52, size: 100 }] };
    engine.onBook(bk, state.apply(bk));
    await engine.onTrade({ time: t(1), tokenId: 'Y', marketId: 'M', price: 0.48, size: 5, side: 'SELL' });
    await engine.flushHourly(new Date(Date.UTC(2026, 5, 12, 10, 30, 0)));

    const hour10 = new Date(Date.UTC(2026, 5, 12, 10, 0, 0)).toISOString();
    const row = table.get(`${hour10}|M|trades`);
    expect(row).toBeDefined();
    expect(row!.fills).toBe(1); // one fill, not two (no double-count from duplicate values)
  });

  it('replaces are attributed per-market, not as a global counter shared across markets', async () => {
    // Two markets. Market A re-quotes several times (churn); market B only fills, never
    // re-quotes. B's row must show replaces=0 — with the old global counter it inherited
    // A's churn (and under accumulation that mis-attribution compounds).
    const cfg = loadConfig({ MM_QUOTER_MODE: 'shadow', MM_REQUOTE_MIN_MS: '0' });
    const state = new BookState();
    const insertPnl = vi.fn().mockResolvedValue(undefined);
    const persistence = {
      ensureSchema: vi.fn().mockResolvedValue(undefined),
      insertFill: vi.fn().mockResolvedValue(undefined),
      upsertState: vi.fn().mockResolvedValue(undefined),
      insertEligibility: vi.fn().mockResolvedValue(undefined),
      insertPnl,
    };
    const engine = new QuoteEngine({
      cfg, state, persistence: persistence as never,
      marketByToken: new Map([['A', 'MA'], ['B', 'MB']]),
      endDateByMarket: new Map([['MA', new Date('2026-12-31T00:00:00Z')], ['MB', new Date('2026-12-31T00:00:00Z')]]),
      rewardsByMarket: new Map(),
    });
    const bookFor = (tok: string, mkt: string, s: number, bid: number, ask: number) => {
      const input = { time: t(s), tokenId: tok, marketId: mkt, eventType: 'book' as const,
        bids: [{ price: bid, size: 0 }], asks: [{ price: ask, size: 100 }] };
      engine.onBook(input, state.apply(input));
    };
    // Market A: place, then 3 price-outs → 3 replaces.
    bookFor('A', 'MA', 0, 0.40, 0.60);
    bookFor('A', 'MA', 1, 0.41, 0.60);
    bookFor('A', 'MA', 2, 0.42, 0.60);
    bookFor('A', 'MA', 3, 0.43, 0.60);
    // Market B: place once (no replace), then a fill so its row is emitted.
    bookFor('B', 'MB', 4, 0.48, 0.52);
    await engine.onTrade({ time: t(5), tokenId: 'B', marketId: 'MB', price: 0.48, size: 5, side: 'SELL' });

    await engine.flushHourly(new Date(Date.UTC(2026, 5, 12, 11, 0, 0)));

    const rowB = insertPnl.mock.calls
      .map((c: unknown[]) => c[0] as { marketId: string; bound: string; replaces: number })
      .find((r) => r.marketId === 'MB' && r.bound === 'trades');
    expect(rowB).toBeDefined();
    expect(rowB!.replaces).toBe(0); // B never re-quoted; must not inherit A's churn
  });
});

// Fix 4 regression: flushHourly PnL uses deltas not cumulative
describe('Fix 4: flushHourly PnL deltas', () => {
  it('two fills then flush → pnl row has fills=2 and spreadPnl=delta; second flush with no activity → zeros', async () => {
    const cfg = loadConfig({ MM_QUOTER_MODE: 'shadow' });
    const state = new BookState();
    const insertPnl = vi.fn().mockResolvedValue(undefined);
    const persistence = {
      ensureSchema: vi.fn().mockResolvedValue(undefined),
      insertFill: vi.fn().mockResolvedValue(undefined),
      upsertState: vi.fn().mockResolvedValue(undefined),
      insertEligibility: vi.fn().mockResolvedValue(undefined),
      insertPnl,
    };
    const engine = new QuoteEngine({
      cfg, state, persistence: persistence as never,
      marketByToken: new Map([['T', 'M']]),
      endDateByMarket: new Map([['M', new Date('2026-12-31T00:00:00Z')]]),
      rewardsByMarket: new Map(),
    });
    // Place bid at 0.48, queue=0 (immediately front of queue)
    const bookInput = {
      time: t(0), tokenId: 'T', marketId: 'M', eventType: 'book' as const,
      bids: [{ price: 0.48, size: 0 }], asks: [{ price: 0.52, size: 100 }],
    };
    engine.onBook(bookInput, state.apply(bookInput));

    // Two partial fills at level: size=5 each (queue already 0 so both fill)
    await engine.onTrade({ time: t(1), tokenId: 'T', marketId: 'M', price: 0.48, size: 5, side: 'SELL' });
    await engine.onTrade({ time: t(2), tokenId: 'T', marketId: 'M', price: 0.48, size: 5, side: 'SELL' });

    // First flush
    const hour1 = new Date(Date.UTC(2026, 5, 12, 11, 0, 0));
    await engine.flushHourly(hour1);

    // Find the trades-bound pnl row for market M
    const call1 = insertPnl.mock.calls.find(
      (c: unknown[]) => (c[0] as { marketId: string; bound: string }).marketId === 'M' &&
                        (c[0] as { bound: string }).bound === 'trades',
    );
    expect(call1).toBeDefined();
    const row1 = call1![0] as { fills: number; spreadPnl: number };
    expect(row1.fills).toBe(2);
    // spreadPnl = delta of realized since last flush (was 0 before) — may be 0 for buys with no closes
    // but must equal the realized delta at this point, not some accumulated value
    // The key assertion: a second flush with no new fills should yield spreadPnl=0 and fills=0
    insertPnl.mockClear();
    const hour2 = new Date(Date.UTC(2026, 5, 12, 12, 0, 0));
    await engine.flushHourly(hour2);
    const call2 = insertPnl.mock.calls.find(
      (c: unknown[]) => (c[0] as { marketId: string; bound: string }).marketId === 'M' &&
                        (c[0] as { bound: string }).bound === 'trades',
    );
    if (call2) {
      const row2 = call2[0] as { fills: number; spreadPnl: number };
      expect(row2.spreadPnl).toBe(0); // delta since last flush is 0
      expect(row2.fills).toBe(0);
    }
    // If no row was emitted (position/realized unchanged) that's also correct — no double-count
  });
});

// Fix 5 regression: inventory_pnl must be a per-flush DELTA (telescoping), not an
// instantaneous M2M snapshot. Accounting identity: equity = realized + unrealized, so
// SUM(spreadPnl) + SUM(inventoryPnl) over all flushes must equal the equity change
// (from 0). With a snapshot the open M2M is double-counted across flushes and the sum
// inflates — exactly the SUM(inventory_pnl) trap that bit the daily-review query.
describe('Fix 5: inventory_pnl telescoping invariant', () => {
  it('sum of spread+inventory deltas across flushes equals final equity', async () => {
    const { engine, persistence, book } = setup({ MM_REQUOTE_MIN_MS: '0' });

    // Buy 10@0.48 (bid at touch, queue 0 → at-level trade fills), mid 0.50.
    book(0, 0.48, 0.52, 0, 0);
    await engine.onTrade({ time: t(1), tokenId: 'T', marketId: 'M', price: 0.48, size: 10, side: 'SELL' });
    await engine.flushHourly(new Date(Date.UTC(2026, 5, 12, 11, 0, 0)));

    // Mid drifts up to 0.51 (open inventory M2M moves) — flush with no new fills.
    book(2, 0.49, 0.53, 0, 0);
    await engine.flushHourly(new Date(Date.UTC(2026, 5, 12, 12, 0, 0)));

    // Sell 10@0.53 (ask at touch) → position flat, realized +0.50.
    await engine.onTrade({ time: t(3), tokenId: 'T', marketId: 'M', price: 0.53, size: 10, side: 'BUY' });
    await engine.flushHourly(new Date(Date.UTC(2026, 5, 12, 13, 0, 0)));

    const rows = (persistence.insertPnl as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c[0] as { marketId: string; bound: string; spreadPnl: number; inventoryPnl: number })
      .filter((r) => r.marketId === 'M' && r.bound === 'trades');
    const sum = rows.reduce((a, r) => a + r.spreadPnl + r.inventoryPnl, 0);

    // Telescoping identity — holds only when inventoryPnl is a delta, not a snapshot.
    expect(sum).toBeCloseTo(engine.equity('trades'), 6);
    // And the realized leg alone is the round-trip profit (10 × (0.53−0.48)).
    expect(engine.equity('trades')).toBeCloseTo(0.5, 6);
  });
});
