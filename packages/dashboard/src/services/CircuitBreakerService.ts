/**
 * Circuit Breaker Service
 *
 * Monitors account drawdown and halts trading when losses exceed threshold.
 * Changed from auto-reset to halt-and-wait to preserve account state.
 *
 * Features:
 * - Monitors drawdown every 60 seconds
 * - When drawdown exceeds threshold (default 15%):
 *   1. Closes all open positions WITH proper sell trades
 *   2. Halts trading (cooldown period)
 *   3. Does NOT reset account - preserves losses for analysis
 * - Logs all events for analysis
 */

import { EventEmitter } from 'events';
import { isDatabaseConfigured, query } from '../database/index.js';
import { getTradingAutomation } from './TradingAutomation.js';
import { getStopLossService } from './StopLossService.js';
import { getPositionClosingService } from './PositionClosingService.js';
import { computeEquityDrawdown } from './drawdown.js';

export interface CircuitBreakerConfig {
  enabled: boolean;
  checkIntervalMs: number;      // How often to check (default: 60 seconds)
  maxDrawdownPct: number;       // Max drawdown before halt (default: 30%)
  initialCapital: number;       // Reference capital (default: 10000)
  cooldownMs: number;           // Cooldown before resuming (default: 30 min)
  autoReset: boolean;           // Whether to auto-reset capital (default: false)
  maxConsecutiveLosses: number; // Halt after N consecutive losing closes (default: 8)
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
  checkIntervalMs: 5 * 60 * 1000,           // Fallback: 5 minutes (primary trigger is event-driven)
  maxDrawdownPct: parseFloat(process.env.MAX_DRAWDOWN || '0.15') * 100,  // env is decimal (0.15 = 15%)
  initialCapital: parseFloat(process.env.INITIAL_CAPITAL || '10000'),
  cooldownMs: 30 * 60 * 1000,              // 30 minutes cooldown
  autoReset: false,                         // Don't auto-reset, preserve state
  maxConsecutiveLosses: parseInt(process.env.CB_MAX_CONSECUTIVE_LOSSES || '8', 10),
};

export class CircuitBreakerService extends EventEmitter {
  private config: CircuitBreakerConfig;
  private checkInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private onTradeExecuted: ((data: any) => void) | null = null;
  private onPositionsClosed: (() => void) | null = null;
  private resetCount = 0;
  private lastResetTime: Date | null = null;
  private isHaltedInMemory = false;
  private consecutiveLosses = 0;
  private onPositionClosed: ((data: any) => void) | null = null;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  isTradingHalted(): boolean {
    return this.isHaltedInMemory;
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

    try {
      await query(`
        CREATE TABLE IF NOT EXISTS trading_config (
          key VARCHAR(255) PRIMARY KEY,
          value TEXT NOT NULL,
          description TEXT,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
    } catch (error) {
      console.error('[CircuitBreaker] Failed to create trading_config table:', error);
    }

    // Load consecutive loss counter from DB
    try {
      const result = await query<{ value: string }>(
        `SELECT value FROM trading_config WHERE key = 'consecutive_losses'`
      );
      if (result.rows[0]) {
        this.consecutiveLosses = parseInt(result.rows[0].value, 10) || 0;
        console.log(`[CircuitBreaker] Loaded consecutive losses from DB: ${this.consecutiveLosses}`);
      }
    } catch (err) {
      // Non-critical — start with 0
    }

    this.isRunning = true;
    console.log(`[CircuitBreaker] Started (fallback interval: ${this.config.checkIntervalMs / 1000}s, max drawdown: ${this.config.maxDrawdownPct}%)`);

    // Primary triggers: check after capital changes (trades executed or positions closed)
    const automation = getTradingAutomation();
    this.onTradeExecuted = (data: any) => {
      // Only check drawdown on sells — buys mechanically reduce capital by fees
      // but don't represent actual losses
      if (data?.action === 'open') return;
      this.checkDrawdown().catch(err => {
        console.error('[CircuitBreaker] Post-trade check failed:', err);
      });
    };
    automation.on('trade:executed', this.onTradeExecuted);

    const stopLoss = getStopLossService();
    this.onPositionsClosed = () => {
      this.checkDrawdown().catch(err => {
        console.error('[CircuitBreaker] Post-stopLoss check failed:', err);
      });
    };
    stopLoss.on('positions:closed', this.onPositionsClosed);

    // Track consecutive losses via PositionClosingService events
    const closingService = getPositionClosingService();
    this.onPositionClosed = ({ netPnl }: { marketId: string; reason: string; netPnl: number }) => {
      if (netPnl < 0) {
        this.consecutiveLosses++;
        query(
          `INSERT INTO trading_config (key, value, description, updated_at)
           VALUES ('consecutive_losses', $1, 'Consecutive losing trades counter', NOW())
           ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
          [String(this.consecutiveLosses)]
        ).catch(() => {}); // fire-and-forget, non-critical
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) {
          console.log(`[CircuitBreaker] ${this.consecutiveLosses} consecutive losses — halting trading`);
          this.haltTrading(`${this.consecutiveLosses} consecutive losing trades`)
            .catch(err => console.error('[CircuitBreaker] Consecutive loss halt failed:', err));
          this.consecutiveLosses = 0;
          query(
            `INSERT INTO trading_config (key, value, description, updated_at)
             VALUES ('consecutive_losses', $1, 'Consecutive losing trades counter', NOW())
             ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
            [String(this.consecutiveLosses)]
          ).catch(() => {}); // persist reset to 0 so restart doesn't re-trigger halt
          // Schedule cooldown end
          setTimeout(() => {
            this.resumeTrading().catch(err => console.error('[CircuitBreaker] Resume failed:', err));
          }, this.config.cooldownMs);
        }
      } else {
        this.consecutiveLosses = 0;
        query(
          `INSERT INTO trading_config (key, value, description, updated_at)
           VALUES ('consecutive_losses', $1, 'Consecutive losing trades counter', NOW())
           ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
          [String(this.consecutiveLosses)]
        ).catch(() => {}); // fire-and-forget, non-critical
      }
    };
    closingService.on('position:closed', this.onPositionClosed);

    // Fallback timer: safety net
    this.checkInterval = setInterval(() => {
      this.checkDrawdown().catch(err => {
        console.error('[CircuitBreaker] Fallback check failed:', err);
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
    if (this.onTradeExecuted) {
      getTradingAutomation().off('trade:executed', this.onTradeExecuted);
      this.onTradeExecuted = null;
    }
    if (this.onPositionsClosed) {
      getStopLossService().off('positions:closed', this.onPositionsClosed);
      this.onPositionsClosed = null;
    }
    if (this.onPositionClosed) {
      getPositionClosingService().off('position:closed', this.onPositionClosed);
      this.onPositionClosed = null;
    }
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
      const dd = await computeEquityDrawdown(this.config.initialCapital);
      if (!dd) return;
      const { currentCapital, drawdownPct } = dd;

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
          capitalAfter: this.config.autoReset ? this.config.initialCapital : capitalAfterClose,
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
   * Close all open positions by delegating to PositionClosingService.
   * Ensures consistent fee/PnL calculation and emits position:closed events.
   */
  private async closeAllPositions(): Promise<number> {
    const openPositions = await query<{
      id: string;
      market_id: string;
      token_id: string;
      side: string;
      size: string;
      avg_entry_price: string;
      latest_price: string | null;
      opened_at: string;
    }>(`
      SELECT
        pp.id,
        pp.market_id,
        pp.token_id,
        pp.side,
        pp.size,
        pp.avg_entry_price,
        pp.opened_at,
        -- For SHORT positions, price_history only has Yes token data
        -- No token price = 1 - Yes token price
        CASE WHEN pp.side = 'short' THEN 1 - ph.close ELSE ph.close END as latest_price
      FROM paper_positions pp
      LEFT JOIN markets m ON pp.market_id = m.id OR pp.market_id = m.condition_id
      LEFT JOIN LATERAL (
        SELECT close FROM price_history
        WHERE token_id = COALESCE(m.clob_token_id_yes, pp.token_id)
        ORDER BY time DESC LIMIT 1
      ) ph ON true
      WHERE pp.closed_at IS NULL
    `);

    let closed = 0;
    const closingService = getPositionClosingService();

    for (const pos of openPositions.rows) {
      const size = parseFloat(pos.size);
      if (size <= 0) continue;

      // Skip positions opened less than 5 minutes ago (prevent flash close)
      const MIN_HOLD_MS = 5 * 60 * 1000;
      const positionAge = Date.now() - new Date(pos.opened_at).getTime();
      if (positionAge < MIN_HOLD_MS) {
        console.log(`[CircuitBreaker] Skipping position ${pos.market_id} — opened ${Math.round(positionAge / 1000)}s ago (min hold: ${MIN_HOLD_MS / 1000}s)`);
        continue;
      }

      const entryPrice = parseFloat(pos.avg_entry_price);
      const exitPrice = pos.latest_price
        ? parseFloat(pos.latest_price)
        : entryPrice;

      try {
        const result = await closingService.close({
          positionId: parseInt(pos.id, 10),
          marketId: pos.market_id,
          tokenId: pos.token_id,
          side: pos.side as 'long' | 'short',
          size,
          entryPrice,
          exitPrice,
          reason: 'circuit_breaker_exit',
        });

        if (result.executed) {
          closed++;
          console.log(`[CircuitBreaker] Closed ${pos.market_id.substring(0, 12)}... | P&L: $${result.netPnl.toFixed(2)}`);
        }
      } catch (error) {
        console.error(`[CircuitBreaker] Failed to close position ${pos.market_id}:`, error);
      }
    }

    console.log(`[CircuitBreaker] Closed ${closed} positions`);
    return closed;
  }

  /**
   * Halt trading for cooldown period
   */
  private async haltTrading(reason: string): Promise<void> {
    this.isHaltedInMemory = true;
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
    this.isHaltedInMemory = false;
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
