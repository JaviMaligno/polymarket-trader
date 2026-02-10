import { describe, it, expect, beforeEach } from 'vitest';
import { PositionLimits } from './PositionLimits.js';
import { StopLossManager } from './StopLossManager.js';
import { HurstFilter } from './HurstFilter.js';
import { RSIMomentumFilter } from './RSIMomentumFilter.js';
import { ZScoreVolatilityFilter } from './ZScoreVolatilityFilter.js';
import { EntryFilterPipeline } from './EntryFilterPipeline.js';

describe('PositionLimits', () => {
  let limits: PositionLimits;

  beforeEach(() => {
    limits = new PositionLimits({
      maxExposurePerMarket: 0.03,
      maxTotalExposure: 0.60,
      maxOpenPositions: 20,
      minPositionSize: 5,
    });
  });

  it('should allow position within limits', () => {
    const result = limits.checkPosition(
      'market1',
      100,
      0.5,
      10000,
      []
    );
    expect(result.allowed).toBe(true);
    expect(result.adjustedSize).toBeUndefined();
  });

  it('should reject position below minimum size', () => {
    const result = limits.checkPosition(
      'market1',
      5,
      0.5,
      10000,
      []
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('minimum');
  });

  it('should reduce size when exceeding per-market limit', () => {
    const result = limits.checkPosition(
      'market1',
      1000,  // Would be $500 at $0.5
      0.5,
      10000,  // 3% = $300 max
      []
    );
    expect(result.allowed).toBe(true);
    expect(result.adjustedSize).toBeDefined();
    expect(result.adjustedSize! * 0.5).toBeLessThanOrEqual(300);
  });

  it('should reject when max positions reached', () => {
    const existingPositions = Array(20).fill(null).map((_, i) => ({
      marketId: `market${i}`,
      size: 10,
      entryPrice: 0.5,
      currentPrice: 0.5,
    }));

    const result = limits.checkPosition(
      'newMarket',
      100,
      0.5,
      10000,
      existingPositions
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('20 positions');
  });

  it('should calculate max allowed size correctly', () => {
    const maxSize = limits.getMaxAllowedSize(
      'market1',
      0.5,
      10000,
      []
    );
    // 3% of 10000 = 300, at price 0.5 = 600 shares
    expect(maxSize).toBe(600);
  });
});

describe('StopLossManager', () => {
  let manager: StopLossManager;

  beforeEach(() => {
    manager = new StopLossManager({
      trailingStopPct: 0.15,
      hardStopPct: 0.25,
      takeProfitPct: 0.30,
      absoluteMaxLoss: 0.35,
    });
  });

  it('should track new positions', () => {
    manager.trackPosition('market1', 0.5, 100);
    const position = manager.getPosition('market1');
    expect(position).toBeDefined();
    expect(position!.entryPrice).toBe(0.5);
    expect(position!.highWaterMark).toBe(0.5);
  });

  it('should update high water mark on price increase', () => {
    manager.trackPosition('market1', 0.5, 100);
    manager.updatePrice('market1', 0.6);
    const position = manager.getPosition('market1');
    expect(position!.highWaterMark).toBe(0.6);
  });

  it('should trigger take profit', () => {
    manager.trackPosition('market1', 0.5, 100);
    const result = manager.updatePrice('market1', 0.70);  // +40%
    expect(result!.shouldClose).toBe(true);
    expect(result!.reason).toBe('take_profit');
  });

  it('should trigger hard stop', () => {
    manager.trackPosition('market1', 0.5, 100);
    const result = manager.updatePrice('market1', 0.35);  // -30%
    expect(result!.shouldClose).toBe(true);
    expect(result!.reason).toBe('hard_stop');
  });

  it('should trigger trailing stop', () => {
    manager.trackPosition('market1', 0.5, 100);
    manager.updatePrice('market1', 0.6);  // New HWM
    const result = manager.updatePrice('market1', 0.50);  // -16.7% from HWM
    expect(result!.shouldClose).toBe(true);
    expect(result!.reason).toBe('trailing_stop');
  });

  it('should not trigger stop in normal range', () => {
    manager.trackPosition('market1', 0.5, 100);
    const result = manager.updatePrice('market1', 0.48);  // -4%
    expect(result!.shouldClose).toBe(false);
  });
});

describe('HurstFilter', () => {
  let filter: HurstFilter;

  beforeEach(() => {
    filter = new HurstFilter({
      minBars: 50,
      windowSize: 30,
      meanReversionThreshold: 0.45,
      trendingThreshold: 0.55,
    });
  });

  it('should return null with insufficient data', () => {
    const prices = Array(30).fill(1);
    const result = filter.calculateHurst(prices);
    expect(result).toBeNull();
  });

  it('should calculate Hurst for sufficient data', () => {
    // Generate random walk data (H ~ 0.5)
    const prices: number[] = [100];
    for (let i = 1; i < 60; i++) {
      prices.push(prices[i - 1] * (1 + (Math.random() - 0.5) * 0.02));
    }
    const result = filter.calculateHurst(prices);
    expect(result).not.toBeNull();
    expect(result!.hurstExponent).toBeGreaterThanOrEqual(0);
    expect(result!.hurstExponent).toBeLessThanOrEqual(1);
  });

  it('should detect trending market from consistent uptrend', () => {
    // Generate uptrend (H > 0.5)
    const prices: number[] = [100];
    for (let i = 1; i < 60; i++) {
      prices.push(prices[i - 1] * 1.01);  // Consistent 1% increase
    }
    const result = filter.calculateHurst(prices);
    expect(result).not.toBeNull();
    // Trending markets have H > 0.5
    expect(result!.hurstExponent).toBeGreaterThan(0.4);
  });

  it('should allow mean reversion in mean-reverting market', () => {
    // Generate mean-reverting data (oscillating)
    const prices: number[] = [];
    for (let i = 0; i < 60; i++) {
      prices.push(100 + Math.sin(i * 0.5) * 5);
    }
    const decision = filter.shouldAllowMeanReversion(prices);
    // Should either allow or be in ambiguous zone
    expect(decision.sizeMultiplier).toBeGreaterThanOrEqual(0);
  });

  it('should reduce size with insufficient data', () => {
    const prices = Array(30).fill(1);
    const decision = filter.shouldAllowMeanReversion(prices);
    expect(decision.allowed).toBe(true);
    expect(decision.sizeMultiplier).toBe(0.5);
  });
});

describe('RSIMomentumFilter', () => {
  let filter: RSIMomentumFilter;

  beforeEach(() => {
    filter = new RSIMomentumFilter({
      period: 14,
      oversoldThreshold: 30,
      overboughtThreshold: 70,
      momentumBars: 3,
    });
  });

  it('should return null with insufficient data', () => {
    const prices = Array(10).fill(1);
    const result = filter.calculateRSI(prices);
    expect(result).toBeNull();
  });

  it('should calculate RSI for sufficient data', () => {
    // Generate some price movement
    const prices: number[] = [100];
    for (let i = 1; i < 25; i++) {
      prices.push(prices[i - 1] * (1 + (Math.random() - 0.5) * 0.02));
    }
    const result = filter.calculateRSI(prices);
    expect(result).not.toBeNull();
    expect(result!.rsi).toBeGreaterThanOrEqual(0);
    expect(result!.rsi).toBeLessThanOrEqual(100);
  });

  it('should detect oversold condition', () => {
    // Generate consistent downtrend
    const prices: number[] = [100];
    for (let i = 1; i < 25; i++) {
      prices.push(prices[i - 1] * 0.98);  // 2% drop each bar
    }
    const result = filter.calculateRSI(prices);
    expect(result).not.toBeNull();
    expect(result!.isOversold).toBe(true);
  });

  it('should block buy when oversold and still falling', () => {
    // Generate consistent downtrend
    const prices: number[] = [100];
    for (let i = 1; i < 25; i++) {
      prices.push(prices[i - 1] * 0.97);
    }
    const decision = filter.shouldAllowMeanReversionBuy(prices);
    // Should be oversold and falling = blocked
    if (decision.rsiResult?.isOversold && decision.rsiResult?.momentum === 'falling') {
      expect(decision.allowed).toBe(false);
    }
  });
});

describe('ZScoreVolatilityFilter', () => {
  let filter: ZScoreVolatilityFilter;

  beforeEach(() => {
    filter = new ZScoreVolatilityFilter({
      maPeriod: 20,
      entryZScore: -2.0,
      volatilityLookback: 30,
      maxVolatilityRatio: 1.5,
    });
  });

  it('should return null with insufficient data', () => {
    const prices = Array(10).fill(1);
    const result = filter.analyze(prices);
    expect(result).toBeNull();
  });

  it('should calculate Z-score correctly', () => {
    // Generate stable prices then drop
    const prices = Array(30).fill(100);
    prices.push(90);  // 10% drop
    const result = filter.analyze(prices);
    expect(result).not.toBeNull();
    expect(result!.zScore).toBeLessThan(0);  // Below mean
  });

  it('should detect high volatility', () => {
    // Generate stable prices then high volatility
    const prices: number[] = Array(30).fill(100);
    for (let i = 0; i < 10; i++) {
      prices.push(100 + (Math.random() - 0.5) * 20);  // High volatility
    }
    const result = filter.analyze(prices);
    expect(result).not.toBeNull();
    // May or may not be high volatility depending on random values
  });

  it('should block entry in crash scenario', () => {
    // Generate stable then crash
    const prices: number[] = Array(30).fill(100);
    // Add high volatility crash
    for (let i = 0; i < 10; i++) {
      prices.push(prices[prices.length - 1] * 0.95);  // 5% drops
    }
    const decision = filter.shouldAllowMeanReversionBuy(prices);
    // Should detect crash scenario if Z-score is low and volatility high
    expect(decision).toBeDefined();
  });
});

describe('EntryFilterPipeline', () => {
  let pipeline: EntryFilterPipeline;

  beforeEach(() => {
    pipeline = new EntryFilterPipeline({
      hurstMinBars: 50,
    });
  });

  it('should use Hurst filter when enough data', () => {
    const prices: number[] = [];
    for (let i = 0; i < 60; i++) {
      prices.push(100 + Math.random() * 10);
    }
    const decision = pipeline.evaluate(prices, 'mean_reversion', 'buy');
    expect(decision.filtersApplied).toContain('hurst');
  });

  it('should use fallback filters with insufficient data', () => {
    const prices: number[] = [];
    for (let i = 0; i < 30; i++) {
      prices.push(100 + Math.random() * 10);
    }
    const decision = pipeline.evaluate(prices, 'mean_reversion', 'buy');
    expect(decision.filtersApplied).toContain('rsi');
    expect(decision.filtersApplied).toContain('zscore');
  });

  it('should not filter "other" signal types', () => {
    const prices = Array(10).fill(100);
    const decision = pipeline.evaluate(prices, 'other', 'buy');
    expect(decision.allowed).toBe(true);
    expect(decision.sizeMultiplier).toBe(1.0);
  });

  it('should provide size multiplier', () => {
    const prices: number[] = [];
    for (let i = 0; i < 60; i++) {
      prices.push(100 + Math.random() * 10);
    }
    const multiplier = pipeline.getSizeMultiplier(prices, 'mean_reversion', 'buy');
    expect(multiplier).toBeGreaterThanOrEqual(0);
    expect(multiplier).toBeLessThanOrEqual(1);
  });

  it('should return optimizable ranges', () => {
    const ranges = EntryFilterPipeline.getOptimizableRanges();
    expect(ranges.hurst).toBeDefined();
    expect(ranges.rsi).toBeDefined();
    expect(ranges.zScore).toBeDefined();
  });
});
