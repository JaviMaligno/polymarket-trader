/**
 * Position Limits Filter (A)
 *
 * Enforces position sizing limits to prevent overexposure to any single market.
 * These are safety constraints, not optimizable parameters.
 */

export interface PositionLimitsConfig {
  /** Maximum exposure per market as fraction of total capital (default: 0.03 = 3%) */
  maxExposurePerMarket: number;
  /** Maximum total exposure as fraction of capital (default: 0.60 = 60%) */
  maxTotalExposure: number;
  /** Maximum number of open positions (default: 20) */
  maxOpenPositions: number;
  /** Minimum position size in USD (default: 5) */
  minPositionSize: number;
}

export interface Position {
  marketId: string;
  size: number;
  entryPrice: number;
  currentPrice: number;
}

export interface PositionCheckResult {
  allowed: boolean;
  reason?: string;
  adjustedSize?: number;
  currentExposure?: number;
  marketExposure?: number;
}

const DEFAULT_CONFIG: PositionLimitsConfig = {
  maxExposurePerMarket: 0.03,  // 3% max per market
  maxTotalExposure: 0.60,      // 60% max total
  maxOpenPositions: 20,
  minPositionSize: 5,
};

export class PositionLimits {
  private config: PositionLimitsConfig;

  constructor(config: Partial<PositionLimitsConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if a new position or addition to existing position is allowed
   */
  checkPosition(
    marketId: string,
    proposedSize: number,
    price: number,
    totalCapital: number,
    existingPositions: Position[]
  ): PositionCheckResult {
    const proposedValue = proposedSize * price;

    // Check minimum size
    if (proposedValue < this.config.minPositionSize) {
      return {
        allowed: false,
        reason: `Position value $${proposedValue.toFixed(2)} below minimum $${this.config.minPositionSize}`,
      };
    }

    // Calculate current exposures
    const currentTotalExposure = existingPositions.reduce(
      (sum, p) => sum + p.size * p.currentPrice,
      0
    );

    const existingMarketPosition = existingPositions.find(p => p.marketId === marketId);
    const currentMarketExposure = existingMarketPosition
      ? existingMarketPosition.size * existingMarketPosition.currentPrice
      : 0;

    // Check max positions
    if (!existingMarketPosition && existingPositions.length >= this.config.maxOpenPositions) {
      return {
        allowed: false,
        reason: `Maximum ${this.config.maxOpenPositions} positions reached`,
        currentExposure: currentTotalExposure / totalCapital,
      };
    }

    // Check per-market exposure limit
    const newMarketExposure = currentMarketExposure + proposedValue;
    const maxMarketValue = totalCapital * this.config.maxExposurePerMarket;

    if (newMarketExposure > maxMarketValue) {
      // Calculate adjusted size that would fit within limit
      const availableValue = Math.max(0, maxMarketValue - currentMarketExposure);
      const adjustedSize = availableValue / price;

      if (adjustedSize * price < this.config.minPositionSize) {
        return {
          allowed: false,
          reason: `Market exposure would exceed ${(this.config.maxExposurePerMarket * 100).toFixed(0)}% limit`,
          marketExposure: newMarketExposure / totalCapital,
        };
      }

      return {
        allowed: true,
        reason: `Size reduced to fit ${(this.config.maxExposurePerMarket * 100).toFixed(0)}% per-market limit`,
        adjustedSize,
        marketExposure: maxMarketValue / totalCapital,
      };
    }

    // Check total exposure limit
    const newTotalExposure = currentTotalExposure + proposedValue;
    const maxTotalValue = totalCapital * this.config.maxTotalExposure;

    if (newTotalExposure > maxTotalValue) {
      const availableValue = Math.max(0, maxTotalValue - currentTotalExposure);
      const adjustedSize = availableValue / price;

      if (adjustedSize * price < this.config.minPositionSize) {
        return {
          allowed: false,
          reason: `Total exposure would exceed ${(this.config.maxTotalExposure * 100).toFixed(0)}% limit`,
          currentExposure: newTotalExposure / totalCapital,
        };
      }

      return {
        allowed: true,
        reason: `Size reduced to fit ${(this.config.maxTotalExposure * 100).toFixed(0)}% total limit`,
        adjustedSize,
        currentExposure: maxTotalValue / totalCapital,
      };
    }

    // All checks passed
    return {
      allowed: true,
      currentExposure: newTotalExposure / totalCapital,
      marketExposure: newMarketExposure / totalCapital,
    };
  }

  /**
   * Calculate the maximum allowed position size for a market
   */
  getMaxAllowedSize(
    marketId: string,
    price: number,
    totalCapital: number,
    existingPositions: Position[]
  ): number {
    const existingMarketPosition = existingPositions.find(p => p.marketId === marketId);
    const currentMarketValue = existingMarketPosition
      ? existingMarketPosition.size * existingMarketPosition.currentPrice
      : 0;

    const currentTotalValue = existingPositions.reduce(
      (sum, p) => sum + p.size * p.currentPrice,
      0
    );

    // Max based on per-market limit
    const maxMarketValue = totalCapital * this.config.maxExposurePerMarket;
    const availableMarketValue = Math.max(0, maxMarketValue - currentMarketValue);

    // Max based on total exposure limit
    const maxTotalValue = totalCapital * this.config.maxTotalExposure;
    const availableTotalValue = Math.max(0, maxTotalValue - currentTotalValue);

    // Take the minimum of both limits
    const availableValue = Math.min(availableMarketValue, availableTotalValue);

    return availableValue / price;
  }

  /**
   * Get current configuration
   */
  getConfig(): PositionLimitsConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<PositionLimitsConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
