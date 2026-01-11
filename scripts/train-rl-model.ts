/**
 * RL Model Training Script
 *
 * Trains a DQN agent on historical market data for market making.
 *
 * Usage:
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 npx tsx scripts/train-rl-model.ts
 *
 * Environment variables:
 *   DATABASE_URL - PostgreSQL connection string
 *   RL_EPISODES - Number of training episodes (default: 1000)
 *   RL_SAVE_PATH - Path to save trained model (default: ./rl-model.json)
 */

import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

// Types
interface PriceRow {
  time: Date;
  market_id: string;
  close: number;
  volume: number;
}

interface RLState {
  orderBook: number[];
  position: number;
  unrealizedPnL: number;
  priceHistory: number[];
  ofi: number;
  volatility: number;
  timeToResolution: number;
  regime: number[];
  inventoryRisk: number;
}

interface Experience {
  state: RLState;
  action: number;
  reward: number;
  nextState: RLState;
  done: boolean;
}

// Simple DQN implementation for training
class SimpleDQN {
  private weights: number[][][];
  private biases: number[][];
  private config: {
    stateDim: number;
    actionDim: number;
    hiddenLayers: number[];
    learningRate: number;
    gamma: number;
    epsilon: number;
    epsilonMin: number;
    epsilonDecay: number;
  };

  constructor(config: Partial<typeof SimpleDQN.prototype.config> = {}) {
    this.config = {
      stateDim: 22,
      actionDim: 10,
      hiddenLayers: [64, 32],
      learningRate: 0.001,
      gamma: 0.99,
      epsilon: 1.0,
      epsilonMin: 0.01,
      epsilonDecay: 0.995,
      ...config,
    };

    // Initialize weights
    this.weights = [];
    this.biases = [];

    const layers = [
      this.config.stateDim,
      ...this.config.hiddenLayers,
      this.config.actionDim,
    ];

    for (let i = 0; i < layers.length - 1; i++) {
      const inputSize = layers[i];
      const outputSize = layers[i + 1];

      // Xavier initialization
      const scale = Math.sqrt(2.0 / (inputSize + outputSize));
      const layerWeights: number[][] = [];
      const layerBias: number[] = [];

      for (let j = 0; j < outputSize; j++) {
        const neuronWeights: number[] = [];
        for (let k = 0; k < inputSize; k++) {
          neuronWeights.push((Math.random() * 2 - 1) * scale);
        }
        layerWeights.push(neuronWeights);
        layerBias.push(0);
      }

      this.weights.push(layerWeights);
      this.biases.push(layerBias);
    }
  }

  private relu(x: number): number {
    return Math.max(0, x);
  }

  private forward(state: number[]): number[] {
    let current = state;

    for (let i = 0; i < this.weights.length; i++) {
      const next: number[] = [];
      const isLastLayer = i === this.weights.length - 1;

      for (let j = 0; j < this.weights[i].length; j++) {
        let sum = this.biases[i][j];
        for (let k = 0; k < current.length; k++) {
          sum += current[k] * this.weights[i][j][k];
        }
        // ReLU for hidden layers, linear for output
        next.push(isLastLayer ? sum : this.relu(sum));
      }

      current = next;
    }

    return current;
  }

  getQValues(state: RLState): number[] {
    const stateVector = this.stateToVector(state);
    return this.forward(stateVector);
  }

  selectAction(state: RLState, training: boolean): number {
    if (training && Math.random() < this.config.epsilon) {
      return Math.floor(Math.random() * this.config.actionDim);
    }

    const qValues = this.getQValues(state);
    let bestAction = 0;
    let bestValue = qValues[0];

    for (let i = 1; i < qValues.length; i++) {
      if (qValues[i] > bestValue) {
        bestValue = qValues[i];
        bestAction = i;
      }
    }

    return bestAction;
  }

  train(experiences: Experience[]): number {
    let totalLoss = 0;

    for (const exp of experiences) {
      const stateVector = this.stateToVector(exp.state);
      const nextStateVector = this.stateToVector(exp.nextState);

      // Current Q-values
      const qValues = this.forward(stateVector);

      // Target Q-value
      const nextQValues = this.forward(nextStateVector);
      const maxNextQ = Math.max(...nextQValues);
      const target = exp.done
        ? exp.reward
        : exp.reward + this.config.gamma * maxNextQ;

      // TD error
      const tdError = target - qValues[exp.action];
      totalLoss += tdError * tdError;

      // Update weights for the action taken (simplified backprop)
      this.updateWeights(stateVector, exp.action, tdError);
    }

    // Decay epsilon
    this.config.epsilon = Math.max(
      this.config.epsilonMin,
      this.config.epsilon * this.config.epsilonDecay
    );

    return totalLoss / experiences.length;
  }

  private updateWeights(stateVector: number[], action: number, tdError: number): void {
    const lr = this.config.learningRate;

    // Simplified: only update output layer for the action taken
    const lastLayerIdx = this.weights.length - 1;
    const hiddenOutput = this.getHiddenOutput(stateVector);

    for (let k = 0; k < hiddenOutput.length; k++) {
      this.weights[lastLayerIdx][action][k] += lr * tdError * hiddenOutput[k];
    }
    this.biases[lastLayerIdx][action] += lr * tdError;
  }

  private getHiddenOutput(stateVector: number[]): number[] {
    let current = stateVector;

    for (let i = 0; i < this.weights.length - 1; i++) {
      const next: number[] = [];
      for (let j = 0; j < this.weights[i].length; j++) {
        let sum = this.biases[i][j];
        for (let k = 0; k < current.length; k++) {
          sum += current[k] * this.weights[i][j][k];
        }
        next.push(this.relu(sum));
      }
      current = next;
    }

    return current;
  }

  private stateToVector(state: RLState): number[] {
    return [
      ...state.orderBook,
      state.position,
      state.unrealizedPnL,
      ...state.priceHistory,
      state.ofi,
      state.volatility,
      state.timeToResolution,
      ...state.regime,
      state.inventoryRisk,
    ];
  }

  getEpsilon(): number {
    return this.config.epsilon;
  }

  save(): { weights: number[][][]; biases: number[][]; config: typeof this.config } {
    return {
      weights: this.weights,
      biases: this.biases,
      config: this.config,
    };
  }
}

// Training environment
class TrainingEnvironment {
  private priceData: PriceRow[] = [];
  private currentIdx = 0;
  private position = 0;
  private entryPrice = 0;
  private episodeSteps = 0;
  private maxSteps = 100;

  loadData(data: PriceRow[]): void {
    this.priceData = data.sort((a, b) =>
      new Date(a.time).getTime() - new Date(b.time).getTime()
    );
    console.log(`Loaded ${this.priceData.length} price points`);
  }

  reset(): RLState {
    // Start at random point in history (leaving room for history and episode)
    const minStart = 20;
    const maxStart = Math.max(minStart, this.priceData.length - this.maxSteps - 10);
    this.currentIdx = Math.floor(Math.random() * (maxStart - minStart)) + minStart;
    this.position = 0;
    this.entryPrice = 0;
    this.episodeSteps = 0;

    return this.buildState();
  }

  step(action: number): { state: RLState; reward: number; done: boolean } {
    const prevPrice = this.priceData[this.currentIdx].close;
    this.currentIdx++;
    this.episodeSteps++;

    const currentPrice = this.priceData[this.currentIdx].close;
    const priceChange = currentPrice - prevPrice;

    // Execute action
    let reward = 0;
    const tradeCost = 0.001;

    switch (action) {
      case 0: // HOLD
        reward = this.position * priceChange;
        break;

      case 1: // TIGHT_SMALL - small long
      case 2: // TIGHT_MEDIUM - medium long
      case 3: // TIGHT_LARGE - large long
        if (this.position <= 0) {
          const size = action === 1 ? 0.1 : action === 2 ? 0.3 : 0.5;
          this.position = size;
          this.entryPrice = currentPrice;
          reward = -tradeCost;
        }
        reward += this.position * priceChange;
        break;

      case 4: // WIDE_SMALL
      case 5: // WIDE_MEDIUM
      case 6: // WIDE_LARGE
        // Wide spread = defensive, reduce position
        if (this.position > 0) {
          reward = this.position * priceChange - tradeCost;
          this.position *= 0.5;
        }
        break;

      case 7: // CANCEL_ALL - close position
        if (this.position !== 0) {
          reward = this.position * priceChange - tradeCost;
          this.position = 0;
        }
        break;

      case 8: // BUY_ONLY
        if (this.position < 1) {
          this.position = Math.min(1, this.position + 0.3);
          reward = -tradeCost;
        }
        reward += this.position * priceChange;
        break;

      case 9: // SELL_ONLY
        if (this.position > -1) {
          this.position = Math.max(-1, this.position - 0.3);
          reward = -tradeCost;
        }
        reward += this.position * priceChange;
        break;
    }

    // Inventory penalty
    reward -= 0.0001 * Math.abs(this.position);

    const done =
      this.episodeSteps >= this.maxSteps ||
      this.currentIdx >= this.priceData.length - 10;

    return {
      state: this.buildState(),
      reward,
      done,
    };
  }

  private buildState(): RLState {
    const currentPrice = this.priceData[this.currentIdx].close;

    // Order book (simulated from price)
    const orderBook: number[] = [];
    for (let i = 0; i < 4; i++) {
      const spread = 0.01 * (i + 1);
      orderBook.push(currentPrice - spread / 2);
      orderBook.push(currentPrice + spread / 2);
    }

    // Price history (returns)
    const priceHistory: number[] = [];
    for (let i = 5; i > 0; i--) {
      const idx = this.currentIdx - i;
      if (idx > 0) {
        const ret =
          (this.priceData[idx].close - this.priceData[idx - 1].close) /
          this.priceData[idx - 1].close;
        priceHistory.push(ret);
      } else {
        priceHistory.push(0);
      }
    }

    // OFI
    let ofi = 0;
    let totalVol = 0;
    for (let i = 1; i <= 10 && this.currentIdx - i >= 0; i++) {
      const idx = this.currentIdx - i;
      const priceChg =
        this.priceData[idx].close -
        (idx > 0 ? this.priceData[idx - 1].close : this.priceData[idx].close);
      const vol = this.priceData[idx].volume || 1;
      ofi += priceChg > 0 ? vol : -vol;
      totalVol += vol;
    }
    ofi = totalVol > 0 ? ofi / totalVol : 0;

    // Volatility
    const returns = priceHistory.filter((r) => r !== 0);
    const meanRet =
      returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const variance =
      returns.length > 0
        ? returns.reduce((sum, r) => sum + Math.pow(r - meanRet, 2), 0) /
          returns.length
        : 0;
    const volatility = Math.sqrt(variance);

    // Regime (simplified)
    const regime = [0, 0, 1];
    if (priceHistory.length > 0) {
      const avgRet =
        priceHistory.reduce((a, b) => a + b, 0) / priceHistory.length;
      if (avgRet > 0.001) {
        regime[0] = 1;
        regime[2] = 0;
      } else if (avgRet < -0.001) {
        regime[1] = 1;
        regime[2] = 0;
      }
    }

    return {
      orderBook,
      position: this.position,
      unrealizedPnL:
        this.position !== 0
          ? this.position * (currentPrice - this.entryPrice)
          : 0,
      priceHistory,
      ofi,
      volatility,
      timeToResolution: 1 - this.episodeSteps / this.maxSteps,
      regime,
      inventoryRisk: Math.abs(this.position),
    };
  }
}

// Main training function
async function main() {
  console.log('=== RL Model Training ===\n');

  // Configuration
  const episodes = parseInt(process.env.RL_EPISODES || '1000');
  const savePath = process.env.RL_SAVE_PATH || './rl-model.json';
  const batchSize = 32;
  const bufferSize = 10000;

  // Connect to database
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  console.log('Loading historical price data...');

  // Load price history
  const result = await pool.query<PriceRow>(`
    SELECT time, market_id, close,
           COALESCE(bid + ask, 1000) as volume
    FROM price_history
    WHERE close IS NOT NULL AND close > 0 AND close < 1
    ORDER BY time ASC
    LIMIT 100000
  `);

  if (result.rows.length < 1000) {
    console.error('Not enough price data. Need at least 1000 rows.');
    await pool.end();
    process.exit(1);
  }

  console.log(`Loaded ${result.rows.length} price points\n`);

  // Initialize
  const env = new TrainingEnvironment();
  env.loadData(result.rows);

  const agent = new SimpleDQN({
    stateDim: 22,
    actionDim: 10,
    hiddenLayers: [64, 32],
    learningRate: 0.001,
    gamma: 0.99,
    epsilon: 1.0,
    epsilonMin: 0.05,
    epsilonDecay: 0.998,
  });

  // Experience replay buffer
  const buffer: Experience[] = [];

  // Training loop
  console.log(`Training for ${episodes} episodes...\n`);

  let totalReward = 0;
  let bestAvgReward = -Infinity;
  const rewardHistory: number[] = [];

  for (let episode = 0; episode < episodes; episode++) {
    let state = env.reset();
    let episodeReward = 0;
    let done = false;

    while (!done) {
      const action = agent.selectAction(state, true);
      const result = env.step(action);

      // Store experience
      buffer.push({
        state,
        action,
        reward: result.reward,
        nextState: result.state,
        done: result.done,
      });

      // Keep buffer size limited
      if (buffer.length > bufferSize) {
        buffer.shift();
      }

      // Train on batch
      if (buffer.length >= batchSize) {
        const batch: Experience[] = [];
        for (let i = 0; i < batchSize; i++) {
          const idx = Math.floor(Math.random() * buffer.length);
          batch.push(buffer[idx]);
        }
        agent.train(batch);
      }

      episodeReward += result.reward;
      state = result.state;
      done = result.done;
    }

    totalReward += episodeReward;
    rewardHistory.push(episodeReward);

    // Log progress
    if ((episode + 1) % 100 === 0) {
      const avgReward = rewardHistory.slice(-100).reduce((a, b) => a + b, 0) / 100;
      console.log(
        `Episode ${episode + 1}/${episodes} | ` +
          `Avg Reward: ${avgReward.toFixed(4)} | ` +
          `Epsilon: ${agent.getEpsilon().toFixed(3)} | ` +
          `Buffer: ${buffer.length}`
      );

      // Save best model
      if (avgReward > bestAvgReward) {
        bestAvgReward = avgReward;
        const modelData = agent.save();
        fs.writeFileSync(savePath, JSON.stringify(modelData, null, 2));
        console.log(`  -> New best! Saved to ${savePath}`);
      }
    }
  }

  // Final save
  const modelData = agent.save();
  fs.writeFileSync(savePath, JSON.stringify(modelData, null, 2));

  console.log('\n=== Training Complete ===');
  console.log(`Total episodes: ${episodes}`);
  console.log(`Best avg reward: ${bestAvgReward.toFixed(4)}`);
  console.log(`Model saved to: ${savePath}`);

  await pool.end();
}

main().catch(console.error);
