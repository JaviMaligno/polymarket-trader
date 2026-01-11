/**
 * Hidden Markov Model (HMM) Implementation
 *
 * Gaussian HMM for market regime detection.
 * Uses the Viterbi algorithm for most likely state sequence
 * and Forward algorithm for state probabilities.
 *
 * Reference: Rabiner, L.R. (1989) "A Tutorial on Hidden Markov Models"
 */

import { pino, Logger } from 'pino';

/**
 * HMM Configuration
 */
export interface HMMConfig {
  /** Number of hidden states */
  numStates: number;
  /** Number of observation dimensions */
  numObservations: number;
  /** Learning rate for online updates */
  learningRate?: number;
  /** Minimum probability to prevent numerical issues */
  minProb?: number;
}

/**
 * Gaussian emission parameters for a state
 */
interface GaussianParams {
  /** Mean vector for each observation dimension */
  mean: number[];
  /** Variance for each observation dimension (diagonal covariance) */
  variance: number[];
}

/**
 * Hidden Markov Model
 */
export class HiddenMarkovModel {
  private logger: Logger;
  private numStates: number;
  private numObs: number;
  private learningRate: number;
  private minProb: number;

  /** Initial state probabilities π */
  private initialProbs: number[];
  /** Transition matrix A[i][j] = P(state_t = j | state_{t-1} = i) */
  private transitionMatrix: number[][];
  /** Emission parameters B for each state (Gaussian) */
  private emissionParams: GaussianParams[];

  constructor(config: HMMConfig) {
    this.logger = pino({ name: 'HiddenMarkovModel' });
    this.numStates = config.numStates;
    this.numObs = config.numObservations;
    this.learningRate = config.learningRate ?? 0.01;
    this.minProb = config.minProb ?? 1e-10;

    // Initialize with uniform initial probabilities
    this.initialProbs = Array(this.numStates).fill(1 / this.numStates);

    // Initialize transition matrix (slight preference for staying in same state)
    this.transitionMatrix = this.initializeTransitionMatrix();

    // Initialize emission parameters with sensible defaults
    this.emissionParams = this.initializeEmissionParams();
  }

  /**
   * Initialize transition matrix with self-transition preference
   */
  private initializeTransitionMatrix(): number[][] {
    // Handle edge case of single state
    if (this.numStates === 1) {
      return [[1.0]];
    }

    const selfProb = 0.7; // Probability of staying in same state
    const otherProb = (1 - selfProb) / (this.numStates - 1);

    const matrix: number[][] = [];
    for (let i = 0; i < this.numStates; i++) {
      const row: number[] = [];
      for (let j = 0; j < this.numStates; j++) {
        row.push(i === j ? selfProb : otherProb);
      }
      matrix.push(row);
    }
    return matrix;
  }

  /**
   * Initialize emission parameters based on typical market regimes
   */
  private initializeEmissionParams(): GaussianParams[] {
    // Default parameters assuming 2 observations: [returns, volatility]
    // States: 0=bull_low_vol, 1=bull_high_vol, 2=bear_low_vol, 3=bear_high_vol, 4=neutral
    const defaultParams: GaussianParams[] = [
      { mean: [0.02, 0.01], variance: [0.001, 0.0001] },  // bull_low_vol
      { mean: [0.03, 0.04], variance: [0.004, 0.001] },   // bull_high_vol
      { mean: [-0.02, 0.01], variance: [0.001, 0.0001] }, // bear_low_vol
      { mean: [-0.03, 0.04], variance: [0.004, 0.001] },  // bear_high_vol
      { mean: [0.0, 0.02], variance: [0.002, 0.0005] },   // neutral
    ];

    // Use defaults or generate if different number of states
    if (this.numStates === 5) {
      return defaultParams;
    }

    // Generate based on state count
    const params: GaussianParams[] = [];
    for (let i = 0; i < this.numStates; i++) {
      // Handle single state case to avoid division by zero
      const returnMean = this.numStates === 1
        ? 0
        : (i / (this.numStates - 1)) * 0.06 - 0.03; // -0.03 to +0.03
      const volMean = 0.01 + (i % 2) * 0.03; // Alternating low/high vol
      params.push({
        mean: Array(this.numObs).fill(returnMean).map((v, j) => j === 1 ? volMean : v),
        variance: Array(this.numObs).fill(0.002),
      });
    }
    return params;
  }

  /**
   * Compute Gaussian probability density
   */
  private gaussianPdf(x: number, mean: number, variance: number): number {
    const safeVariance = Math.max(variance, 1e-6); // More reasonable minimum variance
    const exp = -0.5 * Math.pow(x - mean, 2) / safeVariance;
    const norm = 1 / Math.sqrt(2 * Math.PI * safeVariance);
    return Math.max(this.minProb, norm * Math.exp(exp));
  }

  /**
   * Compute log Gaussian probability density (for numerical stability)
   */
  private logGaussianPdf(x: number, mean: number, variance: number): number {
    const safeVariance = Math.max(variance, 1e-6);
    const logNorm = -0.5 * Math.log(2 * Math.PI * safeVariance);
    const logExp = -0.5 * Math.pow(x - mean, 2) / safeVariance;
    return logNorm + logExp;
  }

  /**
   * Compute log emission probability P(observation | state)
   * Uses log-space to prevent underflow with multi-dimensional observations
   */
  private logEmissionProb(observation: number[], state: number): number {
    const params = this.emissionParams[state];
    let logProb = 0;
    for (let d = 0; d < this.numObs; d++) {
      logProb += this.logGaussianPdf(observation[d], params.mean[d], params.variance[d]);
    }
    return logProb;
  }

  /**
   * Compute emission probability P(observation | state)
   * Uses log-space internally to prevent underflow
   */
  private emissionProb(observation: number[], state: number): number {
    const logProb = this.logEmissionProb(observation, state);
    // Clamp to prevent underflow (exp(-700) ≈ 0)
    return Math.exp(Math.max(-700, logProb));
  }

  /**
   * Forward algorithm - compute P(observations | model) and state probabilities
   *
   * Returns forward probabilities α[t][i] = P(o_1..o_t, state_t = i)
   */
  forward(observations: number[][]): { alpha: number[][]; logLikelihood: number } {
    const T = observations.length;
    const alpha: number[][] = [];

    // Initialize α_1(i) = π_i * b_i(o_1)
    const alpha0: number[] = [];
    let scale0 = 0;
    for (let i = 0; i < this.numStates; i++) {
      const p = this.initialProbs[i] * this.emissionProb(observations[0], i);
      alpha0.push(p);
      scale0 += p;
    }
    // Scale to prevent underflow
    alpha.push(alpha0.map(p => p / Math.max(scale0, this.minProb)));

    let logLikelihood = Math.log(Math.max(scale0, this.minProb));

    // Induction: α_t(j) = [Σ_i α_{t-1}(i) * a_ij] * b_j(o_t)
    for (let t = 1; t < T; t++) {
      const alphaT: number[] = [];
      let scaleT = 0;

      for (let j = 0; j < this.numStates; j++) {
        let sum = 0;
        for (let i = 0; i < this.numStates; i++) {
          sum += alpha[t - 1][i] * this.transitionMatrix[i][j];
        }
        const p = sum * this.emissionProb(observations[t], j);
        alphaT.push(p);
        scaleT += p;
      }

      // Scale
      alpha.push(alphaT.map(p => p / Math.max(scaleT, this.minProb)));
      logLikelihood += Math.log(Math.max(scaleT, this.minProb));
    }

    return { alpha, logLikelihood };
  }

  /**
   * Backward algorithm - compute backward probabilities
   *
   * Returns backward probabilities β[t][i] = P(o_{t+1}..o_T | state_t = i)
   */
  backward(observations: number[][]): number[][] {
    const T = observations.length;
    const beta: number[][] = Array(T).fill(null).map(() => Array(this.numStates).fill(0));

    // Initialize β_T(i) = 1
    for (let i = 0; i < this.numStates; i++) {
      beta[T - 1][i] = 1;
    }

    // Induction: β_t(i) = Σ_j a_ij * b_j(o_{t+1}) * β_{t+1}(j)
    for (let t = T - 2; t >= 0; t--) {
      let scale = 0;
      for (let i = 0; i < this.numStates; i++) {
        let sum = 0;
        for (let j = 0; j < this.numStates; j++) {
          sum += this.transitionMatrix[i][j] *
                 this.emissionProb(observations[t + 1], j) *
                 beta[t + 1][j];
        }
        beta[t][i] = sum;
        scale += sum;
      }
      // Scale
      if (scale > 0) {
        for (let i = 0; i < this.numStates; i++) {
          beta[t][i] /= scale;
        }
      }
    }

    return beta;
  }

  /**
   * Viterbi algorithm - find most likely state sequence
   *
   * Returns the most likely sequence of states
   */
  viterbi(observations: number[][]): { states: number[]; probability: number } {
    const T = observations.length;
    const delta: number[][] = Array(T).fill(null).map(() => Array(this.numStates).fill(0));
    const psi: number[][] = Array(T).fill(null).map(() => Array(this.numStates).fill(0));

    // Initialize
    for (let i = 0; i < this.numStates; i++) {
      delta[0][i] = Math.log(Math.max(this.initialProbs[i], this.minProb)) +
                    Math.log(Math.max(this.emissionProb(observations[0], i), this.minProb));
      psi[0][i] = 0;
    }

    // Recursion
    for (let t = 1; t < T; t++) {
      for (let j = 0; j < this.numStates; j++) {
        let maxVal = -Infinity;
        let maxIdx = 0;
        for (let i = 0; i < this.numStates; i++) {
          const val = delta[t - 1][i] + Math.log(Math.max(this.transitionMatrix[i][j], this.minProb));
          if (val > maxVal) {
            maxVal = val;
            maxIdx = i;
          }
        }
        delta[t][j] = maxVal + Math.log(Math.max(this.emissionProb(observations[t], j), this.minProb));
        psi[t][j] = maxIdx;
      }
    }

    // Termination
    let maxProb = -Infinity;
    let lastState = 0;
    for (let i = 0; i < this.numStates; i++) {
      if (delta[T - 1][i] > maxProb) {
        maxProb = delta[T - 1][i];
        lastState = i;
      }
    }

    // Backtrack
    const states: number[] = Array(T).fill(0);
    states[T - 1] = lastState;
    for (let t = T - 2; t >= 0; t--) {
      states[t] = psi[t + 1][states[t + 1]];
    }

    return { states, probability: Math.exp(maxProb) };
  }

  /**
   * Get current state probabilities given a new observation
   * (Online filtering)
   */
  filter(observation: number[], previousProbs?: number[]): number[] {
    const probs = previousProbs || this.initialProbs;

    // Predict: P(state_t | observations_{1..t-1})
    const predicted: number[] = Array(this.numStates).fill(0);
    for (let j = 0; j < this.numStates; j++) {
      for (let i = 0; i < this.numStates; i++) {
        predicted[j] += probs[i] * this.transitionMatrix[i][j];
      }
    }

    // Update: P(state_t | observations_{1..t})
    const updated: number[] = [];
    let norm = 0;
    for (let i = 0; i < this.numStates; i++) {
      const p = predicted[i] * this.emissionProb(observation, i);
      updated.push(p);
      norm += p;
    }

    // Normalize
    return updated.map(p => p / Math.max(norm, this.minProb));
  }

  /**
   * Online parameter update using a single observation
   * (Simplified Baum-Welch update using Welford's algorithm)
   */
  updateOnline(observation: number[], stateProbs: number[]): void {
    const lr = this.learningRate;

    // Update emission parameters
    for (let i = 0; i < this.numStates; i++) {
      const weight = stateProbs[i] * lr;
      for (let d = 0; d < this.numObs; d++) {
        // CRITICAL FIX: Compute error BEFORE updating mean (Welford's algorithm)
        const oldMean = this.emissionParams[i].mean[d];
        const err = Math.pow(observation[d] - oldMean, 2);

        // Update mean towards observation
        this.emissionParams[i].mean[d] += weight * (observation[d] - oldMean);

        // Update variance towards squared error (using old mean for unbiased estimate)
        this.emissionParams[i].variance[d] += weight * (err - this.emissionParams[i].variance[d]);

        // Ensure minimum variance (use reasonable minimum, not minProb)
        this.emissionParams[i].variance[d] = Math.max(1e-6, this.emissionParams[i].variance[d]);
      }
    }
  }

  /**
   * Set transition matrix manually
   */
  setTransitionMatrix(matrix: number[][]): void {
    if (matrix.length !== this.numStates) {
      throw new Error(`Invalid transition matrix size: expected ${this.numStates}x${this.numStates}`);
    }
    this.transitionMatrix = matrix;
  }

  /**
   * Set emission parameters manually
   */
  setEmissionParams(params: GaussianParams[]): void {
    if (params.length !== this.numStates) {
      throw new Error(`Invalid emission params: expected ${this.numStates} states`);
    }
    this.emissionParams = params;
  }

  /**
   * Set initial probabilities
   */
  setInitialProbs(probs: number[]): void {
    if (probs.length !== this.numStates) {
      throw new Error(`Invalid initial probs: expected ${this.numStates} values`);
    }
    this.initialProbs = probs;
  }

  /**
   * Get model parameters for serialization
   */
  getParameters(): {
    initialProbs: number[];
    transitionMatrix: number[][];
    emissionParams: GaussianParams[];
  } {
    return {
      initialProbs: [...this.initialProbs],
      transitionMatrix: this.transitionMatrix.map(row => [...row]),
      emissionParams: this.emissionParams.map(p => ({
        mean: [...p.mean],
        variance: [...p.variance],
      })),
    };
  }

  /**
   * Load model parameters
   */
  loadParameters(params: {
    initialProbs: number[];
    transitionMatrix: number[][];
    emissionParams: GaussianParams[];
  }): void {
    this.initialProbs = params.initialProbs;
    this.transitionMatrix = params.transitionMatrix;
    this.emissionParams = params.emissionParams;
  }

  /**
   * Get number of states
   */
  getNumStates(): number {
    return this.numStates;
  }

  /**
   * Get transition probability from state i to state j
   */
  getTransitionProb(fromState: number, toState: number): number {
    return this.transitionMatrix[fromState][toState];
  }
}
