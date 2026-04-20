import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DirectionResolver } from './DirectionResolver.js';
import type { DirectionMultiplierPolicy } from './DirectionMultiplierPolicy.js';

const stubRepo = {
  getExplorationStats: vi.fn().mockResolvedValue({ count: 0, pnl: 0 }),
};

const stubConfig = {
  epsilon: 0.1,
  min: 0.0,
  max: 1.0,
  breakerMinTrades: 20,
  breakerWindowDays: 7,
  breakerMaxCumLoss: -150,
  breakerCacheTtlMs: 300_000,
};

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

describe('DirectionResolver — segment match', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns segment multiplier with reason=segment when a segment matches', async () => {
    const policy: DirectionMultiplierPolicy = {
      global: -1.0,
      minMultiplier: -1.25,
      maxMultiplier: 1.0,
      segments: [{
        id: 'event_financial-20to40-medium',
        multiplier: -1.25,
        marketTypes: ['event_financial'],
        priceRange: { min: 0.2, max: 0.4 },
        durationBands: ['medium'],
      }],
    };
    const resolver = new DirectionResolver({
      policyProvider: async () => policy,
      explorationConfig: stubConfig,
      rng: () => 0.5,
      paperPositionsRepo: stubRepo as any,
      logger,
    });

    const result = await resolver.resolve({
      marketType: 'event_financial',
      currentPrice: 0.3,
      endDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),  // medium duration
    });

    expect(result.multiplier).toBe(-1.25);
    expect(result.segmentId).toBe('event_financial-20to40-medium');
    expect(result.wasExploration).toBe(false);
    expect(result.reason).toBe('segment');
    expect(result.contextKey).toContain('event_financial');
  });
});

describe('DirectionResolver — exploration sampling', () => {
  const policy: DirectionMultiplierPolicy = {
    global: -1.0, minMultiplier: -1.25, maxMultiplier: 1.0, segments: [],
  };
  const ctx = {
    marketType: 'event_long',
    currentPrice: 0.3,
    endDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
  };

  beforeEach(() => { vi.clearAllMocks(); });

  it('returns global when segment misses and rng misses epsilon', async () => {
    const resolver = new DirectionResolver({
      policyProvider: async () => policy,
      explorationConfig: stubConfig,
      // First rng call is the epsilon roll; 0.5 > 0.1 epsilon → miss
      rng: () => 0.5,
      paperPositionsRepo: stubRepo as any,
      logger,
    });
    const result = await resolver.resolve(ctx);
    expect(result.multiplier).toBe(-1.0);
    expect(result.wasExploration).toBe(false);
    expect(result.reason).toBe('global');
  });

  it('samples uniformly from [min, max] when segment misses and rng hits epsilon', async () => {
    // 1st rng() = 0.05 → < 0.1 epsilon → hit.
    // 2nd rng() = 0.7 → sampled = 0 + 0.7 * (1 - 0) = 0.7
    const rngCalls = [0.05, 0.7];
    let i = 0;
    const resolver = new DirectionResolver({
      policyProvider: async () => policy,
      explorationConfig: stubConfig,
      rng: () => rngCalls[i++],
      paperPositionsRepo: stubRepo as any,
      logger,
    });
    const result = await resolver.resolve(ctx);
    expect(result.multiplier).toBeCloseTo(0.7, 5);
    expect(result.wasExploration).toBe(true);
    expect(result.reason).toBe('exploration');
    expect(result.segmentId).toBeNull();
  });

  it('returns global with reason=global when epsilon=0 (kill switch), regardless of rng', async () => {
    const resolver = new DirectionResolver({
      policyProvider: async () => policy,
      explorationConfig: { ...stubConfig, epsilon: 0 },
      rng: () => 0.0,  // rng() >= epsilon (0 >= 0) so epsilon=0 always misses
      paperPositionsRepo: stubRepo as any,
      logger,
    });
    const result = await resolver.resolve(ctx);
    expect(result.multiplier).toBe(-1.0);
    expect(result.wasExploration).toBe(false);
    expect(result.reason).toBe('global');
  });
});

describe('DirectionResolver — circuit breaker', () => {
  const policy: DirectionMultiplierPolicy = {
    global: -1.0, minMultiplier: -1.25, maxMultiplier: 1.0, segments: [],
  };
  const ctx = {
    marketType: 'event_long',
    currentPrice: 0.3,
    endDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
  };

  beforeEach(() => { vi.clearAllMocks(); });

  it('returns global with reason=breaker_tripped when exploration losses exceed threshold', async () => {
    const repo = { getExplorationStats: vi.fn().mockResolvedValue({ count: 22, pnl: -172.45 }) };
    const resolver = new DirectionResolver({
      policyProvider: async () => policy,
      explorationConfig: stubConfig,
      rng: () => 0.05,  // would sample exploration otherwise
      paperPositionsRepo: repo as any,
      logger,
    });
    const result = await resolver.resolve(ctx);
    expect(result.reason).toBe('breaker_tripped');
    expect(result.wasExploration).toBe(false);
    expect(result.multiplier).toBe(-1.0);
  });

  it('does not trip when count below minTrades', async () => {
    const repo = { getExplorationStats: vi.fn().mockResolvedValue({ count: 19, pnl: -500 }) };
    const resolver = new DirectionResolver({
      policyProvider: async () => policy,
      explorationConfig: stubConfig,
      rng: () => 0.05,
      paperPositionsRepo: repo as any,
      logger,
    });
    const result = await resolver.resolve(ctx);
    // Should proceed to sampling, not breaker_tripped
    expect(result.reason).toBe('exploration');
  });

  it('caches breaker state and does not requery within TTL', async () => {
    const repo = { getExplorationStats: vi.fn().mockResolvedValue({ count: 22, pnl: -200 }) };
    const resolver = new DirectionResolver({
      policyProvider: async () => policy,
      explorationConfig: { ...stubConfig, breakerCacheTtlMs: 60_000 },
      rng: () => 0.05,
      paperPositionsRepo: repo as any,
      logger,
    });
    await resolver.resolve(ctx);
    await resolver.resolve(ctx);
    await resolver.resolve(ctx);
    expect(repo.getExplorationStats).toHaveBeenCalledTimes(1);
  });
});

describe('DirectionResolver — breaker status write', () => {
  const policy: DirectionMultiplierPolicy = {
    global: -1.0, minMultiplier: -1.25, maxMultiplier: 1.0, segments: [],
  };
  const ctx = {
    marketType: 'event_long',
    currentPrice: 0.3,
    endDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
  };

  beforeEach(() => { vi.clearAllMocks(); });

  it('writes status=tripped to trading_config when breaker first trips', async () => {
    const repo = { getExplorationStats: vi.fn().mockResolvedValue({ count: 22, pnl: -172.45 }) };
    const setConfig = vi.fn().mockResolvedValue(undefined);
    const resolver = new DirectionResolver({
      policyProvider: async () => policy,
      explorationConfig: stubConfig,
      rng: () => 0.05,
      paperPositionsRepo: repo as any,
      logger,
      setTradingConfig: setConfig,
    });
    await resolver.resolve(ctx);
    expect(setConfig).toHaveBeenCalledWith(
      'direction_exploration_status',
      expect.objectContaining({
        state: 'tripped',
        exploreCount: 22,
        explorePnl: -172.45,
        thresholdTrades: 20,
        thresholdLoss: -150,
      }),
      expect.any(String),
    );
  });

  it('writes status=active when breaker un-trips after previously tripped', async () => {
    // First call: tripped. Second call (after cache expires): no longer tripped.
    const repo = {
      getExplorationStats: vi.fn()
        .mockResolvedValueOnce({ count: 22, pnl: -172 })
        .mockResolvedValueOnce({ count: 8, pnl: -30 }),
    };
    const setConfig = vi.fn().mockResolvedValue(undefined);
    const resolver = new DirectionResolver({
      policyProvider: async () => policy,
      explorationConfig: { ...stubConfig, breakerCacheTtlMs: 0 },  // disable cache for test
      rng: () => 0.05,
      paperPositionsRepo: repo as any,
      logger,
      setTradingConfig: setConfig,
    });
    await resolver.resolve(ctx);
    await resolver.resolve(ctx);
    const calls = setConfig.mock.calls.map(c => c[1].state);
    expect(calls).toEqual(['tripped', 'active']);
  });
});
