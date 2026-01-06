import type { SlippageConfig, OrderSide } from '../types/index.js';

interface OrderLevel {
  price: number;
  size: number;
}

export interface SlippageResult {
  /** Expected execution price */
  executionPrice: number;
  /** Slippage amount in absolute terms */
  slippageAmount: number;
  /** Slippage as percentage */
  slippagePct: number;
  /** Market impact cost */
  marketImpact: number;
  /** Whether full order can be filled */
  canFill: boolean;
  /** Maximum fillable size */
  maxFillableSize: number;
}

/**
 * SlippageModel - Models execution slippage for backtesting
 *
 * Supports multiple slippage models:
 * 1. Fixed - Constant slippage regardless of size
 * 2. Proportional - Slippage proportional to order size
 * 3. Order book - Realistic slippage based on order book depth
 */
export class SlippageModel {
  private config: SlippageConfig;

  constructor(config: SlippageConfig) {
    this.config = config;
  }

  /**
   * Calculate slippage for an order
   */
  calculateSlippage(
    orderSize: number,
    side: OrderSide,
    orderBook: OrderLevel[],
    dailyVolume: number = 100000
  ): SlippageResult {
    switch (this.config.model) {
      case 'fixed':
        return this.calculateFixedSlippage(orderSize, side, orderBook);
      case 'proportional':
        return this.calculateProportionalSlippage(orderSize, side, orderBook, dailyVolume);
      case 'orderbook':
        return this.calculateOrderBookSlippage(orderSize, side, orderBook);
      default:
        return this.calculateFixedSlippage(orderSize, side, orderBook);
    }
  }

  /**
   * Fixed slippage model
   * Simple constant slippage regardless of order size
   */
  private calculateFixedSlippage(
    orderSize: number,
    side: OrderSide,
    orderBook: OrderLevel[]
  ): SlippageResult {
    const fixedSlippage = this.config.fixedSlippage || 0.001; // 0.1% default

    if (orderBook.length === 0) {
      return this.noLiquidityResult();
    }

    const bestPrice = orderBook[0].price;
    const slippageDirection = side === 'BUY' ? 1 : -1;
    const executionPrice = bestPrice * (1 + slippageDirection * fixedSlippage);

    return {
      executionPrice,
      slippageAmount: Math.abs(executionPrice - bestPrice),
      slippagePct: fixedSlippage * 100,
      marketImpact: fixedSlippage * orderSize * bestPrice,
      canFill: true,
      maxFillableSize: orderSize,
    };
  }

  /**
   * Proportional slippage model
   * Slippage increases with order size relative to daily volume
   */
  private calculateProportionalSlippage(
    orderSize: number,
    side: OrderSide,
    orderBook: OrderLevel[],
    dailyVolume: number
  ): SlippageResult {
    if (orderBook.length === 0) {
      return this.noLiquidityResult();
    }

    const bestPrice = orderBook[0].price;
    const baseRate = this.config.proportionalRate || 0.001;

    // Slippage increases with order size / daily volume
    const volumeRatio = (orderSize * bestPrice) / Math.max(1, dailyVolume);
    const slippagePct = baseRate + (volumeRatio * 0.1); // 10% additional per 100% of daily volume

    const slippageDirection = side === 'BUY' ? 1 : -1;
    const executionPrice = bestPrice * (1 + slippageDirection * slippagePct);

    return {
      executionPrice,
      slippageAmount: Math.abs(executionPrice - bestPrice),
      slippagePct: slippagePct * 100,
      marketImpact: slippagePct * orderSize * bestPrice,
      canFill: true,
      maxFillableSize: orderSize,
    };
  }

  /**
   * Order book slippage model
   * Realistic slippage based on walking the order book
   */
  private calculateOrderBookSlippage(
    orderSize: number,
    side: OrderSide,
    orderBook: OrderLevel[]
  ): SlippageResult {
    if (orderBook.length === 0) {
      return this.noLiquidityResult();
    }

    const impactFactor = this.config.impactFactor || 1.0;
    let remainingSize = orderSize;
    let totalCost = 0;
    let totalFilled = 0;

    // Walk through the order book
    for (const level of orderBook) {
      if (remainingSize <= 0) break;

      const fillSize = Math.min(remainingSize, level.size);
      totalCost += fillSize * level.price;
      totalFilled += fillSize;
      remainingSize -= fillSize;
    }

    if (totalFilled === 0) {
      return this.noLiquidityResult();
    }

    const avgPrice = totalCost / totalFilled;
    const bestPrice = orderBook[0].price;

    // Apply impact factor for additional market impact
    const slippageFromBook = Math.abs(avgPrice - bestPrice) / bestPrice;
    const additionalImpact = slippageFromBook * (impactFactor - 1);
    const totalSlippage = slippageFromBook + additionalImpact;

    const slippageDirection = side === 'BUY' ? 1 : -1;
    const executionPrice = bestPrice * (1 + slippageDirection * totalSlippage);

    return {
      executionPrice,
      slippageAmount: Math.abs(executionPrice - bestPrice),
      slippagePct: totalSlippage * 100,
      marketImpact: totalSlippage * totalFilled * bestPrice,
      canFill: remainingSize === 0,
      maxFillableSize: totalFilled,
    };
  }

  /**
   * Result when no liquidity available
   */
  private noLiquidityResult(): SlippageResult {
    return {
      executionPrice: 0,
      slippageAmount: 0,
      slippagePct: 100,
      marketImpact: 0,
      canFill: false,
      maxFillableSize: 0,
    };
  }

  /**
   * Estimate market impact for a given order size
   * Useful for order sizing decisions
   */
  estimateMarketImpact(
    orderSize: number,
    currentPrice: number,
    dailyVolume: number
  ): number {
    const volumeRatio = (orderSize * currentPrice) / Math.max(1, dailyVolume);

    // Kyle's lambda approximation: impact ≈ lambda * sqrt(volume_ratio)
    const lambda = this.config.impactFactor || 0.1;
    const impact = lambda * Math.sqrt(volumeRatio);

    return impact * orderSize * currentPrice;
  }

  /**
   * Calculate optimal order size given maximum acceptable slippage
   */
  calculateOptimalSize(
    maxSlippagePct: number,
    currentPrice: number,
    dailyVolume: number,
    orderBook: OrderLevel[]
  ): number {
    if (orderBook.length === 0) return 0;

    const maxSlippage = maxSlippagePct / 100;

    switch (this.config.model) {
      case 'fixed': {
        // Fixed slippage - any size is fine if under max
        const fixedSlippage = this.config.fixedSlippage || 0.001;
        if (fixedSlippage <= maxSlippage) {
          return orderBook.reduce((sum, l) => sum + l.size, 0);
        }
        return 0;
      }

      case 'proportional': {
        // Solve: baseRate + (size * price / dailyVolume) * 0.1 = maxSlippage
        const baseRate = this.config.proportionalRate || 0.001;
        if (baseRate >= maxSlippage) return 0;

        const remainingSlippage = maxSlippage - baseRate;
        const maxVolume = (remainingSlippage / 0.1) * dailyVolume;
        return maxVolume / currentPrice;
      }

      case 'orderbook': {
        // Walk order book until slippage exceeds max
        let totalSize = 0;
        let totalCost = 0;
        const bestPrice = orderBook[0].price;

        for (const level of orderBook) {
          const newTotalSize = totalSize + level.size;
          const newTotalCost = totalCost + level.size * level.price;
          const avgPrice = newTotalCost / newTotalSize;
          const slippage = Math.abs(avgPrice - bestPrice) / bestPrice;

          if (slippage > maxSlippage) {
            // Binary search within this level
            let low = 0;
            let high = level.size;

            while (high - low > 0.01) {
              const mid = (low + high) / 2;
              const testTotalSize = totalSize + mid;
              const testTotalCost = totalCost + mid * level.price;
              const testAvgPrice = testTotalCost / testTotalSize;
              const testSlippage = Math.abs(testAvgPrice - bestPrice) / bestPrice;

              if (testSlippage <= maxSlippage) {
                low = mid;
              } else {
                high = mid;
              }
            }

            return totalSize + low;
          }

          totalSize = newTotalSize;
          totalCost = newTotalCost;
        }

        return totalSize;
      }

      default:
        return 0;
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): SlippageConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<SlippageConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
