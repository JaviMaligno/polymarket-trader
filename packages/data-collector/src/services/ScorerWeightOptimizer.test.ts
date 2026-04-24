import { describe, it, expect } from 'vitest';
import { pearsonCorrelation, computeObjective, MIN_TRADES } from './ScorerWeightOptimizer.js';
import type { ScorerWeights } from './MarketScorer.js';

describe('pearsonCorrelation', () => {
  it('returns 1.0 for perfectly correlated series', () => {
    expect(pearsonCorrelation([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1.0);
  });

  it('returns -1.0 for perfectly inversely correlated series', () => {
    expect(pearsonCorrelation([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1.0);
  });

  it('returns 0 for constant series (no variance)', () => {
    expect(pearsonCorrelation([1, 1, 1], [1, 2, 3])).toBe(0);
  });

  it('returns 0 for empty arrays', () => {
    expect(pearsonCorrelation([], [])).toBe(0);
  });
});

describe('computeObjective', () => {
  const weights: ScorerWeights = {
    tradeability: 0.30, liquidity: 0.25, volatility: 0.20, ttr: 0.15, dataQuality: 0.10, typeExpectedValue: 0.20,
  };

  it('returns positive correlation when high-score trades have positive pnl', () => {
    const trades = [
      { dims: { tradeability: 1.0, liquidity: 0.8, ttr: 0.9, volatility: null, dataQuality: null, typeExpectedValue: 0.5 }, pnl: 10 },
      { dims: { tradeability: 0.1, liquidity: 0.1, ttr: 0.2, volatility: null, dataQuality: null, typeExpectedValue: 0.5 }, pnl: -5 },
      { dims: { tradeability: 0.8, liquidity: 0.7, ttr: 0.8, volatility: null, dataQuality: null, typeExpectedValue: 0.5 }, pnl: 7 },
    ];
    const result = computeObjective(weights, trades);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(1);
  });

  it('returns 0 when all pnl are identical (no variance)', () => {
    const trades = [
      { dims: { tradeability: 0.5, liquidity: 0.5, ttr: 0.5, volatility: null, dataQuality: null, typeExpectedValue: 0.5 }, pnl: 5 },
      { dims: { tradeability: 0.8, liquidity: 0.8, ttr: 0.8, volatility: null, dataQuality: null, typeExpectedValue: 0.5 }, pnl: 5 },
    ];
    expect(computeObjective(weights, trades)).toBe(0);
  });
});

describe('MIN_TRADES', () => {
  it('is 30', () => {
    expect(MIN_TRADES).toBe(30);
  });
});
