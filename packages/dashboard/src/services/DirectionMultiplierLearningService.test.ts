import { describe, expect, it } from 'vitest';
import { deriveDirectionMultiplierPolicy, type DirectionLearningRow } from './DirectionMultiplierLearningService.js';

function repeat(row: DirectionLearningRow, count: number): DirectionLearningRow[] {
  return Array.from({ length: count }, () => ({ ...row }));
}

describe('DirectionMultiplierLearningService policy derivation', () => {
  it('creates a segment override when a bucket clearly beats the baseline', () => {
    const rows = [
      ...repeat({
        marketType: 'event_financial',
        priceBucket: '40to60',
        durationBand: 'medium',
        realizedPnl: 4,
        directionMultiplier: -1.2,
      }, 12),
      ...repeat({
        marketType: 'event_financial',
        priceBucket: '40to60',
        durationBand: 'medium',
        realizedPnl: -1,
        directionMultiplier: -0.7,
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
      maxMultiplier: 0.1,
      maxPositiveMultiplier: 0.1,
    });

    expect(policy.segments).toHaveLength(1);
    expect(policy.segments[0].id).toBe('event_financial-40to60-medium');
    expect(policy.segments[0].multiplier).toBeLessThan(-1.1);
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
      maxMultiplier: 0.1,
      maxPositiveMultiplier: 0.1,
    });

    expect(policy.segments).toHaveLength(0);
  });
});
