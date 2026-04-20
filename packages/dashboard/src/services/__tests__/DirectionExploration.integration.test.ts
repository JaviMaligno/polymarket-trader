import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { DirectionResolver } from '../DirectionResolver.js';
import { enrichCombinedWithDirection } from '../SignalEngine.js';
import type { DirectionMultiplierPolicy } from '../DirectionMultiplierPolicy.js';

describe('Direction exploration — end-to-end integration', () => {
  const policy: DirectionMultiplierPolicy = {
    global: -1.0, minMultiplier: -1.25, maxMultiplier: 1.0, segments: [],
  };
  const ctx = {
    marketType: 'event_long',
    currentPrice: 0.3,
    endDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
  };
  const stubRepo = {
    getExplorationStats: vi.fn().mockResolvedValue({ count: 5, pnl: 0 }),
    openPositionAtomically: vi.fn().mockResolvedValue({ opened: true }),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  beforeEach(() => { vi.clearAllMocks(); });

  it('an exploration resolution ends up persisted with was_exploration=true', async () => {
    const resolver = new DirectionResolver({
      policyProvider: async () => policy,
      explorationConfig: {
        enabled: true, epsilon: 1.0, min: 0.0, max: 1.0,
        breakerMinTrades: 20, breakerWindowDays: 7, breakerMaxCumLoss: -150, breakerCacheTtlMs: 300_000,
      },
      rng: (() => { let i = 0; const vals = [0.0, 0.6]; return () => vals[i++ % 2]; })(),
      paperPositionsRepo: stubRepo as any,
      logger,
    });

    const resolution = await resolver.resolve(ctx);
    expect(resolution.wasExploration).toBe(true);
    expect(resolution.multiplier).toBeCloseTo(0.6, 5);

    // Simulate combiner producing a combined output with appliedDirectionMultiplier set
    const combined = {
      signalId: 'combined', marketId: 'mkt1', tokenId: 'tok1',
      direction: 'long' as const, strength: 0.3, confidence: 0.7,
      timestamp: new Date(), ttlMs: 60_000, componentSignals: [], weights: {},
      appliedDirectionMultiplier: resolution.multiplier, metadata: {},
    };
    const enriched = enrichCombinedWithDirection(combined, resolution);
    expect(enriched.wasExploration).toBe(true);
    expect(enriched.appliedDirectionMultiplier).toBeCloseTo(0.6, 5);

    // Simulate executor building the PaperPosition payload
    const positionPayload = {
      market_id: 'mkt1', token_id: 'tok1', side: 'long' as const, size: 10,
      avg_entry_price: 0.3, current_price: 0.3,
      opened_at: new Date(),
      applied_direction_multiplier: enriched.appliedDirectionMultiplier,
      was_exploration: enriched.wasExploration,
    };
    await stubRepo.openPositionAtomically(positionPayload, 3.0, 0.01);
    expect(stubRepo.openPositionAtomically).toHaveBeenCalledWith(
      expect.objectContaining({
        applied_direction_multiplier: expect.closeTo(0.6, 5),
        was_exploration: true,
      }),
      3.0, 0.01,
    );
  });

  it('breaker-tripped resolution persists with was_exploration=false and multiplier=global', async () => {
    stubRepo.getExplorationStats = vi.fn().mockResolvedValue({ count: 25, pnl: -200 });
    const resolver = new DirectionResolver({
      policyProvider: async () => policy,
      explorationConfig: {
        enabled: true, epsilon: 1.0, min: 0.0, max: 1.0,
        breakerMinTrades: 20, breakerWindowDays: 7, breakerMaxCumLoss: -150, breakerCacheTtlMs: 300_000,
      },
      rng: () => 0.0,  // would trigger exploration otherwise
      paperPositionsRepo: stubRepo as any,
      logger,
    });
    const resolution = await resolver.resolve(ctx);
    expect(resolution.reason).toBe('breaker_tripped');
    expect(resolution.wasExploration).toBe(false);
    expect(resolution.multiplier).toBe(-1.0);
  });
});

describe('convertToSignalResult propagation (source-pinning)', () => {
  it('preserves appliedDirectionMultiplier and wasExploration from enriched output to SignalResult', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../SignalEngine.ts'),
      'utf8',
    );
    const fnStart = source.indexOf('convertToSignalResult(');
    expect(fnStart).toBeGreaterThan(-1);
    // Find the end of the function body by looking for the next JSDoc comment
    const fnEnd = source.indexOf('/**\n   * Send signals', fnStart);
    const fnBody = source.substring(fnStart, fnEnd);
    expect(fnBody).toContain('appliedDirectionMultiplier');
    expect(fnBody).toContain('wasExploration');
  });
});
