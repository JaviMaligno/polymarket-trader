/**
 * TypeScript wrapper for the Python Bayesian Optimizer
 *
 * Communicates with the Python FastAPI server to perform
 * Bayesian optimization for signal weight tuning.
 */

import pino from 'pino';

const logger = pino({ name: 'BayesianOptimizer' });

// ============================================
// Types
// ============================================

export interface SignalBounds {
  signalId: string;
  minWeight: number;
  maxWeight: number;
  initialWeight: number;
}

export interface OptimizerConfig {
  /** Base URL of the Python optimizer server */
  serverUrl: string;
  /** Signal bounds configuration */
  signalBounds: SignalBounds[];
  /** Number of optimization calls */
  nCalls?: number;
  /** Number of initial random points */
  nInitialPoints?: number;
}

export interface OptimizationResult {
  bestWeights: Record<string, number>;
  bestScore: number;
  nIterations: number;
  convergenceHistory: number[];
  allWeights: Record<string, number>[];
  allScores: number[];
}

export interface OptimizerStatistics {
  nEvaluations: number;
  bestScore: number | null;
  avgScore: number | null;
  scoreStd: number | null;
  recentTrend?: number;
}

export interface CombinerPrediction {
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  strength: number;
  confidence: number;
  predictedEdge: number;
  featureImportance: Record<string, number>;
}

export interface SignalFeaturesInput {
  signalId: string;
  marketId: string;
  timestamp: string;
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  strength: number;
  confidence: number;
  features?: number[];
}

export interface TrainingExample {
  signals: SignalFeaturesInput[];
  marketId: string;
  timestamp: string;
  actualOutcome: number;
  pnl: number;
}

// API response types
interface HealthResponse {
  status: string;
}

interface CreateOptimizerResponse {
  optimizer_id: string;
  signal_ids: string[];
  initial_weights: Record<string, number>;
}

interface EvaluateResponse {
  recorded: boolean;
  should_update: boolean;
  statistics: {
    n_evaluations: number;
    best_score: number | null;
    avg_score: number | null;
    score_std: number | null;
    recent_trend?: number;
  };
}

interface SuggestResponse {
  suggestions: Record<string, number>[];
  best_weights: Record<string, number>;
}

interface BestWeightsResponse {
  best_weights: Record<string, number>;
  statistics: {
    n_evaluations: number;
    best_score: number | null;
    avg_score: number | null;
    score_std: number | null;
    recent_trend?: number;
  };
}

interface TrainCombinerResponse {
  combiner_id: string;
  metrics: Record<string, number>;
  model_path: string;
}

interface PredictResponse {
  direction: string;
  strength: number;
  confidence: number;
  predicted_edge: number;
  feature_importance: Record<string, number>;
}

interface UpdateCombinerResponse {
  combiner_id: string;
  metrics: Record<string, number>;
  updated: boolean;
}

interface FeatureImportanceResponse {
  combiner_id: string;
  feature_importance: Record<string, number>;
}

// ============================================
// Bayesian Optimizer Client
// ============================================

export class BayesianOptimizerClient {
  private serverUrl: string;
  private optimizerId: string | null = null;
  private signalBounds: SignalBounds[];

  constructor(config: OptimizerConfig) {
    this.serverUrl = config.serverUrl.replace(/\/$/, '');
    this.signalBounds = config.signalBounds;
  }

  /**
   * Check if the optimizer server is healthy
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.serverUrl}/health`);
      const data = await response.json() as HealthResponse;
      return data.status === 'healthy';
    } catch (error) {
      logger.error({ error }, 'Health check failed');
      return false;
    }
  }

  /**
   * Create a new optimizer session
   */
  async create(): Promise<string> {
    const response = await fetch(`${this.serverUrl}/optimizer/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        signal_bounds: this.signalBounds.map(b => ({
          signal_id: b.signalId,
          min_weight: b.minWeight,
          max_weight: b.maxWeight,
          initial_weight: b.initialWeight,
        })),
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to create optimizer: ${response.statusText}`);
    }

    const data = await response.json() as CreateOptimizerResponse;
    this.optimizerId = data.optimizer_id;
    logger.info({ optimizerId: this.optimizerId }, 'Optimizer created');

    return this.optimizerId;
  }

  /**
   * Record a weight/score evaluation
   */
  async recordEvaluation(
    weights: Record<string, number>,
    score: number
  ): Promise<{ shouldUpdate: boolean; statistics: OptimizerStatistics }> {
    if (!this.optimizerId) {
      throw new Error('Optimizer not created. Call create() first.');
    }

    const response = await fetch(`${this.serverUrl}/optimizer/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        optimizer_id: this.optimizerId,
        weights,
        score,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to record evaluation: ${response.statusText}`);
    }

    const data = await response.json() as EvaluateResponse;
    return {
      shouldUpdate: data.should_update,
      statistics: {
        nEvaluations: data.statistics.n_evaluations,
        bestScore: data.statistics.best_score,
        avgScore: data.statistics.avg_score,
        scoreStd: data.statistics.score_std,
        recentTrend: data.statistics.recent_trend,
      },
    };
  }

  /**
   * Get next weight suggestions
   */
  async suggest(nSuggestions: number = 1): Promise<Record<string, number>[]> {
    if (!this.optimizerId) {
      throw new Error('Optimizer not created. Call create() first.');
    }

    const response = await fetch(`${this.serverUrl}/optimizer/suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        optimizer_id: this.optimizerId,
        n_suggestions: nSuggestions,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to get suggestions: ${response.statusText}`);
    }

    const data = await response.json() as SuggestResponse;
    return data.suggestions;
  }

  /**
   * Get the best weights found so far
   */
  async getBestWeights(): Promise<{
    bestWeights: Record<string, number>;
    statistics: OptimizerStatistics;
  }> {
    if (!this.optimizerId) {
      throw new Error('Optimizer not created. Call create() first.');
    }

    const response = await fetch(
      `${this.serverUrl}/optimizer/${this.optimizerId}/best`
    );

    if (!response.ok) {
      throw new Error(`Failed to get best weights: ${response.statusText}`);
    }

    const data = await response.json() as BestWeightsResponse;
    return {
      bestWeights: data.best_weights,
      statistics: {
        nEvaluations: data.statistics.n_evaluations,
        bestScore: data.statistics.best_score,
        avgScore: data.statistics.avg_score,
        scoreStd: data.statistics.score_std,
        recentTrend: data.statistics.recent_trend,
      },
    };
  }

  /**
   * Delete the optimizer
   */
  async delete(): Promise<void> {
    if (!this.optimizerId) return;

    await fetch(`${this.serverUrl}/optimizer/${this.optimizerId}`, {
      method: 'DELETE',
    });

    this.optimizerId = null;
  }

  /**
   * Get the optimizer ID
   */
  getOptimizerId(): string | null {
    return this.optimizerId;
  }
}

// ============================================
// ML Combiner Client
// ============================================

export class MLCombinerClient {
  private serverUrl: string;
  private combinerId: string | null = null;

  constructor(serverUrl: string) {
    this.serverUrl = serverUrl.replace(/\/$/, '');
  }

  /**
   * Train a new ML combiner
   */
  async train(
    signalIds: string[],
    examples: TrainingExample[],
    modelType: 'xgboost' | 'ensemble' = 'xgboost'
  ): Promise<{
    combinerId: string;
    metrics: Record<string, number>;
  }> {
    const response = await fetch(`${this.serverUrl}/combiner/train`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        signal_ids: signalIds,
        model_type: modelType,
        examples: examples.map(e => ({
          signals: e.signals.map(s => ({
            signal_id: s.signalId,
            market_id: s.marketId,
            timestamp: s.timestamp,
            direction: s.direction,
            strength: s.strength,
            confidence: s.confidence,
            features: s.features || [],
          })),
          market_id: e.marketId,
          timestamp: e.timestamp,
          actual_outcome: e.actualOutcome,
          pnl: e.pnl,
        })),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to train combiner: ${error}`);
    }

    const data = await response.json() as TrainCombinerResponse;
    this.combinerId = data.combiner_id;

    logger.info({ combinerId: this.combinerId, metrics: data.metrics }, 'Combiner trained');

    return {
      combinerId: data.combiner_id,
      metrics: data.metrics,
    };
  }

  /**
   * Get prediction from the combiner
   */
  async predict(signals: SignalFeaturesInput[]): Promise<CombinerPrediction> {
    if (!this.combinerId) {
      throw new Error('Combiner not trained. Call train() first.');
    }

    const response = await fetch(`${this.serverUrl}/combiner/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        combiner_id: this.combinerId,
        signals: signals.map(s => ({
          signal_id: s.signalId,
          market_id: s.marketId,
          timestamp: s.timestamp,
          direction: s.direction,
          strength: s.strength,
          confidence: s.confidence,
          features: s.features || [],
        })),
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to get prediction: ${response.statusText}`);
    }

    const data = await response.json() as PredictResponse;
    return {
      direction: data.direction as 'LONG' | 'SHORT' | 'NEUTRAL',
      strength: data.strength,
      confidence: data.confidence,
      predictedEdge: data.predicted_edge,
      featureImportance: data.feature_importance,
    };
  }

  /**
   * Update combiner with new training data
   */
  async update(
    signalIds: string[],
    newExamples: TrainingExample[]
  ): Promise<Record<string, number>> {
    if (!this.combinerId) {
      throw new Error('Combiner not trained. Call train() first.');
    }

    const response = await fetch(
      `${this.serverUrl}/combiner/${this.combinerId}/update`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signal_ids: signalIds,
          examples: newExamples.map(e => ({
            signals: e.signals.map(s => ({
              signal_id: s.signalId,
              market_id: s.marketId,
              timestamp: s.timestamp,
              direction: s.direction,
              strength: s.strength,
              confidence: s.confidence,
              features: s.features || [],
            })),
            market_id: e.marketId,
            timestamp: e.timestamp,
            actual_outcome: e.actualOutcome,
            pnl: e.pnl,
          })),
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to update combiner: ${response.statusText}`);
    }

    const data = await response.json() as UpdateCombinerResponse;
    return data.metrics;
  }

  /**
   * Get feature importance
   */
  async getFeatureImportance(): Promise<Record<string, number>> {
    if (!this.combinerId) {
      throw new Error('Combiner not trained. Call train() first.');
    }

    const response = await fetch(
      `${this.serverUrl}/combiner/${this.combinerId}/importance`
    );

    if (!response.ok) {
      throw new Error(`Failed to get feature importance: ${response.statusText}`);
    }

    const data = await response.json() as FeatureImportanceResponse;
    return data.feature_importance;
  }

  /**
   * Load an existing combiner by ID
   */
  setCombinerId(combinerId: string): void {
    this.combinerId = combinerId;
  }

  /**
   * Get the combiner ID
   */
  getCombinerId(): string | null {
    return this.combinerId;
  }

  /**
   * Delete the combiner
   */
  async delete(): Promise<void> {
    if (!this.combinerId) return;

    await fetch(`${this.serverUrl}/combiner/${this.combinerId}`, {
      method: 'DELETE',
    });

    this.combinerId = null;
  }
}

// ============================================
// Factory Functions
// ============================================

/**
 * Create a Bayesian optimizer client
 */
export function createOptimizerClient(config: OptimizerConfig): BayesianOptimizerClient {
  return new BayesianOptimizerClient(config);
}

/**
 * Create an ML combiner client
 */
export function createCombinerClient(serverUrl: string): MLCombinerClient {
  return new MLCombinerClient(serverUrl);
}

/**
 * Default optimizer server URL
 */
export const DEFAULT_OPTIMIZER_URL = 'http://localhost:8000';
