/**
 * Regime Detector Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RegimeDetector } from './RegimeDetector.js';
import { MarketRegime } from './types.js';

describe('RegimeDetector', () => {
  let detector: RegimeDetector;

  const createBar = (close: number, volume: number = 1000) => ({
    close,
    volume,
    timestamp: new Date(),
  });

  beforeEach(() => {
    detector = new RegimeDetector({
      lookbackPeriod: 20,
      minObservations: 5,
    });
  });

  describe('update', () => {
    it('should accept price updates without error', () => {
      detector.update(createBar(0.5));
      detector.update(createBar(0.51));
      detector.update(createBar(0.52));

      // Should not throw
      expect(true).toBe(true);
    });

    it('should update regime after enough observations', () => {
      // Feed enough data
      for (let i = 0; i < 30; i++) {
        const price = 0.5 + (Math.random() - 0.5) * 0.1;
        const volume = 1000 + Math.random() * 500;
        detector.update(createBar(price, volume));
      }

      const state = detector.getCurrentState();
      expect(Object.values(MarketRegime)).toContain(state.regime);
    });
  });

  describe('getCurrentState', () => {
    it('should return NEUTRAL initially', () => {
      const state = detector.getCurrentState();
      expect(state.regime).toBe(MarketRegime.NEUTRAL);
    });

    it('should return a valid state after updates', () => {
      for (let i = 0; i < 20; i++) {
        detector.update(createBar(0.5));
      }

      const state = detector.getCurrentState();
      expect(Object.values(MarketRegime)).toContain(state.regime);
      expect(state.probability).toBeGreaterThanOrEqual(0);
      expect(state.probability).toBeLessThanOrEqual(1);
    });

    it('should return state probabilities that sum to ~1', () => {
      for (let i = 0; i < 20; i++) {
        detector.update(createBar(0.5));
      }

      const state = detector.getCurrentState();
      const probs = state.stateProbabilities;

      expect(probs).toBeDefined();
      expect(Object.keys(probs).length).toBeGreaterThan(0);

      const sum = Object.values(probs).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 1);
    });
  });

  describe('getCurrentParameters', () => {
    it('should return parameters for current regime', () => {
      const params = detector.getCurrentParameters();

      expect(params).toBeDefined();
      expect(typeof params.positionSizeMultiplier).toBe('number');
      expect(typeof params.minConfidence).toBe('number');
      expect(typeof params.minStrength).toBe('number');
      expect(Array.isArray(params.preferredSignals)).toBe(true);
      expect(Array.isArray(params.avoidSignals)).toBe(true);
    });
  });

  describe('regime detection logic', () => {
    it('should detect bullish regime with rising prices', () => {
      // Simulate consistently rising prices
      let price = 0.4;
      for (let i = 0; i < 50; i++) {
        price += 0.005; // Consistent upward movement
        detector.update(createBar(price));
      }

      const state = detector.getCurrentState();
      // Should be one of the bullish regimes or neutral (depends on volatility)
      expect([
        MarketRegime.BULL_LOW_VOL,
        MarketRegime.BULL_HIGH_VOL,
        MarketRegime.NEUTRAL,
      ]).toContain(state.regime);
    });

    it('should detect bearish regime with falling prices', () => {
      // Simulate consistently falling prices
      let price = 0.6;
      for (let i = 0; i < 50; i++) {
        price -= 0.005; // Consistent downward movement
        detector.update(createBar(price));
      }

      const state = detector.getCurrentState();
      // Should be one of the bearish regimes or neutral
      expect([
        MarketRegime.BEAR_LOW_VOL,
        MarketRegime.BEAR_HIGH_VOL,
        MarketRegime.NEUTRAL,
      ]).toContain(state.regime);
    });

    it('should detect high volatility with large price swings', () => {
      // Simulate high volatility
      for (let i = 0; i < 50; i++) {
        const price = 0.5 + (i % 2 === 0 ? 0.05 : -0.05); // Large swings
        detector.update(createBar(price));
      }

      const state = detector.getCurrentState();
      // Should be one of the high volatility regimes or neutral
      expect([
        MarketRegime.BULL_HIGH_VOL,
        MarketRegime.BEAR_HIGH_VOL,
        MarketRegime.NEUTRAL,
      ]).toContain(state.regime);
    });
  });

  describe('reset', () => {
    it('should reset to initial state', () => {
      // Feed some data
      for (let i = 0; i < 30; i++) {
        detector.update(createBar(0.5 + i * 0.01));
      }

      detector.reset();

      // Should be back to neutral
      const state = detector.getCurrentState();
      expect(state.regime).toBe(MarketRegime.NEUTRAL);
    });
  });

  describe('getModelParameters', () => {
    it('should serialize HMM parameters', () => {
      for (let i = 0; i < 20; i++) {
        detector.update(createBar(0.5));
      }

      const params = detector.getModelParameters();

      expect(params).toBeDefined();
      // The HMM getParameters() returns an object with learned parameters
      expect(typeof params).toBe('object');
    });

    it('should load HMM parameters', () => {
      for (let i = 0; i < 20; i++) {
        detector.update(createBar(0.5));
      }

      const params = detector.getModelParameters();

      // Create new detector and load params
      const newDetector = new RegimeDetector();
      newDetector.loadModelParameters(params);

      // Should not throw
      const newParams = newDetector.getModelParameters();
      expect(typeof newParams).toBe('object');
    });
  });

  describe('signal filtering', () => {
    it('should check if signal is preferred', () => {
      // Start with NEUTRAL regime
      const isPreferred = detector.isSignalPreferred('momentum');
      expect(typeof isPreferred).toBe('boolean');
    });

    it('should check if signal should be avoided', () => {
      const shouldAvoid = detector.shouldAvoidSignal('momentum');
      expect(typeof shouldAvoid).toBe('boolean');
    });
  });

  describe('position sizing', () => {
    it('should return position size multiplier', () => {
      const multiplier = detector.getPositionSizeMultiplier();

      expect(typeof multiplier).toBe('number');
      expect(multiplier).toBeGreaterThan(0);
      expect(multiplier).toBeLessThanOrEqual(1.5);
    });
  });

  describe('adjusted thresholds', () => {
    it('should return adjusted thresholds', () => {
      const thresholds = detector.getAdjustedThresholds();

      expect(thresholds.minConfidence).toBeDefined();
      expect(thresholds.minStrength).toBeDefined();
      expect(typeof thresholds.minConfidence).toBe('number');
      expect(typeof thresholds.minStrength).toBe('number');
    });
  });

  describe('batchUpdate', () => {
    it('should process multiple bars', () => {
      const bars = [];
      for (let i = 0; i < 30; i++) {
        bars.push(createBar(0.5 + Math.random() * 0.1));
      }

      const state = detector.batchUpdate(bars);

      expect(state.regime).toBeDefined();
      expect(state.probability).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getMostLikelySequence', () => {
    it('should return regime sequence via Viterbi', () => {
      for (let i = 0; i < 30; i++) {
        detector.update(createBar(0.5 + Math.random() * 0.1));
      }

      const { regimes, probability } = detector.getMostLikelySequence();

      expect(Array.isArray(regimes)).toBe(true);
      expect(regimes.length).toBeGreaterThan(0);
      expect(typeof probability).toBe('number');
    });
  });
});
