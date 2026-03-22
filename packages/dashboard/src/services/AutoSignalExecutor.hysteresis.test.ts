import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../database/index.js', () => ({
  isDatabaseConfigured: vi.fn(() => true),
  query: vi.fn(),
}));

vi.mock('../database/repositories.js', () => ({
  paperTradesRepo: { create: vi.fn() },
  paperPositionsRepo: { getAll: vi.fn().mockResolvedValue([]) },
  signalPredictionsRepo: { create: vi.fn() },
  signalWeightsRepo: { getAll: vi.fn().mockResolvedValue([]) },
}));

vi.mock('./PositionClosingService.js', () => ({
  getPositionClosingService: () => ({ closePosition: vi.fn() }),
}));

vi.mock('./CircuitBreakerService.js', () => ({
  getCircuitBreakerService: () => ({ isTradingHalted: () => false }),
}));

vi.mock('./OrderBookExecutionSimulator.js', () => ({
  OrderBookExecutionSimulator: class {
    simulateBuy = vi.fn().mockResolvedValue({
      executed: true, executedPrice: 0.60, executedSize: 10,
      slippagePct: 0.1, fee: 0.006, fillSource: 'estimated',
      snapshotAgeMs: null, availableDepth: 0,
      bestBid: null, bestAsk: null,
    });
    simulateSell = vi.fn().mockResolvedValue({
      executed: true, executedPrice: 0.60, executedSize: 10,
      slippagePct: 0.1, fee: 0.006, fillSource: 'estimated',
      snapshotAgeMs: null, availableDepth: 0,
      bestBid: null, bestAsk: null,
    });
  },
}));

import { query } from '../database/index.js';
import { paperPositionsRepo } from '../database/repositories.js';
import { AutoSignalExecutor } from './AutoSignalExecutor.js';

const makeSignal = (confidence: number, direction: 'long' | 'short' = 'long') => ({
  signalId: 'test',
  marketId: 'market-1',
  tokenId: 'token-1',
  direction,
  strength: 0.5,
  confidence,
  price: 0.6,
});

/** Make query return a valid active market so early guards pass */
function mockValidMarket() {
  (query as ReturnType<typeof vi.fn>).mockResolvedValue({
    rows: [{ is_active: true, is_resolved: false, end_date: null }],
  });
}

describe('AutoSignalExecutor — hysteresis thresholds', () => {
  let executor: AutoSignalExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    mockValidMarket();
    (paperPositionsRepo.getAll as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    executor = new AutoSignalExecutor({ openThreshold: 0.43, exitThreshold: 0.25, cooldownMs: 0 });
    executor.start();
  });

  it('rejects LONG signal below openThreshold', async () => {
    const result = await executor.processSignal(makeSignal(0.35, 'long'));
    expect(result.executed).toBe(false);
    expect(result.reason).toMatch(/open threshold/);
  });

  it('does not reject LONG signal at openThreshold', async () => {
    const result = await executor.processSignal(makeSignal(0.43, 'long'));
    // May fail for DB or other reasons, but NOT due to open threshold
    expect(result.reason).not.toMatch(/open threshold/);
  });

  it('rejects SHORT signal below openThreshold when no existing position', async () => {
    // No existing position → treated as new open, uses openThreshold
    const result = await executor.processSignal(makeSignal(0.30, 'short'));
    expect(result.executed).toBe(false);
    expect(result.reason).toMatch(/open threshold/);
  });
});
