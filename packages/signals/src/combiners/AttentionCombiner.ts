/**
 * Attention-Based Signal Combiner
 *
 * Uses a transformer-style attention mechanism to dynamically
 * weight signals based on market context and regime.
 */

import type {
  SignalOutput,
  SignalDirection,
  SignalContext,
} from '../core/types/signal.types.js';
import { MarketRegime } from '../regime/types.js';

/**
 * Attention Combiner Configuration
 */
export interface AttentionCombinerConfig {
  /** Dimension of the query/key/value vectors */
  embedDim: number;
  /** Number of attention heads */
  numHeads: number;
  /** Dropout rate for regularization (0-1) */
  dropout: number;
  /** Temperature for attention softmax (lower = sharper focus) */
  temperature: number;
  /** Whether to use regime-conditioned attention */
  useRegimeConditioning: boolean;
  /** Whether to use self-attention between signals */
  useSelfAttention: boolean;
  /** Learning rate for online learning */
  learningRate: number;
  /** Minimum weight for any signal */
  minWeight: number;
  /** Maximum weight for any signal */
  maxWeight: number;
}

/** Default attention combiner configuration */
export const DEFAULT_ATTENTION_CONFIG: AttentionCombinerConfig = {
  embedDim: 32,
  numHeads: 4,
  dropout: 0.1,
  temperature: 1.0,
  useRegimeConditioning: true,
  useSelfAttention: true,
  learningRate: 0.01,
  minWeight: 0.05,
  maxWeight: 0.5,
};

/**
 * Signal embedding for attention computation
 */
interface SignalEmbedding {
  signalId: string;
  direction: number; // -1, 0, 1 for SHORT, NEUTRAL, LONG
  confidence: number;
  strength: number;
  regime: number[]; // One-hot encoded regime
  features: number[]; // Additional context features
}

/** MarketRegime string type for internal use */
type MarketRegimeValue = 'bull_low_vol' | 'bull_high_vol' | 'bear_low_vol' | 'bear_high_vol' | 'neutral';

/**
 * Attention weights output
 */
export interface AttentionWeights {
  signalId: string;
  weight: number;
  attentionScore: number;
}

/**
 * Combined signal result with attention info
 */
export interface AttentionCombinedResult extends SignalOutput {
  attentionWeights: AttentionWeights[];
  dominantSignal: string;
  regimeInfluence: number;
}

/**
 * Multi-Head Attention layer
 */
class MultiHeadAttention {
  private numHeads: number;
  private headDim: number;
  private queryWeights: number[][][]; // [head][input_dim][head_dim]
  private keyWeights: number[][][];
  private valueWeights: number[][][];
  private outputWeights: number[][];
  private temperature: number;

  constructor(embedDim: number, numHeads: number, temperature: number = 1.0) {
    this.numHeads = numHeads;
    this.headDim = Math.floor(embedDim / numHeads);
    this.temperature = temperature;

    // Initialize weights with Xavier initialization
    const scale = Math.sqrt(2.0 / (embedDim + this.headDim));

    this.queryWeights = this.initWeights(numHeads, embedDim, this.headDim, scale);
    this.keyWeights = this.initWeights(numHeads, embedDim, this.headDim, scale);
    this.valueWeights = this.initWeights(numHeads, embedDim, this.headDim, scale);

    // Output projection
    this.outputWeights = this.initMatrix(numHeads * this.headDim, embedDim, scale);
  }

  private initWeights(
    heads: number,
    inputDim: number,
    outputDim: number,
    scale: number
  ): number[][][] {
    const weights: number[][][] = [];
    for (let h = 0; h < heads; h++) {
      weights.push(this.initMatrix(inputDim, outputDim, scale));
    }
    return weights;
  }

  private initMatrix(rows: number, cols: number, scale: number): number[][] {
    const matrix: number[][] = [];
    for (let i = 0; i < rows; i++) {
      matrix.push(
        Array(cols)
          .fill(0)
          .map(() => (Math.random() * 2 - 1) * scale)
      );
    }
    return matrix;
  }

  private matmul(vec: number[], matrix: number[][]): number[] {
    const result: number[] = new Array(matrix[0].length).fill(0);
    for (let j = 0; j < matrix[0].length; j++) {
      for (let i = 0; i < vec.length && i < matrix.length; i++) {
        result[j] += vec[i] * matrix[i][j];
      }
    }
    return result;
  }

  /**
   * Softmax with numerical stability
   * FIXED: Handles NaN, Infinity, and edge cases
   */
  private softmax(scores: number[]): number[] {
    if (scores.length === 0) return [];

    // Handle NaN and Infinity in input
    const cleanScores = scores.map((s) => {
      if (!Number.isFinite(s)) return 0;
      return s;
    });

    const maxScore = Math.max(...cleanScores);
    // Prevent overflow/underflow
    const exps = cleanScores.map((s) => {
      const scaled = (s - maxScore) / this.temperature;
      // Clamp to prevent extreme values
      const clamped = Math.max(-700, Math.min(700, scaled));
      return Math.exp(clamped);
    });

    const sumExps = exps.reduce((a, b) => a + b, 0);

    // If all zeros (extreme case), return uniform distribution
    if (sumExps === 0 || !Number.isFinite(sumExps)) {
      return scores.map(() => 1 / scores.length);
    }

    return exps.map((e) => e / sumExps);
  }

  private dot(a: number[], b: number[]): number {
    let sum = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      sum += a[i] * b[i];
    }
    return sum;
  }

  /**
   * Compute attention
   * @param query - Query vector
   * @param keys - Key vectors
   * @param values - Value vectors
   * @returns Attended output and attention weights
   */
  forward(
    query: number[],
    keys: number[][],
    values: number[][]
  ): { output: number[]; weights: number[] } {
    const headOutputs: number[][] = [];
    const allWeights: number[][] = [];

    for (let h = 0; h < this.numHeads; h++) {
      // Project query
      const q = this.matmul(query, this.queryWeights[h]);

      // Project keys and values
      const k = keys.map((key) => this.matmul(key, this.keyWeights[h]));
      const v = values.map((val) => this.matmul(val, this.valueWeights[h]));

      // Compute attention scores
      const scores = k.map((ki) => this.dot(q, ki) / Math.sqrt(this.headDim));

      // Softmax
      const weights = this.softmax(scores);
      allWeights.push(weights);

      // Weighted sum of values
      const headOutput: number[] = new Array(this.headDim).fill(0);
      for (let i = 0; i < weights.length; i++) {
        for (let j = 0; j < this.headDim && j < v[i].length; j++) {
          headOutput[j] += weights[i] * v[i][j];
        }
      }
      headOutputs.push(headOutput);
    }

    // Concatenate heads
    const concat: number[] = headOutputs.flat();

    // Output projection
    const output = this.matmul(concat, this.outputWeights);

    // Average weights across heads
    const avgWeights: number[] = new Array(keys.length).fill(0);
    for (let i = 0; i < keys.length; i++) {
      for (let h = 0; h < this.numHeads; h++) {
        avgWeights[i] += allWeights[h][i] / this.numHeads;
      }
    }

    return { output, weights: avgWeights };
  }

  /**
   * Update weights (for online learning)
   * FIXED: Proper gradient computation with clipping and NaN protection
   */
  updateWeights(
    query: number[],
    keys: number[][],
    targetWeights: number[],
    learningRate: number,
    gradientClip: number = 1.0
  ): void {
    if (keys.length === 0 || targetWeights.length !== keys.length) return;

    const { weights: currentWeights } = this.forward(query, keys, keys);

    // Calculate weight errors
    const errors = targetWeights.map((target, idx) => target - currentWeights[idx]);

    for (let h = 0; h < this.numHeads; h++) {
      // Project query through this head to get Q
      const q = this.matmul(query, this.queryWeights[h]);

      for (let keyIdx = 0; keyIdx < keys.length; keyIdx++) {
        const k = this.matmul(keys[keyIdx], this.keyWeights[h]);
        const error = errors[keyIdx];

        // Skip tiny errors
        if (Math.abs(error) < 1e-6) continue;

        // Gradient for query weights: dL/dWq = error * dWeight/dWq
        // Simplified: update query weights proportionally to error and key alignment
        for (let i = 0; i < this.queryWeights[h].length && i < query.length; i++) {
          for (let j = 0; j < this.queryWeights[h][i].length && j < k.length; j++) {
            // Gradient approximation: error * query[i] * key_projection[j]
            let grad = error * query[i] * k[j] / Math.sqrt(this.headDim);

            // Gradient clipping for stability
            grad = Math.max(-gradientClip, Math.min(gradientClip, grad));

            // NaN protection
            if (!Number.isFinite(grad)) continue;

            this.queryWeights[h][i][j] += learningRate * grad;
          }
        }

        // Also update key weights (bidirectional update)
        for (let i = 0; i < this.keyWeights[h].length && i < keys[keyIdx].length; i++) {
          for (let j = 0; j < this.keyWeights[h][i].length && j < q.length; j++) {
            let grad = error * keys[keyIdx][i] * q[j] / Math.sqrt(this.headDim);

            grad = Math.max(-gradientClip, Math.min(gradientClip, grad));
            if (!Number.isFinite(grad)) continue;

            this.keyWeights[h][i][j] += learningRate * grad;
          }
        }
      }
    }
  }
}

/**
 * Attention-Based Signal Combiner
 *
 * Combines multiple trading signals using attention mechanism:
 * 1. Embeds signals into a common vector space
 * 2. Uses market context as query
 * 3. Computes attention weights over signals
 * 4. Produces weighted combination
 */
export class AttentionCombiner {
  private config: AttentionCombinerConfig;
  private attention: MultiHeadAttention;
  private regimeEmbeddings: Map<MarketRegime, number[]>;
  private signalHistory: Array<{
    signals: SignalOutput[];
    outcome: number;
    regime?: MarketRegime;
  }>;

  constructor(config: Partial<AttentionCombinerConfig> = {}) {
    this.config = { ...DEFAULT_ATTENTION_CONFIG, ...config };

    this.attention = new MultiHeadAttention(
      this.config.embedDim,
      this.config.numHeads,
      this.config.temperature
    );

    // Initialize regime embeddings
    this.regimeEmbeddings = new Map();
    this.initRegimeEmbeddings();

    this.signalHistory = [];
  }

  /**
   * Initialize regime embeddings
   */
  private initRegimeEmbeddings(): void {
    const regimes: MarketRegime[] = [
      MarketRegime.BULL_LOW_VOL,
      MarketRegime.BULL_HIGH_VOL,
      MarketRegime.BEAR_LOW_VOL,
      MarketRegime.BEAR_HIGH_VOL,
      MarketRegime.NEUTRAL,
    ];

    const scale = Math.sqrt(2.0 / this.config.embedDim);

    for (const regime of regimes) {
      const embedding = Array(this.config.embedDim)
        .fill(0)
        .map(() => (Math.random() * 2 - 1) * scale);
      this.regimeEmbeddings.set(regime, embedding);
    }
  }

  /**
   * Convert signal to embedding vector
   */
  private signalToEmbedding(signal: SignalOutput, regime?: MarketRegime): number[] {
    const embedding: number[] = [];

    // Direction encoding (-1, 0, 1)
    const directionValue =
      signal.direction === 'LONG' ? 1 : signal.direction === 'SHORT' ? -1 : 0;
    embedding.push(directionValue);

    // Confidence and strength
    embedding.push(signal.confidence);
    embedding.push(signal.strength);

    // Signal type one-hot (simplified)
    const signalTypes = [
      'momentum',
      'mean_reversion',
      'wallet_tracking',
      'ofi',
      'mlofi',
      'sentiment',
      'event_driven',
      'cross_market_arb',
    ];
    for (const type of signalTypes) {
      embedding.push(signal.signalId === type ? 1 : 0);
    }

    // Regime embedding if available
    if (regime && this.config.useRegimeConditioning) {
      const regimeEmb = this.regimeEmbeddings.get(regime) || [];
      for (let i = 0; i < Math.min(10, regimeEmb.length); i++) {
        embedding.push(regimeEmb[i]);
      }
    } else {
      for (let i = 0; i < 10; i++) {
        embedding.push(0);
      }
    }

    // Pad or truncate to embedDim
    while (embedding.length < this.config.embedDim) {
      embedding.push(0);
    }
    return embedding.slice(0, this.config.embedDim);
  }

  /**
   * Build context query from market state
   */
  private buildContextQuery(
    context?: Partial<SignalContext>,
    regime?: MarketRegime
  ): number[] {
    const query: number[] = [];

    // Price momentum (if available)
    if (context?.priceBars && context.priceBars.length >= 2) {
      const prices = context.priceBars;
      const latestPrice = prices[prices.length - 1].close;
      const prevPrice = prices[prices.length - 2].close;
      const momentum = (latestPrice - prevPrice) / prevPrice;
      query.push(momentum);
    } else {
      query.push(0);
    }

    // Volatility proxy
    if (context?.priceBars && context.priceBars.length >= 10) {
      const returns: number[] = [];
      for (let i = 1; i < context.priceBars.length; i++) {
        const ret =
          (context.priceBars[i].close - context.priceBars[i - 1].close) /
          context.priceBars[i - 1].close;
        returns.push(ret);
      }
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance =
        returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
      query.push(Math.sqrt(variance));
    } else {
      query.push(0.1);
    }

    // Order book imbalance (if available)
    if (context?.orderBook) {
      // Use depth at 10% levels if available
      const bidDepth = context.orderBook.bidDepth10Pct ?? 100;
      const askDepth = context.orderBook.askDepth10Pct ?? 100;
      const totalDepth = bidDepth + askDepth;
      const imbalance = totalDepth > 0 ? (bidDepth - askDepth) / totalDepth : 0;
      query.push(imbalance);
    } else {
      query.push(0);
    }

    // Regime embedding
    if (regime && this.config.useRegimeConditioning) {
      const regimeEmb = this.regimeEmbeddings.get(regime) || [];
      for (let i = 0; i < Math.min(10, regimeEmb.length); i++) {
        query.push(regimeEmb[i]);
      }
    } else {
      for (let i = 0; i < 10; i++) {
        query.push(0);
      }
    }

    // Pad to embedDim
    while (query.length < this.config.embedDim) {
      query.push(0);
    }
    return query.slice(0, this.config.embedDim);
  }

  /**
   * Combine signals using attention
   */
  combine(
    signals: SignalOutput[],
    context?: Partial<SignalContext>,
    regime?: MarketRegime
  ): AttentionCombinedResult | null {
    if (signals.length === 0) return null;

    // Build signal embeddings
    const embeddings = signals.map((s) => this.signalToEmbedding(s, regime));

    // Build context query
    const query = this.buildContextQuery(context, regime);

    // Compute attention
    const { output, weights } = this.attention.forward(query, embeddings, embeddings);

    // FIXED: Validate weights and handle NaN
    const validatedWeights = weights.map((w) =>
      Number.isFinite(w) ? w : 1 / weights.length
    );

    // Clamp weights to [minWeight, maxWeight]
    const clampedWeights = validatedWeights.map((w) =>
      Math.max(this.config.minWeight, Math.min(this.config.maxWeight, w))
    );

    // Normalize to sum to 1
    const totalWeight = clampedWeights.reduce((a, b) => a + b, 0);
    if (totalWeight === 0 || !Number.isFinite(totalWeight)) {
      // Fallback to uniform weights
      const uniform = 1 / signals.length;
      clampedWeights.fill(uniform);
    }
    const normalizedWeights = clampedWeights.map((w) => w / (totalWeight || 1));

    // Combine signals
    let combinedStrength = 0;
    let combinedConfidence = 0;
    let longScore = 0;
    let shortScore = 0;
    let neutralScore = 0;

    const attentionWeights: AttentionWeights[] = [];
    let dominantSignal = '';
    let maxWeight = 0;

    for (let i = 0; i < signals.length; i++) {
      const signal = signals[i];
      const weight = normalizedWeights[i];

      combinedStrength += signal.strength * weight;
      combinedConfidence += signal.confidence * weight;

      if (signal.direction === 'LONG') {
        longScore += weight * signal.confidence;
      } else if (signal.direction === 'SHORT') {
        shortScore += weight * signal.confidence;
      } else {
        neutralScore += weight * signal.confidence;
      }

      attentionWeights.push({
        signalId: signal.signalId,
        weight,
        attentionScore: weights[i],
      });

      if (weight > maxWeight) {
        maxWeight = weight;
        dominantSignal = signal.signalId;
      }
    }

    // Determine direction
    let direction: SignalDirection;
    if (longScore > shortScore && longScore > neutralScore) {
      direction = 'LONG';
    } else if (shortScore > longScore && shortScore > neutralScore) {
      direction = 'SHORT';
    } else {
      direction = 'NEUTRAL';
    }

    // Calculate regime influence
    let regimeInfluence = 0;
    if (regime && this.config.useRegimeConditioning) {
      const regimeEmb = this.regimeEmbeddings.get(regime);
      if (regimeEmb) {
        // Measure how much output aligns with regime embedding
        let dotProduct = 0;
        let outputNorm = 0;
        let regimeNorm = 0;
        for (let i = 0; i < Math.min(output.length, regimeEmb.length); i++) {
          dotProduct += output[i] * regimeEmb[i];
          outputNorm += output[i] * output[i];
          regimeNorm += regimeEmb[i] * regimeEmb[i];
        }
        const normProduct = Math.sqrt(outputNorm) * Math.sqrt(regimeNorm);
        regimeInfluence = normProduct > 0 ? dotProduct / normProduct : 0;
      }
    }

    // Get marketId and tokenId from first signal or context
    const marketId = signals[0]?.marketId || context?.market?.id || 'unknown';
    const tokenId = signals[0]?.tokenId || context?.market?.tokenIdYes || 'unknown';

    return {
      signalId: 'attention_combined',
      marketId,
      tokenId,
      direction,
      strength: Math.abs(combinedStrength),
      confidence: combinedConfidence,
      timestamp: new Date(),
      ttlMs: 5 * 60 * 1000, // 5 minutes
      metadata: {
        numSignals: signals.length,
        regime,
        attentionTemperature: this.config.temperature,
        numHeads: this.config.numHeads,
      },
      attentionWeights,
      dominantSignal,
      regimeInfluence,
    };
  }

  /**
   * Update attention weights based on outcome
   */
  learn(
    signals: SignalOutput[],
    outcome: number,
    regime?: MarketRegime
  ): void {
    if (signals.length === 0) return;

    // Store for history
    this.signalHistory.push({ signals, outcome, regime });

    // Keep history bounded
    if (this.signalHistory.length > 1000) {
      this.signalHistory.shift();
    }

    // Calculate target weights based on outcome
    const targetWeights: number[] = [];
    for (const signal of signals) {
      // Signals that matched outcome direction should get higher weight
      let targetWeight = 0.5;

      const signalDirection =
        signal.direction === 'LONG' ? 1 : signal.direction === 'SHORT' ? -1 : 0;

      if (outcome > 0.01 && signalDirection > 0) {
        targetWeight = 0.7 + signal.confidence * 0.2;
      } else if (outcome < -0.01 && signalDirection < 0) {
        targetWeight = 0.7 + signal.confidence * 0.2;
      } else if (Math.abs(outcome) <= 0.01 && signalDirection === 0) {
        targetWeight = 0.6;
      } else {
        // Wrong direction
        targetWeight = 0.2;
      }

      targetWeights.push(targetWeight);
    }

    // Normalize target weights
    const totalTarget = targetWeights.reduce((a, b) => a + b, 0);
    const normalizedTargets = targetWeights.map((w) => w / totalTarget);

    // Update attention weights
    const embeddings = signals.map((s) => this.signalToEmbedding(s, regime));
    const query = this.buildContextQuery(undefined, regime);

    this.attention.updateWeights(
      query,
      embeddings,
      normalizedTargets,
      this.config.learningRate
    );
  }

  /**
   * Get current performance statistics
   */
  getStats(): {
    historySize: number;
    avgOutcome: number;
    winRate: number;
  } {
    if (this.signalHistory.length === 0) {
      return { historySize: 0, avgOutcome: 0, winRate: 0 };
    }

    const outcomes = this.signalHistory.map((h) => h.outcome);
    const avgOutcome = outcomes.reduce((a, b) => a + b, 0) / outcomes.length;
    const wins = outcomes.filter((o) => o > 0).length;
    const winRate = wins / outcomes.length;

    return {
      historySize: this.signalHistory.length,
      avgOutcome,
      winRate,
    };
  }

  /**
   * Reset the combiner
   */
  reset(): void {
    this.signalHistory = [];
    this.attention = new MultiHeadAttention(
      this.config.embedDim,
      this.config.numHeads,
      this.config.temperature
    );
    this.initRegimeEmbeddings();
  }

  /**
   * Export model state
   */
  exportState(): {
    config: AttentionCombinerConfig;
    regimeEmbeddings: Record<string, number[]>;
  } {
    const regimeEmbs: Record<string, number[]> = {};
    for (const [regime, emb] of this.regimeEmbeddings) {
      regimeEmbs[regime] = emb;
    }

    return {
      config: this.config,
      regimeEmbeddings: regimeEmbs,
    };
  }

  /**
   * Import model state
   */
  importState(state: {
    config?: Partial<AttentionCombinerConfig>;
    regimeEmbeddings?: Record<string, number[]>;
  }): void {
    if (state.config) {
      this.config = { ...this.config, ...state.config };
    }

    if (state.regimeEmbeddings) {
      for (const [regime, emb] of Object.entries(state.regimeEmbeddings)) {
        this.regimeEmbeddings.set(regime as MarketRegime, emb);
      }
    }
  }
}
