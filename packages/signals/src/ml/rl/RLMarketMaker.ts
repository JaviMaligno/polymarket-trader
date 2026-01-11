/**
 * RL Market Maker
 *
 * Main class that combines the DQN agent with the market making environment.
 * Provides training, evaluation, and live trading interfaces.
 */

import type {
  RLState,
  RLAction,
  AgentConfig,
  EnvironmentConfig,
  MarketMakerMetrics,
  ModelCheckpoint,
  Experience,
} from './types.js';
import { DEFAULT_AGENT_CONFIG, DEFAULT_ENV_CONFIG, DiscreteAction } from './types.js';
import { DQNAgent } from './DQNAgent.js';
import {
  MarketMakingEnvironment,
  type OrderBookSnapshot,
  type MarketTick,
  type StepResult,
} from './Environment.js';
import type { ReplayBufferConfig } from './ReplayBuffer.js';

/**
 * Training callback
 */
export type TrainingCallback = (
  episode: number,
  reward: number,
  metrics: Partial<MarketMakerMetrics>
) => void;

/**
 * RL Market Maker configuration
 */
export interface RLMarketMakerConfig {
  agent: Partial<AgentConfig>;
  environment: Partial<EnvironmentConfig>;
  buffer: Partial<ReplayBufferConfig>;
  /** Number of steps to warm up before training */
  warmupSteps: number;
  /** Train every N steps */
  trainFrequency: number;
  /** Save checkpoint every N episodes */
  checkpointFrequency: number;
  /** Maximum episodes to train */
  maxEpisodes: number;
  /** Early stopping if reward doesn't improve for N episodes */
  earlyStopPatience: number;
}

/** Default RL Market Maker configuration */
export const DEFAULT_RL_CONFIG: RLMarketMakerConfig = {
  agent: {},
  environment: {},
  buffer: {},
  warmupSteps: 1000,
  trainFrequency: 4,
  checkpointFrequency: 100,
  maxEpisodes: 10000,
  earlyStopPatience: 200,
};

/**
 * Training result
 */
export interface TrainingResult {
  episodes: number;
  totalSteps: number;
  finalMetrics: MarketMakerMetrics;
  bestMetrics: MarketMakerMetrics;
  rewardHistory: number[];
  lossHistory: number[];
}

/**
 * RL Market Maker
 *
 * Combines DQN agent with market making environment for training
 * and live trading.
 */
export class RLMarketMaker {
  private config: RLMarketMakerConfig;
  private agent: DQNAgent;
  private environment: MarketMakingEnvironment;
  private checkpoints: ModelCheckpoint[];
  private bestReward: number;
  private rewardHistory: number[];
  private lossHistory: number[];
  private totalSteps: number;

  constructor(config: Partial<RLMarketMakerConfig> = {}) {
    this.config = { ...DEFAULT_RL_CONFIG, ...config };

    // Initialize agent
    this.agent = new DQNAgent(this.config.agent, this.config.buffer);

    // Initialize environment
    this.environment = new MarketMakingEnvironment(this.config.environment);

    this.checkpoints = [];
    this.bestReward = -Infinity;
    this.rewardHistory = [];
    this.lossHistory = [];
    this.totalSteps = 0;
  }

  /**
   * Train the agent
   */
  async train(
    historicalData?: MarketTick[],
    callback?: TrainingCallback
  ): Promise<TrainingResult> {
    if (historicalData) {
      this.environment.loadHistoricalData(historicalData);
    }

    let bestMetrics: Partial<MarketMakerMetrics> = {};
    let noImprovementCount = 0;

    for (let episode = 0; episode < this.config.maxEpisodes; episode++) {
      const result = await this.runEpisode(true);
      this.rewardHistory.push(result.totalReward);

      // Check for improvement
      if (result.totalReward > this.bestReward) {
        this.bestReward = result.totalReward;
        bestMetrics = result.metrics;
        noImprovementCount = 0;

        // Save checkpoint
        if (episode % this.config.checkpointFrequency === 0) {
          this.saveCheckpoint(result.metrics);
        }
      } else {
        noImprovementCount++;
      }

      // Callback
      if (callback) {
        callback(episode, result.totalReward, result.metrics);
      }

      // Early stopping
      if (noImprovementCount >= this.config.earlyStopPatience) {
        console.log(`Early stopping at episode ${episode}`);
        break;
      }

      // Log progress
      if (episode % 100 === 0) {
        const avgReward =
          this.rewardHistory.slice(-100).reduce((a, b) => a + b, 0) / 100;
        console.log(
          `Episode ${episode}: Avg Reward = ${avgReward.toFixed(2)}, ` +
            `Epsilon = ${this.agent.getEpsilon().toFixed(3)}, ` +
            `Buffer = ${this.agent.getBufferSize()}`
        );
      }
    }

    return {
      episodes: this.rewardHistory.length,
      totalSteps: this.totalSteps,
      finalMetrics: this.environment.getMetrics() as MarketMakerMetrics,
      bestMetrics: bestMetrics as MarketMakerMetrics,
      rewardHistory: this.rewardHistory,
      lossHistory: this.lossHistory,
    };
  }

  /**
   * Run a single episode
   */
  private async runEpisode(training: boolean): Promise<{
    totalReward: number;
    steps: number;
    metrics: Partial<MarketMakerMetrics>;
  }> {
    let state = this.environment.reset();
    let totalReward = 0;
    let steps = 0;
    let done = false;

    while (!done) {
      // Select action
      const action = this.agent.selectAction(state, training);

      // Execute action
      const result = this.environment.step(action);

      // Store experience
      if (training) {
        const experience: Experience = {
          state,
          action,
          reward: result.reward,
          nextState: result.state,
          done: result.done,
        };
        this.agent.remember(experience);

        // Train
        if (
          this.totalSteps > this.config.warmupSteps &&
          this.totalSteps % this.config.trainFrequency === 0
        ) {
          const trainResult = this.agent.train();
          if (trainResult) {
            this.lossHistory.push(trainResult.loss);
          }
        }
      }

      // Update
      state = result.state;
      totalReward += result.reward;
      steps++;
      this.totalSteps++;
      done = result.done;
    }

    return {
      totalReward,
      steps,
      metrics: this.environment.getMetrics(),
    };
  }

  /**
   * Evaluate the agent (no exploration)
   */
  async evaluate(
    historicalData?: MarketTick[],
    episodes: number = 10
  ): Promise<{
    avgReward: number;
    avgPnL: number;
    avgSharpe: number;
    metrics: Partial<MarketMakerMetrics>;
  }> {
    if (historicalData) {
      this.environment.loadHistoricalData(historicalData);
    }

    const rewards: number[] = [];
    const pnls: number[] = [];
    const sharpes: number[] = [];
    let lastMetrics: Partial<MarketMakerMetrics> = {};

    // Save epsilon and set to 0 for evaluation
    const savedEpsilon = this.agent.getEpsilon();
    this.agent.setEpsilon(0);

    for (let i = 0; i < episodes; i++) {
      const result = await this.runEpisode(false);
      rewards.push(result.totalReward);
      pnls.push(result.metrics.totalPnL || 0);
      sharpes.push(result.metrics.sharpeRatio || 0);
      lastMetrics = result.metrics;
    }

    // Restore epsilon
    this.agent.setEpsilon(savedEpsilon);

    return {
      avgReward: rewards.reduce((a, b) => a + b, 0) / rewards.length,
      avgPnL: pnls.reduce((a, b) => a + b, 0) / pnls.length,
      avgSharpe: sharpes.reduce((a, b) => a + b, 0) / sharpes.length,
      metrics: lastMetrics,
    };
  }

  /**
   * Get action for live trading
   */
  getAction(state: RLState): {
    action: DiscreteAction;
    qValues: number[];
    confidence: number;
  } {
    const qValues = this.agent.getQValues(state);
    let bestAction = 0;
    let bestValue = qValues[0];

    for (let i = 1; i < qValues.length; i++) {
      if (qValues[i] > bestValue) {
        bestValue = qValues[i];
        bestAction = i;
      }
    }

    // Calculate confidence as softmax probability
    const expValues = qValues.map((q) => Math.exp(q - bestValue));
    const sumExp = expValues.reduce((a, b) => a + b, 0);
    const confidence = expValues[bestAction] / sumExp;

    return {
      action: bestAction as DiscreteAction,
      qValues,
      confidence,
    };
  }

  /**
   * Convert discrete action to trading parameters
   */
  actionToParams(
    action: DiscreteAction,
    midPrice: number,
    maxPosition: number
  ): {
    bidPrice: number | null;
    askPrice: number | null;
    bidSize: number;
    askSize: number;
    cancelAll: boolean;
  } {
    const params = {
      bidPrice: null as number | null,
      askPrice: null as number | null,
      bidSize: 0,
      askSize: 0,
      cancelAll: false,
    };

    switch (action) {
      case DiscreteAction.HOLD:
        break;

      case DiscreteAction.TIGHT_SMALL:
        params.bidPrice = midPrice * 0.99;
        params.askPrice = midPrice * 1.01;
        params.bidSize = maxPosition * 0.1;
        params.askSize = maxPosition * 0.1;
        break;

      case DiscreteAction.TIGHT_MEDIUM:
        params.bidPrice = midPrice * 0.99;
        params.askPrice = midPrice * 1.01;
        params.bidSize = maxPosition * 0.3;
        params.askSize = maxPosition * 0.3;
        break;

      case DiscreteAction.TIGHT_LARGE:
        params.bidPrice = midPrice * 0.99;
        params.askPrice = midPrice * 1.01;
        params.bidSize = maxPosition * 0.5;
        params.askSize = maxPosition * 0.5;
        break;

      case DiscreteAction.WIDE_SMALL:
        params.bidPrice = midPrice * 0.97;
        params.askPrice = midPrice * 1.03;
        params.bidSize = maxPosition * 0.1;
        params.askSize = maxPosition * 0.1;
        break;

      case DiscreteAction.WIDE_MEDIUM:
        params.bidPrice = midPrice * 0.97;
        params.askPrice = midPrice * 1.03;
        params.bidSize = maxPosition * 0.3;
        params.askSize = maxPosition * 0.3;
        break;

      case DiscreteAction.WIDE_LARGE:
        params.bidPrice = midPrice * 0.97;
        params.askPrice = midPrice * 1.03;
        params.bidSize = maxPosition * 0.5;
        params.askSize = maxPosition * 0.5;
        break;

      case DiscreteAction.CANCEL_ALL:
        params.cancelAll = true;
        break;

      case DiscreteAction.BUY_ONLY:
        params.bidPrice = midPrice * 0.98;
        params.bidSize = maxPosition * 0.3;
        break;

      case DiscreteAction.SELL_ONLY:
        params.askPrice = midPrice * 1.02;
        params.askSize = maxPosition * 0.3;
        break;
    }

    return params;
  }

  /**
   * Save checkpoint
   */
  private saveCheckpoint(metrics: Partial<MarketMakerMetrics>): void {
    const saved = this.agent.save();
    const checkpoint: ModelCheckpoint = {
      weights: saved.weights,
      config: saved.config,
      metrics: metrics as MarketMakerMetrics,
      epoch: this.rewardHistory.length,
      timestamp: new Date(),
    };
    this.checkpoints.push(checkpoint);

    // Keep only last 10 checkpoints
    if (this.checkpoints.length > 10) {
      this.checkpoints.shift();
    }
  }

  /**
   * Get best checkpoint
   */
  getBestCheckpoint(): ModelCheckpoint | null {
    if (this.checkpoints.length === 0) return null;

    return this.checkpoints.reduce((best, current) =>
      (current.metrics.totalPnL || 0) > (best.metrics.totalPnL || 0) ? current : best
    );
  }

  /**
   * Load checkpoint
   */
  loadCheckpoint(checkpoint: ModelCheckpoint): void {
    this.agent.load({ weights: checkpoint.weights });
  }

  /**
   * Export model
   */
  exportModel(): {
    weights: number[][][];
    config: AgentConfig;
    metrics: Partial<MarketMakerMetrics>;
  } {
    const saved = this.agent.save();
    return {
      weights: saved.weights,
      config: saved.config,
      metrics: this.environment.getMetrics(),
    };
  }

  /**
   * Import model
   */
  importModel(data: { weights: number[][][]; config?: AgentConfig }): void {
    this.agent.load(data);
  }

  /**
   * Get training stats
   */
  getStats(): {
    episodes: number;
    totalSteps: number;
    epsilon: number;
    bufferSize: number;
    avgReward100: number;
    avgLoss100: number;
  } {
    const recentRewards = this.rewardHistory.slice(-100);
    const recentLoss = this.lossHistory.slice(-100);

    return {
      episodes: this.rewardHistory.length,
      totalSteps: this.totalSteps,
      epsilon: this.agent.getEpsilon(),
      bufferSize: this.agent.getBufferSize(),
      avgReward100:
        recentRewards.length > 0
          ? recentRewards.reduce((a, b) => a + b, 0) / recentRewards.length
          : 0,
      avgLoss100:
        recentLoss.length > 0
          ? recentLoss.reduce((a, b) => a + b, 0) / recentLoss.length
          : 0,
    };
  }

  /**
   * Reset for new training run
   */
  reset(): void {
    this.agent = new DQNAgent(this.config.agent, this.config.buffer);
    this.checkpoints = [];
    this.bestReward = -Infinity;
    this.rewardHistory = [];
    this.lossHistory = [];
    this.totalSteps = 0;
  }
}
