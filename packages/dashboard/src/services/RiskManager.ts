/**
 * Risk Manager Service (Dashboard/Paper Trading)
 *
 * Monitors portfolio risk and automatically halts trading when limits are exceeded.
 * NOW USES: Centralized risk profile system with AGGRESSIVE default.
 */

import { EventEmitter } from 'events';
import { isDatabaseConfigured, query } from '../database/index.js';
import { paperPositionsRepo, portfolioSnapshotsRepo } from '../database/repositories.js';
import {
  type RiskConfig,
  getDefaultRiskProfile,
  mergeRiskConfig,
  calculateAdaptiveMultiplier,
} from '@polymarket-trader/backtest';

export type { RiskConfig } from '@polymarket-trader/backtest';

export type RiskViolation = 'drawdown' | 'daily_loss' | 'position_size' | 'total_exposure' | 'manual';

interface RiskStatus {
  isHalted: boolean;
  haltReason: RiskViolation | null;
  haltedAt: Date | null;
  currentDrawdownPct: number;
  dailyPnlPct: number;
  totalExposurePct: number;
  largestPositionPct: number;
  adaptiveMultiplier: number;
  profileType: string;
}

/**
 * Enhanced Risk Manager for Paper Trading
 * - Uses centralized AGGRESSIVE profile by default
 * - Fixed drawdown calculation
 * - Percentage-based daily loss (scalable)
 * - Adaptive risk management
 */
export class RiskManager extends EventEmitter {
  private config: RiskConfig;
  private checkInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isHalted = false;
  private haltReason: RiskViolation | null = null;
  private haltedAt: Date | null = null;
  private peakEquity = 0;
  private dayStartEquity = 0;
  private lastDayReset: Date;
  private adaptiveMultiplier = 1.0;

  constructor(config?: Partial<RiskConfig>) {
    super();

    // Use AGGRESSIVE profile as default
    this.config = config
      ? mergeRiskConfig('AGGRESSIVE', config)
      : getDefaultRiskProfile();

    this.lastDayReset = new Date();
    this.lastDayReset.setHours(0, 0, 0, 0);

    console.log(`[RiskManager] Initialized with ${this.config.profileType} profile`);
  }

  /**
   * Start the risk manager
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[RiskManager] Already running');
      return;
    }

    if (!isDatabaseConfigured()) {
      console.warn('[RiskManager] Database not configured - cannot start');
      return;
    }

    this.isRunning = true;

    // Initialize equity tracking
    await this.initializeEquityTracking();

    console.log(`[RiskManager] Started (check interval: ${this.config.checkIntervalMs / 1000}s)`);

    // Schedule periodic risk checks
    this.checkInterval = setInterval(() => {
      this.checkRisk();
    }, this.config.checkIntervalMs);

    // Initial check
    await this.checkRisk();

    this.emit('started');
  }

  /**
   * Stop the risk manager
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.isRunning = false;
    console.log('[RiskManager] Stopped');
    this.emit('stopped');
  }

  /**
   * Initialize equity tracking from database
   */
  private async initializeEquityTracking(): Promise<void> {
    try {
      const accountResult = await query<{
        current_capital: string;
        peak_equity: string;
      }>('SELECT current_capital, peak_equity FROM paper_account LIMIT 1');

      if (accountResult.rows[0]) {
        const currentCapital = parseFloat(accountResult.rows[0].current_capital);
        this.peakEquity = parseFloat(accountResult.rows[0].peak_equity) || currentCapital;
        this.dayStartEquity = currentCapital;
      }

      // Load day-start snapshot if available
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const earlyMorning = new Date(todayStart);
      earlyMorning.setHours(1, 0, 0, 0);

      const snapshotResult = await query<{ current_capital: string; time: Date }>(
        `SELECT current_capital, time FROM portfolio_snapshots
         WHERE time >= $1 AND time <= $2
         ORDER BY time ASC
         LIMIT 1`,
        [todayStart, earlyMorning]
      );

      if (snapshotResult.rows[0]) {
        this.dayStartEquity = parseFloat(snapshotResult.rows[0].current_capital);
        console.log(`[RiskManager] Using day-start snapshot: $${this.dayStartEquity.toFixed(2)}`);
      } else {
        console.log(`[RiskManager] No snapshot found, using current capital: $${this.dayStartEquity.toFixed(2)}`);
      }

    } catch (error) {
      console.error('[RiskManager] Failed to initialize equity tracking:', error);
    }
  }

  /**
   * Check all risk limits
   * FIXED: Drawdown calculation, percentage-based limits, adaptive mode
   */
  async checkRisk(): Promise<RiskStatus> {
    if (!this.config.enabled || !isDatabaseConfigured()) {
      return this.getStatus();
    }

    // Check if halt cooldown has passed
    if (this.isHalted && this.haltedAt) {
      const haltDuration = Date.now() - this.haltedAt.getTime();
      if (haltDuration >= this.config.cooldownAfterHaltMs) {
        if (this.config.autoResumeAfterCooldown) {
          await this.resumeTrading('Cooldown period ended');
        }
      }
    }

    // Reset daily tracking if new day
    this.checkDayReset();

    try {
      // Get current account state
      const accountResult = await query<{
        initial_capital: string;
        current_capital: string;
        peak_equity: string;
      }>('SELECT initial_capital, current_capital, peak_equity FROM paper_account LIMIT 1');

      if (!accountResult.rows[0]) {
        return this.getStatus();
      }

      const initialCapital = parseFloat(accountResult.rows[0].initial_capital);
      const currentCapital = parseFloat(accountResult.rows[0].current_capital);

      // Update peak equity
      if (currentCapital > this.peakEquity) {
        this.peakEquity = currentCapital;
        await query(
          'UPDATE paper_account SET peak_equity = $1 WHERE id = 1',
          [this.peakEquity]
        );
      }

      // Get positions for exposure calculation
      const positions = await paperPositionsRepo.getAll();
      const totalExposure = positions.reduce(
        (sum, p) => sum + parseFloat(String(p.size)) * parseFloat(String(p.current_price || p.avg_entry_price)),
        0
      );

      // FIXED: Correct drawdown calculation (highWaterMark - current) / highWaterMark
      const currentDrawdownPct = this.peakEquity > 0
        ? ((this.peakEquity - currentCapital) / this.peakEquity) * 100
        : 0;

      // FIXED: Daily loss as percentage (scalable)
      const dailyPnlPct = this.dayStartEquity > 0
        ? ((currentCapital - this.dayStartEquity) / this.dayStartEquity) * 100
        : 0;

      const totalExposurePct = initialCapital > 0
        ? (totalExposure / initialCapital) * 100
        : 0;

      const largestPositionPct = positions.length > 0 && initialCapital > 0
        ? Math.max(...positions.map(p =>
            (parseFloat(String(p.size)) * parseFloat(String(p.current_price || p.avg_entry_price)) / initialCapital) * 100
          ))
        : 0;

      // Calculate adaptive multiplier
      this.adaptiveMultiplier = calculateAdaptiveMultiplier(currentDrawdownPct, this.config);

      // Update max drawdown in database
      await query(
        `UPDATE paper_account SET
          max_drawdown = GREATEST(max_drawdown, $1),
          updated_at = NOW()
        WHERE id = 1`,
        [currentDrawdownPct / 100]
      );

      // Check risk limits with adaptive mode support
      if (!this.isHalted) {
        // Hard halt threshold
        if (currentDrawdownPct >= this.config.haltDrawdownPct) {
          await this.haltTrading('drawdown', `Drawdown ${currentDrawdownPct.toFixed(2)}% exceeded hard halt limit ${this.config.haltDrawdownPct}%`);
        }
        // Max drawdown (adaptive trigger)
        else if (currentDrawdownPct >= this.config.maxDrawdownPct) {
          if (this.config.adaptiveMode === 'NONE') {
            await this.haltTrading('drawdown', `Drawdown ${currentDrawdownPct.toFixed(2)}% exceeded limit ${this.config.maxDrawdownPct}%`);
          } else {
            console.warn(`[RiskManager] Adaptive mode: drawdown ${currentDrawdownPct.toFixed(2)}% - reducing position size to ${(this.adaptiveMultiplier * 100).toFixed(0)}%`);
          }
        }
        // Daily loss
        else if (dailyPnlPct <= -this.config.maxDailyLossPct) {
          if (this.config.adaptiveMode === 'NONE') {
            await this.haltTrading('daily_loss', `Daily loss ${Math.abs(dailyPnlPct).toFixed(2)}% exceeded limit ${this.config.maxDailyLossPct}%`);
          } else {
            console.warn(`[RiskManager] Adaptive mode: daily loss ${Math.abs(dailyPnlPct).toFixed(2)}% - reducing position size`);
          }
        }
        // Total exposure
        else if (totalExposurePct >= this.config.maxExposurePct) {
          await this.haltTrading('total_exposure', `Total exposure ${totalExposurePct.toFixed(2)}% exceeded limit ${this.config.maxExposurePct}%`);
        }
      }

      const status: RiskStatus = {
        isHalted: this.isHalted,
        haltReason: this.haltReason,
        haltedAt: this.haltedAt,
        currentDrawdownPct,
        dailyPnlPct,
        totalExposurePct,
        largestPositionPct,
        adaptiveMultiplier: this.adaptiveMultiplier,
        profileType: this.config.profileType,
      };

      this.emit('risk:checked', status);
      return status;

    } catch (error) {
      console.error('[RiskManager] Risk check failed:', error);
      this.emit('risk:error', error);
      return this.getStatus();
    }
  }

  /**
   * Halt trading due to risk violation
   */
  private async haltTrading(reason: RiskViolation, message: string): Promise<void> {
    if (this.isHalted) return;

    this.isHalted = true;
    this.haltReason = reason;
    this.haltedAt = new Date();

    console.warn(`[RiskManager] TRADING HALTED: ${message}`);

    this.emit('trading:halted', {
      reason,
      message,
      timestamp: this.haltedAt,
    });

    // Record the halt event
    try {
      await query(
        `INSERT INTO trading_config (key, value, description, updated_at)
         VALUES ('trading_halted', $1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET
           value = EXCLUDED.value,
           description = EXCLUDED.description,
           updated_at = NOW()`,
        [JSON.stringify({ halted: true, reason, timestamp: this.haltedAt }), message]
      );
    } catch (error) {
      console.error('[RiskManager] Failed to record halt:', error);
    }
  }

  /**
   * Resume trading after halt
   */
  async resumeTrading(reason = 'Manual resume'): Promise<boolean> {
    if (!this.isHalted) return true;

    // Re-check risk before resuming
    const status = await this.checkRisk();

    // Don't resume if still violating limits (with some buffer)
    if (status.currentDrawdownPct >= this.config.maxDrawdownPct * 0.9) {
      console.warn('[RiskManager] Cannot resume - still in drawdown');
      return false;
    }

    this.isHalted = false;
    this.haltReason = null;
    this.haltedAt = null;

    console.log(`[RiskManager] TRADING RESUMED: ${reason}`);

    this.emit('trading:resumed', {
      reason,
      timestamp: new Date(),
    });

    // Record the resume event
    try {
      await query(
        `UPDATE trading_config SET
          value = $1,
          description = $2,
          updated_at = NOW()
        WHERE key = 'trading_halted'`,
        [JSON.stringify({ halted: false, reason }), reason]
      );
    } catch (error) {
      console.error('[RiskManager] Failed to record resume:', error);
    }

    return true;
  }

  /**
   * Manually halt trading
   */
  async manualHalt(reason = 'Manual halt requested'): Promise<void> {
    await this.haltTrading('manual', reason);
  }

  /**
   * Check if a new trade would violate position limits
   * NOW WITH: Adaptive multiplier support
   */
  async canOpenPosition(positionValue: number): Promise<{
    allowed: boolean;
    reason?: string;
    adaptiveMultiplier?: number;
  }> {
    if (this.isHalted) {
      return { allowed: false, reason: `Trading halted: ${this.haltReason}`, adaptiveMultiplier: 0 };
    }

    if (!isDatabaseConfigured()) {
      return { allowed: true, adaptiveMultiplier: 1 };
    }

    try {
      const accountResult = await query<{ initial_capital: string }>(
        'SELECT initial_capital FROM paper_account LIMIT 1'
      );

      if (!accountResult.rows[0]) {
        return { allowed: true, adaptiveMultiplier: 1 };
      }

      const initialCapital = parseFloat(accountResult.rows[0].initial_capital);

      // Apply adaptive multiplier to position size limit
      const effectiveMaxPct = this.config.maxPositionSizePct * this.adaptiveMultiplier;
      const positionPct = (positionValue / initialCapital) * 100;

      if (positionPct > effectiveMaxPct) {
        return {
          allowed: false,
          reason: `Position size ${positionPct.toFixed(2)}% exceeds adaptive limit ${effectiveMaxPct.toFixed(2)}% (base: ${this.config.maxPositionSizePct}%)`,
          adaptiveMultiplier: this.adaptiveMultiplier,
        };
      }

      // Check total exposure limit
      const positions = await paperPositionsRepo.getAll();
      const currentExposure = positions.reduce(
        (sum, p) => sum + parseFloat(String(p.size)) * parseFloat(String(p.current_price || p.avg_entry_price)),
        0
      );

      const newExposurePct = ((currentExposure + positionValue) / initialCapital) * 100;
      if (newExposurePct > this.config.maxExposurePct) {
        return {
          allowed: false,
          reason: `Total exposure ${newExposurePct.toFixed(2)}% would exceed limit ${this.config.maxExposurePct}%`,
          adaptiveMultiplier: this.adaptiveMultiplier,
        };
      }

      return { allowed: true, adaptiveMultiplier: this.adaptiveMultiplier };

    } catch (error) {
      console.error('[RiskManager] Position check failed:', error);
      return { allowed: true, adaptiveMultiplier: 1 };  // Allow on error
    }
  }

  /**
   * Reset daily tracking if new day
   */
  private async checkDayReset(): Promise<void> {
    const now = new Date();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);

    if (today > this.lastDayReset) {
      this.lastDayReset = today;

      // Get current equity as day start
      try {
        const accountResult = await query<{ current_capital: string }>(
          'SELECT current_capital FROM paper_account LIMIT 1'
        );
        if (accountResult.rows[0]) {
          this.dayStartEquity = parseFloat(accountResult.rows[0].current_capital);
        }
      } catch (error) {
        console.error('[RiskManager] Failed to reset day tracking:', error);
      }

      console.log('[RiskManager] Daily tracking reset');
      this.emit('day:reset', { dayStartEquity: this.dayStartEquity });
    }
  }

  /**
   * Get current risk status
   */
  getStatus(): RiskStatus {
    return {
      isHalted: this.isHalted,
      haltReason: this.haltReason,
      haltedAt: this.haltedAt,
      currentDrawdownPct: 0,
      dailyPnlPct: 0,
      totalExposurePct: 0,
      largestPositionPct: 0,
      adaptiveMultiplier: this.adaptiveMultiplier,
      profileType: this.config.profileType,
    };
  }

  /**
   * Check if trading is halted
   */
  isTradingHalted(): boolean {
    return this.isHalted;
  }

  /**
   * Get configuration
   */
  getConfig(): RiskConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<RiskConfig>): void {
    this.config = { ...this.config, ...updates };
    console.log(`[RiskManager] Config updated - profile: ${this.config.profileType}`);
    this.emit('config:updated', this.config);
  }
}

// Singleton instance
let riskManager: RiskManager | null = null;

export function getRiskManager(): RiskManager {
  if (!riskManager) {
    riskManager = new RiskManager();
  }
  return riskManager;
}

export function initializeRiskManager(config?: Partial<RiskConfig>): RiskManager {
  riskManager = new RiskManager(config);
  return riskManager;
}
