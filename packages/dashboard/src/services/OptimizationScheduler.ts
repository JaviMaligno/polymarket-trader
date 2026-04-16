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
import { signalWeightsRepo } from '../database/repositories.js';
import { getBacktestService, BacktestService, type BacktestRequest } from './BacktestService.js';
import type { MarketData } from '@polymarket-trader/backtest';
import { getValidationService, type ValidationService } from './ValidationService.js';
import { getTradingAutomation } from './TradingAutomation.js';
import { OptunaClient, type ParameterDef } from './OptunaClient.js';
import { checkVMHealth, tryFreeMemory, logHealthStatus } from '../utils/vmHealth.js';

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
// Optuna 17-parameter space
// ============================================================
const OPTUNA_PARAM_SPACE: ParameterDef[] = [
  // Direction multiplier is EXCLUDED from optimization — pinned to -1.0 per validated design spec.
  // Empirical validation: 91.5% accuracy at -1.0 vs 3.7% unflipped (188 trades, Apr 2026).
  // History: optimizer drifted to -0.7819 (Apr 15) and +1.0208 (Apr 14), both causing losses.
  // The value is enforced to -1.0 after each optimization run (see applyOptimizationResult).
  // Combiner thresholds
  { name: 'combiner.minCombinedConfidence', type: 'float', low: 0.25, high: 0.65 },
  { name: 'combiner.minCombinedStrength', type: 'float', low: 0.20, high: 0.60 },
  { name: 'combiner.onlyDirection', type: 'categorical', choices: [null, 'LONG', 'SHORT'] },
  // Signal weights — all active generators
  { name: 'combiner.momentumWeight', type: 'float', low: -1.5, high: 1.5 },
  { name: 'combiner.meanReversionWeight', type: 'float', low: 0.0, high: 2.0 },
  { name: 'combiner.ofiWeight', type: 'float', low: 0.0, high: 2.0 },
  { name: 'combiner.mlofiWeight', type: 'float', low: 0.0, high: 2.0 },
  { name: 'combiner.hawkesWeight', type: 'float', low: 0.0, high: 2.0 },
  // Risk
  { name: 'risk.maxPositionSizePct', type: 'float', low: 3.0, high: 15.0 },
  { name: 'risk.maxPositions', type: 'int', low: 5, high: 15 },
  { name: 'risk.stopLossPct', type: 'float', low: 8.0, high: 30.0 },
  { name: 'risk.takeProfitPct', type: 'float', low: 15.0, high: 80.0 },
  // Signal-specific parameters
  { name: 'momentum.rsiPeriod', type: 'int', low: 10, high: 21 },
  { name: 'meanReversion.bollingerPeriod', type: 'int', low: 15, high: 30 },
  { name: 'meanReversion.zScoreThreshold', type: 'float', low: 1.5, high: 2.5 },
];

/**
 * Reduced parameter space for incremental refinement
 * Only the 8 most impactful parameters
 */
const REFINEMENT_PARAM_SPACE: ParameterDef[] = [
  // direction_multiplier excluded — pinned to -1.0 (see OPTUNA_PARAM_SPACE comment above)
  { name: 'combiner.minCombinedConfidence', type: 'float', low: 0.15, high: 0.65 },
  { name: 'combiner.minCombinedStrength', type: 'float', low: 0.15, high: 0.60 },
  { name: 'combiner.momentumWeight', type: 'float', low: -1.5, high: 1.5 },
  { name: 'combiner.meanReversionWeight', type: 'float', low: 0.0, high: 2.0 },
  { name: 'combiner.ofiWeight', type: 'float', low: 0.0, high: 2.0 },
  { name: 'combiner.mlofiWeight', type: 'float', low: 0.0, high: 2.0 },
  { name: 'combiner.hawkesWeight', type: 'float', low: 0.0, high: 2.0 },
  { name: 'risk.maxPositionSizePct', type: 'float', low: 3.0, high: 15.0 },
  { name: 'risk.stopLossPct', type: 'float', low: 8.0, high: 30.0 },
  { name: 'meanReversion.zScoreThreshold', type: 'float', low: 1.5, high: 2.5 },
];

// ============================================================
// Walk-forward validation configuration
// ============================================================
const WALKFORWARD_CONFIG = {
  /** Total data period in days */
  totalPeriodDays: 14,
  /** Out-of-sample validation period in days */
  oosPeriodDays: 4,
  /** Training period in days (totalPeriodDays - oosPeriodDays) */
  trainingPeriodDays: 10,
};

// Adaptive OOS gate: safety floor (fixed, non-adaptive)
const OOS_SAFETY_FLOOR = {
  /** Minimum OOS Sharpe — reject severely negative */
  minSharpe: -1.0,
  /** Maximum OOS drawdown — reject catastrophic */
  maxDrawdown: 0.50,
  /** Minimum trades in OOS for statistical signal */
  minTrades: 20,
  /** Minimum distinct markets evaluated — prevents apply on tiny universes
   *  where local maxima are statistically meaningless. Triggered by the
   *  2026-04-14 incident where 6 event_financial markets produced
   *  direction_multiplier=+1.0208 (causing 13.5% drawdown). */
  minMarkets: parseInt(process.env.OPTIMIZER_MIN_MARKETS_FOR_APPLY || '8', 10),
};

// Decay factor cold start: used when fewer than 10 runs have OOS data
const DECAY_FACTOR_COLD_START = 0.3;
const DECAY_FACTOR_MIN_ROWS = 10;

// Batch processing configuration for resource management
const BATCH_CONFIG = {
  /** Number of trials per batch */
  batchSize: 5,
  /** Delay between batches in ms */
  batchDelayMs: 30000,
  /** Pause duration when VM is under pressure */
  healthPauseMs: 60000,
};

interface OOSValidationResult {
  passed: boolean;
  sharpeOOS: number;
  drawdownOOS: number;
  tradesOOS: number;
  winRateOOS: number;
  marketsEvaluated: number;
  reason?: string;
}

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
  private keepAliveInterval: NodeJS.Timeout | null = null;
  private backtestService: BacktestService;
  private validationService: ValidationService;
  private dashboardApiUrl: string;
  private optunaClient: OptunaClient | null = null;

  // Schedule configuration
  private incrementalIntervalHours = 6;
  private fullIntervalHours = 168;  // Weekly instead of daily
  private incrementalIterations = 15;  // 3x more for better local search
  private fullIterations = 50;  // 5x more for proper exploration
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

    // Keep Render Optuna server warm to avoid 30-60s cold start per run
    if (this.optunaClient) {
      this.keepAliveInterval = setInterval(() => {
        this.optunaClient!.ping().catch(() => {});
      }, 4 * 60 * 1000); // Every 4 min (Render sleeps after 15 min)
    }

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
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
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
    const hoursSinceIncremental = this.state.lastIncrementalAt
      ? (now.getTime() - this.state.lastIncrementalAt.getTime()) / 3_600_000
      : Infinity;

    if (this.shouldRunFull(now)) {
      await this.runFullOptimization();
    } else if (this.shouldRunIncremental(now)) {
      await this.runIncrementalOptimization();
    } else if (hoursSinceIncremental > 4) {
      // Log when approaching trigger time to confirm interval is alive
      console.log(`[OptimizationScheduler] Tick: ${hoursSinceIncremental.toFixed(1)}h since last incremental (need ${this.incrementalIntervalHours}h)`);
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
    if (hoursSince < this.fullIntervalHours) {
      return false;
    }

    // Prefer nighttime (2-6 UTC) for full optimization to reduce load during active trading
    const hour = now.getUTCHours();
    const isNighttime = hour >= 2 && hour <= 6;

    if (!isNighttime && hoursSince < this.fullIntervalHours + 12) {
      // If not nighttime and we haven't waited too long, defer to nighttime
      return false;
    }

    return true;
  }

  private async runIncrementalOptimization(): Promise<void> {
    console.log('[OptimizationScheduler] Starting incremental optimization...');
    this.state.currentRunType = 'incremental';

    try {
      const results = await this.runOptimization(this.incrementalIterations, 'incremental');
      if (results.length === 0) return;

      const best = results.reduce((a, b) => a.sharpe > b.sharpe ? a : b);

      // Always run OOS validation and persist score (feeds decay factor history)
      await this.runOOSAndPersist(best);

      if (best.sharpe >= this.state.bestSharpe) {
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

      // Always run OOS validation and persist score (feeds decay factor history)
      await this.runOOSAndPersist(best);

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
      // Use refinement space for incremental, full space for full optimization
      const paramSpace = type === 'incremental' ? REFINEMENT_PARAM_SPACE : OPTUNA_PARAM_SPACE;
      return this.runOptunaOptimization(iterations, type, paramSpace);
    }
    return this.runGridOptimization(iterations, type);
  }

  // ============================================================
  // Optuna Bayesian optimization
  // ============================================================
  private async runOptunaOptimization(iterations: number, type: string, paramSpace?: ParameterDef[]): Promise<OptimizationResult[]> {
    const client = this.optunaClient!;
    const runStartedAt = new Date();
    const results: OptimizationResult[] = [];

    // Wake server (Render cold start)
    console.log('[OptimizationScheduler] Waking Optuna server...');
    const alive = await client.ping();
    if (!alive) {
      console.error('[OptimizationScheduler] Optuna server unreachable, falling back to grid search');
      return this.runGridOptimization(iterations, type as any);
    }

    // Create fresh optimizer for this run
    const effectiveParamSpace = paramSpace ?? OPTUNA_PARAM_SPACE;
    const nStartupTrials = Math.ceil(iterations * 0.3);  // 30% random exploration

    const optimizerId = await client.createOptimizer(
      `${type}-${new Date().toISOString().slice(0, 10)}`,
      effectiveParamSpace,
      { sampler: 'tpe', nStartupTrials }
    );

    console.log(`[OptimizationScheduler] Created Optuna optimizer ${optimizerId}, running ${iterations} trials...`);
    console.log(`[OptimizationScheduler] Using ${effectiveParamSpace.length} parameters, ${nStartupTrials} startup trials`);

    // Use training period only (exclude OOS period for honest validation)
    const now = new Date();
    const endDate = new Date(now.getTime() - WALKFORWARD_CONFIG.oosPeriodDays * 24 * 60 * 60 * 1000);
    const startDate = new Date(endDate.getTime() - WALKFORWARD_CONFIG.trainingPeriodDays * 24 * 60 * 60 * 1000);

    console.log(`[OptimizationScheduler] Training period: ${startDate.toISOString().slice(0,10)} to ${endDate.toISOString().slice(0,10)} (${WALKFORWARD_CONFIG.trainingPeriodDays} days)`);

    // Preload backtest data once for all trials (same training period)
    console.log('[OptimizationScheduler] Preloading backtest data...');
    const preloadedData: MarketData[] = await this.backtestService.fetchHistoricalData(startDate, endDate);
    console.log(`[OptimizationScheduler] Preloaded ${preloadedData.length} markets`);

    try {
      let consecutiveFailures = 0;
      const MAX_CONSECUTIVE_FAILURES = 3;

      for (let i = 0; i < iterations; i++) {
        // Health check at start of each batch
        if (i % BATCH_CONFIG.batchSize === 0) {
          const health = checkVMHealth();
          logHealthStatus(health);

          if (health.shouldPause) {
            console.log(`[OptimizationScheduler] VM under pressure, pausing for ${BATCH_CONFIG.healthPauseMs / 1000}s...`);
            tryFreeMemory();
            await new Promise(r => setTimeout(r, BATCH_CONFIG.healthPauseMs));
          } else if (i > 0) {
            // Batch delay between batches (not before first)
            console.log(`[OptimizationScheduler] Batch complete, waiting ${BATCH_CONFIG.batchDelayMs / 1000}s...`);
            tryFreeMemory();
            await new Promise(r => setTimeout(r, BATCH_CONFIG.batchDelayMs));
          }
        }

        if (i > 0 && i % BATCH_CONFIG.batchSize !== 0) {
          await new Promise(r => setTimeout(r, this.backtestDelayMs));
        }

        try {
          // 1. Get suggestion from Optuna
          const { trialId, params } = await client.suggest(optimizerId);
          console.log(`[OptimizationScheduler] Trial ${i + 1}/${iterations} (id=${trialId}):`, JSON.stringify(params));

          // 2. Map Optuna params → BacktestRequest
          const request = this.mapOptunaParamsToRequest(params, startDate, endDate);

          // 3. Run backtest (use preloaded data to skip per-trial DB fetch)
          const backtest = await this.backtestService.runBacktest(request, preloadedData);

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
            consecutiveFailures = 0;
          }
        } catch (error) {
          console.error(`[OptimizationScheduler] Trial ${i + 1} failed:`, error);
          consecutiveFailures++;
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            console.error(`[OptimizationScheduler] ${MAX_CONSECUTIVE_FAILURES} consecutive failures — Optuna server likely down, aborting run`);
            break;
          }
        }
      }

      // Log best found
      if (results.length > 0) {
        try {
          const best = await client.getBest(optimizerId);
          console.log('[OptimizationScheduler] Optuna best:', best.best_params, 'Score:', best.best_score);
        } catch { /* non-critical */ }

        await this.saveOptimizationRun(type, results, 'optuna_tpe', runStartedAt);
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
    const runStartedAt = new Date();
    const results: OptimizationResult[] = [];
    // Use training period only (exclude OOS period)
    const now = new Date();
    const endDate = new Date(now.getTime() - WALKFORWARD_CONFIG.oosPeriodDays * 24 * 60 * 60 * 1000);
    const startDate = new Date(endDate.getTime() - WALKFORWARD_CONFIG.trainingPeriodDays * 24 * 60 * 60 * 1000);

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
      await this.saveOptimizationRun(type, results, 'random_search', runStartedAt);
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
  // Out-of-sample validation
  // ============================================================
  /**
   * Validate parameters on out-of-sample data
   */
  private async validateOnOOS(params: Record<string, any>, isScore: number): Promise<OOSValidationResult> {
    // Gate: don't validate negative in-sample
    if (isScore <= 0) {
      return { passed: false, sharpeOOS: 0, drawdownOOS: 0, tradesOOS: 0, winRateOOS: 0, marketsEvaluated: 0, reason: 'IS Sharpe <= 0, nothing to validate' };
    }

    const now = new Date();
    const oosEndDate = now;
    const oosStartDate = new Date(now.getTime() - WALKFORWARD_CONFIG.oosPeriodDays * 24 * 60 * 60 * 1000);

    console.log(`[OptimizationScheduler] Running OOS validation from ${oosStartDate.toISOString().slice(0, 10)} to ${oosEndDate.toISOString().slice(0, 10)} (IS Sharpe: ${isScore.toFixed(3)})`);

    try {
      const request = this.optunaClient
        ? this.mapOptunaParamsToRequest(params, oosStartDate, oosEndDate)
        : {
            startDate: oosStartDate.toISOString(),
            endDate: oosEndDate.toISOString(),
            initialCapital: 10000,
            signalTypes: ['momentum', 'mean_reversion'],
            riskConfig: { maxPositionSizePct: 10, maxExposurePct: 50 },
            signalFilters: {
              minStrength: params.minEdge ?? params['combiner.minCombinedStrength'] ?? 0.2,
              minConfidence: params.minConfidence ?? params['combiner.minCombinedConfidence'] ?? 0.3,
            },
          };

      const backtest = await this.backtestService.runBacktest(request);

      if (!backtest.result || !backtest.result.metrics) {
        return { passed: false, sharpeOOS: 0, drawdownOOS: 1, tradesOOS: 0, winRateOOS: 0, marketsEvaluated: 0, reason: 'Backtest failed to produce results' };
      }

      const metrics = backtest.result.metrics;
      const trades = backtest.result.trades?.length || 0;
      const oosScore = metrics.sharpeRatio || 0;
      const drawdown = Math.abs(metrics.maxDrawdown || 0);
      const marketsEvaluated = backtest.result.marketsEvaluated ?? 0;

      // Safety floor checks
      if (marketsEvaluated < OOS_SAFETY_FLOOR.minMarkets) {
        return { passed: false, sharpeOOS: oosScore, drawdownOOS: metrics.maxDrawdown, tradesOOS: trades, winRateOOS: metrics.winRate, marketsEvaluated, reason: `Markets ${marketsEvaluated} < ${OOS_SAFETY_FLOOR.minMarkets} (universe too small to apply)` };
      }
      if (trades < OOS_SAFETY_FLOOR.minTrades) {
        return { passed: false, sharpeOOS: oosScore, drawdownOOS: metrics.maxDrawdown, tradesOOS: trades, winRateOOS: metrics.winRate, marketsEvaluated, reason: `Trades ${trades} < ${OOS_SAFETY_FLOOR.minTrades}` };
      }
      if (oosScore < OOS_SAFETY_FLOOR.minSharpe) {
        return { passed: false, sharpeOOS: oosScore, drawdownOOS: metrics.maxDrawdown, tradesOOS: trades, winRateOOS: metrics.winRate, marketsEvaluated, reason: `OOS Sharpe ${oosScore.toFixed(3)} < ${OOS_SAFETY_FLOOR.minSharpe}` };
      }
      if (drawdown > OOS_SAFETY_FLOOR.maxDrawdown) {
        return { passed: false, sharpeOOS: oosScore, drawdownOOS: metrics.maxDrawdown, tradesOOS: trades, winRateOOS: metrics.winRate, marketsEvaluated, reason: `Drawdown ${(drawdown * 100).toFixed(1)}% > ${OOS_SAFETY_FLOOR.maxDrawdown * 100}%` };
      }

      // Adaptive consistency gate
      const decayFactor = await this.computeDecayFactor();
      const threshold = isScore * decayFactor;
      const passed = oosScore >= threshold;

      let reason: string | undefined;
      if (!passed) {
        reason = `OOS ${oosScore.toFixed(3)} < IS ${isScore.toFixed(3)} * decay ${decayFactor.toFixed(3)} = ${threshold.toFixed(3)}`;
      }

      console.log(`[OptimizationScheduler] OOS validation: Sharpe=${oosScore.toFixed(3)}, markets=${marketsEvaluated}, decay=${decayFactor.toFixed(3)}, threshold=${threshold.toFixed(3)}, ${passed ? 'PASSED' : 'FAILED'}`);

      return { passed, sharpeOOS: oosScore, drawdownOOS: metrics.maxDrawdown, tradesOOS: trades, winRateOOS: metrics.winRate, marketsEvaluated, reason };
    } catch (error) {
      console.error('[OptimizationScheduler] OOS validation failed:', error);
      return { passed: false, sharpeOOS: 0, drawdownOOS: 1, tradesOOS: 0, winRateOOS: 0, marketsEvaluated: 0, reason: `Validation error: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * Compute adaptive decay factor from historical OOS/IS ratios.
   * Returns the 25th percentile of ratios, or cold-start default if insufficient data.
   */
  private async computeDecayFactor(): Promise<number> {
    if (!isDatabaseConfigured()) return DECAY_FACTOR_COLD_START;

    try {
      const result = await query<{ best_score: number; oos_score: number }>(`
        SELECT best_score, oos_score FROM optimization_runs
        WHERE status = 'completed' AND oos_score IS NOT NULL AND best_score > 0
        ORDER BY created_at DESC LIMIT 30
      `);

      if (result.rows.length < DECAY_FACTOR_MIN_ROWS) {
        console.log(`[OptimizationScheduler] Decay factor: cold start (${result.rows.length}/${DECAY_FACTOR_MIN_ROWS} rows)`);
        return DECAY_FACTOR_COLD_START;
      }

      const ratios = result.rows
        .map(r => r.oos_score / r.best_score)
        .sort((a, b) => a - b);

      const idx = Math.floor(ratios.length * 0.25);
      const factor = ratios[idx];
      console.log(`[OptimizationScheduler] Decay factor: ${factor.toFixed(3)} (p25 of ${ratios.length} ratios)`);
      return factor;
    } catch (error) {
      console.error('[OptimizationScheduler] Failed to compute decay factor:', error);
      return DECAY_FACTOR_COLD_START;
    }
  }

  // ============================================================
  // OOS validation + persistence (runs always, not just when deploying)
  // ============================================================
  private async runOOSAndPersist(best: OptimizationResult): Promise<void> {
    try {
      const oosResult = await this.validateOnOOS(best.params, best.sharpe);

      // Persist OOS score for decay factor history (even if gate failed)
      if (isDatabaseConfigured()) {
        try {
          await query(`
            UPDATE optimization_runs SET oos_score = $1
            WHERE id = (
              SELECT id FROM optimization_runs
              WHERE status = 'completed' AND oos_score IS NULL
              ORDER BY completed_at DESC LIMIT 1
            )
          `, [oosResult.sharpeOOS]);
        } catch (err) {
          console.error('[OptimizationScheduler] Failed to persist OOS score:', err);
        }
      }

      // Store result for updateStrategy to check
      this._lastOOSResult = oosResult;
    } catch (error) {
      console.error('[OptimizationScheduler] OOS validation failed:', error);
      this._lastOOSResult = null;
    }
  }

  private _lastOOSResult: OOSValidationResult | null = null;

  // ============================================================
  // Strategy update
  // ============================================================
  private async updateStrategy(result: OptimizationResult): Promise<void> {
    // Basic sanity checks
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

    // OOS Validation Gate (already ran in runOOSAndPersist)
    const oosResult = this._lastOOSResult;
    if (!oosResult || !oosResult.passed) {
      console.log(`[OptimizationScheduler] OOS validation FAILED: ${oosResult?.reason ?? 'no OOS result available'}`);
      if (oosResult) {
        console.log(`[OptimizationScheduler] OOS metrics: Sharpe=${oosResult.sharpeOOS.toFixed(2)}, DD=${(oosResult.drawdownOOS * 100).toFixed(1)}%, Trades=${oosResult.tradesOOS}, WR=${(oosResult.winRateOOS * 100).toFixed(1)}%`);
      }
      return;
    }

    console.log(`[OptimizationScheduler] OOS validation PASSED: Sharpe=${oosResult.sharpeOOS.toFixed(2)}, Trades=${oosResult.tradesOOS}`);
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

    // Enforce direction multiplier = -1.0 after every optimization run.
    // It is excluded from the parameter space (not optimized), but we reset it here
    // so any manual or legacy DB changes are corrected automatically.
    // Validated value: -1.0 gives 91.5% accuracy vs 3.7% unflipped (188 trades, Apr 2026).
    try {
      await signalWeightsRepo.update('direction_multiplier', -1.0, `optimization-${new Date().toISOString().slice(0, 10)}`);
      console.log('[OptimizationScheduler] direction_multiplier enforced to -1.0 (pinned design spec)');
    } catch (err) {
      console.error('[OptimizationScheduler] Failed to enforce direction_multiplier to -1.0:', err);
    }

    // Apply optimized signal weights to database
    const WEIGHT_PARAM_MAP: Record<string, string> = {
      'combiner.momentumWeight': 'momentum',
      'combiner.meanReversionWeight': 'mean_reversion',
      'combiner.ofiWeight': 'ofi',
      'combiner.mlofiWeight': 'mlofi',
      'combiner.hawkesWeight': 'hawkes',
      'combiner.volumeAnomalyWeight': 'volume_anomaly',
      'combiner.spreadCompressionWeight': 'spread_compression',
      'combiner.crossMarketCorrWeight': 'cross_market_corr',
      'combiner.priceDivergenceWeight': 'price_divergence',
      'combiner.attentionSpikeWeight': 'attention_spike',
      'combiner.newsSentimentWeight': 'news_sentiment',
    };

    const MIN_WEIGHT = -1.5;  // Allow negative (contrarian) weights
    const MAX_WEIGHT = 3.0;

    for (const [paramKey, signalType] of Object.entries(WEIGHT_PARAM_MAP)) {
      const rawWeight = result.params[paramKey];
      if (rawWeight !== undefined && rawWeight !== null) {
        const weight = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, Number(rawWeight)));

        try {
          await signalWeightsRepo.update(signalType, weight, `optimization-${new Date().toISOString().slice(0, 10)}`);
          console.log(`[OptimizationScheduler] Updated signal weight: ${signalType} = ${weight.toFixed(4)}`);
        } catch (err) {
          console.error(`[OptimizationScheduler] Failed to update weight ${signalType}:`, err);
        }
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
  private async saveOptimizationRun(type: string, results: OptimizationResult[], optimizerType: string = 'random_search', startedAt?: Date): Promise<void> {
    if (!isDatabaseConfigured()) return;

    try {
      const best = results.reduce((a, b) => a.sharpe > b.sharpe ? a : b, results[0]);
      const runStartedAt = startedAt ?? new Date();

      await query(`
        INSERT INTO optimization_runs (
          name, description, status, optimizer_type, n_iterations,
          objective_metric, parameter_space, data_start_date, data_end_date,
          best_params, best_score, iterations_completed, started_at, completed_at,
          duration_seconds
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(),
          EXTRACT(EPOCH FROM (NOW() - $13::timestamptz))::INTEGER)
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
        best?.sharpe ?? null,
        results.length,
        runStartedAt,
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
