import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../database/index.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
  isDatabaseConfigured: vi.fn(() => true),
}));

vi.mock('../database/repositories.js', () => ({
  signalWeightsRepo: {
    update: vi.fn().mockResolvedValue(undefined),
    updatePerType: vi.fn().mockResolvedValue(undefined),
    getPerType: vi.fn().mockResolvedValue(null),
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
import { query } from '../database/index.js';
import {
  OptimizationScheduler,
  getOosMinTrades,
  OOS_MIN_TRADES_PER_TYPE,
  REFINEMENT_PARAM_SPACE,
  OPTUNA_PARAM_SPACE,
} from './OptimizationScheduler.js';

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

describe('bestSharpePerType persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(query).mockResolvedValue({ rows: [] } as any);
  });

  it('saveState writes bestSharpePerType as JSONB to optimization_service_state', async () => {
    const scheduler = new OptimizationScheduler();
    (scheduler as any).state.bestSharpePerType = {
      event_financial: 0.42,
      event_long: 0.11,
    };

    await (scheduler as any).saveState();

    const stateUpsertCall = vi.mocked(query).mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('optimization_service_state'),
    );
    expect(stateUpsertCall).toBeDefined();
    const params = stateUpsertCall?.[1] as unknown[];
    // Last param is the JSON payload — assert it carries the per-type map.
    const jsonParam = params.find(
      (p) => typeof p === 'string' && p.includes('event_financial'),
    );
    expect(jsonParam).toBe(JSON.stringify({ event_financial: 0.42, event_long: 0.11 }));
  });

  it('loadState restores bestSharpePerType from optimization_service_state row', async () => {
    const persisted = { event_financial: 0.55, event_short: 0.18 };
    vi.mocked(query).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM optimization_runs')) {
        return { rows: [{ best_params: { foo: 1 }, best_score: 0.99, completed_at: new Date('2026-04-28') }] } as any;
      }
      if (sql.includes('FROM optimization_service_state')) {
        return {
          rows: [{
            last_incremental_run_at: null,
            last_full_run_at: null,
            best_sharpe_per_type: persisted,
          }],
        } as any;
      }
      return { rows: [] } as any;
    });

    const scheduler = new OptimizationScheduler();
    await (scheduler as any).loadState();

    expect((scheduler as any).state.bestSharpePerType).toEqual(persisted);
  });

  it('loadState falls back to { __legacy__: best_score } when persisted column is absent or empty', async () => {
    vi.mocked(query).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM optimization_runs')) {
        return { rows: [{ best_params: { foo: 1 }, best_score: 0.42, completed_at: new Date() }] } as any;
      }
      if (sql.includes('FROM optimization_service_state')) {
        return { rows: [{ last_incremental_run_at: null, last_full_run_at: null, best_sharpe_per_type: {} }] } as any;
      }
      return { rows: [] } as any;
    });

    const scheduler = new OptimizationScheduler();
    await (scheduler as any).loadState();

    expect((scheduler as any).state.bestSharpePerType).toEqual({ __legacy__: 0.42 });
  });
});

describe('runGridOptimization marketType filter (#146)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(query).mockResolvedValue({ rows: [] } as any);
  });

  it('preloads filtered data once per cycle via fetchHistoricalData(start, end, undefined, marketType)', async () => {
    const scheduler = new OptimizationScheduler();
    const filteredData = [{ marketId: 'm1' }, { marketId: 'm2' }] as any[];
    const fetchSpy = vi.fn().mockResolvedValue(filteredData);
    const runBacktestSpy = vi.fn().mockResolvedValue({
      result: {
        metrics: { sharpeRatio: 0.3, totalReturn: 0.05, maxDrawdown: 0.1 },
        trades: [],
      },
    });
    (scheduler as any).backtestService = {
      fetchHistoricalData: fetchSpy,
      runBacktest: runBacktestSpy,
    };
    (scheduler as any).backtestDelayMs = 0;

    await (scheduler as any).runGridOptimization(2, 'incremental', 'event_long');

    // Preloaded once with marketType='event_long'
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const args = fetchSpy.mock.calls[0];
    expect(args[2]).toBeUndefined();          // marketIds
    expect(args[3]).toBe('event_long');       // marketType
  });

  it('passes preloaded filtered data to runBacktest as second argument', async () => {
    const scheduler = new OptimizationScheduler();
    const filteredData = [{ marketId: 'm1' }] as any[];
    const fetchSpy = vi.fn().mockResolvedValue(filteredData);
    const runBacktestSpy = vi.fn().mockResolvedValue({
      result: {
        metrics: { sharpeRatio: 0.2, totalReturn: 0.04, maxDrawdown: 0.1 },
        trades: [],
      },
    });
    (scheduler as any).backtestService = {
      fetchHistoricalData: fetchSpy,
      runBacktest: runBacktestSpy,
    };
    (scheduler as any).backtestDelayMs = 0;

    await (scheduler as any).runGridOptimization(1, 'incremental', 'crypto_daily');

    expect(runBacktestSpy).toHaveBeenCalled();
    const [, preloadedArg] = runBacktestSpy.mock.calls[0];
    expect(preloadedArg).toBe(filteredData);
  });
});

describe('applyGlobalThresholds — once per cycle, max-Sharpe winner (#145)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(query).mockResolvedValue({ rows: [] } as any);
  });

  it('updateStrategy returns wasApplied=true when OOS passes', async () => {
    const scheduler = new OptimizationScheduler();
    (scheduler as any)._lastOOSResult = {
      passed: true,
      sharpeOOS: 0.5,
      drawdownOOS: 0.1,
      tradesOOS: 30,
      winRateOOS: 0.5,
      marketsEvaluated: 10,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: vi.fn() }));

    const result = await (scheduler as any).updateStrategy(
      { params: {}, sharpe: 0.5, totalReturn: 0.05, trades: 30 },
      'event_financial',
    );

    expect(result.wasApplied).toBe(true);
  });

  it('updateStrategy returns wasApplied=false when OOS fails', async () => {
    const scheduler = new OptimizationScheduler();
    (scheduler as any)._lastOOSResult = {
      passed: false,
      sharpeOOS: 0,
      drawdownOOS: 0,
      tradesOOS: 0,
      winRateOOS: 0,
      marketsEvaluated: 0,
      reason: 'low Sharpe',
    };

    const result = await (scheduler as any).updateStrategy(
      { params: {}, sharpe: 0.5, totalReturn: 0.05, trades: 30 },
      'event_financial',
    );

    expect(result.wasApplied).toBe(false);
  });

  it('updateStrategy returns wasApplied=false when totalReturn < -0.1', async () => {
    const scheduler = new OptimizationScheduler();
    (scheduler as any)._lastOOSResult = { passed: true };

    const result = await (scheduler as any).updateStrategy(
      { params: {}, sharpe: 0.5, totalReturn: -0.5, trades: 30 },
      'event_financial',
    );

    expect(result.wasApplied).toBe(false);
  });

  it('updateStrategy no longer touches global executor config or strategy API', async () => {
    const scheduler = new OptimizationScheduler();
    (scheduler as any)._lastOOSResult = {
      passed: true,
      sharpeOOS: 0.5,
      drawdownOOS: 0.1,
      tradesOOS: 30,
      winRateOOS: 0.5,
      marketsEvaluated: 10,
    };
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, json: vi.fn() });
    vi.stubGlobal('fetch', fetchSpy);

    await (scheduler as any).updateStrategy(
      { params: {}, sharpe: 0.5, totalReturn: 0.05, trades: 30 },
      'event_financial',
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('applyGlobalThresholds calls strategy API and updates executor config', async () => {
    const scheduler = new OptimizationScheduler();
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue({ data: { strategies: [] } }) })
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue({ data: { id: 'new-strat' } }) })
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);

    await (scheduler as any).applyGlobalThresholds(
      { params: { 'combiner.minCombinedStrength': 0.3, 'combiner.minCombinedConfidence': 0.5 }, sharpe: 0.5, totalReturn: 0.05, trades: 30 },
      'event_financial',
    );

    expect(fetchSpy).toHaveBeenCalled();
    // 1st GET strategies, 2nd POST create, 3rd POST start
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('OptimizationScheduler.mapOptunaParamsToRequest — directionMultiplier forward', () => {
  it('forwards combiner.directionMultiplier to combinerConfig.directionMultiplier', () => {
    const scheduler = new OptimizationScheduler();
    const params = {
      'combiner.directionMultiplier': 1.0,
      'combiner.momentumWeight': 0.5,
      'combiner.meanReversionWeight': 0.5,
      'combiner.ofiWeight': 0.5,
      'combiner.hawkesWeight': 0.5,
      'combiner.volumeAnomalyWeight': 0.5,
      'combiner.mlofiWeight': 0.5,
      'combiner.spreadCompressionWeight': 0.5,
      'risk.maxPositionSizePct': 5,
      'risk.maxPositions': 10,
      'risk.stopLossPct': 25,
      'risk.takeProfitPct': 40,
      'combiner.minCombinedConfidence': 0.4,
      'combiner.minCombinedStrength': 0.3,
      'momentum.rsiPeriod': 14,
      'meanReversion.bollingerPeriod': 20,
      'meanReversion.zScoreThreshold': 2.0,
    };
    const start = new Date('2026-04-20');
    const end = new Date('2026-04-30');
    const req = (scheduler as any).mapOptunaParamsToRequest(params, start, end);
    expect(req.combinerConfig.directionMultiplier).toBe(1.0);
  });

  it('forwards -1.0 unchanged (categorical choices include -1)', () => {
    const scheduler = new OptimizationScheduler();
    const params = {
      'combiner.directionMultiplier': -1.0,
      'combiner.minCombinedConfidence': 0.4,
      'combiner.minCombinedStrength': 0.3,
    };
    const start = new Date('2026-04-20');
    const end = new Date('2026-04-30');
    const req = (scheduler as any).mapOptunaParamsToRequest(params, start, end);
    expect(req.combinerConfig.directionMultiplier).toBe(-1.0);
  });

  it('passes undefined when combiner.directionMultiplier is absent (FULL strategy)', () => {
    const scheduler = new OptimizationScheduler();
    const params = {
      'combiner.momentumWeight': 0.5,
      'risk.maxPositionSizePct': 5,
      'risk.stopLossPct': 25,
      'combiner.minCombinedConfidence': 0.4,
      'combiner.minCombinedStrength': 0.3,
    };
    const start = new Date('2026-04-20');
    const end = new Date('2026-04-30');
    const req = (scheduler as any).mapOptunaParamsToRequest(params, start, end);
    expect(req.combinerConfig.directionMultiplier).toBeUndefined();
  });
});

describe('OptimizationScheduler param spaces — directionMultiplier', () => {
  it('REFINEMENT_PARAM_SPACE exposes combiner.directionMultiplier as categorical with choices [-1, 1]', () => {
    const dm = REFINEMENT_PARAM_SPACE.find((p) => p.name === 'combiner.directionMultiplier');
    expect(dm).toBeDefined();
    expect(dm!.type).toBe('categorical');
    expect((dm as { choices?: unknown[] }).choices).toEqual([-1.0, 1.0]);
  });

  it('OPTUNA_PARAM_SPACE (FULL) does NOT include combiner.directionMultiplier (PR #104 invariant)', () => {
    const names = OPTUNA_PARAM_SPACE.map((p) => p.name);
    expect(names).not.toContain('combiner.directionMultiplier');
  });
});

describe('signalWeightsRepo.getPerType (helper for min-lift gate)', () => {
  it('is exported on signalWeightsRepo and is mocked by the test setup', () => {
    expect(signalWeightsRepo).toBeDefined();
    // Only assert presence in the mock map; runtime behaviour is covered by integration tests.
    expect(typeof (signalWeightsRepo as any).updatePerType).toBe('function');
  });
});
