import pino from 'pino';
import type { Order, PortfolioState } from '../types/index.js';
import type { IRiskManager } from '../engine/BacktestEngine.js';
import {
  type RiskConfig,
  getDefaultRiskProfile,
  calculateAdaptiveMultiplier,
  calculateVolatilityAdjustedSL,
  calculateVolatilityAdjustedTP,
} from '../types/RiskProfiles.js';

interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
  adjustedSize?: number;
  adaptiveMultiplier?: number;
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

interface PositionTrailing {
  marketId: string;
  tokenId: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  highestPrice: number;  // For longs
  lowestPrice: number;   // For shorts
  currentStopLoss: number;
  currentTakeProfit: number;
  baseStopLoss: number;
  baseTakeProfit: number;
}

/**
 * Enhanced RiskManager - Comprehensive risk management for backtesting
 *
 * Features:
 * - Unified risk profile configuration (AGGRESSIVE by default)
 * - Fixed drawdown calculation bug
 * - Daily loss as % of portfolio (scalable)
 * - Correlation risk controls
 * - Adaptive risk management (gradual reduction, not binary halt)
 * - Trailing stops
 * - Volatility-adjusted SL/TP
 * - Position-level risk tracking
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
  private currentPortfolioValue: number = 0;
  private haltTriggered: boolean = false;
  private haltReason: string = '';
  private adaptiveMultiplier: number = 1.0;

  // Trailing stops tracking
  private trailingStops: Map<string, PositionTrailing> = new Map();

  // Volatility tracking for adaptive SL/TP
  private priceHistory: Map<string, number[]> = new Map();
  private readonly VOLATILITY_WINDOW = 20;

  // Correlation tracking
  private categoryExposure: Map<string, number> = new Map();
  private positionReturns: Map<string, number[]> = new Map();

  constructor(config?: Partial<RiskConfig>) {
    // Use AGGRESSIVE profile as default (as per requirements)
    this.config = config
      ? { ...getDefaultRiskProfile(), ...config }
      : getDefaultRiskProfile();

    this.logger = pino({ name: 'RiskManager' });
    this.logger.info({ profile: this.config.profileType }, 'RiskManager initialized with profile');
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
        adaptiveMultiplier: 0,
      };
    }

    // Calculate adaptive multiplier based on current drawdown
    const currentDrawdown = this.calculateCurrentDrawdown(portfolioState.totalValue);
    this.adaptiveMultiplier = calculateAdaptiveMultiplier(currentDrawdown, this.config);

    if (this.adaptiveMultiplier === 0) {
      return {
        allowed: false,
        reason: `Adaptive risk management: drawdown ${currentDrawdown.toFixed(1)}% triggered halt`,
        adaptiveMultiplier: 0,
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

    // Check correlation limits (if enabled)
    if (this.config.enableCorrelationChecks) {
      const correlationCheck = this.checkCorrelationLimit(order, portfolioState);
      if (!correlationCheck.allowed) {
        return correlationCheck;
      }
    }

    return {
      allowed: true,
      adjustedSize: positionSizeCheck.adjustedSize,
      adaptiveMultiplier: this.adaptiveMultiplier,
    };
  }

  /**
   * Check overall portfolio health
   * FIXED: Drawdown calculation now uses currentValue, not initialValue
   */
  checkPortfolio(portfolioState: PortfolioState): PortfolioCheckResult {
    const warnings: string[] = [];

    this.currentPortfolioValue = portfolioState.totalValue;

    // Update high water mark
    if (portfolioState.totalValue > this.highWaterMark) {
      this.highWaterMark = portfolioState.totalValue;
    }

    // FIXED: Correct drawdown calculation
    const drawdown = this.calculateCurrentDrawdown(portfolioState.totalValue);

    // Check halt drawdown (hard stop)
    if (drawdown >= this.config.haltDrawdownPct) {
      this.haltTriggered = true;
      this.haltReason = `Hard halt: drawdown ${drawdown.toFixed(1)}% exceeded ${this.config.haltDrawdownPct}%`;
      return {
        halt: true,
        reason: this.haltReason,
        warnings,
      };
    }

    // Check max drawdown (adaptive reduction trigger)
    if (drawdown >= this.config.maxDrawdownPct) {
      const multiplier = calculateAdaptiveMultiplier(drawdown, this.config);

      if (this.config.adaptiveMode === 'NONE') {
        // Binary mode: halt immediately
        this.haltTriggered = true;
        this.haltReason = `Maximum drawdown ${drawdown.toFixed(1)}% exceeded limit ${this.config.maxDrawdownPct}%`;
        return {
          halt: true,
          reason: this.haltReason,
          warnings,
        };
      } else {
        // Adaptive mode: reduce size
        warnings.push(
          `Adaptive risk: drawdown ${drawdown.toFixed(1)}% - position size reduced to ${(multiplier * 100).toFixed(0)}%`
        );
      }
    }

    // Warning if approaching drawdown limit
    if (drawdown >= this.config.warningDrawdownPct) {
      warnings.push(`Approaching max drawdown: ${drawdown.toFixed(1)}%`);
    }

    // Check daily loss (FIXED: now uses percentage, not USD)
    const dailyLossPct = this.getDailyLossPct();
    if (dailyLossPct >= this.config.maxDailyLossPct) {
      const multiplier = calculateAdaptiveMultiplier(drawdown, this.config);

      if (this.config.adaptiveMode === 'NONE') {
        this.haltTriggered = true;
        this.haltReason = `Daily loss ${dailyLossPct.toFixed(2)}% exceeded limit ${this.config.maxDailyLossPct}%`;
        return {
          halt: true,
          reason: this.haltReason,
          warnings,
        };
      } else {
        warnings.push(
          `Daily loss ${dailyLossPct.toFixed(2)}% exceeded - position size reduced`
        );
      }
    }

    // Warning if approaching daily limit
    if (dailyLossPct >= this.config.warningDailyLossPct) {
      warnings.push(`Approaching daily loss limit: ${dailyLossPct.toFixed(2)}%`);
    }

    // Check exposure
    const exposurePct = (portfolioState.marginUsed / portfolioState.totalValue) * 100;
    if (exposurePct >= this.config.maxExposurePct * 0.9) {
      warnings.push(`High exposure: ${exposurePct.toFixed(1)}%`);
    }

    return { halt: false, warnings };
  }

  /**
   * Check position size limit (with adaptive multiplier)
   */
  private checkPositionSize(order: Order, portfolioState: PortfolioState): RiskCheckResult {
    const orderValue = order.size * (order.price || 0.5);

    // Apply adaptive multiplier to max position size
    const effectiveMaxPct = this.config.maxPositionSizePct * this.adaptiveMultiplier;
    const maxPositionValue = (portfolioState.totalValue * effectiveMaxPct) / 100;

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
          reason: `Position size limit reached: max ${effectiveMaxPct.toFixed(1)}% (adaptive: ${(this.adaptiveMultiplier * 100).toFixed(0)}%)`,
        };
      }

      // Suggest adjusted size
      const adjustedSize = allowedAdditional / (order.price || 0.5);
      return {
        allowed: true,
        adjustedSize: Math.max(0, adjustedSize),
        reason: `Order size reduced to stay within position limit (adaptive)`,
        adaptiveMultiplier: this.adaptiveMultiplier,
      };
    }

    return {
      allowed: true,
      adaptiveMultiplier: this.adaptiveMultiplier,
    };
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
   * Check daily loss limit (FIXED: now percentage-based, scalable)
   */
  private checkDailyLoss(portfolioState: PortfolioState): RiskCheckResult {
    const dailyLossPct = this.getDailyLossPct();

    if (dailyLossPct >= this.config.maxDailyLossPct) {
      return {
        allowed: false,
        reason: `Daily loss ${dailyLossPct.toFixed(2)}% exceeded limit ${this.config.maxDailyLossPct}%`,
      };
    }

    return { allowed: true };
  }

  /**
   * Check correlation limit (NEW: correlation risk control)
   */
  private checkCorrelationLimit(order: Order, portfolioState: PortfolioState): RiskCheckResult {
    // Check category concentration
    const category = this.getMarketCategory(order.marketId);
    const orderValue = order.size * (order.price || 0.5);
    const currentCategoryExposure = this.categoryExposure.get(category) || 0;
    const totalValue = portfolioState.totalValue;

    const newCategoryExposure = currentCategoryExposure + orderValue;
    const categoryPct = (newCategoryExposure / totalValue) * 100;

    if (categoryPct > this.config.maxCategoryConcentrationPct) {
      return {
        allowed: false,
        reason: `Category '${category}' concentration ${categoryPct.toFixed(1)}% exceeds limit ${this.config.maxCategoryConcentrationPct}%`,
      };
    }

    // TODO: Implement pairwise correlation check between positions
    // Would require historical return data for each position
    // For now, category concentration is a good proxy

    return { allowed: true };
  }

  /**
   * Calculate current drawdown (FIXED)
   */
  private calculateCurrentDrawdown(currentValue: number): number {
    if (this.highWaterMark === 0) return 0;
    return ((this.highWaterMark - currentValue) / this.highWaterMark) * 100;
  }

  /**
   * Get current daily P&L as percentage (FIXED: was USD, now %)
   */
  private getDailyLossPct(): number {
    const stats = this.dailyStats.get(this.currentDate);
    if (!stats || stats.startingValue === 0) return 0;

    // Return loss as positive percentage if losing
    const lossPct = -(stats.pnl / stats.startingValue) * 100;
    return Math.max(0, lossPct); // Only return if it's a loss
  }

  /**
   * Get current daily P&L (for backwards compatibility)
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
   * Calculate stop loss price (with volatility adjustment and trailing)
   */
  calculateStopLoss(
    entryPrice: number,
    side: 'LONG' | 'SHORT',
    marketId?: string,
    currentPrice?: number
  ): number {
    let stopLossPct = this.config.stopLossPct;

    // Apply volatility adjustment if enabled
    if (this.config.useVolatilityAdjusted && marketId) {
      const volatility = this.calculateVolatility(marketId);
      const avgVolatility = this.config.stopLossPct; // Use base as average
      stopLossPct = calculateVolatilityAdjustedSL(
        this.config.stopLossPct,
        volatility,
        avgVolatility,
        this.config
      );
    }

    // Check for trailing stop
    if (this.config.useTrailingStops && marketId && currentPrice) {
      const key = `${marketId}`;
      const trailing = this.trailingStops.get(key);

      if (trailing) {
        return trailing.currentStopLoss;
      }
    }

    // Calculate base stop loss
    const stopPct = stopLossPct / 100;

    if (side === 'LONG') {
      return entryPrice * (1 - stopPct);
    } else {
      return entryPrice * (1 + stopPct);
    }
  }

  /**
   * Calculate take profit price (with volatility adjustment)
   */
  calculateTakeProfit(
    entryPrice: number,
    side: 'LONG' | 'SHORT',
    marketId?: string
  ): number {
    let takeProfitPct = this.config.takeProfitPct;

    // Apply volatility adjustment if enabled
    if (this.config.useVolatilityAdjusted && marketId) {
      const volatility = this.calculateVolatility(marketId);
      const avgVolatility = this.config.takeProfitPct;
      takeProfitPct = calculateVolatilityAdjustedTP(
        this.config.takeProfitPct,
        volatility,
        avgVolatility,
        this.config
      );
    }

    const takePct = takeProfitPct / 100;

    if (side === 'LONG') {
      return entryPrice * (1 + takePct);
    } else {
      return entryPrice * (1 - takePct);
    }
  }

  /**
   * Update trailing stop for a position (NEW)
   */
  updateTrailingStop(
    marketId: string,
    tokenId: string,
    currentPrice: number,
    side: 'LONG' | 'SHORT'
  ): void {
    if (!this.config.useTrailingStops) return;

    const key = `${marketId}`;
    let trailing = this.trailingStops.get(key);

    if (!trailing) {
      // Initialize trailing stop
      trailing = {
        marketId,
        tokenId,
        side,
        entryPrice: currentPrice,
        highestPrice: currentPrice,
        lowestPrice: currentPrice,
        currentStopLoss: this.calculateStopLoss(currentPrice, side),
        currentTakeProfit: this.calculateTakeProfit(currentPrice, side),
        baseStopLoss: this.calculateStopLoss(currentPrice, side),
        baseTakeProfit: this.calculateTakeProfit(currentPrice, side),
      };
      this.trailingStops.set(key, trailing);
      return;
    }

    // Update highest/lowest prices
    if (side === 'LONG') {
      if (currentPrice > trailing.highestPrice) {
        trailing.highestPrice = currentPrice;

        // Update trailing stop
        const trailingPct = this.config.trailingStopPct / 100;
        const newStopLoss = currentPrice * (1 - trailingPct);

        // Only move stop loss up, never down
        if (newStopLoss > trailing.currentStopLoss) {
          trailing.currentStopLoss = newStopLoss;
        }
      }
    } else {
      // SHORT
      if (currentPrice < trailing.lowestPrice) {
        trailing.lowestPrice = currentPrice;

        const trailingPct = this.config.trailingStopPct / 100;
        const newStopLoss = currentPrice * (1 + trailingPct);

        // Only move stop loss down, never up
        if (newStopLoss < trailing.currentStopLoss) {
          trailing.currentStopLoss = newStopLoss;
        }
      }
    }
  }

  /**
   * Check if stop loss is triggered
   */
  isStopLossTriggered(
    currentPrice: number,
    entryPrice: number,
    side: 'LONG' | 'SHORT',
    marketId?: string
  ): boolean {
    const stopPrice = this.calculateStopLoss(entryPrice, side, marketId, currentPrice);

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
    side: 'LONG' | 'SHORT',
    marketId?: string
  ): boolean {
    const takeProfitPrice = this.calculateTakeProfit(entryPrice, side, marketId);

    if (side === 'LONG') {
      return currentPrice >= takeProfitPrice;
    } else {
      return currentPrice <= takeProfitPrice;
    }
  }

  /**
   * Calculate volatility for a market (for adaptive SL/TP)
   */
  private calculateVolatility(marketId: string): number {
    const prices = this.priceHistory.get(marketId) || [];
    if (prices.length < 2) return this.config.stopLossPct; // Default to base

    // Calculate standard deviation of returns
    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      const ret = (prices[i] - prices[i - 1]) / prices[i - 1];
      returns.push(ret);
    }

    if (returns.length === 0) return this.config.stopLossPct;

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);

    // Return as percentage
    return stdDev * 100;
  }

  /**
   * Update price history for volatility calculation
   */
  updatePriceHistory(marketId: string, price: number): void {
    let prices = this.priceHistory.get(marketId);
    if (!prices) {
      prices = [];
      this.priceHistory.set(marketId, prices);
    }

    prices.push(price);

    // Keep only last N prices
    if (prices.length > this.VOLATILITY_WINDOW) {
      prices.shift();
    }
  }

  /**
   * Update category exposure (for correlation tracking)
   */
  updateCategoryExposure(marketId: string, value: number): void {
    const category = this.getMarketCategory(marketId);
    this.categoryExposure.set(category, value);
  }

  /**
   * Get market category (simplified - would need market metadata)
   */
  private getMarketCategory(marketId: string): string {
    // TODO: Implement proper category extraction from market metadata
    // For now, use a simple hash-based categorization
    const hash = marketId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const categories = ['politics', 'sports', 'crypto', 'entertainment', 'finance'];
    return categories[hash % categories.length];
  }

  /**
   * Get risk metrics
   */
  getRiskMetrics(): {
    currentDrawdown: number;
    highWaterMark: number;
    dailyPnL: number;
    dailyPnLPct: number;
    isHalted: boolean;
    haltReason: string;
    adaptiveMultiplier: number;
    profileType: string;
  } {
    return {
      currentDrawdown: this.calculateCurrentDrawdown(this.currentPortfolioValue),
      highWaterMark: this.highWaterMark,
      dailyPnL: this.getDailyPnL(),
      dailyPnLPct: this.getDailyLossPct(),
      isHalted: this.haltTriggered,
      haltReason: this.haltReason,
      adaptiveMultiplier: this.adaptiveMultiplier,
      profileType: this.config.profileType,
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
    this.currentPortfolioValue = 0;
    this.haltTriggered = false;
    this.haltReason = '';
    this.adaptiveMultiplier = 1.0;
    this.trailingStops.clear();
    this.priceHistory.clear();
    this.categoryExposure.clear();
    this.positionReturns.clear();
  }

  /**
   * Initialize with starting portfolio value
   */
  initialize(portfolioValue: number): void {
    this.initialPortfolioValue = portfolioValue;
    this.highWaterMark = portfolioValue;
    this.currentPortfolioValue = portfolioValue;
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
    this.logger.info({ profile: this.config.profileType }, 'Risk config updated');
  }
}
