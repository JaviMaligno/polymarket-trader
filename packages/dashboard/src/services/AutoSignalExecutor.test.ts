import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../database/index.js', () => ({
  query: vi.fn(),
  isDatabaseConfigured: vi.fn(() => true),
}));

vi.mock('../database/repositories.js', () => ({
  paperTradesRepo: { create: vi.fn() },
  paperPositionsRepo: {
    getAll: vi.fn(),
    insert: vi.fn(),
    upsert: vi.fn(),
    openPositionAtomically: vi.fn().mockResolvedValue({ opened: true }),
  },
  signalPredictionsRepo: { create: vi.fn() },
  signalWeightsRepo: { get: vi.fn() },
}));

vi.mock('./PositionClosingService.js', () => {
  const { EventEmitter } = require('events');
  const mockService = new EventEmitter();
  mockService.close = vi.fn().mockResolvedValue({ executed: true, pnl: 0 });
  return {
    getPositionClosingService: vi.fn(() => mockService),
  };
});

vi.mock('./CircuitBreakerService.js', () => ({
  getCircuitBreakerService: vi.fn(() => ({
    isTradingHalted: vi.fn(() => false),
  })),
}));

vi.mock('./ExecutionRouter.js', () => ({
  getExecutionRouter: vi.fn(() => null),
}));

vi.mock('./OrderBookExecutionSimulator.js', () => ({
  OrderBookExecutionSimulator: class {
    simulateBuy = vi.fn().mockResolvedValue({
      executed: true, executedPrice: 0.50, executedSize: 10,
      slippagePct: 0.1, fee: 0.005, fillSource: 'estimated',
      snapshotAgeMs: null, availableDepth: 0,
      bestBid: null, bestAsk: null,
    });
    simulateSell = vi.fn().mockResolvedValue({
      executed: true, executedPrice: 0.50, executedSize: 10,
      slippagePct: 0.1, fee: 0.005, fillSource: 'estimated',
      snapshotAgeMs: null, availableDepth: 0,
      bestBid: null, bestAsk: null,
    });
  },
}));

import { query } from '../database/index.js';
import { paperPositionsRepo } from '../database/repositories.js';
import { getPositionClosingService } from './PositionClosingService.js';
import { AutoSignalExecutor, type SignalResult } from './AutoSignalExecutor.js';
import { getSignalSigmaCache, __resetSignalSigmaCacheForTests } from './SignalSigmaCache.js';

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

    it('should persist cooldown to trading_config on stop-loss', async () => {
      const closingService = getPositionClosingService();
      executor.registerStopLossCooldown(closingService as any);

      (closingService as any).emit('position:closed', { marketId: 'market-123', reason: 'stop_loss' });

      // query should have been called with INSERT INTO trading_config; key is passed as first param
      const calls = (query as any).mock.calls as [string, unknown[]][];
      const persistCall = calls.find(([sql, params]) =>
        sql.includes('trading_config') && Array.isArray(params) && params[0] === 'stoploss_cooldown:market-123'
      );
      expect(persistCall).toBeDefined();
    });

    it('should restore active cooldowns from trading_config on loadPersistedCooldowns', async () => {
      const futureUntil = Date.now() + 2 * 60 * 60 * 1000; // 2h from now
      (query as any).mockResolvedValueOnce({
        rows: [{ key: 'stoploss_cooldown:market-abc', value: JSON.stringify({ until: futureUntil }) }],
      });

      await executor.loadPersistedCooldowns();

      expect((executor as any).stoppedOutMarkets.has('market-abc')).toBe(true);
    });

    it('should skip expired cooldowns from trading_config on loadPersistedCooldowns', async () => {
      const pastUntil = Date.now() - 1000; // already expired
      (query as any).mockResolvedValueOnce({
        rows: [{ key: 'stoploss_cooldown:market-xyz', value: JSON.stringify({ until: pastUntil }) }],
      });

      await executor.loadPersistedCooldowns();

      expect((executor as any).stoppedOutMarkets.has('market-xyz')).toBe(false);
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

  // =========================================================
  // Per-market consecutive loss block
  // =========================================================
  describe('Per-market consecutive loss block', () => {
    it('should block new opens after 3 consecutive losses in a market', async () => {
      // First query: market metadata; second query: consecutive loss check returns 3 losing rows
      (query as any)
        .mockResolvedValueOnce({ rows: [{ is_active: true, is_resolved: false, end_date: null }] })
        .mockResolvedValueOnce({ rows: [
          { realized_pnl: '-5.00' },
          { realized_pnl: '-3.50' },
          { realized_pnl: '-8.00' },
        ] });
      (paperPositionsRepo.getAll as any).mockResolvedValue([]);

      const result = await executor.processSignal(makeSignal());
      expect(result.executed).toBe(false);
      expect(result.reason).toMatch(/last 3 closed positions all lost/i);
    });

    it('should allow new opens when fewer than 3 consecutive losses', async () => {
      // First query: market metadata; second query: only 2 losing rows (below threshold)
      (query as any)
        .mockResolvedValueOnce({ rows: [{ is_active: true, is_resolved: false, end_date: null }] })
        .mockResolvedValueOnce({ rows: [
          { realized_pnl: '-5.00' },
          { realized_pnl: '-3.50' },
        ] });
      (paperPositionsRepo.getAll as any).mockResolvedValue([]);

      const result = await executor.processSignal(makeSignal());
      // Should NOT be blocked for consecutive losses (may fail for other reasons)
      expect(result.reason || '').not.toMatch(/last 3 closed positions all lost/i);
    });

    it('should allow new opens when 3 positions exist but some are winning', async () => {
      // First query: market metadata; second query: 3 rows but one is a win
      (query as any)
        .mockResolvedValueOnce({ rows: [{ is_active: true, is_resolved: false, end_date: null }] })
        .mockResolvedValueOnce({ rows: [
          { realized_pnl: '-5.00' },
          { realized_pnl: '10.00' }, // winning trade breaks the streak
          { realized_pnl: '-3.50' },
        ] });
      (paperPositionsRepo.getAll as any).mockResolvedValue([]);

      const result = await executor.processSignal(makeSignal());
      expect(result.reason || '').not.toMatch(/last 3 closed positions all lost/i);
    });
  });

  // =========================================================
  // Long-term persistent loser ban (7-day window)
  // =========================================================
  describe('Long-term persistent loser ban', () => {
    it('should block market with ≥5 losses and <15% win rate in 7 days', async () => {
      // 1st: market metadata; 2nd: 24h consecutive check (0 rows - no short-term block);
      // 3rd: 7-day rate check (7 losses, 0 wins = 0% win rate)
      (query as any)
        .mockResolvedValueOnce({ rows: [{ is_active: true, is_resolved: false, end_date: null }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ losses: '7', wins: '0' }] });
      (paperPositionsRepo.getAll as any).mockResolvedValue([]);

      const result = await executor.processSignal(makeSignal());
      expect(result.executed).toBe(false);
      expect(result.reason).toMatch(/7-day window/i);
    });

    it('should not block when loss count is below threshold (< 5 losses)', async () => {
      (query as any)
        .mockResolvedValueOnce({ rows: [{ is_active: true, is_resolved: false, end_date: null }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ losses: '3', wins: '0' }] });
      (paperPositionsRepo.getAll as any).mockResolvedValue([]);

      const result = await executor.processSignal(makeSignal());
      expect(result.reason || '').not.toMatch(/7-day window/i);
    });

    it('should not block when win rate is at or above 15% threshold', async () => {
      // 7 losses, 2 wins = 22% win rate — above the 15% threshold
      (query as any)
        .mockResolvedValueOnce({ rows: [{ is_active: true, is_resolved: false, end_date: null }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ losses: '7', wins: '2' }] });
      (paperPositionsRepo.getAll as any).mockResolvedValue([]);

      const result = await executor.processSignal(makeSignal());
      expect(result.reason || '').not.toMatch(/7-day window/i);
    });

    it('should not block when 24h consecutive check already triggered', async () => {
      // 24h check fires first — 7-day check is never reached
      (query as any)
        .mockResolvedValueOnce({ rows: [{ is_active: true, is_resolved: false, end_date: null }] })
        .mockResolvedValueOnce({ rows: [
          { realized_pnl: '-5.00' },
          { realized_pnl: '-3.50' },
          { realized_pnl: '-8.00' },
        ] });
      (paperPositionsRepo.getAll as any).mockResolvedValue([]);

      const result = await executor.processSignal(makeSignal());
      expect(result.executed).toBe(false);
      expect(result.reason).toMatch(/last 3 closed positions all lost/i);
    });
  });

  // =========================================================
  // SHORT YES-price gate (asymmetric entry filter)
  //
  // Rationale: empirical analysis (5 days, 24 SHORTs) showed 0% win rate when
  // SHORTs entered against high-consensus markets (YES > 0.6). The consensus
  // does not flip in our 60-min hold window; NO token decays from spread/fees.
  // Block SHORT entries when YES price > shortMaxYesPrice. LONG unaffected.
  // For SHORT signals, signal.price is the NO token price → YES = 1 - signal.price.
  // =========================================================
  describe('SHORT YES-price gate', () => {
    it('should reject SHORT when YES consensus is too strong (YES > 0.6)', async () => {
      mockMarketQuery();
      // SHORT at NO=0.30 → YES=0.70 (consensus too strong)
      const result = await executor.processSignal(makeSignal({ direction: 'short', price: 0.30 }));
      expect(result.executed).toBe(false);
      expect(result.reason).toMatch(/SHORT blocked.*consensus/i);
    });

    it('should allow SHORT when YES consensus is moderate (YES <= 0.6)', async () => {
      mockMarketQuery();
      // SHORT at NO=0.45 → YES=0.55 (within threshold)
      const result = await executor.processSignal(makeSignal({ direction: 'short', price: 0.45 }));
      expect(result.reason || '').not.toMatch(/SHORT blocked.*consensus/i);
    });

    it('should NOT gate LONG signals (gate is SHORT-only)', async () => {
      mockMarketQuery();
      // LONG at YES=0.70 — would be rejected if gate applied to LONG
      const result = await executor.processSignal(makeSignal({ direction: 'long', price: 0.70 }));
      expect(result.reason || '').not.toMatch(/SHORT blocked/i);
    });

    it('should respect custom shortMaxYesPrice threshold via config', async () => {
      const strictExecutor = new AutoSignalExecutor({ enabled: true, cooldownMs: 0, shortMaxYesPrice: 0.5 });
      mockMarketQuery();
      // SHORT at NO=0.45 → YES=0.55, exceeds custom threshold 0.5
      const result = await strictExecutor.processSignal(makeSignal({ direction: 'short', price: 0.45 }));
      expect(result.executed).toBe(false);
      expect(result.reason).toMatch(/SHORT blocked.*consensus/i);
    });
  });

  // =========================================================
  // Asymmetric position sizing (LONG vs SHORT)
  //
  // Rationale: SHORTs lose 0% win rate empirically (24/24 losing in 5 days).
  // Until Learning Service identifies winning SHORT segments, halve SHORT
  // position size to limit damage while still collecting data. LONG sizing
  // unaffected.
  // =========================================================
  describe('Asymmetric SHORT position sizing', () => {
    function fullMockChain() {
      // Route queries by SQL content so order/optional queries don't break the chain
      (query as any).mockImplementation((sql: string) => {
        if (sql.includes('FROM markets WHERE id')) {
          return Promise.resolve({ rows: [{ is_active: true, is_resolved: false, end_date: null }] });
        }
        if (sql.includes('FROM paper_account')) {
          return Promise.resolve({ rows: [{ available_capital: '100000', current_capital: '10000' }] });
        }
        if (sql.includes('market_score') && sql.includes('current_price_yes')) {
          return Promise.resolve({ rows: [{ market_score: '0.5', current_price_yes: '0.5', volume_24h: '1000', spread: '0.01', end_date: null }] });
        }
        // Loss check, predictions insert, etc — return empty
        return Promise.resolve({ rows: [] });
      });
    }

    it('should size SHORT positions smaller than LONG at same price (default 0.5x)', async () => {
      const exec = new AutoSignalExecutor({ enabled: true, cooldownMs: 0 });
      const simSpy = vi.spyOn((exec as any).simulator, 'simulateBuy');

      // Same price for both, only direction differs — isolates the side multiplier
      fullMockChain();
      await exec.processSignal(makeSignal({ direction: 'long', price: 0.50 }));
      const longShares = Number(simSpy.mock.calls[0]?.[2] ?? 0);

      fullMockChain();
      await exec.processSignal(makeSignal({ direction: 'short', price: 0.50, tokenId: 'token-no' }));
      const shortShares = Number(simSpy.mock.calls[1]?.[2] ?? 0);

      expect(longShares).toBeGreaterThan(0);
      expect(shortShares).toBeGreaterThan(0);
      // SHORT should be ~50% of LONG (default 0.5 multiplier)
      expect(shortShares).toBeLessThan(longShares * 0.6);
      expect(shortShares).toBeGreaterThan(longShares * 0.4);
    });

    it('should respect custom shortSizeMultiplier via config', async () => {
      const exec = new AutoSignalExecutor({ enabled: true, cooldownMs: 0, shortSizeMultiplier: 0.25 });
      const simSpy = vi.spyOn((exec as any).simulator, 'simulateBuy');
      fullMockChain();
      await exec.processSignal(makeSignal({ direction: 'short', price: 0.50, tokenId: 'token-no' }));
      const shortSharesQuarter = Number(simSpy.mock.calls[0]?.[2] ?? 0);

      const exec2 = new AutoSignalExecutor({ enabled: true, cooldownMs: 0 });
      const simSpy2 = vi.spyOn((exec2 as any).simulator, 'simulateBuy');
      fullMockChain();
      await exec2.processSignal(makeSignal({ direction: 'short', price: 0.50, tokenId: 'token-no' }));
      const shortSharesHalf = Number(simSpy2.mock.calls[0]?.[2] ?? 0);

      // 0.25x should produce ~half the shares of 0.5x
      expect(shortSharesQuarter).toBeGreaterThan(0);
      expect(shortSharesQuarter).toBeLessThan(shortSharesHalf);
    });

    it('should NOT alter LONG sizing regardless of shortSizeMultiplier', async () => {
      const exec = new AutoSignalExecutor({ enabled: true, cooldownMs: 0, shortSizeMultiplier: 0.1 });
      const simSpy = vi.spyOn((exec as any).simulator, 'simulateBuy');
      fullMockChain();
      await exec.processSignal(makeSignal({ direction: 'long', price: 0.30 }));
      const longSharesA = Number(simSpy.mock.calls[0]?.[2] ?? 0);

      const exec2 = new AutoSignalExecutor({ enabled: true, cooldownMs: 0, shortSizeMultiplier: 0.5 });
      const simSpy2 = vi.spyOn((exec2 as any).simulator, 'simulateBuy');
      fullMockChain();
      await exec2.processSignal(makeSignal({ direction: 'long', price: 0.30 }));
      const longSharesB = Number(simSpy2.mock.calls[0]?.[2] ?? 0);

      expect(longSharesA).toBe(longSharesB);
    });
  });

  // =========================================================
  // Drawdown proximity check uses equity (capital + open positions)
  // =========================================================
  describe('Drawdown proximity check', () => {
    it('blocks new opens when equity drawdown exceeds CB_THRESHOLD - 2', async () => {
      const exec = new AutoSignalExecutor({ enabled: true, cooldownMs: 0 });
      (query as any).mockImplementation((sql: string) => {
        if (sql.includes('FROM markets WHERE id')) {
          return Promise.resolve({ rows: [{ is_active: true, is_resolved: false, end_date: null }] });
        }
        if (sql.includes('FROM paper_account')) {
          // Capital $8649 with initial $10000 → capital drawdown 13.51% > 15-2=13%
          return Promise.resolve({ rows: [{ available_capital: '8549', current_capital: '8649' }] });
        }
        if (sql.includes('FROM paper_positions WHERE closed_at IS NULL')) {
          // No open positions → equity == capital → equity drawdown also 13.51%
          return Promise.resolve({ rows: [{ total_exposure: '0' }] });
        }
        return Promise.resolve({ rows: [] });
      });
      const result = await exec.processSignal(makeSignal({ direction: 'long', price: 0.50 }));
      expect(result.executed).toBe(false);
      expect(result.reason).toMatch(/drawdown.*too close/i);
    });

    it('allows new opens when equity drawdown is below CB_THRESHOLD - 2 even if capital-only exceeds it', async () => {
      const exec = new AutoSignalExecutor({ enabled: true, cooldownMs: 0 });
      (query as any).mockImplementation((sql: string) => {
        if (sql.includes('FROM markets WHERE id')) {
          return Promise.resolve({ rows: [{ is_active: true, is_resolved: false, end_date: null }] });
        }
        if (sql.includes('FROM paper_account')) {
          // Capital $8649: capital-only drawdown = 13.51% > 13% (would block without equity fix)
          return Promise.resolve({ rows: [{ available_capital: '8549', current_capital: '8649' }] });
        }
        if (sql.includes('FROM paper_positions WHERE closed_at IS NULL')) {
          // Open position worth $200: equity = $8849, equity drawdown = 11.51% < 13% → allow
          return Promise.resolve({ rows: [{ total_exposure: '200' }] });
        }
        if (sql.includes('market_score') && sql.includes('current_price_yes')) {
          return Promise.resolve({ rows: [{ market_score: '0.5', current_price_yes: '0.5', volume_24h: '1000', spread: '0.01', end_date: null }] });
        }
        return Promise.resolve({ rows: [] });
      });
      const result = await exec.processSignal(makeSignal({ direction: 'long', price: 0.50 }));
      expect(result.reason).not.toMatch(/drawdown.*too close/i);
    });
  });

  // =========================================================
  // T11: direction multiplier + exploration flag propagation
  // =========================================================
  describe('AutoSignalExecutor — direction multiplier propagation', () => {
    function fullMockChain() {
      (query as any).mockImplementation((sql: string) => {
        if (sql.includes('FROM markets WHERE id')) {
          return Promise.resolve({ rows: [{ is_active: true, is_resolved: false, end_date: null }] });
        }
        if (sql.includes('FROM paper_account')) {
          return Promise.resolve({ rows: [{ available_capital: '100000', current_capital: '10000' }] });
        }
        if (sql.includes('market_score') && sql.includes('current_price_yes')) {
          return Promise.resolve({ rows: [{ market_score: '0.5', current_price_yes: '0.5', volume_24h: '1000', spread: '0.01', end_date: null }] });
        }
        return Promise.resolve({ rows: [] });
      });
    }

    function buildCombinedSignal(overrides: Partial<SignalResult> & { appliedDirectionMultiplier?: number; wasExploration?: boolean }): SignalResult {
      const { appliedDirectionMultiplier, wasExploration, ...rest } = overrides;
      const base = makeSignal(rest);
      return {
        ...base,
        ...(appliedDirectionMultiplier !== undefined ? { appliedDirectionMultiplier } : {}),
        ...(wasExploration !== undefined ? { wasExploration } : {}),
      } as SignalResult;
    }

    function buildExecutor() {
      return new AutoSignalExecutor({ enabled: true, cooldownMs: 0 });
    }

    it('passes appliedDirectionMultiplier and wasExploration to paperPositionsRepo', async () => {
      const openSpy = vi.spyOn(paperPositionsRepo, 'openPositionAtomically')
        .mockResolvedValue({ opened: true });
      fullMockChain();
      const signal = buildCombinedSignal({
        direction: 'long',
        strength: 0.4,
        confidence: 0.7,
        appliedDirectionMultiplier: 0.75,
        wasExploration: true,
      });
      const executor = buildExecutor();
      await executor.processSignal(signal);
      expect(openSpy).toHaveBeenCalledTimes(1);
      const positionArg = openSpy.mock.calls[0][0];
      expect(positionArg.applied_direction_multiplier).toBe(0.75);
      expect(positionArg.was_exploration).toBe(true);
      openSpy.mockRestore();
    });

    it('defaults both fields to null/false when signal omits them', async () => {
      const openSpy = vi.spyOn(paperPositionsRepo, 'openPositionAtomically')
        .mockResolvedValue({ opened: true });
      fullMockChain();
      const signal = buildCombinedSignal({ direction: 'long', strength: 0.4, confidence: 0.7 });
      const executor = buildExecutor();
      await executor.processSignal(signal);
      expect(openSpy).toHaveBeenCalledTimes(1);
      const positionArg = openSpy.mock.calls[0][0];
      expect(positionArg.applied_direction_multiplier ?? null).toBeNull();
      expect(positionArg.was_exploration ?? false).toBe(false);
      openSpy.mockRestore();
    });
  });

  // =========================================================
  // Task 5: Concentration gate (same-direction re-entry filter)
  // =========================================================
  describe('Concentration gate', () => {
    beforeEach(() => {
      __resetSignalSigmaCacheForTests();
      // Pre-populate cache via direct getter mutation (test-only)
      const cache = getSignalSigmaCache();
      (cache as any).sigmas = new Map([
        ['event_financial', 0.353],
      ]);
    });

    it('blocks same-direction re-entry with weaker conviction than prev close', async () => {
      // Mock chain: market query (1st), consecutive-loss check (2nd, empty),
      // long-term loser ban (3rd, empty), prev-close signal (4th)
      (query as any)
        .mockResolvedValueOnce({ rows: [{ is_active: true, is_resolved: false, end_date: null, market_type: 'event_financial' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ losses: '0', wins: '0' }] })
        .mockResolvedValueOnce({
          rows: [{ direction: 'short', strength: '-0.5', confidence: '0.8' }], // prev close: |s×c| = 0.40
        });

      const signal = makeSignal({ direction: 'short', strength: -0.4, confidence: 0.6 }); // |s×c| = 0.24
      const result = await executor.processSignal(signal);

      expect(result.executed).toBe(false);
      expect(result.reason).toMatch(/Same-direction re-entry conviction/i);
      expect(result.reason).toMatch(/0\.240/); // newSxC in reason
      expect(result.reason).toMatch(/event_financial/);
    });

    it('allows same-direction re-entry when conviction is ≥ 1σ stronger', async () => {
      (query as any)
        .mockResolvedValueOnce({ rows: [{ is_active: true, is_resolved: false, end_date: null, market_type: 'event_financial' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ losses: '0', wins: '0' }] })
        .mockResolvedValueOnce({
          rows: [{ direction: 'short', strength: '-0.5', confidence: '0.8' }], // prev: 0.40
        });

      const signal = makeSignal({ direction: 'short', strength: -0.95, confidence: 0.9 }); // 0.855 > 0.40+0.353
      const result = await executor.processSignal(signal);

      if (!result.executed) {
        expect(result.reason).not.toMatch(/Same-direction re-entry conviction/i);
      }
    });

    it('allows direction flip regardless of conviction', async () => {
      (query as any)
        .mockResolvedValueOnce({ rows: [{ is_active: true, is_resolved: false, end_date: null, market_type: 'event_financial' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ losses: '0', wins: '0' }] })
        .mockResolvedValueOnce({
          rows: [{ direction: 'short', strength: '-0.8', confidence: '0.9' }], // prev: 0.72 (very strong)
        });

      const signal = makeSignal({ direction: 'long', strength: 0.3, confidence: 0.5 }); // weak but flipped
      const result = await executor.processSignal(signal);

      if (!result.executed) {
        expect(result.reason).not.toMatch(/Same-direction re-entry conviction/i);
      }
    });

    it('allows when no prior close on this market exists', async () => {
      (query as any)
        .mockResolvedValueOnce({ rows: [{ is_active: true, is_resolved: false, end_date: null, market_type: 'event_financial' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ losses: '0', wins: '0' }] })
        .mockResolvedValueOnce({ rows: [] }); // no prev close

      const signal = makeSignal({ direction: 'long', strength: 0.3, confidence: 0.5 });
      const result = await executor.processSignal(signal);

      if (!result.executed) {
        expect(result.reason).not.toMatch(/Same-direction re-entry conviction/i);
      }
    });

    it('uses 0.3 fallback σ for unknown market_type', async () => {
      (query as any)
        .mockResolvedValueOnce({ rows: [{ is_active: true, is_resolved: false, end_date: null, market_type: 'event_long' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ losses: '0', wins: '0' }] })
        .mockResolvedValueOnce({
          rows: [{ direction: 'short', strength: '-0.5', confidence: '0.8' }], // prev: 0.40
        });

      // With σ = 0.3 (fallback), threshold = 0.40 + 0.3 = 0.70
      // signal s×c = 0.65 → block
      const signal = makeSignal({ direction: 'short', strength: -0.65, confidence: 1.0 });
      const result = await executor.processSignal(signal);

      expect(result.executed).toBe(false);
      expect(result.reason).toMatch(/Same-direction re-entry conviction/i);
      expect(result.reason).toMatch(/event_long/);
    });
  });
});
