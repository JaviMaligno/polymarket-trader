/**
 * Circuit Breaker Service
 *
 * Monitors account drawdown and halts trading when losses exceed threshold.
 * Changed from auto-reset to halt-and-wait to preserve account state.
 *
 * Features:
 * - Monitors drawdown every 60 seconds
 * - When drawdown exceeds threshold (default 30%):
 *   1. Closes all open positions WITH proper sell trades
 *   2. Halts trading (cooldown period)
 *   3. Does NOT reset account - preserves losses for analysis
 * - Logs all events for analysis
 */

import { EventEmitter } from 'events';
import { isDatabaseConfigured, query } from '../database/index.js';
import { paperTradesRepo, paperPositionsRepo } from '../database/repositories.js';

export interface CircuitBreakerConfig {
  enabled: boolean;
  checkIntervalMs: number;      // How often to check (default: 60 seconds)
  maxDrawdownPct: number;       // Max drawdown before halt (default: 30%)
  initialCapital: number;       // Reference capital (default: 10000)
  cooldownMs: number;           // Cooldown before resuming (default: 30 min)
  autoReset: boolean;           // Whether to auto-reset capital (default: false)
}

interface CircuitBreakerEvent {
  timestamp: Date;
  drawdownPct: number;
  capitalBefore: number;
  capitalAfter: number;
  positionsClosed: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  enabled: true,
  checkIntervalMs: 60 * 1000,              // 60 seconds
  maxDrawdownPct: 30,                       // 30% drawdown triggers halt
  initialCapital: parseFloat(process.env.INITIAL_CAPITAL || '10000'),
  cooldownMs: 30 * 60 * 1000,              // 30 minutes cooldown
  autoReset: false,                         // Don't auto-reset, preserve state
};

export class CircuitBreakerService extends EventEmitter {
  private config: CircuitBreakerConfig;
  private checkInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private resetCount = 0;
  private lastResetTime: Date | null = null;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the circuit breaker monitoring
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[CircuitBreaker] Already running');
      return;
    }

    if (!isDatabaseConfigured()) {
      console.warn('[CircuitBreaker] Database not configured - cannot start');
      return;
    }

    this.isRunning = true;
    console.log(`[CircuitBreaker] Started (check interval: ${this.config.checkIntervalMs / 1000}s, max drawdown: ${this.config.maxDrawdownPct}%)`);

    // Schedule periodic checks
    this.checkInterval = setInterval(() => {
      this.checkDrawdown().catch(err => {
        console.error('[CircuitBreaker] Check failed:', err);
      });
    }, this.config.checkIntervalMs);

    // Run initial check
    await this.checkDrawdown();

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
    console.log('[CircuitBreaker] Stopped');
    this.emit('stopped');
  }

  /**
   * Check current drawdown and reset if necessary
   */
  async checkDrawdown(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    try {
      // Get current account state
      const accountResult = await query<{
        current_capital: string;
        initial_capital: string;
      }>('SELECT current_capital, initial_capital FROM paper_account WHERE id = 1');

      if (accountResult.rows.length === 0) {
        return;
      }

      const currentCapital = parseFloat(accountResult.rows[0].current_capital);
      const initialCapital = this.config.initialCapital;

      // Calculate drawdown percentage
      const drawdownPct = ((initialCapital - currentCapital) / initialCapital) * 100;

      // Check if we need to trigger circuit breaker
      if (drawdownPct >= this.config.maxDrawdownPct) {
        console.log(`[CircuitBreaker] TRIGGERED: ${drawdownPct.toFixed(1)}% drawdown exceeds ${this.config.maxDrawdownPct}% threshold`);

        // 1. Close all open positions WITH sell trades
        const positionsClosed = await this.closeAllPositions();

        // 2. Halt trading for cooldown period
        await this.haltTrading(`Drawdown ${drawdownPct.toFixed(1)}% exceeded ${this.config.maxDrawdownPct}% threshold`);

        // 3. Only reset account if autoReset is enabled
        if (this.config.autoReset) {
          await this.resetAccount();
        }

        // Get updated capital after closing positions
        const updatedAccount = await query<{ current_capital: string }>(
          'SELECT current_capital FROM paper_account WHERE id = 1'
        );
        const capitalAfterClose = parseFloat(updatedAccount.rows[0]?.current_capital ?? '0');

        // 4. Log the event
        const event: CircuitBreakerEvent = {
          timestamp: new Date(),
          drawdownPct,
          capitalBefore: currentCapital,
          capitalAfter: this.config.autoReset ? initialCapital : capitalAfterClose,
          positionsClosed,
        };

        this.resetCount++;
        this.lastResetTime = event.timestamp;

        console.log(`[CircuitBreaker] Trading halted (closed ${positionsClosed} positions, capital: $${capitalAfterClose.toFixed(2)})`);
        this.emit('circuit:triggered', event);

        // Log to database for historical tracking
        await this.logResetEvent(event);

        // Schedule cooldown end
        setTimeout(() => {
          this.resumeTrading().catch(err => console.error('[CircuitBreaker] Resume failed:', err));
        }, this.config.cooldownMs);
      }
    } catch (error) {
      console.error('[CircuitBreaker] Error checking drawdown:', error);
      this.emit('error', error);
    }
  }

  /**
   * Close all open positions WITH proper sell trades
   * Creates actual sell trades and calculates real P&L
   */
  private async closeAllPositions(): Promise<number> {
    // Get all open positions with current market prices
    const openPositions = await query<{
      market_id: string;
      token_id: string;
      side: string;
      size: string;
      avg_entry_price: string;
      current_price_yes: string;
      current_price_no: string;
    }>(`
      SELECT
        pp.market_id,
        pp.token_id,
        pp.side,
        pp.size,
        pp.avg_entry_price,
        m.current_price_yes,
        m.current_price_no
      FROM paper_positions pp
      JOIN markets m ON pp.market_id = m.id OR pp.market_id = m.condition_id
      WHERE pp.closed_at IS NULL
    `);

    let closed = 0;
    let totalPnl = 0;

    for (const pos of openPositions.rows) {
      const size = parseFloat(pos.size);
      if (size <= 0) continue;

      const entryPrice = parseFloat(pos.avg_entry_price);
      // Use correct price based on position side: long = Yes price, short = No price
      const exitPrice = pos.side === 'long'
        ? (parseFloat(pos.current_price_yes) || entryPrice)
        : (parseFloat(pos.current_price_no) || entryPrice);
      const feeRate = 0.001;
      const fee = size * exitPrice * feeRate;

      // Calculate P&L
      const grossPnl = (exitPrice - entryPrice) * size;
      const netPnl = grossPnl - fee;
      totalPnl += netPnl;

      try {
        // Create the SELL trade
        await paperTradesRepo.create({
          time: new Date(),
          market_id: pos.market_id,
          token_id: pos.token_id,
          side: 'sell',
          requested_size: size,
          executed_size: size,
          requested_price: exitPrice,
          executed_price: exitPrice,
          fee,
          value_usd: size * exitPrice,
          signal_type: 'circuit_breaker_exit',
          order_type: 'market',
          fill_type: 'full',
        });

        // Close the position with actual P&L
        await query(
          `UPDATE paper_positions SET
            closed_at = NOW(),
            size = 0,
            realized_pnl = $1
          WHERE market_id = $2 AND token_id = $3 AND closed_at IS NULL`,
          [netPnl, pos.market_id, pos.token_id]
        );

        // Update paper_account
        const proceeds = size * exitPrice;
        await query(
          `UPDATE paper_account SET
            current_capital = current_capital + $1,
            available_capital = available_capital + $1,
            total_fees_paid = total_fees_paid + $2,
            total_trades = total_trades + 1,
            total_realized_pnl = total_realized_pnl + $3,
            winning_trades = winning_trades + CASE WHEN $3 > 0 THEN 1 ELSE 0 END,
            losing_trades = losing_trades + CASE WHEN $3 < 0 THEN 1 ELSE 0 END,
            updated_at = NOW()
          WHERE id = 1`,
          [proceeds - fee, fee, netPnl]
        );

        closed++;
        console.log(`[CircuitBreaker] Closed position ${pos.market_id.substring(0, 12)}... | P&L: $${netPnl.toFixed(2)}`);

      } catch (error) {
        console.error(`[CircuitBreaker] Failed to close position ${pos.market_id}:`, error);
      }
    }

    console.log(`[CircuitBreaker] Closed ${closed} positions | Total P&L: $${totalPnl.toFixed(2)}`);
    return closed;
  }

  /**
   * Halt trading for cooldown period
   */
  private async haltTrading(reason: string): Promise<void> {
    try {
      await query(`
        INSERT INTO trading_config (key, value, description, updated_at)
        VALUES ('trading_halted', $1::jsonb, $2, NOW())
        ON CONFLICT (key) DO UPDATE SET
          value = $1::jsonb,
          description = $2,
          updated_at = NOW()
      `, [JSON.stringify({ halted: true, reason, until: new Date(Date.now() + this.config.cooldownMs) }), reason]);
      console.log(`[CircuitBreaker] Trading halted: ${reason}`);
      this.emit('trading:halted', { reason });
    } catch (error) {
      console.error('[CircuitBreaker] Failed to halt trading:', error);
    }
  }

  /**
   * Resume trading after cooldown
   */
  private async resumeTrading(): Promise<void> {
    try {
      await query(`
        INSERT INTO trading_config (key, value, description, updated_at)
        VALUES ('trading_halted', $1::jsonb, $2, NOW())
        ON CONFLICT (key) DO UPDATE SET
          value = $1::jsonb,
          description = $2,
          updated_at = NOW()
      `, [JSON.stringify({ halted: false, reason: 'Cooldown period ended' }), 'Cooldown period ended']);
      console.log('[CircuitBreaker] Trading resumed after cooldown');
      this.emit('trading:resumed');
    } catch (error) {
      console.error('[CircuitBreaker] Failed to resume trading:', error);
    }
  }

  /**
   * Reset account to initial capital (only used if autoReset is enabled)
   */
  private async resetAccount(): Promise<void> {
    await query(`
      UPDATE paper_account SET
        current_capital = $1,
        available_capital = $1,
        total_realized_pnl = 0,
        total_fees_paid = 0,
        total_trades = 0,
        winning_trades = 0,
        losing_trades = 0,
        max_drawdown = 0,
        peak_equity = $1,
        updated_at = NOW()
      WHERE id = 1
    `, [this.config.initialCapital]);
    console.log(`[CircuitBreaker] Account reset to $${this.config.initialCapital}`);
  }

  /**
   * Log reset event to database for historical tracking
   */
  private async logResetEvent(event: CircuitBreakerEvent): Promise<void> {
    try {
      // Check if circuit_breaker_log table exists, create if not
      await query(`
        CREATE TABLE IF NOT EXISTS circuit_breaker_log (
          id SERIAL PRIMARY KEY,
          timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          drawdown_pct DECIMAL(10, 4) NOT NULL,
          capital_before DECIMAL(20, 6) NOT NULL,
          capital_after DECIMAL(20, 6) NOT NULL,
          positions_closed INTEGER NOT NULL
        )
      `);

      await query(`
        INSERT INTO circuit_breaker_log (timestamp, drawdown_pct, capital_before, capital_after, positions_closed)
        VALUES ($1, $2, $3, $4, $5)
      `, [event.timestamp, event.drawdownPct, event.capitalBefore, event.capitalAfter, event.positionsClosed]);
    } catch (error) {
      console.error('[CircuitBreaker] Failed to log reset event:', error);
    }
  }

  /**
   * Force a check (for manual triggers)
   */
  async forceCheck(): Promise<void> {
    console.log('[CircuitBreaker] Manual check triggered');
    await this.checkDrawdown();
  }

  /**
   * Get current configuration
   */
  getConfig(): CircuitBreakerConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<CircuitBreakerConfig>): void {
    this.config = { ...this.config, ...updates };
    console.log(`[CircuitBreaker] Config updated - max drawdown: ${this.config.maxDrawdownPct}%`);
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
  getStats(): {
    isRunning: boolean;
    resetCount: number;
    lastResetTime: Date | null;
    maxDrawdownPct: number;
  } {
    return {
      isRunning: this.isRunning,
      resetCount: this.resetCount,
      lastResetTime: this.lastResetTime,
      maxDrawdownPct: this.config.maxDrawdownPct,
    };
  }
}

// Singleton instance
let circuitBreakerService: CircuitBreakerService | null = null;

export function getCircuitBreakerService(): CircuitBreakerService {
  if (!circuitBreakerService) {
    circuitBreakerService = new CircuitBreakerService();
  }
  return circuitBreakerService;
}

export function initializeCircuitBreakerService(config?: Partial<CircuitBreakerConfig>): CircuitBreakerService {
  circuitBreakerService = new CircuitBreakerService(config);
  return circuitBreakerService;
}
