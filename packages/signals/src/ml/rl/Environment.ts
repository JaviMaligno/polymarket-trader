/**
 * Market Making Environment
 *
 * Simulates a market making environment for training RL agents.
 * Supports both historical replay and live market data.
 */

import type {
  RLState,
  RLAction,
  DiscreteAction,
  EnvironmentConfig,
  MarketMakerMetrics,
} from './types.js';
import { DEFAULT_ENV_CONFIG } from './types.js';

/**
 * Order book snapshot
 */
export interface OrderBookSnapshot {
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  timestamp: Date;
}

/**
 * Market tick data
 */
export interface MarketTick {
  price: number;
  volume: number;
  side: 'buy' | 'sell';
  timestamp: Date;
}

/**
 * Order placed by market maker
 */
interface Order {
  id: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
  timestamp: Date;
}

/**
 * Fill event
 */
interface Fill {
  orderId: string;
  price: number;
  size: number;
  side: 'buy' | 'sell';
  timestamp: Date;
}

/**
 * Environment step result
 */
export interface StepResult {
  state: RLState;
  reward: number;
  done: boolean;
  info: {
    pnl: number;
    position: number;
    fills: Fill[];
    metrics: Partial<MarketMakerMetrics>;
  };
}

/**
 * Market regime enum
 */
enum Regime {
  BULL_LOW_VOL = 0,
  BULL_HIGH_VOL = 1,
  BEAR_LOW_VOL = 2,
  BEAR_HIGH_VOL = 3,
  NEUTRAL = 4,
}

/**
 * Market Making Environment
 */
export class MarketMakingEnvironment {
  private config: EnvironmentConfig;
  private orderBook: OrderBookSnapshot;
  private priceHistory: number[];
  private position: number;
  private cash: number;
  /** FIXED: Track entry prices WITH their sizes for accurate PnL calculation */
  private entryPrices: Array<{ price: number; size: number }>;
  private orders: Map<string, Order>;
  private fills: Fill[];
  private stepIndex: number;
  private episodeStartCash: number;
  private historicalData: MarketTick[];
  private historicalIndex: number;
  private maxDrawdown: number;
  private peakValue: number;
  private totalTrades: number;
  private winningTrades: number;
  private spreadsEarned: number[];
  private regime: Regime;

  constructor(config: Partial<EnvironmentConfig> = {}) {
    this.config = { ...DEFAULT_ENV_CONFIG, ...config };
    this.orderBook = { bids: [], asks: [], timestamp: new Date() };
    this.priceHistory = [];
    this.position = 0;
    this.cash = 10000; // Initial cash
    this.entryPrices = [];
    this.orders = new Map();
    this.fills = [];
    this.stepIndex = 0;
    this.episodeStartCash = this.cash;
    this.historicalData = [];
    this.historicalIndex = 0;
    this.maxDrawdown = 0;
    this.peakValue = this.cash;
    this.totalTrades = 0;
    this.winningTrades = 0;
    this.spreadsEarned = [];
    this.regime = Regime.NEUTRAL;
  }

  /**
   * Load historical data for replay
   */
  loadHistoricalData(data: MarketTick[]): void {
    this.historicalData = data;
    this.historicalIndex = 0;
  }

  /**
   * Reset environment for new episode
   */
  reset(): RLState {
    this.position = 0;
    this.cash = this.episodeStartCash;
    this.entryPrices = []; // Array of { price, size }
    this.orders.clear();
    this.fills = [];
    this.stepIndex = 0;
    this.historicalIndex = 0;
    this.maxDrawdown = 0;
    this.peakValue = this.cash;
    this.totalTrades = 0;
    this.winningTrades = 0;
    this.spreadsEarned = [];

    // Initialize with first data points
    this.initializePriceHistory();
    this.updateOrderBook();

    return this.getState();
  }

  /**
   * Initialize price history
   */
  private initializePriceHistory(): void {
    this.priceHistory = [];

    if (this.historicalData.length > 0) {
      // Use historical data
      const startIdx = Math.min(
        this.config.priceHistoryLength,
        this.historicalData.length
      );
      for (let i = 0; i < startIdx; i++) {
        this.priceHistory.push(this.historicalData[i].price);
      }
      this.historicalIndex = startIdx;
    } else {
      // Generate synthetic data
      let price = 0.5; // Start at 50%
      for (let i = 0; i < this.config.priceHistoryLength; i++) {
        price += (Math.random() - 0.5) * 0.01;
        price = Math.max(0.01, Math.min(0.99, price));
        this.priceHistory.push(price);
      }
    }
  }

  /**
   * Update order book from market data
   */
  private updateOrderBook(): void {
    const midPrice = this.getCurrentPrice();
    const spread = 0.01; // 1% spread

    // Generate synthetic order book levels
    const bids: Array<{ price: number; size: number }> = [];
    const asks: Array<{ price: number; size: number }> = [];

    for (let i = 0; i < this.config.orderBookDepth; i++) {
      const bidPrice = midPrice - spread / 2 - i * this.config.tickSize;
      const askPrice = midPrice + spread / 2 + i * this.config.tickSize;

      // Size decreases with distance from mid
      const baseSize = 100 + Math.random() * 200;
      const decay = Math.exp(-i * 0.3);

      bids.push({ price: Math.max(0, bidPrice), size: baseSize * decay });
      asks.push({ price: Math.min(1, askPrice), size: baseSize * decay });
    }

    this.orderBook = { bids, asks, timestamp: new Date() };
  }

  /**
   * Get current mid price
   */
  private getCurrentPrice(): number {
    if (this.priceHistory.length === 0) return 0.5;
    return this.priceHistory[this.priceHistory.length - 1];
  }

  /**
   * Get current state
   */
  getState(): RLState {
    const midPrice = this.getCurrentPrice();
    const position = this.position;
    const maxPosition = this.config.maxPosition;

    // Normalize order book
    const orderBook: number[] = [];
    for (let i = 0; i < this.config.orderBookDepth; i++) {
      if (i < this.orderBook.bids.length) {
        orderBook.push((this.orderBook.bids[i].price - midPrice) / midPrice);
        orderBook.push(this.orderBook.bids[i].size / 1000);
      } else {
        orderBook.push(0);
        orderBook.push(0);
      }
      if (i < this.orderBook.asks.length) {
        orderBook.push((this.orderBook.asks[i].price - midPrice) / midPrice);
        orderBook.push(this.orderBook.asks[i].size / 1000);
      } else {
        orderBook.push(0);
        orderBook.push(0);
      }
    }

    // Calculate OFI
    const ofi = this.calculateOFI();

    // Calculate volatility
    const volatility = this.calculateVolatility();

    // Unrealized PnL
    const unrealizedPnL = this.calculateUnrealizedPnL() / 100; // Normalize

    // Time to resolution (simulated)
    const timeToResolution =
      1 - this.stepIndex / Math.max(this.config.episodeLength, 1);

    // One-hot encode regime
    const regimeVec = [0, 0, 0, 0, 0];
    regimeVec[this.regime] = 1;

    // Inventory risk
    const inventoryRisk = Math.abs(position / maxPosition);

    // Normalize price history
    const normalizedPrices = this.priceHistory
      .slice(-this.config.priceHistoryLength)
      .map((p) => (p - midPrice) / midPrice);

    // Pad if necessary
    while (normalizedPrices.length < this.config.priceHistoryLength) {
      normalizedPrices.unshift(0);
    }

    return {
      orderBook,
      position: position / maxPosition,
      unrealizedPnL,
      priceHistory: normalizedPrices,
      ofi,
      volatility,
      timeToResolution,
      regime: regimeVec,
      inventoryRisk,
    };
  }

  /**
   * Calculate Order Flow Imbalance
   */
  private calculateOFI(): number {
    let bidVolume = 0;
    let askVolume = 0;

    for (const bid of this.orderBook.bids) {
      bidVolume += bid.size;
    }
    for (const ask of this.orderBook.asks) {
      askVolume += ask.size;
    }

    const totalVolume = bidVolume + askVolume;
    if (totalVolume === 0) return 0;

    return (bidVolume - askVolume) / totalVolume;
  }

  /**
   * Calculate recent volatility
   */
  private calculateVolatility(): number {
    if (this.priceHistory.length < 2) return 0;

    const returns: number[] = [];
    for (let i = 1; i < this.priceHistory.length; i++) {
      const ret =
        (this.priceHistory[i] - this.priceHistory[i - 1]) /
        this.priceHistory[i - 1];
      returns.push(ret);
    }

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance =
      returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;

    return Math.sqrt(variance) * Math.sqrt(252); // Annualized
  }

  /**
   * Calculate unrealized PnL
   * FIXED: Now properly weights by position size at each entry price
   */
  private calculateUnrealizedPnL(): number {
    if (this.position === 0 || this.entryPrices.length === 0) return 0;

    const currentPrice = this.getCurrentPrice();
    let unrealized = 0;

    for (const entry of this.entryPrices) {
      if (this.position > 0) {
        // Long position: profit if price went up
        unrealized += (currentPrice - entry.price) * entry.size;
      } else {
        // Short position: profit if price went down
        unrealized += (entry.price - currentPrice) * entry.size;
      }
    }

    return unrealized;
  }

  /**
   * Convert discrete action to continuous parameters
   */
  private discreteToAction(action: number): RLAction {
    const actions: Record<number, RLAction> = {
      0: {
        bidOffset: 0,
        askOffset: 0,
        bidSize: 0,
        askSize: 0,
        cancelAll: false,
      }, // HOLD
      1: {
        bidOffset: -0.01,
        askOffset: 0.01,
        bidSize: 0.1,
        askSize: 0.1,
        cancelAll: false,
      }, // TIGHT_SMALL
      2: {
        bidOffset: -0.01,
        askOffset: 0.01,
        bidSize: 0.3,
        askSize: 0.3,
        cancelAll: false,
      }, // TIGHT_MEDIUM
      3: {
        bidOffset: -0.01,
        askOffset: 0.01,
        bidSize: 0.5,
        askSize: 0.5,
        cancelAll: false,
      }, // TIGHT_LARGE
      4: {
        bidOffset: -0.03,
        askOffset: 0.03,
        bidSize: 0.1,
        askSize: 0.1,
        cancelAll: false,
      }, // WIDE_SMALL
      5: {
        bidOffset: -0.03,
        askOffset: 0.03,
        bidSize: 0.3,
        askSize: 0.3,
        cancelAll: false,
      }, // WIDE_MEDIUM
      6: {
        bidOffset: -0.03,
        askOffset: 0.03,
        bidSize: 0.5,
        askSize: 0.5,
        cancelAll: false,
      }, // WIDE_LARGE
      7: {
        bidOffset: 0,
        askOffset: 0,
        bidSize: 0,
        askSize: 0,
        cancelAll: true,
      }, // CANCEL_ALL
      8: {
        bidOffset: -0.02,
        askOffset: 0,
        bidSize: 0.3,
        askSize: 0,
        cancelAll: false,
      }, // BUY_ONLY
      9: {
        bidOffset: 0,
        askOffset: 0.02,
        bidSize: 0,
        askSize: 0.3,
        cancelAll: false,
      }, // SELL_ONLY
    };

    return actions[action] || actions[0];
  }

  /**
   * Execute a step in the environment
   */
  step(action: number | RLAction): StepResult {
    const rlAction =
      typeof action === 'number' ? this.discreteToAction(action) : action;

    // Cancel all orders if requested
    if (rlAction.cancelAll) {
      this.orders.clear();
    }

    const fills: Fill[] = [];
    const midPrice = this.getCurrentPrice();

    // Place new orders
    if (rlAction.bidSize > 0 && !rlAction.cancelAll) {
      const bidPrice = midPrice * (1 + rlAction.bidOffset);
      const bidSize = rlAction.bidSize * this.config.maxPosition;

      // Check if we can add to position
      if (this.position + bidSize <= this.config.maxPosition) {
        const order: Order = {
          id: `bid_${Date.now()}_${Math.random()}`,
          side: 'buy',
          price: bidPrice,
          size: bidSize,
          timestamp: new Date(),
        };
        this.orders.set(order.id, order);
      }
    }

    if (rlAction.askSize > 0 && !rlAction.cancelAll) {
      const askPrice = midPrice * (1 + rlAction.askOffset);
      const askSize = rlAction.askSize * this.config.maxPosition;

      // Check if we can reduce position
      if (this.position - askSize >= -this.config.maxPosition) {
        const order: Order = {
          id: `ask_${Date.now()}_${Math.random()}`,
          side: 'sell',
          price: askPrice,
          size: askSize,
          timestamp: new Date(),
        };
        this.orders.set(order.id, order);
      }
    }

    // Simulate market movement and fills
    this.simulateMarket(fills);

    // Update state
    this.stepIndex++;

    // Calculate reward
    const reward = this.calculateReward(fills);

    // Check if done
    const done = this.stepIndex >= this.config.episodeLength;

    // Update metrics
    this.updateMetrics(fills);

    return {
      state: this.getState(),
      reward,
      done,
      info: {
        pnl: this.getTotalPnL(),
        position: this.position,
        fills,
        metrics: this.getMetrics(),
      },
    };
  }

  /**
   * Simulate market movement and fill orders
   */
  private simulateMarket(fills: Fill[]): void {
    // Get next price
    let nextPrice: number;

    if (
      this.historicalData.length > 0 &&
      this.historicalIndex < this.historicalData.length
    ) {
      nextPrice = this.historicalData[this.historicalIndex].price;
      this.historicalIndex++;
    } else {
      // Generate random price movement
      const currentPrice = this.getCurrentPrice();
      const vol = this.calculateVolatility() / Math.sqrt(252); // Daily vol
      const drift = 0;
      const shock = (Math.random() - 0.5) * 2 * vol;
      nextPrice = currentPrice * (1 + drift + shock);
      nextPrice = Math.max(0.01, Math.min(0.99, nextPrice));
    }

    // Update price history
    this.priceHistory.push(nextPrice);
    if (this.priceHistory.length > this.config.priceHistoryLength * 2) {
      this.priceHistory = this.priceHistory.slice(-this.config.priceHistoryLength);
    }

    // Update order book
    this.updateOrderBook();

    // Check for order fills
    const ordersToRemove: string[] = [];

    for (const [id, order] of this.orders) {
      let filled = false;

      if (order.side === 'buy' && nextPrice <= order.price) {
        // Buy order filled
        filled = true;
        this.position += order.size;
        this.cash -= order.size * order.price * (1 + this.config.makerFee);
        // FIXED: Store entry price WITH its size
        this.entryPrices.push({ price: order.price, size: order.size });

        fills.push({
          orderId: id,
          price: order.price,
          size: order.size,
          side: 'buy',
          timestamp: new Date(),
        });
      } else if (order.side === 'sell' && nextPrice >= order.price) {
        // Sell order filled
        filled = true;
        this.position -= order.size;
        this.cash += order.size * order.price * (1 - this.config.makerFee);

        // Calculate P&L for this trade using FIFO
        // FIXED: Now properly handles size-weighted entry prices
        let remainingSize = order.size;
        let totalTradePnL = 0;

        while (remainingSize > 0 && this.entryPrices.length > 0) {
          const entry = this.entryPrices[0];
          const sizeToClose = Math.min(remainingSize, entry.size);
          const tradePnL = (order.price - entry.price) * sizeToClose;
          totalTradePnL += tradePnL;

          if (sizeToClose >= entry.size) {
            // Fully close this entry
            this.entryPrices.shift();
          } else {
            // Partially close this entry
            entry.size -= sizeToClose;
          }
          remainingSize -= sizeToClose;
        }

        if (totalTradePnL > 0) {
          this.winningTrades++;
        }
        this.spreadsEarned.push(totalTradePnL / order.size); // Per-unit PnL

        fills.push({
          orderId: id,
          price: order.price,
          size: order.size,
          side: 'sell',
          timestamp: new Date(),
        });
      }

      if (filled) {
        ordersToRemove.push(id);
        this.totalTrades++;
      }
    }

    // Remove filled orders
    for (const id of ordersToRemove) {
      this.orders.delete(id);
    }

    // Update regime
    this.updateRegime();
  }

  /**
   * Update market regime
   */
  private updateRegime(): void {
    const vol = this.calculateVolatility();
    const returns = this.priceHistory.length >= 2
      ? (this.priceHistory[this.priceHistory.length - 1] -
          this.priceHistory[this.priceHistory.length - 2]) /
        this.priceHistory[this.priceHistory.length - 2]
      : 0;

    const highVol = vol > 0.2;
    const bullish = returns > 0.01;
    const bearish = returns < -0.01;

    if (bullish && !highVol) {
      this.regime = Regime.BULL_LOW_VOL;
    } else if (bullish && highVol) {
      this.regime = Regime.BULL_HIGH_VOL;
    } else if (bearish && !highVol) {
      this.regime = Regime.BEAR_LOW_VOL;
    } else if (bearish && highVol) {
      this.regime = Regime.BEAR_HIGH_VOL;
    } else {
      this.regime = Regime.NEUTRAL;
    }
  }

  /**
   * Calculate reward
   */
  private calculateReward(fills: Fill[]): number {
    // Components of reward
    let reward = 0;

    // 1. Realized PnL from fills
    for (const fill of fills) {
      if (fill.side === 'sell' && this.spreadsEarned.length > 0) {
        reward += this.spreadsEarned[this.spreadsEarned.length - 1];
      }
    }

    // 2. Unrealized PnL change (scaled)
    const unrealizedPnL = this.calculateUnrealizedPnL();
    reward += unrealizedPnL * 0.1;

    // 3. Inventory penalty
    const inventoryPenalty =
      this.config.inventoryPenalty *
      Math.pow(this.position / this.config.maxPosition, 2);
    reward -= inventoryPenalty;

    // 4. Risk penalty
    const riskPenalty =
      this.config.riskAversion * this.calculateVolatility() * Math.abs(this.position);
    reward -= riskPenalty;

    // Scale reward
    return reward * this.config.rewardScale;
  }

  /**
   * Update performance metrics
   */
  private updateMetrics(fills: Fill[]): void {
    const portfolioValue = this.getPortfolioValue();

    // Update peak and drawdown
    if (portfolioValue > this.peakValue) {
      this.peakValue = portfolioValue;
    }
    const drawdown = (this.peakValue - portfolioValue) / this.peakValue;
    if (drawdown > this.maxDrawdown) {
      this.maxDrawdown = drawdown;
    }
  }

  /**
   * Get portfolio value
   */
  getPortfolioValue(): number {
    return this.cash + this.position * this.getCurrentPrice();
  }

  /**
   * Get total PnL
   */
  getTotalPnL(): number {
    return this.getPortfolioValue() - this.episodeStartCash;
  }

  /**
   * Get performance metrics
   */
  getMetrics(): Partial<MarketMakerMetrics> {
    const totalPnL = this.getTotalPnL();
    const avgSpread =
      this.spreadsEarned.length > 0
        ? this.spreadsEarned.reduce((a, b) => a + b, 0) / this.spreadsEarned.length
        : 0;

    // Calculate Sharpe (simplified)
    const returns = this.spreadsEarned;
    let sharpeRatio = 0;
    if (returns.length > 1) {
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance =
        returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
      const std = Math.sqrt(variance);
      sharpeRatio = std > 0 ? (mean / std) * Math.sqrt(252) : 0;
    }

    return {
      totalPnL,
      numTrades: this.totalTrades,
      avgSpread,
      maxDrawdown: this.maxDrawdown,
      sharpeRatio,
      winRate: this.totalTrades > 0 ? this.winningTrades / this.totalTrades : 0,
      avgPosition: this.position,
      timeInMarket:
        this.stepIndex > 0 ? this.totalTrades / this.stepIndex : 0,
    };
  }

  /**
   * Set initial cash
   */
  setInitialCash(cash: number): void {
    this.cash = cash;
    this.episodeStartCash = cash;
  }

  /**
   * Get config
   */
  getConfig(): EnvironmentConfig {
    return { ...this.config };
  }
}
