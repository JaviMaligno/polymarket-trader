/**
 * Paper Trading Engine
 *
 * Simulates live trading without real money. Executes orders,
 * tracks positions, calculates P&L, and applies realistic
 * slippage and fees.
 */

import pino from 'pino';
import { EventEmitter } from 'eventemitter3';
import type {
  Order,
  OrderRequest,
  OrderFill,
  OrderStatus,
  Position,
  PortfolioState,
  LivePrice,
  TradingEvent,
  OrderEvent,
  PositionEvent,
} from '../types/index.js';
import type { LiveDataFeed } from '../feeds/LiveDataFeed.js';

const logger = pino({ name: 'PaperTradingEngine' });

// ============================================
// Types
// ============================================

export interface PaperTradingConfig {
  /** Initial cash balance */
  initialCapital: number;
  /** Fee rate per trade (e.g., 0.002 = 0.2%) */
  feeRate: number;
  /** Slippage model */
  slippageModel: 'none' | 'fixed' | 'proportional' | 'orderbook';
  /** Fixed slippage in price points */
  fixedSlippage?: number;
  /** Proportional slippage rate */
  proportionalSlippage?: number;
  /** Enable partial fills simulation */
  enablePartialFills: boolean;
  /** Latency simulation in ms */
  latencyMs: number;
  /** Market resolution handling */
  autoCloseOnResolution: boolean;
}

export interface PaperTradingEvents {
  'order:created': (order: Order) => void;
  'order:filled': (order: Order, fill: OrderFill) => void;
  'order:cancelled': (order: Order, reason: string) => void;
  'order:rejected': (order: Order, reason: string) => void;
  'position:opened': (position: Position) => void;
  'position:updated': (position: Position, previous: Position) => void;
  'position:closed': (position: Position, pnl: number) => void;
  'portfolio:updated': (state: PortfolioState) => void;
}

interface InternalOrder extends Order {
  _pendingCancel: boolean;
}

// ============================================
// Default Configuration
// ============================================

const DEFAULT_CONFIG: PaperTradingConfig = {
  initialCapital: 10000,
  feeRate: 0.002,
  slippageModel: 'proportional',
  proportionalSlippage: 0.001,
  enablePartialFills: false,
  latencyMs: 100,
  autoCloseOnResolution: true,
};

// ============================================
// Paper Trading Engine
// ============================================

export class PaperTradingEngine extends EventEmitter<PaperTradingEvents> {
  private config: PaperTradingConfig;
  private feed: LiveDataFeed;

  private cash: number;
  private orders: Map<string, InternalOrder> = new Map();
  private positions: Map<string, Position> = new Map();
  private orderHistory: Order[] = [];
  private fillHistory: OrderFill[] = [];
  private tradeCount: number = 0;

  private isRunning: boolean = false;
  private updateInterval: NodeJS.Timeout | null = null;

  constructor(feed: LiveDataFeed, config?: Partial<PaperTradingConfig>) {
    super();
    this.feed = feed;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.cash = this.config.initialCapital;
  }

  // ============================================
  // Engine Control
  // ============================================

  /**
   * Start the paper trading engine
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Engine already running');
      return;
    }

    logger.info({ config: this.config }, 'Starting paper trading engine');

    this.isRunning = true;

    // Listen to price updates for order execution
    this.feed.on('price', this.handlePriceUpdate.bind(this));

    // Periodic position updates
    this.updateInterval = setInterval(() => {
      this.updatePositions();
    }, 1000);

    this.emitPortfolioUpdate();
  }

  /**
   * Stop the paper trading engine
   */
  stop(): void {
    if (!this.isRunning) return;

    logger.info('Stopping paper trading engine');

    this.isRunning = false;

    this.feed.off('price', this.handlePriceUpdate.bind(this));

    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  /**
   * Reset the engine to initial state
   */
  reset(): void {
    this.stop();
    this.cash = this.config.initialCapital;
    this.orders.clear();
    this.positions.clear();
    this.orderHistory = [];
    this.fillHistory = [];
    this.tradeCount = 0;

    logger.info('Engine reset to initial state');
    this.emitPortfolioUpdate();
  }

  // ============================================
  // Order Management
  // ============================================

  /**
   * Submit a new order
   */
  async submitOrder(request: OrderRequest): Promise<Order> {
    // Simulate network latency
    await this.simulateLatency();

    const order: InternalOrder = {
      id: this.generateOrderId(),
      marketId: request.marketId,
      outcome: request.outcome,
      type: request.type,
      side: request.side,
      size: request.size,
      price: request.price,
      stopPrice: request.stopPrice,
      status: 'PENDING',
      filledSize: 0,
      avgFillPrice: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: request.expiresAt,
      strategyId: request.strategyId,
      metadata: request.metadata,
      _pendingCancel: false,
    };

    // Validate order
    const validation = this.validateOrder(order);
    if (!validation.valid) {
      order.status = 'REJECTED';
      this.emit('order:rejected', order, validation.reason!);
      this.orderHistory.push(order);
      return order;
    }

    // Add to active orders
    this.orders.set(order.id, order);
    order.status = 'OPEN';
    order.updatedAt = new Date();

    this.emit('order:created', order);
    logger.info({ orderId: order.id, type: order.type, side: order.side, size: order.size }, 'Order created');

    // Attempt immediate execution for market orders
    if (order.type === 'MARKET') {
      await this.tryExecuteOrder(order);
    }

    return order;
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId: string): Promise<boolean> {
    const order = this.orders.get(orderId);
    if (!order) {
      logger.warn({ orderId }, 'Order not found');
      return false;
    }

    if (order.status !== 'OPEN' && order.status !== 'PARTIAL') {
      logger.warn({ orderId, status: order.status }, 'Cannot cancel order in current status');
      return false;
    }

    await this.simulateLatency();

    order.status = 'CANCELLED';
    order.updatedAt = new Date();
    this.orders.delete(orderId);
    this.orderHistory.push(order);

    this.emit('order:cancelled', order, 'User requested');
    logger.info({ orderId }, 'Order cancelled');

    return true;
  }

  /**
   * Cancel all open orders
   */
  async cancelAllOrders(strategyId?: string): Promise<number> {
    let cancelled = 0;
    const ordersToCancel = Array.from(this.orders.values())
      .filter(o => !strategyId || o.strategyId === strategyId);

    for (const order of ordersToCancel) {
      if (await this.cancelOrder(order.id)) {
        cancelled++;
      }
    }

    return cancelled;
  }

  /**
   * Get an order by ID
   */
  getOrder(orderId: string): Order | undefined {
    return this.orders.get(orderId) || this.orderHistory.find(o => o.id === orderId);
  }

  /**
   * Get all open orders
   */
  getOpenOrders(strategyId?: string): Order[] {
    return Array.from(this.orders.values())
      .filter(o => !strategyId || o.strategyId === strategyId);
  }

  // ============================================
  // Order Execution
  // ============================================

  /**
   * Handle price updates and try to execute orders
   */
  private handlePriceUpdate(price: LivePrice): void {
    if (!this.isRunning) return;

    // Find matching orders
    const matchingOrders = Array.from(this.orders.values())
      .filter(o => o.marketId === price.marketId && o.outcome === price.outcome);

    for (const order of matchingOrders) {
      this.tryExecuteOrder(order, price);
    }

    // Update positions with new price
    this.updatePositionPrice(price);
  }

  /**
   * Try to execute an order
   */
  private async tryExecuteOrder(order: InternalOrder, price?: LivePrice): Promise<void> {
    if (order._pendingCancel) return;

    const currentPrice = price || this.feed.getPrice(order.marketId, order.outcome);
    if (!currentPrice) return;

    let shouldFill = false;
    let fillPrice = currentPrice.price;

    switch (order.type) {
      case 'MARKET':
        shouldFill = true;
        fillPrice = order.side === 'BUY' ? currentPrice.ask : currentPrice.bid;
        break;

      case 'LIMIT':
        if (order.side === 'BUY' && currentPrice.ask <= order.price!) {
          shouldFill = true;
          fillPrice = Math.min(currentPrice.ask, order.price!);
        } else if (order.side === 'SELL' && currentPrice.bid >= order.price!) {
          shouldFill = true;
          fillPrice = Math.max(currentPrice.bid, order.price!);
        }
        break;

      case 'STOP':
        if (order.side === 'BUY' && currentPrice.price >= order.stopPrice!) {
          shouldFill = true;
          fillPrice = currentPrice.ask;
        } else if (order.side === 'SELL' && currentPrice.price <= order.stopPrice!) {
          shouldFill = true;
          fillPrice = currentPrice.bid;
        }
        break;

      case 'STOP_LIMIT':
        // First check stop trigger
        if (order.side === 'BUY' && currentPrice.price >= order.stopPrice!) {
          // Convert to limit order logic
          if (currentPrice.ask <= order.price!) {
            shouldFill = true;
            fillPrice = Math.min(currentPrice.ask, order.price!);
          }
        } else if (order.side === 'SELL' && currentPrice.price <= order.stopPrice!) {
          if (currentPrice.bid >= order.price!) {
            shouldFill = true;
            fillPrice = Math.max(currentPrice.bid, order.price!);
          }
        }
        break;
    }

    if (shouldFill) {
      await this.executeOrder(order, fillPrice);
    }
  }

  /**
   * Execute an order at the given price
   */
  private async executeOrder(order: InternalOrder, basePrice: number): Promise<void> {
    // Apply slippage
    const slippageAmount = this.calculateSlippage(order, basePrice);
    const fillPrice = order.side === 'BUY'
      ? basePrice + slippageAmount
      : basePrice - slippageAmount;

    // Check if we have enough cash for buy orders
    const orderValue = order.size * fillPrice;
    const fee = orderValue * this.config.feeRate;

    if (order.side === 'BUY') {
      const totalCost = orderValue + fee;
      if (totalCost > this.cash) {
        order.status = 'REJECTED';
        order.updatedAt = new Date();
        this.orders.delete(order.id);
        this.orderHistory.push(order);
        this.emit('order:rejected', order, 'Insufficient funds');
        return;
      }
    }

    // Create fill
    const fill: OrderFill = {
      orderId: order.id,
      marketId: order.marketId,
      outcome: order.outcome,
      side: order.side,
      size: order.size,
      price: fillPrice,
      fee,
      timestamp: new Date(),
    };

    // Update order
    order.filledSize = order.size;
    order.avgFillPrice = fillPrice;
    order.status = 'FILLED';
    order.updatedAt = new Date();

    // Update cash
    if (order.side === 'BUY') {
      this.cash -= (orderValue + fee);
    } else {
      this.cash += (orderValue - fee);
    }

    // Update position
    this.updatePosition(order, fill);

    // Move to history
    this.orders.delete(order.id);
    this.orderHistory.push(order);
    this.fillHistory.push(fill);
    this.tradeCount++;

    this.emit('order:filled', order, fill);
    this.emitPortfolioUpdate();

    logger.info({
      orderId: order.id,
      fillPrice,
      size: order.size,
      side: order.side,
      fee,
    }, 'Order filled');
  }

  /**
   * Calculate slippage for an order
   */
  private calculateSlippage(order: Order, basePrice: number): number {
    switch (this.config.slippageModel) {
      case 'none':
        return 0;

      case 'fixed':
        return this.config.fixedSlippage || 0;

      case 'proportional':
        return basePrice * (this.config.proportionalSlippage || 0);

      case 'orderbook':
        // Would need order book data for realistic simulation
        // Fall back to proportional
        return basePrice * (this.config.proportionalSlippage || 0.001);

      default:
        return 0;
    }
  }

  // ============================================
  // Position Management
  // ============================================

  /**
   * Update position after a fill
   */
  private updatePosition(order: Order, fill: OrderFill): void {
    const positionKey = `${order.marketId}:${order.outcome}`;
    const existing = this.positions.get(positionKey);

    if (order.side === 'BUY') {
      if (existing) {
        // Add to existing position
        const previous = { ...existing };
        const totalSize = existing.size + fill.size;
        const totalCost = existing.avgEntryPrice * existing.size + fill.price * fill.size;

        existing.avgEntryPrice = totalCost / totalSize;
        existing.size = totalSize;
        existing.lastUpdate = new Date();

        this.emit('position:updated', existing, previous);
      } else {
        // Open new position
        const position: Position = {
          marketId: order.marketId,
          outcome: order.outcome,
          size: fill.size,
          avgEntryPrice: fill.price,
          currentPrice: fill.price,
          unrealizedPnl: 0,
          realizedPnl: 0,
          openedAt: new Date(),
          lastUpdate: new Date(),
        };

        this.positions.set(positionKey, position);
        this.emit('position:opened', position);
      }
    } else {
      // SELL - reduce or close position
      if (existing) {
        const previous = { ...existing };
        const pnl = (fill.price - existing.avgEntryPrice) * fill.size;

        if (fill.size >= existing.size) {
          // Close entire position
          existing.realizedPnl += pnl;
          this.positions.delete(positionKey);
          this.emit('position:closed', existing, pnl);
        } else {
          // Reduce position
          existing.size -= fill.size;
          existing.realizedPnl += pnl;
          existing.lastUpdate = new Date();
          this.emit('position:updated', existing, previous);
        }
      }
      // Note: Short selling not supported in prediction markets
    }
  }

  /**
   * Update position with new price
   */
  private updatePositionPrice(price: LivePrice): void {
    const positionKey = `${price.marketId}:${price.outcome}`;
    const position = this.positions.get(positionKey);

    if (position) {
      const previous = { ...position };
      position.currentPrice = price.price;
      position.unrealizedPnl = (price.price - position.avgEntryPrice) * position.size;
      position.lastUpdate = new Date();

      if (Math.abs(position.unrealizedPnl - previous.unrealizedPnl) > 0.01) {
        this.emit('position:updated', position, previous);
      }
    }
  }

  /**
   * Update all positions
   */
  private updatePositions(): void {
    for (const position of this.positions.values()) {
      const price = this.feed.getPrice(position.marketId, position.outcome);
      if (price) {
        position.currentPrice = price.price;
        position.unrealizedPnl = (price.price - position.avgEntryPrice) * position.size;
        position.lastUpdate = new Date();
      }
    }
  }

  /**
   * Get a position
   */
  getPosition(marketId: string, outcome: string): Position | undefined {
    return this.positions.get(`${marketId}:${outcome}`);
  }

  /**
   * Get all positions
   */
  getAllPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  /**
   * Close a position
   */
  async closePosition(marketId: string, outcome: string): Promise<Order | null> {
    const position = this.positions.get(`${marketId}:${outcome}`);
    if (!position || position.size <= 0) {
      return null;
    }

    return this.submitOrder({
      marketId,
      outcome,
      type: 'MARKET',
      side: 'SELL',
      size: position.size,
    });
  }

  /**
   * Close all positions
   */
  async closeAllPositions(): Promise<number> {
    let closed = 0;
    for (const position of this.positions.values()) {
      const order = await this.closePosition(position.marketId, position.outcome);
      if (order && order.status === 'FILLED') {
        closed++;
      }
    }
    return closed;
  }

  // ============================================
  // Portfolio State
  // ============================================

  /**
   * Get current portfolio state
   */
  getPortfolioState(): PortfolioState {
    const positions = this.getAllPositions();
    const openOrders = this.getOpenOrders();

    const totalUnrealizedPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
    const totalRealizedPnl = positions.reduce((sum, p) => sum + p.realizedPnl, 0);
    const positionValue = positions.reduce((sum, p) => sum + p.size * p.currentPrice, 0);

    return {
      cash: this.cash,
      equity: this.cash + positionValue,
      positions,
      openOrders,
      totalUnrealizedPnl,
      totalRealizedPnl,
      marginUsed: positionValue,
      marginAvailable: this.cash,
      timestamp: new Date(),
    };
  }

  /**
   * Get current cash balance
   */
  getCash(): number {
    return this.cash;
  }

  /**
   * Get current equity
   */
  getEquity(): number {
    const positionValue = this.getAllPositions()
      .reduce((sum, p) => sum + p.size * p.currentPrice, 0);
    return this.cash + positionValue;
  }

  /**
   * Emit portfolio update event
   */
  private emitPortfolioUpdate(): void {
    this.emit('portfolio:updated', this.getPortfolioState());
  }

  // ============================================
  // Validation
  // ============================================

  /**
   * Validate an order
   */
  private validateOrder(order: Order): { valid: boolean; reason?: string } {
    // Basic validation
    if (order.size <= 0) {
      return { valid: false, reason: 'Order size must be positive' };
    }

    if (order.type === 'LIMIT' && !order.price) {
      return { valid: false, reason: 'Limit orders require a price' };
    }

    if ((order.type === 'STOP' || order.type === 'STOP_LIMIT') && !order.stopPrice) {
      return { valid: false, reason: 'Stop orders require a stop price' };
    }

    // Price validation
    if (order.price !== undefined && (order.price <= 0 || order.price >= 1)) {
      return { valid: false, reason: 'Price must be between 0 and 1 for prediction markets' };
    }

    // Margin check for buy orders
    if (order.side === 'BUY') {
      const estimatedCost = order.size * (order.price || 0.5);
      const estimatedFee = estimatedCost * this.config.feeRate;
      if (estimatedCost + estimatedFee > this.cash) {
        return { valid: false, reason: 'Insufficient funds' };
      }
    }

    // Check if we have position for sell orders
    if (order.side === 'SELL') {
      const position = this.positions.get(`${order.marketId}:${order.outcome}`);
      if (!position || position.size < order.size) {
        return { valid: false, reason: 'Insufficient position for sell order' };
      }
    }

    return { valid: true };
  }

  // ============================================
  // Helpers
  // ============================================

  /**
   * Generate unique order ID
   */
  private generateOrderId(): string {
    return `paper_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Simulate network latency
   */
  private async simulateLatency(): Promise<void> {
    if (this.config.latencyMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.config.latencyMs));
    }
  }

  /**
   * Get trade statistics
   */
  getStatistics(): {
    totalTrades: number;
    totalFees: number;
    totalPnl: number;
    winRate: number;
  } {
    const totalFees = this.fillHistory.reduce((sum, f) => sum + f.fee, 0);
    const totalPnl = this.getEquity() - this.config.initialCapital;

    // Calculate win rate from closed positions (simplified)
    const fills = this.fillHistory;
    let wins = 0;
    let losses = 0;

    // Group fills by position and calculate P&L
    // This is simplified - real implementation would track per-trade P&L
    const positionPnls = new Map<string, number>();
    for (const fill of fills) {
      const key = `${fill.marketId}:${fill.outcome}`;
      const current = positionPnls.get(key) || 0;
      const delta = fill.side === 'SELL' ? fill.price * fill.size : -fill.price * fill.size;
      positionPnls.set(key, current + delta);
    }

    for (const pnl of positionPnls.values()) {
      if (pnl > 0) wins++;
      else if (pnl < 0) losses++;
    }

    const winRate = wins + losses > 0 ? wins / (wins + losses) : 0;

    return {
      totalTrades: this.tradeCount,
      totalFees,
      totalPnl,
      winRate,
    };
  }
}

/**
 * Create a paper trading engine
 */
export function createPaperTradingEngine(
  feed: LiveDataFeed,
  config?: Partial<PaperTradingConfig>
): PaperTradingEngine {
  return new PaperTradingEngine(feed, config);
}
