import pino from 'pino';
import type {
  Position,
  PortfolioState,
  PortfolioSnapshot,
  PriceUpdateEvent,
  MarketResolvedEvent,
  BacktestEvent,
  OrderEvent,
  Order,
  TradeRecord,
} from '../types/index.js';
import type { IPortfolioManager } from '../engine/BacktestEngine.js';

interface PortfolioManagerConfig {
  /** Initial capital */
  initialCapital: number;
  /** Fee rate for trades */
  feeRate: number;
  /** Snapshot interval in minutes */
  snapshotIntervalMinutes: number;
}

/**
 * PortfolioManager - Tracks positions, P&L, and equity curve
 *
 * Features:
 * - Position tracking with entry/exit
 * - Real-time P&L calculation
 * - Equity curve generation
 * - Trade history with full details
 */
export class PortfolioManager implements IPortfolioManager {
  private config: PortfolioManagerConfig;
  private logger: pino.Logger;

  // Portfolio state
  private cash: number;
  private positions: Map<string, Position> = new Map();
  private closedPositions: Position[] = [];

  // Price tracking
  private currentPrices: Map<string, number> = new Map();

  // Market resolution tracking
  private marketResolutions: Map<string, { outcome: 'YES' | 'NO' | 'INVALID'; price: number }> = new Map();

  // Equity curve
  private equityCurve: PortfolioSnapshot[] = [];
  private lastSnapshotTime: Date | null = null;

  // Trade history
  private trades: TradeRecord[] = [];

  // Tracking
  private highWaterMark: number;
  private totalFees: number = 0;

  constructor(config: PortfolioManagerConfig) {
    this.config = config;
    this.cash = config.initialCapital;
    this.highWaterMark = config.initialCapital;
    this.logger = pino({ name: 'PortfolioManager' });
  }

  /**
   * Get current portfolio state
   */
  getState(): PortfolioState {
    const positionsValue = this.calculatePositionsValue();
    const totalValue = this.cash + positionsValue;
    const unrealizedPnl = this.calculateUnrealizedPnL();
    const realizedPnl = this.calculateRealizedPnL();

    return {
      timestamp: new Date(),
      cash: this.cash,
      positions: new Map(this.positions),
      totalValue,
      unrealizedPnl,
      realizedPnl,
      marginUsed: positionsValue, // Simplified margin model
      marginAvailable: this.cash,
    };
  }

  /**
   * Get current snapshot
   */
  getSnapshot(): PortfolioSnapshot {
    const positionsValue = this.calculatePositionsValue();
    const totalValue = this.cash + positionsValue;
    const unrealizedPnl = this.calculateUnrealizedPnL();
    const realizedPnl = this.calculateRealizedPnL();

    if (totalValue > this.highWaterMark) {
      this.highWaterMark = totalValue;
    }

    const drawdown = this.highWaterMark > 0
      ? (this.highWaterMark - totalValue) / this.highWaterMark
      : 0;

    return {
      timestamp: new Date(),
      cash: this.cash,
      positionsValue,
      totalValue,
      unrealizedPnl,
      realizedPnl,
      drawdown,
      highWaterMark: this.highWaterMark,
    };
  }

  /**
   * Get equity curve
   */
  getEquityCurve(): PortfolioSnapshot[] {
    return [...this.equityCurve];
  }

  /**
   * Get all completed trades
   */
  getTrades(): TradeRecord[] {
    return [...this.trades];
  }

  /**
   * Handle price update
   */
  handlePriceUpdate(event: PriceUpdateEvent): void {
    const key = this.getPositionKey(event.data.marketId, event.data.tokenId);
    this.currentPrices.set(key, event.data.price);

    // Update position current price
    const position = this.positions.get(key);
    if (position) {
      position.currentPrice = event.data.price;
      position.unrealizedPnl = this.calculatePositionPnL(position);
    }

    // Record snapshot if needed
    this.maybeRecordSnapshot(event.timestamp);
  }

  /**
   * Handle order filled event
   */
  handleOrderFilled(event: BacktestEvent): void {
    const orderEvent = event as OrderEvent;
    if (orderEvent.type !== 'ORDER_FILLED') return;

    const order = orderEvent.data;
    const key = this.getPositionKey(order.marketId, order.tokenId);
    const existingPosition = this.positions.get(key);

    if (existingPosition) {
      this.updatePosition(existingPosition, order);
    } else {
      this.openPosition(order);
    }

    // Deduct fees
    const fees = order.fills.reduce((sum, f) => sum + f.fee, 0);
    this.cash -= fees;
    this.totalFees += fees;
  }

  /**
   * Handle market resolved event
   */
  handleMarketResolved(event: MarketResolvedEvent): void {
    this.marketResolutions.set(event.data.marketId, {
      outcome: event.data.outcome,
      price: event.data.resolutionPrice,
    });

    // Close all positions in this market at resolution price
    for (const [key, position] of this.positions) {
      if (position.marketId === event.data.marketId) {
        this.closePositionAtResolution(position, event);
      }
    }
  }

  /**
   * Open a new position
   */
  private openPosition(order: Order): void {
    const key = this.getPositionKey(order.marketId, order.tokenId);
    const side = order.side === 'BUY' ? 'LONG' : 'SHORT';

    const position: Position = {
      id: `pos_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      marketId: order.marketId,
      tokenId: order.tokenId,
      side,
      size: order.filledSize,
      entryPrice: order.avgFillPrice,
      currentPrice: order.avgFillPrice,
      unrealizedPnl: 0,
      realizedPnl: 0,
      openedAt: order.updatedAt,
      orders: [order.id],
    };

    this.positions.set(key, position);

    // Update cash
    if (side === 'LONG') {
      this.cash -= order.filledSize * order.avgFillPrice;
    } else {
      // SHORT: receive premium but have liability
      this.cash += order.filledSize * order.avgFillPrice;
    }

    this.logger.debug({ position }, 'Position opened');
  }

  /**
   * Update existing position
   */
  private updatePosition(position: Position, order: Order): void {
    const isAddingToPosition =
      (position.side === 'LONG' && order.side === 'BUY') ||
      (position.side === 'SHORT' && order.side === 'SELL');

    if (isAddingToPosition) {
      // Adding to position - average in
      const totalCost = position.size * position.entryPrice + order.filledSize * order.avgFillPrice;
      const newSize = position.size + order.filledSize;
      position.entryPrice = totalCost / newSize;
      position.size = newSize;
      position.orders.push(order.id);

      if (position.side === 'LONG') {
        this.cash -= order.filledSize * order.avgFillPrice;
      } else {
        this.cash += order.filledSize * order.avgFillPrice;
      }
    } else {
      // Reducing or closing position
      const closeSize = Math.min(order.filledSize, position.size);
      const pnl = this.calculateClosePnL(position, order.avgFillPrice, closeSize);

      position.realizedPnl += pnl;

      if (position.side === 'LONG') {
        this.cash += closeSize * order.avgFillPrice;
      } else {
        this.cash -= closeSize * order.avgFillPrice;
      }

      if (closeSize >= position.size) {
        // Position fully closed
        this.closePosition(position, order.avgFillPrice, order.updatedAt);
      } else {
        // Partial close
        position.size -= closeSize;
        position.orders.push(order.id);
      }
    }
  }

  /**
   * Close position
   */
  private closePosition(position: Position, exitPrice: number, exitTime: Date): void {
    const key = this.getPositionKey(position.marketId, position.tokenId);

    position.closedAt = exitTime;
    position.currentPrice = exitPrice;
    position.unrealizedPnl = 0;

    // Record trade
    const trade: TradeRecord = {
      id: `trade_${Date.now()}`,
      marketId: position.marketId,
      tokenId: position.tokenId,
      marketQuestion: '', // Would need market info
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice,
      size: position.size,
      pnl: position.realizedPnl,
      pnlPct: (position.realizedPnl / (position.size * position.entryPrice)) * 100,
      fees: 0, // Tracked separately
      entryTime: position.openedAt,
      exitTime,
      holdingPeriodMs: exitTime.getTime() - position.openedAt.getTime(),
      signals: [],
      marketResolved: false,
    };

    this.trades.push(trade);
    this.closedPositions.push(position);
    this.positions.delete(key);

    this.logger.debug({ trade }, 'Position closed');
  }

  /**
   * Close position at market resolution
   */
  private closePositionAtResolution(position: Position, event: MarketResolvedEvent): void {
    const key = this.getPositionKey(position.marketId, position.tokenId);
    const resolutionPrice = event.data.resolutionPrice;

    // Calculate P&L at resolution
    const pnl = this.calculateClosePnL(position, resolutionPrice, position.size);
    position.realizedPnl = pnl;

    // Settlement
    if (position.side === 'LONG') {
      this.cash += position.size * resolutionPrice;
    } else {
      this.cash -= position.size * resolutionPrice;
    }

    // Record trade
    const trade: TradeRecord = {
      id: `trade_${Date.now()}`,
      marketId: position.marketId,
      tokenId: position.tokenId,
      marketQuestion: '',
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice: resolutionPrice,
      size: position.size,
      pnl,
      pnlPct: (pnl / (position.size * position.entryPrice)) * 100,
      fees: 0,
      entryTime: position.openedAt,
      exitTime: event.timestamp,
      holdingPeriodMs: event.timestamp.getTime() - position.openedAt.getTime(),
      signals: [],
      marketResolved: true,
      resolutionOutcome: event.data.outcome,
    };

    this.trades.push(trade);
    this.closedPositions.push(position);
    this.positions.delete(key);

    this.logger.debug({ trade }, 'Position resolved');
  }

  /**
   * Calculate P&L for closing a position
   */
  private calculateClosePnL(position: Position, exitPrice: number, size: number): number {
    if (position.side === 'LONG') {
      return (exitPrice - position.entryPrice) * size;
    } else {
      return (position.entryPrice - exitPrice) * size;
    }
  }

  /**
   * Calculate position P&L
   */
  private calculatePositionPnL(position: Position): number {
    if (position.side === 'LONG') {
      return (position.currentPrice - position.entryPrice) * position.size;
    } else {
      return (position.entryPrice - position.currentPrice) * position.size;
    }
  }

  /**
   * Calculate total positions value
   */
  private calculatePositionsValue(): number {
    let value = 0;
    for (const position of this.positions.values()) {
      value += position.currentPrice * position.size;
    }
    return value;
  }

  /**
   * Calculate total unrealized P&L
   */
  private calculateUnrealizedPnL(): number {
    let pnl = 0;
    for (const position of this.positions.values()) {
      pnl += this.calculatePositionPnL(position);
    }
    return pnl;
  }

  /**
   * Calculate total realized P&L
   */
  private calculateRealizedPnL(): number {
    return this.trades.reduce((sum, t) => sum + t.pnl, 0);
  }

  /**
   * Maybe record equity snapshot
   */
  private maybeRecordSnapshot(timestamp: Date): void {
    const intervalMs = this.config.snapshotIntervalMinutes * 60 * 1000;

    if (!this.lastSnapshotTime ||
        timestamp.getTime() - this.lastSnapshotTime.getTime() >= intervalMs) {
      const snapshot = this.getSnapshot();
      snapshot.timestamp = timestamp;
      this.equityCurve.push(snapshot);
      this.lastSnapshotTime = timestamp;
    }
  }

  /**
   * Get position key
   */
  private getPositionKey(marketId: string, tokenId: string): string {
    return `${marketId}:${tokenId}`;
  }

  /**
   * Reset portfolio
   */
  reset(initialCapital: number): void {
    this.cash = initialCapital;
    this.positions.clear();
    this.closedPositions = [];
    this.currentPrices.clear();
    this.marketResolutions.clear();
    this.equityCurve = [];
    this.lastSnapshotTime = null;
    this.trades = [];
    this.highWaterMark = initialCapital;
    this.totalFees = 0;

    this.config.initialCapital = initialCapital;
  }

  /**
   * Get total fees paid
   */
  getTotalFees(): number {
    return this.totalFees;
  }

  /**
   * Get open positions count
   */
  getOpenPositionsCount(): number {
    return this.positions.size;
  }

  /**
   * Get specific position
   */
  getPosition(marketId: string, tokenId: string): Position | null {
    return this.positions.get(this.getPositionKey(marketId, tokenId)) || null;
  }
}
