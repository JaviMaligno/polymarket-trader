import { describe, it, expect } from 'vitest';
import { computePrior, MIN_CATEGORY_TRADES } from './MarketPerformanceTracker.js';

describe('computePrior', () => {
  it('returns 1.0 for sharpe = 0 (neutral)', () => {
    expect(computePrior(0)).toBeCloseTo(1.0);
  });

  it('returns ~0.5 for very negative sharpe', () => {
    expect(computePrior(-10)).toBeCloseTo(0.5, 1);
  });

  it('returns ~1.5 for very positive sharpe', () => {
    expect(computePrior(10)).toBeCloseTo(1.5, 1);
  });

  it('is bounded to [0.5, 1.5]', () => {
    expect(computePrior(-100)).toBeGreaterThanOrEqual(0.5);
    expect(computePrior(100)).toBeLessThanOrEqual(1.5);
  });

  it('is monotonically increasing', () => {
    expect(computePrior(-1)).toBeLessThan(computePrior(0));
    expect(computePrior(0)).toBeLessThan(computePrior(1));
  });
});

describe('MIN_CATEGORY_TRADES', () => {
  it('is 5', () => {
    expect(MIN_CATEGORY_TRADES).toBe(5);
  });
});
