/**
 * Environment Tests
 *
 * Tests for MarketMakingEnvironment - RL environment for market making simulation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MarketMakingEnvironment } from './Environment.js';
import { DiscreteAction } from './types.js';

describe('MarketMakingEnvironment', () => {
  let env: MarketMakingEnvironment;

  beforeEach(() => {
    env = new MarketMakingEnvironment({
      maxPosition: 100,
      inventoryPenalty: 0.001,
      makerFee: 0.001,
      takerFee: 0.002,
      episodeLength: 100,
      tickSize: 0.01,
      riskAversion: 0.1,
      orderBookDepth: 5,
      priceHistoryLength: 10,
      rewardScale: 1.0,
    });
  });

  describe('reset', () => {
    it('should return a valid initial state', () => {
      const state = env.reset();

      expect(state.orderBook).toBeDefined();
      expect(state.orderBook.length).toBeGreaterThan(0);
      expect(state.position).toBe(0);
      expect(state.unrealizedPnL).toBe(0);
      expect(state.priceHistory).toBeDefined();
      expect(state.priceHistory.length).toBeGreaterThan(0);
      expect(typeof state.ofi).toBe('number');
      expect(typeof state.volatility).toBe('number');
      expect(typeof state.timeToResolution).toBe('number');
      expect(state.regime).toBeDefined();
      expect(typeof state.inventoryRisk).toBe('number');
    });
  });

  describe('step', () => {
    beforeEach(() => {
      env.reset();
    });

    it('should return valid step result', () => {
      const result = env.step(DiscreteAction.HOLD);

      expect(result.state).toBeDefined();
      expect(typeof result.reward).toBe('number');
      expect(typeof result.done).toBe('boolean');
      expect(result.info).toBeDefined();
    });

    it('should end episode after episodeLength steps', () => {
      env.reset();

      let done = false;
      for (let i = 0; i < 150 && !done; i++) {
        const result = env.step(DiscreteAction.HOLD);
        done = result.done;
      }

      expect(done).toBe(true);
    });
  });

  describe('action interpretation', () => {
    beforeEach(() => {
      env.reset();
    });

    it('should handle HOLD action', () => {
      const result = env.step(DiscreteAction.HOLD);
      expect(result.state).toBeDefined();
      expect(typeof result.reward).toBe('number');
    });

    it('should handle TIGHT_SMALL action without error', () => {
      const result = env.step(DiscreteAction.TIGHT_SMALL);
      expect(result.state).toBeDefined();
      expect(isNaN(result.reward)).toBe(false);
      expect(isFinite(result.reward)).toBe(true);
    });

    it('should handle TIGHT_MEDIUM action without error', () => {
      const result = env.step(DiscreteAction.TIGHT_MEDIUM);
      expect(result.state).toBeDefined();
      expect(isNaN(result.reward)).toBe(false);
      expect(isFinite(result.reward)).toBe(true);
    });

    it('should handle WIDE_SMALL action without error', () => {
      const result = env.step(DiscreteAction.WIDE_SMALL);
      expect(result.state).toBeDefined();
      expect(isNaN(result.reward)).toBe(false);
      expect(isFinite(result.reward)).toBe(true);
    });

    it('should handle CANCEL_ALL action without error', () => {
      const result = env.step(DiscreteAction.CANCEL_ALL);
      expect(result.state).toBeDefined();
      expect(isNaN(result.reward)).toBe(false);
      expect(isFinite(result.reward)).toBe(true);
    });
  });

  describe('state validity', () => {
    it('should always return valid numbers in state', () => {
      env.reset();

      for (let i = 0; i < 50; i++) {
        const action = i % 5 as DiscreteAction;
        const { state } = env.step(action);

        // Check orderBook
        state.orderBook.forEach(val => {
          expect(typeof val).toBe('number');
          expect(isNaN(val)).toBe(false);
        });

        // Check scalar values
        expect(isNaN(state.position)).toBe(false);
        expect(isNaN(state.unrealizedPnL)).toBe(false);
        expect(isNaN(state.ofi)).toBe(false);
        expect(isNaN(state.volatility)).toBe(false);
        expect(isNaN(state.inventoryRisk)).toBe(false);

        // Check arrays
        state.priceHistory.forEach(val => {
          expect(typeof val).toBe('number');
          expect(isNaN(val)).toBe(false);
        });

        state.regime.forEach(val => {
          expect(typeof val).toBe('number');
          expect(isNaN(val)).toBe(false);
        });
      }
    });
  });

  describe('reward validity', () => {
    it('should always return valid reward', () => {
      env.reset();

      for (let i = 0; i < 50; i++) {
        const action = i % 5 as DiscreteAction;
        const { reward } = env.step(action);

        expect(typeof reward).toBe('number');
        expect(isNaN(reward)).toBe(false);
        expect(isFinite(reward)).toBe(true);
      }
    });
  });
});
