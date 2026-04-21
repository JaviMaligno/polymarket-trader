/**
 * Auto Signal Executor
 *
 * Automatically executes paper trades based on signal outputs.
 * Connects the signal engine to the paper trading system.
 *
 * Trading Logic:
 * - LONG signal: Opens a "Yes" position (buy Yes tokens)
 * - SHORT signal: Opens a "No" position (buy No tokens) OR closes existing Yes position
 * - Positions are properly tracked with P&L calculation on close
 */

import { EventEmitter } from 'events';
import { isDatabaseConfigured, query } from '../database/index.js';
import {
  paperTradesRepo,
  paperPositionsRepo,
  signalPredictionsRepo,
  signalWeightsRepo,
  type SignalPrediction,
  type PaperPosition,
} from '../database/repositories.js';
import { getPositionClosingService } from './PositionClosingService.js';
import { getTokenPrice } from './PriceService.js';
import { getCircuitBreakerService } from './CircuitBreakerService.js';
import { getExecutionRouter } from './ExecutionRouter.js';
import { OrderBookExecutionSimulator, type SimulationResult } from './OrderBookExecutionSimulator.js';

// ---------------------------------------------------------------------------
// Inline score helpers (mirror MarketScorer statics — no cross-package import)
// ---------------------------------------------------------------------------
function clamp01(v: number): number { return Math.min(1, Math.max(0, v)); }

function computeTradeability(price: number | null): number {
  if (price === null) return 0;
  if (price < 0.05 || price > 0.95) return 0;
  if (price >= 0.45 && price <= 0.55) return 0;
  if (price >= 0.15 && price <= 0.40) return 1.0;
  if (price >= 0.60 && price <= 0.85) return 1.0;
  if (price >= 0.05 && price < 0.15) return clamp01((price - 0.05) / 0.10);
  if (price > 0.40 && price < 0.45) return clamp01((0.45 - price) / 0.05);
  if (price > 0.55 && price < 0.60) return clamp01((price - 0.55) / 0.05);
  if (price > 0.85 && price <= 0.95) return clamp01((0.95 - price) / 0.10);
  return 0;
}

const SCORE_MAX_VOLUME_REF = 30_000_000;
function computeLiquidity(volume: number | null, spread: number | null): number {
  if (volume === null || volume <= 0) return 0;
  const raw = clamp01(Math.log(volume) / Math.log(SCORE_MAX_VOLUME_REF));
  return spread !== null && spread > 0.03 ? raw * 0.5 : raw;
}

function computeTtr(endDate: Date | null): number {
  if (endDate === null) return 0.5;
  const days = (endDate.getTime() - Date.now()) / 86_400_000;
  if (days <= 0) return 0;
  if (days < 1) return 0.1;
  if (days <= 7) return 0.1 + 0.9 * (days - 1) / 6;
  if (days <= 60) return 1.0;
  if (days <= 180) return 1.0 - 0.5 * (days - 60) / 120;
  return 0.5;
}

export interface SignalResult {
  signalId: string;
  marketId: string;
  tokenId: string;
  direction: 'long' | 'short';
  strength: number;      // 0-1
  confidence: number;    // 0-1
  price: number;
  marketType?: string;  // crypto_intraday, crypto_daily, event_short, event_long
  metadata?: Record<string, unknown>;
  appliedDirectionMultiplier?: number;  // multiplier used by SignalEngine (from DirectionResolver)
  wasExploration?: boolean;             // true when this trade is an exploration branch
}

export interface ExecutorConfig {
  enabled: boolean;
  minConfidence: number;        // Minimum confidence (0 = trust combiner)
  minStrength: number;          // Minimum signal strength (0 = trust combiner)
  maxPositionSize: number;      // Max $ per position (500)
  maxOpenPositions: number;     // Max concurrent positions (10)
  maxDailyTrades: number;       // Max trades per day (50)
  cooldownMs: number;           // Cooldown between trades same market (60000)
  feeRate: number;              // Trading fee rate (0.001)
  // Smart price validation based on ROI and probability
  minPotentialROI: number;      // Minimum potential ROI to accept (0.15 = 15%)
  minImpliedProbability: number; // Minimum market probability (0.10 = 10%)
  // Asymmetric SHORT gate: block SHORT entries against high-consensus markets
  // (YES price > shortMaxYesPrice). LONG entries are unaffected.
  shortMaxYesPrice: number;     // Max YES price to allow SHORT entry (0.6 default)
  // Asymmetric SHORT sizing: scale SHORT position size by this multiplier.
  // Empirical: 5-day SHORT win rate is 0% — halve size while collecting data.
  shortSizeMultiplier: number;  // Multiplier for SHORT position size (0.5 default)
  // Hysteresis thresholds: higher to open, lower to exit
  openThreshold: number;        // Minimum confidence to OPEN a new position
  exitThreshold: number;        // Minimum confidence to CLOSE an existing position (lower)
}

const DEFAULT_CONFIG: ExecutorConfig = {
  enabled: true,
  // Trust the combiner's optimized thresholds - executor only applies risk limits
  // Set to 0 to disable redundant filtering (combiner already filters)
  minConfidence: parseFloat(process.env.EXECUTOR_MIN_CONFIDENCE || '0'),
  minStrength: parseFloat(process.env.EXECUTOR_MIN_STRENGTH || '0'),
  maxPositionSize: parseInt(process.env.EXECUTOR_MAX_POSITION_SIZE || '500', 10),
  maxOpenPositions: parseInt(process.env.EXECUTOR_MAX_OPEN_POSITIONS || '50', 10),
  maxDailyTrades: parseInt(process.env.EXECUTOR_MAX_DAILY_TRADES || '50', 10),
  cooldownMs: parseInt(process.env.EXECUTOR_MARKET_COOLDOWN_MS || '300000', 10),
  feeRate: 0.001,
  // Smart price validation - configurable via environment variables
  // minPotentialROI: 0.15 means need at least 15% potential gain → rejects prices > ~0.87
  // minImpliedProbability: 0.10 means market must show at least 10% chance → rejects prices < 0.10
  minPotentialROI: parseFloat(process.env.EXECUTOR_MIN_POTENTIAL_ROI || '0.15'),
  minImpliedProbability: parseFloat(process.env.EXECUTOR_MIN_IMPLIED_PROB || '0.10'),
  // Empirical: 5-day analysis (Apr 13-18, 24 SHORTs) showed 0% win rate when
  // SHORTs entered against YES > 0.6. Default optimizable via env.
  shortMaxYesPrice: parseFloat(process.env.EXECUTOR_SHORT_MAX_YES_PRICE || '0.6'),
  shortSizeMultiplier: parseFloat(process.env.EXECUTOR_SHORT_SIZE_MULT || '0.5'),
  // Hysteresis thresholds: higher to open, lower to exit
  openThreshold: parseFloat(process.env.EXECUTOR_OPEN_THRESHOLD || '0.43'),
  exitThreshold: parseFloat(process.env.EXECUTOR_EXIT_THRESHOLD || '0.25'),
};

const STOP_LOSS_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours
// Any position close with realized loss >= this threshold triggers the same 4h cooldown,
// regardless of exit reason (signal, time_exit, etc.). Prevents re-entry into markets
// that consistently lose large amounts due to stale price data or bad market conditions.
const LARGE_LOSS_COOLDOWN_THRESHOLD_USD = 25;
const MAX_POSITIONS_PER_MARKET = 2;
// Block new opens in a market where the last N closed positions all lost money.
// This prevents the system from continuously re-entering a market that has structural
// signal mismatch (e.g. Man City 566188 — 0/25 win rate on SHORT, -$707 total loss;
// WTI crude oil markets 1712297/1712301/1894941 — 21 consecutive losses Apr 2026).
// Default lowered from 5 to 3: observed cycling produces 3-4 losses per market within
// 24h before reaching 5, so 5 was too lenient to stop the re-entry loop.
const PER_MARKET_CONSECUTIVE_LOSS_BLOCK = parseInt(process.env.EXECUTOR_PER_MARKET_LOSS_BLOCK || '3', 10);
const PER_MARKET_LOSS_BLOCK_WINDOW_MS = parseInt(process.env.EXECUTOR_PER_MARKET_LOSS_WINDOW_MS || String(24 * 60 * 60 * 1000), 10);
// Second-tier ban for persistent losers that evade the 24h window (losses spaced >24h apart).
// Trigger: ≥ LONG_TERM_MIN_LOSSES total losses in the last 7 days AND win rate < LONG_TERM_MAX_WIN_RATE.
// e.g. WTI 1712297: 12 losses, 0 wins in 7 days — 1 trade/day → always clears 24h window.
const LONG_TERM_LOSS_WINDOW_MS = parseInt(process.env.EXECUTOR_LONG_TERM_LOSS_WINDOW_MS || String(7 * 24 * 60 * 60 * 1000), 10);
const LONG_TERM_MIN_LOSSES = parseInt(process.env.EXECUTOR_LONG_TERM_MIN_LOSSES || '5', 10);
const LONG_TERM_MAX_WIN_RATE = parseFloat(process.env.EXECUTOR_LONG_TERM_MAX_WIN_RATE || '0.15');
const NEAR_RESOLUTION_HOURS = 24;
const MIN_CONFIDENCE_NEAR_RESOLUTION = 0.65;
// Near-resolved price guard: block new opens when market is effectively decided
// Configurable via env vars (defaults: 0.97 upper, 0.03 lower)
const NEAR_RESOLVED_UPPER = parseFloat(process.env.EXECUTOR_NEAR_RESOLVED_UPPER || '0.97');
const NEAR_RESOLVED_LOWER = parseFloat(process.env.EXECUTOR_NEAR_RESOLVED_LOWER || '0.03');

// Market type gate: only allow trades for these market types (comma-separated)
// If unset, all types are allowed (backward compatible)
const ALLOWED_MARKET_TYPES: Set<string> | null = process.env.ALLOWED_MARKET_TYPES
  ? new Set(process.env.ALLOWED_MARKET_TYPES.split(',').map(t => t.trim()))
  : null;

interface TradeRecord {
  marketId: string;
  timestamp: number;
}

export interface SignalProcessResult {
  executed: boolean;
  reason?: string;
  tradeId?: number;
  predictionId?: number;
  action?: 'open' | 'close';  // What action was taken
  pnl?: number;               // P&L if position was closed
}

export class AutoSignalExecutor extends EventEmitter {
  private config: ExecutorConfig;
  private recentTrades: TradeRecord[] = [];
  private dailyTradeCount = 0;
  private lastDayReset: Date;
  private isRunning = false;
  // Track processed signals to prevent duplicates (key: marketId+direction, value: timestamp)
  private processedSignals: Map<string, number> = new Map();
  private readonly SIGNAL_DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
  private stoppedOutMarkets: Map<string, number> = new Map();
  private nearResolutionMarkets: Set<string> = new Set();
  private simulator: OrderBookExecutionSimulator;

  constructor(config?: Partial<ExecutorConfig>, simulator?: OrderBookExecutionSimulator) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.simulator = simulator || new OrderBookExecutionSimulator();
    this.lastDayReset = new Date();
    this.lastDayReset.setHours(0, 0, 0, 0);
  }

  registerStopLossCooldown(closingService: import('events').EventEmitter): void {
    closingService.on('position:closed', ({ marketId, reason, netPnl }: { marketId: string; reason: string; netPnl: number }) => {
      const isStopLoss = reason === 'stop_loss';
      const isLargeLoss = typeof netPnl === 'number' && netPnl <= -LARGE_LOSS_COOLDOWN_THRESHOLD_USD;
      if (isStopLoss || isLargeLoss) {
        if (this.nearResolutionMarkets.has(marketId)) {
          // Permanent cooldown for near-resolution markets (set far-future timestamp)
          const until = Date.now() + 365 * 24 * 3600000;
          this.stoppedOutMarkets.set(marketId, until);
          this.persistCooldown(marketId, until);
          console.log(`[AutoExecutor] PERMANENT stop-loss cooldown for near-resolution market ${marketId.substring(0, 12)}...`);
        } else {
          const triggerReason = isStopLoss ? 'stop_loss' : `large_loss($${Math.abs(netPnl).toFixed(2)})`;
          const stoppedAt = Date.now();
          this.stoppedOutMarkets.set(marketId, stoppedAt);
          this.persistCooldown(marketId, stoppedAt + STOP_LOSS_COOLDOWN_MS);
          console.log(`[AutoExecutor] Stop-loss cooldown activated for ${marketId.substring(0, 12)}... [${triggerReason}] (${STOP_LOSS_COOLDOWN_MS / 3600000}h)`);
        }
      }
    });
  }

  /**
   * Persist a stop-loss cooldown to trading_config so it survives restarts.
   * Key format: stoploss_cooldown:{marketId}
   */
  private persistCooldown(marketId: string, until: number): void {
    const key = `stoploss_cooldown:${marketId}`;
    query(
      `INSERT INTO trading_config (key, value, description, updated_at)
       VALUES ($1, $2::jsonb, 'stop-loss cooldown', NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
      [key, JSON.stringify({ until })]
    ).catch(err => console.error('[AutoExecutor] Failed to persist cooldown:', err));
  }

  /**
   * Record a shadow trade for a signal blocked by the market type gate.
   * Fire-and-forget — errors are logged but don't affect signal processing.
   */
  private async insertShadowTrade(
    signal: SignalResult,
    signalTypeOverride?: string
  ): Promise<void> {
    // Compute theoretical position size using the same logic as openPosition
    let weight = 0.5;
    try {
      const weightRecord = await signalWeightsRepo.get(signal.signalId);
      if (weightRecord) weight = Number(weightRecord.weight);
    } catch { /* use default */ }

    const sizeMultiplier = signal.confidence * Math.abs(signal.strength) * weight;
    const positionValue = Math.min(
      this.config.maxPositionSize * sizeMultiplier,
      this.config.maxPositionSize
    );
    const shares = Math.floor(positionValue / signal.price);
    if (shares < 1) return; // Too small to record

    await query(
      `INSERT INTO shadow_trades (time, market_id, market_type, direction, entry_price, theoretical_size, signal_strength, signal_confidence, signal_type)
       VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        signal.marketId,
        signal.marketType,
        signal.direction,
        signal.price,
        shares,
        Math.abs(signal.strength),
        signal.confidence,
        signalTypeOverride ?? signal.signalId,
      ]
    );
  }

  /**
   * Load stop-loss cooldowns from trading_config on startup.
   * Restores the in-memory Map so cooldowns survive service restarts.
   */
  async loadPersistedCooldowns(): Promise<void> {
    if (!isDatabaseConfigured()) return;
    try {
      const result = await query<{ key: string; value: string }>(
        `SELECT key, value FROM trading_config WHERE key LIKE 'stoploss_cooldown:%'`
      );
      const now = Date.now();
      for (const row of result.rows) {
        const marketId = row.key.replace('stoploss_cooldown:', '');
        const { until } = JSON.parse(row.value) as { until: number };
        if (until > now) {
          // Store as the original "stoppedAt" timestamp so check logic (Date.now() - stoppedAt < cooldownMs) works
          this.stoppedOutMarkets.set(marketId, until - STOP_LOSS_COOLDOWN_MS);
          console.log(`[AutoExecutor] Restored stop-loss cooldown for ${marketId.substring(0, 12)}... (expires in ${((until - now) / 3600000).toFixed(1)}h)`);
        } else {
          // Expired — clean up from DB
          query(`DELETE FROM trading_config WHERE key = $1`, [row.key]).catch(() => {});
        }
      }
    } catch (err) {
      console.error('[AutoExecutor] Failed to load persisted cooldowns:', err);
    }
  }

  /**
   * Ensure the shadow_trades table exists. The init/*.sql migrations only run on
   * first TimescaleDB initialization, so post-deploy schema changes won't apply
   * to existing volumes. Mirrors the trading_config pattern in CircuitBreakerService.
   */
  async ensureShadowTradesTable(): Promise<void> {
    if (!isDatabaseConfigured()) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS shadow_trades (
          id SERIAL PRIMARY KEY,
          time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          market_id VARCHAR(255) NOT NULL,
          market_type VARCHAR(20) NOT NULL,
          direction VARCHAR(5) NOT NULL,
          entry_price FLOAT NOT NULL,
          theoretical_size FLOAT NOT NULL,
          signal_strength FLOAT NOT NULL,
          signal_confidence FLOAT NOT NULL,
          signal_type VARCHAR(100),
          resolved_at TIMESTAMPTZ,
          resolution_price FLOAT,
          theoretical_pnl FLOAT
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_shadow_trades_market_type ON shadow_trades(market_type)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_shadow_trades_time ON shadow_trades(time DESC)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_shadow_trades_unresolved ON shadow_trades(resolved_at) WHERE resolved_at IS NULL`);
    } catch (error) {
      console.error('[AutoExecutor] Failed to ensure shadow_trades table:', error);
    }
  }

  /**
   * Process a signal and potentially execute a trade
   *
   * Trading Logic:
   * - LONG signal + no position → Open "Yes" position (buy Yes tokens)
   * - LONG signal + existing position → Do nothing (already have position)
   * - SHORT signal + existing Yes → CLOSE position (sell to exit)
   * - SHORT signal + no position → Open "No" position (buy No tokens)
   */
  async processSignal(signal: SignalResult): Promise<SignalProcessResult> {
    if (!this.config.enabled) {
      // console.log(`[AutoExecutor] REJECTED ${signal.marketId.substring(0, 12)}... : Executor disabled`);
      return { executed: false, reason: 'Executor disabled' };
    }

    if (!isDatabaseConfigured()) {
      // console.log(`[AutoExecutor] REJECTED ${signal.marketId.substring(0, 12)}... : Database not configured`);
      return { executed: false, reason: 'Database not configured' };
    }

    // 0a. Check circuit breaker in-memory halt flag (works even when DB is down)
    if (getCircuitBreakerService().isTradingHalted()) {
      return { executed: false, reason: 'Trading halted by circuit breaker' };
    }

    // 0. CRITICAL: Verify market is active in database (defense in depth)
    // NOTE: signal.marketId may be either:
    //   - Gamma API's market.id (stored as 'id' in DB)
    //   - CLOB API's condition_id (stored as 'condition_id' in DB)
    // We search by BOTH to handle signals from PolymarketService (uses condition_id)
    let isNearResolution = false;
    try {
      const marketCheck = await query<{ is_active: boolean; is_resolved: boolean; end_date: string | null }>(
        `SELECT is_active, is_resolved, end_date FROM markets WHERE id = $1`,
        [signal.marketId]
      );

      if (marketCheck.rows.length === 0) {
        console.log(`[AutoExecutor] REJECTED ${signal.marketId.substring(0, 12)}... : Market not found in database (checked id and condition_id)`);
        return { executed: false, reason: 'Market not found in database' };
      }

      const market = marketCheck.rows[0];
      if (market.is_active === false) {
        console.log(`[AutoExecutor] REJECTED ${signal.marketId.substring(0, 12)}... : Market is inactive`);
        return { executed: false, reason: 'Market is inactive' };
      }
      if (market.is_resolved === true) {
        console.log(`[AutoExecutor] REJECTED ${signal.marketId.substring(0, 12)}... : Market is resolved`);
        return { executed: false, reason: 'Market is already resolved' };
      }

      // 0b. Near-resolved price guard: block new opens when price signals market is decided
      // Allows closes (selling existing positions) — only blocks new entries
      if (signal.price >= NEAR_RESOLVED_UPPER || signal.price <= NEAR_RESOLVED_LOWER) {
        // Check if this is a close of an OPEN position — allow those through
        // getAll() only returns open positions (closed_at IS NULL)
        const openPositions = await paperPositionsRepo.getAll();
        const hasOpenPosition = openPositions.some(p => p.market_id === signal.marketId);
        const isClose = signal.direction === 'short' && hasOpenPosition;
        if (!isClose) {
          console.log(`[AutoExecutor] REJECTED ${signal.marketId.substring(0, 12)}... : Near-resolved price $${signal.price.toFixed(4)} (bounds: ${NEAR_RESOLVED_LOWER}-${NEAR_RESOLVED_UPPER})`);
          return { executed: false, reason: `Near-resolved market: price $${signal.price.toFixed(4)} outside ${NEAR_RESOLVED_LOWER}-${NEAR_RESOLVED_UPPER} range` };
        }
      }

      // 0c. Near-resolution market protection (time-based)
      if (market.end_date) {
        const hoursToResolution = (new Date(market.end_date).getTime() - Date.now()) / 3600000;
        if (hoursToResolution > 0 && hoursToResolution < NEAR_RESOLUTION_HOURS) {
          isNearResolution = true;
          this.nearResolutionMarkets.add(signal.marketId);
          if (signal.signalId === 'mean_reversion') {
            return { executed: false, reason: `Rejecting mean_reversion on near-resolution market (${hoursToResolution.toFixed(1)}h to resolve)` };
          }
          if (signal.confidence < MIN_CONFIDENCE_NEAR_RESOLUTION) {
            return { executed: false, reason: `Insufficient confidence for near-resolution market (${signal.confidence.toFixed(2)} < ${MIN_CONFIDENCE_NEAR_RESOLUTION})` };
          }
          console.log(`[AutoExecutor] Near-resolution market (${hoursToResolution.toFixed(1)}h) — half position size`);
        }
      }
    } catch (error) {
      console.error('[AutoExecutor] Failed to verify market status:', error);
      return { executed: false, reason: 'Cannot verify market status - rejecting for safety' };
    }

    // 0d. Market type gate: restrict new opens to allowed types
    // Treat undefined marketType as 'unclassified' — unclassified markets are blocked by default
    const effectiveMarketType = signal.marketType || 'unclassified';
    if (ALLOWED_MARKET_TYPES && !ALLOWED_MARKET_TYPES.has(effectiveMarketType)) {
      // Check if this is a close of an existing position — always allow closes
      try {
        const openPositions = await paperPositionsRepo.getAll();
        const hasOpenPosition = openPositions.some(p => p.market_id === signal.marketId);
        if (!hasOpenPosition) {
          console.log(`[AutoExecutor] REJECTED ${signal.marketId.substring(0, 12)}... : market_type_not_allowed (${effectiveMarketType})`);
          // Fire-and-forget shadow trade insert
          this.insertShadowTrade(signal).catch(() => {});
          return { executed: false, reason: `market_type_not_allowed: ${effectiveMarketType}` };
        }
      } catch {
        // If we can't check positions, block the trade for safety
        console.log(`[AutoExecutor] REJECTED ${signal.marketId.substring(0, 12)}... : market_type_not_allowed (${effectiveMarketType}, position check failed)`);
        return { executed: false, reason: `market_type_not_allowed: ${effectiveMarketType}` };
      }
    }

    // Reset daily counter if new day
    this.checkDayReset();

    // 1. Check signal strength threshold
    if (Math.abs(signal.strength) < this.config.minStrength) {
      const reason = `Strength ${Math.abs(signal.strength).toFixed(2)} below threshold ${this.config.minStrength}`;
      // console.log(`[AutoExecutor] REJECTED ${signal.marketId.substring(0, 12)}... : ${reason}`);
      return { executed: false, reason };
    }

    // 2. Check daily trade limit
    if (this.dailyTradeCount >= this.config.maxDailyTrades) {
      const reason = `Daily trade limit reached (${this.config.maxDailyTrades})`;
      // console.log(`[AutoExecutor] REJECTED ${signal.marketId.substring(0, 12)}... : ${reason}`);
      return { executed: false, reason };
    }

    // 3. Check cooldown for this market
    const recentTradeForMarket = this.recentTrades.find(
      t => t.marketId === signal.marketId &&
           Date.now() - t.timestamp < this.config.cooldownMs
    );
    if (recentTradeForMarket) {
      const remaining = this.config.cooldownMs - (Date.now() - recentTradeForMarket.timestamp);
      return { executed: false, reason: `Market in cooldown (${Math.ceil(remaining / 1000)}s remaining)` };
    }

    // 3a. Stop-loss re-entry cooldown
    const stoppedAt = this.stoppedOutMarkets.get(signal.marketId);
    if (stoppedAt && Date.now() - stoppedAt < STOP_LOSS_COOLDOWN_MS) {
      const remainingH = ((STOP_LOSS_COOLDOWN_MS - (Date.now() - stoppedAt)) / 3600000).toFixed(1);
      return { executed: false, reason: `Market in stop-loss cooldown (${remainingH}h remaining)` };
    }
    for (const [key, ts] of this.stoppedOutMarkets) {
      if (Date.now() - ts > STOP_LOSS_COOLDOWN_MS) {
        this.stoppedOutMarkets.delete(key);
        query(`DELETE FROM trading_config WHERE key = $1`, [`stoploss_cooldown:${key}`]).catch(() => {});
      }
    }

    // 3b. Signal deduplication - prevent processing same signal type for same market within 5-min window
    const dedupKey = `${signal.marketId}:${signal.direction}`;
    const lastProcessed = this.processedSignals.get(dedupKey);
    if (lastProcessed && Date.now() - lastProcessed < this.SIGNAL_DEDUP_WINDOW_MS) {
      const reason = `Duplicate signal (${signal.direction}) within 5min window`;
      // console.log(`[AutoExecutor] REJECTED ${signal.marketId.substring(0, 12)}... : ${reason}`);
      return { executed: false, reason };
    }
    // Clean old entries
    for (const [key, ts] of this.processedSignals) {
      if (Date.now() - ts > this.SIGNAL_DEDUP_WINDOW_MS) {
        this.processedSignals.delete(key);
      }
    }
    this.processedSignals.set(dedupKey, Date.now());

    // 4. Get existing positions
    let positions: PaperPosition[] = [];
    let existingPosition: PaperPosition | undefined;
    try {
      positions = await paperPositionsRepo.getAll();
      // Find position for this market - check both by market_id alone and by market_id + token_id
      // First try exact match (same token), then any position in same market
      existingPosition = positions.find(p => p.market_id === signal.marketId && p.token_id === signal.tokenId)
        || positions.find(p => p.market_id === signal.marketId);
    } catch (error) {
      console.error('Failed to check positions:', error);
      return { executed: false, reason: 'Failed to check positions' };
    }

    // Hysteresis: use lower exit threshold when closing an existing position,
    // higher open threshold when entering a new position
    const isClosingExistingLong = signal.direction === 'short' && !!existingPosition;
    const threshold = isClosingExistingLong
      ? this.config.exitThreshold
      : this.config.openThreshold;
    if (signal.confidence < threshold) {
      const action = isClosingExistingLong ? 'exit' : 'open';
      return {
        executed: false,
        reason: `Confidence ${signal.confidence.toFixed(2)} below ${action} threshold ${threshold}`,
      };
    }

    // 4a. Per-market concentration limit (only for new opens, not closes)
    const isClosingExisting = signal.direction === 'short' && !!existingPosition;
    if (!isClosingExisting) {
      const openOnMarket = positions.filter(
        p => p.market_id === signal.marketId && Number(p.size) > 0
      ).length;
      if (openOnMarket >= MAX_POSITIONS_PER_MARKET) {
        return { executed: false, reason: `At market position limit (${openOnMarket}/${MAX_POSITIONS_PER_MARKET})` };
      }

      // 4b. Per-market consecutive-loss block (new opens only)
      // If the last PER_MARKET_CONSECUTIVE_LOSS_BLOCK closed positions in this market all
      // lost money within the window, skip new entries. This prevents the system from
      // re-entering markets with structural signal mismatch (e.g. 0/25 win rate on SHORT
      // positions in market 566188 due to consistent fee+spread drag in the wrong direction).
      try {
        const lossResult = await query<{ realized_pnl: string }>(
          `SELECT realized_pnl FROM paper_positions
           WHERE market_id = $1
             AND closed_at IS NOT NULL
             AND closed_at >= NOW() - $2::interval
           ORDER BY closed_at DESC
           LIMIT $3`,
          [signal.marketId, `${PER_MARKET_LOSS_BLOCK_WINDOW_MS} milliseconds`, PER_MARKET_CONSECUTIVE_LOSS_BLOCK]
        );
        if (lossResult.rows.length >= PER_MARKET_CONSECUTIVE_LOSS_BLOCK) {
          const allLosing = lossResult.rows.every(r => parseFloat(r.realized_pnl) < 0);
          if (allLosing) {
            console.log(`[AutoExecutor] BLOCKED ${signal.marketId.substring(0, 12)}...: last ${PER_MARKET_CONSECUTIVE_LOSS_BLOCK} positions all lost money`);
            return {
              executed: false,
              reason: `Market blocked: last ${PER_MARKET_CONSECUTIVE_LOSS_BLOCK} closed positions all lost (24h window)`,
            };
          }
        }
      } catch {
        // Non-fatal: proceed without the check
      }

      // 4c. Long-term persistent loser ban (7-day window, rate-based)
      // Catches markets that lose consistently but with gaps > 24h between trades,
      // which evade the 24h consecutive block above.
      try {
        const longTermResult = await query<{ losses: string; wins: string }>(
          `SELECT
             COUNT(*) FILTER (WHERE realized_pnl < 0) AS losses,
             COUNT(*) FILTER (WHERE realized_pnl >= 0) AS wins
           FROM paper_positions
           WHERE market_id = $1
             AND closed_at IS NOT NULL
             AND closed_at >= NOW() - $2::interval`,
          [signal.marketId, `${LONG_TERM_LOSS_WINDOW_MS} milliseconds`]
        );
        if (longTermResult.rows.length > 0) {
          const losses = parseInt(longTermResult.rows[0].losses, 10);
          const wins = parseInt(longTermResult.rows[0].wins, 10);
          const total = losses + wins;
          const winRate = total > 0 ? wins / total : 0;
          if (losses >= LONG_TERM_MIN_LOSSES && winRate < LONG_TERM_MAX_WIN_RATE) {
            console.log(`[AutoExecutor] BLOCKED ${signal.marketId.substring(0, 12)}...: ${losses} losses, ${(winRate * 100).toFixed(0)}% win rate in 7-day window`);
            return {
              executed: false,
              reason: `Market blocked: ${losses} losses with ${(winRate * 100).toFixed(0)}% win rate in 7-day window`,
            };
          }
        }
      } catch {
        // Non-fatal: proceed without the check
      }
    }

    // 5. Handle SHORT signal - can EXIT existing LONG or ENTER "No" position
    if (signal.direction === 'short') {
      if (existingPosition) {
        // Close the existing LONG position
        console.log(`[AutoExecutor] SHORT signal for ${signal.marketId.substring(0, 12)}... - closing existing position (token: ${existingPosition.token_id?.substring(0, 12)}...)`);
        return this.closePosition(existingPosition, signal);
      }

      // No existing position - open a "No" position (bet against the market)
      // But first verify we have a valid No token
      if (!signal.tokenId || signal.tokenId === 'undefined') {
        return { executed: false, reason: 'No valid token_id for No position' };
      }

      // Check max open positions first
      if (positions.length >= this.config.maxOpenPositions) {
        const reason = `Max open positions reached (${positions.length}/${this.config.maxOpenPositions})`;
        // console.log(`[AutoExecutor] REJECTED ${signal.marketId.substring(0, 12)}... : ${reason}`);
        return { executed: false, reason };
      }

      // Open position on the "No" side
      console.log(`[AutoExecutor] SHORT signal for ${signal.marketId.substring(0, 12)}... - opening NO position @ $${signal.price.toFixed(4)}`);
      return this.openPosition(signal, isNearResolution);
    }

    // 6. Handle LONG signal - this is our ENTRY strategy
    if (signal.direction === 'long') {
      if (existingPosition) {
        return { executed: false, reason: 'Already have LONG position in this market' };
      }

      // Check max open positions
      if (positions.length >= this.config.maxOpenPositions) {
        return { executed: false, reason: `Max open positions reached (${this.config.maxOpenPositions})` };
      }

      return this.openPosition(signal, isNearResolution);
    }

    return { executed: false, reason: 'Unknown signal direction' };
  }

  /**
   * Open a new LONG position
   */
  private async openPosition(signal: SignalResult, isNearResolution = false): Promise<SignalProcessResult> {
    // SMART PRICE VALIDATION based on ROI and probability
    // This is more intuitive than fixed bounds and adapts to market conditions

    // 1. Calculate potential ROI: if we buy at price P, max payout is $1.00
    //    maxROI = (1 - P) / P
    //    At P=0.90: ROI=11%, P=0.80: ROI=25%, P=0.50: ROI=100%
    const maxPotentialROI = signal.price > 0 ? (1.0 - signal.price) / signal.price : 0;

    // 2. The market price IS the implied probability of YES outcome
    const impliedProbability = signal.price;

    // Reject if potential ROI is too low (high price = no upside)
    if (maxPotentialROI < this.config.minPotentialROI) {
      const maxAcceptablePrice = 1 / (1 + this.config.minPotentialROI);
      return {
        executed: false,
        reason: `Insufficient upside: max ROI ${(maxPotentialROI * 100).toFixed(1)}% < ${(this.config.minPotentialROI * 100).toFixed(0)}% required (price $${signal.price.toFixed(4)} > $${maxAcceptablePrice.toFixed(2)})`,
      };
    }

    // Reject if implied probability is too low (low price = likely resolved NO)
    if (impliedProbability < this.config.minImpliedProbability) {
      return {
        executed: false,
        reason: `Too speculative: implied probability ${(impliedProbability * 100).toFixed(1)}% < ${(this.config.minImpliedProbability * 100).toFixed(0)}% required (likely resolved NO)`,
      };
    }

    // SHORT YES-price gate: block SHORTs against high-consensus markets.
    // For SHORT signals, signal.price is the NO token price → YES = 1 - signal.price.
    if (signal.direction === 'short') {
      const yesPrice = 1 - signal.price;
      if (yesPrice > this.config.shortMaxYesPrice) {
        return {
          executed: false,
          reason: `SHORT blocked: YES price ${(yesPrice * 100).toFixed(0)}% > ${(this.config.shortMaxYesPrice * 100).toFixed(0)}% threshold (consensus too strong to flip)`,
        };
      }
    }

    // Get signal weight from database
    let weight = 0.5;
    try {
      const weightRecord = await signalWeightsRepo.get(signal.signalId);
      if (weightRecord) {
        weight = Number(weightRecord.weight);
        if (!weightRecord.is_enabled) {
          return { executed: false, reason: `Signal type ${signal.signalId} is disabled` };
        }
      }
    } catch (error) {
      console.warn('Failed to get signal weight, using default:', error);
    }

    // Calculate position size based on confidence, strength (absolute), and weight.
    // SHORT positions get scaled by shortSizeMultiplier (default 0.5x) to limit
    // damage while empirical SHORT win rate remains low.
    const baseSizeMultiplier = signal.confidence * Math.abs(signal.strength) * weight;
    const sideMultiplier = signal.direction === 'short' ? this.config.shortSizeMultiplier : 1.0;
    const sizeMultiplier = baseSizeMultiplier * sideMultiplier;
    const positionValue = Math.min(
      this.config.maxPositionSize * sizeMultiplier,
      this.config.maxPositionSize * sideMultiplier
    ) * (isNearResolution ? 0.5 : 1.0);

    // Calculate number of shares based on price
    const shares = Math.floor(positionValue / signal.price);
    if (shares < 1) {
      return { executed: false, reason: 'Position size too small' };
    }

    // Check account has enough capital + drawdown proximity to CB threshold
    try {
      const accountResult = await query<{ available_capital: string; current_capital: string }>(
        'SELECT available_capital, current_capital FROM paper_account LIMIT 1'
      );
      const availableCapital = parseFloat(accountResult.rows[0]?.available_capital ?? '0');
      const currentCapital = parseFloat(accountResult.rows[0]?.current_capital ?? '0');

      // Don't open if near CB threshold — prevents open->CB->close->reopen cycle
      const initialCapital = parseFloat(process.env.INITIAL_CAPITAL || '10000');
      const drawdownPct = ((initialCapital - currentCapital) / initialCapital) * 100;
      const CB_THRESHOLD = parseFloat(process.env.MAX_DRAWDOWN || '0.15') * 100; // env is decimal (0.15 = 15%)
      if (drawdownPct > CB_THRESHOLD - 2) {
        console.log(`[AutoSignalExecutor] Skipping open — drawdown ${drawdownPct.toFixed(1)}% too close to CB threshold ${CB_THRESHOLD}%`);
        return { executed: false, reason: `Drawdown ${drawdownPct.toFixed(1)}% too close to CB threshold ${CB_THRESHOLD}%` };
      }

      const totalCost = shares * signal.price * (1 + this.config.feeRate);

      if (totalCost > availableCapital) {
        return { executed: false, reason: `Insufficient capital. Need $${totalCost.toFixed(2)}, have $${availableCapital.toFixed(2)}` };
      }
    } catch (error) {
      console.error('Failed to check account:', error);
      return { executed: false, reason: 'Failed to check account' };
    }

    // Fetch market score for entry capture (non-critical — don't fail trade if missing)
    let marketScoreAtEntry: number | null = null;
    let scoreDimensionsAtEntry: Record<string, unknown> | null = null;
    try {
      const mktResult = await query<{
        market_score: string | null;
        current_price_yes: string | null;
        volume_24h: string | null;
        spread: string | null;
        end_date: string | null;
      }>(
        `SELECT market_score, current_price_yes, volume_24h, spread, end_date
         FROM   markets
         WHERE  id = $1`,
        [signal.marketId],
      );
      if (mktResult.rows.length > 0) {
        const m = mktResult.rows[0];
        marketScoreAtEntry = m.market_score != null ? Number(m.market_score) : null;

        const price = m.current_price_yes != null ? Number(m.current_price_yes) : null;
        const vol   = m.volume_24h != null ? Number(m.volume_24h) : null;
        const sprd  = m.spread != null ? Number(m.spread) : null;
        const endDate = m.end_date ? new Date(m.end_date) : null;

        scoreDimensionsAtEntry = {
          tradeability: computeTradeability(price),
          liquidity:    computeLiquidity(vol, sprd),
          ttr:          computeTtr(endDate),
          volatility:   null,
          dataQuality:  null,
        };
      }
    } catch (err) {
      // Non-critical — trade proceeds without score capture
    }

    // Record the signal prediction
    let prediction: SignalPrediction | null = null;
    try {
      prediction = await signalPredictionsRepo.create({
        time: new Date(),
        market_id: signal.marketId,
        signal_type: signal.signalId,
        direction: signal.direction,
        strength: signal.strength,
        confidence: signal.confidence,
        price_at_signal: signal.price,
        metadata: signal.metadata,
      });
    } catch (error) {
      console.error('Failed to record prediction:', error);
    }

    // Route through ExecutionRouter for potential real execution
    const executionRouter = getExecutionRouter();
    let executionMode: string = 'paper';
    if (executionRouter) {
      try {
        const execResult = await executionRouter.execute({
          tokenId: signal.tokenId,
          side: 'BUY',
          price: signal.price,
          size: shares,
        });
        executionMode = execResult.execution_mode;
      } catch (routerError) {
        console.warn('[AutoExecutor] ExecutionRouter error, defaulting to paper:', routerError);
      }
    }

    // Execute the BUY trade
    try {
      // Simulate realistic execution via order book
      const sim = await this.simulator.simulateBuy(
        signal.marketId, signal.tokenId, shares, signal.price
      );

      if (!sim.executed) {
        console.log(`[AutoExecutor] Trade rejected by simulator: ${sim.rejectReason}`);
        return { executed: false, reason: `Simulator rejected: ${sim.rejectReason}` };
      }

      // Use simulated values instead of signal.price
      const actualShares = sim.executedSize;
      const actualPrice = sim.executedPrice;
      const actualFee = sim.fee;
      const actualValue = actualShares * actualPrice;

      // Open position atomically: check + debit + insert in one transaction
      // Must happen BEFORE recording the trade to avoid orphaned buy records
      // if the position open fails (e.g., duplicate or insufficient capital).
      const openResult = await paperPositionsRepo.openPositionAtomically(
        {
          market_id: signal.marketId,
          token_id: signal.tokenId,
          side: signal.direction === 'long' ? 'long' : 'short',
          size: actualShares,
          avg_entry_price: actualPrice,
          current_price: actualPrice,
          unrealized_pnl: 0,
          opened_at: new Date(),
          signal_type: signal.signalId,
          market_score_at_entry: marketScoreAtEntry,
          score_dimensions_at_entry: scoreDimensionsAtEntry ?? undefined,
          execution_mode: executionMode,
          applied_direction_multiplier: signal.appliedDirectionMultiplier ?? null,
          was_exploration: signal.wasExploration ?? false,
        },
        actualValue,
        actualFee,
      );

      if (!openResult.opened) {
        return { executed: false, reason: openResult.reason || 'Position open failed' };
      }

      const trade = await paperTradesRepo.create({
        time: new Date(),
        market_id: signal.marketId,
        token_id: signal.tokenId,
        side: 'buy',
        requested_size: shares,
        executed_size: actualShares,
        requested_price: signal.price,
        executed_price: actualPrice,
        slippage_pct: sim.slippagePct,
        fee: actualFee,
        value_usd: actualValue,
        signal_id: prediction?.id,
        signal_type: signal.signalId,
        order_type: 'market',
        fill_type: actualShares < shares ? 'partial' : 'full',
        best_bid: sim.bestBid ?? undefined,
        best_ask: sim.bestAsk ?? undefined,
        fill_source: sim.fillSource,
        snapshot_age_ms: sim.snapshotAgeMs ?? undefined,
        available_depth: sim.availableDepth,
        execution_mode: executionMode,
      });

      // Track the trade
      this.recentTrades.push({ marketId: signal.marketId, timestamp: Date.now() });
      this.dailyTradeCount++;
      this.cleanupOldTrades();

      this.emit('trade:executed', {
        signal,
        trade,
        prediction,
        shares: actualShares,
        value: actualValue,
        action: 'open',
      });

      const side = signal.direction === 'long' ? 'YES' : 'NO';
      console.log(`[AutoExecutor] OPENED: BUY ${actualShares} ${side} shares of ${signal.marketId.substring(0, 20)}... @ $${actualPrice.toFixed(4)} (slippage: ${sim.slippagePct.toFixed(2)}%, source: ${sim.fillSource})`);

      return {
        executed: true,
        tradeId: trade.id,
        predictionId: prediction?.id,
        action: 'open',
      };

    } catch (error) {
      console.error('Failed to execute trade:', error);
      return { executed: false, reason: `Trade execution failed: ${error}` };
    }
  }

  /**
   * Close an existing position (EXIT strategy)
   *
   * Keeps signal-specific logic (price lookup, prediction recording, trade tracking)
   * and delegates the actual close (position update, account update, trade recording)
   * to PositionClosingService for consistent PnL/fee handling.
   */
  private async closePosition(position: PaperPosition, signal: SignalResult): Promise<SignalProcessResult> {
    const shares = Number(position.size);
    const entryPrice = Number(position.avg_entry_price);

    // Exit price lookup via centralized PriceService (single source of truth for Yes/No inversion).
    // Fallback chain: getTokenPrice() → position.current_price → corrected signal.price
    const positionCurrentPrice = position.current_price != null ? Number(position.current_price) : null;
    const signalMatchesPosition = (signal.direction === 'long') === (position.side === 'long');
    const correctedSignalPrice = signalMatchesPosition ? signal.price : 1 - signal.price;

    let exitPrice = positionCurrentPrice != null && positionCurrentPrice > 0
      ? positionCurrentPrice
      : correctedSignalPrice;
    try {
      const freshPrice = await getTokenPrice(position.market_id, position.side as 'long' | 'short');
      if (freshPrice != null && freshPrice > 0) {
        exitPrice = freshPrice;
      }
    } catch (error) {
      console.warn('[AutoExecutor] PriceService failed for exit, using fallback:', error);
    }

    // Note: No price drop sanity check — in prediction markets, a token can
    // legitimately drop 99% (e.g. $0.50 → $0.005) when an event becomes unlikely.
    // Rejecting the exit would trap capital permanently (bought but never sold).

    // Simulate realistic sell execution
    const sim = await this.simulator.simulateSell(
      signal.marketId, position.token_id, shares, exitPrice
    );

    if (!sim.executed) {
      console.log(`[AutoExecutor] Close rejected by simulator: ${sim.rejectReason}`);
      return { executed: false, reason: `Simulator rejected close: ${sim.rejectReason}` };
    }

    // Use simulated exit price
    exitPrice = sim.executedPrice;

    // Record the signal prediction
    let prediction: SignalPrediction | null = null;
    try {
      prediction = await signalPredictionsRepo.create({
        time: new Date(),
        market_id: signal.marketId,
        signal_type: signal.signalId,
        direction: signal.direction,
        strength: signal.strength,
        confidence: signal.confidence,
        price_at_signal: signal.price,
        metadata: { ...signal.metadata, action: 'close' },
      });
    } catch (error) {
      console.error('Failed to record prediction:', error);
    }

    // Route through ExecutionRouter for potential real execution
    const executionRouter = getExecutionRouter();
    let executionMode: string = 'paper';
    if (executionRouter) {
      try {
        const execResult = await executionRouter.execute({
          tokenId: position.token_id,
          side: 'SELL',
          price: exitPrice,
          size: shares,
        });
        executionMode = execResult.execution_mode;
      } catch (routerError) {
        console.warn('[AutoExecutor] ExecutionRouter error on close, defaulting to paper:', routerError);
      }
    }

    // Delegate close to PositionClosingService (position update, account update, trade recording, fee computation)
    const closeResult = await getPositionClosingService().close({
      positionId: (position as any).id,
      marketId: signal.marketId,
      tokenId: position.token_id,
      side: position.side,
      size: shares,
      entryPrice,
      exitPrice,
      reason: 'signal',
      openedAt: position.opened_at ? new Date(position.opened_at) : undefined,
      signalId: signal.signalId,
      predictionId: prediction?.id?.toString(),
      execution_mode: executionMode,
    });

    if (!closeResult.executed) {
      return { executed: false, reason: closeResult.reason || 'Close failed' };
    }

    // Track the trade
    this.recentTrades.push({ marketId: signal.marketId, timestamp: Date.now() });
    this.dailyTradeCount++;
    this.cleanupOldTrades();

    const pnlStr = closeResult.netPnl >= 0 ? `+$${closeResult.netPnl.toFixed(2)}` : `-$${Math.abs(closeResult.netPnl).toFixed(2)}`;
    this.emit('trade:executed', {
      signal,
      tradeId: closeResult.tradeId,
      prediction,
      shares,
      value: shares * exitPrice,
      action: 'close',
      pnl: closeResult.netPnl,
    });

    console.log(`[AutoExecutor] CLOSED: SELL ${shares} shares of ${signal.marketId.substring(0, 20)}... @ $${exitPrice.toFixed(4)} | P&L: ${pnlStr}`);

    return {
      executed: true,
      tradeId: closeResult.tradeId ? parseInt(closeResult.tradeId, 10) : undefined,
      predictionId: prediction?.id,
      action: 'close',
      pnl: closeResult.netPnl,
    };
  }

  /**
   * Clean up old trade records
   */
  private cleanupOldTrades(): void {
    this.recentTrades = this.recentTrades.filter(
      t => Date.now() - t.timestamp < this.config.cooldownMs * 2
    );
  }

  /**
   * Process multiple signals and execute trades for qualifying ones
   */
  async processSignals(signals: SignalResult[]): Promise<{
    processed: number;
    executed: number;
    results: Array<{ signal: SignalResult; result: SignalProcessResult }>;
  }> {
    const results: Array<{ signal: SignalResult; result: SignalProcessResult }> = [];

    // Sort by combined score (confidence * strength)
    const sortedSignals = [...signals].sort(
      (a, b) => (b.confidence * b.strength) - (a.confidence * a.strength)
    );

    for (const signal of sortedSignals) {
      const result = await this.processSignal(signal);
      results.push({ signal, result });

      // Small delay between trades
      if (result.executed) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    return {
      processed: signals.length,
      executed: results.filter(r => r.result.executed).length,
      results,
    };
  }

  /**
   * Start the executor
   */
  start(): void {
    this.isRunning = true;
    this.config.enabled = true;
    console.log('[AutoExecutor] Started');
    this.emit('started');
  }

  /**
   * Stop the executor
   */
  stop(): void {
    this.isRunning = false;
    this.config.enabled = false;
    console.log('[AutoExecutor] Stopped');
    this.emit('stopped');
  }

  /**
   * Check if executor is running
   */
  isActive(): boolean {
    return this.isRunning && this.config.enabled;
  }

  /**
   * Get current configuration
   */
  getConfig(): ExecutorConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<ExecutorConfig>): void {
    this.config = { ...this.config, ...updates };
    this.emit('config:updated', this.config);
  }

  /**
   * Get executor statistics
   */
  getStats(): {
    dailyTradeCount: number;
    recentTradesCount: number;
    isRunning: boolean;
  } {
    return {
      dailyTradeCount: this.dailyTradeCount,
      recentTradesCount: this.recentTrades.length,
      isRunning: this.isRunning,
    };
  }

  /**
   * Reset daily counter if it's a new day
   */
  private checkDayReset(): void {
    const now = new Date();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);

    if (today > this.lastDayReset) {
      this.dailyTradeCount = 0;
      this.lastDayReset = today;
      console.log('[AutoExecutor] Daily trade counter reset');
    }
  }
}

// Singleton instance
let autoSignalExecutor: AutoSignalExecutor | null = null;

export function getAutoSignalExecutor(): AutoSignalExecutor {
  if (!autoSignalExecutor) {
    autoSignalExecutor = new AutoSignalExecutor();
  }
  return autoSignalExecutor;
}

export function initializeAutoSignalExecutor(config?: Partial<ExecutorConfig>, simulator?: OrderBookExecutionSimulator): AutoSignalExecutor {
  autoSignalExecutor = new AutoSignalExecutor(config, simulator);
  return autoSignalExecutor;
}
