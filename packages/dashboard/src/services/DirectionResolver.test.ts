import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DirectionResolver } from './DirectionResolver.js';
import type { DirectionMultiplierPolicy } from './DirectionMultiplierPolicy.js';

const stubRepo = {
  getExplorationStats: vi.fn().mockResolvedValue({ count: 0, pnl: 0 }),
};

const stubConfig = {
  enabled: true,
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

  beforeEach(() => vi.clearAllMocks());

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

  it('returns global with reason=global when exploration is disabled, regardless of rng', async () => {
    const resolver = new DirectionResolver({
      policyProvider: async () => policy,
      explorationConfig: { ...stubConfig, enabled: false },
      rng: () => 0.0,  // would normally trigger exploration
      paperPositionsRepo: stubRepo as any,
      logger,
    });
    const result = await resolver.resolve(ctx);
    expect(result.multiplier).toBe(-1.0);
    expect(result.wasExploration).toBe(false);
    expect(result.reason).toBe('global');
  });
});
