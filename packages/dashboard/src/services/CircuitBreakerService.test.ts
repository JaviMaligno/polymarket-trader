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
vi.mock('../database/repositories.js', () => ({
  paperTradesRepo: { create: vi.fn() },
  paperPositionsRepo: { getAll: vi.fn() },
}));
vi.mock('./TradingAutomation.js', () => ({
  getTradingAutomation: vi.fn(() => ({ on: vi.fn(), off: vi.fn() })),
}));
vi.mock('./StopLossService.js', () => ({
  getStopLossService: vi.fn(() => ({ on: vi.fn(), off: vi.fn() })),
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
    vi.doMock('../database/repositories.js', () => ({
      paperTradesRepo: { create: vi.fn() },
      paperPositionsRepo: { getAll: vi.fn() },
    }));
    vi.doMock('./TradingAutomation.js', () => ({
      getTradingAutomation: vi.fn(() => ({ on: vi.fn(), off: vi.fn() })),
    }));
    vi.doMock('./StopLossService.js', () => ({
      getStopLossService: vi.fn(() => ({ on: vi.fn(), off: vi.fn() })),
    }));

    const { CircuitBreakerService: FreshService } = await import('./CircuitBreakerService.js');
    const freshService = new FreshService();
    expect((freshService as any).config.maxDrawdownPct).toBe(15);

    delete process.env.MAX_DRAWDOWN;
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
      if (sqlStr.includes('SELECT current_capital')) {
        // Return low capital to trigger the circuit breaker
        return { rows: [{ current_capital: '5000', initial_capital: '10000' }], rowCount: 1 } as any;
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
