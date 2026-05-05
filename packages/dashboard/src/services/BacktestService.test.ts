import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock database to keep isDatabaseConfigured() === false (skips DB writes/reads).
vi.mock('../database/index.js', () => ({
  isDatabaseConfigured: () => false,
  query: vi.fn(),
  transaction: vi.fn(),
}));

// Mock backtest engine + calculators so runBacktest doesn't actually execute
// signals over data — we only care that the combiner gets dm applied BEFORE
// the engine starts running.
vi.mock('@polymarket-trader/backtest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@polymarket-trader/backtest')>();
  return {
    ...actual,
    createBacktestEngine: vi.fn(() => ({
      run: vi.fn(async () => ({
        config: {} as any,
        summary: {} as any,
        trades: [],
        equityCurve: [],
        metrics: {} as any,
        predictionMetrics: {} as any,
      })),
    })),
    PerformanceCalculator: {
      ...actual.PerformanceCalculator,
      calculate: vi.fn(() => ({} as any)),
    },
    PredictionMarketCalculator: {
      ...actual.PredictionMarketCalculator,
      calculate: vi.fn(() => ({} as any)),
    },
  };
});

import { WeightedAverageCombiner } from '@polymarket-trader/signals';
import { BacktestService, type BacktestRequest } from './BacktestService.js';
import type { MarketData } from '@polymarket-trader/backtest';

describe('BacktestService — combinerConfig.directionMultiplier propagates to combiner', () => {
  // Use `any` here: the precise spy generic type leaks through ReturnType<typeof vi.spyOn>
  // and clashes with the prototype method signature. Test ergonomics > strict typing.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let setDirectionMultiplierSpy: any;

  // Bare minimum preloaded market data so runBacktest skips fetchHistoricalData
  // and reaches the combiner-construction line.
  const preloaded: MarketData[] = [
    {
      marketId: 'mkt-1',
      tokenId: 'tok-1',
      bars: [],
      currentPriceYes: 0.5,
      marketQuestion: 'q',
      resolved: false,
    } as unknown as MarketData,
  ];

  const baseRequest: BacktestRequest = {
    startDate: '2026-01-01',
    endDate: '2026-01-02',
    initialCapital: 10_000,
    signalTypes: ['momentum'],
    combinerConfig: {
      momentumWeight: 1,
      mean_reversion: 0,
    } as unknown as BacktestRequest['combinerConfig'],
  };

  beforeEach(() => {
    setDirectionMultiplierSpy = vi.spyOn(
      WeightedAverageCombiner.prototype,
      'setDirectionMultiplier',
    );
  });

  afterEach(() => {
    setDirectionMultiplierSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('calls combiner.setDirectionMultiplier(value) when combinerConfig.directionMultiplier is provided', async () => {
    const service = new BacktestService();
    const req: BacktestRequest = {
      ...baseRequest,
      combinerConfig: { ...baseRequest.combinerConfig, directionMultiplier: 1.0 },
    };

    await service.runBacktest(req, preloaded);

    expect(setDirectionMultiplierSpy).toHaveBeenCalledTimes(1);
    expect(setDirectionMultiplierSpy).toHaveBeenCalledWith(1.0);
  });

  it('also propagates negative dm values (e.g. -1)', async () => {
    const service = new BacktestService();
    const req: BacktestRequest = {
      ...baseRequest,
      combinerConfig: { ...baseRequest.combinerConfig, directionMultiplier: -1 },
    };

    await service.runBacktest(req, preloaded);

    expect(setDirectionMultiplierSpy).toHaveBeenCalledWith(-1);
  });

  it('does not call combiner.setDirectionMultiplier when combinerConfig.directionMultiplier is undefined', async () => {
    const service = new BacktestService();
    const req: BacktestRequest = {
      ...baseRequest,
      combinerConfig: { ...baseRequest.combinerConfig },
    };
    // Ensure undefined
    delete (req.combinerConfig as Record<string, unknown>).directionMultiplier;

    await service.runBacktest(req, preloaded);

    expect(setDirectionMultiplierSpy).not.toHaveBeenCalled();
  });

  it('does not call combiner.setDirectionMultiplier for non-finite values (NaN / Infinity)', async () => {
    const service = new BacktestService();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      setDirectionMultiplierSpy.mockClear();
      const req: BacktestRequest = {
        ...baseRequest,
        combinerConfig: { ...baseRequest.combinerConfig, directionMultiplier: bad },
      };
      await service.runBacktest(req, preloaded);
      expect(setDirectionMultiplierSpy).not.toHaveBeenCalled();
    }
  });
});

describe('BacktestService — buildPriceRangeModifier', () => {
  const preloaded: MarketData[] = [
    {
      marketId: 'mkt-1',
      tokenId: 'tok-1',
      bars: [],
      currentPriceYes: 0.5,
      marketQuestion: 'q',
      resolved: false,
    } as unknown as MarketData,
  ];

  it('returns undefined when no priceRangeConfig is supplied (legacy path)', () => {
    const service = new BacktestService();
    const result = (service as any).buildPriceRangeModifier(undefined);
    expect(result).toBeUndefined();
  });

  it('returns undefined when priceRangeConfig has no recognised keys', () => {
    const service = new BacktestService();
    const result = (service as any).buildPriceRangeModifier({});
    expect(result).toBeUndefined();
  });

  it('builds a modifier and overrides only the bands provided', async () => {
    const service = new BacktestService();
    const result = (service as any).buildPriceRangeModifier({
      momentum: { uncertain: 0.7 },
      meanReversion: { transitional: 0.9 },
    });
    expect(result).toBeDefined();
    const matrix = result.getMatrix();
    // momentum.uncertain overridden, transitional/normal keep defaults (0.6 / 1.0)
    expect(matrix.momentum).toEqual({ normal: 1.0, transitional: 0.6, uncertain: 0.7 });
    // mean_reversion.transitional overridden, others keep defaults (0 / 1.0)
    expect(matrix.mean_reversion).toEqual({ normal: 1.0, transitional: 0.9, uncertain: 0 });
  });

  it('forwards the modifier to createBacktestEngine', async () => {
    const { createBacktestEngine } = await import('@polymarket-trader/backtest');
    const service = new BacktestService();
    const req: BacktestRequest = {
      startDate: '2026-01-01',
      endDate: '2026-01-02',
      initialCapital: 10_000,
      signalTypes: ['momentum'],
      priceRangeConfig: { momentum: { uncertain: 0.8 } },
    };
    await service.runBacktest(req, preloaded);
    const calls = (createBacktestEngine as unknown as { mock: { calls: any[] } }).mock.calls;
    const lastCall = calls[calls.length - 1][0];
    expect(lastCall.priceRangeModifier).toBeDefined();
    expect(lastCall.priceRangeModifier.getMatrix().momentum.uncertain).toBe(0.8);
  });

  it('passes undefined when priceRangeConfig absent so the engine uses raw weights', async () => {
    const { createBacktestEngine } = await import('@polymarket-trader/backtest');
    (createBacktestEngine as unknown as { mock: { calls: any[] } }).mock.calls.length = 0;
    const service = new BacktestService();
    const req: BacktestRequest = {
      startDate: '2026-01-01',
      endDate: '2026-01-02',
      initialCapital: 10_000,
      signalTypes: ['momentum'],
    };
    await service.runBacktest(req, preloaded);
    const calls = (createBacktestEngine as unknown as { mock: { calls: any[] } }).mock.calls;
    expect(calls[calls.length - 1][0].priceRangeModifier).toBeUndefined();
  });
});
