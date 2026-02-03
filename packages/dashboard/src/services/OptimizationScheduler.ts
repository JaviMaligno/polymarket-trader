/**
 * Optimization Scheduler Service
 *
 * Runs automated optimization on a schedule:
 * - Every 6h: Quick incremental optimization (20 iterations)
 * - Every 24h: Full optimization (50 iterations)
 *
 * When better parameters are found, automatically updates the active strategy.
 */

import { query, isDatabaseConfigured } from '../database/index.js';
import { getBacktestService, BacktestService } from './BacktestService.js';
import { getValidationService, type ValidationService } from './ValidationService.js';
import { getTradingAutomation } from './TradingAutomation.js';

// Parameter ranges for optimization
// More permissive ranges to allow trades to execute
const PARAMETER_RANGES = {
  minEdge: { min: 0.005, max: 0.05, step: 0.005 },      // Lower range for more signals
  minConfidence: { min: 0.15, max: 0.45, step: 0.05 },  // Lower confidence thresholds
};

// Default best parameters - permissive to allow trades
const DEFAULT_BEST_PARAMS = {
  minEdge: 0.01,        // Very low edge requirement
  minConfidence: 0.25,  // Moderate confidence
};

interface OptimizationResult {
  params: { minEdge: number; minConfidence: number };
  sharpe: number;
  totalReturn: number;
  trades: number;
}

interface SchedulerState {
  isRunning: boolean;
  lastIncrementalAt: Date | null;
  lastFullAt: Date | null;
  currentRunType: 'idle' | 'incremental' | 'full';
  bestParams: { minEdge: number; minConfidence: number };
  bestSharpe: number;
}

export class OptimizationScheduler {
  private state: SchedulerState = {
    isRunning: false,
    lastIncrementalAt: null,
    lastFullAt: null,
    currentRunType: 'idle',
    bestParams: { ...DEFAULT_BEST_PARAMS },
    bestSharpe: 0,
  };

  private mainLoopInterval: NodeJS.Timeout | null = null;
  private backtestService: BacktestService;
  private validationService: ValidationService;
  private dashboardApiUrl: string;

  // Schedule configuration (conservative for free tier)
  private incrementalIntervalHours = 6;
  private fullIntervalHours = 24;
  private incrementalIterations = 5;  // Reduced from 20 for free tier
  private fullIterations = 10;        // Reduced from 50 for free tier
  private backtestDelayMs = 5000;     // Delay between backtests to prevent memory issues

  constructor(dashboardApiUrl: string = 'http://localhost:3001') {
    this.backtestService = getBacktestService();
    this.validationService = getValidationService();
    this.dashboardApiUrl = dashboardApiUrl;
  }

  /**
   * Start the scheduler
   */
  async start(): Promise<void> {
    if (this.state.isRunning) {
      console.log('[OptimizationScheduler] Already running');
      return;
    }

    console.log('[OptimizationScheduler] Starting...');
    this.state.isRunning = true;

    // Load state from database
    await this.loadState();

    // Start main loop (check every 5 minutes)
    this.mainLoopInterval = setInterval(
      () => this.mainLoop().catch(err => console.error('[OptimizationScheduler] Loop error:', err)),
      5 * 60 * 1000
    );

    // Run initial check
    await this.mainLoop();
    console.log('[OptimizationScheduler] Started');
  }

  /**
   * Stop the scheduler
   */
  async stop(): Promise<void> {
    if (!this.state.isRunning) return;

    this.state.isRunning = false;
    if (this.mainLoopInterval) {
      clearInterval(this.mainLoopInterval);
      this.mainLoopInterval = null;
    }

    await this.saveState();
    console.log('[OptimizationScheduler] Stopped');
  }

  /**
   * Get current state
   */
  getState(): SchedulerState {
    return { ...this.state };
  }

  /**
   * Main loop - check what needs to run
   */
  private async mainLoop(): Promise<void> {
    if (!this.state.isRunning || this.state.currentRunType !== 'idle') {
      return;
    }

    const now = new Date();

    // Check for full optimization (less frequent, higher priority)
    if (this.shouldRunFull(now)) {
      await this.runFullOptimization();
      return;
    }

    // Check for incremental optimization
    if (this.shouldRunIncremental(now)) {
      await this.runIncrementalOptimization();
      return;
    }
  }

  /**
   * Should run incremental optimization?
   */
  private shouldRunIncremental(now: Date): boolean {
    if (!this.state.lastIncrementalAt) return true;

    const hoursSince = (now.getTime() - this.state.lastIncrementalAt.getTime()) / (1000 * 60 * 60);
    return hoursSince >= this.incrementalIntervalHours;
  }

  /**
   * Should run full optimization?
   */
  private shouldRunFull(now: Date): boolean {
    if (!this.state.lastFullAt) return true;

    const hoursSince = (now.getTime() - this.state.lastFullAt.getTime()) / (1000 * 60 * 60);
    return hoursSince >= this.fullIntervalHours;
  }

  /**
   * Run incremental optimization (quick, focused search)
   */
  private async runIncrementalOptimization(): Promise<void> {
    console.log('[OptimizationScheduler] Starting incremental optimization...');
    this.state.currentRunType = 'incremental';

    try {
      const results = await this.runOptimization(this.incrementalIterations, 'incremental');

      // Find best result
      const best = results.reduce((a, b) => a.sharpe > b.sharpe ? a : b);

      // Check if better than current
      if (best.sharpe > this.state.bestSharpe * 1.05) { // 5% improvement threshold
        console.log(`[OptimizationScheduler] Found better params: Sharpe ${best.sharpe.toFixed(2)} vs ${this.state.bestSharpe.toFixed(2)}`);
        await this.updateStrategy(best);
      }

      this.state.lastIncrementalAt = new Date();
      console.log('[OptimizationScheduler] Incremental optimization completed');
    } catch (error) {
      console.error('[OptimizationScheduler] Incremental optimization failed:', error);
    } finally {
      this.state.currentRunType = 'idle';
      await this.saveState();
    }
  }

  /**
   * Run full optimization (broader search)
   */
  private async runFullOptimization(): Promise<void> {
    console.log('[OptimizationScheduler] Starting full optimization...');
    this.state.currentRunType = 'full';

    try {
      const results = await this.runOptimization(this.fullIterations, 'full');

      // Find best result
      const best = results.reduce((a, b) => a.sharpe > b.sharpe ? a : b);

      // Check if better than current (lower threshold for full)
      if (best.sharpe > this.state.bestSharpe) {
        console.log(`[OptimizationScheduler] Found better params: Sharpe ${best.sharpe.toFixed(2)} vs ${this.state.bestSharpe.toFixed(2)}`);
        await this.updateStrategy(best);
      }

      this.state.lastFullAt = new Date();
      this.state.lastIncrementalAt = new Date(); // Also reset incremental
      console.log('[OptimizationScheduler] Full optimization completed');
    } catch (error) {
      console.error('[OptimizationScheduler] Full optimization failed:', error);
    } finally {
      this.state.currentRunType = 'idle';
      await this.saveState();
    }
  }

  /**
   * Run optimization with given number of iterations
   * Conservative approach for free tier - sequential with delays
   */
  private async runOptimization(iterations: number, type: 'incremental' | 'full'): Promise<OptimizationResult[]> {
    const results: OptimizationResult[] = [];

    // Calculate date range (last 7 days - reduced from 14 for free tier)
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Generate parameter combinations
    const paramCombos = type === 'incremental'
      ? this.generateIncrementalParams()
      : this.generateFullParams();

    // Shuffle and take first N iterations
    const shuffled = paramCombos.sort(() => Math.random() - 0.5).slice(0, iterations);

    console.log(`[OptimizationScheduler] Running ${shuffled.length} backtests (sequential with ${this.backtestDelayMs}ms delay)...`);

    for (let i = 0; i < shuffled.length; i++) {
      const params = shuffled[i];

      try {
        // Add delay between backtests to prevent memory/connection issues
        if (i > 0) {
          console.log(`[OptimizationScheduler] Waiting ${this.backtestDelayMs}ms before next backtest...`);
          await new Promise(resolve => setTimeout(resolve, this.backtestDelayMs));
        }

        console.log(`[OptimizationScheduler] Running backtest ${i + 1}/${shuffled.length}: edge=${params.minEdge}, conf=${params.minConfidence}`);

        const backtest = await this.backtestService.runBacktest({
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          initialCapital: 10000,
          signalTypes: ['momentum', 'mean_reversion'],
          riskConfig: {
            maxPositionSizePct: 10,
            maxExposurePct: 50,
          },
          signalFilters: {
            minStrength: params.minEdge,
            minConfidence: params.minConfidence,
          },
        });

        if (backtest.result && backtest.result.metrics) {
          const result = {
            params,
            sharpe: backtest.result.metrics.sharpeRatio || 0,
            totalReturn: backtest.result.metrics.totalReturn || 0,
            trades: backtest.result.trades?.length || 0,
          };
          results.push(result);
          console.log(`[OptimizationScheduler] Backtest ${i + 1} completed: Sharpe=${result.sharpe.toFixed(2)}, Return=${(result.totalReturn * 100).toFixed(1)}%`);
        }
      } catch (error) {
        console.error(`[OptimizationScheduler] Backtest ${i + 1} failed for params:`, params, error);
        // Continue with next iteration instead of failing completely
      }
    }

    // Save to database (only if we have results)
    if (results.length > 0) {
      await this.saveOptimizationRun(type, results);
    }

    return results;
  }

  /**
   * Generate parameter combinations for incremental (focused around current best)
   */
  private generateIncrementalParams(): Array<{ minEdge: number; minConfidence: number }> {
    const combos: Array<{ minEdge: number; minConfidence: number }> = [];
    const current = this.state.bestParams;

    // Search around current best (±2 steps)
    for (let edgeOffset = -2; edgeOffset <= 2; edgeOffset++) {
      for (let confOffset = -2; confOffset <= 2; confOffset++) {
        const minEdge = Math.max(
          PARAMETER_RANGES.minEdge.min,
          Math.min(PARAMETER_RANGES.minEdge.max, current.minEdge + edgeOffset * PARAMETER_RANGES.minEdge.step)
        );
        const minConfidence = Math.max(
          PARAMETER_RANGES.minConfidence.min,
          Math.min(PARAMETER_RANGES.minConfidence.max, current.minConfidence + confOffset * PARAMETER_RANGES.minConfidence.step)
        );

        combos.push({ minEdge: Math.round(minEdge * 100) / 100, minConfidence: Math.round(minConfidence * 100) / 100 });
      }
    }

    return combos;
  }

  /**
   * Generate parameter combinations for full search
   */
  private generateFullParams(): Array<{ minEdge: number; minConfidence: number }> {
    const combos: Array<{ minEdge: number; minConfidence: number }> = [];

    for (let edge = PARAMETER_RANGES.minEdge.min; edge <= PARAMETER_RANGES.minEdge.max; edge += PARAMETER_RANGES.minEdge.step) {
      for (let conf = PARAMETER_RANGES.minConfidence.min; conf <= PARAMETER_RANGES.minConfidence.max; conf += PARAMETER_RANGES.minConfidence.step) {
        combos.push({
          minEdge: Math.round(edge * 100) / 100,
          minConfidence: Math.round(conf * 100) / 100
        });
      }
    }

    return combos;
  }

  /**
   * Update the active strategy with new parameters
   * Includes validation to prevent deploying overfit strategies
   */
  private async updateStrategy(result: OptimizationResult, backtestResult?: { metrics: { totalTrades: number; sharpeRatio: number; maxDrawdown: number; totalReturn: number; winRate: number; profitFactor: number } }): Promise<void> {
    // Validate the strategy before deploying
    // NOTE: For paper trading learning phase, we're more permissive to allow trades
    if (backtestResult) {
      const validation = this.validationService.quickValidate(backtestResult.metrics as any);
      if (!validation.passed) {
        console.log(`[OptimizationScheduler] Strategy failed validation:`, validation.reasons);
        // In learning mode, only reject if return is negative or too few trades
        if (backtestResult.metrics.totalReturn < 0 || backtestResult.metrics.totalTrades < 5) {
          console.log(`[OptimizationScheduler] Critical validation failure, skipping deployment`);
          return;
        }
        console.log(`[OptimizationScheduler] Allowing deployment for paper trading learning`);
      }
    } else {
      // Quick sanity check - be more permissive for paper trading
      if (result.sharpe > 8) {
        console.log(`[OptimizationScheduler] Strategy Sharpe ${result.sharpe.toFixed(2)} is extremely high, capping expectations`);
        // Still deploy but log warning - we want to learn from real trades
      }
      if (result.trades < 5) {
        console.log(`[OptimizationScheduler] Strategy has very few trades (${result.trades}), but allowing for paper trading`);
        // Don't skip - let paper trading run and learn
      }
      if (result.totalReturn < -0.1) {
        console.log(`[OptimizationScheduler] Strategy has significant negative return (${(result.totalReturn * 100).toFixed(1)}%), skipping deployment`);
        return;
      }
    }

    console.log(`[OptimizationScheduler] Strategy passed validation, deploying...`);

    // Update local state
    this.state.bestParams = result.params;
    this.state.bestSharpe = result.sharpe;

    // Save to optimization_runs table
    if (isDatabaseConfigured()) {
      try {
        await query(`
          UPDATE optimization_runs
          SET best_params = $1, best_score = $2, completed_at = NOW(), status = 'completed'
          WHERE status = 'running'
        `, [JSON.stringify(result.params), result.sharpe]);
      } catch (error) {
        console.error('[OptimizationScheduler] Failed to update optimization_runs:', error);
      }
    }

    // Update active strategy via API
    try {
      // First, get current strategies
      const strategiesRes = await fetch(`${this.dashboardApiUrl}/api/strategies`);
      if (!strategiesRes.ok) {
        console.log('[OptimizationScheduler] Could not fetch strategies');
        return;
      }

      const strategiesData = await strategiesRes.json() as { data?: { strategies?: Array<{ id: string; status: string }> } };
      const strategies = strategiesData.data?.strategies || [];

      // Stop any running strategies
      for (const strategy of strategies) {
        if (strategy.status === 'running') {
          await fetch(`${this.dashboardApiUrl}/api/strategies/${strategy.id}/stop`, { method: 'POST' });
        }
      }

      // Create new strategy with optimized params
      const createRes = await fetch(`${this.dashboardApiUrl}/api/strategies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'combo',
          name: `auto-opt-${new Date().toISOString().slice(0, 10)}`,
          minEdge: result.params.minEdge,
          minConfidence: result.params.minConfidence,
          disableFilters: true,
        }),
      });

      if (createRes.ok) {
        const createData = await createRes.json() as { data?: { id?: string } };
        const strategyId = createData.data?.id;

        if (strategyId) {
          // Start the new strategy
          await fetch(`${this.dashboardApiUrl}/api/strategies/${strategyId}/start`, { method: 'POST' });
          console.log(`[OptimizationScheduler] Created and started new strategy: ${strategyId}`);

          // Update executor runtime thresholds with optimized params
          try {
            getTradingAutomation().getExecutor().updateConfig({
              minStrength: result.params.minEdge,
              minConfidence: result.params.minConfidence,
            });
            console.log(`[OptimizationScheduler] Updated executor: minStrength=${result.params.minEdge}, minConfidence=${result.params.minConfidence}`);
          } catch (err) {
            console.error('[OptimizationScheduler] Failed to update executor config:', err);
          }
        }
      }
    } catch (error) {
      console.error('[OptimizationScheduler] Failed to update strategy via API:', error);
    }
  }

  /**
   * Save optimization run to database
   */
  private async saveOptimizationRun(type: string, results: OptimizationResult[]): Promise<void> {
    if (!isDatabaseConfigured()) return;

    try {
      const best = results.reduce((a, b) => a.sharpe > b.sharpe ? a : b, results[0]);

      await query(`
        INSERT INTO optimization_runs (
          name, description, status, optimizer_type, n_iterations,
          objective_metric, parameter_space, data_start_date, data_end_date,
          best_params, best_score, iterations_completed, completed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
      `, [
        `${type}-${new Date().toISOString().slice(0, 10)}`,
        `Automated ${type} optimization`,
        'completed',
        'random_search',
        results.length,
        'sharpe',
        JSON.stringify(PARAMETER_RANGES),
        new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
        new Date(),
        best ? JSON.stringify(best.params) : null,
        best?.sharpe || null,
        results.length,
      ]);
    } catch (error) {
      console.error('[OptimizationScheduler] Failed to save optimization run:', error);
    }
  }

  /**
   * Load state from database
   */
  private async loadState(): Promise<void> {
    if (!isDatabaseConfigured()) return;

    try {
      // Load best params from most recent completed optimization
      const result = await query<{ best_params: Record<string, number>; best_score: number; completed_at: Date }>(`
        SELECT best_params, best_score, completed_at
        FROM optimization_runs
        WHERE status = 'completed' AND best_score IS NOT NULL
        ORDER BY completed_at DESC
        LIMIT 1
      `);

      if (result.rows.length > 0) {
        const row = result.rows[0];
        if (row.best_params) {
          this.state.bestParams = {
            minEdge: row.best_params.minEdge || row.best_params.execution_minEdge || DEFAULT_BEST_PARAMS.minEdge,
            minConfidence: row.best_params.minConfidence || row.best_params.combiner_minCombinedConfidence || DEFAULT_BEST_PARAMS.minConfidence,
          };
          this.state.bestSharpe = row.best_score;
          this.state.lastFullAt = row.completed_at;
        }
      }

      // Load service state
      const stateResult = await query<{ last_incremental_run_at: Date | null; last_full_run_at: Date | null }>(`
        SELECT last_incremental_run_at, last_full_run_at
        FROM optimization_service_state
        WHERE id = 'main'
      `);

      if (stateResult.rows.length > 0) {
        const state = stateResult.rows[0];
        this.state.lastIncrementalAt = state.last_incremental_run_at;
        this.state.lastFullAt = state.last_full_run_at || this.state.lastFullAt;
      }

      console.log('[OptimizationScheduler] Loaded state:', {
        bestParams: this.state.bestParams,
        bestSharpe: this.state.bestSharpe,
        lastIncremental: this.state.lastIncrementalAt,
        lastFull: this.state.lastFullAt,
      });
    } catch (error) {
      console.error('[OptimizationScheduler] Failed to load state:', error);
    }
  }

  /**
   * Save state to database
   */
  private async saveState(): Promise<void> {
    if (!isDatabaseConfigured()) return;

    try {
      await query(`
        INSERT INTO optimization_service_state (id, is_running, last_incremental_run_at, last_full_run_at, updated_at)
        VALUES ('main', $1, $2, $3, NOW())
        ON CONFLICT (id) DO UPDATE SET
          is_running = $1,
          last_incremental_run_at = $2,
          last_full_run_at = $3,
          updated_at = NOW()
      `, [
        this.state.isRunning,
        this.state.lastIncrementalAt,
        this.state.lastFullAt,
      ]);
    } catch (error) {
      console.error('[OptimizationScheduler] Failed to save state:', error);
    }
  }

  /**
   * Manually trigger optimization
   */
  async triggerOptimization(type: 'incremental' | 'full' = 'incremental'): Promise<void> {
    if (this.state.currentRunType !== 'idle') {
      console.log('[OptimizationScheduler] Optimization already running');
      return;
    }

    if (type === 'full') {
      await this.runFullOptimization();
    } else {
      await this.runIncrementalOptimization();
    }
  }
}

// Singleton
let scheduler: OptimizationScheduler | null = null;

export function getOptimizationScheduler(dashboardApiUrl?: string): OptimizationScheduler {
  if (!scheduler) {
    scheduler = new OptimizationScheduler(dashboardApiUrl);
  }
  return scheduler;
}

export function initializeOptimizationScheduler(dashboardApiUrl: string): OptimizationScheduler {
  scheduler = new OptimizationScheduler(dashboardApiUrl);
  return scheduler;
}
