/**
 * performance-calculator.test.ts - Tests for PerformanceCalculator
 */

import { describe, it, expect } from 'vitest';
import { PerformanceCalculator } from '../../packages/backtest/src/metrics/PerformanceCalculator.js';
import type { TradeRecord, PortfolioSnapshot } from '../../packages/backtest/src/types/index.js';

function createTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id: 'trade-' + Math.random().toString(36).slice(2),
    marketId: 'market-123',
    outcome: 'Yes',
    side: 'BUY',
    entryPrice: 0.5,
    exitPrice: 0.6,
    size: 100,
    pnl: 10,
    pnlPct: 0.1,
    entryTime: new Date(),
    exitTime: new Date(),
    holdingPeriodMs: 3600000,
    fees: 0.2,
    ...overrides,
  };
}

function createSnapshot(totalValue: number, timestamp: Date): PortfolioSnapshot {
  return {
    timestamp,
    totalValue,
    cash: totalValue * 0.5,
    positionValue: totalValue * 0.5,
    positions: [],
  };
}

function createEquityCurve(values: number[], startDate: Date = new Date()): PortfolioSnapshot[] {
  return values.map((value, i) => createSnapshot(
    value,
    new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000) // 1 day apart
  ));
}

describe('PerformanceCalculator', () => {
  describe('calculateReturns', () => {
    it('should calculate daily returns from equity curve', () => {
      const curve = createEquityCurve([10000, 10100, 10200, 10100]);
      const returns = PerformanceCalculator.calculateReturns(curve);

      expect(returns).toHaveLength(3);
      expect(returns[0]).toBeCloseTo(0.01, 4); // 1% gain
      expect(returns[1]).toBeCloseTo(0.0099, 3); // ~1% gain
      expect(returns[2]).toBeCloseTo(-0.0098, 3); // ~1% loss
    });

    it('should return empty array for single snapshot', () => {
      const curve = createEquityCurve([10000]);
      const returns = PerformanceCalculator.calculateReturns(curve);
      expect(returns).toHaveLength(0);
    });

    it('should return empty array for empty curve', () => {
      const returns = PerformanceCalculator.calculateReturns([]);
      expect(returns).toHaveLength(0);
    });
  });

  describe('calculateTotalReturn', () => {
    it('should calculate total return correctly', () => {
      const curve = createEquityCurve([10000, 11000, 12000]);
      const totalReturn = PerformanceCalculator.calculateTotalReturn(curve, 10000);

      expect(totalReturn).toBeCloseTo(0.2, 4); // 20% return
    });

    it('should handle loss correctly', () => {
      const curve = createEquityCurve([10000, 9000, 8000]);
      const totalReturn = PerformanceCalculator.calculateTotalReturn(curve, 10000);

      expect(totalReturn).toBeCloseTo(-0.2, 4); // -20% return
    });

    it('should return 0 for empty curve', () => {
      const totalReturn = PerformanceCalculator.calculateTotalReturn([], 10000);
      expect(totalReturn).toBe(0);
    });
  });

  describe('calculateSharpeRatio', () => {
    it('should calculate Sharpe ratio for positive returns', () => {
      const returns = [0.01, 0.02, 0.015, 0.01, 0.005];
      const sharpe = PerformanceCalculator.calculateSharpeRatio(returns);

      expect(sharpe).toBeGreaterThan(0);
    });

    it('should return 0 for empty returns', () => {
      const sharpe = PerformanceCalculator.calculateSharpeRatio([]);
      expect(sharpe).toBe(0);
    });

    it('should return 0 for zero variance', () => {
      const returns = [0.01, 0.01, 0.01, 0.01];
      const sharpe = PerformanceCalculator.calculateSharpeRatio(returns);
      expect(sharpe).toBe(0);
    });

    it('should be negative for negative average returns', () => {
      const returns = [-0.02, -0.01, -0.015, -0.02];
      const sharpe = PerformanceCalculator.calculateSharpeRatio(returns);
      expect(sharpe).toBeLessThan(0);
    });
  });

  describe('calculateSortinoRatio', () => {
    it('should calculate Sortino ratio', () => {
      const returns = [0.01, -0.005, 0.02, -0.01, 0.015];
      const sortino = PerformanceCalculator.calculateSortinoRatio(returns);

      expect(typeof sortino).toBe('number');
    });

    it('should return Infinity for all positive returns', () => {
      const returns = [0.01, 0.02, 0.015];
      const sortino = PerformanceCalculator.calculateSortinoRatio(returns);

      expect(sortino).toBe(Infinity);
    });

    it('should return 0 for empty returns', () => {
      const sortino = PerformanceCalculator.calculateSortinoRatio([]);
      expect(sortino).toBe(0);
    });
  });

  describe('calculateMaxDrawdown', () => {
    it('should calculate max drawdown correctly', () => {
      const curve = createEquityCurve([10000, 11000, 9000, 10500]);
      const maxDD = PerformanceCalculator.calculateMaxDrawdown(curve);

      // Peak was 11000, trough was 9000 = 18.18% drawdown
      expect(maxDD).toBeCloseTo(0.1818, 2);
    });

    it('should return 0 for always increasing curve', () => {
      const curve = createEquityCurve([10000, 10100, 10200, 10300]);
      const maxDD = PerformanceCalculator.calculateMaxDrawdown(curve);
      expect(maxDD).toBe(0);
    });

    it('should return 0 for empty curve', () => {
      const maxDD = PerformanceCalculator.calculateMaxDrawdown([]);
      expect(maxDD).toBe(0);
    });
  });

  describe('calculateMaxDrawdownDuration', () => {
    it('should calculate drawdown duration in periods', () => {
      const curve = createEquityCurve([10000, 11000, 10500, 10200, 10800, 11100]);
      const duration = PerformanceCalculator.calculateMaxDrawdownDuration(curve);

      expect(duration).toBeGreaterThan(0);
    });

    it('should return 0 for always increasing curve', () => {
      const curve = createEquityCurve([10000, 10100, 10200]);
      const duration = PerformanceCalculator.calculateMaxDrawdownDuration(curve);
      expect(duration).toBe(0);
    });
  });

  describe('calculateWinRate', () => {
    it('should calculate win rate correctly', () => {
      const trades = [
        createTrade({ pnl: 10 }),
        createTrade({ pnl: -5 }),
        createTrade({ pnl: 20 }),
        createTrade({ pnl: -3 }),
      ];

      const winRate = PerformanceCalculator.calculateWinRate(trades);
      expect(winRate).toBe(0.5); // 2 wins out of 4
    });

    it('should return 0 for no trades', () => {
      const winRate = PerformanceCalculator.calculateWinRate([]);
      expect(winRate).toBe(0);
    });

    it('should return 1 for all winning trades', () => {
      const trades = [
        createTrade({ pnl: 10 }),
        createTrade({ pnl: 5 }),
      ];

      const winRate = PerformanceCalculator.calculateWinRate(trades);
      expect(winRate).toBe(1);
    });
  });

  describe('calculateProfitFactor', () => {
    it('should calculate profit factor correctly', () => {
      const trades = [
        createTrade({ pnl: 100 }),
        createTrade({ pnl: -50 }),
        createTrade({ pnl: 50 }),
      ];

      const pf = PerformanceCalculator.calculateProfitFactor(trades);
      expect(pf).toBe(3); // 150 / 50
    });

    it('should return Infinity for no losses', () => {
      const trades = [
        createTrade({ pnl: 100 }),
        createTrade({ pnl: 50 }),
      ];

      const pf = PerformanceCalculator.calculateProfitFactor(trades);
      expect(pf).toBe(Infinity);
    });

    it('should return 0 for no wins', () => {
      const trades = [
        createTrade({ pnl: -100 }),
        createTrade({ pnl: -50 }),
      ];

      const pf = PerformanceCalculator.calculateProfitFactor(trades);
      expect(pf).toBe(0);
    });
  });

  describe('calculateExpectancy', () => {
    it('should calculate positive expectancy', () => {
      const trades = [
        createTrade({ pnl: 20, pnlPct: 0.2 }),
        createTrade({ pnl: -10, pnlPct: -0.1 }),
        createTrade({ pnl: 15, pnlPct: 0.15 }),
        createTrade({ pnl: -5, pnlPct: -0.05 }),
      ];

      const expectancy = PerformanceCalculator.calculateExpectancy(trades);
      expect(expectancy).toBeGreaterThan(0);
    });
  });

  describe('calculateKellyFraction', () => {
    it('should calculate Kelly fraction', () => {
      const trades = [
        createTrade({ pnl: 20, pnlPct: 0.2 }),
        createTrade({ pnl: -10, pnlPct: -0.1 }),
        createTrade({ pnl: 15, pnlPct: 0.15 }),
        createTrade({ pnl: -8, pnlPct: -0.08 }),
      ];

      const kelly = PerformanceCalculator.calculateKellyFraction(trades);
      expect(kelly).toBeGreaterThanOrEqual(0);
      expect(kelly).toBeLessThanOrEqual(1);
    });

    it('should return 0 for no losses', () => {
      const trades = [createTrade({ pnl: 10, pnlPct: 0.1 })];
      const kelly = PerformanceCalculator.calculateKellyFraction(trades);
      expect(kelly).toBe(0);
    });
  });

  describe('calculateVaR', () => {
    it('should calculate Value at Risk', () => {
      const returns = [-0.05, -0.02, 0.01, 0.03, -0.01, 0.02, -0.03, 0.04, -0.01, 0.01];
      const var95 = PerformanceCalculator.calculateVaR(returns, 0.95);

      expect(var95).toBeGreaterThan(0);
      expect(var95).toBeLessThan(1);
    });

    it('should return 0 for empty returns', () => {
      const var95 = PerformanceCalculator.calculateVaR([], 0.95);
      expect(var95).toBe(0);
    });
  });

  describe('calculateCVaR', () => {
    it('should calculate Conditional VaR', () => {
      const returns = [-0.05, -0.02, 0.01, 0.03, -0.01, 0.02, -0.03, 0.04, -0.01, 0.01];
      const cvar = PerformanceCalculator.calculateCVaR(returns, 0.95);

      expect(cvar).toBeGreaterThanOrEqual(0);
    });
  });

  describe('calculate (full metrics)', () => {
    it('should calculate all metrics', () => {
      const trades = [
        createTrade({ pnl: 100, pnlPct: 0.1 }),
        createTrade({ pnl: -50, pnlPct: -0.05 }),
        createTrade({ pnl: 75, pnlPct: 0.075 }),
      ];
      const curve = createEquityCurve([10000, 10100, 10050, 10125]);

      const metrics = PerformanceCalculator.calculate(trades, curve, 10000);

      expect(metrics).toHaveProperty('totalReturn');
      expect(metrics).toHaveProperty('sharpeRatio');
      expect(metrics).toHaveProperty('maxDrawdown');
      expect(metrics).toHaveProperty('winRate');
      expect(metrics).toHaveProperty('profitFactor');
      expect(metrics).toHaveProperty('totalTrades');
      expect(metrics.totalTrades).toBe(3);
    });
  });
});
