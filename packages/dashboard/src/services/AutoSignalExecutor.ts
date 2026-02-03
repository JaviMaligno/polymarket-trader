/**
 * Auto Signal Executor
 *
 * Automatically executes paper trades based on signal outputs.
 * Connects the signal engine to the paper trading system.
 *
 * Trading Logic:
 * - LONG signal: Opens a buy position if none exists
 * - SHORT signal: Closes existing LONG position (exit strategy)
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

export interface SignalResult {
  signalId: string;
  marketId: string;
  tokenId: string;
  direction: 'long' | 'short';
  strength: number;      // 0-1
  confidence: number;    // 0-1
  price: number;
  metadata?: Record<string, unknown>;
}

export interface ExecutorConfig {
  enabled: boolean;
  minConfidence: number;        // Minimum confidence to execute (0.6)
  minStrength: number;          // Minimum signal strength (0.3)
  maxPositionSize: number;      // Max $ per position (500)
  maxOpenPositions: number;     // Max concurrent positions (10)
  maxDailyTrades: number;       // Max trades per day (50)
  cooldownMs: number;           // Cooldown between trades same market (60000)
  feeRate: number;              // Trading fee rate (0.001)
  // Smart price validation based on ROI and probability
  minPotentialROI: number;      // Minimum potential ROI to accept (0.15 = 15%)
  minImpliedProbability: number; // Minimum market probability (0.10 = 10%)
}

const DEFAULT_CONFIG: ExecutorConfig = {
  enabled: true,
  minConfidence: parseFloat(process.env.EXECUTOR_MIN_CONFIDENCE || '0.55'),
  minStrength: parseFloat(process.env.EXECUTOR_MIN_STRENGTH || '0.20'),
  maxPositionSize: 500,
  maxOpenPositions: 10,
  maxDailyTrades: 50,
  cooldownMs: 60000,
  feeRate: 0.001,
  // Smart price validation - configurable via environment variables
  // minPotentialROI: 0.15 means need at least 15% potential gain → rejects prices > ~0.87
  // minImpliedProbability: 0.10 means market must show at least 10% chance → rejects prices < 0.10
  minPotentialROI: parseFloat(process.env.EXECUTOR_MIN_POTENTIAL_ROI || '0.15'),
  minImpliedProbability: parseFloat(process.env.EXECUTOR_MIN_IMPLIED_PROB || '0.10'),
};

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

  constructor(config?: Partial<ExecutorConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.lastDayReset = new Date();
    this.lastDayReset.setHours(0, 0, 0, 0);
  }

  /**
   * Process a signal and potentially execute a trade
   *
   * Trading Logic:
   * - LONG signal + no position → Open new LONG position (buy)
   * - LONG signal + existing LONG → Do nothing (already long)
   * - SHORT signal + existing LONG → CLOSE position (sell to exit)
   * - SHORT signal + no position → Do nothing (we don't short in paper trading)
   */
  async processSignal(signal: SignalResult): Promise<SignalProcessResult> {
    if (!this.config.enabled) {
      return { executed: false, reason: 'Executor disabled' };
    }

    if (!isDatabaseConfigured()) {
      return { executed: false, reason: 'Database not configured' };
    }

    // Reset daily counter if new day
    this.checkDayReset();

    // 1. Check signal thresholds
    if (signal.confidence < this.config.minConfidence) {
      return { executed: false, reason: `Confidence ${signal.confidence.toFixed(2)} below threshold ${this.config.minConfidence}` };
    }

    if (Math.abs(signal.strength) < this.config.minStrength) {
      return { executed: false, reason: `Strength ${Math.abs(signal.strength).toFixed(2)} below threshold ${this.config.minStrength}` };
    }

    // 2. Check daily trade limit
    if (this.dailyTradeCount >= this.config.maxDailyTrades) {
      return { executed: false, reason: `Daily trade limit reached (${this.config.maxDailyTrades})` };
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

    // 3b. Signal deduplication - prevent processing same signal type for same market within window
    const dedupKey = `${signal.marketId}:${signal.direction}`;
    const lastProcessed = this.processedSignals.get(dedupKey);
    if (lastProcessed && Date.now() - lastProcessed < this.SIGNAL_DEDUP_WINDOW_MS) {
      return { executed: false, reason: `Duplicate signal for ${signal.marketId} (${signal.direction}) within dedup window` };
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
      existingPosition = positions.find(p => p.market_id === signal.marketId);
    } catch (error) {
      console.error('Failed to check positions:', error);
      return { executed: false, reason: 'Failed to check positions' };
    }

    // 5. Handle SHORT signal - this is our EXIT strategy
    if (signal.direction === 'short') {
      if (!existingPosition) {
        return { executed: false, reason: 'SHORT signal but no position to close' };
      }
      // Close the existing LONG position
      return this.closePosition(existingPosition, signal);
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

      return this.openPosition(signal);
    }

    return { executed: false, reason: 'Unknown signal direction' };
  }

  /**
   * Open a new LONG position
   */
  private async openPosition(signal: SignalResult): Promise<SignalProcessResult> {
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

    // Calculate position size based on confidence, strength (absolute), and weight
    const sizeMultiplier = signal.confidence * Math.abs(signal.strength) * weight;
    const positionValue = Math.min(
      this.config.maxPositionSize * sizeMultiplier,
      this.config.maxPositionSize
    );

    // Calculate number of shares based on price
    const shares = Math.floor(positionValue / signal.price);
    if (shares < 1) {
      return { executed: false, reason: 'Position size too small' };
    }

    // Check account has enough capital
    try {
      const accountResult = await query<{ available_capital: string }>(
        'SELECT available_capital FROM paper_account LIMIT 1'
      );
      const availableCapital = parseFloat(accountResult.rows[0]?.available_capital ?? '0');
      const totalCost = shares * signal.price * (1 + this.config.feeRate);

      if (totalCost > availableCapital) {
        return { executed: false, reason: `Insufficient capital. Need $${totalCost.toFixed(2)}, have $${availableCapital.toFixed(2)}` };
      }
    } catch (error) {
      console.error('Failed to check account:', error);
      return { executed: false, reason: 'Failed to check account' };
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

    // Execute the BUY trade
    try {
      const fee = shares * signal.price * this.config.feeRate;
      const trade = await paperTradesRepo.create({
        time: new Date(),
        market_id: signal.marketId,
        token_id: signal.tokenId,
        side: 'buy',
        requested_size: shares,
        executed_size: shares,
        requested_price: signal.price,
        executed_price: signal.price,
        fee,
        value_usd: shares * signal.price,
        signal_id: prediction?.id,
        signal_type: signal.signalId,
        order_type: 'market',
        fill_type: 'full',
      });

      // Update paper account - subtract cost
      const orderValue = shares * signal.price;
      await query(
        `UPDATE paper_account SET
          current_capital = current_capital - $1,
          available_capital = available_capital - $1,
          total_fees_paid = total_fees_paid + $2,
          total_trades = total_trades + 1,
          updated_at = NOW()
        WHERE id = 1`,
        [orderValue + fee, fee]
      );

      // Create position
      await paperPositionsRepo.upsert({
        market_id: signal.marketId,
        token_id: signal.tokenId,
        side: 'long',
        size: shares,
        avg_entry_price: signal.price,
        current_price: signal.price,
        unrealized_pnl: 0,
        opened_at: new Date(),
        signal_type: signal.signalId,
      });

      // Track the trade
      this.recentTrades.push({ marketId: signal.marketId, timestamp: Date.now() });
      this.dailyTradeCount++;
      this.cleanupOldTrades();

      this.emit('trade:executed', {
        signal,
        trade,
        prediction,
        shares,
        value: orderValue,
        action: 'open',
      });

      console.log(`[AutoExecutor] OPENED: BUY ${shares} shares of ${signal.marketId.substring(0, 20)}... @ $${signal.price.toFixed(4)}`);

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
   */
  private async closePosition(position: PaperPosition, signal: SignalResult): Promise<SignalProcessResult> {
    const shares = Number(position.size);
    const entryPrice = Number(position.avg_entry_price);
    const exitPrice = signal.price;

    // Calculate P&L
    const grossPnl = (exitPrice - entryPrice) * shares;
    const fee = shares * exitPrice * this.config.feeRate;
    const netPnl = grossPnl - fee;

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
        metadata: { ...signal.metadata, action: 'close', pnl: netPnl },
      });
    } catch (error) {
      console.error('Failed to record prediction:', error);
    }

    // Execute the SELL trade
    try {
      const trade = await paperTradesRepo.create({
        time: new Date(),
        market_id: signal.marketId,
        token_id: signal.tokenId,
        side: 'sell',
        requested_size: shares,
        executed_size: shares,
        requested_price: exitPrice,
        executed_price: exitPrice,
        fee,
        value_usd: shares * exitPrice,
        signal_id: prediction?.id,
        signal_type: `${signal.signalId}_exit`,  // Mark as exit trade
        order_type: 'market',
        fill_type: 'full',
      });

      // Update paper account - add back proceeds
      const proceeds = shares * exitPrice;
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

      // Close the position (mark as closed)
      await query(
        `UPDATE paper_positions SET
          closed_at = NOW(),
          realized_pnl = $1
        WHERE market_id = $2 AND token_id = $3 AND closed_at IS NULL`,
        [netPnl, signal.marketId, signal.tokenId]
      );

      // Track the trade
      this.recentTrades.push({ marketId: signal.marketId, timestamp: Date.now() });
      this.dailyTradeCount++;
      this.cleanupOldTrades();

      const pnlStr = netPnl >= 0 ? `+$${netPnl.toFixed(2)}` : `-$${Math.abs(netPnl).toFixed(2)}`;
      this.emit('trade:executed', {
        signal,
        trade,
        prediction,
        shares,
        value: proceeds,
        action: 'close',
        pnl: netPnl,
      });

      console.log(`[AutoExecutor] CLOSED: SELL ${shares} shares of ${signal.marketId.substring(0, 20)}... @ $${exitPrice.toFixed(4)} | P&L: ${pnlStr}`);

      return {
        executed: true,
        tradeId: trade.id,
        predictionId: prediction?.id,
        action: 'close',
        pnl: netPnl,
      };

    } catch (error) {
      console.error('Failed to close position:', error);
      return { executed: false, reason: `Position close failed: ${error}` };
    }
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

export function initializeAutoSignalExecutor(config?: Partial<ExecutorConfig>): AutoSignalExecutor {
  autoSignalExecutor = new AutoSignalExecutor(config);
  return autoSignalExecutor;
}
