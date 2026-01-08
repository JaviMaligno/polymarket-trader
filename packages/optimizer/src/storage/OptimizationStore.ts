/**
 * Optimization Store
 *
 * Database access layer for optimization runs and results.
 */

import type { Pool, QueryResultRow } from 'pg';
import type { ParameterValues } from '../core/ParameterSpace.js';
import type { BacktestMetrics } from '../core/ObjectiveFunctions.js';

// ============================================
// Types
// ============================================

export interface OptimizationRun {
  id: string;
  name: string;
  description: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  optimizerType: string;
  totalIterations: number;
  completedIterations: number;
  parameterSpace: Record<string, unknown>;
  objectiveConfig: Record<string, unknown>;
  backtestConfig: Record<string, unknown>;
  bestParams: ParameterValues | null;
  bestScore: number | null;
  errorMessage: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface BacktestResult {
  id: string;
  optimizationRunId: string;
  iteration: number;
  params: ParameterValues;
  totalReturn: number;
  sharpeRatio: number;
  maxDrawdown: number;
  winRate: number;
  profitFactor: number;
  totalTrades: number;
  objectiveScore: number;
  isExploration: boolean;
  createdAt: Date;
}

export interface SavedStrategy {
  id: string;
  name: string;
  description: string | null;
  params: ParameterValues;
  backtestMetrics: BacktestMetrics;
  optimizationRunId: string | null;
  walkForwardPassed: boolean;
  validationMetrics: Record<string, unknown> | null;
  isActive: boolean;
  mode: 'backtest' | 'paper' | 'live';
  activatedAt: Date | null;
  deactivatedAt: Date | null;
  createdAt: Date;
}

// ============================================
// Store Class
// ============================================

export class OptimizationStore {
  private db: Pool;

  constructor(db: Pool) {
    this.db = db;
  }

  // ============================================
  // Optimization Runs
  // ============================================

  async createRun(run: Omit<OptimizationRun, 'createdAt' | 'startedAt' | 'completedAt'>): Promise<OptimizationRun> {
    const result = await this.db.query<QueryResultRow>(
      `INSERT INTO optimization_runs (
        id, name, description, status, optimizer_type,
        total_iterations, completed_iterations, parameter_space,
        objective_config, backtest_config, best_params, best_score, error_message
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *`,
      [
        run.id,
        run.name,
        run.description,
        run.status,
        run.optimizerType,
        run.totalIterations,
        run.completedIterations,
        JSON.stringify(run.parameterSpace),
        JSON.stringify(run.objectiveConfig),
        JSON.stringify(run.backtestConfig),
        run.bestParams ? JSON.stringify(run.bestParams) : null,
        run.bestScore,
        run.errorMessage,
      ]
    );

    return this.mapRun(result.rows[0]);
  }

  async getRun(id: string): Promise<OptimizationRun | null> {
    const result = await this.db.query<QueryResultRow>(
      'SELECT * FROM optimization_runs WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRun(result.rows[0]);
  }

  async updateRun(id: string, updates: Partial<OptimizationRun>): Promise<OptimizationRun | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (updates.status !== undefined) {
      fields.push(`status = $${paramIndex++}`);
      values.push(updates.status);
    }
    if (updates.completedIterations !== undefined) {
      fields.push(`completed_iterations = $${paramIndex++}`);
      values.push(updates.completedIterations);
    }
    if (updates.bestParams !== undefined) {
      fields.push(`best_params = $${paramIndex++}`);
      values.push(JSON.stringify(updates.bestParams));
    }
    if (updates.bestScore !== undefined) {
      fields.push(`best_score = $${paramIndex++}`);
      values.push(updates.bestScore);
    }
    if (updates.errorMessage !== undefined) {
      fields.push(`error_message = $${paramIndex++}`);
      values.push(updates.errorMessage);
    }

    if (updates.status === 'running') {
      fields.push(`started_at = NOW()`);
    }
    if (['completed', 'failed', 'cancelled'].includes(updates.status ?? '')) {
      fields.push(`completed_at = NOW()`);
    }

    if (fields.length === 0) {
      return this.getRun(id);
    }

    values.push(id);
    const result = await this.db.query<QueryResultRow>(
      `UPDATE optimization_runs SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRun(result.rows[0]);
  }

  async listRuns(options?: {
    status?: OptimizationRun['status'];
    limit?: number;
    offset?: number;
  }): Promise<OptimizationRun[]> {
    let query = 'SELECT * FROM optimization_runs';
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (options?.status) {
      conditions.push(`status = $${params.length + 1}`);
      params.push(options.status);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY created_at DESC';

    if (options?.limit) {
      query += ` LIMIT $${params.length + 1}`;
      params.push(options.limit);
    }

    if (options?.offset) {
      query += ` OFFSET $${params.length + 1}`;
      params.push(options.offset);
    }

    const result = await this.db.query<QueryResultRow>(query, params);
    return result.rows.map(row => this.mapRun(row));
  }

  async deleteRun(id: string): Promise<boolean> {
    // Delete results first (foreign key)
    await this.db.query('DELETE FROM backtest_results WHERE optimization_run_id = $1', [id]);

    const result = await this.db.query('DELETE FROM optimization_runs WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  private mapRun(row: QueryResultRow): OptimizationRun {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      status: row.status,
      optimizerType: row.optimizer_type,
      totalIterations: row.total_iterations,
      completedIterations: row.completed_iterations,
      parameterSpace: row.parameter_space,
      objectiveConfig: row.objective_config,
      backtestConfig: row.backtest_config,
      bestParams: row.best_params,
      bestScore: row.best_score,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  }

  // ============================================
  // Backtest Results
  // ============================================

  async saveResult(result: Omit<BacktestResult, 'createdAt'>): Promise<BacktestResult> {
    const dbResult = await this.db.query<QueryResultRow>(
      `INSERT INTO backtest_results (
        id, optimization_run_id, iteration, params,
        total_return, sharpe_ratio, max_drawdown, win_rate,
        profit_factor, total_trades, objective_score, is_exploration
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *`,
      [
        result.id,
        result.optimizationRunId,
        result.iteration,
        JSON.stringify(result.params),
        result.totalReturn,
        result.sharpeRatio,
        result.maxDrawdown,
        result.winRate,
        result.profitFactor,
        result.totalTrades,
        result.objectiveScore,
        result.isExploration,
      ]
    );

    return this.mapResult(dbResult.rows[0]);
  }

  async getResults(runId: string, options?: {
    limit?: number;
    offset?: number;
    orderBy?: 'iteration' | 'objective_score';
    orderDir?: 'asc' | 'desc';
  }): Promise<BacktestResult[]> {
    let query = 'SELECT * FROM backtest_results WHERE optimization_run_id = $1';
    const params: unknown[] = [runId];

    const orderBy = options?.orderBy ?? 'iteration';
    const orderDir = options?.orderDir ?? 'asc';
    query += ` ORDER BY ${orderBy} ${orderDir}`;

    if (options?.limit) {
      query += ` LIMIT $${params.length + 1}`;
      params.push(options.limit);
    }

    if (options?.offset) {
      query += ` OFFSET $${params.length + 1}`;
      params.push(options.offset);
    }

    const result = await this.db.query<QueryResultRow>(query, params);
    return result.rows.map(row => this.mapResult(row));
  }

  async getBestResults(runId: string, limit: number = 10): Promise<BacktestResult[]> {
    return this.getResults(runId, {
      orderBy: 'objective_score',
      orderDir: 'desc',
      limit,
    });
  }

  async getResultStats(runId: string): Promise<{
    count: number;
    avgScore: number;
    maxScore: number;
    minScore: number;
    avgReturn: number;
    avgSharpe: number;
  }> {
    const result = await this.db.query<QueryResultRow>(
      `SELECT
        COUNT(*) as count,
        AVG(objective_score) as avg_score,
        MAX(objective_score) as max_score,
        MIN(objective_score) as min_score,
        AVG(total_return) as avg_return,
        AVG(sharpe_ratio) as avg_sharpe
      FROM backtest_results
      WHERE optimization_run_id = $1`,
      [runId]
    );

    const row = result.rows[0];
    return {
      count: parseInt(row.count, 10),
      avgScore: parseFloat(row.avg_score) || 0,
      maxScore: parseFloat(row.max_score) || 0,
      minScore: parseFloat(row.min_score) || 0,
      avgReturn: parseFloat(row.avg_return) || 0,
      avgSharpe: parseFloat(row.avg_sharpe) || 0,
    };
  }

  private mapResult(row: QueryResultRow): BacktestResult {
    return {
      id: row.id,
      optimizationRunId: row.optimization_run_id,
      iteration: row.iteration,
      params: row.params,
      totalReturn: row.total_return,
      sharpeRatio: row.sharpe_ratio,
      maxDrawdown: row.max_drawdown,
      winRate: row.win_rate,
      profitFactor: row.profit_factor,
      totalTrades: row.total_trades,
      objectiveScore: row.objective_score,
      isExploration: row.is_exploration,
      createdAt: row.created_at,
    };
  }

  // ============================================
  // Saved Strategies
  // ============================================

  async saveStrategy(strategy: Omit<SavedStrategy, 'createdAt'>): Promise<SavedStrategy> {
    const result = await this.db.query<QueryResultRow>(
      `INSERT INTO saved_strategies (
        id, name, description, params, backtest_metrics,
        optimization_run_id, walk_forward_passed, validation_metrics,
        is_active, mode, activated_at, deactivated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *`,
      [
        strategy.id,
        strategy.name,
        strategy.description,
        JSON.stringify(strategy.params),
        JSON.stringify(strategy.backtestMetrics),
        strategy.optimizationRunId,
        strategy.walkForwardPassed,
        strategy.validationMetrics ? JSON.stringify(strategy.validationMetrics) : null,
        strategy.isActive,
        strategy.mode,
        strategy.activatedAt,
        strategy.deactivatedAt,
      ]
    );

    return this.mapStrategy(result.rows[0]);
  }

  async getStrategy(id: string): Promise<SavedStrategy | null> {
    const result = await this.db.query<QueryResultRow>(
      'SELECT * FROM saved_strategies WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapStrategy(result.rows[0]);
  }

  async getStrategyByName(name: string): Promise<SavedStrategy | null> {
    const result = await this.db.query<QueryResultRow>(
      'SELECT * FROM saved_strategies WHERE name = $1',
      [name]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapStrategy(result.rows[0]);
  }

  async getActiveStrategy(mode: SavedStrategy['mode']): Promise<SavedStrategy | null> {
    const result = await this.db.query<QueryResultRow>(
      'SELECT * FROM saved_strategies WHERE is_active = true AND mode = $1',
      [mode]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapStrategy(result.rows[0]);
  }

  async activateStrategy(id: string, mode: SavedStrategy['mode']): Promise<SavedStrategy | null> {
    // Deactivate any currently active strategy for this mode
    await this.db.query(
      `UPDATE saved_strategies SET is_active = false, deactivated_at = NOW()
       WHERE mode = $1 AND is_active = true`,
      [mode]
    );

    // Activate the new strategy
    const result = await this.db.query<QueryResultRow>(
      `UPDATE saved_strategies SET is_active = true, mode = $1, activated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [mode, id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapStrategy(result.rows[0]);
  }

  async deactivateStrategy(id: string): Promise<SavedStrategy | null> {
    const result = await this.db.query<QueryResultRow>(
      `UPDATE saved_strategies SET is_active = false, deactivated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapStrategy(result.rows[0]);
  }

  async listStrategies(options?: {
    isActive?: boolean;
    mode?: SavedStrategy['mode'];
    limit?: number;
  }): Promise<SavedStrategy[]> {
    let query = 'SELECT * FROM saved_strategies';
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (options?.isActive !== undefined) {
      conditions.push(`is_active = $${params.length + 1}`);
      params.push(options.isActive);
    }

    if (options?.mode) {
      conditions.push(`mode = $${params.length + 1}`);
      params.push(options.mode);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY created_at DESC';

    if (options?.limit) {
      query += ` LIMIT $${params.length + 1}`;
      params.push(options.limit);
    }

    const result = await this.db.query<QueryResultRow>(query, params);
    return result.rows.map(row => this.mapStrategy(row));
  }

  async deleteStrategy(id: string): Promise<boolean> {
    const result = await this.db.query('DELETE FROM saved_strategies WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  private mapStrategy(row: QueryResultRow): SavedStrategy {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      params: row.params,
      backtestMetrics: row.backtest_metrics,
      optimizationRunId: row.optimization_run_id,
      walkForwardPassed: row.walk_forward_passed,
      validationMetrics: row.validation_metrics,
      isActive: row.is_active,
      mode: row.mode,
      activatedAt: row.activated_at,
      deactivatedAt: row.deactivated_at,
      createdAt: row.created_at,
    };
  }
}

// ============================================
// Factory
// ============================================

export function createOptimizationStore(db: Pool): OptimizationStore {
  return new OptimizationStore(db);
}
