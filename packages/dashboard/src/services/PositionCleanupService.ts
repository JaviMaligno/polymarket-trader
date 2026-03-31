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
import { getPositionClosingService } from './PositionClosingService.js';

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
        latest_price: string | null;
        opened_at: Date | null;
      }>(`
        SELECT
          pp.id,
          pp.market_id,
          pp.token_id,
          pp.side,
          pp.size,
          pp.avg_entry_price,
          pp.opened_at,
          m.is_active,
          m.is_resolved,
          m.resolution_outcome,
          m.question,
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
          // If outcome is null/unknown, use latest price from price_history
          else if (pos.latest_price) {
            exitPrice = parseFloat(pos.latest_price);
          }
        } else if (isInactive) {
          // Not resolved but inactive - use latest price from price_history
          if (pos.latest_price) {
            exitPrice = parseFloat(pos.latest_price);
          }
        }

        const exitValue = size * exitPrice;
        const pnl = exitValue - invested;

        // Close the position
        await this.closePosition(pos.id, pos.market_id, pos.token_id, pos.side as 'long' | 'short', size, entryPrice, exitPrice, reason, pos.opened_at ? new Date(pos.opened_at) : undefined);

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
   * Close a single position via PositionClosingService (correct fee handling)
   */
  private async closePosition(
    positionId: number,
    marketId: string,
    tokenId: string,
    side: 'long' | 'short',
    size: number,
    entryPrice: number,
    exitPrice: number,
    reason: 'inactive' | 'resolved',
    openedAt?: Date
  ): Promise<void> {
    await getPositionClosingService().close({
      positionId,
      marketId,
      tokenId,
      side,
      size,
      entryPrice,
      exitPrice,
      reason: reason === 'inactive' ? 'cleanup_inactive' : 'cleanup_resolved',
      openedAt,
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
