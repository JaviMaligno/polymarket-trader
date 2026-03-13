import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all dependencies before importing the class under test
vi.mock('../../database/index.js', () => ({
  isDatabaseConfigured: () => true,
  // Return an active market for all market-status queries
  query: vi.fn().mockResolvedValue({
    rows: [{ is_active: true, is_resolved: false, end_date: null }],
  }),
}));
vi.mock('../../database/repositories.js', () => ({
  paperTradesRepo: { create: vi.fn() },
  paperPositionsRepo: { getAll: vi.fn().mockResolvedValue([]) },
  signalPredictionsRepo: { create: vi.fn() },
  signalWeightsRepo: { getAll: vi.fn().mockResolvedValue([]) },
}));
vi.mock('../PositionClosingService.js', () => ({
  getPositionClosingService: () => ({ closePosition: vi.fn() }),
}));
vi.mock('../CircuitBreakerService.js', () => ({
  getCircuitBreakerService: () => ({ isTradingHalted: () => false }),
}));

import { AutoSignalExecutor } from '../AutoSignalExecutor.js';

const makeSignal = (confidence: number, direction: 'long' | 'short' = 'long') => ({
  signalId: 'test',
  marketId: 'market-1',
  tokenId: 'token-1',
  direction,
  strength: 0.5,
  confidence,
  price: 0.6,
});

describe('AutoSignalExecutor — hysteresis thresholds', () => {
  let executor: AutoSignalExecutor;

  beforeEach(() => {
    executor = new AutoSignalExecutor({ openThreshold: 0.43, exitThreshold: 0.25 });
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
