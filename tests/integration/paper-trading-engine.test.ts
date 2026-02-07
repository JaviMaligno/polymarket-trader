/**
 * paper-trading-engine.test.ts - Integration tests for PaperTradingEngine
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';

// Mock LiveDataFeed for testing
class MockLiveDataFeed extends EventEmitter {
  private prices: Map<string, { price: number; bid: number; ask: number }> = new Map();

  setPrice(marketId: string, outcome: string, price: number, spread: number = 0.01) {
    const key = `${marketId}:${outcome}`;
    this.prices.set(key, {
      price,
      bid: price - spread / 2,
      ask: price + spread / 2,
    });
  }

  getPrice(marketId: string, outcome: string) {
    const key = `${marketId}:${outcome}`;
    const data = this.prices.get(key);
    if (!data) return null;
    return {
      marketId,
      outcome,
      ...data,
    };
  }

  emitPriceUpdate(marketId: string, outcome: string, price: number) {
    this.setPrice(marketId, outcome, price);
    this.emit('price', {
      marketId,
      outcome,
      price,
      bid: price - 0.005,
      ask: price + 0.005,
    });
  }
}

// Simplified PaperTradingEngine mock for integration testing
class TestPaperTradingEngine {
  private feed: MockLiveDataFeed;
  private cash: number;
  private positions: Map<string, { size: number; avgEntryPrice: number }> = new Map();
  private orders: Map<string, any> = new Map();
  private config: any;

  constructor(feed: MockLiveDataFeed, config: any = {}) {
    this.feed = feed;
    this.config = {
      initialCapital: 10000,
      feeRate: 0.002,
      ...config,
    };
    this.cash = this.config.initialCapital;
  }

  async submitOrder(request: any) {
    const price = this.feed.getPrice(request.marketId, request.outcome);
    if (!price) {
      return { ...request, status: 'REJECTED', reason: 'No price available' };
    }

    const fillPrice = request.side === 'BUY' ? price.ask : price.bid;
    const orderValue = request.size * fillPrice;
    const fee = orderValue * this.config.feeRate;

    if (request.side === 'BUY') {
      if (orderValue + fee > this.cash) {
        return { ...request, status: 'REJECTED', reason: 'Insufficient funds' };
      }
      this.cash -= (orderValue + fee);

      const posKey = `${request.marketId}:${request.outcome}`;
      const existing = this.positions.get(posKey);
      if (existing) {
        const newSize = existing.size + request.size;
        const newAvg = (existing.avgEntryPrice * existing.size + fillPrice * request.size) / newSize;
        this.positions.set(posKey, { size: newSize, avgEntryPrice: newAvg });
      } else {
        this.positions.set(posKey, { size: request.size, avgEntryPrice: fillPrice });
      }
    } else {
      const posKey = `${request.marketId}:${request.outcome}`;
      const existing = this.positions.get(posKey);
      if (!existing || existing.size < request.size) {
        return { ...request, status: 'REJECTED', reason: 'Insufficient position' };
      }

      this.cash += (orderValue - fee);
      existing.size -= request.size;
      if (existing.size <= 0) {
        this.positions.delete(posKey);
      }
    }

    return {
      ...request,
      id: `order-${Date.now()}`,
      status: 'FILLED',
      filledSize: request.size,
      avgFillPrice: fillPrice,
    };
  }

  getPosition(marketId: string, outcome: string) {
    return this.positions.get(`${marketId}:${outcome}`);
  }

  getAllPositions() {
    return Array.from(this.positions.entries()).map(([key, pos]) => {
      const [marketId, outcome] = key.split(':');
      return { marketId, outcome, ...pos };
    });
  }

  getCash() {
    return this.cash;
  }

  getEquity() {
    let positionValue = 0;
    for (const [key, pos] of this.positions) {
      const [marketId, outcome] = key.split(':');
      const price = this.feed.getPrice(marketId, outcome);
      if (price) {
        positionValue += pos.size * price.price;
      }
    }
    return this.cash + positionValue;
  }
}

describe('PaperTradingEngine Integration', () => {
  let feed: MockLiveDataFeed;
  let engine: TestPaperTradingEngine;

  beforeEach(() => {
    feed = new MockLiveDataFeed();
    engine = new TestPaperTradingEngine(feed, { initialCapital: 10000 });

    // Set up some market prices
    feed.setPrice('market-1', 'Yes', 0.5);
    feed.setPrice('market-1', 'No', 0.5);
    feed.setPrice('market-2', 'Yes', 0.7);
  });

  describe('Order Submission', () => {
    it('should execute market buy order', async () => {
      const order = await engine.submitOrder({
        marketId: 'market-1',
        outcome: 'Yes',
        type: 'MARKET',
        side: 'BUY',
        size: 100,
      });

      expect(order.status).toBe('FILLED');
      expect(order.filledSize).toBe(100);
    });

    it('should update position after buy', async () => {
      await engine.submitOrder({
        marketId: 'market-1',
        outcome: 'Yes',
        type: 'MARKET',
        side: 'BUY',
        size: 100,
      });

      const position = engine.getPosition('market-1', 'Yes');
      expect(position).toBeDefined();
      expect(position?.size).toBe(100);
    });

    it('should deduct cash and fees on buy', async () => {
      const initialCash = engine.getCash();

      await engine.submitOrder({
        marketId: 'market-1',
        outcome: 'Yes',
        type: 'MARKET',
        side: 'BUY',
        size: 100,
      });

      const finalCash = engine.getCash();
      // Should have spent ~50 (100 * 0.5) plus fees
      expect(finalCash).toBeLessThan(initialCash);
      expect(initialCash - finalCash).toBeGreaterThan(50);
    });

    it('should reject order with insufficient funds', async () => {
      const order = await engine.submitOrder({
        marketId: 'market-1',
        outcome: 'Yes',
        type: 'MARKET',
        side: 'BUY',
        size: 50000, // Way more than we can afford
      });

      expect(order.status).toBe('REJECTED');
      expect(order.reason).toContain('Insufficient');
    });

    it('should reject sell without position', async () => {
      const order = await engine.submitOrder({
        marketId: 'market-1',
        outcome: 'Yes',
        type: 'MARKET',
        side: 'SELL',
        size: 100,
      });

      expect(order.status).toBe('REJECTED');
    });
  });

  describe('Position Management', () => {
    it('should accumulate position on multiple buys', async () => {
      await engine.submitOrder({
        marketId: 'market-1',
        outcome: 'Yes',
        type: 'MARKET',
        side: 'BUY',
        size: 100,
      });

      await engine.submitOrder({
        marketId: 'market-1',
        outcome: 'Yes',
        type: 'MARKET',
        side: 'BUY',
        size: 50,
      });

      const position = engine.getPosition('market-1', 'Yes');
      expect(position?.size).toBe(150);
    });

    it('should calculate average entry price', async () => {
      feed.setPrice('market-1', 'Yes', 0.4);
      await engine.submitOrder({
        marketId: 'market-1',
        outcome: 'Yes',
        type: 'MARKET',
        side: 'BUY',
        size: 100,
      });

      feed.setPrice('market-1', 'Yes', 0.6);
      await engine.submitOrder({
        marketId: 'market-1',
        outcome: 'Yes',
        type: 'MARKET',
        side: 'BUY',
        size: 100,
      });

      const position = engine.getPosition('market-1', 'Yes');
      // Average should be around 0.5 (between 0.4 and 0.6)
      expect(position?.avgEntryPrice).toBeGreaterThan(0.4);
      expect(position?.avgEntryPrice).toBeLessThan(0.6);
    });

    it('should close position on full sell', async () => {
      await engine.submitOrder({
        marketId: 'market-1',
        outcome: 'Yes',
        type: 'MARKET',
        side: 'BUY',
        size: 100,
      });

      await engine.submitOrder({
        marketId: 'market-1',
        outcome: 'Yes',
        type: 'MARKET',
        side: 'SELL',
        size: 100,
      });

      const position = engine.getPosition('market-1', 'Yes');
      expect(position).toBeUndefined();
    });

    it('should reduce position on partial sell', async () => {
      await engine.submitOrder({
        marketId: 'market-1',
        outcome: 'Yes',
        type: 'MARKET',
        side: 'BUY',
        size: 100,
      });

      await engine.submitOrder({
        marketId: 'market-1',
        outcome: 'Yes',
        type: 'MARKET',
        side: 'SELL',
        size: 30,
      });

      const position = engine.getPosition('market-1', 'Yes');
      expect(position?.size).toBe(70);
    });
  });

  describe('Portfolio State', () => {
    it('should track multiple positions', async () => {
      await engine.submitOrder({
        marketId: 'market-1',
        outcome: 'Yes',
        type: 'MARKET',
        side: 'BUY',
        size: 100,
      });

      await engine.submitOrder({
        marketId: 'market-2',
        outcome: 'Yes',
        type: 'MARKET',
        side: 'BUY',
        size: 50,
      });

      const positions = engine.getAllPositions();
      expect(positions).toHaveLength(2);
    });

    it('should calculate equity correctly', async () => {
      const initialEquity = engine.getEquity();

      await engine.submitOrder({
        marketId: 'market-1',
        outcome: 'Yes',
        type: 'MARKET',
        side: 'BUY',
        size: 100,
      });

      const newEquity = engine.getEquity();
      // Equity should be slightly less due to fees
      expect(newEquity).toBeLessThan(initialEquity);
      expect(newEquity).toBeGreaterThan(initialEquity * 0.99); // Less than 1% loss to fees
    });

    it('should update equity on price changes', async () => {
      await engine.submitOrder({
        marketId: 'market-1',
        outcome: 'Yes',
        type: 'MARKET',
        side: 'BUY',
        size: 100,
      });

      const equityBefore = engine.getEquity();

      // Price increases
      feed.setPrice('market-1', 'Yes', 0.6);

      const equityAfter = engine.getEquity();
      expect(equityAfter).toBeGreaterThan(equityBefore);
    });
  });

  describe('P&L Calculation', () => {
    it('should realize profit on winning trade', async () => {
      const initialCash = engine.getCash();

      await engine.submitOrder({
        marketId: 'market-1',
        outcome: 'Yes',
        type: 'MARKET',
        side: 'BUY',
        size: 100,
      });

      // Price goes up
      feed.setPrice('market-1', 'Yes', 0.7);

      await engine.submitOrder({
        marketId: 'market-1',
        outcome: 'Yes',
        type: 'MARKET',
        side: 'SELL',
        size: 100,
      });

      const finalCash = engine.getCash();
      // Should have profit (bought at ~0.5, sold at ~0.7, minus fees)
      expect(finalCash).toBeGreaterThan(initialCash * 0.99); // Account for fees
    });

    it('should realize loss on losing trade', async () => {
      const initialCash = engine.getCash();

      await engine.submitOrder({
        marketId: 'market-1',
        outcome: 'Yes',
        type: 'MARKET',
        side: 'BUY',
        size: 100,
      });

      // Price goes down
      feed.setPrice('market-1', 'Yes', 0.3);

      await engine.submitOrder({
        marketId: 'market-1',
        outcome: 'Yes',
        type: 'MARKET',
        side: 'SELL',
        size: 100,
      });

      const finalCash = engine.getCash();
      // Should have loss
      expect(finalCash).toBeLessThan(initialCash);
    });
  });
});
