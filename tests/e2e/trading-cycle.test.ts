/**
 * trading-cycle.test.ts - E2E tests for complete trading cycle
 *
 * Tests the full flow from signal detection to position closure.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// Simplified types for E2E testing
interface Market {
  id: string;
  question: string;
  outcomes: string[];
}

interface PriceBar {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Signal {
  marketId: string;
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  strength: number;
  confidence: number;
}

interface Order {
  id: string;
  marketId: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  size: number;
  status: 'PENDING' | 'FILLED' | 'CANCELLED' | 'REJECTED';
  fillPrice?: number;
}

interface Position {
  marketId: string;
  outcome: string;
  size: number;
  avgEntryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
}

interface Trade {
  entryOrder: Order;
  exitOrder?: Order;
  pnl?: number;
  status: 'OPEN' | 'CLOSED';
}

// Simplified trading system for E2E testing
class TradingSystem {
  private cash: number;
  private positions: Map<string, Position> = new Map();
  private trades: Trade[] = [];
  private orderIdCounter = 0;

  constructor(initialCapital: number = 10000) {
    this.cash = initialCapital;
  }

  // Generate signal from price bars
  generateSignal(market: Market, priceBars: PriceBar[]): Signal | null {
    if (priceBars.length < 20) return null;

    const closes = priceBars.map(b => b.close);
    const recentCloses = closes.slice(-10);
    const olderCloses = closes.slice(-20, -10);

    const recentAvg = recentCloses.reduce((a, b) => a + b, 0) / recentCloses.length;
    const olderAvg = olderCloses.reduce((a, b) => a + b, 0) / olderCloses.length;

    const momentum = (recentAvg - olderAvg) / olderAvg;

    if (Math.abs(momentum) < 0.02) {
      return null;
    }

    return {
      marketId: market.id,
      direction: momentum > 0 ? 'LONG' : 'SHORT',
      strength: Math.min(1, Math.abs(momentum) * 5),
      confidence: 0.6 + Math.random() * 0.3,
    };
  }

  // Convert signal to order
  signalToOrder(signal: Signal, currentPrice: number): Order | null {
    if (signal.confidence < 0.5 || Math.abs(signal.strength) < 0.3) {
      return null;
    }

    const maxPositionValue = this.cash * 0.1;
    const size = maxPositionValue / currentPrice;

    return {
      id: `order-${++this.orderIdCounter}`,
      marketId: signal.marketId,
      outcome: signal.direction === 'LONG' ? 'Yes' : 'No',
      side: 'BUY',
      size,
      status: 'PENDING',
    };
  }

  // Execute order
  executeOrder(order: Order, currentPrice: number): Order {
    const value = order.size * currentPrice;
    const fee = value * 0.002;

    if (order.side === 'BUY' && value + fee > this.cash) {
      return { ...order, status: 'REJECTED' };
    }

    if (order.side === 'BUY') {
      this.cash -= (value + fee);

      const posKey = `${order.marketId}:${order.outcome}`;
      const existing = this.positions.get(posKey);

      if (existing) {
        const newSize = existing.size + order.size;
        const newAvg = (existing.avgEntryPrice * existing.size + currentPrice * order.size) / newSize;
        this.positions.set(posKey, {
          ...existing,
          size: newSize,
          avgEntryPrice: newAvg,
          currentPrice,
        });
      } else {
        this.positions.set(posKey, {
          marketId: order.marketId,
          outcome: order.outcome,
          size: order.size,
          avgEntryPrice: currentPrice,
          currentPrice,
          unrealizedPnl: 0,
        });
      }

      const filledOrder = { ...order, status: 'FILLED' as const, fillPrice: currentPrice };
      this.trades.push({ entryOrder: filledOrder, status: 'OPEN' });
      return filledOrder;
    }

    // Sell logic
    const posKey = `${order.marketId}:${order.outcome}`;
    const position = this.positions.get(posKey);

    if (!position || position.size < order.size) {
      return { ...order, status: 'REJECTED' };
    }

    this.cash += (value - fee);
    position.size -= order.size;

    const filledOrder = { ...order, status: 'FILLED' as const, fillPrice: currentPrice };

    // Find and close the trade
    const openTrade = this.trades.find(
      t => t.status === 'OPEN' && t.entryOrder.marketId === order.marketId
    );
    if (openTrade) {
      openTrade.exitOrder = filledOrder;
      openTrade.pnl = (currentPrice - (openTrade.entryOrder.fillPrice || 0)) * order.size - fee * 2;
      openTrade.status = 'CLOSED';
    }

    if (position.size <= 0) {
      this.positions.delete(posKey);
    }

    return filledOrder;
  }

  // Close position
  closePosition(marketId: string, outcome: string, currentPrice: number): Order | null {
    const posKey = `${marketId}:${outcome}`;
    const position = this.positions.get(posKey);

    if (!position || position.size <= 0) {
      return null;
    }

    const order: Order = {
      id: `order-${++this.orderIdCounter}`,
      marketId,
      outcome,
      side: 'SELL',
      size: position.size,
      status: 'PENDING',
    };

    return this.executeOrder(order, currentPrice);
  }

  // Get state
  getCash() { return this.cash; }
  getPositions() { return Array.from(this.positions.values()); }
  getTrades() { return this.trades; }
  getEquity(prices: Map<string, number>) {
    let posValue = 0;
    for (const pos of this.positions.values()) {
      const price = prices.get(`${pos.marketId}:${pos.outcome}`) || pos.currentPrice;
      posValue += pos.size * price;
    }
    return this.cash + posValue;
  }
}

describe('Trading Cycle E2E', () => {
  let system: TradingSystem;

  beforeEach(() => {
    system = new TradingSystem(10000);
  });

  describe('Full Trading Cycle', () => {
    it('should complete: signal -> order -> position -> close', () => {
      const market: Market = {
        id: 'market-e2e-1',
        question: 'Will event X happen?',
        outcomes: ['Yes', 'No'],
      };

      // Generate uptrend price data
      const priceBars: PriceBar[] = [];
      for (let i = 0; i < 30; i++) {
        priceBars.push({
          time: new Date(Date.now() - (30 - i) * 60000),
          open: 0.4 + i * 0.005,
          high: 0.41 + i * 0.005,
          low: 0.39 + i * 0.005,
          close: 0.4 + i * 0.005,
          volume: 1000,
        });
      }

      // Step 1: Generate signal
      const signal = system.generateSignal(market, priceBars);
      expect(signal).not.toBeNull();
      expect(signal?.direction).toBe('LONG');

      // Step 2: Convert to order
      const currentPrice = priceBars[priceBars.length - 1].close;
      const order = system.signalToOrder(signal!, currentPrice);

      if (order) {
        // Step 3: Execute order -> open position
        const filledOrder = system.executeOrder(order, currentPrice);
        expect(filledOrder.status).toBe('FILLED');

        const positions = system.getPositions();
        expect(positions).toHaveLength(1);
        expect(positions[0].outcome).toBe('Yes');

        // Step 4: Price increases
        const exitPrice = currentPrice + 0.1;

        // Step 5: Close position
        const closeOrder = system.closePosition(market.id, 'Yes', exitPrice);
        expect(closeOrder).not.toBeNull();
        expect(closeOrder?.status).toBe('FILLED');

        // Step 6: Verify position closed
        expect(system.getPositions()).toHaveLength(0);

        // Step 7: Verify trade recorded with P&L
        const trades = system.getTrades();
        const closedTrade = trades.find(t => t.status === 'CLOSED');
        expect(closedTrade).toBeDefined();
        expect(closedTrade?.pnl).toBeGreaterThan(0);
      }
    });

    it('should handle losing trade cycle', () => {
      const market: Market = {
        id: 'market-e2e-2',
        question: 'Will event Y happen?',
        outcomes: ['Yes', 'No'],
      };

      // Generate uptrend price data
      const priceBars: PriceBar[] = [];
      for (let i = 0; i < 30; i++) {
        priceBars.push({
          time: new Date(Date.now() - (30 - i) * 60000),
          open: 0.4 + i * 0.005,
          high: 0.41 + i * 0.005,
          low: 0.39 + i * 0.005,
          close: 0.4 + i * 0.005,
          volume: 1000,
        });
      }

      const signal = system.generateSignal(market, priceBars);
      const entryPrice = 0.55;
      const order = system.signalToOrder(signal!, entryPrice);

      if (order) {
        system.executeOrder(order, entryPrice);

        // Price drops
        const exitPrice = 0.45;
        system.closePosition(market.id, 'Yes', exitPrice);

        const trades = system.getTrades();
        const closedTrade = trades.find(t => t.status === 'CLOSED');
        expect(closedTrade?.pnl).toBeLessThan(0);
      }
    });

    it('should track multiple concurrent positions', () => {
      const markets: Market[] = [
        { id: 'market-a', question: 'Event A?', outcomes: ['Yes', 'No'] },
        { id: 'market-b', question: 'Event B?', outcomes: ['Yes', 'No'] },
        { id: 'market-c', question: 'Event C?', outcomes: ['Yes', 'No'] },
      ];

      // Open positions in all markets
      for (const market of markets) {
        const order: Order = {
          id: `order-${market.id}`,
          marketId: market.id,
          outcome: 'Yes',
          side: 'BUY',
          size: 100,
          status: 'PENDING',
        };
        system.executeOrder(order, 0.5);
      }

      expect(system.getPositions()).toHaveLength(3);

      // Close one position
      system.closePosition('market-b', 'Yes', 0.6);
      expect(system.getPositions()).toHaveLength(2);

      // Remaining positions should still be tracked
      const remaining = system.getPositions().map(p => p.marketId);
      expect(remaining).toContain('market-a');
      expect(remaining).toContain('market-c');
      expect(remaining).not.toContain('market-b');
    });

    it('should calculate equity correctly throughout cycle', () => {
      const initialEquity = system.getEquity(new Map());
      expect(initialEquity).toBe(10000);

      // Open position
      const order: Order = {
        id: 'order-1',
        marketId: 'market-1',
        outcome: 'Yes',
        side: 'BUY',
        size: 1000,
        status: 'PENDING',
      };
      system.executeOrder(order, 0.5);

      // Equity should be roughly the same (minus small fee)
      const prices = new Map([['market-1:Yes', 0.5]]);
      expect(system.getEquity(prices)).toBeLessThan(initialEquity);
      expect(system.getEquity(prices)).toBeGreaterThan(initialEquity * 0.99);

      // Price increases 20%
      prices.set('market-1:Yes', 0.6);
      expect(system.getEquity(prices)).toBeGreaterThan(initialEquity);
    });
  });

  describe('Edge Cases', () => {
    it('should handle insufficient funds', () => {
      const order: Order = {
        id: 'order-huge',
        marketId: 'market-1',
        outcome: 'Yes',
        side: 'BUY',
        size: 100000, // Way more than capital
        status: 'PENDING',
      };

      const result = system.executeOrder(order, 0.5);
      expect(result.status).toBe('REJECTED');
    });

    it('should handle closing non-existent position', () => {
      const result = system.closePosition('non-existent', 'Yes', 0.5);
      expect(result).toBeNull();
    });

    it('should handle neutral signals', () => {
      const market: Market = {
        id: 'market-flat',
        question: 'Flat market?',
        outcomes: ['Yes', 'No'],
      };

      // Flat price data
      const priceBars: PriceBar[] = [];
      for (let i = 0; i < 30; i++) {
        priceBars.push({
          time: new Date(),
          open: 0.5,
          high: 0.51,
          low: 0.49,
          close: 0.5,
          volume: 1000,
        });
      }

      const signal = system.generateSignal(market, priceBars);
      expect(signal).toBeNull();
    });
  });
});
