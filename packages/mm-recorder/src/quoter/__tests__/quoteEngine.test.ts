import { describe, it, expect, vi } from 'vitest';
import { QuoteEngine } from '../engine.js';
import { loadConfig } from '../config.js';
import { BookState } from '../../bookState.js';

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
