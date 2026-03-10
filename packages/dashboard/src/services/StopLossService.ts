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
import { getDbEventListener } from './DbEventListener.js';
import { getPositionClosingService } from './PositionClosingService.js';

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
  checkIntervalMs: 5 * 60 * 1000,  // Fallback: check every 5 minutes (primary trigger is event-driven)
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
  private onPriceRefreshed: (() => void) | null = null;
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
    console.log(`[StopLoss] Started (fallback interval: ${this.config.checkIntervalMs / 1000}s, SL: ${this.config.defaultStopLossPct}%, TP: ${this.config.defaultTakeProfitPct}%)`);

    // Primary trigger: react to fresh price data from data-collector
    const dbListener = getDbEventListener();
    this.onPriceRefreshed = () => {
      this.checkPositions().catch(err => {
        console.error('[StopLoss] Event-driven check failed:', err);
      });
    };
    dbListener.on('price:refreshed', this.onPriceRefreshed);

    // Fallback timer: safety net if LISTEN connection drops
    this.checkInterval = setInterval(() => {
      this.checkPositions().catch(err => {
        console.error('[StopLoss] Fallback check failed:', err);
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
    if (this.onPriceRefreshed) {
      getDbEventListener().off('price:refreshed', this.onPriceRefreshed);
      this.onPriceRefreshed = null;
    }
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
      // Get all open positions with latest prices from price_history
      // NOTE: We use price_history (written by data-collector every cycle) instead of
      // markets.current_price_yes/no which can be stale and cause catastrophic stop-loss sells
      const positionsResult = await query<{
        id: number;
        market_id: string;
        token_id: string;
        side: string;
        size: string;
        avg_entry_price: string;
        stop_loss: string | null;
        take_profit: string | null;
        latest_price: string | null;
        price_age_seconds: string | null;
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
          m.question,
          -- For SHORT positions, price_history only has Yes token data
          -- No token price = 1 - Yes token price
          CASE WHEN pp.side = 'short' THEN 1 - ph.close ELSE ph.close END as latest_price,
          EXTRACT(EPOCH FROM (NOW() - ph.time)) as price_age_seconds
        FROM paper_positions pp
        LEFT JOIN markets m ON pp.market_id = m.id OR pp.market_id = m.condition_id
        LEFT JOIN LATERAL (
          SELECT close, time FROM price_history
          WHERE token_id = COALESCE(m.clob_token_id_yes, pp.token_id)
          ORDER BY time DESC LIMIT 1
        ) ph ON true
        WHERE pp.closed_at IS NULL
      `);

      for (const pos of positionsResult.rows) {
        const size = parseFloat(pos.size);
        const entryPrice = parseFloat(pos.avg_entry_price);

        // Use latest price from price_history (fresh data from data-collector)
        let currentPrice: number;
        if (pos.latest_price) {
          currentPrice = parseFloat(pos.latest_price);
        } else {
          // No price_history data for this token - use entry price to avoid false triggers
          currentPrice = entryPrice;
        }

        // Skip if no valid price
        if (currentPrice <= 0 || isNaN(currentPrice)) {
          continue;
        }

        // Price staleness check: if price data is older than 1 hour,
        // still update position price and allow time exits, but skip stop/TP triggers
        const priceAgeSeconds = pos.price_age_seconds ? parseFloat(pos.price_age_seconds) : null;
        const isPriceStale = priceAgeSeconds !== null && priceAgeSeconds > 3600;

        // Note: No price drop sanity check — in prediction markets, a token can
        // legitimately drop 99% (e.g. $0.50 → $0.005) when an event becomes unlikely.
        // The stop-loss system handles these via normal SL triggers.

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

        // Check stop loss (loss exceeds threshold) - skip if price is stale
        if (!isPriceStale && pnlPct <= -effectiveStopLossPct) {
          console.log(`[StopLoss] STOP LOSS triggered for ${(pos.question || pos.market_id).substring(0, 40)}... | PnL: ${pnlPct.toFixed(2)}% <= -${effectiveStopLossPct.toFixed(2)}%`);

          const closeResult = await this.closePosition(
            pos.id,
            pos.market_id,
            pos.token_id,
            pos.side as 'long' | 'short',
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
        // Check take profit (gain exceeds threshold) - skip if price is stale
        else if (!isPriceStale && pnlPct >= takeProfitPct) {
          console.log(`[StopLoss] TAKE PROFIT triggered for ${(pos.question || pos.market_id).substring(0, 40)}... | PnL: ${pnlPct.toFixed(2)}% >= ${takeProfitPct.toFixed(2)}%`);

          const closeResult = await this.closePosition(
            pos.id,
            pos.market_id,
            pos.token_id,
            pos.side as 'long' | 'short',
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
              pos.side as 'long' | 'short',
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
   * Close a position due to stop loss or take profit.
   * Delegates to PositionClosingService for correct fee/PnL accounting.
   */
  private async closePosition(
    positionId: number,
    marketId: string,
    tokenId: string,
    side: 'long' | 'short',
    size: number,
    entryPrice: number,
    exitPrice: number,
    reason: 'stop_loss' | 'take_profit' | 'time_exit'
  ): Promise<{ pnl: number }> {
    const result = await getPositionClosingService().close({
      positionId,
      marketId,
      tokenId,
      side,
      size,
      entryPrice,
      exitPrice,
      reason,
    });

    if (result.executed) {
      this.emit('position:closed', {
        marketId,
        reason,
        entryPrice,
        exitPrice,
        pnl: result.netPnl,
        pnlPct: ((exitPrice - entryPrice) / entryPrice) * 100,
      });
    }

    return { pnl: result.netPnl };
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
