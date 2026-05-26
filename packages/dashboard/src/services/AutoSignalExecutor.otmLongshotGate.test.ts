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
      executed: true, executedPrice: 0.50, executedSize: 10,
      slippagePct: 0.1, fee: 0.005, fillSource: 'estimated',
      snapshotAgeMs: null, availableDepth: 0,
      bestBid: null, bestAsk: null,
    });
    simulateSell = vi.fn().mockResolvedValue({
      executed: true, executedPrice: 0.50, executedSize: 10,
      slippagePct: 0.1, fee: 0.005, fillSource: 'estimated',
      snapshotAgeMs: null, availableDepth: 0,
      bestBid: null, bestAsk: null,
    });
  },
}));

import { query } from '../database/index.js';
import { paperPositionsRepo } from '../database/repositories.js';
import { AutoSignalExecutor, type SignalResult } from './AutoSignalExecutor.js';

const makeSignal = (overrides?: Partial<SignalResult>): SignalResult => ({
  signalId: 'mean_reversion',
  marketId: 'market-crypto-daily-1',
  tokenId: 'token-yes',
  direction: 'long',
  strength: 0.8,
  confidence: 0.7,
  price: 0.20,
  marketType: 'crypto_daily',
  ...overrides,
});

function mockMarketActive() {
  (query as any).mockResolvedValue({
    rows: [{
      is_active: true, is_resolved: false,
      end_date: new Date(Date.now() + 30 * 24 * 3600_000).toISOString(),
    }],
  });
}

describe('OTMLongshotGate (gate 0g)', () => {
  let executor: AutoSignalExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new AutoSignalExecutor({ enabled: true, cooldownMs: 0 });
    (paperPositionsRepo.getAll as any).mockResolvedValue([]);
    mockMarketActive();
  });

  it('blocks crypto_daily LONG at price 0.20 (below default 0.30 threshold)', async () => {
    const result = await executor.processSignal(
      makeSignal({ marketType: 'crypto_daily', direction: 'long', price: 0.20 })
    );
    expect(result.executed).toBe(false);
    expect(result.reason).toMatch(/otm_longshot_blocked/);
    expect(result.reason).toContain('crypto_daily');
  });

  it('blocks crypto_daily LONG at boundary-low price 0.299', async () => {
    const result = await executor.processSignal(
      makeSignal({ marketType: 'crypto_daily', direction: 'long', price: 0.299 })
    );
    expect(result.executed).toBe(false);
    expect(result.reason).toMatch(/otm_longshot_blocked/);
  });

  it('does NOT block crypto_daily LONG at threshold 0.30 (strict less-than)', async () => {
    const result = await executor.processSignal(
      makeSignal({ marketType: 'crypto_daily', direction: 'long', price: 0.30 })
    );
    expect(result.reason || '').not.toMatch(/otm_longshot_blocked/);
  });

  it('does NOT block crypto_daily LONG at high price 0.85', async () => {
    const result = await executor.processSignal(
      makeSignal({ marketType: 'crypto_daily', direction: 'long', price: 0.85 })
    );
    expect(result.reason || '').not.toMatch(/otm_longshot_blocked/);
  });

  it('does NOT block crypto_daily SHORT at low price (gate is LONG-only)', async () => {
    const result = await executor.processSignal(
      makeSignal({ marketType: 'crypto_daily', direction: 'short', price: 0.15 })
    );
    expect(result.reason || '').not.toMatch(/otm_longshot_blocked/);
  });

  it('does NOT block event_long LONG at low price (gate scoped to crypto types)', async () => {
    const result = await executor.processSignal(
      makeSignal({ marketType: 'event_long', direction: 'long', price: 0.05 })
    );
    expect(result.reason || '').not.toMatch(/otm_longshot_blocked/);
  });

  it('does NOT block event_financial LONG at low price (gate scoped to crypto types)', async () => {
    const result = await executor.processSignal(
      makeSignal({ marketType: 'event_financial', direction: 'long', price: 0.08 })
    );
    expect(result.reason || '').not.toMatch(/otm_longshot_blocked/);
  });

  it('does NOT block when an open position exists (allows close/unwind path)', async () => {
    (paperPositionsRepo.getAll as any).mockResolvedValue([
      { market_id: 'market-crypto-daily-1', side: 'long', size: 10, closed_at: null },
    ]);
    const result = await executor.processSignal(
      makeSignal({ marketType: 'crypto_daily', direction: 'long', price: 0.20 })
    );
    expect(result.reason || '').not.toMatch(/otm_longshot_blocked/);
  });

  it('records a shadow trade tagged otm_longshot_blocked when gate blocks', async () => {
    await executor.processSignal(
      makeSignal({ marketType: 'crypto_daily', direction: 'long', price: 0.20 })
    );
    const shadowCalls = (query as any).mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO shadow_trades')
    );
    expect(shadowCalls.length).toBe(1);
    // signal_type is the last positional param
    const params = shadowCalls[0][1] as any[];
    expect(params[params.length - 1]).toBe('otm_longshot_blocked');
  });

  it.skip('respects EXECUTOR_OTM_LONGSHOT_PRICE_LO env override (constants read at module-import time)', async () => {
    // Same module-import-time caveat as EventOTMGate tests. Rollback is verified
    // at deploy time via docker-compose env overrides.
  });

  it.skip('respects EXECUTOR_OTM_LONGSHOT_TYPES env override (constants read at module-import time)', async () => {
    // Same module-import-time caveat. Verified at deploy time.
  });
});
