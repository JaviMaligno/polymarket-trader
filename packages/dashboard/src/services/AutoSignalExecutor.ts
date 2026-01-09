/**
 * Auto Signal Executor
 *
 * Automatically executes paper trades based on signal outputs.
 * Connects the signal engine to the paper trading system.
 */

import { EventEmitter } from 'events';
import { isDatabaseConfigured, query } from '../database/index.js';
import {
  paperTradesRepo,
  paperPositionsRepo,
  signalPredictionsRepo,
  signalWeightsRepo,
  type SignalPrediction,
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
}

const DEFAULT_CONFIG: ExecutorConfig = {
  enabled: true,
  minConfidence: parseFloat(process.env.EXECUTOR_MIN_CONFIDENCE || '0.40'),  // Lowered from 0.6 to match optimized params
  minStrength: parseFloat(process.env.EXECUTOR_MIN_STRENGTH || '0.05'),      // Lowered from 0.3 to match optimized params
  maxPositionSize: 500,
  maxOpenPositions: 10,
  maxDailyTrades: 50,
  cooldownMs: 60000,
  feeRate: 0.001,
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
}

export class AutoSignalExecutor extends EventEmitter {
  private config: ExecutorConfig;
  private recentTrades: TradeRecord[] = [];
  private dailyTradeCount = 0;
  private lastDayReset: Date;
  private isRunning = false;

  constructor(config?: Partial<ExecutorConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.lastDayReset = new Date();
    this.lastDayReset.setHours(0, 0, 0, 0);
  }

  /**
   * Process a signal and potentially execute a trade
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

    if (signal.strength < this.config.minStrength) {
      return { executed: false, reason: `Strength ${signal.strength.toFixed(2)} below threshold ${this.config.minStrength}` };
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

    // 4. Check max open positions
    try {
      const positions = await paperPositionsRepo.getAll();
      if (positions.length >= this.config.maxOpenPositions) {
        return { executed: false, reason: `Max open positions reached (${this.config.maxOpenPositions})` };
      }

      // 5. Check if already have position in this market
      const existingPosition = positions.find(p => p.market_id === signal.marketId);
      if (existingPosition) {
        return { executed: false, reason: `Already have position in market ${signal.marketId}` };
      }
    } catch (error) {
      console.error('Failed to check positions:', error);
      return { executed: false, reason: 'Failed to check positions' };
    }

    // 6. Get signal weight from database
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

    // 7. Calculate position size based on confidence, strength, and weight
    const sizeMultiplier = signal.confidence * signal.strength * weight;
    const positionValue = Math.min(
      this.config.maxPositionSize * sizeMultiplier,
      this.config.maxPositionSize
    );

    // Calculate number of shares based on price
    const shares = Math.floor(positionValue / signal.price);
    if (shares < 1) {
      return { executed: false, reason: 'Position size too small' };
    }

    // 8. Check account has enough capital
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

    // 9. Record the signal prediction first
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

    // 10. Execute the trade
    try {
      const fee = shares * signal.price * this.config.feeRate;
      const trade = await paperTradesRepo.create({
        time: new Date(),
        market_id: signal.marketId,
        token_id: signal.tokenId,
        side: signal.direction === 'long' ? 'buy' : 'sell',
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

      // Update paper account
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

      // Clean up old trade records
      this.recentTrades = this.recentTrades.filter(
        t => Date.now() - t.timestamp < this.config.cooldownMs * 2
      );

      this.emit('trade:executed', {
        signal,
        trade,
        prediction,
        shares,
        value: orderValue,
      });

      console.log(`[AutoExecutor] Executed: ${signal.direction} ${shares} shares of ${signal.marketId} @ ${signal.price}`);

      return {
        executed: true,
        tradeId: trade.id,
        predictionId: prediction?.id,
      };

    } catch (error) {
      console.error('Failed to execute trade:', error);
      return { executed: false, reason: `Trade execution failed: ${error}` };
    }
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
