/**
 * Paper Trading Service
 *
 * Bridges the PaperTradingEngine with database persistence.
 * Listens to trading events and saves trades, positions, and snapshots.
 */

import { isDatabaseConfigured, query } from '../database/index.js';
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
   * Uses database account state for accuracy (not in-memory engine state)
   */
  async recordSnapshot(
    _portfolioState: PortfolioState,
    _stats?: {
      totalTrades?: number;
      winningTrades?: number;
      losingTrades?: number;
      maxDrawdown?: number;
    }
  ): Promise<void> {
    if (!isDatabaseConfigured()) return;

    try {
      // Fetch actual account state from database (not in-memory engine)
      const accountResult = await query<{
        initial_capital: string;
        current_capital: string;
        available_capital: string;
        total_realized_pnl: string;
        total_trades: number;
        winning_trades: number;
        losing_trades: number;
        max_drawdown: string;
        peak_equity: string;
      }>('SELECT * FROM paper_account LIMIT 1');

      if (accountResult.rows.length === 0) {
        console.warn('No paper account found for snapshot');
        return;
      }

      const account = accountResult.rows[0];
      const initialCapital = parseFloat(account.initial_capital);
      const currentCapital = parseFloat(account.current_capital);
      const availableCapital = parseFloat(account.available_capital);
      const peakEquity = parseFloat(account.peak_equity || String(currentCapital));

      // Get open positions from database
      const positionsResult = await query<{ count: string; total_exposure: string }>(
        `SELECT COUNT(*) as count, COALESCE(SUM(size * avg_entry_price), 0) as total_exposure
         FROM paper_positions WHERE closed_at IS NULL`
      );
      const openPositions = parseInt(positionsResult.rows[0]?.count || '0');
      const totalExposure = parseFloat(positionsResult.rows[0]?.total_exposure || '0');

      // Calculate equity (capital + position value)
      const equity = currentCapital + totalExposure;
      const totalPnl = equity - initialCapital;
      const totalPnlPct = initialCapital > 0 ? (totalPnl / initialCapital) * 100 : 0;

      // Calculate drawdown from peak
      const actualPeak = Math.max(peakEquity, equity);
      const currentDrawdown = actualPeak > 0 ? ((actualPeak - equity) / actualPeak) * 100 : 0;

      const snapshot: PortfolioSnapshot = {
        time: new Date(),
        initial_capital: initialCapital,
        current_capital: equity,
        available_capital: availableCapital,
        total_pnl: totalPnl,
        total_pnl_pct: totalPnlPct,
        max_drawdown: parseFloat(account.max_drawdown || '0'),
        current_drawdown: currentDrawdown,
        total_trades: account.total_trades || 0,
        winning_trades: account.winning_trades || 0,
        losing_trades: account.losing_trades || 0,
        win_rate:
          account.total_trades > 0
            ? (account.winning_trades / account.total_trades) * 100
            : undefined,
        open_positions: openPositions,
        total_exposure: totalExposure,
      };

      await portfolioSnapshotsRepo.create(snapshot);
      this.lastSnapshot = snapshot;

      // Update peak equity in account if current equity is higher
      if (equity > peakEquity) {
        await query('UPDATE paper_account SET peak_equity = $1 WHERE id = 1', [equity]);
      }
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
