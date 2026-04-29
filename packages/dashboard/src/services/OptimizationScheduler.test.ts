import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../database/index.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
  isDatabaseConfigured: vi.fn(() => true),
}));

vi.mock('../database/repositories.js', () => ({
  signalWeightsRepo: {
    update: vi.fn().mockResolvedValue(undefined),
    updatePerType: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('./BacktestService.js', () => ({
  getBacktestService: vi.fn(() => ({
    fetchHistoricalData: vi.fn().mockResolvedValue([]),
    runBacktest: vi.fn(),
  })),
}));

vi.mock('./ValidationService.js', () => ({
  getValidationService: vi.fn(() => ({})),
}));

vi.mock('./TradingAutomation.js', () => ({
  getTradingAutomation: vi.fn(() => ({})),
}));

vi.mock('./OptunaClient.js', () => ({
  OptunaClient: vi.fn(),
}));

vi.mock('../utils/vmHealth.js', () => ({
  checkVMHealth: vi.fn(() => ({ shouldPause: false })),
  tryFreeMemory: vi.fn(),
  logHealthStatus: vi.fn(),
}));

import { signalWeightsRepo } from '../database/repositories.js';
import { OptimizationScheduler, getOosMinTrades, OOS_MIN_TRADES_PER_TYPE } from './OptimizationScheduler.js';

describe('OptimizationScheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('excludes combiner.directionMultiplier from the Optuna parameter space', async () => {
    const scheduler = new OptimizationScheduler();
    const createOptimizer = vi.fn().mockResolvedValue('optimizer-1');
    const deleteOptimizer = vi.fn().mockResolvedValue(undefined);

    (scheduler as any).optunaClient = {
      ping: vi.fn().mockResolvedValue(true),
      createOptimizer,
      deleteOptimizer,
    };

    await (scheduler as any).runOptimization(0, 'full');

    expect(createOptimizer).toHaveBeenCalledTimes(1);
    const [, paramSpace] = createOptimizer.mock.calls[0];
    const names = paramSpace.map((param: { name: string }) => param.name);

    expect(names).not.toContain('combiner.directionMultiplier');
  });

  it('always enforces direction_multiplier to -1.0 after a successful optimization', async () => {
    const scheduler = new OptimizationScheduler();
    (scheduler as any)._lastOOSResult = {
      passed: true,
      sharpeOOS: 0.7,
      drawdownOOS: 0.1,
      tradesOOS: 24,
      winRateOOS: 0.6,
      marketsEvaluated: 12,
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: vi.fn(),
    }));

    await (scheduler as any).updateStrategy({
      params: {
        'combiner.directionMultiplier': -0.7819,
      },
      sharpe: 1.1,
      totalReturn: 0.12,
      trades: 30,
    });

    expect(signalWeightsRepo.update).toHaveBeenCalledWith(
      'direction_multiplier',
      -1.0,
      expect.stringMatching(/^optimization-\d{4}-\d{2}-\d{2}$/),
    );
  });
});

describe('getOosMinTrades', () => {
  const ENV_KEYS = [
    'OPTIMIZER_MIN_TRADES_CRYPTO_INTRADAY',
    'OPTIMIZER_MIN_TRADES_CRYPTO_DAILY',
    'OPTIMIZER_MIN_TRADES_EVENT_FINANCIAL',
    'OPTIMIZER_MIN_TRADES_EVENT_SHORT',
    'OPTIMIZER_MIN_TRADES_EVENT_LONG',
    'OPTIMIZER_MIN_TRADES_UNKNOWN_TYPE',
  ];

  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it('event_long floor is 5 (was 20 — was rejecting positive IS Sharpe with 7 trades)', () => {
    expect(getOosMinTrades('event_long')).toBe(5);
  });

  it('crypto_intraday floor is 30 (high-frequency, 4-day OOS expected to deliver more)', () => {
    expect(getOosMinTrades('crypto_intraday')).toBe(30);
  });

  it('all 5 known market types have a per-type floor', () => {
    expect(Object.keys(OOS_MIN_TRADES_PER_TYPE).sort()).toEqual([
      'crypto_daily',
      'crypto_intraday',
      'event_financial',
      'event_long',
      'event_short',
    ]);
  });

  it('unknown market_type falls back to legacy default 20', () => {
    expect(getOosMinTrades('unknown_type')).toBe(20);
  });

  it('OPTIMIZER_MIN_TRADES_<TYPE> env var overrides the per-type default', () => {
    process.env.OPTIMIZER_MIN_TRADES_EVENT_LONG = '8';
    expect(getOosMinTrades('event_long')).toBe(8);
  });

  it('ignores invalid env values (non-numeric, zero, negative)', () => {
    process.env.OPTIMIZER_MIN_TRADES_EVENT_LONG = 'abc';
    expect(getOosMinTrades('event_long')).toBe(5);
    process.env.OPTIMIZER_MIN_TRADES_EVENT_LONG = '0';
    expect(getOosMinTrades('event_long')).toBe(5);
    process.env.OPTIMIZER_MIN_TRADES_EVENT_LONG = '-3';
    expect(getOosMinTrades('event_long')).toBe(5);
  });
});
