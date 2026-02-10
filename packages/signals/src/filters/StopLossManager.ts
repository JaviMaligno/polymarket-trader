/**
 * Stop-Loss Manager (B)
 *
 * Manages trailing stops and hard stops for positions.
 * Parameters are optimizable within safe bounds.
 */

import { EventEmitter } from 'events';

export interface StopLossConfig {
  /** Trailing stop as fraction from high water mark (default: 0.15 = -15%) */
  trailingStopPct: number;
  /** Hard stop as fraction from entry price (default: 0.25 = -25%) */
  hardStopPct: number;
  /** Take profit as fraction from entry (default: 0.30 = +30%) */
  takeProfitPct: number;
  /** Absolute maximum loss allowed (safety limit, not optimizable) */
  absoluteMaxLoss: number;
}

export interface TrackedPosition {
  marketId: string;
  entryPrice: number;
  currentPrice: number;
  highWaterMark: number;
  size: number;
  openedAt: Date;
}

export interface StopCheckResult {
  shouldClose: boolean;
  reason?: 'trailing_stop' | 'hard_stop' | 'take_profit' | 'absolute_max';
  currentPnlPct: number;
  drawdownFromPeak: number;
}

export interface StopLossEvents {
  'stop:triggered': (position: TrackedPosition, result: StopCheckResult) => void;
  'hwm:updated': (marketId: string, newHwm: number) => void;
}

const DEFAULT_CONFIG: StopLossConfig = {
  trailingStopPct: 0.15,
  hardStopPct: 0.25,
  takeProfitPct: 0.30,
  absoluteMaxLoss: 0.35,  // Safety limit
};

// Optimizable ranges
export const OPTIMIZABLE_RANGES = {
  trailingStopPct: [0.10, 0.15, 0.20, 0.25],
  hardStopPct: [0.20, 0.25, 0.30],
  takeProfitPct: [0.15, 0.20, 0.30, 0.50],
};

export class StopLossManager extends EventEmitter {
  private config: StopLossConfig;
  private positions: Map<string, TrackedPosition> = new Map();

  constructor(config: Partial<StopLossConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.validateConfig();
  }

  private validateConfig(): void {
    // Ensure hard stop is never more lenient than absolute max
    if (this.config.hardStopPct > this.config.absoluteMaxLoss) {
      this.config.hardStopPct = this.config.absoluteMaxLoss;
    }
  }

  /**
   * Start tracking a new position
   */
  trackPosition(
    marketId: string,
    entryPrice: number,
    size: number
  ): void {
    this.positions.set(marketId, {
      marketId,
      entryPrice,
      currentPrice: entryPrice,
      highWaterMark: entryPrice,
      size,
      openedAt: new Date(),
    });
  }

  /**
   * Update position price and check stops
   */
  updatePrice(marketId: string, currentPrice: number): StopCheckResult | null {
    const position = this.positions.get(marketId);
    if (!position) {
      return null;
    }

    position.currentPrice = currentPrice;

    // Update high water mark
    if (currentPrice > position.highWaterMark) {
      position.highWaterMark = currentPrice;
      this.emit('hwm:updated', marketId, currentPrice);
    }

    // Check all stop conditions
    const result = this.checkStops(position);

    if (result.shouldClose) {
      this.emit('stop:triggered', position, result);
    }

    return result;
  }

  /**
   * Check all stop conditions for a position
   */
  checkStops(position: TrackedPosition): StopCheckResult {
    const { entryPrice, currentPrice, highWaterMark } = position;

    // Calculate metrics
    const pnlPct = (currentPrice - entryPrice) / entryPrice;
    const drawdownFromPeak = (highWaterMark - currentPrice) / highWaterMark;

    // Check take profit first (positive exit)
    if (pnlPct >= this.config.takeProfitPct) {
      return {
        shouldClose: true,
        reason: 'take_profit',
        currentPnlPct: pnlPct,
        drawdownFromPeak,
      };
    }

    // Check absolute max loss (safety limit)
    if (pnlPct <= -this.config.absoluteMaxLoss) {
      return {
        shouldClose: true,
        reason: 'absolute_max',
        currentPnlPct: pnlPct,
        drawdownFromPeak,
      };
    }

    // Check hard stop from entry
    if (pnlPct <= -this.config.hardStopPct) {
      return {
        shouldClose: true,
        reason: 'hard_stop',
        currentPnlPct: pnlPct,
        drawdownFromPeak,
      };
    }

    // Check trailing stop from high water mark
    if (drawdownFromPeak >= this.config.trailingStopPct) {
      return {
        shouldClose: true,
        reason: 'trailing_stop',
        currentPnlPct: pnlPct,
        drawdownFromPeak,
      };
    }

    // No stop triggered
    return {
      shouldClose: false,
      currentPnlPct: pnlPct,
      drawdownFromPeak,
    };
  }

  /**
   * Stop tracking a position (after it's closed)
   */
  removePosition(marketId: string): void {
    this.positions.delete(marketId);
  }

  /**
   * Get all tracked positions
   */
  getTrackedPositions(): TrackedPosition[] {
    return Array.from(this.positions.values());
  }

  /**
   * Get a specific tracked position
   */
  getPosition(marketId: string): TrackedPosition | undefined {
    return this.positions.get(marketId);
  }

  /**
   * Check all positions and return those that should be closed
   */
  checkAllPositions(): Array<{ position: TrackedPosition; result: StopCheckResult }> {
    const toClose: Array<{ position: TrackedPosition; result: StopCheckResult }> = [];

    for (const position of this.positions.values()) {
      const result = this.checkStops(position);
      if (result.shouldClose) {
        toClose.push({ position, result });
      }
    }

    return toClose;
  }

  /**
   * Get current configuration
   */
  getConfig(): StopLossConfig {
    return { ...this.config };
  }

  /**
   * Update configuration (validates against safety limits)
   */
  updateConfig(config: Partial<StopLossConfig>): void {
    this.config = { ...this.config, ...config };
    this.validateConfig();
  }

  /**
   * Get optimizable parameter ranges
   */
  static getOptimizableRanges(): typeof OPTIMIZABLE_RANGES {
    return OPTIMIZABLE_RANGES;
  }
}
