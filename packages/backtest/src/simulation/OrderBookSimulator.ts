import pino from 'pino';
import type {
  PriceUpdateEvent,
  TradeEvent,
  Order,
  OrderFill,
  OrderEvent,
  OrderSide,
} from '../types/index.js';
import type { IOrderBookSimulator } from '../engine/BacktestEngine.js';
import { SlippageModel, type SlippageResult } from './SlippageModel.js';

interface OrderLevel {
  price: number;
  size: number;
  orders: number;
}

interface SimulatedOrderBook {
  marketId: string;
  tokenId: string;
  bids: OrderLevel[];
  asks: OrderLevel[];
  lastUpdate: Date;
  lastPrice: number;
  volume24h: number;
}

interface OrderBookSimulatorConfig {
  /** Number of price levels to simulate */
  depthLevels: number;
  /** Base spread as percentage */
  baseSpreadPct: number;
  /** Size decay per level */
  sizeDecay: number;
  /** Minimum size at any level */
  minLevelSize: number;
  /** How much volume affects spread */
  volumeSpreadImpact: number;
}

/**
 * OrderBookSimulator - Simulates order book dynamics for backtesting
 *
 * Features:
 * - Synthetic order book generation from price data
 * - Order matching simulation
 * - Slippage calculation based on order size
 * - Fill simulation with realistic partial fills
 */
export class OrderBookSimulator implements IOrderBookSimulator {
  private config: OrderBookSimulatorConfig;
  private orderBooks: Map<string, SimulatedOrderBook> = new Map();
  private slippageModel: SlippageModel;
  private logger: pino.Logger;

  // Pending orders
  private pendingOrders: Map<string, Order> = new Map();

  constructor(
    slippageModel: SlippageModel,
    config?: Partial<OrderBookSimulatorConfig>
  ) {
    this.config = {
      depthLevels: 10,
      baseSpreadPct: 0.5,
      sizeDecay: 0.8,
      minLevelSize: 100,
      volumeSpreadImpact: 0.1,
      ...config,
    };
    this.slippageModel = slippageModel;
    this.logger = pino({ name: 'OrderBookSimulator' });
  }

  /**
   * Handle price update - rebuild order book around new price
   */
  handlePriceUpdate(event: PriceUpdateEvent): void {
    const key = this.getKey(event.data.marketId, event.data.tokenId);

    const existingBook = this.orderBooks.get(key);
    const volume24h = existingBook?.volume24h || 10000;

    // Build synthetic order book around current price
    const orderBook = this.buildOrderBook(
      event.data.marketId,
      event.data.tokenId,
      event.data.price,
      event.data.bid,
      event.data.ask,
      volume24h,
      event.timestamp
    );

    this.orderBooks.set(key, orderBook);

    // Check if any pending orders can be filled
    this.checkPendingOrders(event.data.marketId, event.data.tokenId);
  }

  /**
   * Handle trade event - update volume tracking
   */
  handleTrade(event: TradeEvent): void {
    const key = this.getKey(event.data.marketId, event.data.tokenId);
    const book = this.orderBooks.get(key);

    if (book) {
      book.volume24h += event.data.size * event.data.price;
      book.lastPrice = event.data.price;
    }
  }

  /**
   * Submit an order for execution
   */
  submitOrder(order: Order): OrderEvent | null {
    const key = this.getKey(order.marketId, order.tokenId);
    const book = this.orderBooks.get(key);

    if (!book) {
      this.logger.warn({ order }, 'No order book for market');
      return null;
    }

    if (order.type === 'MARKET') {
      return this.executeMarketOrder(order, book);
    } else {
      return this.executeLimitOrder(order, book);
    }
  }

  /**
   * Execute a market order
   */
  private executeMarketOrder(order: Order, book: SimulatedOrderBook): OrderEvent {
    const levels = order.side === 'BUY' ? book.asks : book.bids;

    if (levels.length === 0) {
      // No liquidity
      return {
        type: 'ORDER_CANCELLED',
        timestamp: new Date(),
        data: { ...order, status: 'CANCELLED' },
      };
    }

    // Calculate slippage and fills
    const slippage = this.slippageModel.calculateSlippage(
      order.size,
      order.side,
      levels,
      book.volume24h
    );

    const fills = this.generateFills(order, slippage, levels);
    const filledSize = fills.reduce((sum, f) => sum + f.size, 0);
    const avgFillPrice = fills.length > 0
      ? fills.reduce((sum, f) => sum + f.price * f.size, 0) / filledSize
      : 0;

    const filledOrder: Order = {
      ...order,
      status: filledSize >= order.size ? 'FILLED' : 'PARTIALLY_FILLED',
      filledSize,
      avgFillPrice,
      fills,
      updatedAt: new Date(),
    };

    return {
      type: 'ORDER_FILLED',
      timestamp: new Date(),
      data: filledOrder,
    };
  }

  /**
   * Execute a limit order
   */
  private executeLimitOrder(order: Order, book: SimulatedOrderBook): OrderEvent {
    if (!order.price) {
      return {
        type: 'ORDER_CANCELLED',
        timestamp: new Date(),
        data: { ...order, status: 'CANCELLED' },
      };
    }

    const levels = order.side === 'BUY' ? book.asks : book.bids;

    // Check if limit can be filled immediately
    const canFill = order.side === 'BUY'
      ? levels.length > 0 && levels[0].price <= order.price
      : levels.length > 0 && levels[0].price >= order.price;

    if (canFill) {
      // Execute like a market order but with price limit
      const slippage = this.slippageModel.calculateSlippage(
        order.size,
        order.side,
        levels.filter(l => order.side === 'BUY' ? l.price <= order.price! : l.price >= order.price!),
        book.volume24h
      );

      const fills = this.generateFills(order, slippage, levels);
      const filledSize = fills.reduce((sum, f) => sum + f.size, 0);
      const avgFillPrice = fills.length > 0
        ? fills.reduce((sum, f) => sum + f.price * f.size, 0) / filledSize
        : 0;

      const filledOrder: Order = {
        ...order,
        status: filledSize >= order.size ? 'FILLED' : 'PARTIALLY_FILLED',
        filledSize,
        avgFillPrice,
        fills,
        updatedAt: new Date(),
      };

      if (filledSize < order.size) {
        // Partial fill - rest goes to pending
        const remainingOrder: Order = {
          ...order,
          id: order.id + '_remainder',
          size: order.size - filledSize,
          status: 'OPEN',
        };
        this.pendingOrders.set(remainingOrder.id, remainingOrder);
      }

      return {
        type: 'ORDER_FILLED',
        timestamp: new Date(),
        data: filledOrder,
      };
    } else {
      // Add to pending orders
      const pendingOrder: Order = {
        ...order,
        status: 'OPEN',
      };
      this.pendingOrders.set(order.id, pendingOrder);

      return {
        type: 'ORDER_PLACED',
        timestamp: new Date(),
        data: pendingOrder,
      };
    }
  }

  /**
   * Generate fills from slippage result
   */
  private generateFills(
    order: Order,
    slippage: SlippageResult,
    levels: OrderLevel[]
  ): OrderFill[] {
    const fills: OrderFill[] = [];
    let remainingSize = order.size;
    let levelIdx = 0;

    // Distribute fills across levels
    while (remainingSize > 0 && levelIdx < levels.length) {
      const level = levels[levelIdx];
      const fillSize = Math.min(remainingSize, level.size);

      if (fillSize > 0) {
        fills.push({
          price: level.price,
          size: fillSize,
          fee: fillSize * level.price * 0.001, // 0.1% fee
          timestamp: new Date(),
        });
        remainingSize -= fillSize;
      }

      levelIdx++;
    }

    return fills;
  }

  /**
   * Check pending orders for possible fills
   */
  private checkPendingOrders(marketId: string, tokenId: string): void {
    const key = this.getKey(marketId, tokenId);
    const book = this.orderBooks.get(key);
    if (!book) return;

    for (const [orderId, order] of this.pendingOrders) {
      if (order.marketId !== marketId || order.tokenId !== tokenId) continue;
      if (!order.price) continue;

      const levels = order.side === 'BUY' ? book.asks : book.bids;
      const canFill = order.side === 'BUY'
        ? levels.length > 0 && levels[0].price <= order.price
        : levels.length > 0 && levels[0].price >= order.price;

      if (canFill) {
        // Remove from pending and mark for fill
        this.pendingOrders.delete(orderId);
        // In a real implementation, we'd emit an event here
      }
    }
  }

  /**
   * Get best bid price
   */
  getBestBid(marketId: string, tokenId: string): number | null {
    const book = this.orderBooks.get(this.getKey(marketId, tokenId));
    return book?.bids[0]?.price || null;
  }

  /**
   * Get best ask price
   */
  getBestAsk(marketId: string, tokenId: string): number | null {
    const book = this.orderBooks.get(this.getKey(marketId, tokenId));
    return book?.asks[0]?.price || null;
  }

  /**
   * Build synthetic order book around a price
   */
  private buildOrderBook(
    marketId: string,
    tokenId: string,
    midPrice: number,
    bid?: number,
    ask?: number,
    volume24h: number = 10000,
    timestamp: Date = new Date()
  ): SimulatedOrderBook {
    // Calculate spread based on volume (lower volume = wider spread)
    const volumeMultiplier = Math.max(0.5, Math.min(2, 10000 / Math.max(1, volume24h)));
    const spreadPct = (this.config.baseSpreadPct / 100) * volumeMultiplier;

    const bestBid = bid || midPrice * (1 - spreadPct / 2);
    const bestAsk = ask || midPrice * (1 + spreadPct / 2);

    // Generate bid levels
    const bids: OrderLevel[] = [];
    let bidPrice = bestBid;
    let bidSize = 1000 * (1 / volumeMultiplier); // More size with more volume

    for (let i = 0; i < this.config.depthLevels; i++) {
      bids.push({
        price: Math.max(0.001, bidPrice),
        size: Math.max(this.config.minLevelSize, bidSize),
        orders: Math.floor(1 + Math.random() * 5),
      });
      bidPrice *= (1 - spreadPct / this.config.depthLevels);
      bidSize *= this.config.sizeDecay;
    }

    // Generate ask levels
    const asks: OrderLevel[] = [];
    let askPrice = bestAsk;
    let askSize = 1000 * (1 / volumeMultiplier);

    for (let i = 0; i < this.config.depthLevels; i++) {
      asks.push({
        price: Math.min(0.999, askPrice),
        size: Math.max(this.config.minLevelSize, askSize),
        orders: Math.floor(1 + Math.random() * 5),
      });
      askPrice *= (1 + spreadPct / this.config.depthLevels);
      askSize *= this.config.sizeDecay;
    }

    return {
      marketId,
      tokenId,
      bids,
      asks,
      lastUpdate: timestamp,
      lastPrice: midPrice,
      volume24h,
    };
  }

  /**
   * Get order book key
   */
  private getKey(marketId: string, tokenId: string): string {
    return `${marketId}:${tokenId}`;
  }

  /**
   * Get current order book
   */
  getOrderBook(marketId: string, tokenId: string): SimulatedOrderBook | null {
    return this.orderBooks.get(this.getKey(marketId, tokenId)) || null;
  }

  /**
   * Reset the simulator
   */
  reset(): void {
    this.orderBooks.clear();
    this.pendingOrders.clear();
  }
}
