/**
 * PositionClosingService
 *
 * Centralized service for closing positions with correct PnL and fee handling.
 * This is the single source of truth for all position-closing logic.
 *
 * Previously, three services closed positions with inconsistent fee handling:
 * - AutoSignalExecutor: correct (deducted fees)
 * - StopLossService: BUG (ignored fees entirely)
 * - PositionCleanupService: BUG (set fee=0)
 *
 * All callers should delegate to this service to ensure consistent financials.
 */

import { EventEmitter } from 'events';
import { transaction } from '../database/index.js';
import { paperTradesRepo } from '../database/repositories.js';
import type { PoolClient } from 'pg';

// ============================================
// Types
// ============================================

export type CloseReason = 'signal' | 'stop_loss' | 'take_profit' | 'time_exit' | 'cleanup_inactive' | 'cleanup_resolved' | 'circuit_breaker_exit';

export interface ClosePositionParams {
  positionId?: number;
  marketId: string;
  tokenId: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  exitPrice: number;
  reason: CloseReason;
  signalId?: string;
  predictionId?: string;
  execution_mode?: string;
}

export interface ClosePositionResult {
  executed: boolean;
  netPnl: number;
  fee: number;
  reason?: string;
  tradeId?: string;
}

// ============================================
// Config
// ============================================

export interface PositionClosingConfig {
  feeRate: number;
}

const DEFAULT_CONFIG: PositionClosingConfig = {
  feeRate: 0.001,
};

// ============================================
// Service
// ============================================

export class PositionClosingService extends EventEmitter {
  private readonly config: PositionClosingConfig;

  constructor(config?: Partial<PositionClosingConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Close a position with correct PnL/fee accounting.
   *
   * Uses a database transaction for atomicity:
   * 1. UPDATE paper_positions (mark closed, record PnL)
   * 2. UPDATE paper_account (return proceeds, track stats)
   *
   * If the position is already closed (rowCount=0), returns executed=false (idempotent).
   * Trade recording happens outside the transaction (non-critical).
   */
  async close(params: ClosePositionParams): Promise<ClosePositionResult> {
    const {
      positionId,
      marketId,
      tokenId,
      side,
      size,
      entryPrice,
      exitPrice,
      reason,
      signalId,
      predictionId,
      execution_mode,
    } = params;

    // 1. Validate exit price
    if (exitPrice === null || exitPrice === undefined || isNaN(exitPrice) || exitPrice < 0) {
      return { executed: false, netPnl: 0, fee: 0, reason: 'invalid exit price' };
    }

    // 2. Compute financials
    const exitValue = size * exitPrice;
    const fee = exitValue * this.config.feeRate;
    const grossPnl = (exitPrice - entryPrice) * size;
    const netPnl = grossPnl - fee;
    const proceeds = exitValue - fee;

    // 3. Database transaction for atomicity
    let txResult: { alreadyClosed: boolean };
    try {
      txResult = await transaction(async (client: PoolClient) => {
        // UPDATE paper_positions: mark closed
        const posResult = await client.query(
          `UPDATE paper_positions SET
            closed_at = NOW(),
            realized_pnl = COALESCE(realized_pnl, 0) + $1,
            current_price = $2,
            size = 0
          WHERE id = $3 AND closed_at IS NULL`,
          [netPnl, exitPrice, positionId]
        );

        // Idempotency: if no rows updated, position is already closed or not found
        if (posResult.rowCount === 0) {
          return { alreadyClosed: true };
        }

        // UPDATE paper_account: return proceeds, track fees and stats.
        // current_capital increases by proceeds (cash returned).
        // available_capital increases by proceeds + cost (releases the position lock
        // that was set in openPositionAtomically, restoring available = current).
        const cost = entryPrice * size;
        await client.query(
          `UPDATE paper_account SET
            current_capital = current_capital + $1,
            available_capital = available_capital + $1 + $4,
            total_fees_paid = total_fees_paid + $2,
            total_trades = total_trades + 1,
            total_realized_pnl = total_realized_pnl + $3,
            winning_trades = winning_trades + CASE WHEN $3 > 0 THEN 1 ELSE 0 END,
            losing_trades = losing_trades + CASE WHEN $3 < 0 THEN 1 ELSE 0 END,
            updated_at = NOW()
          WHERE id = 1`,
          [proceeds, fee, netPnl, cost]
        );

        return { alreadyClosed: false };
      });
    } catch (error) {
      return { executed: false, netPnl: 0, fee: 0, reason: `transaction failed: ${error}` };
    }

    if (txResult.alreadyClosed) {
      return { executed: false, netPnl: 0, fee: 0, reason: 'already closed or not found' };
    }

    // 4. Record trade (outside transaction, non-critical)
    let tradeId: string | undefined;
    try {
      const trade = await paperTradesRepo.create({
        time: new Date(),
        market_id: marketId,
        token_id: tokenId,
        side: 'sell',
        requested_size: size,
        executed_size: size,
        requested_price: exitPrice,
        executed_price: exitPrice,
        fee,
        value_usd: exitValue,
        signal_type: reason,
        order_type: 'market',
        fill_type: 'full',
        execution_mode: execution_mode ?? 'paper',
      });
      tradeId = trade?.id?.toString();
    } catch (error) {
      console.error(`[PositionClosingService] Failed to record trade for position ${positionId}:`, error);
      // Non-critical: position is already closed in DB, just log the error
    }

    const pnlStr = netPnl >= 0 ? `+$${netPnl.toFixed(2)}` : `-$${Math.abs(netPnl).toFixed(2)}`;
    console.log(`[PositionClosingService] Closed position ${positionId} (${reason}) | ${side} ${size} @ exit=$${exitPrice.toFixed(4)} | PnL: ${pnlStr} | Fee: $${fee.toFixed(4)}`);

    this.emit('position:closed', { marketId, reason, netPnl });

    return { executed: true, netPnl, fee, tradeId };
  }
}

// ============================================
// Singleton
// ============================================

let instance: PositionClosingService | null = null;

export function getPositionClosingService(): PositionClosingService {
  if (!instance) {
    const feeRate = parseFloat(process.env.TRADING_FEE_RATE || '0.001');
    instance = new PositionClosingService({ feeRate });
  }
  return instance;
}
