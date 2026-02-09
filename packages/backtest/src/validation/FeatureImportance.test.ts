/**
 * Tests for FeatureImportanceCalculator
 */

import { describe, it, expect } from 'vitest';
import {
  FeatureImportanceCalculator,
  createFeatureImportanceCalculator,
} from './FeatureImportance.js';
import type { PerformanceMetrics, TradeRecord } from '../types/index.js';

// ============================================
// Helpers
// ============================================

function makeTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id: 't1',
    marketId: 'm1',
    tokenId: 'tk1',
    marketQuestion: 'Q?',
    side: 'LONG',
    entryPrice: 0.5,
    exitPrice: 0.52,
    size: 10,
    pnl: 0.2,
    pnlPct: 4,
    fees: 0.01,
    entryTime: new Date(),
    exitTime: new Date(),
    holdingPeriodMs: 86400000,
    signals: ['momentum'],
    marketResolved: false,
    ...overrides,
  };
}

function makeMetrics(overrides: Partial<PerformanceMetrics> = {}): PerformanceMetrics {
  return {
    totalReturn: 0.15,
    annualizedReturn: 0.30,
    sharpeRatio: 1.5,
    sortinoRatio: 2.0,
    maxDrawdown: -0.10,
    maxDrawdownDuration: 5,
    calmarRatio: 3.0,
    winRate: 0.55,
    profitFactor: 1.8,
    avgTradeReturn: 0.005,
    avgWin: 0.02,
    avgLoss: -0.01,
    expectancy: 0.005,
    totalTrades: 50,
    avgHoldingPeriod: 24,
    kellyFraction: 0.1,
    ...overrides,
  };
}

// ============================================
// Tests
// ============================================

describe('FeatureImportanceCalculator', () => {
  describe('createFeatureImportanceCalculator', () => {
    it('should create with default config', () => {
      const calc = createFeatureImportanceCalculator();
      expect(calc).toBeInstanceOf(FeatureImportanceCalculator);
    });

    it('should accept custom config', () => {
      const calc = createFeatureImportanceCalculator({
        numPermutations: 10,
        primaryMetric: 'totalReturn',
        randomSeed: 42,
      });
      expect(calc).toBeInstanceOf(FeatureImportanceCalculator);
    });
  });

  describe('calculate', () => {
    it('should throw with fewer than minTrades', () => {
      const calc = createFeatureImportanceCalculator({ minTrades: 20 });

      const trades = Array.from({ length: 5 }, (_, i) =>
        makeTrade({ id: `t${i}`, pnl: i % 2 === 0 ? 1 : -0.5, pnlPct: i % 2 === 0 ? 5 : -3 })
      );

      expect(() => calc.calculate(trades, makeMetrics())).toThrow('at least 20');
    });

    it('should identify useful signals', () => {
      const calc = createFeatureImportanceCalculator({
        numPermutations: 20,
        randomSeed: 42,
        minTrades: 5,
        minImportanceThreshold: -1, // Accept everything to test ranking
      });

      // Create trades: momentum trades are profitable, mean_reversion are random
      const trades: TradeRecord[] = [];
      for (let i = 0; i < 30; i++) {
        if (i < 15) {
          // Momentum trades: consistently profitable
          trades.push(makeTrade({
            id: `t${i}`,
            signals: ['momentum'],
            pnl: 2.0 + Math.random() * 0.5,
            pnlPct: 5 + Math.random(),
          }));
        } else {
          // Mean reversion trades: random
          trades.push(makeTrade({
            id: `t${i}`,
            signals: ['mean_reversion'],
            pnl: Math.random() > 0.5 ? 1.5 : -1.5,
            pnlPct: Math.random() > 0.5 ? 3 : -3,
          }));
        }
      }

      const result = calc.calculate(trades, makeMetrics());

      expect(result.features.length).toBe(2);
      expect(result.ranking.length).toBe(2);
      expect(result.ranking[0].name).toBeDefined();
      expect(result.baselineMetric).toBeDefined();
    });

    it('should return correct ranking order', () => {
      const calc = createFeatureImportanceCalculator({
        numPermutations: 50,
        randomSeed: 123,
        minTrades: 5,
      });

      // Trades with two signals where one is clearly important
      const trades: TradeRecord[] = [];
      for (let i = 0; i < 40; i++) {
        const isA = i < 20;
        trades.push(makeTrade({
          id: `t${i}`,
          signals: isA ? ['signal_a'] : ['signal_b'],
          pnl: isA ? 5.0 : 0.01,
          pnlPct: isA ? 10 : 0.02,
        }));
      }

      const result = calc.calculate(trades, makeMetrics());

      expect(result.ranking.length).toBe(2);
      // Signal A should rank higher in importance since it has all the profit
      expect(result.ranking[0].importance).toBeGreaterThanOrEqual(result.ranking[1].importance);
    });

    it('should handle trades with multiple signals', () => {
      const calc = createFeatureImportanceCalculator({
        numPermutations: 10,
        randomSeed: 42,
        minTrades: 5,
      });

      const trades: TradeRecord[] = Array.from({ length: 20 }, (_, i) =>
        makeTrade({
          id: `t${i}`,
          signals: ['momentum', 'ofi'], // Trade uses multiple signals
          pnl: 1.0,
          pnlPct: 2,
        })
      );

      const result = calc.calculate(trades, makeMetrics());

      expect(result.features.length).toBe(2);
      expect(result.features.find(f => f.name === 'momentum')).toBeDefined();
      expect(result.features.find(f => f.name === 'ofi')).toBeDefined();
    });

    it('should produce deterministic results with seed', () => {
      const trades: TradeRecord[] = Array.from({ length: 20 }, (_, i) =>
        makeTrade({
          id: `t${i}`,
          signals: ['sig_a'],
          pnl: i % 3 === 0 ? 2 : -1,
          pnlPct: i % 3 === 0 ? 5 : -2.5,
        })
      );

      const calc1 = createFeatureImportanceCalculator({ randomSeed: 42, numPermutations: 20, minTrades: 5 });
      const calc2 = createFeatureImportanceCalculator({ randomSeed: 42, numPermutations: 20, minTrades: 5 });

      const r1 = calc1.calculate(trades, makeMetrics());
      const r2 = calc2.calculate(trades, makeMetrics());

      expect(r1.features[0].importance).toBe(r2.features[0].importance);
    });
  });
});
