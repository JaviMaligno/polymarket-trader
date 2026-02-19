/**
 * Circuit Breaker Service
 *
 * Monitors account drawdown and automatically resets the paper trading
 * account when losses exceed a threshold. This allows continuous testing
 * without manual intervention.
 *
 * Features:
 * - Monitors drawdown every 60 seconds
 * - When drawdown exceeds threshold (default 30%):
 *   1. Closes all open positions
 *   2. Resets account to initial capital
 *   3. Continues trading automatically
 * - Logs all reset events for analysis
 */

import { EventEmitter } from 'events';
import { isDatabaseConfigured, query } from '../database/index.js';

export interface CircuitBreakerConfig {
  enabled: boolean;
  checkIntervalMs: number;      // How often to check (default: 60 seconds)
  maxDrawdownPct: number;       // Max drawdown before reset (default: 30%)
  initialCapital: number;       // Capital to reset to (default: 10000)
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
  maxDrawdownPct: 30,                       // 30% drawdown triggers reset
  initialCapital: parseFloat(process.env.INITIAL_CAPITAL || '10000'),
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

        // 1. Close all open positions
        const positionsClosed = await this.closeAllPositions();

        // 2. Reset account to initial capital
        await this.resetAccount();

        // 3. Log the event
        const event: CircuitBreakerEvent = {
          timestamp: new Date(),
          drawdownPct,
          capitalBefore: currentCapital,
          capitalAfter: initialCapital,
          positionsClosed,
        };

        this.resetCount++;
        this.lastResetTime = event.timestamp;

        console.log(`[CircuitBreaker] Account reset to $${initialCapital} (closed ${positionsClosed} positions)`);
        this.emit('circuit:reset', event);

        // Log to database for historical tracking
        await this.logResetEvent(event);
      }
    } catch (error) {
      console.error('[CircuitBreaker] Error checking drawdown:', error);
      this.emit('error', error);
    }
  }

  /**
   * Close all open positions
   */
  private async closeAllPositions(): Promise<number> {
    const result = await query(`
      UPDATE paper_positions
      SET closed_at = NOW(), size = 0, realized_pnl = 0
      WHERE closed_at IS NULL
    `);

    return result.rowCount ?? 0;
  }

  /**
   * Reset account to initial capital
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
