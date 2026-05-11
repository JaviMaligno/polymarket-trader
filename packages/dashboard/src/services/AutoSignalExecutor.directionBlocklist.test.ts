/**
 * Tests for AutoSignalExecutor Gate 0f — per-(market_type, direction) blocklist.
 *
 * Generator-predictions per-type t-stat analysis (2026-05-11) revealed
 * asymmetric edge inside the same market_type:
 *
 *   mean_reversion x event_financial x LONG  → t = +8.61 (strong edge)
 *   mean_reversion x event_financial x SHORT → t = -9.97 (strong anti-edge)
 *
 * The signal_weights schema is keyed on (signal_type, market_type) — no
 * direction — so per-type weights amplify BOTH directions equally. The only
 * way to act on direction-specific edge today is to filter at the executor
 * level via this blocklist.
 *
 * The env var is parsed at module-load, so each test uses isolateModules to
 * re-import AutoSignalExecutor with the desired env state.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../database/index.js', () => ({
  query: vi.fn(),
  isDatabaseConfigured: vi.fn(() => true),
}));

vi.mock('../database/repositories.js', () => ({
  paperTradesRepo: { create: vi.fn() },
  paperPositionsRepo: {
    getAll: vi.fn().mockResolvedValue([]),
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

interface MakeSignalOverrides {
  direction?: 'long' | 'short';
  marketType?: string;
  marketId?: string;
}

function makeSignal(overrides: MakeSignalOverrides = {}) {
  return {
    signalId: 'mean_reversion',
    marketId: overrides.marketId ?? 'mkt1',
    tokenId: 'tok1',
    direction: overrides.direction ?? 'long',
    strength: 0.7,
    confidence: 0.7,
    price: 0.5,
    marketType: overrides.marketType ?? 'event_financial',
  };
}

// Common mock chain: market is active, capital is healthy, no positions
function setupMockChain() {
  (paperPositionsRepo.getAll as any).mockResolvedValue([]);
  (query as any).mockImplementation((sql: string) => {
    if (sql.includes('FROM markets WHERE id')) {
      return Promise.resolve({
        rows: [{ is_active: true, is_resolved: false, end_date: null, market_type: 'event_financial' }],
      });
    }
    if (sql.includes('FROM paper_account')) {
      return Promise.resolve({
        rows: [{ available_capital: '9500', current_capital: '10000', peak_equity: '10000' }],
      });
    }
    if (sql.includes('FROM paper_positions WHERE closed_at IS NULL')) {
      return Promise.resolve({ rows: [{ total_exposure: '0' }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

describe('AutoSignalExecutor Gate 0f — direction blocklist', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.EXECUTOR_BLOCKED_TYPE_DIRECTIONS;
  });

  it('allows all directions when the env var is empty (default)', async () => {
    const { AutoSignalExecutor } = await import('./AutoSignalExecutor.js');
    setupMockChain();
    const exec = new AutoSignalExecutor({ enabled: true, cooldownMs: 0 });

    const result = await exec.processSignal(makeSignal({ direction: 'short' }) as any);
    expect(result.reason ?? '').not.toMatch(/direction_blocked_for_type/);
  });

  it('blocks short on event_financial when configured, allows long', async () => {
    process.env.EXECUTOR_BLOCKED_TYPE_DIRECTIONS = 'event_financial:short';
    const { AutoSignalExecutor } = await import('./AutoSignalExecutor.js');
    setupMockChain();
    const exec = new AutoSignalExecutor({ enabled: true, cooldownMs: 0 });

    const shortResult = await exec.processSignal(makeSignal({ direction: 'short' }) as any);
    expect(shortResult.executed).toBe(false);
    expect(shortResult.reason).toMatch(/direction_blocked_for_type: event_financial:short/);

    const longResult = await exec.processSignal(makeSignal({ direction: 'long' }) as any);
    expect(longResult.reason ?? '').not.toMatch(/direction_blocked_for_type/);
  });

  it('allows direction-blocked signals to close existing positions (unwind path)', async () => {
    process.env.EXECUTOR_BLOCKED_TYPE_DIRECTIONS = 'event_financial:short';
    const { AutoSignalExecutor } = await import('./AutoSignalExecutor.js');
    setupMockChain();
    // Existing LONG position in the same market
    (paperPositionsRepo.getAll as any).mockResolvedValue([
      { market_id: 'mkt1', token_id: 'tok_yes', side: 'long', size: 10, current_price: 0.5, avg_entry_price: 0.45 },
    ]);

    const exec = new AutoSignalExecutor({ enabled: true, cooldownMs: 0 });
    const result = await exec.processSignal(makeSignal({ direction: 'short' }) as any);

    // Signal does not get rejected by the direction blocklist (close is allowed)
    expect(result.reason ?? '').not.toMatch(/direction_blocked_for_type/);
  });

  it('supports multiple (type:direction) pairs', async () => {
    process.env.EXECUTOR_BLOCKED_TYPE_DIRECTIONS = 'event_financial:short,event_long:long';
    const { AutoSignalExecutor } = await import('./AutoSignalExecutor.js');
    setupMockChain();
    const exec = new AutoSignalExecutor({ enabled: true, cooldownMs: 0 });

    const r1 = await exec.processSignal(makeSignal({ direction: 'short', marketType: 'event_financial' }) as any);
    expect(r1.reason).toMatch(/event_financial:short/);

    // event_long would be blocked by ALLOWED_MARKET_TYPES upstream of 0f in the
    // current default config, so we configure ALLOWED_MARKET_TYPES to include
    // it via a separate import that does NOT set that env. For this test we
    // rely on the absence of ALLOWED_MARKET_TYPES (set to null), so the
    // direction blocklist is the only gate that fires.
    delete process.env.ALLOWED_MARKET_TYPES;
    vi.resetModules();
    const { AutoSignalExecutor: ExecWithoutTypeGate } = await import('./AutoSignalExecutor.js');
    const exec2 = new ExecWithoutTypeGate({ enabled: true, cooldownMs: 0 });
    const r2 = await exec2.processSignal(makeSignal({ direction: 'long', marketType: 'event_long' }) as any);
    expect(r2.reason).toMatch(/event_long:long/);
  });

  it('rejects malformed entries silently (only valid type:direction pairs are honoured)', async () => {
    process.env.EXECUTOR_BLOCKED_TYPE_DIRECTIONS = 'event_financial:short,invalid_entry,event_long:wrongside';
    const { AutoSignalExecutor } = await import('./AutoSignalExecutor.js');
    setupMockChain();
    const exec = new AutoSignalExecutor({ enabled: true, cooldownMs: 0 });

    // valid entry blocks
    const r1 = await exec.processSignal(makeSignal({ direction: 'short', marketType: 'event_financial' }) as any);
    expect(r1.reason).toMatch(/event_financial:short/);

    // invalid entries don't accidentally block legitimate signals
    const r2 = await exec.processSignal(makeSignal({ direction: 'long', marketType: 'event_long' }) as any);
    expect(r2.reason ?? '').not.toMatch(/direction_blocked_for_type/);
  });
});
