import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../database/index.js', () => ({
  query: vi.fn(),
  isDatabaseConfigured: vi.fn(() => true),
}));

vi.mock('../database/repositories.js', () => ({
  paperTradesRepo: { create: vi.fn() },
  paperPositionsRepo: {
    getAll: vi.fn(),
    insert: vi.fn(),
    upsert: vi.fn(),
    openPositionAtomically: vi.fn().mockResolvedValue({ opened: true }),
  },
  signalPredictionsRepo: { create: vi.fn() },
  signalWeightsRepo: { get: vi.fn() },
}));

vi.mock('./PositionClosingService.js', () => {
  const { EventEmitter } = require('events');
  const mockService = new EventEmitter();
  mockService.close = vi.fn().mockResolvedValue({ executed: true, pnl: 0 });
  return { getPositionClosingService: vi.fn(() => mockService) };
});

vi.mock('./CircuitBreakerService.js', () => ({
  getCircuitBreakerService: vi.fn(() => ({ isTradingHalted: vi.fn(() => false) })),
}));

vi.mock('./ExecutionRouter.js', () => ({ getExecutionRouter: vi.fn(() => null) }));

vi.mock('./OrderBookExecutionSimulator.js', () => ({
  OrderBookExecutionSimulator: class {
    simulateBuy = vi.fn().mockResolvedValue({
      executed: true, executedPrice: 0.12, executedSize: 10,
      slippagePct: 0.1, fee: 0.005, fillSource: 'estimated',
      snapshotAgeMs: null, availableDepth: 0,
      bestBid: null, bestAsk: null,
    });
    simulateSell = vi.fn().mockResolvedValue({
      executed: true, executedPrice: 0.12, executedSize: 10,
      slippagePct: 0.1, fee: 0.005, fillSource: 'estimated',
      snapshotAgeMs: null, availableDepth: 0,
      bestBid: null, bestAsk: null,
    });
  },
}));

import { query } from '../database/index.js';
import { paperPositionsRepo } from '../database/repositories.js';
import { AutoSignalExecutor, type SignalResult } from './AutoSignalExecutor.js';

// Helper: build a SignalResult with overrides
const makeSignal = (overrides?: Partial<SignalResult>): SignalResult => ({
  signalId: 'mean_reversion',
  marketId: 'market-wti-1712302',
  tokenId: 'token-yes',
  direction: 'long',
  strength: 0.8,
  confidence: 0.7,
  price: 0.12,
  marketType: 'event_financial',
  ...overrides,
});

// Helper: set the market query mock with a given TTR in hours from now
function mockMarketWithTTR(hoursFromNow: number | null, overrides?: {
  is_active?: boolean; is_resolved?: boolean;
}) {
  const end_date =
    hoursFromNow === null
      ? null
      : new Date(Date.now() + hoursFromNow * 3600_000).toISOString();
  const row = { is_active: true, is_resolved: false, end_date, ...overrides };
  (query as any).mockResolvedValue({ rows: [row] });
}

describe('EventOTMGate (gate 0e)', () => {
  let executor: AutoSignalExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset env to defaults each test; individual tests override as needed
    delete process.env.EXECUTOR_EVENT_OTM_TTR_HOURS;
    delete process.env.EXECUTOR_EVENT_OTM_PRICE_LO;
    delete process.env.EXECUTOR_EVENT_OTM_PRICE_HI;
    delete process.env.EXECUTOR_EVENT_OTM_MARKET_TYPES;
    executor = new AutoSignalExecutor({ enabled: true, cooldownMs: 0 });
    (paperPositionsRepo.getAll as any).mockResolvedValue([]);
  });

  it('blocks WTI-like classic trap: event_financial, TTR 9d, price 0.12', async () => {
    mockMarketWithTTR(216); // 9 days
    const result = await executor.processSignal(makeSignal({ price: 0.12 }));
    expect(result.executed).toBe(false);
    expect(result.reason).toMatch(/event_otm_near_expiry/);
  });

  it('records a shadow trade tagged event_otm_gated when gate blocks an open', async () => {
    mockMarketWithTTR(216);
    // Depends on insertShadowTrade's shares>=1 gate: default weight 0.5 + price 0.12 keeps
    // shares well above the floor. Changing signal defaults or maxPositionSize could void this.
    await executor.processSignal(makeSignal({ price: 0.12 }));
    // Locate the shadow_trades INSERT call among all query calls
    const shadowCalls = (query as any).mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO shadow_trades')
    );
    expect(shadowCalls.length).toBe(1);
    // signal_type is the last positional param (index 7 in the values array)
    const params = shadowCalls[0][1] as any[];
    expect(params[params.length - 1]).toBe('event_otm_gated');
  });

  it('passes event_financial with mid-price near expiry (0.50, 9d)', async () => {
    mockMarketWithTTR(216);
    const result = await executor.processSignal(makeSignal({ price: 0.50 }));
    // Gate must not fire; result may still pass or fail other gates — assert negative only
    expect(result.reason || '').not.toMatch(/event_otm_near_expiry/);
  });

  it('passes event_financial with extreme price and long horizon (0.12, 30d)', async () => {
    mockMarketWithTTR(720);
    const result = await executor.processSignal(makeSignal({ price: 0.12 }));
    expect(result.reason || '').not.toMatch(/event_otm_near_expiry/);
  });

  it('passes crypto markets even with extreme price near expiry (marketType mismatch)', async () => {
    mockMarketWithTTR(216);
    const result = await executor.processSignal(
      makeSignal({ marketType: 'crypto_intraday', price: 0.12 })
    );
    expect(result.reason || '').not.toMatch(/event_otm_near_expiry/);
  });

  it('passes event_financial with null end_date (cannot compute TTR)', async () => {
    mockMarketWithTTR(null);
    const result = await executor.processSignal(makeSignal({ price: 0.12 }));
    expect(result.reason || '').not.toMatch(/event_otm_near_expiry/);
  });

  it('allows closing an existing position on a matching market', async () => {
    mockMarketWithTTR(216);
    (paperPositionsRepo.getAll as any).mockResolvedValue([
      { market_id: 'market-wti-1712302', size: 10 },
    ]);
    const result = await executor.processSignal(
      makeSignal({ price: 0.12, direction: 'short' }) // short = close of long
    );
    expect(result.reason || '').not.toMatch(/event_otm_near_expiry/);
  });

  it('passes at exact TTR boundary (strict less-than)', async () => {
    // Freeze Date.now() so the TTR seen by the executor matches the TTR set by the mock.
    // Without this, the elapsed time between mockMarketWithTTR(240) and the executor's
    // Date.now() reading drops the computed TTR below 240h, triggering the gate unexpectedly.
    const frozenNow = Date.now();
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(frozenNow);
    try {
      mockMarketWithTTR(240); // exactly the default threshold
      const result = await executor.processSignal(makeSignal({ price: 0.12 }));
      expect(result.reason || '').not.toMatch(/event_otm_near_expiry/);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it('passes at exact PRICE_LO boundary (strict less-than)', async () => {
    mockMarketWithTTR(216);
    const result = await executor.processSignal(makeSignal({ price: 0.20 }));
    expect(result.reason || '').not.toMatch(/event_otm_near_expiry/);
  });

  it('passes at exact PRICE_HI boundary (strict greater-than)', async () => {
    mockMarketWithTTR(216);
    const result = await executor.processSignal(makeSignal({ price: 0.80 }));
    expect(result.reason || '').not.toMatch(/event_otm_near_expiry/);
  });

  it('blocks upper-extreme price near expiry (0.88, 9d)', async () => {
    mockMarketWithTTR(216);
    const result = await executor.processSignal(makeSignal({ price: 0.88 }));
    expect(result.executed).toBe(false);
    expect(result.reason).toMatch(/event_otm_near_expiry/);
  });

  it.skip('is disabled when EXECUTOR_EVENT_OTM_TTR_HOURS=0 (env override not testable at runtime)', async () => {
    // Gate constants are read at module import time, so mid-test env changes have
    // no effect. Rollback is verified at deploy time via docker-compose env overrides.
    // See docs/plans/2026-04-21-event-otm-gate-plan.md Task 1 for the limitation note.
  });

  it.skip('blocks custom market types when EXECUTOR_EVENT_OTM_MARKET_TYPES includes them', async () => {
    // Same module-import-time caveat as the previous test.
  });
});
