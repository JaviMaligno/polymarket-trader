import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../database/index.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
  isDatabaseConfigured: vi.fn(() => true),
}));

vi.mock('../database/repositories.js', () => ({
  signalWeightsRepo: {
    update: vi.fn().mockResolvedValue(undefined),
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
import { OptimizationScheduler } from './OptimizationScheduler.js';

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
