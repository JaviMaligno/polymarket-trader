/**
 * Strategy Optimizer
 *
 * Main orchestrator for automated strategy optimization.
 * Connects to Python Optuna server, runs backtests, and stores results.
 */

import { pino } from 'pino';
import { v4 as uuidv4 } from 'uuid';
import type { Pool } from 'pg';
import {
  type ParameterDefinition,
  type ParameterValues,
  ParameterSpace,
  FULL_PARAMETER_SPACE,
  MINIMAL_PARAMETER_SPACE,
} from './ParameterSpace.js';
import {
  type ObjectiveConfig,
  type BacktestMetrics,
  evaluateObjective,
  extractMetrics,
  getDefaultObjectiveConfig,
} from './ObjectiveFunctions.js';

const logger = pino({ name: 'StrategyOptimizer' });

// ============================================
// Types
// ============================================

export interface OptimizerServerConfig {
  /** URL of Python Optuna server */
  url: string;
  /** Timeout for requests in ms */
  timeout?: number;
}

export type OptimizerType = 'tpe' | 'cmaes' | 'random' | 'grid';

export interface OptimizationConfig {
  /** Run name for identification */
  name: string;
  /** Description of the run */
  description?: string;
  /** Number of iterations */
  iterations: number;
  /** Optimizer algorithm */
  optimizer: OptimizerType;
  /** Objective function config */
  objective: ObjectiveConfig;
  /** Parameter space to optimize */
  parameterSpace: 'full' | 'minimal' | ParameterDefinition[];
  /** Backtest configuration */
  backtest: {
    startDate: Date;
    endDate: Date;
    initialCapital: number;
    granularityMinutes: number;
    marketIds?: string[];
  };
  /** Mark results as exploration (less important) */
  isExploration?: boolean;
  /** Optional parallel evaluation count */
  parallelEvaluations?: number;
}

export interface OptimizationRunState {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  optimizer_type: OptimizerType;
  total_iterations: number;
  completed_iterations: number;
  best_params: ParameterValues | null;
  best_score: number | null;
  started_at: Date | null;
  completed_at: Date | null;
  error_message?: string;
}

export interface BacktestResultRecord {
  id: string;
  optimization_run_id: string;
  iteration: number;
  params: ParameterValues;
  metrics: BacktestMetrics;
  objective_score: number;
  is_exploration: boolean;
  created_at: Date;
}

// API Response types
interface CreateOptimizerResponse {
  optimizer_id: string;
  sampler: string;
  parameter_space: Record<string, unknown>;
}

interface SuggestResponse {
  trial_id: number;
  params: Record<string, number>;
}

interface BestResponse {
  best_params: Record<string, number>;
  best_score: number | null;
  n_trials: number;
  optimization_history: Array<{ trial: number; value: number }>;
}

// ============================================
// Backtest Runner Interface
// ============================================

export interface IBacktestRunner {
  /**
   * Run a backtest with given parameters
   */
  run(params: ParameterValues, config: OptimizationConfig['backtest']): Promise<{
    metrics: BacktestMetrics;
    trades: unknown[];
    equityCurve: unknown[];
  }>;
}

// ============================================
// Strategy Optimizer
// ============================================

export class StrategyOptimizer {
  private serverConfig: OptimizerServerConfig;
  private db: Pool | null;
  private backtestRunner: IBacktestRunner | null = null;

  private currentRunId: string | null = null;
  private currentOptimizerId: string | null = null;
  private parameterSpace: ParameterSpace;

  constructor(
    serverConfig: OptimizerServerConfig,
    db: Pool | null = null
  ) {
    this.serverConfig = {
      ...serverConfig,
      timeout: serverConfig.timeout ?? 30000,
    };
    this.db = db;
    this.parameterSpace = new ParameterSpace(FULL_PARAMETER_SPACE);
  }

  /**
   * Set the backtest runner
   */
  setBacktestRunner(runner: IBacktestRunner): void {
    this.backtestRunner = runner;
  }

  /**
   * Check if optimizer server is healthy
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.serverConfig.url}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      const data = await response.json() as { status: string };
      return data.status === 'healthy';
    } catch (error) {
      logger.error({ error }, 'Optimizer server health check failed');
      return false;
    }
  }

  /**
   * Start a new optimization run
   */
  async startOptimization(config: OptimizationConfig): Promise<string> {
    // Validate
    if (!this.backtestRunner) {
      throw new Error('BacktestRunner not set. Call setBacktestRunner() first.');
    }

    // Check server health
    const isHealthy = await this.healthCheck();
    if (!isHealthy) {
      throw new Error('Optimizer server is not healthy');
    }

    // Determine parameter space
    let paramDefs: ParameterDefinition[];
    if (config.parameterSpace === 'full') {
      paramDefs = FULL_PARAMETER_SPACE;
    } else if (config.parameterSpace === 'minimal') {
      paramDefs = MINIMAL_PARAMETER_SPACE;
    } else {
      paramDefs = config.parameterSpace;
    }
    this.parameterSpace = new ParameterSpace(paramDefs);

    // Create run in database
    const runId = uuidv4();
    this.currentRunId = runId;

    if (this.db) {
      await this.db.query(
        `INSERT INTO optimization_runs (
          id, name, description, status, optimizer_type,
          total_iterations, parameter_space, objective_config, backtest_config
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          runId,
          config.name,
          config.description || null,
          'running',
          config.optimizer,
          config.iterations,
          JSON.stringify(this.parameterSpace.toOptunaFormat()),
          JSON.stringify(config.objective),
          JSON.stringify(config.backtest),
        ]
      );
    }

    // Create optimizer session on Python server
    const createResponse = await fetch(`${this.serverConfig.url}/optimizer/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sampler: config.optimizer,
        parameter_space: this.parameterSpace.toOptunaFormat(),
        direction: 'maximize',
        study_name: config.name,
      }),
      signal: AbortSignal.timeout(this.serverConfig.timeout!),
    });

    if (!createResponse.ok) {
      const error = await createResponse.text();
      throw new Error(`Failed to create optimizer: ${error}`);
    }

    const createData = await createResponse.json() as CreateOptimizerResponse;
    this.currentOptimizerId = createData.optimizer_id;

    logger.info({
      runId,
      optimizerId: this.currentOptimizerId,
      iterations: config.iterations,
      optimizer: config.optimizer,
    }, 'Optimization started');

    return runId;
  }

  /**
   * Run the optimization loop
   */
  async runOptimization(config: OptimizationConfig): Promise<OptimizationRunState> {
    const runId = await this.startOptimization(config);

    let bestScore: number | null = null;
    let bestParams: ParameterValues | null = null;
    let completedIterations = 0;

    try {
      for (let i = 0; i < config.iterations; i++) {
        // Get next parameters from Optuna
        const suggestResponse = await fetch(`${this.serverConfig.url}/optimizer/suggest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            optimizer_id: this.currentOptimizerId,
          }),
          signal: AbortSignal.timeout(this.serverConfig.timeout!),
        });

        if (!suggestResponse.ok) {
          throw new Error(`Failed to get suggestion: ${await suggestResponse.text()}`);
        }

        const { trial_id, params: flatParams } = await suggestResponse.json() as SuggestResponse;

        // Parse flat params into nested structure
        const params = this.parameterSpace.parseParams(flatParams);

        // Run backtest
        const backtestResult = await this.backtestRunner!.run(params, config.backtest);

        // Extract metrics and calculate objective
        const metrics = extractMetrics(backtestResult.metrics);
        const score = evaluateObjective(metrics, config.objective);

        // Report result to Optuna
        await fetch(`${this.serverConfig.url}/optimizer/report`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            optimizer_id: this.currentOptimizerId,
            trial_id,
            value: score,
          }),
          signal: AbortSignal.timeout(this.serverConfig.timeout!),
        });

        // Store result in database
        if (this.db) {
          await this.db.query(
            `INSERT INTO backtest_results (
              id, optimization_run_id, iteration, params,
              total_return, sharpe_ratio, max_drawdown, win_rate,
              profit_factor, total_trades, objective_score, is_exploration
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
              uuidv4(),
              runId,
              i + 1,
              JSON.stringify(params),
              metrics.totalReturn,
              metrics.sharpeRatio,
              metrics.maxDrawdown,
              metrics.winRate,
              metrics.profitFactor,
              metrics.totalTrades,
              score,
              config.isExploration ?? false,
            ]
          );
        }

        // Track best
        if (bestScore === null || score > bestScore) {
          bestScore = score;
          bestParams = params;

          // Update run with best params
          if (this.db) {
            await this.db.query(
              `UPDATE optimization_runs SET
                best_params = $1, best_score = $2, completed_iterations = $3
              WHERE id = $4`,
              [JSON.stringify(bestParams), bestScore, i + 1, runId]
            );
          }
        }

        completedIterations = i + 1;

        // Log progress
        if ((i + 1) % 10 === 0 || i === 0) {
          logger.info({
            iteration: i + 1,
            totalIterations: config.iterations,
            currentScore: score,
            bestScore,
            metrics: {
              return: (metrics.totalReturn * 100).toFixed(2) + '%',
              sharpe: metrics.sharpeRatio.toFixed(2),
              trades: metrics.totalTrades,
            },
          }, 'Optimization progress');
        }
      }

      // Mark as completed
      if (this.db) {
        await this.db.query(
          `UPDATE optimization_runs SET
            status = 'completed', completed_at = NOW(),
            completed_iterations = $1, best_params = $2, best_score = $3
          WHERE id = $4`,
          [completedIterations, JSON.stringify(bestParams), bestScore, runId]
        );
      }

      logger.info({
        runId,
        completedIterations,
        bestScore,
      }, 'Optimization completed');

      return {
        id: runId,
        name: config.name,
        status: 'completed',
        optimizer_type: config.optimizer,
        total_iterations: config.iterations,
        completed_iterations: completedIterations,
        best_params: bestParams,
        best_score: bestScore,
        started_at: new Date(),
        completed_at: new Date(),
      };
    } catch (error) {
      // Mark as failed
      const errorMsg = error instanceof Error ? error.message : String(error);

      if (this.db) {
        await this.db.query(
          `UPDATE optimization_runs SET
            status = 'failed', error_message = $1, completed_at = NOW()
          WHERE id = $2`,
          [errorMsg, runId]
        );
      }

      logger.error({ error, runId }, 'Optimization failed');

      return {
        id: runId,
        name: config.name,
        status: 'failed',
        optimizer_type: config.optimizer,
        total_iterations: config.iterations,
        completed_iterations: completedIterations,
        best_params: bestParams,
        best_score: bestScore,
        started_at: new Date(),
        completed_at: new Date(),
        error_message: errorMsg,
      };
    }
  }

  /**
   * Get best parameters from current or completed run
   */
  async getBestParams(): Promise<{
    params: ParameterValues;
    score: number;
    nTrials: number;
  } | null> {
    if (!this.currentOptimizerId) {
      return null;
    }

    const response = await fetch(
      `${this.serverConfig.url}/optimizer/${this.currentOptimizerId}/best`,
      { signal: AbortSignal.timeout(this.serverConfig.timeout!) }
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json() as BestResponse;

    if (data.best_score === null) {
      return null;
    }

    return {
      params: this.parameterSpace.parseParams(data.best_params),
      score: data.best_score,
      nTrials: data.n_trials,
    };
  }

  /**
   * Get optimization run state from database
   */
  async getRunState(runId: string): Promise<OptimizationRunState | null> {
    if (!this.db) {
      return null;
    }

    const result = await this.db.query(
      `SELECT * FROM optimization_runs WHERE id = $1`,
      [runId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      optimizer_type: row.optimizer_type,
      total_iterations: row.total_iterations,
      completed_iterations: row.completed_iterations,
      best_params: row.best_params,
      best_score: row.best_score,
      started_at: row.started_at,
      completed_at: row.completed_at,
      error_message: row.error_message,
    };
  }

  /**
   * Get all results for a run
   */
  async getRunResults(runId: string): Promise<BacktestResultRecord[]> {
    if (!this.db) {
      return [];
    }

    const result = await this.db.query(
      `SELECT * FROM backtest_results
       WHERE optimization_run_id = $1
       ORDER BY iteration`,
      [runId]
    );

    return result.rows.map(row => ({
      id: row.id,
      optimization_run_id: row.optimization_run_id,
      iteration: row.iteration,
      params: row.params,
      metrics: {
        totalReturn: row.total_return,
        sharpeRatio: row.sharpe_ratio,
        maxDrawdown: row.max_drawdown,
        winRate: row.win_rate,
        profitFactor: row.profit_factor,
        totalTrades: row.total_trades,
        averageTradeReturn: 0,
        volatility: 0,
      },
      objective_score: row.objective_score,
      is_exploration: row.is_exploration,
      created_at: row.created_at,
    }));
  }

  /**
   * Cancel current optimization
   */
  async cancel(): Promise<void> {
    if (!this.currentRunId || !this.db) {
      return;
    }

    await this.db.query(
      `UPDATE optimization_runs SET
        status = 'cancelled', completed_at = NOW()
      WHERE id = $1 AND status = 'running'`,
      [this.currentRunId]
    );

    this.currentRunId = null;
    this.currentOptimizerId = null;
  }

  /**
   * List all optimization runs
   */
  async listRuns(options?: {
    status?: OptimizationRunState['status'];
    limit?: number;
  }): Promise<OptimizationRunState[]> {
    if (!this.db) {
      return [];
    }

    let query = 'SELECT * FROM optimization_runs';
    const params: unknown[] = [];

    if (options?.status) {
      query += ' WHERE status = $1';
      params.push(options.status);
    }

    query += ' ORDER BY created_at DESC';

    if (options?.limit) {
      query += ` LIMIT $${params.length + 1}`;
      params.push(options.limit);
    }

    const result = await this.db.query(query, params);

    return result.rows.map(row => ({
      id: row.id,
      name: row.name,
      status: row.status,
      optimizer_type: row.optimizer_type,
      total_iterations: row.total_iterations,
      completed_iterations: row.completed_iterations,
      best_params: row.best_params,
      best_score: row.best_score,
      started_at: row.started_at,
      completed_at: row.completed_at,
      error_message: row.error_message,
    }));
  }

  /**
   * Delete a run and its results
   */
  async deleteRun(runId: string): Promise<boolean> {
    if (!this.db) {
      return false;
    }

    await this.db.query('DELETE FROM backtest_results WHERE optimization_run_id = $1', [runId]);
    const result = await this.db.query('DELETE FROM optimization_runs WHERE id = $1', [runId]);

    return (result.rowCount ?? 0) > 0;
  }
}

// ============================================
// Factory
// ============================================

export function createStrategyOptimizer(
  serverUrl: string = 'http://localhost:8000',
  db: Pool | null = null
): StrategyOptimizer {
  return new StrategyOptimizer({ url: serverUrl }, db);
}
