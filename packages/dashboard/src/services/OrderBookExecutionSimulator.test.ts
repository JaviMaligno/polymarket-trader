import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../database/index.js', () => ({
  query: vi.fn(),
}));

import { query } from '../database/index.js';
import { OrderBookExecutionSimulator } from './OrderBookExecutionSimulator.js';

const mockQuery = vi.mocked(query);

describe('OrderBookExecutionSimulator', () => {
  let simulator: OrderBookExecutionSimulator;

  beforeEach(() => {
    vi.clearAllMocks();
    simulator = new OrderBookExecutionSimulator();
  });

  describe('walkTheBook', () => {
    it('computes correct avg price walking multiple ask levels', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          best_bid: '0.86', best_ask: '0.87', spread: '0.01',
          asks: JSON.stringify([
            { price: '0.87', size: '50' },
            { price: '0.88', size: '100' },
            { price: '0.89', size: '200' },
          ]),
          bids: JSON.stringify([
            { price: '0.86', size: '80' },
            { price: '0.85', size: '150' },
          ]),
          ask_depth_10pct: '350',
          bid_depth_10pct: '230',
          snapshot_age_ms: '5000',
        }],
        rowCount: 1,
      } as any);

      const result = await simulator.simulateBuy('m1', 't1', 219, 0.87);

      expect(result.executed).toBe(true);
      expect(result.fillSource).toBe('orderbook');
      expect(result.executedSize).toBe(219);
      // 50*0.87 + 100*0.88 + 69*0.89 = 43.5 + 88 + 61.41 = 192.91
      // avg = 192.91 / 219 = 0.8808...
      expect(result.executedPrice).toBeCloseTo(0.881, 2);
      expect(result.slippagePct).toBeGreaterThan(0);
      expect(result.bestAsk).toBe(0.87);
      expect(result.availableDepth).toBe(350);
    });

    it('returns partial fill when book depth insufficient', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          best_bid: '0.86', best_ask: '0.87', spread: '0.01',
          asks: JSON.stringify([
            { price: '0.87', size: '30' },
            { price: '0.88', size: '20' },
          ]),
          bids: JSON.stringify([]),
          ask_depth_10pct: '50',
          bid_depth_10pct: '0',
          snapshot_age_ms: '2000',
        }],
        rowCount: 1,
      } as any);

      const result = await simulator.simulateBuy('m1', 't1', 200, 0.87);

      expect(result.executed).toBe(true);
      expect(result.executedSize).toBe(50);
      expect(result.fillSource).toBe('orderbook');
    });

    it('rejects when partial fill < 50% of requested', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          best_bid: '0.86', best_ask: '0.87', spread: '0.01',
          asks: JSON.stringify([
            { price: '0.87', size: '10' },
          ]),
          bids: JSON.stringify([]),
          ask_depth_10pct: '10',
          bid_depth_10pct: '0',
          snapshot_age_ms: '3000',
        }],
        rowCount: 1,
      } as any);

      const result = await simulator.simulateBuy('m1', 't1', 200, 0.87);

      expect(result.executed).toBe(false);
      expect(result.rejectReason).toContain('insufficient');
    });

    it('rejects when slippage exceeds 5%', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          best_bid: '0.50', best_ask: '0.51', spread: '0.01',
          asks: JSON.stringify([
            { price: '0.51', size: '5' },
            { price: '0.60', size: '5' },
            { price: '0.70', size: '500' },
          ]),
          bids: JSON.stringify([]),
          ask_depth_10pct: '510',
          bid_depth_10pct: '0',
          snapshot_age_ms: '1000',
        }],
        rowCount: 1,
      } as any);

      const result = await simulator.simulateBuy('m1', 't1', 100, 0.51);

      expect(result.executed).toBe(false);
      expect(result.rejectReason).toContain('slippage');
    });

    it('simulateSell walks bids descending', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          best_bid: '0.86', best_ask: '0.87', spread: '0.01',
          asks: JSON.stringify([]),
          bids: JSON.stringify([
            { price: '0.86', size: '100' },
            { price: '0.85', size: '100' },
          ]),
          ask_depth_10pct: '0',
          bid_depth_10pct: '200',
          snapshot_age_ms: '4000',
        }],
        rowCount: 1,
      } as any);

      const result = await simulator.simulateSell('m1', 't1', 150, 0.86);

      expect(result.executed).toBe(true);
      expect(result.fillSource).toBe('orderbook');
      // 100*0.86 + 50*0.85 = 86 + 42.5 = 128.5 / 150 = 0.8567
      expect(result.executedPrice).toBeCloseTo(0.857, 2);
    });
  });

  describe('estimated mode', () => {
    it('uses proportional model when no snapshot exists', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      mockQuery.mockResolvedValueOnce({
        rows: [{ volume_24h: '50000' }],
        rowCount: 1,
      } as any);

      const result = await simulator.simulateBuy('m1', 't1', 219, 0.50);

      expect(result.executed).toBe(true);
      expect(result.fillSource).toBe('estimated');
      expect(result.executedPrice).toBeGreaterThan(0.50);
      expect(result.slippagePct).toBeGreaterThanOrEqual(1.0);
      expect(result.snapshotAgeMs).toBeNull();
    });

    it('uses estimated when snapshot too old', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          best_bid: '0.86', best_ask: '0.87', spread: '0.01',
          asks: JSON.stringify([{ price: '0.87', size: '100' }]),
          bids: JSON.stringify([]),
          ask_depth_10pct: '100',
          bid_depth_10pct: '0',
          snapshot_age_ms: '120000',
        }],
        rowCount: 1,
      } as any);
      mockQuery.mockResolvedValueOnce({
        rows: [{ volume_24h: '50000' }],
        rowCount: 1,
      } as any);

      const result = await simulator.simulateBuy('m1', 't1', 100, 0.87);
      expect(result.fillSource).toBe('estimated');
    });

    it('rejects when no snapshot AND no volume data', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await simulator.simulateBuy('m1', 't1', 100, 0.50);

      expect(result.executed).toBe(false);
      expect(result.rejectReason).toContain('no market data');
    });
  });
});
