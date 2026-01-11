/**
 * DQN Agent Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DQNAgent } from './DQNAgent.js';
import type { RLState, Experience } from './types.js';

describe('DQNAgent', () => {
  let agent: DQNAgent;

  // State vector: orderBook(8) + position(1) + unrealizedPnL(1) + priceHistory(5) + ofi(1) + volatility(1) + timeToResolution(1) + regime(3) + inventoryRisk(1) = 22
  const createMockState = (overrides: Partial<RLState> = {}): RLState => ({
    orderBook: [0.5, 100, 0.51, 100, 0.49, 50, 0.52, 50], // 8
    position: 0,
    unrealizedPnL: 0,
    priceHistory: [0.5, 0.51, 0.50, 0.49, 0.50], // 5
    ofi: 0,
    volatility: 0.02,
    timeToResolution: 24,
    regime: [1, 0, 0], // 3
    inventoryRisk: 0,
    ...overrides,
  });

  beforeEach(() => {
    // stateDim must match the total elements in the state vector: 8 + 1 + 1 + 5 + 1 + 1 + 1 + 3 + 1 = 22
    agent = new DQNAgent({
      stateDim: 22,
      actionDim: 5,
      hiddenLayers: [32, 16],
      learningRate: 0.001,
      gamma: 0.99,
      epsilon: 1.0,
      epsilonMin: 0.01,
      epsilonDecay: 0.995,
      batchSize: 4,
      targetUpdateFreq: 10,
    });
  });

  describe('selectAction', () => {
    it('should return a valid action index', () => {
      const state = createMockState();
      const action = agent.selectAction(state, false);

      expect(action).toBeGreaterThanOrEqual(0);
      expect(action).toBeLessThan(5);
    });

    it('should explore when epsilon is high during training', () => {
      agent.setEpsilon(1.0);
      const state = createMockState();

      // With epsilon=1, should always explore (random)
      const actions = new Set<number>();
      for (let i = 0; i < 100; i++) {
        actions.add(agent.selectAction(state, true));
      }

      // Should see multiple different actions due to exploration
      expect(actions.size).toBeGreaterThan(1);
    });

    it('should exploit when not training', () => {
      const state = createMockState();

      // When not training, should be deterministic
      const action1 = agent.selectAction(state, false);
      const action2 = agent.selectAction(state, false);

      expect(action1).toBe(action2);
    });
  });

  describe('getQValues', () => {
    it('should return Q-values for all actions', () => {
      const state = createMockState();
      const qValues = agent.getQValues(state);

      expect(qValues).toHaveLength(5);
      qValues.forEach(q => {
        expect(typeof q).toBe('number');
        expect(isNaN(q)).toBe(false);
        expect(isFinite(q)).toBe(true);
      });
    });
  });

  describe('remember', () => {
    it('should add experience to replay buffer', () => {
      const state = createMockState();
      const nextState = createMockState({ position: 10 });

      const experience: Experience = {
        state,
        action: 1,
        reward: 0.5,
        nextState,
        done: false,
      };

      expect(agent.getBufferSize()).toBe(0);
      agent.remember(experience);
      expect(agent.getBufferSize()).toBe(1);
    });
  });

  describe('train', () => {
    it('should return null when buffer is too small', () => {
      const result = agent.train();
      expect(result).toBeNull();
    });

    it('should train and return loss/avgQ when buffer has enough samples', () => {
      const state = createMockState();

      // Add enough experiences
      for (let i = 0; i < 10; i++) {
        const nextState = createMockState({ position: i });
        agent.remember({
          state,
          action: i % 5,
          reward: Math.random() - 0.5,
          nextState,
          done: i === 9,
        });
      }

      const result = agent.train();

      expect(result).not.toBeNull();
      expect(result!.loss).toBeGreaterThanOrEqual(0);
      expect(typeof result!.avgQ).toBe('number');
      expect(isNaN(result!.avgQ)).toBe(false);
    });
  });

  describe('save/load', () => {
    it('should save and restore model state', () => {
      const state = createMockState();

      // Get initial Q-values
      const qBefore = agent.getQValues(state);

      // Save
      const saved = agent.save();

      expect(saved.weights).toBeDefined();
      expect(saved.biases).toBeDefined();
      expect(saved.config).toBeDefined();
      expect(saved.epsilon).toBeDefined();

      // Create new agent and load
      const newAgent = new DQNAgent(saved.config);
      newAgent.load(saved);

      // Q-values should match
      const qAfter = newAgent.getQValues(state);

      for (let i = 0; i < qBefore.length; i++) {
        expect(qAfter[i]).toBeCloseTo(qBefore[i], 10);
      }
    });
  });

  describe('epsilon decay', () => {
    it('should decay epsilon after training', () => {
      const state = createMockState();

      // Add enough experiences
      for (let i = 0; i < 10; i++) {
        agent.remember({
          state,
          action: i % 5,
          reward: 0.1,
          nextState: state,
          done: false,
        });
      }

      const epsilonBefore = agent.getEpsilon();
      agent.train();
      const epsilonAfter = agent.getEpsilon();

      expect(epsilonAfter).toBeLessThan(epsilonBefore);
    });
  });
});
