/**
 * Optimization Scheduler Service
 *
 * Runs automated optimization on a schedule:
 * - Every 6h: Quick incremental optimization (5 iterations)
 * - Every 24h: Full optimization (10 iterations)
 *
 * Uses Optuna Bayesian optimization (TPE sampler) when OPTIMIZER_URL is set,
 * otherwise falls back to grid/random search over 2 parameters.
 *
 * When better parameters are found, automatically updates the active strategy.
 */

import { query, isDatabaseConfigured } from '../database/index.js';
import { getBacktestService, BacktestService, type BacktestRequest } from './BacktestService.js';
import { getValidationService, type ValidationService } from './ValidationService.js';
import { getTradingAutomation } from './TradingAutomation.js';
import { OptunaClient, type ParameterDef } from './OptunaClient.js';

// ============================================================
// Legacy grid-search parameter ranges (fallback when no OPTIMIZER_URL)
// ============================================================
const PARAMETER_RANGES = {
  minEdge: { min: 0.005, max: 0.05, step: 0.005 },
  minConfidence: { min: 0.15, max: 0.45, step: 0.05 },
};

const DEFAULT_BEST_PARAMS = {
  minEdge: 0.01,
  minConfidence: 0.25,
};

// ============================================================
// Optuna 12-parameter space
// ============================================================
const OPTUNA_PARAM_SPACE: ParameterDef[] = [
  // Combiner thresholds - MORE CONSERVATIVE
  { name: 'combiner.minCombinedConfidence', type: 'float', low: 0.25, high: 0.65 },
  { name: 'combiner.minCombinedStrength', type: 'float', low: 0.20, high: 0.60 },
  { name: 'combiner.onlyDirection', type: 'categorical', choices: [null, 'LONG', 'SHORT'] },
  { name: 'combiner.momentumWeight', type: 'float', low: 0.2, high: 1.5 },
  { name: 'combiner.meanReversionWeight', type: 'float', low: 0.2, high: 1.5 },
  // Risk - slightly tighter
  { name: 'risk.maxPositionSizePct', type: 'float', low: 3.0, high: 15.0 },
  { name: 'risk.maxPositions', type: 'int', low: 5, high: 15 },
  { name: 'risk.stopLossPct', type: 'float', low: 8.0, high: 30.0 },
  { name: 'risk.takeProfitPct', type: 'float', low: 15.0, high: 80.0 },
  // Momentum signal
  { name: 'momentum.rsiPeriod', type: 'int', low: 10, high: 21 },
  // Mean reversion signal
  { name: 'meanReversion.bollingerPeriod', type: 'int', low: 15, high: 30 },
  { name: 'meanReversion.zScoreThreshold', type: 'float', low: 1.5, high: 2.5 },
];

// ============================================================
// Walk-forward validation configuration
// ============================================================
const WALKFORWARD_CONFIG = {
  /** Total data period in days */
  totalPeriodDays: 30,
  /** Out-of-sample validation period in days */
  oosPeriodDays: 7,
  /** Training period in days (totalPeriodDays - oosPeriodDays) */
  trainingPeriodDays: 23,
  /** Minimum Sharpe ratio on OOS data to approve deployment */
  minOOSSharpe: 0.3,
  /** Maximum drawdown on OOS data */
  maxOOSDrawdown: 0.20,
  /** Minimum trades on OOS period */
  minOOSTrades: 10,
  /** Minimum win rate on OOS period */
  minOOSWinRate: 0.40,
};

interface OptimizationResult {
  params: Record<string, any>;
  sharpe: number;
  totalReturn: number;
  trades: number;
}

interface SchedulerState {
  isRunning: boolean;
  lastIncrementalAt: Date | null;
  lastFullAt: Date | null;
  currentRunType: 'idle' | 'incremental' | 'full';
  bestParams: Record<string, any>;
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
  private optunaClient: OptunaClient | null = null;

  // Schedule configuration
  private incrementalIntervalHours = 6;
  private fullIntervalHours = 24;
  private incrementalIterations = 5;
  private fullIterations = 10;
  private backtestDelayMs = 5000;

  constructor(dashboardApiUrl: string = 'http://localhost:3001') {
    this.backtestService = getBacktestService();
    this.validationService = getValidationService();
    this.dashboardApiUrl = dashboardApiUrl;

    // Initialize Optuna client if URL is configured
    const optimizerUrl = process.env.OPTIMIZER_URL;
    if (optimizerUrl) {
      this.optunaClient = new OptunaClient(optimizerUrl);
      console.log(`[OptimizationScheduler] Optuna mode enabled: ${optimizerUrl}`);
    } else {
      console.log('[OptimizationScheduler] Grid-search fallback mode (set OPTIMIZER_URL for Optuna)');
    }
  }

  async start(): Promise<void> {
    if (this.state.isRunning) {
      console.log('[OptimizationScheduler] Already running');
      return;
    }

    console.log('[OptimizationScheduler] Starting...');
    this.state.isRunning = true;

    await this.loadState();

    this.mainLoopInterval = setInterval(
      () => this.mainLoop().catch(err => console.error('[OptimizationScheduler] Loop error:', err)),
      5 * 60 * 1000
    );

    await this.mainLoop();
    console.log('[OptimizationScheduler] Started');
  }

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

  getState(): SchedulerState {
    return { ...this.state };
  }

  private async mainLoop(): Promise<void> {
    if (!this.state.isRunning || this.state.currentRunType !== 'idle') return;

    const now = new Date();
    if (this.shouldRunFull(now)) {
      await this.runFullOptimization();
    } else if (this.shouldRunIncremental(now)) {
      await this.runIncrementalOptimization();
    }
  }

  private shouldRunIncremental(now: Date): boolean {
    if (!this.state.lastIncrementalAt) return true;
    const hoursSince = (now.getTime() - this.state.lastIncrementalAt.getTime()) / (1000 * 60 * 60);
    return hoursSince >= this.incrementalIntervalHours;
  }

  private shouldRunFull(now: Date): boolean {
    if (!this.state.lastFullAt) return true;
    const hoursSince = (now.getTime() - this.state.lastFullAt.getTime()) / (1000 * 60 * 60);
    return hoursSince >= this.fullIntervalHours;
  }

  private async runIncrementalOptimization(): Promise<void> {
    console.log('[OptimizationScheduler] Starting incremental optimization...');
    this.state.currentRunType = 'incremental';

    try {
      const results = await this.runOptimization(this.incrementalIterations, 'incremental');
      if (results.length === 0) return;

      const best = results.reduce((a, b) => a.sharpe > b.sharpe ? a : b);

      if (best.sharpe > this.state.bestSharpe * 1.05) {
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

  private async runFullOptimization(): Promise<void> {
    console.log('[OptimizationScheduler] Starting full optimization...');
    this.state.currentRunType = 'full';

    try {
      const results = await this.runOptimization(this.fullIterations, 'full');
      if (results.length === 0) return;

      const best = results.reduce((a, b) => a.sharpe > b.sharpe ? a : b);

      if (best.sharpe > this.state.bestSharpe) {
        console.log(`[OptimizationScheduler] Found better params: Sharpe ${best.sharpe.toFixed(2)} vs ${this.state.bestSharpe.toFixed(2)}`);
        await this.updateStrategy(best);
      }

      this.state.lastFullAt = new Date();
      this.state.lastIncrementalAt = new Date();
      console.log('[OptimizationScheduler] Full optimization completed');
    } catch (error) {
      console.error('[OptimizationScheduler] Full optimization failed:', error);
    } finally {
      this.state.currentRunType = 'idle';
      await this.saveState();
    }
  }

  // ============================================================
  // Core optimization dispatcher
  // ============================================================
  private async runOptimization(iterations: number, type: 'incremental' | 'full'): Promise<OptimizationResult[]> {
    if (this.optunaClient) {
      return this.runOptunaOptimization(iterations, type);
    }
    return this.runGridOptimization(iterations, type);
  }

  // ============================================================
  // Optuna Bayesian optimization
  // ============================================================
  private async runOptunaOptimization(iterations: number, type: string): Promise<OptimizationResult[]> {
    const client = this.optunaClient!;
    const results: OptimizationResult[] = [];

    // Wake server (Render cold start)
    console.log('[OptimizationScheduler] Waking Optuna server...');
    const alive = await client.ping();
    if (!alive) {
      console.error('[OptimizationScheduler] Optuna server unreachable, falling back to grid search');
      return this.runGridOptimization(iterations, type as any);
    }

    // Create fresh optimizer for this run
    const optimizerId = await client.createOptimizer(
      `${type}-${new Date().toISOString().slice(0, 10)}`,
      OPTUNA_PARAM_SPACE,
      { sampler: 'tpe', nStartupTrials: Math.min(3, iterations) }
    );

    console.log(`[OptimizationScheduler] Created Optuna optimizer ${optimizerId}, running ${iterations} trials...`);

    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);

    try {
      for (let i = 0; i < iterations; i++) {
        if (i > 0) {
          await new Promise(r => setTimeout(r, this.backtestDelayMs));
        }

        try {
          // 1. Get suggestion from Optuna
          const { trialId, params } = await client.suggest(optimizerId);
          console.log(`[OptimizationScheduler] Trial ${i + 1}/${iterations} (id=${trialId}):`, JSON.stringify(params));

          // 2. Map Optuna params → BacktestRequest
          const request = this.mapOptunaParamsToRequest(params, startDate, endDate);

          // 3. Run backtest
          const backtest = await this.backtestService.runBacktest(request);

          if (backtest.result && backtest.result.metrics) {
            const sharpe = backtest.result.metrics.sharpeRatio || 0;
            const totalReturn = backtest.result.metrics.totalReturn || 0;
            const trades = backtest.result.trades?.length || 0;

            // 4. Report score to Optuna
            await client.report(optimizerId, trialId, sharpe, {
              totalReturn,
              trades,
              maxDrawdown: backtest.result.metrics.maxDrawdown || 0,
            });

            results.push({ params, sharpe, totalReturn, trades });
            console.log(`[OptimizationScheduler] Trial ${i + 1} done: Sharpe=${sharpe.toFixed(2)}, Return=${(totalReturn * 100).toFixed(1)}%, Trades=${trades}`);
          }
        } catch (error) {
          console.error(`[OptimizationScheduler] Trial ${i + 1} failed:`, error);
        }
      }

      // Log best found
      if (results.length > 0) {
        try {
          const best = await client.getBest(optimizerId);
          console.log('[OptimizationScheduler] Optuna best:', best.best_params, 'Score:', best.best_score);
        } catch { /* non-critical */ }

        await this.saveOptimizationRun(type, results, 'optuna_tpe');
      }
    } finally {
      await client.deleteOptimizer(optimizerId);
    }

    return results;
  }

  /**
   * Map flat Optuna params (e.g. "combiner.minCombinedConfidence") → BacktestRequest
   */
  private mapOptunaParamsToRequest(params: Record<string, any>, startDate: Date, endDate: Date): BacktestRequest {
    return {
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      initialCapital: 10000,
      signalTypes: ['momentum', 'mean_reversion'],
      riskConfig: {
        maxPositionSizePct: params['risk.maxPositionSizePct'],
        maxExposurePct: 50,
        stopLossPct: params['risk.stopLossPct'],
        takeProfitPct: params['risk.takeProfitPct'],
        maxPositions: params['risk.maxPositions'],
      },
      signalFilters: {
        minStrength: params['combiner.minCombinedStrength'],
        minConfidence: params['combiner.minCombinedConfidence'],
      },
      momentumConfig: {
        rsiPeriod: params['momentum.rsiPeriod'],
      },
      meanReversionConfig: {
        bbPeriod: params['meanReversion.bollingerPeriod'],
        zScoreThreshold: params['meanReversion.zScoreThreshold'],
      },
      combinerConfig: {
        momentumWeight: params['combiner.momentumWeight'],
        meanReversionWeight: params['combiner.meanReversionWeight'],
        minCombinedConfidence: params['combiner.minCombinedConfidence'],
        minCombinedStrength: params['combiner.minCombinedStrength'],
        onlyDirection: params['combiner.onlyDirection'],
      },
    };
  }

  // ============================================================
  // Legacy grid/random search (fallback)
  // ============================================================
  private async runGridOptimization(iterations: number, type: 'incremental' | 'full'): Promise<OptimizationResult[]> {
    const results: OptimizationResult[] = [];
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);

    const paramCombos = type === 'incremental'
      ? this.generateIncrementalParams()
      : this.generateFullParams();

    const shuffled = paramCombos.sort(() => Math.random() - 0.5).slice(0, iterations);

    console.log(`[OptimizationScheduler] Running ${shuffled.length} grid-search backtests...`);

    for (let i = 0; i < shuffled.length; i++) {
      const params = shuffled[i];

      try {
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, this.backtestDelayMs));
        }

        console.log(`[OptimizationScheduler] Backtest ${i + 1}/${shuffled.length}: edge=${params.minEdge}, conf=${params.minConfidence}`);

        const backtest = await this.backtestService.runBacktest({
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          initialCapital: 10000,
          signalTypes: ['momentum', 'mean_reversion'],
          riskConfig: { maxPositionSizePct: 10, maxExposurePct: 50 },
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
          console.log(`[OptimizationScheduler] Backtest ${i + 1}: Sharpe=${result.sharpe.toFixed(2)}, Return=${(result.totalReturn * 100).toFixed(1)}%`);
        }
      } catch (error) {
        console.error(`[OptimizationScheduler] Backtest ${i + 1} failed:`, params, error);
      }
    }

    if (results.length > 0) {
      await this.saveOptimizationRun(type, results, 'random_search');
    }

    return results;
  }

  private generateIncrementalParams(): Array<{ minEdge: number; minConfidence: number }> {
    const combos: Array<{ minEdge: number; minConfidence: number }> = [];
    const current = this.state.bestParams;
    const baseEdge = current.minEdge ?? DEFAULT_BEST_PARAMS.minEdge;
    const baseConf = current.minConfidence ?? DEFAULT_BEST_PARAMS.minConfidence;

    for (let edgeOffset = -2; edgeOffset <= 2; edgeOffset++) {
      for (let confOffset = -2; confOffset <= 2; confOffset++) {
        const minEdge = Math.max(
          PARAMETER_RANGES.minEdge.min,
          Math.min(PARAMETER_RANGES.minEdge.max, baseEdge + edgeOffset * PARAMETER_RANGES.minEdge.step)
        );
        const minConfidence = Math.max(
          PARAMETER_RANGES.minConfidence.min,
          Math.min(PARAMETER_RANGES.minConfidence.max, baseConf + confOffset * PARAMETER_RANGES.minConfidence.step)
        );
        combos.push({ minEdge: Math.round(minEdge * 100) / 100, minConfidence: Math.round(minConfidence * 100) / 100 });
      }
    }

    return combos;
  }

  private generateFullParams(): Array<{ minEdge: number; minConfidence: number }> {
    const combos: Array<{ minEdge: number; minConfidence: number }> = [];

    for (let edge = PARAMETER_RANGES.minEdge.min; edge <= PARAMETER_RANGES.minEdge.max; edge += PARAMETER_RANGES.minEdge.step) {
      for (let conf = PARAMETER_RANGES.minConfidence.min; conf <= PARAMETER_RANGES.minConfidence.max; conf += PARAMETER_RANGES.minConfidence.step) {
        combos.push({
          minEdge: Math.round(edge * 100) / 100,
          minConfidence: Math.round(conf * 100) / 100,
        });
      }
    }

    return combos;
  }

  // ============================================================
  // Strategy update
  // ============================================================
  private async updateStrategy(result: OptimizationResult): Promise<void> {
    // Sanity checks
    if (result.sharpe > 8) {
      console.log(`[OptimizationScheduler] Extremely high Sharpe ${result.sharpe.toFixed(2)}, proceeding with caution`);
    }
    if (result.trades < 5) {
      console.log(`[OptimizationScheduler] Few trades (${result.trades}), allowing for paper trading`);
    }
    if (result.totalReturn < -0.1) {
      console.log(`[OptimizationScheduler] Negative return (${(result.totalReturn * 100).toFixed(1)}%), skipping deployment`);
      return;
    }

    console.log('[OptimizationScheduler] Deploying optimized strategy...');

    // Update local state
    this.state.bestParams = result.params;
    this.state.bestSharpe = result.sharpe;

    // Save to DB
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

    // Extract minEdge/minConfidence (works for both Optuna and grid params)
    const minEdge = result.params['combiner.minCombinedStrength']
      ?? result.params.minEdge
      ?? DEFAULT_BEST_PARAMS.minEdge;
    const minConfidence = result.params['combiner.minCombinedConfidence']
      ?? result.params.minConfidence
      ?? DEFAULT_BEST_PARAMS.minConfidence;

    // Update active strategy via API
    try {
      const strategiesRes = await fetch(`${this.dashboardApiUrl}/api/strategies`);
      if (!strategiesRes.ok) {
        console.log('[OptimizationScheduler] Could not fetch strategies');
        return;
      }

      const strategiesData = await strategiesRes.json() as { data?: { strategies?: Array<{ id: string; status: string }> } };
      const strategies = strategiesData.data?.strategies || [];

      for (const strategy of strategies) {
        if (strategy.status === 'running') {
          await fetch(`${this.dashboardApiUrl}/api/strategies/${strategy.id}/stop`, { method: 'POST' });
        }
      }

      const createRes = await fetch(`${this.dashboardApiUrl}/api/strategies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'combo',
          name: `auto-opt-${new Date().toISOString().slice(0, 10)}`,
          minEdge,
          minConfidence,
          disableFilters: true,
        }),
      });

      if (createRes.ok) {
        const createData = await createRes.json() as { data?: { id?: string } };
        const strategyId = createData.data?.id;

        if (strategyId) {
          await fetch(`${this.dashboardApiUrl}/api/strategies/${strategyId}/start`, { method: 'POST' });
          console.log(`[OptimizationScheduler] Created and started strategy: ${strategyId}`);

          // Update executor runtime thresholds
          try {
            getTradingAutomation().getExecutor().updateConfig({
              minStrength: minEdge,
              minConfidence,
            });
            console.log(`[OptimizationScheduler] Updated executor: minStrength=${minEdge}, minConfidence=${minConfidence}`);
          } catch (err) {
            console.error('[OptimizationScheduler] Failed to update executor:', err);
          }
        }
      }
    } catch (error) {
      console.error('[OptimizationScheduler] Failed to update strategy:', error);
    }
  }

  // ============================================================
  // Database persistence
  // ============================================================
  private async saveOptimizationRun(type: string, results: OptimizationResult[], optimizerType: string = 'random_search'): Promise<void> {
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
        `Automated ${type} optimization (${optimizerType})`,
        'completed',
        optimizerType,
        results.length,
        'sharpe',
        JSON.stringify(this.optunaClient ? OPTUNA_PARAM_SPACE : PARAMETER_RANGES),
        new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        new Date(),
        best ? JSON.stringify(best.params) : null,
        best?.sharpe || null,
        results.length,
      ]);
    } catch (error) {
      console.error('[OptimizationScheduler] Failed to save optimization run:', error);
    }
  }

  private async loadState(): Promise<void> {
    if (!isDatabaseConfigured()) return;

    try {
      const result = await query<{ best_params: Record<string, any>; best_score: number; completed_at: Date }>(`
        SELECT best_params, best_score, completed_at
        FROM optimization_runs
        WHERE status = 'completed' AND best_score IS NOT NULL
        ORDER BY completed_at DESC
        LIMIT 1
      `);

      if (result.rows.length > 0) {
        const row = result.rows[0];
        if (row.best_params) {
          this.state.bestParams = row.best_params;
          this.state.bestSharpe = row.best_score;
          this.state.lastFullAt = row.completed_at;
        }
      }

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
        bestSharpe: this.state.bestSharpe,
        lastIncremental: this.state.lastIncrementalAt,
        lastFull: this.state.lastFullAt,
        mode: this.optunaClient ? 'optuna' : 'grid',
      });
    } catch (error) {
      console.error('[OptimizationScheduler] Failed to load state:', error);
    }
  }

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
