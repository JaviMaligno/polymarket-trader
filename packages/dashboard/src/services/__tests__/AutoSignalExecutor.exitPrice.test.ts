import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mutable refs so individual tests can override query behaviour
const simulateSell = vi.fn().mockResolvedValue({
  executed: true, executedPrice: 0.16, executedSize: 100,
  slippagePct: 0.0, fee: 0.00016, fillSource: 'estimated',
  snapshotAgeMs: null, availableDepth: 0,
  bestBid: null, bestAsk: null,
});

vi.mock('../../database/index.js', () => ({
  isDatabaseConfigured: () => true,
  query: vi.fn(),
}));

vi.mock('../../database/repositories.js', () => ({
  paperTradesRepo: { create: vi.fn() },
  paperPositionsRepo: {
    getAll: vi.fn(),
  },
  signalPredictionsRepo: { create: vi.fn().mockResolvedValue({ id: 1 }) },
  signalWeightsRepo: { get: vi.fn().mockResolvedValue({ weight: 1.0 }) },
}));

vi.mock('../PositionClosingService.js', () => ({
  getPositionClosingService: () => ({
    close: vi.fn().mockResolvedValue({ executed: true, netPnl: 5.0, tradeId: '42' }),
  }),
}));

vi.mock('../CircuitBreakerService.js', () => ({
  getCircuitBreakerService: () => ({ isTradingHalted: () => false }),
}));

vi.mock('../ExecutionRouter.js', () => ({
  getExecutionRouter: () => null,
}));

vi.mock('../OrderBookExecutionSimulator.js', () => ({
  OrderBookExecutionSimulator: class {
    simulateBuy = vi.fn();
    simulateSell = simulateSell;
  },
}));

import { AutoSignalExecutor } from '../AutoSignalExecutor.js';
import { query } from '../../database/index.js';
import { paperPositionsRepo } from '../../database/repositories.js';

const mockQuery = query as ReturnType<typeof vi.fn>;
const mockGetAll = paperPositionsRepo.getAll as ReturnType<typeof vi.fn>;

/** An open LONG position where current_price reflects the Yes token price (0.16) */
const existingLongPosition = {
  id: 99,
  market_id: 'market-1',
  token_id: 'yes-token-1',
  side: 'long',
  size: 100,
  avg_entry_price: 0.16,
  current_price: 0.16,   // YES token price — correct fallback
  unrealized_pnl: 0,
  unrealized_pnl_pct: 0,
  realized_pnl: 0,
  opened_at: new Date(),
  updated_at: new Date(),
  closed_at: null,
  signal_type: 'combined',
};

/** SHORT signal generated for this market: price = 0.84 (the No-token price, i.e. 1 - 0.16).
 *  This is wrong for the Yes-token position — it must NOT be used as exit price fallback. */
const shortSignal = {
  signalId: 'combined',
  marketId: 'market-1',
  tokenId: 'yes-token-1',
  direction: 'short' as const,
  strength: 0.6,
  confidence: 0.5,
  price: 0.84,   // ← No-token price (wrong direction for the LONG/Yes position)
};

describe('AutoSignalExecutor — exit price fallback on DB timeout', () => {
  let executor: AutoSignalExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new AutoSignalExecutor({ openThreshold: 0.43, exitThreshold: 0.25 });
    executor.start();

    // Default: position exists for market-1
    mockGetAll.mockResolvedValue([existingLongPosition]);
  });

  it('uses position.current_price when price_history query throws (timeout scenario)', async () => {
    // Query sequence:
    //   1st call — market status check → active
    //   2nd call — price_history in closePosition → throws (simulating DB timeout)
    mockQuery
      .mockResolvedValueOnce({ rows: [{ is_active: true, is_resolved: false, end_date: null }] })
      .mockRejectedValueOnce(new Error('timeout exceeded when trying to connect'));

    const result = await executor.processSignal(shortSignal);

    expect(result.executed).toBe(true);
    // simulateSell must be called with position.current_price (0.16), NOT signal.price (0.84)
    expect(simulateSell).toHaveBeenCalledOnce();
    const [, , , calledPrice] = simulateSell.mock.calls[0];
    expect(calledPrice).toBeCloseTo(0.16, 3);
  });

  it('uses price_history result when DB query succeeds', async () => {
    // Query sequence:
    //   1st call — market status → active
    //   2nd call — price_history → fresh yes price 0.162
    mockQuery
      .mockResolvedValueOnce({ rows: [{ is_active: true, is_resolved: false, end_date: null }] })
      .mockResolvedValueOnce({ rows: [{ close: '0.162', price_age_seconds: '3' }] });

    const result = await executor.processSignal(shortSignal);

    expect(result.executed).toBe(true);
    expect(simulateSell).toHaveBeenCalledOnce();
    const [, , , calledPrice] = simulateSell.mock.calls[0];
    // Should use the fresh price_history value (0.162), not 0.16 or 0.84
    expect(calledPrice).toBeCloseTo(0.162, 3);
  });
});
