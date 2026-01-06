/**
 * Paper Trading Service
 *
 * Bridges the PaperTradingEngine with database persistence.
 * Listens to trading events and saves trades, positions, and snapshots.
 */

import { isDatabaseConfigured } from '../database/index.js';
import {
  paperTradesRepo,
  paperPositionsRepo,
  portfolioSnapshotsRepo,
  signalPredictionsRepo,
  type PaperTrade,
  type PaperPosition,
  type PortfolioSnapshot,
  type SignalPrediction,
} from '../database/repositories.js';

// Types matching PaperTradingEngine events
interface Order {
  id: string;
  marketId: string;
  outcome: string;
  type: string;
  side: 'BUY' | 'SELL';
  size: number;
  price?: number;
  status: string;
  filledSize: number;
  avgFillPrice: number;
  createdAt: Date;
  updatedAt: Date;
  strategyId?: string;
}

interface OrderFill {
  orderId: string;
  marketId: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  fee: number;
  timestamp: Date;
}

interface Position {
  marketId: string;
  outcome: string;
  size: number;
  avgEntryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  openedAt: Date;
  lastUpdate: Date;
}

interface PortfolioState {
  cash: number;
  equity: number;
  positions: Position[];
  totalUnrealizedPnl: number;
  totalRealizedPnl: number;
  timestamp: Date;
}

interface SignalResult {
  signalId: string;
  marketId: string;
  outcome: string;
  direction: 'long' | 'short';
  strength: number;
  confidence: number;
  price: number;
}

export class PaperTradingService {
  private snapshotInterval: NodeJS.Timeout | null = null;
  private initialCapital: number;
  private lastSnapshot: PortfolioSnapshot | null = null;

  constructor(initialCapital = 10000) {
    this.initialCapital = initialCapital;
  }

  /**
   * Record a paper trade when an order is filled
   */
  async recordTrade(
    order: Order,
    fill: OrderFill,
    signalInfo?: { signalId?: number; signalType?: string; bestBid?: number; bestAsk?: number }
  ): Promise<void> {
    if (!isDatabaseConfigured()) {
      console.warn('Database not configured - trade not persisted');
      return;
    }

    try {
      const trade: Omit<PaperTrade, 'id'> = {
        time: fill.timestamp,
        market_id: fill.marketId,
        token_id: fill.outcome,
        side: fill.side.toLowerCase() as 'buy' | 'sell',
        requested_size: order.size,
        executed_size: fill.size,
        requested_price: order.price ?? 0,
        executed_price: fill.price,
        slippage_pct: order.price
          ? ((fill.price - order.price) / order.price) * 100
          : undefined,
        fee: fill.fee,
        value_usd: fill.size * fill.price,
        signal_id: signalInfo?.signalId,
        signal_type: signalInfo?.signalType,
        order_type: order.type.toLowerCase(),
        fill_type: fill.size >= order.size ? 'full' : 'partial',
        best_bid: signalInfo?.bestBid,
        best_ask: signalInfo?.bestAsk,
      };

      await paperTradesRepo.create(trade);
      console.log(`Paper trade recorded: ${fill.side} ${fill.size} @ ${fill.price}`);
    } catch (error) {
      console.error('Failed to record paper trade:', error);
    }
  }

  /**
   * Update position in database when position changes
   */
  async updatePosition(position: Position, signalType?: string): Promise<void> {
    if (!isDatabaseConfigured()) return;

    try {
      const dbPosition: PaperPosition = {
        market_id: position.marketId,
        token_id: position.outcome,
        side: 'long', // Prediction markets are always long
        size: position.size,
        avg_entry_price: position.avgEntryPrice,
        current_price: position.currentPrice,
        unrealized_pnl: position.unrealizedPnl,
        unrealized_pnl_pct:
          position.avgEntryPrice > 0
            ? ((position.currentPrice - position.avgEntryPrice) / position.avgEntryPrice) * 100
            : 0,
        realized_pnl: position.realizedPnl,
        opened_at: position.openedAt,
        signal_type: signalType,
      };

      await paperPositionsRepo.upsert(dbPosition);
    } catch (error) {
      console.error('Failed to update position:', error);
    }
  }

  /**
   * Close position in database
   */
  async closePosition(marketId: string): Promise<void> {
    if (!isDatabaseConfigured()) return;

    try {
      await paperPositionsRepo.close(marketId);
      console.log(`Position closed: ${marketId}`);
    } catch (error) {
      console.error('Failed to close position:', error);
    }
  }

  /**
   * Record a portfolio snapshot
   */
  async recordSnapshot(
    portfolioState: PortfolioState,
    stats?: {
      totalTrades?: number;
      winningTrades?: number;
      losingTrades?: number;
      maxDrawdown?: number;
    }
  ): Promise<void> {
    if (!isDatabaseConfigured()) return;

    try {
      const totalPnl = portfolioState.equity - this.initialCapital;
      const totalPnlPct = (totalPnl / this.initialCapital) * 100;

      // Calculate drawdown from peak
      const peakEquity = this.lastSnapshot
        ? Math.max(this.lastSnapshot.current_capital, portfolioState.equity)
        : portfolioState.equity;
      const currentDrawdown =
        peakEquity > 0 ? ((peakEquity - portfolioState.equity) / peakEquity) * 100 : 0;

      const snapshot: PortfolioSnapshot = {
        time: new Date(),
        initial_capital: this.initialCapital,
        current_capital: portfolioState.equity,
        available_capital: portfolioState.cash,
        total_pnl: totalPnl,
        total_pnl_pct: totalPnlPct,
        max_drawdown: stats?.maxDrawdown ?? currentDrawdown,
        current_drawdown: currentDrawdown,
        total_trades: stats?.totalTrades ?? 0,
        winning_trades: stats?.winningTrades ?? 0,
        losing_trades: stats?.losingTrades ?? 0,
        win_rate:
          stats?.totalTrades && stats.totalTrades > 0
            ? ((stats.winningTrades ?? 0) / stats.totalTrades) * 100
            : undefined,
        open_positions: portfolioState.positions.length,
        total_exposure: portfolioState.positions.reduce(
          (sum, p) => sum + p.size * p.currentPrice,
          0
        ),
      };

      await portfolioSnapshotsRepo.create(snapshot);
      this.lastSnapshot = snapshot;
    } catch (error) {
      console.error('Failed to record portfolio snapshot:', error);
    }
  }

  /**
   * Record a signal prediction
   */
  async recordSignal(signal: SignalResult): Promise<SignalPrediction | null> {
    if (!isDatabaseConfigured()) return null;

    try {
      const prediction: Omit<SignalPrediction, 'id'> = {
        time: new Date(),
        market_id: signal.marketId,
        signal_type: signal.signalId,
        direction: signal.direction,
        strength: signal.strength,
        confidence: signal.confidence,
        price_at_signal: signal.price,
      };

      return await signalPredictionsRepo.create(prediction);
    } catch (error) {
      console.error('Failed to record signal prediction:', error);
      return null;
    }
  }

  /**
   * Resolve a signal prediction (mark it as correct/incorrect)
   */
  async resolveSignal(
    id: number,
    time: Date,
    currentPrice: number,
    entryPrice: number,
    direction: 'long' | 'short'
  ): Promise<void> {
    if (!isDatabaseConfigured()) return;

    try {
      const pnlPct =
        direction === 'long'
          ? ((currentPrice - entryPrice) / entryPrice) * 100
          : ((entryPrice - currentPrice) / entryPrice) * 100;

      const wasCorrect = pnlPct > 0;

      await signalPredictionsRepo.resolve(id, time, {
        price_at_resolution: currentPrice,
        was_correct: wasCorrect,
        pnl_pct: pnlPct,
      });
    } catch (error) {
      console.error('Failed to resolve signal:', error);
    }
  }

  /**
   * Start periodic snapshot recording
   */
  startSnapshotRecording(
    getPortfolioState: () => PortfolioState,
    getStats: () => {
      totalTrades: number;
      winningTrades?: number;
      losingTrades?: number;
      maxDrawdown?: number;
    },
    intervalMs = 60000
  ): void {
    if (this.snapshotInterval) {
      clearInterval(this.snapshotInterval);
    }

    // Take immediate snapshot
    const portfolioState = getPortfolioState();
    const stats = getStats();
    this.recordSnapshot(portfolioState, stats);

    // Schedule periodic snapshots
    this.snapshotInterval = setInterval(() => {
      const portfolioState = getPortfolioState();
      const stats = getStats();
      this.recordSnapshot(portfolioState, stats);
    }, intervalMs);

    console.log(`Snapshot recording started (every ${intervalMs / 1000}s)`);
  }

  /**
   * Stop periodic snapshot recording
   */
  stopSnapshotRecording(): void {
    if (this.snapshotInterval) {
      clearInterval(this.snapshotInterval);
      this.snapshotInterval = null;
      console.log('Snapshot recording stopped');
    }
  }

  /**
   * Get the initial capital setting
   */
  getInitialCapital(): number {
    return this.initialCapital;
  }

  /**
   * Set initial capital
   */
  setInitialCapital(capital: number): void {
    this.initialCapital = capital;
  }
}

// Singleton instance
let paperTradingService: PaperTradingService | null = null;

export function getPaperTradingService(): PaperTradingService {
  if (!paperTradingService) {
    paperTradingService = new PaperTradingService();
  }
  return paperTradingService;
}

export function initializePaperTradingService(initialCapital?: number): PaperTradingService {
  paperTradingService = new PaperTradingService(initialCapital);
  return paperTradingService;
}
