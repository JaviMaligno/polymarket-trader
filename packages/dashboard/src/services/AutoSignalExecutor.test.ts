import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../database/index.js', () => ({
  query: vi.fn(),
  isDatabaseConfigured: vi.fn(() => true),
}));

vi.mock('../database/repositories.js', () => ({
  paperTradesRepo: { create: vi.fn() },
  paperPositionsRepo: { getAll: vi.fn(), upsert: vi.fn() },
  signalPredictionsRepo: { create: vi.fn() },
  signalWeightsRepo: { get: vi.fn() },
}));

vi.mock('./PositionClosingService.js', () => {
  const { EventEmitter } = require('events');
  const mockService = new EventEmitter();
  mockService.close = vi.fn();
  return {
    getPositionClosingService: vi.fn(() => mockService),
  };
});

vi.mock('./CircuitBreakerService.js', () => ({
  getCircuitBreakerService: vi.fn(() => ({
    isTradingHalted: vi.fn(() => false),
  })),
}));

import { query } from '../database/index.js';
import { paperPositionsRepo } from '../database/repositories.js';
import { getPositionClosingService } from './PositionClosingService.js';
import { AutoSignalExecutor, type SignalResult } from './AutoSignalExecutor.js';

const makeSignal = (overrides?: Partial<SignalResult>): SignalResult => ({
  signalId: 'momentum',
  marketId: 'market-123',
  tokenId: 'token-yes',
  direction: 'long',
  strength: 0.8,
  confidence: 0.7,
  price: 0.50,
  ...overrides,
});

function mockMarketQuery(overrides?: { is_active?: boolean; is_resolved?: boolean; end_date?: string | null }) {
  const defaults = { is_active: true, is_resolved: false, end_date: null, ...overrides };
  (query as any).mockResolvedValue({ rows: [defaults] });
}

describe('AutoSignalExecutor', () => {
  let executor: AutoSignalExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new AutoSignalExecutor({ enabled: true, cooldownMs: 0 });
    (paperPositionsRepo.getAll as any).mockResolvedValue([]);
  });

  // =========================================================
  // Task 3: Stop-loss re-entry cooldown
  // =========================================================
  describe('Stop-loss cooldown', () => {
    it('should reject signal for a market in stop-loss cooldown', async () => {
      mockMarketQuery();
      const closingService = getPositionClosingService();
      executor.registerStopLossCooldown(closingService as any);

      // Simulate a stop-loss close event
      (closingService as any).emit('position:closed', { marketId: 'market-123', reason: 'stop_loss' });

      const result = await executor.processSignal(makeSignal());
      expect(result.executed).toBe(false);
      expect(result.reason).toMatch(/stop-loss cooldown/i);
    });

    it('should allow signal after cooldown expires', async () => {
      mockMarketQuery();
      const closingService = getPositionClosingService();
      executor.registerStopLossCooldown(closingService as any);

      // Manually set an old timestamp (5 hours ago, cooldown is 4h)
      (executor as any).stoppedOutMarkets.set('market-123', Date.now() - 5 * 60 * 60 * 1000);

      // The signal should pass the stop-loss cooldown check (may fail later, that's fine)
      const result = await executor.processSignal(makeSignal());
      // It should NOT be rejected for stop-loss cooldown
      expect(result.reason).not.toMatch(/stop-loss cooldown/i);
    });

    it('should not cooldown for non-stop-loss closes', async () => {
      mockMarketQuery();
      const closingService = getPositionClosingService();
      executor.registerStopLossCooldown(closingService as any);

      // Emit a non-stop-loss close
      (closingService as any).emit('position:closed', { marketId: 'market-123', reason: 'signal' });

      // The market should NOT be in cooldown
      const result = await executor.processSignal(makeSignal());
      expect(result.reason).not.toMatch(/stop-loss cooldown/i);
    });
  });

  // =========================================================
  // Task 4: Per-market position concentration limit
  // =========================================================
  describe('Per-market concentration limit', () => {
    it('should reject when market has 2+ open positions', async () => {
      mockMarketQuery();
      (paperPositionsRepo.getAll as any).mockResolvedValue([
        { market_id: 'market-123', token_id: 'token-a', size: '10', side: 'long', avg_entry_price: '0.50' },
        { market_id: 'market-123', token_id: 'token-b', size: '5', side: 'long', avg_entry_price: '0.50' },
      ]);

      const result = await executor.processSignal(makeSignal());
      expect(result.executed).toBe(false);
      expect(result.reason).toMatch(/market position limit/i);
    });

    it('should allow when market has fewer than limit', async () => {
      mockMarketQuery();
      (paperPositionsRepo.getAll as any).mockResolvedValue([
        { market_id: 'market-123', token_id: 'token-a', size: '10', side: 'long', avg_entry_price: '0.50' },
      ]);

      // This should pass the concentration check (may fail later for other reasons)
      const result = await executor.processSignal(makeSignal());
      expect(result.reason).not.toMatch(/market position limit/i);
    });
  });

  // =========================================================
  // Task 5: Near-resolution market protection
  // =========================================================
  describe('Near-resolution protection', () => {
    it('should reject mean_reversion signals on near-resolution markets', async () => {
      const sixHoursFromNow = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
      mockMarketQuery({ end_date: sixHoursFromNow });

      const result = await executor.processSignal(makeSignal({
        signalId: 'mean_reversion',
        confidence: 0.90,
      }));
      expect(result.executed).toBe(false);
      expect(result.reason).toMatch(/mean_reversion.*near-resolution/i);
    });

    it('should reject weak signals on near-resolution markets', async () => {
      const sixHoursFromNow = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
      mockMarketQuery({ end_date: sixHoursFromNow });

      const result = await executor.processSignal(makeSignal({
        signalId: 'momentum',
        confidence: 0.50,
      }));
      expect(result.executed).toBe(false);
      expect(result.reason).toMatch(/insufficient confidence.*near-resolution/i);
    });

    it('should allow strong momentum on near-resolution markets', async () => {
      const sixHoursFromNow = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
      mockMarketQuery({ end_date: sixHoursFromNow });

      const result = await executor.processSignal(makeSignal({
        signalId: 'momentum',
        confidence: 0.80,
      }));
      // Should NOT be rejected for near-resolution reasons
      expect(result.reason).not.toMatch(/near-resolution/i);
    });

    it('should pass markets with null end_date', async () => {
      mockMarketQuery({ end_date: null });

      const result = await executor.processSignal(makeSignal());
      expect(result.reason).not.toMatch(/near-resolution/i);
    });

    it('should pass markets resolving in >24h', async () => {
      const fortyEightHoursFromNow = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      mockMarketQuery({ end_date: fortyEightHoursFromNow });

      const result = await executor.processSignal(makeSignal());
      expect(result.reason).not.toMatch(/near-resolution/i);
    });
  });

  describe('Circuit breaker integration', () => {
    it('should reject signals when circuit breaker is halted', async () => {
      const { getCircuitBreakerService } = await import('./CircuitBreakerService.js');
      vi.mocked(getCircuitBreakerService).mockReturnValue({
        isTradingHalted: vi.fn(() => true),
      } as any);

      const executor = new AutoSignalExecutor();
      mockMarketQuery();

      const result = await executor.processSignal(makeSignal());
      expect(result.executed).toBe(false);
      expect(result.reason).toContain('circuit breaker');
    });
  });

  // =========================================================
  // Bug fix: end_date_iso → end_date column name
  // =========================================================
  describe('Near-resolution uses end_date column (not end_date_iso)', () => {
    it('should reject mean_reversion when end_date is within 24h', async () => {
      // Ensure circuit breaker is not halted (previous test may have mutated mock)
      const { getCircuitBreakerService } = await import('./CircuitBreakerService.js');
      vi.mocked(getCircuitBreakerService).mockReturnValue({
        isTradingHalted: vi.fn(() => false),
      } as any);

      const twelveHoursFromNow = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
      // Only set end_date (the real DB column), NOT end_date_iso
      mockMarketQuery({ end_date: twelveHoursFromNow });

      const result = await executor.processSignal(makeSignal({
        signalId: 'mean_reversion',
        confidence: 0.90,
      }));
      expect(result.executed).toBe(false);
      expect(result.reason).toMatch(/mean_reversion.*near-resolution/i);
    });
  });

  describe('Per-market limit allows closes', () => {
    it('should allow SHORT close even when market is at position limit', async () => {
      const executor = new AutoSignalExecutor();
      mockMarketQuery();

      // 2 existing positions on same market (at limit)
      vi.mocked(paperPositionsRepo.getAll).mockResolvedValue([
        { market_id: 'market-123', token_id: 'token-yes', size: 50, side: 'long', avg_entry_price: 0.40 } as any,
        { market_id: 'market-123', token_id: 'token-no', size: 30, side: 'short', avg_entry_price: 0.60 } as any,
      ]);

      // SHORT signal should be able to close the existing position
      const result = await executor.processSignal(makeSignal({ direction: 'short' }));
      // Should NOT be rejected for market position limit
      expect(result.reason || '').not.toContain('market position limit');
    });
  });
});
