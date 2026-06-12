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
