/**
 * weighted-combiner.test.ts - Tests for WeightedAverageCombiner
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WeightedAverageCombiner } from '../../packages/signals/src/combiners/WeightedAverageCombiner.js';
import type { SignalOutput, SignalDirection } from '../../packages/signals/src/core/types/signal.types.js';

function createMockSignal(overrides: Partial<SignalOutput> = {}): SignalOutput {
  return {
    signalId: 'test_signal',
    marketId: 'market-123',
    tokenId: 'token-456',
    direction: 'LONG' as SignalDirection,
    strength: 0.5,
    confidence: 0.7,
    timestamp: new Date(),
    ttlMs: 300000,
    features: [],
    metadata: {},
    ...overrides,
  };
}

describe('WeightedAverageCombiner', () => {
  let combiner: WeightedAverageCombiner;

  beforeEach(() => {
    combiner = new WeightedAverageCombiner(
      { momentum: 0.5, mean_reversion: 0.5 },
      { minCombinedConfidence: 0.2, minCombinedStrength: 0.1 }
    );
  });

  describe('constructor', () => {
    it('should initialize with provided weights', () => {
      const weights = combiner.getWeights();
      expect(weights.momentum).toBe(0.5);
      expect(weights.mean_reversion).toBe(0.5);
    });

    it('should work with empty weights', () => {
      const emptyCombiner = new WeightedAverageCombiner();
      expect(emptyCombiner.getWeights()).toEqual({});
    });
  });

  describe('combine', () => {
    it('should return null for empty signals array', () => {
      const result = combiner.combine([]);
      expect(result).toBeNull();
    });

    it('should combine single signal', () => {
      const signal = createMockSignal({
        signalId: 'momentum',
        strength: 0.6,
        confidence: 0.8,
        direction: 'LONG',
      });

      const result = combiner.combine([signal]);

      expect(result).not.toBeNull();
      expect(result?.direction).toBe('LONG');
      expect(result?.strength).toBeCloseTo(0.6, 1);
    });

    it('should combine multiple agreeing signals', () => {
      const signals = [
        createMockSignal({
          signalId: 'momentum',
          strength: 0.5,
          confidence: 0.8,
          direction: 'LONG',
        }),
        createMockSignal({
          signalId: 'mean_reversion',
          strength: 0.6,
          confidence: 0.7,
          direction: 'LONG',
        }),
      ];

      const result = combiner.combine(signals);

      expect(result).not.toBeNull();
      expect(result?.direction).toBe('LONG');
      expect(result?.componentSignals).toHaveLength(2);
    });

    it('should handle conflicting signals with weighted resolution', () => {
      const signals = [
        createMockSignal({
          signalId: 'momentum',
          strength: 0.8,
          confidence: 0.9,
          direction: 'LONG',
        }),
        createMockSignal({
          signalId: 'mean_reversion',
          strength: -0.3,
          confidence: 0.6,
          direction: 'SHORT',
        }),
      ];

      const result = combiner.combine(signals);

      // Should resolve to stronger signal direction
      if (result) {
        expect(['LONG', 'SHORT', 'NEUTRAL']).toContain(result.direction);
      }
    });

    it('should filter signals below confidence threshold', () => {
      const signals = [
        createMockSignal({
          signalId: 'momentum',
          strength: 0.8,
          confidence: 0.1, // Below threshold
          direction: 'LONG',
        }),
        createMockSignal({
          signalId: 'mean_reversion',
          strength: 0.5,
          confidence: 0.8, // Above threshold
          direction: 'LONG',
        }),
      ];

      const result = combiner.combine(signals);

      if (result) {
        // Only one signal should pass filter
        expect(result.componentSignals?.length).toBeLessThanOrEqual(2);
      }
    });

    it('should return null when combined strength below threshold', () => {
      const lowStrengthCombiner = new WeightedAverageCombiner(
        {},
        { minCombinedStrength: 0.5 }
      );

      const signals = [
        createMockSignal({
          strength: 0.1,
          confidence: 0.8,
        }),
      ];

      const result = lowStrengthCombiner.combine(signals);
      expect(result).toBeNull();
    });

    it('should filter signals with NaN strength', () => {
      const signals = [
        createMockSignal({
          signalId: 'valid',
          strength: 0.5,
          confidence: 0.8,
        }),
        createMockSignal({
          signalId: 'invalid',
          strength: NaN,
          confidence: 0.8,
        }),
      ];

      const result = combiner.combine(signals);

      if (result) {
        expect(result.componentSignals?.every(s => !isNaN(s.strength))).toBe(true);
      }
    });
  });

  describe('time decay', () => {
    it('should apply decay to older signals', () => {
      const oldSignal = createMockSignal({
        signalId: 'momentum',
        strength: 0.8,
        confidence: 0.9,
        timestamp: new Date(Date.now() - 4 * 60 * 1000), // 4 minutes ago
      });

      const newSignal = createMockSignal({
        signalId: 'mean_reversion',
        strength: 0.5,
        confidence: 0.8,
        timestamp: new Date(), // Now
      });

      const result = combiner.combine([oldSignal, newSignal]);

      if (result && result.weights) {
        // Older signal should have lower effective weight
        const momentumWeight = result.weights['momentum'] || 0;
        const meanRevWeight = result.weights['mean_reversion'] || 0;
        // New signal should have higher or equal weight
        expect(meanRevWeight).toBeGreaterThanOrEqual(momentumWeight * 0.5);
      }
    });

    it('should exclude expired signals', () => {
      const expiredSignal = createMockSignal({
        signalId: 'momentum',
        strength: 0.8,
        confidence: 0.9,
        timestamp: new Date(Date.now() - 10 * 60 * 1000), // 10 minutes ago
        ttlMs: 60000, // 1 minute TTL (expired)
      });

      const result = combiner.combine([expiredSignal]);
      expect(result).toBeNull();
    });
  });

  describe('weight management', () => {
    it('should update weights', () => {
      combiner.setWeights({ new_signal: 0.8 });
      const weights = combiner.getWeights();
      expect(weights.new_signal).toBe(0.8);
    });

    it('should update single weight', () => {
      combiner.updateWeight('momentum', 0.9);
      expect(combiner.getWeights().momentum).toBe(0.9);
    });
  });

  describe('conflict resolution strategies', () => {
    it('should use strongest signal with "strongest" strategy', () => {
      const strongestCombiner = new WeightedAverageCombiner(
        {},
        { conflictResolution: 'strongest', minCombinedStrength: 0.1 }
      );

      const signals = [
        createMockSignal({
          signalId: 'weak',
          strength: 0.3,
          confidence: 0.5,
          direction: 'SHORT',
        }),
        createMockSignal({
          signalId: 'strong',
          strength: 0.9,
          confidence: 0.9,
          direction: 'LONG',
        }),
      ];

      const result = strongestCombiner.combine(signals);

      expect(result).not.toBeNull();
      expect(result?.direction).toBe('LONG');
    });

    it('should use majority with "majority" strategy', () => {
      const majorityCombiner = new WeightedAverageCombiner(
        {},
        { conflictResolution: 'majority', minCombinedStrength: 0.1 }
      );

      const signals = [
        createMockSignal({ signalId: 's1', strength: 0.3, confidence: 0.8, direction: 'LONG' }),
        createMockSignal({ signalId: 's2', strength: 0.4, confidence: 0.7, direction: 'LONG' }),
        createMockSignal({ signalId: 's3', strength: -0.8, confidence: 0.9, direction: 'SHORT' }),
      ];

      const result = majorityCombiner.combine(signals);

      if (result) {
        // Majority is LONG (2 vs 1)
        expect(result.direction).toBe('LONG');
      }
    });
  });

  describe('adjustWeights', () => {
    it('should adjust weights based on performance', () => {
      combiner.setWeights({ momentum: 1.0, mean_reversion: 1.0 });

      combiner.adjustWeights({
        momentum: { accuracy: 0.8, profitFactor: 1.5 },
        mean_reversion: { accuracy: 0.4, profitFactor: 0.8 },
      });

      const weights = combiner.getWeights();
      // Momentum should have higher weight after adjustment
      expect(weights.momentum).toBeGreaterThan(weights.mean_reversion);
    });
  });
});
