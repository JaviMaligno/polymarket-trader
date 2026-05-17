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
import { signalWeightsRepo, priceRangeMatrixRepo, tradingConfigRepo } from '../database/repositories.js';
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
// Optuna parameter space
// ============================================================
export const OPTUNA_PARAM_SPACE: ParameterDef[] = [
  // Direction multiplier is EXCLUDED from this FULL parameter space — pinned to -1.0 globally
  // per validated design spec. Per-type incremental cycles use REFINEMENT_PARAM_SPACE which
  // DOES expose dm as a categorical {-1, +1} (drift impossible by construction).
  // Empirical validation: 91.5% accuracy at -1.0 vs 3.7% unflipped (188 trades, Apr 2026).
  // History: optimizer drifted to -0.7819 (Apr 15) and +1.0208 (Apr 14), both causing losses.
  // The global value is enforced to -1.0 after each optimization run (see applyOptimizationResult).
  // Combiner thresholds
  { name: 'combiner.minCombinedConfidence', type: 'float', low: 0.25, high: 0.65 },
  { name: 'combiner.minCombinedStrength', type: 'float', low: 0.20, high: 0.60 },
  { name: 'combiner.onlyDirection', type: 'categorical', choices: [null, 'LONG', 'SHORT'] },
  // Signal weights — 7 wired generators
  { name: 'combiner.momentumWeight', type: 'float', low: -1.5, high: 1.5 },
  { name: 'combiner.meanReversionWeight', type: 'float', low: 0.0, high: 2.0 },
  { name: 'combiner.ofiWeight', type: 'float', low: 0.0, high: 2.0 },
  { name: 'combiner.hawkesWeight', type: 'float', low: 0.0, high: 2.0 },
  { name: 'combiner.volumeAnomalyWeight', type: 'float', low: 0.0, high: 2.0 },
  { name: 'combiner.mlofiWeight', type: 'float', low: 0.0, high: 2.0 },
  { name: 'combiner.spreadCompressionWeight', type: 'float', low: 0.0, high: 2.0 },
  // Resolution prior — directional voice from time-to-end + price (no SMA
  // anchor). Closes the LONG-bias path that mean_reversion+momentum miss in
  // markets drifting toward NO/YES. Allow full [0, 2] range; OOS gate
  // protects against bad applies.
  { name: 'combiner.resolutionPriorWeight', type: 'float', low: 0.0, high: 2.0 },
  // Favorite-longshot bias (Sprint 2 2026-05-17). Codifies empirical
  // mispricing in tail-band markets (price < 0.10 or > 0.90). Bootstrap row
  // ships at weight 0 so the generator emits predictions for measurement
  // without affecting the combiner until Optuna has cost-aware t-stat
  // evidence. [0, 2] range matches other tail-anchored generators.
  { name: 'combiner.favoriteLongshotBiasWeight', type: 'float', low: 0.0, high: 2.0 },
  // Resolution prior v2 (Sprint 2 PR-2, 2026-05-17). Mean-reversion against
  // a SMA anchor of the earliest bars in the lookback. Distinct from v1
  // which is trend-following relative to 0.5. Bootstrap at 0; same gating
  // as the other Sprint 2 generators.
  { name: 'combiner.resolutionPriorV2Weight', type: 'float', low: 0.0, high: 2.0 },
  // Consensus discount floor (Sub-project B.2, see docs/plans/2026-04-25-signal-consensus-design.md).
  // Combiner-layer confidence multiplier driven by entropy across active generators.
  // 0.0 = full discount on disagreement; 1.0 = no-op. Live default in signal_weights is 0.5.
  { name: 'combiner.consensusDiscountFloor', type: 'float', low: 0.0, high: 1.0 },
  // Risk
  { name: 'risk.maxPositionSizePct', type: 'float', low: 3.0, high: 15.0 },
  { name: 'risk.maxPositions', type: 'int', low: 5, high: 15 },
  { name: 'risk.stopLossPct', type: 'float', low: 8.0, high: 30.0 },
  { name: 'risk.takeProfitPct', type: 'float', low: 15.0, high: 80.0 },
  // Signal-specific parameters
  { name: 'momentum.rsiPeriod', type: 'int', low: 10, high: 21 },
  { name: 'meanReversion.bollingerPeriod', type: 'int', low: 15, high: 30 },
  { name: 'meanReversion.zScoreThreshold', type: 'float', low: 1.5, high: 2.5 },
  // mean-reversion reference anchor. 'sma' (legacy) vs 'fixed_50' (anchor to
  // the coin-flip prior). In a portfolio dominated by markets that drift to
  // a terminal NO/YES resolution, the SMA itself drifts and the generator
  // never expects regression to a stable point. 'fixed_50' tests the
  // alternative hypothesis. Categorical so drift is impossible by
  // construction; persisted via trading_config.
  { name: 'meanReversion.referenceMode', type: 'categorical', choices: ['sma', 'fixed_50'] },
  // PriceRangeWeightModifier per-band multipliers (8 params).
  // Hardcoded defaults zeroed out momentum/mean_reversion in the uncertain
  // band (0.45–0.55) and dampened them in the transitional band (0.40–0.45,
  // 0.55–0.60). With a downward-drifting price universe this dampening
  // contributed to the 6.6:1 LONG:SHORT skew observed 2026-05-05. Optuna now
  // samples the matrix so post-flip data can override the hand-tuned values.
  // See docs / project_optimizer_epoch_reset.md for context.
  { name: 'priceRange.momentumTransitional', type: 'float', low: 0.0, high: 1.5 },
  { name: 'priceRange.momentumUncertain', type: 'float', low: 0.0, high: 1.0 },
  { name: 'priceRange.meanReversionTransitional', type: 'float', low: 0.0, high: 1.5 },
  { name: 'priceRange.meanReversionUncertain', type: 'float', low: 0.0, high: 1.0 },
  { name: 'priceRange.crossMarketCorrTransitional', type: 'float', low: 0.0, high: 1.5 },
  { name: 'priceRange.crossMarketCorrUncertain', type: 'float', low: 0.0, high: 1.5 },
  { name: 'priceRange.spreadCompressionUncertain', type: 'float', low: 0.0, high: 1.5 },
  { name: 'priceRange.newsSentimentUncertain', type: 'float', low: 0.0, high: 1.5 },
];

/**
 * Reduced parameter space for incremental refinement (per-type cycles).
 * 7 wired generators + categorical direction_multiplier.
 *
 * direction_multiplier is included here as a CATEGORICAL {-1, +1} only — drift
 * is impossible by construction (Optuna can pick only the two validated
 * values). The FULL space (OPTUNA_PARAM_SPACE) keeps dm excluded and the
 * global '__global__' row is hard-pinned to -1.0 per PR #104.
 *
 * Per-type writes land on signal_type='direction_multiplier' rows via
 * WEIGHT_PARAM_MAP + signalWeightsRepo.updatePerType. The runtime
 * resolveDirectionMultiplier reads these rows.
 */
export const REFINEMENT_PARAM_SPACE: ParameterDef[] = [
  { name: 'combiner.minCombinedConfidence', type: 'float', low: 0.15, high: 0.65 },
  { name: 'combiner.minCombinedStrength', type: 'float', low: 0.15, high: 0.60 },
  { name: 'combiner.momentumWeight', type: 'float', low: -1.5, high: 1.5 },
  { name: 'combiner.meanReversionWeight', type: 'float', low: 0.0, high: 2.0 },
  { name: 'combiner.ofiWeight', type: 'float', low: 0.0, high: 2.0 },
  { name: 'combiner.hawkesWeight', type: 'float', low: 0.0, high: 2.0 },
  { name: 'combiner.volumeAnomalyWeight', type: 'float', low: 0.0, high: 2.0 },
  { name: 'combiner.mlofiWeight', type: 'float', low: 0.0, high: 2.0 },
  { name: 'combiner.spreadCompressionWeight', type: 'float', low: 0.0, high: 2.0 },
  { name: 'combiner.resolutionPriorWeight', type: 'float', low: 0.0, high: 2.0 },
  { name: 'combiner.favoriteLongshotBiasWeight', type: 'float', low: 0.0, high: 2.0 },
  { name: 'combiner.resolutionPriorV2Weight', type: 'float', low: 0.0, high: 2.0 },
  { name: 'combiner.consensusDiscountFloor', type: 'float', low: 0.0, high: 1.0 },
  { name: 'risk.maxPositionSizePct', type: 'float', low: 3.0, high: 15.0 },
  { name: 'risk.stopLossPct', type: 'float', low: 8.0, high: 30.0 },
  { name: 'meanReversion.zScoreThreshold', type: 'float', low: 1.5, high: 2.5 },
  { name: 'meanReversion.referenceMode', type: 'categorical', choices: ['sma', 'fixed_50'] },
  { name: 'combiner.directionMultiplier', type: 'categorical', choices: [-1.0, 1.0] },
  // PriceRangeWeightModifier multipliers — same 8 params as full space.
  // Refinement re-tunes them per-type each cycle (every 6h) so they track
  // régime changes without waiting for the weekly full run.
  { name: 'priceRange.momentumTransitional', type: 'float', low: 0.0, high: 1.5 },
  { name: 'priceRange.momentumUncertain', type: 'float', low: 0.0, high: 1.0 },
  { name: 'priceRange.meanReversionTransitional', type: 'float', low: 0.0, high: 1.5 },
  { name: 'priceRange.meanReversionUncertain', type: 'float', low: 0.0, high: 1.0 },
  { name: 'priceRange.crossMarketCorrTransitional', type: 'float', low: 0.0, high: 1.5 },
  { name: 'priceRange.crossMarketCorrUncertain', type: 'float', low: 0.0, high: 1.5 },
  { name: 'priceRange.spreadCompressionUncertain', type: 'float', low: 0.0, high: 1.5 },
  { name: 'priceRange.newsSentimentUncertain', type: 'float', low: 0.0, high: 1.5 },
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
  /** Legacy default minimum trades for unknown market types. Per-type values
   *  in OOS_MIN_TRADES_PER_TYPE override this. */
  minTrades: 20,
  /** Minimum distinct markets evaluated — prevents apply on tiny universes
   *  where local maxima are statistically meaningless. Triggered by the
   *  2026-04-14 incident where 6 event_financial markets produced
   *  direction_multiplier=+1.0208 (causing 13.5% drawdown). */
  minMarkets: parseInt(process.env.OPTIMIZER_MIN_MARKETS_FOR_APPLY || '8', 10),
};

/** Per-market-type OOS minimum-trade floors. Reflect realistic trade counts
 *  per OOS window (4 days) given each type's holding-time distribution.
 *  Empirically: event_long observed 7 trades / 4d window (rejected by the old
 *  uniform floor of 20 even with positive IS Sharpe 0.113); event_financial
 *  observed 34 trades / 4d window. See issue #147 — proper fix is adaptive
 *  thresholds derived from per-type historical trade-count distributions. */
export const OOS_MIN_TRADES_PER_TYPE: Record<string, number> = {
  crypto_intraday: 30,
  crypto_daily: 20,
  event_financial: 15,
  event_short: 10,
  event_long: 5,
};

/** Resolves the OOS min-trade floor for a given market_type, honoring the
 *  OPTIMIZER_MIN_TRADES_<TYPE> env override. Falls back to OOS_SAFETY_FLOOR.minTrades
 *  for unknown types. Invalid env values (non-numeric, ≤ 0) are ignored. */
export function getOosMinTrades(marketType: string): number {
  const envKey = `OPTIMIZER_MIN_TRADES_${marketType.toUpperCase()}`;
  const envVal = process.env[envKey];
  if (envVal !== undefined) {
    const parsed = parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return OOS_MIN_TRADES_PER_TYPE[marketType] ?? OOS_SAFETY_FLOOR.minTrades;
}

// ============================================================
// Regime-epoch filter (training/OOS window)
//
// 2026-05-04: directionMultiplier flipped from -1 → +1 (PR #178). Signal
// behaviour reverses across the boundary — pre-flip backtest data trains
// Optuna toward the wrong sign for every per-type weight. Setting
// OPTIMIZER_EPOCH_START floors training and OOS windows to the boundary so
// the optimizer only ingests post-flip trades. Unset (or invalid) → no floor,
// behaviour identical to before.
//
// Remove the env var once the rolling 14d window has aged past the epoch
// organically (target ~2026-05-18).
// ============================================================
export interface OptimizerWindow {
  startDate: Date;
  endDate: Date;
  valid: boolean;
  reason?: string;
}

export function parseOptimizerEpochStart(): Date | null {
  const raw = process.env.OPTIMIZER_EPOCH_START;
  if (!raw || raw.trim() === '') return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    console.warn(`[OptimizationScheduler] Invalid OPTIMIZER_EPOCH_START: ${raw}`);
    return null;
  }
  return parsed;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function buildTrainingWindow(
  now: Date,
  trainingPeriodDays: number,
  oosPeriodDays: number,
  epochStart: Date | null,
): OptimizerWindow {
  const endDate = new Date(now.getTime() - oosPeriodDays * MS_PER_DAY);
  let startDate = new Date(endDate.getTime() - trainingPeriodDays * MS_PER_DAY);

  if (epochStart) {
    if (epochStart.getTime() >= endDate.getTime()) {
      return {
        startDate,
        endDate,
        valid: false,
        reason: `Epoch ${epochStart.toISOString()} >= training endDate ${endDate.toISOString()} — no post-epoch training data yet`,
      };
    }
    if (epochStart.getTime() > startDate.getTime()) {
      startDate = epochStart;
      const windowDays = (endDate.getTime() - startDate.getTime()) / MS_PER_DAY;
      if (windowDays < 1) {
        return {
          startDate,
          endDate,
          valid: false,
          reason: `Training window after epoch only ${windowDays.toFixed(1)}d (need ≥1d)`,
        };
      }
    }
  }

  return { startDate, endDate, valid: true };
}

export function buildOOSWindow(
  now: Date,
  oosPeriodDays: number,
  epochStart: Date | null,
): OptimizerWindow {
  const endDate = now;
  let startDate = new Date(now.getTime() - oosPeriodDays * MS_PER_DAY);

  if (epochStart) {
    if (epochStart.getTime() >= endDate.getTime()) {
      return {
        startDate,
        endDate,
        valid: false,
        reason: `Epoch ${epochStart.toISOString()} >= OOS endDate ${endDate.toISOString()}`,
      };
    }
    if (epochStart.getTime() > startDate.getTime()) {
      startDate = epochStart;
    }
  }

  return { startDate, endDate, valid: true };
}

const MARKET_TYPES = ['crypto_intraday', 'crypto_daily', 'event_financial', 'event_short', 'event_long'] as const;
type MarketType = typeof MARKET_TYPES[number];

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
  bestSharpePerType: Record<string, number>;
}

export class OptimizationScheduler {
  private state: SchedulerState = {
    isRunning: false,
    lastIncrementalAt: null,
    lastFullAt: null,
    currentRunType: 'idle',
    bestParams: { ...DEFAULT_BEST_PARAMS },
    bestSharpePerType: {},
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
    console.log('[OptimizationScheduler] Starting incremental optimization (per-type)...');
    this.state.currentRunType = 'incremental';

    const winners: Array<{ marketType: string; result: OptimizationResult }> = [];

    try {
      for (const marketType of MARKET_TYPES) {
        console.log(`[OptimizationScheduler] === ${marketType} ===`);
        try {
          const results = await this.runOptimization(this.incrementalIterations, 'incremental', marketType);
          if (results.length === 0) {
            console.log(`[OptimizationScheduler] No results for ${marketType}, skipping`);
            continue;
          }

          const best = results.reduce((a, b) => a.sharpe > b.sharpe ? a : b);

          // Always run OOS validation and persist score (feeds decay factor history)
          await this.runOOSAndPersist(best, marketType);

          const priorBest = this.state.bestSharpePerType[marketType] ?? 0;
          if (best.sharpe >= priorBest) {
            console.log(`[OptimizationScheduler] ${marketType}: better params Sharpe ${best.sharpe.toFixed(2)} vs ${priorBest.toFixed(2)}`);
            const { wasApplied } = await this.updateStrategy(best, marketType);
            if (wasApplied) winners.push({ marketType, result: best });
          }
        } catch (err) {
          console.error(`[OptimizationScheduler] ${marketType} failed:`, err);
        }
      }

      // #145 fix: deploy global thresholds ONCE per cycle with the max-Sharpe winner.
      // Pre-fix this ran inside updateStrategy per-type → last-in wins on minEdge/minConfidence.
      if (winners.length > 0) {
        const winner = winners.reduce((a, b) => a.result.sharpe > b.result.sharpe ? a : b);
        console.log(`[OptimizationScheduler] Cycle winner: ${winner.marketType} (Sharpe ${winner.result.sharpe.toFixed(3)}, ${winners.length} types qualified)`);
        await this.applyGlobalThresholds(winner.result, winner.marketType);
      }

      this.state.lastIncrementalAt = new Date();
      console.log('[OptimizationScheduler] Incremental optimization completed (all types)');
    } catch (error) {
      console.error('[OptimizationScheduler] Incremental orchestration failed:', error);
    } finally {
      this.state.currentRunType = 'idle';
      await this.saveState();
    }
  }

  private async runFullOptimization(): Promise<void> {
    console.log('[OptimizationScheduler] Starting full optimization (per-type)...');
    this.state.currentRunType = 'full';

    const winners: Array<{ marketType: string; result: OptimizationResult }> = [];

    try {
      for (const marketType of MARKET_TYPES) {
        console.log(`[OptimizationScheduler] === ${marketType} ===`);
        try {
          const results = await this.runOptimization(this.fullIterations, 'full', marketType);
          if (results.length === 0) {
            console.log(`[OptimizationScheduler] No results for ${marketType}, skipping`);
            continue;
          }

          const best = results.reduce((a, b) => a.sharpe > b.sharpe ? a : b);

          // Always run OOS validation and persist score (feeds decay factor history)
          await this.runOOSAndPersist(best, marketType);

          const priorBest = this.state.bestSharpePerType[marketType] ?? 0;
          if (best.sharpe >= priorBest) {
            console.log(`[OptimizationScheduler] ${marketType}: better params Sharpe ${best.sharpe.toFixed(2)} vs ${priorBest.toFixed(2)}`);
            const { wasApplied } = await this.updateStrategy(best, marketType);
            if (wasApplied) winners.push({ marketType, result: best });
          }
        } catch (err) {
          console.error(`[OptimizationScheduler] ${marketType} failed:`, err);
        }
      }

      // #145 fix: deploy global thresholds ONCE per cycle with the max-Sharpe winner.
      if (winners.length > 0) {
        const winner = winners.reduce((a, b) => a.result.sharpe > b.result.sharpe ? a : b);
        console.log(`[OptimizationScheduler] Cycle winner: ${winner.marketType} (Sharpe ${winner.result.sharpe.toFixed(3)}, ${winners.length} types qualified)`);
        await this.applyGlobalThresholds(winner.result, winner.marketType);
      }

      this.state.lastFullAt = new Date();
      this.state.lastIncrementalAt = new Date();
      console.log('[OptimizationScheduler] Full optimization completed (all types)');
    } catch (error) {
      console.error('[OptimizationScheduler] Full orchestration failed:', error);
    } finally {
      this.state.currentRunType = 'idle';
      await this.saveState();
    }
  }

  // ============================================================
  // Core optimization dispatcher
  // ============================================================
  private async runOptimization(iterations: number, type: 'incremental' | 'full', marketType: string): Promise<OptimizationResult[]> {
    if (this.optunaClient) {
      const paramSpace = type === 'incremental' ? REFINEMENT_PARAM_SPACE : OPTUNA_PARAM_SPACE;
      return this.runOptunaOptimization(iterations, type, marketType, paramSpace);
    }
    return this.runGridOptimization(iterations, type, marketType);
  }

  // ============================================================
  // Optuna Bayesian optimization
  // ============================================================
  private async runOptunaOptimization(iterations: number, type: string, marketType: string, paramSpace?: ParameterDef[]): Promise<OptimizationResult[]> {
    const client = this.optunaClient!;
    const runStartedAt = new Date();
    const results: OptimizationResult[] = [];

    // Wake server (Render cold start)
    console.log('[OptimizationScheduler] Waking Optuna server...');
    const alive = await client.ping();
    if (!alive) {
      console.error('[OptimizationScheduler] Optuna server unreachable, falling back to grid search');
      return this.runGridOptimization(iterations, type as any, marketType);
    }

    // Create fresh optimizer for this run
    const effectiveParamSpace = paramSpace ?? OPTUNA_PARAM_SPACE;
    const nStartupTrials = Math.ceil(iterations * 0.3);  // 30% random exploration

    const optimizerId = await client.createOptimizer(
      `${type}-${new Date().toISOString().slice(0, 10)}-${marketType}`,
      effectiveParamSpace,
      { sampler: 'tpe', nStartupTrials }
    );

    console.log(`[OptimizationScheduler] Created Optuna optimizer ${optimizerId}, running ${iterations} trials...`);
    console.log(`[OptimizationScheduler] Using ${effectiveParamSpace.length} parameters, ${nStartupTrials} startup trials`);

    // Use training period only (exclude OOS period for honest validation).
    // Apply epoch floor so post-flip runs ignore pre-flip data (PR #178).
    const window = buildTrainingWindow(
      new Date(),
      WALKFORWARD_CONFIG.trainingPeriodDays,
      WALKFORWARD_CONFIG.oosPeriodDays,
      parseOptimizerEpochStart(),
    );
    if (!window.valid) {
      console.log(`[OptimizationScheduler] Skipping ${marketType} run: ${window.reason}`);
      await client.deleteOptimizer(optimizerId);
      return [];
    }
    const { startDate, endDate } = window;
    const trainingDays = (endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000);

    console.log(`[OptimizationScheduler] Training period: ${startDate.toISOString().slice(0,10)} to ${endDate.toISOString().slice(0,10)} (${trainingDays.toFixed(1)} days)`);

    // Preload backtest data once for all trials (same training period)
    console.log('[OptimizationScheduler] Preloading backtest data...');
    const preloadedData: MarketData[] = await this.backtestService.fetchHistoricalData(startDate, endDate, undefined, marketType);
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

          // Guard against the Optuna server returning empty params (observed
          // 2026-05-06 cycle 2 for crypto_intraday — every trial returned {}
          // and the resulting "winner" had no params to persist, silently
          // no-op'ing updateStrategy). Treat as a failed trial so the
          // consecutive-failure counter trips and we abort early.
          if (!params || typeof params !== 'object' || Object.keys(params).length === 0) {
            console.warn(`[OptimizationScheduler] Trial ${i + 1} (id=${trialId}): empty params — treating as failed trial`);
            consecutiveFailures++;
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
              console.error(`[OptimizationScheduler] ${MAX_CONSECUTIVE_FAILURES} consecutive failures — Optuna server returned empty params, aborting run`);
              break;
            }
            continue;
          }

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
        referenceMode: params['meanReversion.referenceMode'] as 'sma' | 'fixed_50' | undefined,
      },
      combinerConfig: {
        momentumWeight: params['combiner.momentumWeight'],
        meanReversionWeight: params['combiner.meanReversionWeight'],
        ofiWeight: params['combiner.ofiWeight'],
        hawkesWeight: params['combiner.hawkesWeight'],
        volumeAnomalyWeight: params['combiner.volumeAnomalyWeight'],
        mlofiWeight: params['combiner.mlofiWeight'],
        spreadCompressionWeight: params['combiner.spreadCompressionWeight'],
        resolutionPriorWeight: params['combiner.resolutionPriorWeight'],
        favoriteLongshotBiasWeight: params['combiner.favoriteLongshotBiasWeight'],
        resolutionPriorV2Weight: params['combiner.resolutionPriorV2Weight'],
        minCombinedConfidence: params['combiner.minCombinedConfidence'],
        minCombinedStrength: params['combiner.minCombinedStrength'],
        onlyDirection: params['combiner.onlyDirection'],
        // Forward categorical dm from REFINEMENT_PARAM_SPACE per-type cycles.
        // Undefined for FULL strategy (OPTUNA_PARAM_SPACE excludes dm).
        // Task 8 wires BacktestService to actually apply this via the combiner.
        directionMultiplier: params['combiner.directionMultiplier'] as number | undefined,
        // Sub-project B.2 (issue #129): consensus discount floor sampled per
        // trial. BacktestService.runBacktest already accepts this on the
        // combinerConfig field (commit 46dcf41).
        consensusDiscountFloor: params['combiner.consensusDiscountFloor'] as number | undefined,
      },
      priceRangeConfig: this.buildPriceRangeConfigFromParams(params),
    };
  }

  /**
   * Map flat priceRange.* params into the structured priceRangeConfig that
   * BacktestService consumes. Only emits a key when at least one band
   * multiplier was actually sampled (so absent params keep the default matrix
   * untouched, not silently zeroed).
   */
  private buildPriceRangeConfigFromParams(
    params: Record<string, any>,
  ): BacktestRequest['priceRangeConfig'] {
    const cfg: BacktestRequest['priceRangeConfig'] = {};
    const setBand = (
      genKey: keyof NonNullable<BacktestRequest['priceRangeConfig']>,
      band: 'transitional' | 'uncertain',
      paramName: string,
    ) => {
      const value = params[paramName];
      if (typeof value !== 'number' || !Number.isFinite(value)) return;
      const existing = cfg[genKey] ?? {};
      cfg[genKey] = { ...existing, [band]: value };
    };

    setBand('momentum', 'transitional', 'priceRange.momentumTransitional');
    setBand('momentum', 'uncertain', 'priceRange.momentumUncertain');
    setBand('meanReversion', 'transitional', 'priceRange.meanReversionTransitional');
    setBand('meanReversion', 'uncertain', 'priceRange.meanReversionUncertain');
    setBand('crossMarketCorr', 'transitional', 'priceRange.crossMarketCorrTransitional');
    setBand('crossMarketCorr', 'uncertain', 'priceRange.crossMarketCorrUncertain');
    setBand('spreadCompression', 'uncertain', 'priceRange.spreadCompressionUncertain');
    setBand('newsSentiment', 'uncertain', 'priceRange.newsSentimentUncertain');

    return Object.keys(cfg).length > 0 ? cfg : undefined;
  }

  // ============================================================
  // Legacy grid/random search (fallback)
  // ============================================================
  private async runGridOptimization(iterations: number, type: 'incremental' | 'full', marketType: string): Promise<OptimizationResult[]> {
    const runStartedAt = new Date();
    const results: OptimizationResult[] = [];
    // Use training period only (exclude OOS period). Apply epoch floor.
    const window = buildTrainingWindow(
      new Date(),
      WALKFORWARD_CONFIG.trainingPeriodDays,
      WALKFORWARD_CONFIG.oosPeriodDays,
      parseOptimizerEpochStart(),
    );
    if (!window.valid) {
      console.log(`[OptimizationScheduler] Skipping ${marketType} grid run: ${window.reason}`);
      return [];
    }
    const { startDate, endDate } = window;

    const paramCombos = type === 'incremental'
      ? this.generateIncrementalParams()
      : this.generateFullParams();

    const shuffled = paramCombos.sort(() => Math.random() - 0.5).slice(0, iterations);

    console.log(`[OptimizationScheduler] Running ${shuffled.length} grid-search backtests for ${marketType}...`);

    // Preload filtered training data once per cycle (mirrors the Optuna path).
    // Without this filter the grid path would backtest the full universe and
    // write the result into a per-type row, producing meaningless per-type
    // weights when Optuna is offline. See issue #146.
    const preloadedData: MarketData[] = await this.backtestService.fetchHistoricalData(startDate, endDate, undefined, marketType);
    console.log(`[OptimizationScheduler] Preloaded ${preloadedData.length} markets for ${marketType}`);

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
        }, preloadedData);

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
  private async validateOnOOS(params: Record<string, any>, isScore: number, marketType: string): Promise<OOSValidationResult> {
    // Gate: don't validate negative in-sample
    if (isScore <= 0) {
      return { passed: false, sharpeOOS: 0, drawdownOOS: 0, tradesOOS: 0, winRateOOS: 0, marketsEvaluated: 0, reason: 'IS Sharpe <= 0, nothing to validate' };
    }

    const oosWindow = buildOOSWindow(
      new Date(),
      WALKFORWARD_CONFIG.oosPeriodDays,
      parseOptimizerEpochStart(),
    );
    if (!oosWindow.valid) {
      return { passed: false, sharpeOOS: 0, drawdownOOS: 0, tradesOOS: 0, winRateOOS: 0, marketsEvaluated: 0, reason: oosWindow.reason };
    }
    const { startDate: oosStartDate, endDate: oosEndDate } = oosWindow;

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

      const oosData: MarketData[] = await this.backtestService.fetchHistoricalData(oosStartDate, oosEndDate, undefined, marketType);
      const backtest = await this.backtestService.runBacktest(request, oosData);

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
      const minTradesForType = getOosMinTrades(marketType);
      if (trades < minTradesForType) {
        return { passed: false, sharpeOOS: oosScore, drawdownOOS: metrics.maxDrawdown, tradesOOS: trades, winRateOOS: metrics.winRate, marketsEvaluated, reason: `Trades ${trades} < ${minTradesForType} (${marketType} min)` };
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
  private async runOOSAndPersist(best: OptimizationResult, marketType: string): Promise<void> {
    try {
      const oosResult = await this.validateOnOOS(best.params, best.sharpe, marketType);

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
  // Strategy update — Phase A: per-type writes (idempotent globals + per-type weights)
  //
  // Returns { wasApplied } so the caller can collect winners and invoke
  // applyGlobalThresholds() ONCE per cycle with the highest-Sharpe winner.
  // Pre-#145 this method also redeployed the global combo strategy and updated
  // executor.config; that block now lives in applyGlobalThresholds. See
  // docs/plans/2026-04-29-update-strategy-global-thresholds-design.md.
  // ============================================================
  private async updateStrategy(result: OptimizationResult, marketType: string): Promise<{ wasApplied: boolean }> {
    // Basic sanity checks
    if (result.sharpe > 8) {
      console.log(`[OptimizationScheduler] Extremely high Sharpe ${result.sharpe.toFixed(2)}, proceeding with caution`);
    }
    if (result.trades < 5) {
      console.log(`[OptimizationScheduler] Few trades (${result.trades}), allowing for paper trading`);
    }
    if (result.totalReturn < -0.1) {
      console.log(`[OptimizationScheduler] Negative return (${(result.totalReturn * 100).toFixed(1)}%), skipping deployment`);
      return { wasApplied: false };
    }

    // OOS Validation Gate (already ran in runOOSAndPersist)
    const oosResult = this._lastOOSResult;
    if (!oosResult || !oosResult.passed) {
      console.log(`[OptimizationScheduler] OOS validation FAILED: ${oosResult?.reason ?? 'no OOS result available'}`);
      if (oosResult) {
        console.log(`[OptimizationScheduler] OOS metrics: Sharpe=${oosResult.sharpeOOS.toFixed(2)}, DD=${(oosResult.drawdownOOS * 100).toFixed(1)}%, Trades=${oosResult.tradesOOS}, WR=${(oosResult.winRateOOS * 100).toFixed(1)}%`);
      }
      return { wasApplied: false };
    }

    console.log(`[OptimizationScheduler] OOS validation PASSED: Sharpe=${oosResult.sharpeOOS.toFixed(2)}, Trades=${oosResult.tradesOOS}`);
    console.log(`[OptimizationScheduler] Persisting per-type weights for ${marketType}...`);

    // Capture the previous-best Sharpe BEFORE we overwrite it. The min-lift
    // gate below uses this to decide whether to flip direction_multiplier for
    // this market_type.
    const previousBestSharpe = this.state.bestSharpePerType[marketType];

    // Update local state
    this.state.bestParams = result.params;
    this.state.bestSharpePerType[marketType] = result.sharpe;

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

    // Reset the __global__ direction_multiplier row to +1.0 every cycle.
    //
    // Note: this is NOT a pin — direction_multiplier IS optimized per-type
    // (categorical {-1, +1}) via REFINEMENT_PARAM_SPACE / WEIGHT_PARAM_MAP
    // below, and per-type rows take precedence in DirectionResolver. The
    // __global__ row is only the fallback when no per-type entry exists.
    //
    // 2026-05-04: flipped baseline -1 → +1. Empirical analysis on n=386
    // post-2026-04-07-reset trades showed dm=-1 produced 13.5% WR while the
    // counter direction would have hit 84.7%. The "91.5% when flipped"
    // result cited here previously held at the time of measurement, but
    // signal-generator changes since then made raw outputs correctly
    // directional, so the -1 became a double-flip in production.
    //
    // Per-type drift is gated by OPTIMIZER_DM_FLIP_MIN_LIFT (#174).
    try {
      await signalWeightsRepo.update('direction_multiplier', 1.0, `optimization-${new Date().toISOString().slice(0, 10)}`);
      console.log('[OptimizationScheduler] direction_multiplier __global__ reset to +1.0 (per-type values preserved)');
    } catch (err) {
      console.error('[OptimizationScheduler] Failed to reset __global__ direction_multiplier to +1.0:', err);
    }

    // Sub-project B.2 (issue #129): persist the trial's optimal consensus
    // discount floor to the __global__ row of signal_weights. The combiner
    // reads consensus_discount_floor only at startup from the __global__
    // row (server.ts:661), so per-type writes have no runtime effect — the
    // global write is the contract. Domain [0, 1] is enforced upstream by
    // OPTUNA_PARAM_SPACE; clamp here is defensive against malformed params.
    const cdfRaw = result.params['combiner.consensusDiscountFloor'];
    if (cdfRaw !== undefined && cdfRaw !== null && Number.isFinite(Number(cdfRaw))) {
      const cdf = Math.max(0, Math.min(1, Number(cdfRaw)));
      try {
        await signalWeightsRepo.update(
          'consensus_discount_floor',
          cdf,
          `optimization-${new Date().toISOString().slice(0, 10)}-${marketType}`,
        );
        console.log(`[OptimizationScheduler] consensus_discount_floor __global__ updated to ${cdf.toFixed(4)} (winner: ${marketType})`);
      } catch (err) {
        console.error('[OptimizationScheduler] Failed to persist consensus_discount_floor:', err);
      }
    }

    // Apply optimized signal weights to database
    const WEIGHT_PARAM_MAP: Record<string, string> = {
      'combiner.momentumWeight': 'momentum',
      'combiner.meanReversionWeight': 'mean_reversion',
      'combiner.ofiWeight': 'ofi',
      'combiner.hawkesWeight': 'hawkes',
      'combiner.volumeAnomalyWeight': 'volume_anomaly',
      'combiner.mlofiWeight': 'mlofi',
      'combiner.spreadCompressionWeight': 'spread_compression',
      'combiner.resolutionPriorWeight': 'resolution_prior',
      'combiner.favoriteLongshotBiasWeight': 'favorite_longshot_bias',
      'combiner.resolutionPriorV2Weight': 'resolution_prior_v2',
      // Per-type dm (REFINEMENT_PARAM_SPACE only). Categorical {-1, +1} so the
      // generic clamp below trivially preserves the value. Min-lift gate
      // (OPTIMIZER_DM_FLIP_MIN_LIFT) gates flips when configured.
      'combiner.directionMultiplier': 'direction_multiplier',
    };

    const MIN_WEIGHT = -1.5;  // Allow negative (contrarian) weights
    const MAX_WEIGHT = 3.0;

    for (const [paramKey, signalType] of Object.entries(WEIGHT_PARAM_MAP)) {
      const rawWeight = result.params[paramKey];
      if (rawWeight !== undefined && rawWeight !== null) {
        const weight = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, Number(rawWeight)));

        // Min-lift gate for direction_multiplier flips. Default 0 = always
        // proceed (gate disabled). Operators opt in via env var when a
        // regression is observed. The gate compares this trial's Sharpe
        // against the previous-best Sharpe for this market_type and skips
        // the flip when lift < threshold.
        if (signalType === 'direction_multiplier') {
          const minLift = parseFloat(process.env.OPTIMIZER_DM_FLIP_MIN_LIFT ?? '0');
          if (Number.isFinite(minLift) && minLift > 0) {
            try {
              const currentDm = await signalWeightsRepo.getPerType('direction_multiplier', marketType);
              if (currentDm !== null && currentDm !== weight) {
                const prev = previousBestSharpe;
                // Block the flip when no baseline Sharpe exists yet — the
                // OOS gate has only validated this single trial without
                // anything to compare against. Letting it flip would defeat
                // the purpose of the min-lift gate (observed 2026-05-06: a
                // post-ratchet-reset cycle flipped event_financial dm to -1
                // because lift=Infinity bypassed Number.isFinite). Wait one
                // more cycle to establish baseline before allowing a flip.
                if (prev === undefined || !Number.isFinite(prev)) {
                  console.log(
                    `[OptimizationScheduler] Skipping direction_multiplier flip for ${marketType}: ` +
                    `no baseline Sharpe yet (current=${currentDm}, candidate=${weight}, min_lift=${minLift})`
                  );
                  continue;
                }
                const lift = (result.sharpe ?? 0) - prev;
                if (Number.isFinite(lift) && lift < minLift) {
                  console.log(
                    `[OptimizationScheduler] Skipping direction_multiplier flip for ${marketType}: ` +
                    `lift=${lift.toFixed(3)} < min_lift=${minLift} (current=${currentDm}, candidate=${weight})`
                  );
                  continue;  // skip the updatePerType for THIS signal_type only
                }
              }
            } catch (err) {
              console.error(`[OptimizationScheduler] Min-lift gate read failed for ${marketType}:`, err);
              // Fall through and proceed with the flip — gate is best-effort.
            }
          }
        }

        try {
          await signalWeightsRepo.updatePerType(
            signalType,
            marketType,
            weight,
            `optimization-${new Date().toISOString().slice(0, 10)}-${marketType}`
          );
          console.log(`[OptimizationScheduler] Updated signal weight: ${signalType}[${marketType}] = ${weight.toFixed(4)}`);

          // direction_multiplier per-type live runtime is owned by
          // DirectionResolver, which reads `direction_multiplier_policy.perMarketType[X]`
          // from `trading_config` — NOT from `signal_weights`. Pre-2026-05-06
          // every Optuna apply wrote to signal_weights only, so the runtime
          // never picked up Optuna's per-type decisions (architectural
          // mismatch). Sync the JSON policy here so the categorical {-1, +1}
          // choice that the trial validated against actually takes effect.
          if (signalType === 'direction_multiplier') {
            await this.syncDirectionMultiplierPolicy(marketType, weight);
          }
        } catch (err) {
          console.error(`[OptimizationScheduler] Failed to update weight ${signalType}:`, err);
        }
      }
    }

    // Persist priceRange.* multipliers to price_range_matrix and live-update
    // the SignalEngine modifier so production picks them up without a restart.
    // Matrix is global (not per-type) — the per-type loop runs N times per
    // cycle and the last-in winner determines the persisted matrix. That's
    // intentional for a first cut; per-type matrices would multiply storage
    // and Optuna trials with marginal ROI until empirics demand it.
    await this.persistPriceRangeMultipliers(result.params);

    // Persist mean_reversion.referenceMode + live-update SignalEngine.
    await this.persistMeanReversionReferenceMode(result.params);

    return { wasApplied: true };
  }

  /**
   * Read-modify-write `trading_config.direction_multiplier_policy` so the
   * per-type dm Optuna chose actually takes effect at runtime. Without this
   * sync the value lives only in `signal_weights[direction_multiplier]`,
   * which DirectionResolver does not read.
   */
  private async syncDirectionMultiplierPolicy(marketType: string, weight: number): Promise<void> {
    if (!isDatabaseConfigured()) return;
    try {
      const current = await tradingConfigRepo.get<{
        global?: number;
        perMarketType?: Record<string, number>;
        minMultiplier?: number;
        maxMultiplier?: number;
        segments?: unknown[];
      }>('direction_multiplier_policy');
      const base = current ?? { global: 1.0, perMarketType: {}, segments: [] };
      const updated = {
        ...base,
        perMarketType: { ...(base.perMarketType ?? {}), [marketType]: weight },
      };
      await tradingConfigRepo.set(
        'direction_multiplier_policy',
        updated,
        `optimization-${new Date().toISOString().slice(0, 10)}-${marketType}-dm-sync`,
      );
      console.log(`[OptimizationScheduler] Synced direction_multiplier_policy.perMarketType[${marketType}] = ${weight}`);
    } catch (err) {
      console.error(`[OptimizationScheduler] Failed to sync direction_multiplier_policy for ${marketType}:`, err);
    }
  }

  private async persistMeanReversionReferenceMode(params: Record<string, any>): Promise<void> {
    if (!isDatabaseConfigured()) return;
    const raw = params['meanReversion.referenceMode'];
    if (raw !== 'sma' && raw !== 'fixed_50') return;
    try {
      await tradingConfigRepo.set(
        'mean_reversion.reference_mode',
        raw,
        'Optuna-tuned mean_reversion reference anchor (sma | fixed_50)',
      );
      console.log(`[OptimizationScheduler] mean_reversion.reference_mode = ${raw}`);
    } catch (err) {
      console.error('[OptimizationScheduler] Failed to persist mean_reversion.reference_mode:', err);
      return;
    }
    try {
      const { getSignalEngine } = await import('./SignalEngine.js');
      getSignalEngine().setMeanReversionReferenceMode(raw);
      console.log('[OptimizationScheduler] Live-updated SignalEngine mean_reversion.referenceMode');
    } catch (err) {
      console.error('[OptimizationScheduler] Failed to live-update mean_reversion.referenceMode:', err);
    }
  }

  private static readonly PRICE_RANGE_PARAM_MAP: Array<{ param: string; signalId: string; band: 'transitional' | 'uncertain' }> = [
    { param: 'priceRange.momentumTransitional', signalId: 'momentum', band: 'transitional' },
    { param: 'priceRange.momentumUncertain', signalId: 'momentum', band: 'uncertain' },
    { param: 'priceRange.meanReversionTransitional', signalId: 'mean_reversion', band: 'transitional' },
    { param: 'priceRange.meanReversionUncertain', signalId: 'mean_reversion', band: 'uncertain' },
    { param: 'priceRange.crossMarketCorrTransitional', signalId: 'cross_market_corr', band: 'transitional' },
    { param: 'priceRange.crossMarketCorrUncertain', signalId: 'cross_market_corr', band: 'uncertain' },
    { param: 'priceRange.spreadCompressionUncertain', signalId: 'spread_compression', band: 'uncertain' },
    { param: 'priceRange.newsSentimentUncertain', signalId: 'news_sentiment', band: 'uncertain' },
  ];

  private async persistPriceRangeMultipliers(params: Record<string, any>): Promise<void> {
    if (!isDatabaseConfigured()) return;
    const liveUpdates: Record<string, Partial<Record<'transitional' | 'uncertain', number>>> = {};
    for (const { param, signalId, band } of OptimizationScheduler.PRICE_RANGE_PARAM_MAP) {
      const raw = params[param];
      if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
      const clamped = Math.max(0, Math.min(2.0, raw));
      try {
        await priceRangeMatrixRepo.setBand(signalId, band, clamped);
        liveUpdates[signalId] = { ...(liveUpdates[signalId] ?? {}), [band]: clamped };
        console.log(`[OptimizationScheduler] price_range_matrix[${signalId}/${band}] = ${clamped.toFixed(4)}`);
      } catch (err) {
        console.error(`[OptimizationScheduler] Failed to persist priceRange ${signalId}/${band}:`, err);
      }
    }

    if (Object.keys(liveUpdates).length === 0) return;
    try {
      const { getSignalEngine } = await import('./SignalEngine.js');
      const engine = getSignalEngine();
      const baseline = engine.getPriceRangeMatrix();
      const matrixUpdates: Record<string, { normal: number; transitional: number; uncertain: number }> = {};
      for (const [signalId, bandUpdates] of Object.entries(liveUpdates)) {
        const current = baseline[signalId] ?? { normal: 1.0, transitional: 1.0, uncertain: 1.0 };
        matrixUpdates[signalId] = {
          normal: current.normal,
          transitional: bandUpdates.transitional ?? current.transitional,
          uncertain: bandUpdates.uncertain ?? current.uncertain,
        };
      }
      engine.updatePriceRangeMatrix(matrixUpdates);
      console.log(`[OptimizationScheduler] Live-updated SignalEngine priceRange matrix for ${Object.keys(matrixUpdates).length} generators`);
    } catch (err) {
      console.error('[OptimizationScheduler] Failed to live-update SignalEngine priceRange matrix:', err);
    }
  }

  // ============================================================
  // Strategy update — Phase B: global threshold deploy
  //
  // Runs ONCE per cycle in runIncrementalOptimization / runFullOptimization,
  // with the highest-Sharpe winner across the per-type loop. Pre-#145 this
  // ran inside updateStrategy and was clobbered by whichever type processed
  // last. See docs/plans/2026-04-29-update-strategy-global-thresholds-design.md.
  // ============================================================
  private async applyGlobalThresholds(result: OptimizationResult, marketType: string): Promise<void> {
    // Extract minEdge/minConfidence (works for both Optuna and grid params)
    const minEdge = result.params['combiner.minCombinedStrength']
      ?? result.params.minEdge
      ?? DEFAULT_BEST_PARAMS.minEdge;
    const minConfidence = result.params['combiner.minCombinedConfidence']
      ?? result.params.minConfidence
      ?? DEFAULT_BEST_PARAMS.minConfidence;

    console.log(`[OptimizationScheduler] Applying global thresholds from ${marketType} winner: minEdge=${minEdge}, minConfidence=${minConfidence}`);

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
      console.error('[OptimizationScheduler] Failed to apply global thresholds:', error);
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
          // Legacy row may not carry market_type; per-type ratchet starts fresh on first
          // per-type run after migration. Assign under '__legacy__' so the structure is
          // non-empty and the next per-type comparison falls back to 0 cleanly.
          this.state.bestSharpePerType = { __legacy__: row.best_score };
          this.state.lastFullAt = row.completed_at;
        }
      }

      const stateResult = await query<{
        last_incremental_run_at: Date | null;
        last_full_run_at: Date | null;
        best_sharpe_per_type: Record<string, number> | null;
      }>(`
        SELECT last_incremental_run_at, last_full_run_at, best_sharpe_per_type
        FROM optimization_service_state
        WHERE id = 'main'
      `);

      if (stateResult.rows.length > 0) {
        const state = stateResult.rows[0];
        this.state.lastIncrementalAt = state.last_incremental_run_at;
        this.state.lastFullAt = state.last_full_run_at || this.state.lastFullAt;
        // Restore per-type ratchet if populated; otherwise keep the legacy
        // fallback assigned above. Empty {} is treated as "not yet populated".
        if (state.best_sharpe_per_type && Object.keys(state.best_sharpe_per_type).length > 0) {
          this.state.bestSharpePerType = state.best_sharpe_per_type;
        }
      }

      console.log('[OptimizationScheduler] Loaded state:', {
        bestSharpePerType: this.state.bestSharpePerType,
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
        INSERT INTO optimization_service_state (id, is_running, last_incremental_run_at, last_full_run_at, best_sharpe_per_type, updated_at)
        VALUES ('main', $1, $2, $3, $4::jsonb, NOW())
        ON CONFLICT (id) DO UPDATE SET
          is_running = EXCLUDED.is_running,
          last_incremental_run_at = EXCLUDED.last_incremental_run_at,
          last_full_run_at = EXCLUDED.last_full_run_at,
          best_sharpe_per_type = EXCLUDED.best_sharpe_per_type,
          updated_at = EXCLUDED.updated_at
      `, [
        this.state.isRunning,
        this.state.lastIncrementalAt,
        this.state.lastFullAt,
        JSON.stringify(this.state.bestSharpePerType),
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
