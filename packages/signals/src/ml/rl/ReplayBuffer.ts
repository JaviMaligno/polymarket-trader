/**
 * Experience Replay Buffer
 *
 * Stores experiences for training the RL agent.
 * Supports uniform and prioritized experience replay.
 */

import type { Experience, RLState, RLAction, TrainingBatch } from './types.js';

/**
 * Sum tree for prioritized experience replay
 */
class SumTree {
  private capacity: number;
  private tree: number[];
  private data: (Experience | null)[];
  private writeIndex: number;
  private size: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    // Tree has 2*capacity - 1 nodes (leaf nodes + internal nodes)
    this.tree = new Array(2 * capacity - 1).fill(0);
    this.data = new Array(capacity).fill(null);
    this.writeIndex = 0;
    this.size = 0;
  }

  private propagate(idx: number, change: number): void {
    let parent = Math.floor((idx - 1) / 2);
    this.tree[parent] += change;

    if (parent !== 0) {
      this.propagate(parent, change);
    }
  }

  private retrieve(idx: number, s: number): number {
    const left = 2 * idx + 1;
    const right = left + 1;

    if (left >= this.tree.length) {
      return idx;
    }

    if (s <= this.tree[left]) {
      return this.retrieve(left, s);
    } else {
      return this.retrieve(right, s - this.tree[left]);
    }
  }

  get total(): number {
    return this.tree[0];
  }

  add(priority: number, experience: Experience): void {
    const idx = this.writeIndex + this.capacity - 1;

    this.data[this.writeIndex] = experience;
    this.update(idx, priority);

    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    if (this.size < this.capacity) {
      this.size++;
    }
  }

  update(idx: number, priority: number): void {
    const change = priority - this.tree[idx];
    this.tree[idx] = priority;
    this.propagate(idx, change);
  }

  get(s: number): { idx: number; priority: number; experience: Experience | null } {
    const idx = this.retrieve(0, s);
    const dataIdx = idx - this.capacity + 1;

    return {
      idx,
      priority: this.tree[idx],
      experience: this.data[dataIdx],
    };
  }

  getSize(): number {
    return this.size;
  }
}

/**
 * Replay buffer configuration
 */
export interface ReplayBufferConfig {
  /** Maximum buffer size */
  capacity: number;
  /** Use prioritized experience replay */
  usePER: boolean;
  /** Alpha for priority exponent (0 = uniform, 1 = full priority) */
  alpha: number;
  /** Beta for importance sampling (starts low, anneals to 1) */
  betaStart: number;
  /** Beta annealing rate */
  betaAnnealing: number;
  /** Small constant to avoid zero priority */
  epsilon: number;
}

/** Default buffer configuration */
export const DEFAULT_BUFFER_CONFIG: ReplayBufferConfig = {
  capacity: 100000,
  usePER: false,
  alpha: 0.6,
  betaStart: 0.4,
  betaAnnealing: 0.001,
  epsilon: 0.01,
};

/**
 * Experience Replay Buffer
 *
 * Stores and samples experiences for training.
 * FIXED: Uses circular buffer for O(1) operations instead of O(n) shift()
 */
export class ReplayBuffer {
  private config: ReplayBufferConfig;
  private buffer: (Experience | null)[];
  private writeIndex: number;
  private bufferSize: number;
  private sumTree: SumTree | null;
  private maxPriority: number;
  private beta: number;

  constructor(config: Partial<ReplayBufferConfig> = {}) {
    this.config = { ...DEFAULT_BUFFER_CONFIG, ...config };
    // Pre-allocate circular buffer for O(1) operations
    this.buffer = new Array(this.config.capacity).fill(null);
    this.writeIndex = 0;
    this.bufferSize = 0;
    this.sumTree = this.config.usePER ? new SumTree(this.config.capacity) : null;
    this.maxPriority = 1.0;
    this.beta = this.config.betaStart;
  }

  /**
   * Add experience to buffer using circular buffer pattern
   * FIXED: O(1) operation instead of O(n) shift()
   */
  add(experience: Experience): void {
    if (this.config.usePER && this.sumTree) {
      // For PER, use max priority for new experiences
      const priority = Math.pow(this.maxPriority, this.config.alpha);
      this.sumTree.add(priority, experience);
      // Also add to uniform buffer for getAll()
      this.buffer[this.writeIndex] = experience;
    } else {
      // Circular buffer - O(1) operation
      this.buffer[this.writeIndex] = experience;
    }

    // Update write index and size
    this.writeIndex = (this.writeIndex + 1) % this.config.capacity;
    if (this.bufferSize < this.config.capacity) {
      this.bufferSize++;
    }
  }

  /**
   * Sample batch of experiences
   */
  sample(batchSize: number): {
    batch: TrainingBatch;
    indices: number[];
    weights: number[];
  } {
    const states: RLState[] = [];
    const actions: (number | RLAction)[] = [];
    const rewards: number[] = [];
    const nextStates: RLState[] = [];
    const dones: boolean[] = [];
    const indices: number[] = [];
    const weights: number[] = [];

    if (this.config.usePER && this.sumTree) {
      // Prioritized sampling
      const segment = this.sumTree.total / batchSize;
      const minProbability =
        Math.pow(this.config.epsilon, this.config.alpha) / this.sumTree.total;
      const maxWeight = Math.pow(this.sumTree.getSize() * minProbability, -this.beta);

      for (let i = 0; i < batchSize; i++) {
        const a = segment * i;
        const b = segment * (i + 1);
        const s = a + Math.random() * (b - a);

        const { idx, priority, experience } = this.sumTree.get(s);

        if (experience) {
          states.push(experience.state);
          actions.push(experience.action);
          rewards.push(experience.reward);
          nextStates.push(experience.nextState);
          dones.push(experience.done);
          indices.push(idx);

          // Calculate importance sampling weight
          const probability = priority / this.sumTree.total;
          const weight =
            Math.pow(this.sumTree.getSize() * probability, -this.beta) / maxWeight;
          weights.push(weight);
        }
      }

      // Anneal beta
      this.beta = Math.min(1.0, this.beta + this.config.betaAnnealing);
    } else {
      // Uniform sampling from circular buffer
      const sampledIndices = new Set<number>();

      while (sampledIndices.size < Math.min(batchSize, this.bufferSize)) {
        const idx = Math.floor(Math.random() * this.bufferSize);
        if (!sampledIndices.has(idx)) {
          sampledIndices.add(idx);
          const experience = this.buffer[idx];
          if (experience) {
            states.push(experience.state);
            actions.push(experience.action);
            rewards.push(experience.reward);
            nextStates.push(experience.nextState);
            dones.push(experience.done);
            indices.push(idx);
            weights.push(1.0); // Uniform weights
          }
        }
      }
    }

    return {
      batch: { states, actions, rewards, nextStates, dones },
      indices,
      weights,
    };
  }

  /**
   * Update priorities for PER
   */
  updatePriorities(indices: number[], tdErrors: number[]): void {
    if (!this.config.usePER || !this.sumTree) return;

    for (let i = 0; i < indices.length; i++) {
      const priority = Math.pow(Math.abs(tdErrors[i]) + this.config.epsilon, this.config.alpha);
      this.sumTree.update(indices[i], priority);
      this.maxPriority = Math.max(this.maxPriority, Math.abs(tdErrors[i]) + this.config.epsilon);
    }
  }

  /**
   * Get buffer size
   */
  size(): number {
    if (this.config.usePER && this.sumTree) {
      return this.sumTree.getSize();
    }
    return this.bufferSize;
  }

  /**
   * Check if buffer has enough samples
   */
  canSample(batchSize: number): boolean {
    return this.size() >= batchSize;
  }

  /**
   * Clear buffer
   */
  clear(): void {
    this.buffer = new Array(this.config.capacity).fill(null);
    this.writeIndex = 0;
    this.bufferSize = 0;
    if (this.config.usePER) {
      this.sumTree = new SumTree(this.config.capacity);
    }
    this.maxPriority = 1.0;
    this.beta = this.config.betaStart;
  }

  /**
   * Get all experiences (for analysis)
   * FIXED: Works correctly with circular buffer
   */
  getAll(): Experience[] {
    const result: Experience[] = [];
    for (let i = 0; i < this.bufferSize; i++) {
      const exp = this.buffer[i];
      if (exp) {
        result.push(exp);
      }
    }
    return result;
  }
}
