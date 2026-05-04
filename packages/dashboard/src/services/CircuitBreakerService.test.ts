/**
 * CircuitBreakerService Tests
 *
 * Verifies:
 * 1. start() creates the trading_config table
 * 2. isTradingHalted() returns false initially
 * 3. After drawdown triggers halt, isTradingHalted() returns true (even if DB writes fail)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../database/index.js', () => ({
  query: vi.fn(),
  isDatabaseConfigured: vi.fn(() => true),
}));
vi.mock('./TradingAutomation.js', () => ({
  getTradingAutomation: vi.fn(() => ({ on: vi.fn(), off: vi.fn() })),
}));
vi.mock('./StopLossService.js', () => ({
  getStopLossService: vi.fn(() => ({ on: vi.fn(), off: vi.fn() })),
}));
vi.mock('./PositionClosingService.js', () => ({
  getPositionClosingService: vi.fn(() => ({
    close: vi.fn().mockResolvedValue({ executed: true, netPnl: -5, fee: 0.01 }),
    on: vi.fn(),
    off: vi.fn(),
  })),
}));

import { query, isDatabaseConfigured } from '../database/index.js';
import { CircuitBreakerService } from './CircuitBreakerService.js';

describe('CircuitBreakerService', () => {
  let service: CircuitBreakerService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Default: query resolves successfully with empty rows
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 } as any);
    service = new CircuitBreakerService({
      checkIntervalMs: 60_000,
      maxDrawdownPct: 30,
      initialCapital: 10000,
    });
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
  });

  it('start() should call CREATE TABLE IF NOT EXISTS trading_config', async () => {
    await service.start();

    const createTableCall = vi.mocked(query).mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('CREATE TABLE IF NOT EXISTS trading_config')
    );
    expect(createTableCall).toBeDefined();
  });

  it('isTradingHalted() returns false initially', () => {
    expect(service.isTradingHalted()).toBe(false);
  });

  it('DEFAULT_CONFIG should read MAX_DRAWDOWN env var', async () => {
    // DEFAULT_CONFIG is evaluated at module load time, so we need to re-import the module
    // with the env var set to test this correctly.
    process.env.MAX_DRAWDOWN = '0.15';
    vi.resetModules();

    // Re-register mocks before re-importing
    vi.doMock('../database/index.js', () => ({
      query: vi.fn(),
      isDatabaseConfigured: vi.fn(() => true),
    }));
    vi.doMock('./TradingAutomation.js', () => ({
      getTradingAutomation: vi.fn(() => ({ on: vi.fn(), off: vi.fn() })),
    }));
    vi.doMock('./StopLossService.js', () => ({
      getStopLossService: vi.fn(() => ({ on: vi.fn(), off: vi.fn() })),
    }));
    vi.doMock('./PositionClosingService.js', () => ({
      getPositionClosingService: vi.fn(() => ({
        close: vi.fn().mockResolvedValue({ executed: true, netPnl: -5, fee: 0.01 }),
        on: vi.fn(),
        off: vi.fn(),
      })),
    }));

    const { CircuitBreakerService: FreshService } = await import('./CircuitBreakerService.js');
    const freshService = new FreshService();
    expect((freshService as any).config.maxDrawdownPct).toBe(15);

    delete process.env.MAX_DRAWDOWN;
  });

  it('drawdown check should use equity (capital + positions), not capital alone', async () => {
    // Account has $5000 capital but $5000 in open positions = $10000 equity
    // With initialCapital=$10000, drawdown should be 0%, not 50%
    // Mock sequence:
    // Slot 1: CREATE TABLE (consumed by start())
    // Slot 2: SELECT paper_account (consumed by start()'s initial checkDrawdown() — empty rows, exits early)
    // Slot 3: SELECT paper_account (consumed by timer-triggered checkDrawdown() — returns capital=5000)
    // Slot 4: SELECT exposure (consumed by same timer-triggered checkDrawdown() — returns 5000)
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any) // CREATE TABLE
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any) // SELECT paper_account (start()'s initial check — exits early)
      .mockResolvedValueOnce({  // SELECT paper_account (timer-triggered check)
        rows: [{ current_capital: '5000', initial_capital: '10000', peak_equity: '10000' }],
        rowCount: 1,
      } as any)
      .mockResolvedValueOnce({  // SELECT total exposure from positions (timer-triggered check)
        rows: [{ total_exposure: '5000' }],
        rowCount: 1,
      } as any);

    const service = new CircuitBreakerService({
      checkIntervalMs: 60_000,
      maxDrawdownPct: 30,
      initialCapital: 10000,
    });
    await service.start();
    await vi.advanceTimersByTimeAsync(60_000);

    // Should NOT have triggered halt (equity = $10000, drawdown = 0%)
    expect(service.isTradingHalted()).toBe(false);
  });

  it('drawdown is computed from peak_equity, not initial_capital (avoids deadlock when peak < initial)', async () => {
    // Account state matching the 2026-04-30 deadlock that produced the trade
    // drought before commit 44f16d1: equity below initial but well above peak.
    //   current_capital=8695, peak_equity=8898, total_exposure=0
    // Pre-fix denominator (initial): (10000-8695)/10000 = 13.05% → would HALT at 13% threshold
    // Post-fix denominator (peak):   (8898-8695)/8898 = 2.28%  → safely below threshold
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any) // CREATE TABLE
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any) // start()'s initial check (empty rows, exits early)
      .mockResolvedValueOnce({  // timer-triggered check — note peak_equity < initial
        rows: [{ current_capital: '8695', initial_capital: '10000', peak_equity: '8897.79' }],
        rowCount: 1,
      } as any)
      .mockResolvedValueOnce({  // exposure
        rows: [{ total_exposure: '0' }],
        rowCount: 1,
      } as any);

    const service = new CircuitBreakerService({
      checkIntervalMs: 60_000,
      maxDrawdownPct: 13,  // tight enough that pre-fix would trip
      initialCapital: 10000,
    });
    await service.start();
    await vi.advanceTimersByTimeAsync(60_000);

    // peak-based drawdown is 2.28%, well below 13% — no halt.
    expect(service.isTradingHalted()).toBe(false);
  });

  it('falls back to initialCapital when peak_equity is null/zero (fresh account)', async () => {
    // Fresh account with no peak yet recorded — denominator falls back to initial.
    // current_capital=5000, initial=10000, peak_equity=null → drawdown = 50%
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any) // CREATE TABLE
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any) // start()'s initial check (empty)
      .mockResolvedValueOnce({  // timer-triggered check, peak_equity null
        rows: [{ current_capital: '5000', initial_capital: '10000', peak_equity: null }],
        rowCount: 1,
      } as any)
      .mockResolvedValueOnce({  // exposure
        rows: [{ total_exposure: '0' }],
        rowCount: 1,
      } as any)
      // closeAllPositions / haltTrading / etc. — let them succeed but we only
      // care about the halt decision.
      .mockResolvedValue({ rows: [], rowCount: 0 } as any);

    const service = new CircuitBreakerService({
      checkIntervalMs: 60_000,
      maxDrawdownPct: 30,
      initialCapital: 10000,
    });
    await service.start();
    await vi.advanceTimersByTimeAsync(60_000);

    // 50% drawdown > 30% threshold → halt.
    expect(service.isTradingHalted()).toBe(true);
  });

  it('after checkDrawdown triggers halt, isTradingHalted() returns true even if DB writes fail', async () => {
    // Setup: query mock returns capital=5000 for account check (50% drawdown > 30% threshold)
    // Then all subsequent queries fail (simulating DB failure for halt/close operations)
    let callCount = 0;
    vi.mocked(query).mockImplementation(async (sql: any, _params?: any) => {
      callCount++;
      const sqlStr = String(sql);
      if (sqlStr.includes('CREATE TABLE IF NOT EXISTS trading_config') && !sqlStr.includes('circuit_breaker_log')) {
        // The start() CREATE TABLE call — succeed
        return { rows: [], rowCount: 0 } as any;
      }
      if (sqlStr.includes('FROM paper_account')) {
        // Return low capital to trigger the circuit breaker. peak_equity matches
        // initial here so post-fix denominator behaviour is identical to legacy.
        return { rows: [{ available_capital: '5000', current_capital: '5000', initial_capital: '10000', peak_equity: '10000' }], rowCount: 1 } as any;
      }
      if (sqlStr.includes('paper_positions')) {
        // No open positions to close
        return { rows: [], rowCount: 0 } as any;
      }
      if (sqlStr.includes('trading_config')) {
        // DB write for halt fails
        throw new Error('relation "trading_config" does not exist');
      }
      // Everything else succeeds with empty result
      return { rows: [], rowCount: 0 } as any;
    });

    await service.start();

    // isTradingHalted should now be true because checkDrawdown ran during start()
    // and capital=5000 with initial=10000 is 50% drawdown > 30% threshold
    expect(service.isTradingHalted()).toBe(true);
  });
});
