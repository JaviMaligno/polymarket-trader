/**
 * Tests for MultiObjectiveEvaluator
 */

import { describe, it, expect } from 'vitest';
import {
  MultiObjectiveEvaluator,
  createMultiObjectiveEvaluator,
  DEFAULT_OBJECTIVES,
  DEFAULT_CONSTRAINTS,
  CONSERVATIVE_CONSTRAINTS,
} from './MultiObjective.js';
import type { BacktestMetrics } from './ObjectiveFunctions.js';

// ============================================
// Helpers
// ============================================

function makeMetrics(overrides: Partial<BacktestMetrics> = {}): BacktestMetrics {
  return {
    totalReturn: 0.15,
    sharpeRatio: 1.5,
    maxDrawdown: -0.10,
    winRate: 0.55,
    profitFactor: 1.8,
    totalTrades: 50,
    averageTradeReturn: 0.005,
    volatility: 0.10,
    calmarRatio: 3.0,
    sortinoRatio: 2.0,
    ...overrides,
  };
}

// ============================================
// Tests
// ============================================

describe('MultiObjectiveEvaluator', () => {
  describe('creation', () => {
    it('should create with default config', () => {
      const evaluator = createMultiObjectiveEvaluator();
      expect(evaluator).toBeInstanceOf(MultiObjectiveEvaluator);
    });

    it('should normalize weights that do not sum to 1', () => {
      const evaluator = createMultiObjectiveEvaluator({
        objectives: [
          { metric: 'sharpeRatio', weight: 2 },
          { metric: 'totalReturn', weight: 3 },
        ],
      });
      expect(evaluator).toBeInstanceOf(MultiObjectiveEvaluator);
    });

    it('should export default presets', () => {
      expect(DEFAULT_OBJECTIVES.length).toBeGreaterThan(0);
      expect(DEFAULT_CONSTRAINTS.length).toBeGreaterThan(0);
      expect(CONSERVATIVE_CONSTRAINTS.length).toBeGreaterThan(0);
    });
  });

  describe('evaluate', () => {
    it('should reject results with insufficient trades', () => {
      const evaluator = createMultiObjectiveEvaluator();
      const metrics = makeMetrics({ totalTrades: 3 });

      const result = evaluator.evaluate(metrics, 10);

      expect(result.score).toBe(-1000);
      expect(result.wasPenalized).toBe(true);
    });

    it('should return positive score for good metrics', () => {
      const evaluator = createMultiObjectiveEvaluator({
        constraints: [], // No constraints for simplicity
        normalization: 'none',
      });

      const metrics = makeMetrics({
        sharpeRatio: 2.0,
        totalReturn: 0.20,
        winRate: 0.60,
        profitFactor: 2.0,
      });

      const result = evaluator.evaluate(metrics);

      expect(result.score).toBeGreaterThan(0);
      expect(result.allConstraintsMet).toBe(true);
      expect(result.wasPenalized).toBe(false);
      expect(Object.keys(result.objectiveScores).length).toBeGreaterThan(0);
    });

    it('should reject hard constraint violations', () => {
      const evaluator = createMultiObjectiveEvaluator({
        constraints: [
          // maxDrawdown is stored as negative (e.g., -0.25 = 25% drawdown)
          // Use 'min' constraint: drawdown must not be worse than -0.15
          { metric: 'maxDrawdown', type: 'min', value: -0.15, hard: true },
        ],
      });

      // Drawdown of -0.25 violates the min constraint of -0.15
      const metrics = makeMetrics({ maxDrawdown: -0.25 });

      const result = evaluator.evaluate(metrics);

      expect(result.score).toBeLessThan(-100);
      expect(result.allConstraintsMet).toBe(false);
      expect(result.wasPenalized).toBe(true);
    });

    it('should penalize but not reject soft constraint violations', () => {
      const evaluator = createMultiObjectiveEvaluator({
        constraints: [
          { metric: 'winRate', type: 'min', value: 0.50, hard: false, penaltyWeight: 5 },
        ],
        normalization: 'none',
      });

      const goodMetrics = makeMetrics({ winRate: 0.60 });
      const badMetrics = makeMetrics({ winRate: 0.40 });

      const goodResult = evaluator.evaluate(goodMetrics);
      const badResult = evaluator.evaluate(badMetrics);

      // Bad should have lower score due to soft penalty
      expect(goodResult.score).toBeGreaterThan(badResult.score);
      expect(badResult.constraintResults.some(c => !c.satisfied)).toBe(true);
      expect(badResult.wasPenalized).toBe(true);
    });

    it('should handle range constraints', () => {
      const evaluator = createMultiObjectiveEvaluator({
        constraints: [
          { metric: 'winRate', type: 'range', value: [0.40, 0.70], hard: true },
        ],
      });

      const inRange = makeMetrics({ winRate: 0.55 });
      const outOfRange = makeMetrics({ winRate: 0.80 });

      const inResult = evaluator.evaluate(inRange);
      const outResult = evaluator.evaluate(outOfRange);

      expect(inResult.constraintResults[0].satisfied).toBe(true);
      expect(outResult.constraintResults[0].satisfied).toBe(false);
    });

    it('should prefer higher Sharpe with default objectives', () => {
      const evaluator = createMultiObjectiveEvaluator({
        constraints: [],
        normalization: 'none',
      });

      const highSharpe = makeMetrics({ sharpeRatio: 3.0 });
      const lowSharpe = makeMetrics({ sharpeRatio: 0.5 });

      const highResult = evaluator.evaluate(highSharpe);
      const lowResult = evaluator.evaluate(lowSharpe);

      expect(highResult.score).toBeGreaterThan(lowResult.score);
    });
  });

  describe('reset', () => {
    it('should reset normalization history', () => {
      const evaluator = createMultiObjectiveEvaluator();

      // Add some history
      evaluator.evaluate(makeMetrics());
      evaluator.evaluate(makeMetrics({ sharpeRatio: 3.0 }));

      // Reset and verify no error
      evaluator.reset();

      const result = evaluator.evaluate(makeMetrics());
      expect(result.score).toBeDefined();
    });
  });
});
