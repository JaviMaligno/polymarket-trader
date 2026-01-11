/**
 * Reinforcement Learning Module
 *
 * RL-based market making components:
 * - DQN Agent for learning optimal quoting strategies
 * - Market Making Environment for training
 * - Replay Buffer with PER support
 */

// Types
export * from './types.js';

// Core components
export { DQNAgent } from './DQNAgent.js';
export {
  MarketMakingEnvironment,
  type OrderBookSnapshot,
  type MarketTick,
  type StepResult,
} from './Environment.js';
export {
  ReplayBuffer,
  type ReplayBufferConfig,
  DEFAULT_BUFFER_CONFIG,
} from './ReplayBuffer.js';

// Main interface
export {
  RLMarketMaker,
  type RLMarketMakerConfig,
  type TrainingCallback,
  type TrainingResult,
  DEFAULT_RL_CONFIG,
} from './RLMarketMaker.js';
