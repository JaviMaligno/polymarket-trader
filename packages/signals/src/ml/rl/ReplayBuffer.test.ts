/**
 * Replay Buffer Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ReplayBuffer } from './ReplayBuffer.js';
import type { Experience, RLState } from './types.js';

describe('ReplayBuffer', () => {
  let buffer: ReplayBuffer;

  const createMockState = (position: number = 0): RLState => ({
    orderBook: [0.5, 100, 0.51, 100],
    position,
    unrealizedPnL: 0,
    priceHistory: [0.5, 0.51, 0.50],
    ofi: 0,
    volatility: 0.02,
    timeToResolution: 24,
    regime: [1, 0, 0],
    inventoryRisk: 0,
  });

  const createExperience = (idx: number): Experience => ({
    state: createMockState(idx),
    action: idx % 5,
    reward: idx * 0.1,
    nextState: createMockState(idx + 1),
    done: false,
  });

  beforeEach(() => {
    buffer = new ReplayBuffer({ capacity: 100, usePER: false });
  });

  describe('add and size', () => {
    it('should start empty', () => {
      expect(buffer.size()).toBe(0);
    });

    it('should increase size when adding experiences', () => {
      buffer.add(createExperience(0));
      expect(buffer.size()).toBe(1);

      buffer.add(createExperience(1));
      expect(buffer.size()).toBe(2);
    });

    it('should not exceed capacity', () => {
      const smallBuffer = new ReplayBuffer({ capacity: 5, usePER: false });

      for (let i = 0; i < 10; i++) {
        smallBuffer.add(createExperience(i));
      }

      expect(smallBuffer.size()).toBe(5);
    });
  });

  describe('canSample', () => {
    it('should return false when buffer is too small', () => {
      buffer.add(createExperience(0));
      expect(buffer.canSample(5)).toBe(false);
    });

    it('should return true when buffer has enough samples', () => {
      for (let i = 0; i < 10; i++) {
        buffer.add(createExperience(i));
      }
      expect(buffer.canSample(5)).toBe(true);
    });
  });

  describe('sample', () => {
    beforeEach(() => {
      for (let i = 0; i < 20; i++) {
        buffer.add(createExperience(i));
      }
    });

    it('should return batch of correct size', () => {
      const { batch, indices, weights } = buffer.sample(5);

      expect(batch.states).toHaveLength(5);
      expect(batch.actions).toHaveLength(5);
      expect(batch.rewards).toHaveLength(5);
      expect(batch.nextStates).toHaveLength(5);
      expect(batch.dones).toHaveLength(5);
      expect(indices).toHaveLength(5);
      expect(weights).toHaveLength(5);
    });

    it('should return uniform weights without PER', () => {
      const { weights } = buffer.sample(5);

      weights.forEach(w => {
        expect(w).toBe(1.0);
      });
    });

    it('should return valid experiences', () => {
      const { batch } = buffer.sample(5);

      batch.states.forEach(state => {
        expect(state.orderBook).toBeDefined();
        expect(typeof state.position).toBe('number');
      });

      batch.rewards.forEach(reward => {
        expect(typeof reward).toBe('number');
      });
    });
  });

  describe('clear', () => {
    it('should empty the buffer', () => {
      for (let i = 0; i < 10; i++) {
        buffer.add(createExperience(i));
      }

      expect(buffer.size()).toBe(10);
      buffer.clear();
      expect(buffer.size()).toBe(0);
    });
  });

  describe('getAll', () => {
    it('should return all experiences', () => {
      for (let i = 0; i < 5; i++) {
        buffer.add(createExperience(i));
      }

      const all = buffer.getAll();
      expect(all).toHaveLength(5);
    });
  });

  describe('circular buffer behavior', () => {
    it('should overwrite oldest experiences when full', () => {
      const smallBuffer = new ReplayBuffer({ capacity: 3, usePER: false });

      // Add 5 experiences to a buffer of size 3
      for (let i = 0; i < 5; i++) {
        smallBuffer.add(createExperience(i));
      }

      const all = smallBuffer.getAll();
      expect(all).toHaveLength(3);

      // The newest experiences should be present
      // Due to circular buffer, we should have experiences 2, 3, 4
      const rewards = all.map(e => Math.round(e.reward * 10) / 10); // Round to avoid floating point issues
      expect(rewards).toContain(0.2); // idx 2
      expect(rewards).toContain(0.3); // idx 3
      expect(rewards).toContain(0.4); // idx 4
    });
  });
});

describe('ReplayBuffer with PER', () => {
  let buffer: ReplayBuffer;

  const createMockState = (position: number = 0): RLState => ({
    orderBook: [0.5, 100, 0.51, 100],
    position,
    unrealizedPnL: 0,
    priceHistory: [0.5, 0.51, 0.50],
    ofi: 0,
    volatility: 0.02,
    timeToResolution: 24,
    regime: [1, 0, 0],
    inventoryRisk: 0,
  });

  const createExperience = (idx: number): Experience => ({
    state: createMockState(idx),
    action: idx % 5,
    reward: idx * 0.1,
    nextState: createMockState(idx + 1),
    done: false,
  });

  beforeEach(() => {
    buffer = new ReplayBuffer({ capacity: 100, usePER: true, alpha: 0.6 });
  });

  it('should work with PER enabled', () => {
    for (let i = 0; i < 20; i++) {
      buffer.add(createExperience(i));
    }

    const { batch, indices, weights } = buffer.sample(5);

    expect(batch.states).toHaveLength(5);
    expect(indices).toHaveLength(5);

    // With PER, weights should vary
    weights.forEach(w => {
      expect(w).toBeGreaterThan(0);
      expect(w).toBeLessThanOrEqual(1);
    });
  });

  it('should update priorities', () => {
    for (let i = 0; i < 10; i++) {
      buffer.add(createExperience(i));
    }

    const { indices } = buffer.sample(5);
    const tdErrors = [1.0, 0.5, 0.1, 0.8, 0.3];

    // Should not throw
    buffer.updatePriorities(indices, tdErrors);
  });
});
