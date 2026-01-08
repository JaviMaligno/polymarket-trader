/**
 * Continuous Optimization Service
 *
 * Runs 24/7 to continuously optimize trading strategies:
 * - Every 6h: Incremental optimization (100 iterations)
 * - Every 24h: Validate active strategy
 * - Every 7d: Full re-optimization (500 iterations)
 */

import { pino } from 'pino';
import { v4 as uuidv4 } from 'uuid';
import type { Pool } from 'pg';
import {
  StrategyOptimizer,
  type OptimizationConfig,
  type IBacktestRunner,
} from '../core/StrategyOptimizer.js';
import { OptimizationStore, type SavedStrategy } from '../storage/OptimizationStore.js';
import { FULL_PARAMETER_SPACE, MINIMAL_PARAMETER_SPACE } from '../core/ParameterSpace.js';

const logger = pino({ name: 'OptimizationService' });

// ============================================
// Types
// ============================================

export interface ServiceConfig {
  /** Optimizer server URL */
  optimizerServerUrl: string;
  /** Enable incremental optimization */
  enableIncremental: boolean;
  /** Incremental optimization interval in hours */
  incrementalIntervalHours: number;
  /** Incremental iterations */
  incrementalIterations: number;
  /** Enable daily validation */
  enableValidation: boolean;
  /** Validation interval in hours */
  validationIntervalHours: number;
  /** Enable full re-optimization */
  enableFullOptimization: boolean;
  /** Full optimization interval in days */
  fullOptimizationIntervalDays: number;
  /** Full optimization iterations */
  fullOptimizationIterations: number;
  /** Auto-activate better strategies in paper mode */
  autoActivatePaper: boolean;
  /** Minimum improvement to auto-activate (e.g., 0.1 = 10%) */
  minImprovementToActivate: number;
  /** Walk-forward consistency threshold (0-1) */
  walkForwardThreshold: number;
  /** Backtest lookback days */
  backtestLookbackDays: number;
  /** Initial capital for backtests */
  initialCapital: number;
}

export const DEFAULT_SERVICE_CONFIG: ServiceConfig = {
  optimizerServerUrl: 'http://localhost:8000',
  enableIncremental: true,
  incrementalIntervalHours: 6,
  incrementalIterations: 100,
  enableValidation: true,
  validationIntervalHours: 24,
  enableFullOptimization: true,
  fullOptimizationIntervalDays: 7,
  fullOptimizationIterations: 500,
  autoActivatePaper: true,
  minImprovementToActivate: 0.1,
  walkForwardThreshold: 0.7,
  backtestLookbackDays: 30,
  initialCapital: 10000,
};

interface ServiceState {
  isRunning: boolean;
  lastIncrementalAt: Date | null;
  lastValidationAt: Date | null;
  lastFullOptimizationAt: Date | null;
  currentJobType: 'idle' | 'incremental' | 'validation' | 'full' | null;
  currentJobId: string | null;
}

// ============================================
// Service Class
// ============================================

export class OptimizationService {
  private config: ServiceConfig;
  private db: Pool;
  private optimizer: StrategyOptimizer;
  private store: OptimizationStore;
  private backtestRunner: IBacktestRunner | null = null;

  private state: ServiceState = {
    isRunning: false,
    lastIncrementalAt: null,
    lastValidationAt: null,
    lastFullOptimizationAt: null,
    currentJobType: 'idle',
    currentJobId: null,
  };

  private mainLoopInterval: NodeJS.Timeout | null = null;

  constructor(db: Pool, config?: Partial<ServiceConfig>) {
    this.config = { ...DEFAULT_SERVICE_CONFIG, ...config };
    this.db = db;
    this.optimizer = new StrategyOptimizer(
      { url: this.config.optimizerServerUrl },
      db
    );
    this.store = new OptimizationStore(db);
  }

  /**
   * Set the backtest runner
   */
  setBacktestRunner(runner: IBacktestRunner): void {
    this.backtestRunner = runner;
    this.optimizer.setBacktestRunner(runner);
  }

  /**
   * Start the service
   */
  async start(): Promise<void> {
    if (this.state.isRunning) {
      logger.warn('Service is already running');
      return;
    }

    if (!this.backtestRunner) {
      throw new Error('BacktestRunner not set. Call setBacktestRunner() first.');
    }

    // Load previous state from database
    await this.loadState();

    this.state.isRunning = true;
    logger.info({ config: this.config }, 'Optimization service started');

    // Save state
    await this.saveState();

    // Start main loop (check every minute)
    this.mainLoopInterval = setInterval(
      () => this.mainLoop().catch(err => logger.error({ err }, 'Main loop error')),
      60 * 1000 // 1 minute
    );

    // Run immediately
    await this.mainLoop();
  }

  /**
   * Stop the service
   */
  async stop(): Promise<void> {
    if (!this.state.isRunning) {
      return;
    }

    this.state.isRunning = false;

    if (this.mainLoopInterval) {
      clearInterval(this.mainLoopInterval);
      this.mainLoopInterval = null;
    }

    await this.saveState();
    logger.info('Optimization service stopped');
  }

  /**
   * Get current service state
   */
  getState(): ServiceState {
    return { ...this.state };
  }

  /**
   * Main loop - checks what jobs need to run
   */
  private async mainLoop(): Promise<void> {
    if (!this.state.isRunning || this.state.currentJobType !== 'idle') {
      return;
    }

    const now = new Date();

    // Check for full optimization (highest priority, least frequent)
    if (this.config.enableFullOptimization && this.shouldRunFullOptimization(now)) {
      await this.runFullOptimization();
      return;
    }

    // Check for daily validation
    if (this.config.enableValidation && this.shouldRunValidation(now)) {
      await this.runValidation();
      return;
    }

    // Check for incremental optimization
    if (this.config.enableIncremental && this.shouldRunIncremental(now)) {
      await this.runIncrementalOptimization();
      return;
    }
  }

  /**
   * Check if incremental optimization should run
   */
  private shouldRunIncremental(now: Date): boolean {
    if (!this.state.lastIncrementalAt) return true;

    const hoursSince =
      (now.getTime() - this.state.lastIncrementalAt.getTime()) / (1000 * 60 * 60);

    return hoursSince >= this.config.incrementalIntervalHours;
  }

  /**
   * Check if validation should run
   */
  private shouldRunValidation(now: Date): boolean {
    if (!this.state.lastValidationAt) return true;

    const hoursSince =
      (now.getTime() - this.state.lastValidationAt.getTime()) / (1000 * 60 * 60);

    return hoursSince >= this.config.validationIntervalHours;
  }

  /**
   * Check if full optimization should run
   */
  private shouldRunFullOptimization(now: Date): boolean {
    if (!this.state.lastFullOptimizationAt) return true;

    const daysSince =
      (now.getTime() - this.state.lastFullOptimizationAt.getTime()) / (1000 * 60 * 60 * 24);

    return daysSince >= this.config.fullOptimizationIntervalDays;
  }

  /**
   * Run incremental optimization
   */
  private async runIncrementalOptimization(): Promise<void> {
    const jobId = uuidv4();
    this.state.currentJobType = 'incremental';
    this.state.currentJobId = jobId;
    await this.saveState();

    logger.info({ jobId }, 'Starting incremental optimization');

    try {
      const config: OptimizationConfig = {
        name: `incremental-${new Date().toISOString().split('T')[0]}`,
        description: 'Automated incremental optimization',
        iterations: this.config.incrementalIterations,
        optimizer: 'tpe',
        objective: {
          name: 'sharpe_ratio',
          minTrades: 10,
          maxAllowedDrawdown: 0.5,
        },
        parameterSpace: MINIMAL_PARAMETER_SPACE,
        backtest: this.getBacktestConfig(),
        isExploration: true,
      };

      const result = await this.optimizer.runOptimization(config);

      if (result.status === 'completed' && result.best_score !== null) {
        await this.checkAndActivate(result.best_params!, result.best_score);
      }

      this.state.lastIncrementalAt = new Date();
      logger.info({ jobId, result: result.status }, 'Incremental optimization completed');
    } catch (error) {
      logger.error({ error, jobId }, 'Incremental optimization failed');
    } finally {
      this.state.currentJobType = 'idle';
      this.state.currentJobId = null;
      await this.saveState();
    }
  }

  /**
   * Run full optimization
   */
  private async runFullOptimization(): Promise<void> {
    const jobId = uuidv4();
    this.state.currentJobType = 'full';
    this.state.currentJobId = jobId;
    await this.saveState();

    logger.info({ jobId }, 'Starting full optimization');

    try {
      const config: OptimizationConfig = {
        name: `full-${new Date().toISOString().split('T')[0]}`,
        description: 'Automated full re-optimization',
        iterations: this.config.fullOptimizationIterations,
        optimizer: 'tpe',
        objective: {
          name: 'sharpe_ratio',
          minTrades: 10,
          maxAllowedDrawdown: 0.5,
        },
        parameterSpace: FULL_PARAMETER_SPACE,
        backtest: this.getBacktestConfig(),
        isExploration: false,
      };

      const result = await this.optimizer.runOptimization(config);

      if (result.status === 'completed' && result.best_score !== null) {
        await this.checkAndActivate(result.best_params!, result.best_score);
      }

      this.state.lastFullOptimizationAt = new Date();
      logger.info({ jobId, result: result.status }, 'Full optimization completed');
    } catch (error) {
      logger.error({ error, jobId }, 'Full optimization failed');
    } finally {
      this.state.currentJobType = 'idle';
      this.state.currentJobId = null;
      await this.saveState();
    }
  }

  /**
   * Run validation of active strategy
   */
  private async runValidation(): Promise<void> {
    const jobId = uuidv4();
    this.state.currentJobType = 'validation';
    this.state.currentJobId = jobId;
    await this.saveState();

    logger.info({ jobId }, 'Starting strategy validation');

    try {
      // Get active paper strategy
      const activeStrategy = await this.store.getActiveStrategy('paper');

      if (!activeStrategy) {
        logger.info('No active paper strategy to validate');
        this.state.lastValidationAt = new Date();
        return;
      }

      // Run backtest with active strategy params
      const backtestConfig = this.getBacktestConfig();
      const result = await this.backtestRunner!.run(activeStrategy.params, backtestConfig);

      // Check if performance meets expectations
      const expectedReturn = activeStrategy.backtestMetrics.totalReturn;
      const actualReturn = result.metrics.totalReturn;
      const performanceRatio = expectedReturn !== 0 ? actualReturn / expectedReturn : 0;

      logger.info({
        jobId,
        strategy: activeStrategy.name,
        expectedReturn,
        actualReturn,
        performanceRatio,
      }, 'Validation completed');

      // If performance is significantly worse, alert (but don't auto-deactivate)
      if (performanceRatio < 0.5) {
        logger.warn({
          strategy: activeStrategy.name,
          performanceRatio,
        }, 'Strategy performing significantly below expectations');
      }

      this.state.lastValidationAt = new Date();
    } catch (error) {
      logger.error({ error, jobId }, 'Validation failed');
    } finally {
      this.state.currentJobType = 'idle';
      this.state.currentJobId = null;
      await this.saveState();
    }
  }

  /**
   * Check if new params are better and auto-activate if enabled
   */
  private async checkAndActivate(
    newParams: Record<string, Record<string, unknown>>,
    newScore: number
  ): Promise<void> {
    if (!this.config.autoActivatePaper) {
      return;
    }

    // Get current active paper strategy
    const activeStrategy = await this.store.getActiveStrategy('paper');
    const currentScore = activeStrategy?.backtestMetrics.sharpeRatio ?? 0;

    // Check improvement threshold
    const improvement = currentScore !== 0
      ? (newScore - currentScore) / Math.abs(currentScore)
      : newScore > 0 ? 1 : 0;

    if (improvement < this.config.minImprovementToActivate) {
      logger.info({
        currentScore,
        newScore,
        improvement,
        threshold: this.config.minImprovementToActivate,
      }, 'New strategy does not meet improvement threshold');
      return;
    }

    // TODO: Run walk-forward analysis before activation
    // For now, skip walk-forward and just save

    // Save as new strategy
    const strategyName = `auto-${new Date().toISOString().split('T')[0]}-${uuidv4().slice(0, 8)}`;

    try {
      const strategy = await this.store.saveStrategy({
        id: uuidv4(),
        name: strategyName,
        description: 'Auto-optimized strategy',
        params: newParams,
        backtestMetrics: {
          totalReturn: 0, // Would be filled from backtest
          sharpeRatio: newScore,
          maxDrawdown: 0,
          winRate: 0,
          profitFactor: 0,
          totalTrades: 0,
          averageTradeReturn: 0,
          volatility: 0,
        },
        optimizationRunId: null,
        walkForwardPassed: false, // TODO: implement walk-forward
        validationMetrics: null,
        isActive: false,
        mode: 'backtest',
        activatedAt: null,
        deactivatedAt: null,
      });

      // Activate in paper mode
      await this.store.activateStrategy(strategy.id, 'paper');

      logger.info({
        strategyName,
        newScore,
        improvement,
      }, 'New strategy auto-activated in paper mode');
    } catch (error) {
      logger.error({ error }, 'Failed to save/activate new strategy');
    }
  }

  /**
   * Get backtest configuration
   */
  private getBacktestConfig(): OptimizationConfig['backtest'] {
    const endDate = new Date();
    const startDate = new Date(
      endDate.getTime() - this.config.backtestLookbackDays * 24 * 60 * 60 * 1000
    );

    return {
      startDate,
      endDate,
      initialCapital: this.config.initialCapital,
      granularityMinutes: 60,
    };
  }

  /**
   * Load state from database
   */
  private async loadState(): Promise<void> {
    try {
      const result = await this.db.query(
        'SELECT * FROM optimization_service_state WHERE id = $1',
        ['main']
      );

      if (result.rows.length > 0) {
        const row = result.rows[0];
        this.state.lastIncrementalAt = row.last_incremental_at;
        this.state.lastValidationAt = row.last_validation_at;
        this.state.lastFullOptimizationAt = row.last_full_optimization_at;
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to load service state');
    }
  }

  /**
   * Save state to database
   */
  private async saveState(): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO optimization_service_state (
          id, is_running, current_job_type, current_job_id,
          last_incremental_at, last_validation_at, last_full_optimization_at, config
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (id) DO UPDATE SET
          is_running = $2,
          current_job_type = $3,
          current_job_id = $4,
          last_incremental_at = $5,
          last_validation_at = $6,
          last_full_optimization_at = $7,
          config = $8,
          updated_at = NOW()`,
        [
          'main',
          this.state.isRunning,
          this.state.currentJobType,
          this.state.currentJobId,
          this.state.lastIncrementalAt,
          this.state.lastValidationAt,
          this.state.lastFullOptimizationAt,
          JSON.stringify(this.config),
        ]
      );
    } catch (error) {
      logger.warn({ error }, 'Failed to save service state');
    }
  }
}

// ============================================
// Factory
// ============================================

export function createOptimizationService(
  db: Pool,
  config?: Partial<ServiceConfig>
): OptimizationService {
  return new OptimizationService(db, config);
}
