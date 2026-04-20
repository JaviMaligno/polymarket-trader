import { describe, expect, it, vi } from 'vitest';
import { bucketDirectionMultiplier, DEFAULT_CONFIG, deriveDirectionMultiplierPolicy, type DirectionLearningRow } from './DirectionMultiplierLearningService.js';

function repeat(row: DirectionLearningRow, count: number): DirectionLearningRow[] {
  return Array.from({ length: count }, () => ({ ...row }));
}

describe('DirectionMultiplierLearningService policy derivation', () => {
  it('creates a segment override when a bucket clearly beats the baseline', () => {
    // Global multiplier -1.0 → strong_negative bucket (the losing baseline)
    // near_zero bucket wins clearly → should produce a segment override
    const rows = [
      ...repeat({
        marketType: 'event_financial',
        priceBucket: '40to60',
        durationBand: 'medium',
        realizedPnl: 4,
        directionMultiplier: 0.1,
      }, 12),
      ...repeat({
        marketType: 'event_financial',
        priceBucket: '40to60',
        durationBand: 'medium',
        realizedPnl: -1,
        directionMultiplier: -1.2,
      }, 12),
    ];

    const { policy, summary } = deriveDirectionMultiplierPolicy(rows, -1.0, {
      enabled: true,
      evaluationIntervalMs: 1,
      lookbackDays: 30,
      minSegmentTrades: 10,
      minCandidateTrades: 6,
      minImprovementPerTrade: 1,
      minWinRateLift: 0.05,
      maxSegments: 5,
      minMultiplier: -1.25,
      maxMultiplier: 1.0,
      maxPositiveMultiplier: 1.0,
    });

    expect(policy.segments).toHaveLength(1);
    expect(policy.segments[0].id).toBe('event_financial-40to60-medium');
    expect(policy.segments[0].multiplier).toBeGreaterThan(-0.5);
    expect(summary.segmentCount).toBe(1);
  });

  it('does not create a positive override from tiny sample noise', () => {
    const rows = [
      ...repeat({
        marketType: 'event_financial',
        priceBucket: '40to60',
        durationBand: 'medium',
        realizedPnl: 1,
        directionMultiplier: -0.8,
      }, 14),
      ...repeat({
        marketType: 'event_financial',
        priceBucket: '40to60',
        durationBand: 'medium',
        realizedPnl: 3,
        directionMultiplier: 0.08,
      }, 3),
    ];

    const { policy } = deriveDirectionMultiplierPolicy(rows, -1.0, {
      enabled: true,
      evaluationIntervalMs: 1,
      lookbackDays: 30,
      minSegmentTrades: 10,
      minCandidateTrades: 6,
      minImprovementPerTrade: 0.5,
      minWinRateLift: 0.05,
      maxSegments: 5,
      minMultiplier: -1.25,
      maxMultiplier: 1.0,
      maxPositiveMultiplier: 1.0,
    });

    expect(policy.segments).toHaveLength(0);
  });
});

describe('DirectionMultiplierLearningService — widened buckets', () => {
  it.each([
    [-1.25, 'strong_negative'],
    [-0.5,  'strong_negative'],
    [-0.49, 'near_zero'],
    [0.0,   'near_zero'],
    [0.24,  'near_zero'],
    [0.25,  'weak_positive'],
    [0.5,   'weak_positive'],
    [0.74,  'weak_positive'],
    [0.75,  'strong_positive'],
    [1.0,   'strong_positive'],
  ])('buckets %f as %s', (mult, expected) => {
    expect(bucketDirectionMultiplier(mult)).toBe(expected);
  });

  it('DEFAULT_CONFIG permits multipliers up to +1.0', () => {
    expect(DEFAULT_CONFIG.maxMultiplier).toBe(1.0);
    expect(DEFAULT_CONFIG.maxPositiveMultiplier).toBe(1.0);
    expect(DEFAULT_CONFIG.minMultiplier).toBe(-1.25);
  });
});

describe('DirectionMultiplierLearningService — query COALESCE', () => {
  it('learner query prefers pp.applied_direction_multiplier over signal_weights_history', async () => {
    // Inspect the SQL text the service would run — we do not need a live DB.
    // The service uses `query` from index.js; we stub it and assert the SQL contains
    // the COALESCE in the required order.
    const indexMod = await import('../database/index.js');
    const querySpy = vi.spyOn(indexMod, 'query').mockResolvedValue({ rows: [] } as any);
    const isDatabaseConfiguredSpy = vi.spyOn(indexMod, 'isDatabaseConfigured').mockReturnValue(true);
    const signalWeightsMod = await import('../database/repositories.js');
    vi.spyOn(signalWeightsMod.signalWeightsRepo, 'get').mockResolvedValue({ weight: -1.0 } as any);

    const { DirectionMultiplierLearningService } = await import('./DirectionMultiplierLearningService.js');
    const svc = new DirectionMultiplierLearningService();
    await svc.evaluate();

    const sqlExecuted = querySpy.mock.calls.map(c => c[0] as string).join('\n');
    expect(sqlExecuted).toMatch(/COALESCE\s*\(\s*pp\.applied_direction_multiplier\s*,\s*dm\.weight\s*,\s*\$2\s*\)/i);
    querySpy.mockRestore();
    isDatabaseConfiguredSpy.mockRestore();
  });
});
