/**
 * Position Cleanup Service
 *
 * Periodically checks for positions in inactive/resolved markets
 * and automatically closes them to prevent capital from being stuck.
 *
 * This is critical because:
 * - Markets can become inactive without the trading system knowing
 * - Resolved markets should return capital based on outcome
 * - Capital stuck in inactive positions can't be used for new trades
 */

import { EventEmitter } from 'events';
import { isDatabaseConfigured, query } from '../database/index.js';
import { paperPositionsRepo, paperTradesRepo } from '../database/repositories.js';

interface CleanupConfig {
  enabled: boolean;
  checkIntervalMs: number;  // How often to check (default: 30 minutes)
  closeInactiveMarkets: boolean;  // Close positions in inactive markets
  closeResolvedMarkets: boolean;  // Close positions in resolved markets
}

interface CleanupResult {
  positionsClosed: number;
  capitalRecovered: number;
  totalPnl: number;
  details: Array<{
    marketId: string;
    question: string;
    reason: 'inactive' | 'resolved';
    invested: number;
    recovered: number;
    pnl: number;
  }>;
}

const DEFAULT_CONFIG: CleanupConfig = {
  enabled: true,
  checkIntervalMs: 30 * 60 * 1000,  // 30 minutes
  closeInactiveMarkets: true,
  closeResolvedMarkets: true,
};

export class PositionCleanupService extends EventEmitter {
  private config: CleanupConfig;
  private checkInterval: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(config?: Partial<CleanupConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the cleanup service
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[PositionCleanup] Already running');
      return;
    }

    if (!isDatabaseConfigured()) {
      console.warn('[PositionCleanup] Database not configured - cannot start');
      return;
    }

    this.isRunning = true;
    console.log(`[PositionCleanup] Started (check interval: ${this.config.checkIntervalMs / 60000} minutes)`);

    // Schedule periodic cleanup checks
    this.checkInterval = setInterval(() => {
      this.runCleanup().catch(err => {
        console.error('[PositionCleanup] Cleanup failed:', err);
      });
    }, this.config.checkIntervalMs);

    // Run initial cleanup
    await this.runCleanup();

    this.emit('started');
  }

  /**
   * Stop the cleanup service
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.isRunning = false;
    console.log('[PositionCleanup] Stopped');
    this.emit('stopped');
  }

  /**
   * Run a cleanup cycle
   */
  async runCleanup(): Promise<CleanupResult> {
    if (!this.config.enabled) {
      return { positionsClosed: 0, capitalRecovered: 0, totalPnl: 0, details: [] };
    }

    const result: CleanupResult = {
      positionsClosed: 0,
      capitalRecovered: 0,
      totalPnl: 0,
      details: [],
    };

    try {
      // Find all open positions with their market status
      const positionsResult = await query<{
        id: number;
        market_id: string;
        token_id: string;
        side: string;
        size: string;
        avg_entry_price: string;
        is_active: boolean;
        is_resolved: boolean;
        resolution_outcome: string | null;
        question: string | null;
        current_price_yes: string | null;
        current_price_no: string | null;
      }>(`
        SELECT
          pp.id,
          pp.market_id,
          pp.token_id,
          pp.side,
          pp.size,
          pp.avg_entry_price,
          m.is_active,
          m.is_resolved,
          m.resolution_outcome,
          m.question,
          m.current_price_yes,
          m.current_price_no
        FROM paper_positions pp
        LEFT JOIN markets m ON pp.market_id = m.id
        WHERE pp.closed_at IS NULL
      `);

      for (const pos of positionsResult.rows) {
        const isInactive = pos.is_active === false;
        const isResolved = pos.is_resolved === true;

        // Skip if market is still active and not resolved
        if (!isInactive && !isResolved) {
          continue;
        }

        // Skip based on config
        if (isInactive && !this.config.closeInactiveMarkets) continue;
        if (isResolved && !this.config.closeResolvedMarkets) continue;

        const size = parseFloat(pos.size);
        const entryPrice = parseFloat(pos.avg_entry_price);
        const invested = size * entryPrice;

        // Calculate exit price based on market state
        let exitPrice = entryPrice;  // Default to entry price (breakeven)
        let reason: 'inactive' | 'resolved' = 'inactive';

        if (isResolved) {
          reason = 'resolved';
          const outcome = pos.resolution_outcome;

          if (outcome === 'Yes') {
            // YES won: Yes tokens = $1, No tokens = $0
            exitPrice = pos.side === 'long' ? 1.0 : 0.0;
          } else if (outcome === 'No') {
            // NO won: Yes tokens = $0, No tokens = $1
            exitPrice = pos.side === 'long' ? 0.0 : 1.0;
          }
          // If outcome is null/unknown, use current price or entry price
          else if (pos.current_price_yes) {
            exitPrice = parseFloat(pos.current_price_yes);
          }
        } else if (isInactive) {
          // Not resolved but inactive - use current market price if available
          if (pos.current_price_yes) {
            exitPrice = parseFloat(pos.current_price_yes);
          }
        }

        const exitValue = size * exitPrice;
        const pnl = exitValue - invested;

        // Close the position
        await this.closePosition(pos.id, pos.market_id, pos.token_id, size, exitPrice, pnl, reason);

        result.positionsClosed++;
        result.capitalRecovered += exitValue;
        result.totalPnl += pnl;
        result.details.push({
          marketId: pos.market_id,
          question: pos.question || pos.market_id.substring(0, 30),
          reason,
          invested,
          recovered: exitValue,
          pnl,
        });

        console.log(`[PositionCleanup] Closed position in ${reason} market: ${(pos.question || pos.market_id).substring(0, 40)}... | PnL: $${pnl.toFixed(2)}`);
      }

      if (result.positionsClosed > 0) {
        console.log(`[PositionCleanup] Cleanup complete: ${result.positionsClosed} positions closed, $${result.capitalRecovered.toFixed(2)} recovered, PnL: $${result.totalPnl.toFixed(2)}`);
        this.emit('cleanup:complete', result);
      }

      return result;

    } catch (error) {
      console.error('[PositionCleanup] Error during cleanup:', error);
      this.emit('cleanup:error', error);
      return result;
    }
  }

  /**
   * Close a single position
   */
  private async closePosition(
    positionId: number,
    marketId: string,
    tokenId: string,
    size: number,
    exitPrice: number,
    pnl: number,
    reason: 'inactive' | 'resolved'
  ): Promise<void> {
    const exitValue = size * exitPrice;

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

    // Record a cleanup trade for tracking
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
      signal_type: `cleanup_${reason}`,
      order_type: 'market',
      fill_type: 'full',
    });
  }

  /**
   * Force a cleanup run (for manual triggers)
   */
  async forceCleanup(): Promise<CleanupResult> {
    console.log('[PositionCleanup] Manual cleanup triggered');
    return this.runCleanup();
  }

  /**
   * Get current configuration
   */
  getConfig(): CleanupConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<CleanupConfig>): void {
    this.config = { ...this.config, ...updates };
    console.log('[PositionCleanup] Config updated');
    this.emit('config:updated', this.config);
  }

  /**
   * Check if service is running
   */
  isActive(): boolean {
    return this.isRunning;
  }
}

// Singleton instance
let cleanupService: PositionCleanupService | null = null;

export function getPositionCleanupService(): PositionCleanupService {
  if (!cleanupService) {
    cleanupService = new PositionCleanupService();
  }
  return cleanupService;
}

export function initializePositionCleanupService(config?: Partial<CleanupConfig>): PositionCleanupService {
  cleanupService = new PositionCleanupService(config);
  return cleanupService;
}
