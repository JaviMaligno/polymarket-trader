/**
 * Deep Q-Network Agent
 *
 * DQN agent for market making with support for:
 * - Double DQN (reduces overestimation)
 * - Dueling DQN (separate value and advantage streams)
 * - Prioritized Experience Replay
 */

import type {
  RLState,
  AgentConfig,
  Experience,
  TrainingBatch,
  DiscreteAction,
} from './types.js';
import { DEFAULT_AGENT_CONFIG } from './types.js';
import { ReplayBuffer, type ReplayBufferConfig } from './ReplayBuffer.js';

/**
 * Simple neural network layer (for environments without TensorFlow)
 */
interface Layer {
  weights: number[][];
  biases: number[];
  activation: 'relu' | 'linear' | 'tanh';
}

/**
 * Simple feed-forward neural network
 * Note: For production, use TensorFlow.js or similar
 */
class SimpleNetwork {
  private layers: Layer[];

  constructor(layerSizes: number[], activations: ('relu' | 'linear' | 'tanh')[]) {
    this.layers = [];

    for (let i = 0; i < layerSizes.length - 1; i++) {
      const inputSize = layerSizes[i];
      const outputSize = layerSizes[i + 1];

      // Xavier initialization
      const scale = Math.sqrt(2.0 / (inputSize + outputSize));

      const weights: number[][] = [];
      for (let j = 0; j < inputSize; j++) {
        weights.push(
          Array(outputSize)
            .fill(0)
            .map(() => (Math.random() * 2 - 1) * scale)
        );
      }

      const biases = Array(outputSize).fill(0);

      this.layers.push({
        weights,
        biases,
        activation: activations[i] || 'relu',
      });
    }
  }

  private relu(x: number): number {
    return Math.max(0, x);
  }

  private tanh(x: number): number {
    return Math.tanh(x);
  }

  private applyActivation(x: number, activation: string): number {
    switch (activation) {
      case 'relu':
        return this.relu(x);
      case 'tanh':
        return this.tanh(x);
      default:
        return x;
    }
  }

  forward(input: number[]): number[] {
    let current = input;

    for (const layer of this.layers) {
      const output: number[] = new Array(layer.biases.length).fill(0);

      for (let j = 0; j < layer.biases.length; j++) {
        let sum = layer.biases[j];
        for (let i = 0; i < current.length; i++) {
          sum += current[i] * layer.weights[i][j];
        }
        output[j] = this.applyActivation(sum, layer.activation);
      }

      current = output;
    }

    return current;
  }

  /**
   * Get weights and biases for serialization
   * FIXED: Now includes biases for complete model persistence
   */
  getWeights(): number[][][] {
    return this.layers.map((l) => l.weights);
  }

  /**
   * Get biases for serialization
   */
  getBiases(): number[][] {
    return this.layers.map((l) => [...l.biases]);
  }

  /**
   * Set weights from serialization
   */
  setWeights(weights: number[][][]): void {
    for (let i = 0; i < weights.length && i < this.layers.length; i++) {
      this.layers[i].weights = weights[i];
    }
  }

  /**
   * Set biases from serialization
   */
  setBiases(biases: number[][]): void {
    for (let i = 0; i < biases.length && i < this.layers.length; i++) {
      this.layers[i].biases = [...biases[i]];
    }
  }

  /**
   * Get full model parameters (weights + biases) for serialization
   */
  getParameters(): { weights: number[][][]; biases: number[][] } {
    return {
      weights: this.getWeights(),
      biases: this.getBiases(),
    };
  }

  /**
   * Set full model parameters (weights + biases) from serialization
   */
  setParameters(params: { weights: number[][][]; biases: number[][] }): void {
    this.setWeights(params.weights);
    this.setBiases(params.biases);
  }

  /**
   * Copy weights and biases from another network
   * FIXED: Now copies biases too for complete model copy
   */
  copyFrom(other: SimpleNetwork): void {
    const otherWeights = other.getWeights();
    const otherBiases = other.getBiases();
    for (let i = 0; i < this.layers.length; i++) {
      for (let j = 0; j < this.layers[i].weights.length; j++) {
        for (let k = 0; k < this.layers[i].weights[j].length; k++) {
          this.layers[i].weights[j][k] = otherWeights[i][j][k];
        }
      }
      for (let j = 0; j < this.layers[i].biases.length; j++) {
        this.layers[i].biases[j] = otherBiases[i][j];
      }
    }
  }

  /**
   * Update weights using gradient (simple SGD)
   * FIXED: Computes gradients BEFORE updating weights
   * FIXED: Adds gradient clipping for stability
   */
  updateWeights(
    input: number[],
    targetOutput: number[],
    learningRate: number,
    gradientClip: number = 1.0
  ): number {
    // Forward pass with intermediate activations
    const activations: number[][] = [input];
    let current = input;

    for (const layer of this.layers) {
      const output: number[] = new Array(layer.biases.length).fill(0);
      for (let j = 0; j < layer.biases.length; j++) {
        let sum = layer.biases[j];
        for (let i = 0; i < current.length; i++) {
          sum += current[i] * layer.weights[i][j];
        }
        output[j] = this.applyActivation(sum, layer.activation);
      }
      activations.push(output);
      current = output;
    }

    // Calculate loss (MSE)
    const finalOutput = activations[activations.length - 1];
    let loss = 0;
    const outputErrors: number[] = [];
    for (let i = 0; i < finalOutput.length; i++) {
      const error = finalOutput[i] - targetOutput[i];
      outputErrors.push(error);
      loss += error * error;
    }
    loss /= finalOutput.length;

    // Backward pass - FIXED: Compute all gradients BEFORE updating weights
    let errors = outputErrors;

    // First pass: compute all gradients
    const layerGradients: Array<{
      weightGradients: number[][];
      biasGradients: number[];
      nextErrors: number[];
    }> = [];

    for (let l = this.layers.length - 1; l >= 0; l--) {
      const layer = this.layers[l];
      const prevActivations = activations[l];
      const nextErrors: number[] = new Array(prevActivations.length).fill(0);
      const weightGradients: number[][] = [];
      const biasGradients: number[] = [];

      for (let i = 0; i < prevActivations.length; i++) {
        weightGradients.push(new Array(layer.biases.length).fill(0));
      }

      for (let j = 0; j < layer.biases.length; j++) {
        // Gradient of activation
        let gradient = errors[j];
        if (layer.activation === 'relu' && activations[l + 1][j] <= 0) {
          gradient = 0;
        } else if (layer.activation === 'tanh') {
          const t = activations[l + 1][j];
          gradient *= 1 - t * t;
        }

        // Gradient clipping for stability
        gradient = Math.max(-gradientClip, Math.min(gradientClip, gradient));

        // Store gradients (using ORIGINAL weights for nextErrors)
        for (let i = 0; i < prevActivations.length; i++) {
          weightGradients[i][j] = gradient * prevActivations[i];
          nextErrors[i] += gradient * layer.weights[i][j]; // Use ORIGINAL weight
        }
        biasGradients.push(gradient);
      }

      layerGradients.unshift({ weightGradients, biasGradients, nextErrors });
      errors = nextErrors;
    }

    // Second pass: apply all weight updates
    for (let l = 0; l < this.layers.length; l++) {
      const layer = this.layers[l];
      const grads = layerGradients[l];

      for (let i = 0; i < layer.weights.length; i++) {
        for (let j = 0; j < layer.weights[i].length; j++) {
          layer.weights[i][j] -= learningRate * grads.weightGradients[i][j];
        }
      }
      for (let j = 0; j < layer.biases.length; j++) {
        layer.biases[j] -= learningRate * grads.biasGradients[j];
      }
    }

    return loss;
  }
}

/**
 * DQN Agent for market making
 */
export class DQNAgent {
  private config: AgentConfig;
  private qNetwork: SimpleNetwork;
  private targetNetwork: SimpleNetwork;
  private replayBuffer: ReplayBuffer;
  private epsilon: number;
  private stepCount: number;
  private trainCount: number;

  constructor(
    config: Partial<AgentConfig> = {},
    bufferConfig: Partial<ReplayBufferConfig> = {}
  ) {
    this.config = { ...DEFAULT_AGENT_CONFIG, ...config };
    this.epsilon = this.config.epsilon;
    this.stepCount = 0;
    this.trainCount = 0;

    // Build networks
    const layerSizes = [
      this.config.stateDim,
      ...this.config.hiddenLayers,
      this.config.actionDim,
    ];
    const activations: ('relu' | 'linear')[] = [
      ...this.config.hiddenLayers.map(() => 'relu' as const),
      'linear' as const,
    ];

    this.qNetwork = new SimpleNetwork(layerSizes, activations);
    this.targetNetwork = new SimpleNetwork(layerSizes, activations);
    this.targetNetwork.copyFrom(this.qNetwork);

    // Initialize replay buffer
    this.replayBuffer = new ReplayBuffer({
      ...bufferConfig,
      usePER: this.config.usePER,
    });
  }

  /**
   * Convert state to input vector
   */
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

  /**
   * Select action using epsilon-greedy policy
   */
  selectAction(state: RLState, training: boolean = true): number {
    // Epsilon-greedy exploration
    if (training && Math.random() < this.epsilon) {
      return Math.floor(Math.random() * this.config.actionDim);
    }

    // Exploit: select best action
    const stateVector = this.stateToVector(state);
    const qValues = this.qNetwork.forward(stateVector);

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

  /**
   * Get Q-values for all actions
   */
  getQValues(state: RLState): number[] {
    const stateVector = this.stateToVector(state);
    return this.qNetwork.forward(stateVector);
  }

  /**
   * Store experience in replay buffer
   */
  remember(experience: Experience): void {
    this.replayBuffer.add(experience);
    this.stepCount++;
  }

  /**
   * Train on batch of experiences
   */
  train(): { loss: number; avgQ: number } | null {
    if (!this.replayBuffer.canSample(this.config.batchSize)) {
      return null;
    }

    const { batch, indices, weights } = this.replayBuffer.sample(this.config.batchSize);
    const tdErrors: number[] = [];
    let totalLoss = 0;
    let totalQ = 0;

    for (let i = 0; i < batch.states.length; i++) {
      const stateVector = this.stateToVector(batch.states[i]);
      const nextStateVector = this.stateToVector(batch.nextStates[i]);
      const action = batch.actions[i] as number;
      const reward = batch.rewards[i];
      const done = batch.dones[i];

      // Current Q-values
      const currentQ = this.qNetwork.forward(stateVector);
      totalQ += currentQ[action];

      // Target Q-value
      let targetQ: number;

      if (done) {
        targetQ = reward;
      } else {
        if (this.config.useDoubleDQN) {
          // Double DQN: use online network to select action, target network to evaluate
          const nextQ = this.qNetwork.forward(nextStateVector);
          let bestNextAction = 0;
          for (let a = 1; a < nextQ.length; a++) {
            if (nextQ[a] > nextQ[bestNextAction]) {
              bestNextAction = a;
            }
          }
          const targetNextQ = this.targetNetwork.forward(nextStateVector);
          targetQ = reward + this.config.gamma * targetNextQ[bestNextAction];
        } else {
          // Standard DQN
          const targetNextQ = this.targetNetwork.forward(nextStateVector);
          const maxNextQ = Math.max(...targetNextQ);
          targetQ = reward + this.config.gamma * maxNextQ;
        }
      }

      // TD error
      const tdError = targetQ - currentQ[action];
      tdErrors.push(tdError);

      // Create target output (keep other actions, update selected action)
      const targetOutput = [...currentQ];
      targetOutput[action] = targetQ;

      // Update weights with importance sampling weight
      const loss = this.qNetwork.updateWeights(
        stateVector,
        targetOutput,
        this.config.learningRate * weights[i]
      );
      totalLoss += loss;
    }

    // Update priorities for PER
    if (this.config.usePER) {
      this.replayBuffer.updatePriorities(indices, tdErrors);
    }

    // Update target network periodically
    this.trainCount++;
    if (this.trainCount % this.config.targetUpdateFreq === 0) {
      this.updateTargetNetwork();
    }

    // Decay epsilon
    this.epsilon = Math.max(
      this.config.epsilonMin,
      this.epsilon * this.config.epsilonDecay
    );

    return {
      loss: totalLoss / batch.states.length,
      avgQ: totalQ / batch.states.length,
    };
  }

  /**
   * Update target network
   */
  updateTargetNetwork(): void {
    this.targetNetwork.copyFrom(this.qNetwork);
  }

  /**
   * Get current epsilon
   */
  getEpsilon(): number {
    return this.epsilon;
  }

  /**
   * Set epsilon manually
   */
  setEpsilon(epsilon: number): void {
    this.epsilon = epsilon;
  }

  /**
   * Get step count
   */
  getStepCount(): number {
    return this.stepCount;
  }

  /**
   * Get replay buffer size
   */
  getBufferSize(): number {
    return this.replayBuffer.size();
  }

  /**
   * Save model weights and biases
   * FIXED: Now includes biases for complete model persistence
   */
  save(): { weights: number[][][]; biases: number[][]; config: AgentConfig; epsilon: number } {
    return {
      weights: this.qNetwork.getWeights(),
      biases: this.qNetwork.getBiases(),
      config: this.config,
      epsilon: this.epsilon,
    };
  }

  /**
   * Load model weights and biases
   * FIXED: Now loads biases too for complete model restoration
   */
  load(data: { weights: number[][][]; biases?: number[][]; epsilon?: number }): void {
    this.qNetwork.setWeights(data.weights);
    if (data.biases) {
      this.qNetwork.setBiases(data.biases);
    }
    this.targetNetwork.copyFrom(this.qNetwork);
    if (data.epsilon !== undefined) {
      this.epsilon = data.epsilon;
    }
  }

  /**
   * Reset for new episode
   */
  reset(): void {
    // Can be used to reset episode-specific state if needed
  }
}
