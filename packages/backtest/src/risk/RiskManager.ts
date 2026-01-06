import pino from 'pino';
import type { RiskConfig, Order, PortfolioState } from '../types/index.js';
import type { IRiskManager } from '../engine/BacktestEngine.js';

interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
  adjustedSize?: number;
}

interface PortfolioCheckResult {
  halt: boolean;
  reason?: string;
  warnings: string[];
}

interface DailyStats {
  date: string;
  startingValue: number;
  pnl: number;
  trades: number;
}

/**
 * RiskManager - Enforces risk limits during backtesting
 *
 * Features:
 * - Position size limits
 * - Total exposure limits
 * - Drawdown limits
 * - Daily loss limits
 * - Stop loss / take profit enforcement
 */
export class RiskManager implements IRiskManager {
  private config: RiskConfig;
  private logger: pino.Logger;

  // Daily tracking
  private dailyStats: Map<string, DailyStats> = new Map();
  private currentDate: string = '';

  // State tracking
  private initialPortfolioValue: number = 0;
  private highWaterMark: number = 0;
  private haltTriggered: boolean = false;
  private haltReason: string = '';

  constructor(config: RiskConfig) {
    this.config = config;
    this.logger = pino({ name: 'RiskManager' });
  }

  /**
   * Check if an order is allowed
   */
  checkOrder(
    order: Order,
    portfolioState: PortfolioState
  ): RiskCheckResult {
    if (this.haltTriggered) {
      return {
        allowed: false,
        reason: `Trading halted: ${this.haltReason}`,
      };
    }

    // Check position size limit
    const positionSizeCheck = this.checkPositionSize(order, portfolioState);
    if (!positionSizeCheck.allowed) {
      return positionSizeCheck;
    }

    // Check exposure limit
    const exposureCheck = this.checkExposure(order, portfolioState);
    if (!exposureCheck.allowed) {
      return exposureCheck;
    }

    // Check max positions
    const positionsCheck = this.checkMaxPositions(order, portfolioState);
    if (!positionsCheck.allowed) {
      return positionsCheck;
    }

    // Check daily loss limit
    const dailyLossCheck = this.checkDailyLoss(portfolioState);
    if (!dailyLossCheck.allowed) {
      return dailyLossCheck;
    }

    return { allowed: true, adjustedSize: positionSizeCheck.adjustedSize };
  }

  /**
   * Check overall portfolio health
   */
  checkPortfolio(portfolioState: PortfolioState): PortfolioCheckResult {
    const warnings: string[] = [];

    // Update high water mark
    if (portfolioState.totalValue > this.highWaterMark) {
      this.highWaterMark = portfolioState.totalValue;
    }

    // Check drawdown
    const drawdown = this.highWaterMark > 0
      ? (this.highWaterMark - portfolioState.totalValue) / this.highWaterMark
      : 0;

    if (drawdown >= this.config.maxDrawdownPct / 100) {
      this.haltTriggered = true;
      this.haltReason = `Maximum drawdown of ${(this.config.maxDrawdownPct).toFixed(1)}% exceeded (current: ${(drawdown * 100).toFixed(1)}%)`;
      return {
        halt: true,
        reason: this.haltReason,
        warnings,
      };
    }

    // Warning if approaching drawdown limit
    if (drawdown >= (this.config.maxDrawdownPct / 100) * 0.8) {
      warnings.push(`Approaching max drawdown: ${(drawdown * 100).toFixed(1)}%`);
    }

    // Check daily loss
    const dailyPnL = this.getDailyPnL();
    if (dailyPnL <= -this.config.dailyLossLimit) {
      this.haltTriggered = true;
      this.haltReason = `Daily loss limit of $${this.config.dailyLossLimit} exceeded (current: $${Math.abs(dailyPnL).toFixed(2)})`;
      return {
        halt: true,
        reason: this.haltReason,
        warnings,
      };
    }

    // Warning if approaching daily limit
    if (dailyPnL <= -this.config.dailyLossLimit * 0.8) {
      warnings.push(`Approaching daily loss limit: $${Math.abs(dailyPnL).toFixed(2)}`);
    }

    // Check exposure
    const exposurePct = (portfolioState.marginUsed / portfolioState.totalValue) * 100;
    if (exposurePct >= this.config.maxExposurePct * 0.9) {
      warnings.push(`High exposure: ${exposurePct.toFixed(1)}%`);
    }

    return { halt: false, warnings };
  }

  /**
   * Check position size limit
   */
  private checkPositionSize(order: Order, portfolioState: PortfolioState): RiskCheckResult {
    const orderValue = order.size * (order.price || 0.5); // Estimate if no price
    const maxPositionValue = (portfolioState.totalValue * this.config.maxPositionSizePct) / 100;

    // Check existing position
    const existingPosition = portfolioState.positions.get(
      `${order.marketId}:${order.tokenId}`
    );
    const existingValue = existingPosition
      ? existingPosition.size * existingPosition.currentPrice
      : 0;

    const totalPositionValue = existingValue + orderValue;

    if (totalPositionValue > maxPositionValue) {
      const allowedAdditional = maxPositionValue - existingValue;
      if (allowedAdditional <= 0) {
        return {
          allowed: false,
          reason: `Position size limit reached for ${order.marketId}. Max: ${this.config.maxPositionSizePct}% of portfolio`,
        };
      }

      // Suggest adjusted size
      const adjustedSize = allowedAdditional / (order.price || 0.5);
      return {
        allowed: true,
        adjustedSize: Math.max(0, adjustedSize),
        reason: `Order size reduced to stay within position limit`,
      };
    }

    return { allowed: true };
  }

  /**
   * Check total exposure limit
   */
  private checkExposure(order: Order, portfolioState: PortfolioState): RiskCheckResult {
    const orderValue = order.size * (order.price || 0.5);
    const currentExposure = portfolioState.marginUsed;
    const maxExposure = (portfolioState.totalValue * this.config.maxExposurePct) / 100;

    if (currentExposure + orderValue > maxExposure) {
      const allowedValue = maxExposure - currentExposure;
      if (allowedValue <= 0) {
        return {
          allowed: false,
          reason: `Maximum exposure of ${this.config.maxExposurePct}% reached`,
        };
      }

      return {
        allowed: true,
        adjustedSize: allowedValue / (order.price || 0.5),
        reason: `Order size reduced to stay within exposure limit`,
      };
    }

    return { allowed: true };
  }

  /**
   * Check maximum concurrent positions
   */
  private checkMaxPositions(order: Order, portfolioState: PortfolioState): RiskCheckResult {
    const key = `${order.marketId}:${order.tokenId}`;
    const isNewPosition = !portfolioState.positions.has(key);

    if (isNewPosition && portfolioState.positions.size >= this.config.maxPositions) {
      return {
        allowed: false,
        reason: `Maximum positions (${this.config.maxPositions}) reached`,
      };
    }

    return { allowed: true };
  }

  /**
   * Check daily loss limit
   */
  private checkDailyLoss(portfolioState: PortfolioState): RiskCheckResult {
    const dailyPnL = this.getDailyPnL();

    if (dailyPnL <= -this.config.dailyLossLimit) {
      return {
        allowed: false,
        reason: `Daily loss limit of $${this.config.dailyLossLimit} exceeded`,
      };
    }

    return { allowed: true };
  }

  /**
   * Get current daily P&L
   */
  getDailyPnL(): number {
    const stats = this.dailyStats.get(this.currentDate);
    return stats?.pnl || 0;
  }

  /**
   * Update daily stats
   */
  updateDailyStats(date: Date, portfolioValue: number): void {
    const dateStr = date.toISOString().split('T')[0];

    if (dateStr !== this.currentDate) {
      // New day
      this.currentDate = dateStr;
      this.dailyStats.set(dateStr, {
        date: dateStr,
        startingValue: portfolioValue,
        pnl: 0,
        trades: 0,
      });
    } else {
      // Update P&L
      const stats = this.dailyStats.get(dateStr)!;
      stats.pnl = portfolioValue - stats.startingValue;
    }
  }

  /**
   * Record a trade for daily tracking
   */
  recordTrade(): void {
    const stats = this.dailyStats.get(this.currentDate);
    if (stats) {
      stats.trades++;
    }
  }

  /**
   * Calculate stop loss price for a position
   */
  calculateStopLoss(entryPrice: number, side: 'LONG' | 'SHORT'): number {
    const stopPct = this.config.stopLossPct / 100;

    if (side === 'LONG') {
      return entryPrice * (1 - stopPct);
    } else {
      return entryPrice * (1 + stopPct);
    }
  }

  /**
   * Calculate take profit price for a position
   */
  calculateTakeProfit(entryPrice: number, side: 'LONG' | 'SHORT'): number {
    const takePct = this.config.takeProfitPct / 100;

    if (side === 'LONG') {
      return entryPrice * (1 + takePct);
    } else {
      return entryPrice * (1 - takePct);
    }
  }

  /**
   * Check if stop loss is triggered
   */
  isStopLossTriggered(
    currentPrice: number,
    entryPrice: number,
    side: 'LONG' | 'SHORT'
  ): boolean {
    const stopPrice = this.calculateStopLoss(entryPrice, side);

    if (side === 'LONG') {
      return currentPrice <= stopPrice;
    } else {
      return currentPrice >= stopPrice;
    }
  }

  /**
   * Check if take profit is triggered
   */
  isTakeProfitTriggered(
    currentPrice: number,
    entryPrice: number,
    side: 'LONG' | 'SHORT'
  ): boolean {
    const takeProfitPrice = this.calculateTakeProfit(entryPrice, side);

    if (side === 'LONG') {
      return currentPrice >= takeProfitPrice;
    } else {
      return currentPrice <= takeProfitPrice;
    }
  }

  /**
   * Get risk metrics
   */
  getRiskMetrics(): {
    currentDrawdown: number;
    highWaterMark: number;
    dailyPnL: number;
    isHalted: boolean;
    haltReason: string;
  } {
    return {
      currentDrawdown: this.highWaterMark > 0
        ? (this.highWaterMark - this.initialPortfolioValue) / this.highWaterMark
        : 0,
      highWaterMark: this.highWaterMark,
      dailyPnL: this.getDailyPnL(),
      isHalted: this.haltTriggered,
      haltReason: this.haltReason,
    };
  }

  /**
   * Reset the risk manager
   */
  reset(): void {
    this.dailyStats.clear();
    this.currentDate = '';
    this.initialPortfolioValue = 0;
    this.highWaterMark = 0;
    this.haltTriggered = false;
    this.haltReason = '';
  }

  /**
   * Initialize with starting portfolio value
   */
  initialize(portfolioValue: number): void {
    this.initialPortfolioValue = portfolioValue;
    this.highWaterMark = portfolioValue;
  }

  /**
   * Get current configuration
   */
  getConfig(): RiskConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<RiskConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
