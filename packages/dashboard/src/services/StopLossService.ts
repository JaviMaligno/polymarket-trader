/**
 * Stop Loss Service
 *
 * Monitors open positions and automatically closes them when
 * the loss exceeds the configured stop-loss percentage.
 *
 * Features:
 * - Configurable stop-loss and take-profit percentages
 * - Per-position stop-loss tracking
 * - Uses market prices for accurate PnL calculation
 * - Integrates with paper trading account
 */

import { EventEmitter } from 'events';
import { isDatabaseConfigured, query } from '../database/index.js';
import { paperTradesRepo, paperPositionsRepo } from '../database/repositories.js';

export interface StopLossConfig {
  enabled: boolean;
  checkIntervalMs: number;      // How often to check (default: 30 seconds)
  defaultStopLossPct: number;   // Default stop loss % (e.g., 15 = 15%)
  defaultTakeProfitPct: number; // Default take profit % (e.g., 40 = 40%)
  useTrailingStop: boolean;     // Enable trailing stop loss
  trailingStopPct: number;      // Trailing stop distance %
  maxHoldTimeMs: number;        // Max time to hold position (default: 4 hours)
  useTimeBasedExit: boolean;    // Enable time-based exit
}

interface StopLossResult {
  positionsClosed: number;
  stopLosses: number;
  takeProfits: number;
  timeExits: number;
  totalPnl: number;
  details: Array<{
    marketId: string;
    reason: 'stop_loss' | 'take_profit' | 'time_exit';
    entryPrice: number;
    exitPrice: number;
    pnlPct: number;
    pnl: number;
  }>;
}

const DEFAULT_CONFIG: StopLossConfig = {
  enabled: true,
  checkIntervalMs: 30 * 1000,     // Check every 30 seconds
  defaultStopLossPct: parseFloat(process.env.STOP_LOSS_PCT || '15'),    // 15% stop loss
  defaultTakeProfitPct: parseFloat(process.env.TAKE_PROFIT_PCT || '40'), // 40% take profit
  useTrailingStop: false,
  trailingStopPct: 10,
  maxHoldTimeMs: parseFloat(process.env.MAX_HOLD_TIME_HOURS || '4') * 60 * 60 * 1000,  // 4 hours default
  useTimeBasedExit: process.env.USE_TIME_EXIT === 'true',
};

export class StopLossService extends EventEmitter {
  private config: StopLossConfig;
  private checkInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  // Track highest prices for trailing stops (marketId -> highest price seen)
  private highWaterMarks: Map<string, number> = new Map();

  constructor(config?: Partial<StopLossConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the stop loss monitoring service
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[StopLoss] Already running');
      return;
    }

    if (!isDatabaseConfigured()) {
      console.warn('[StopLoss] Database not configured - cannot start');
      return;
    }

    this.isRunning = true;
    console.log(`[StopLoss] Started (check interval: ${this.config.checkIntervalMs / 1000}s, SL: ${this.config.defaultStopLossPct}%, TP: ${this.config.defaultTakeProfitPct}%)`);

    // Schedule periodic checks
    this.checkInterval = setInterval(() => {
      this.checkPositions().catch(err => {
        console.error('[StopLoss] Check failed:', err);
      });
    }, this.config.checkIntervalMs);

    // Run initial check
    await this.checkPositions();

    this.emit('started');
  }

  /**
   * Stop the service
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.isRunning = false;
    this.highWaterMarks.clear();
    console.log('[StopLoss] Stopped');
    this.emit('stopped');
  }

  /**
   * Check all positions for stop loss / take profit triggers
   */
  async checkPositions(): Promise<StopLossResult> {
    if (!this.config.enabled) {
      return { positionsClosed: 0, stopLosses: 0, takeProfits: 0, timeExits: 0, totalPnl: 0, details: [] };
    }

    const result: StopLossResult = {
      positionsClosed: 0,
      stopLosses: 0,
      takeProfits: 0,
      timeExits: 0,
      totalPnl: 0,
      details: [],
    };

    try {
      // Get all open positions with current market prices
      const positionsResult = await query<{
        id: number;
        market_id: string;
        token_id: string;
        side: string;
        size: string;
        avg_entry_price: string;
        stop_loss: string | null;
        take_profit: string | null;
        current_price_yes: string | null;
        current_price_no: string | null;
        question: string | null;
        opened_at: Date;
      }>(`
        SELECT
          pp.id,
          pp.market_id,
          pp.token_id,
          pp.side,
          pp.size,
          pp.avg_entry_price,
          pp.stop_loss,
          pp.take_profit,
          pp.opened_at,
          m.current_price_yes,
          m.current_price_no,
          m.question
        FROM paper_positions pp
        LEFT JOIN markets m ON pp.market_id = m.id OR pp.market_id = m.condition_id
        WHERE pp.closed_at IS NULL
      `);

      for (const pos of positionsResult.rows) {
        const size = parseFloat(pos.size);
        const entryPrice = parseFloat(pos.avg_entry_price);

        // Determine current price based on position side
        // Long positions use Yes price, Short (No) positions use No price
        let currentPrice: number;
        if (pos.side === 'long') {
          currentPrice = pos.current_price_yes ? parseFloat(pos.current_price_yes) : entryPrice;
        } else {
          currentPrice = pos.current_price_no ? parseFloat(pos.current_price_no) : entryPrice;
        }

        // Skip if no valid price
        if (currentPrice <= 0 || isNaN(currentPrice)) {
          continue;
        }

        // Calculate PnL percentage
        const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;

        // Get stop loss and take profit thresholds
        const stopLossPct = pos.stop_loss ? parseFloat(pos.stop_loss) : this.config.defaultStopLossPct;
        const takeProfitPct = pos.take_profit ? parseFloat(pos.take_profit) : this.config.defaultTakeProfitPct;

        // Update high water mark for trailing stop
        const currentHighWater = this.highWaterMarks.get(pos.market_id) || entryPrice;
        if (currentPrice > currentHighWater) {
          this.highWaterMarks.set(pos.market_id, currentPrice);
        }

        // Calculate trailing stop level if enabled
        let effectiveStopLossPct = stopLossPct;
        if (this.config.useTrailingStop) {
          const highWater = this.highWaterMarks.get(pos.market_id) || entryPrice;
          const trailingLevel = ((highWater - entryPrice) / entryPrice) * 100 - this.config.trailingStopPct;
          if (trailingLevel > -stopLossPct) {
            effectiveStopLossPct = -trailingLevel;  // Convert to positive loss threshold
          }
        }

        // Check stop loss (loss exceeds threshold)
        if (pnlPct <= -effectiveStopLossPct) {
          console.log(`[StopLoss] STOP LOSS triggered for ${(pos.question || pos.market_id).substring(0, 40)}... | PnL: ${pnlPct.toFixed(2)}% <= -${effectiveStopLossPct.toFixed(2)}%`);

          const closeResult = await this.closePosition(
            pos.id,
            pos.market_id,
            pos.token_id,
            size,
            entryPrice,
            currentPrice,
            'stop_loss'
          );

          result.positionsClosed++;
          result.stopLosses++;
          result.totalPnl += closeResult.pnl;
          result.details.push({
            marketId: pos.market_id,
            reason: 'stop_loss',
            entryPrice,
            exitPrice: currentPrice,
            pnlPct,
            pnl: closeResult.pnl,
          });

          // Clean up trailing stop tracking
          this.highWaterMarks.delete(pos.market_id);
        }
        // Check take profit (gain exceeds threshold)
        else if (pnlPct >= takeProfitPct) {
          console.log(`[StopLoss] TAKE PROFIT triggered for ${(pos.question || pos.market_id).substring(0, 40)}... | PnL: ${pnlPct.toFixed(2)}% >= ${takeProfitPct.toFixed(2)}%`);

          const closeResult = await this.closePosition(
            pos.id,
            pos.market_id,
            pos.token_id,
            size,
            entryPrice,
            currentPrice,
            'take_profit'
          );

          result.positionsClosed++;
          result.takeProfits++;
          result.totalPnl += closeResult.pnl;
          result.details.push({
            marketId: pos.market_id,
            reason: 'take_profit',
            entryPrice,
            exitPrice: currentPrice,
            pnlPct,
            pnl: closeResult.pnl,
          });

          // Clean up trailing stop tracking
          this.highWaterMarks.delete(pos.market_id);
        }
        // Check time-based exit (position held too long)
        else if (this.config.useTimeBasedExit) {
          const holdTimeMs = Date.now() - new Date(pos.opened_at).getTime();
          if (holdTimeMs >= this.config.maxHoldTimeMs) {
            const holdTimeHours = (holdTimeMs / (1000 * 60 * 60)).toFixed(1);
            console.log(`[StopLoss] TIME EXIT triggered for ${(pos.question || pos.market_id).substring(0, 40)}... | Held ${holdTimeHours}h | PnL: ${pnlPct.toFixed(2)}%`);

            const closeResult = await this.closePosition(
              pos.id,
              pos.market_id,
              pos.token_id,
              size,
              entryPrice,
              currentPrice,
              'time_exit'
            );

            result.positionsClosed++;
            result.timeExits++;
            result.totalPnl += closeResult.pnl;
            result.details.push({
              marketId: pos.market_id,
              reason: 'time_exit',
              entryPrice,
              exitPrice: currentPrice,
              pnlPct,
              pnl: closeResult.pnl,
            });

            // Clean up trailing stop tracking
            this.highWaterMarks.delete(pos.market_id);
          } else {
            // Update position with current price and unrealized PnL
            await this.updatePositionPrice(pos.id, currentPrice, pnlPct, size, entryPrice);
          }
        }
        // Update position with current price and unrealized PnL
        else {
          await this.updatePositionPrice(pos.id, currentPrice, pnlPct, size, entryPrice);
        }
      }

      if (result.positionsClosed > 0) {
        console.log(`[StopLoss] Check complete: ${result.stopLosses} SL, ${result.takeProfits} TP, ${result.timeExits} time exits, total PnL: $${result.totalPnl.toFixed(2)}`);
        this.emit('positions:closed', result);
      }

      return result;

    } catch (error) {
      console.error('[StopLoss] Error checking positions:', error);
      this.emit('error', error);
      return result;
    }
  }

  /**
   * Close a position due to stop loss or take profit
   */
  private async closePosition(
    positionId: number,
    marketId: string,
    tokenId: string,
    size: number,
    entryPrice: number,
    exitPrice: number,
    reason: 'stop_loss' | 'take_profit' | 'time_exit'
  ): Promise<{ pnl: number }> {
    const exitValue = size * exitPrice;
    const entryValue = size * entryPrice;
    const pnl = exitValue - entryValue;

    // Update position to closed
    await query(`
      UPDATE paper_positions SET
        closed_at = NOW(),
        realized_pnl = $1,
        current_price = $2,
        size = 0
      WHERE id = $3
    `, [pnl, exitPrice, positionId]);

    // Update paper account
    await query(`
      UPDATE paper_account SET
        current_capital = current_capital + $1,
        available_capital = available_capital + $1,
        total_realized_pnl = total_realized_pnl + $2,
        winning_trades = winning_trades + CASE WHEN $2 > 0 THEN 1 ELSE 0 END,
        losing_trades = losing_trades + CASE WHEN $2 < 0 THEN 1 ELSE 0 END,
        updated_at = NOW()
      WHERE id = 1
    `, [exitValue, pnl]);

    // Record the trade
    await paperTradesRepo.create({
      time: new Date(),
      market_id: marketId,
      token_id: tokenId,
      side: 'sell',
      requested_size: size,
      executed_size: size,
      requested_price: exitPrice,
      executed_price: exitPrice,
      fee: 0,
      value_usd: exitValue,
      signal_type: reason,
      order_type: 'market',
      fill_type: 'full',
    });

    this.emit('position:closed', {
      marketId,
      reason,
      entryPrice,
      exitPrice,
      pnl,
      pnlPct: ((exitPrice - entryPrice) / entryPrice) * 100,
    });

    return { pnl };
  }

  /**
   * Update position with current price and unrealized PnL
   */
  private async updatePositionPrice(
    positionId: number,
    currentPrice: number,
    pnlPct: number,
    size: number,
    entryPrice: number
  ): Promise<void> {
    const unrealizedPnl = (currentPrice - entryPrice) * size;

    await query(`
      UPDATE paper_positions SET
        current_price = $1,
        unrealized_pnl = $2,
        unrealized_pnl_pct = $3,
        updated_at = NOW()
      WHERE id = $4
    `, [currentPrice, unrealizedPnl, pnlPct, positionId]);
  }

  /**
   * Force a check (for manual triggers)
   */
  async forceCheck(): Promise<StopLossResult> {
    console.log('[StopLoss] Manual check triggered');
    return this.checkPositions();
  }

  /**
   * Set stop loss for a specific position
   */
  async setPositionStopLoss(marketId: string, stopLossPct: number): Promise<void> {
    await query(`
      UPDATE paper_positions SET
        stop_loss = $1,
        updated_at = NOW()
      WHERE market_id = $2 AND closed_at IS NULL
    `, [stopLossPct, marketId]);
    console.log(`[StopLoss] Set stop loss for ${marketId} to ${stopLossPct}%`);
  }

  /**
   * Set take profit for a specific position
   */
  async setPositionTakeProfit(marketId: string, takeProfitPct: number): Promise<void> {
    await query(`
      UPDATE paper_positions SET
        take_profit = $1,
        updated_at = NOW()
      WHERE market_id = $2 AND closed_at IS NULL
    `, [takeProfitPct, marketId]);
    console.log(`[StopLoss] Set take profit for ${marketId} to ${takeProfitPct}%`);
  }

  /**
   * Get current configuration
   */
  getConfig(): StopLossConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<StopLossConfig>): void {
    this.config = { ...this.config, ...updates };
    console.log(`[StopLoss] Config updated - SL: ${this.config.defaultStopLossPct}%, TP: ${this.config.defaultTakeProfitPct}%`);
    this.emit('config:updated', this.config);
  }

  /**
   * Check if service is running
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Get statistics
   */
  getStats(): { isRunning: boolean; trackedPositions: number } {
    return {
      isRunning: this.isRunning,
      trackedPositions: this.highWaterMarks.size,
    };
  }
}

// Singleton instance
let stopLossService: StopLossService | null = null;

export function getStopLossService(): StopLossService {
  if (!stopLossService) {
    stopLossService = new StopLossService();
  }
  return stopLossService;
}

export function initializeStopLossService(config?: Partial<StopLossConfig>): StopLossService {
  stopLossService = new StopLossService(config);
  return stopLossService;
}
