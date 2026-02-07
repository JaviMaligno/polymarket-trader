/**
 * slippage-model.test.ts - Tests for SlippageModel
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SlippageModel } from '../../packages/backtest/src/simulation/SlippageModel.js';
import type { SlippageConfig } from '../../packages/backtest/src/types/index.js';

function createOrderBook(levels: Array<{ price: number; size: number }>) {
  return levels;
}

describe('SlippageModel', () => {
  describe('Fixed Slippage Model', () => {
    let model: SlippageModel;

    beforeEach(() => {
      model = new SlippageModel({
        model: 'fixed',
        fixedSlippage: 0.002, // 0.2%
      });
    });

    it('should apply fixed slippage for buy orders', () => {
      const orderBook = createOrderBook([
        { price: 0.50, size: 1000 },
        { price: 0.51, size: 500 },
      ]);

      const result = model.calculateSlippage(100, 'BUY', orderBook);

      expect(result.canFill).toBe(true);
      expect(result.executionPrice).toBeCloseTo(0.501, 3); // 0.50 * 1.002
      expect(result.slippagePct).toBeCloseTo(0.2, 1);
    });

    it('should apply negative slippage for sell orders', () => {
      const orderBook = createOrderBook([
        { price: 0.50, size: 1000 },
      ]);

      const result = model.calculateSlippage(100, 'SELL', orderBook);

      expect(result.canFill).toBe(true);
      expect(result.executionPrice).toBeCloseTo(0.499, 3); // 0.50 * 0.998
    });

    it('should return no liquidity for empty order book', () => {
      const result = model.calculateSlippage(100, 'BUY', []);

      expect(result.canFill).toBe(false);
      expect(result.maxFillableSize).toBe(0);
      expect(result.slippagePct).toBe(100);
    });
  });

  describe('Proportional Slippage Model', () => {
    let model: SlippageModel;

    beforeEach(() => {
      model = new SlippageModel({
        model: 'proportional',
        proportionalRate: 0.001, // 0.1% base
      });
    });

    it('should increase slippage with order size', () => {
      const orderBook = createOrderBook([{ price: 0.50, size: 10000 }]);
      const dailyVolume = 10000;

      const smallOrder = model.calculateSlippage(10, 'BUY', orderBook, dailyVolume);
      const largeOrder = model.calculateSlippage(1000, 'BUY', orderBook, dailyVolume);

      expect(largeOrder.slippagePct).toBeGreaterThan(smallOrder.slippagePct);
    });

    it('should scale with volume ratio', () => {
      const orderBook = createOrderBook([{ price: 0.50, size: 10000 }]);

      // Order that represents 10% of daily volume
      const result = model.calculateSlippage(200, 'BUY', orderBook, 1000);

      expect(result.slippagePct).toBeGreaterThan(0.1); // More than base rate
    });
  });

  describe('Order Book Slippage Model', () => {
    let model: SlippageModel;

    beforeEach(() => {
      model = new SlippageModel({
        model: 'orderbook',
        impactFactor: 1.0,
      });
    });

    it('should walk through order book levels', () => {
      const orderBook = createOrderBook([
        { price: 0.50, size: 100 },
        { price: 0.51, size: 100 },
        { price: 0.52, size: 100 },
      ]);

      // Order that requires multiple levels
      const result = model.calculateSlippage(200, 'BUY', orderBook);

      expect(result.canFill).toBe(true);
      // Average price should be between 0.50 and 0.51
      expect(result.executionPrice).toBeGreaterThan(0.50);
    });

    it('should report partial fill when insufficient liquidity', () => {
      const orderBook = createOrderBook([
        { price: 0.50, size: 50 },
        { price: 0.51, size: 30 },
      ]);

      const result = model.calculateSlippage(100, 'BUY', orderBook);

      expect(result.canFill).toBe(false);
      expect(result.maxFillableSize).toBe(80);
    });

    it('should fill completely with sufficient liquidity', () => {
      const orderBook = createOrderBook([
        { price: 0.50, size: 500 },
      ]);

      const result = model.calculateSlippage(100, 'BUY', orderBook);

      expect(result.canFill).toBe(true);
      expect(result.maxFillableSize).toBe(100);
    });

    it('should apply impact factor', () => {
      const orderBook = createOrderBook([
        { price: 0.50, size: 100 },
        { price: 0.52, size: 100 },
      ]);

      const lowImpact = new SlippageModel({ model: 'orderbook', impactFactor: 1.0 });
      const highImpact = new SlippageModel({ model: 'orderbook', impactFactor: 2.0 });

      const lowResult = lowImpact.calculateSlippage(150, 'BUY', orderBook);
      const highResult = highImpact.calculateSlippage(150, 'BUY', orderBook);

      expect(highResult.slippagePct).toBeGreaterThan(lowResult.slippagePct);
    });
  });

  describe('estimateMarketImpact', () => {
    it('should estimate market impact based on order size', () => {
      const model = new SlippageModel({ model: 'fixed', impactFactor: 0.1 });

      const smallImpact = model.estimateMarketImpact(10, 0.5, 10000);
      const largeImpact = model.estimateMarketImpact(100, 0.5, 10000);

      expect(largeImpact).toBeGreaterThan(smallImpact);
    });

    it('should scale with sqrt of volume ratio (Kyle lambda)', () => {
      const model = new SlippageModel({ model: 'fixed', impactFactor: 0.1 });

      const impact1 = model.estimateMarketImpact(100, 0.5, 10000);
      const impact4 = model.estimateMarketImpact(400, 0.5, 10000);

      // With 4x the size, impact should be ~2x (sqrt relationship)
      expect(impact4 / impact1).toBeCloseTo(2, 0);
    });
  });

  describe('calculateOptimalSize', () => {
    it('should return max size for fixed model within tolerance', () => {
      const model = new SlippageModel({ model: 'fixed', fixedSlippage: 0.001 });
      const orderBook = createOrderBook([
        { price: 0.5, size: 1000 },
      ]);

      const optimalSize = model.calculateOptimalSize(0.5, 0.5, 10000, orderBook);

      expect(optimalSize).toBe(1000); // All available liquidity
    });

    it('should return 0 for fixed model exceeding tolerance', () => {
      const model = new SlippageModel({ model: 'fixed', fixedSlippage: 0.01 });
      const orderBook = createOrderBook([{ price: 0.5, size: 1000 }]);

      const optimalSize = model.calculateOptimalSize(0.5, 0.5, 10000, orderBook);

      expect(optimalSize).toBe(0);
    });

    it('should calculate size for proportional model', () => {
      const model = new SlippageModel({ model: 'proportional', proportionalRate: 0.001 });
      const orderBook = createOrderBook([{ price: 0.5, size: 10000 }]);

      const optimalSize = model.calculateOptimalSize(1.0, 0.5, 10000, orderBook);

      expect(optimalSize).toBeGreaterThan(0);
    });

    it('should walk order book for orderbook model', () => {
      const model = new SlippageModel({ model: 'orderbook', impactFactor: 1.0 });
      const orderBook = createOrderBook([
        { price: 0.50, size: 100 },
        { price: 0.51, size: 100 },
        { price: 0.55, size: 100 },
      ]);

      const optimalSize = model.calculateOptimalSize(5.0, 0.5, 10000, orderBook);

      // Should be able to fill some but not all
      expect(optimalSize).toBeGreaterThan(0);
      expect(optimalSize).toBeLessThanOrEqual(300);
    });

    it('should return 0 for empty order book', () => {
      const model = new SlippageModel({ model: 'orderbook' });
      const optimalSize = model.calculateOptimalSize(1.0, 0.5, 10000, []);

      expect(optimalSize).toBe(0);
    });
  });

  describe('configuration', () => {
    it('should return current config', () => {
      const config: SlippageConfig = { model: 'fixed', fixedSlippage: 0.005 };
      const model = new SlippageModel(config);

      expect(model.getConfig()).toEqual(config);
    });

    it('should update config', () => {
      const model = new SlippageModel({ model: 'fixed', fixedSlippage: 0.001 });
      model.updateConfig({ fixedSlippage: 0.002 });

      expect(model.getConfig().fixedSlippage).toBe(0.002);
    });
  });
});
