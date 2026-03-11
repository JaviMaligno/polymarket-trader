/**
 * PositionClosingService Tests
 *
 * TDD tests for the centralized position-closing service.
 * Verifies correct PnL/fee calculations, idempotency, and trade recording.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../database/index.js', () => ({
  query: vi.fn(),
  transaction: vi.fn(),
  isDatabaseConfigured: vi.fn(() => true),
}));

vi.mock('../database/repositories.js', () => ({
  paperTradesRepo: {
    create: vi.fn(),
  },
}));

import { transaction } from '../database/index.js';
import { paperTradesRepo } from '../database/repositories.js';
import {
  PositionClosingService,
  getPositionClosingService,
  type ClosePositionParams,
} from './PositionClosingService.js';

describe('PositionClosingService', () => {
  let service: PositionClosingService;
  let mockClient: { query: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    service = new PositionClosingService();
    mockClient = { query: vi.fn() };
    // Default: transaction executes the callback with mockClient
    vi.mocked(transaction).mockImplementation(async (cb) => cb(mockClient as any));
    // Default: position update succeeds (rowCount=1)
    mockClient.query.mockResolvedValue({ rowCount: 1 });
    // Default: trade recording succeeds
    vi.mocked(paperTradesRepo.create).mockResolvedValue({ id: 42 } as any);
  });

  it('should compute correct PnL and fee for a profitable LONG close', async () => {
    // size=100, entry=0.40, exit=0.60, feeRate=0.001
    // exitValue = 100 * 0.60 = 60
    // fee = 60 * 0.001 = 0.06
    // grossPnl = (0.60 - 0.40) * 100 = 20
    // netPnl = 20 - 0.06 = 19.94
    const params: ClosePositionParams = {
      positionId: 1,
      marketId: 'market-abc',
      tokenId: 'token-yes',
      side: 'long',
      size: 100,
      entryPrice: 0.40,
      exitPrice: 0.60,
      reason: 'signal',
    };

    const result = await service.close(params);

    expect(result.executed).toBe(true);
    expect(result.fee).toBeCloseTo(0.06, 4);
    expect(result.netPnl).toBeCloseTo(19.94, 4);
  });

  it('should compute correct PnL and fee for a losing SHORT close', async () => {
    // size=50, entry=0.80, exit=0.70, feeRate=0.001
    // exitValue = 50 * 0.70 = 35
    // fee = 35 * 0.001 = 0.035
    // grossPnl = (0.70 - 0.80) * 50 = -5
    // netPnl = -5 - 0.035 = -5.035
    const params: ClosePositionParams = {
      positionId: 2,
      marketId: 'market-def',
      tokenId: 'token-no',
      side: 'short',
      size: 50,
      entryPrice: 0.80,
      exitPrice: 0.70,
      reason: 'stop_loss',
    };

    const result = await service.close(params);

    expect(result.executed).toBe(true);
    expect(result.fee).toBeCloseTo(0.035, 4);
    expect(result.netPnl).toBeCloseTo(-5.035, 4);
  });

  it('should deduct fee from proceeds when updating paper_account', async () => {
    // size=100, exit=0.60 => exitValue=60, fee=0.06, proceeds=59.94
    const params: ClosePositionParams = {
      positionId: 3,
      marketId: 'market-ghi',
      tokenId: 'token-yes',
      side: 'long',
      size: 100,
      entryPrice: 0.40,
      exitPrice: 0.60,
      reason: 'take_profit',
    };

    await service.close(params);

    // The second query in the transaction is the paper_account UPDATE
    // First call: UPDATE paper_positions
    // Second call: UPDATE paper_account
    const accountUpdateCall = mockClient.query.mock.calls[1];
    expect(accountUpdateCall).toBeDefined();
    const accountUpdateSql = accountUpdateCall[0] as string;
    const accountUpdateParams = accountUpdateCall[1] as number[];

    // First param should be proceeds = exitValue - fee = 60 - 0.06 = 59.94
    expect(accountUpdateSql).toContain('paper_account');
    expect(accountUpdateParams[0]).toBeCloseTo(59.94, 4);
    // Second param is fee
    expect(accountUpdateParams[1]).toBeCloseTo(0.06, 4);
    // Third param is netPnl
    expect(accountUpdateParams[2]).toBeCloseTo(19.94, 4);
  });

  it('should return executed=false if position already closed (idempotent)', async () => {
    // First query (position UPDATE) returns rowCount=0 => already closed
    mockClient.query.mockResolvedValueOnce({ rowCount: 0 });

    const params: ClosePositionParams = {
      positionId: 99,
      marketId: 'market-old',
      tokenId: 'token-yes',
      side: 'long',
      size: 100,
      entryPrice: 0.50,
      exitPrice: 0.60,
      reason: 'signal',
    };

    const result = await service.close(params);

    expect(result.executed).toBe(false);
    expect(result.reason).toContain('already closed');
    // Should NOT have called paperTradesRepo.create
    expect(paperTradesRepo.create).not.toHaveBeenCalled();
    // Should only have called one query (the position UPDATE)
    expect(mockClient.query).toHaveBeenCalledTimes(1);
  });

  it('should record trade with correct reason/signal_type and fee', async () => {
    const params: ClosePositionParams = {
      positionId: 5,
      marketId: 'market-jkl',
      tokenId: 'token-yes',
      side: 'long',
      size: 200,
      entryPrice: 0.30,
      exitPrice: 0.50,
      reason: 'stop_loss',
      signalId: 'sig-123',
    };

    await service.close(params);

    expect(paperTradesRepo.create).toHaveBeenCalledTimes(1);
    const tradeArg = vi.mocked(paperTradesRepo.create).mock.calls[0][0];

    expect(tradeArg.market_id).toBe('market-jkl');
    expect(tradeArg.token_id).toBe('token-yes');
    expect(tradeArg.side).toBe('sell');
    expect(tradeArg.signal_type).toBe('stop_loss');
    expect(tradeArg.executed_size).toBe(200);
    expect(tradeArg.executed_price).toBe(0.50);
    // fee = 200 * 0.50 * 0.001 = 0.10
    expect(tradeArg.fee).toBeCloseTo(0.10, 4);
    // value_usd = 200 * 0.50 = 100
    expect(tradeArg.value_usd).toBe(100);
  });

  it('should reject invalid exit price (NaN)', async () => {
    const params: ClosePositionParams = {
      positionId: 6,
      marketId: 'market-mno',
      tokenId: 'token-yes',
      side: 'long',
      size: 100,
      entryPrice: 0.50,
      exitPrice: NaN,
      reason: 'signal',
    };

    const result = await service.close(params);

    expect(result.executed).toBe(false);
    expect(result.reason).toContain('invalid exit price');
    // Should NOT have called transaction or trade recording
    expect(transaction).not.toHaveBeenCalled();
    expect(paperTradesRepo.create).not.toHaveBeenCalled();
  });

  it('should reject negative exit price', async () => {
    const params: ClosePositionParams = {
      positionId: 7,
      marketId: 'market-pqr',
      tokenId: 'token-yes',
      side: 'long',
      size: 100,
      entryPrice: 0.50,
      exitPrice: -0.10,
      reason: 'signal',
    };

    const result = await service.close(params);

    expect(result.executed).toBe(false);
    expect(result.reason).toContain('invalid exit price');
  });

  it('should reject null exit price', async () => {
    const params: ClosePositionParams = {
      positionId: 8,
      marketId: 'market-stu',
      tokenId: 'token-yes',
      side: 'long',
      size: 100,
      entryPrice: 0.50,
      exitPrice: null as any,
      reason: 'signal',
    };

    const result = await service.close(params);

    expect(result.executed).toBe(false);
    expect(result.reason).toContain('invalid exit price');
  });

  it('handles transaction failure gracefully', async () => {
    vi.mocked(transaction).mockRejectedValue(new Error('connection refused'));

    const result = await service.close({
      positionId: 1, marketId: 'm1', tokenId: 't1', side: 'long',
      size: 100, entryPrice: 0.50, exitPrice: 0.60, reason: 'signal',
    });

    expect(result.executed).toBe(false);
    expect(result.reason).toContain('transaction failed');
  });

  it('should emit position:closed event with marketId and reason after successful close', async () => {
    const params: ClosePositionParams = {
      positionId: 1,
      marketId: 'market-abc',
      tokenId: 'token-yes',
      side: 'long',
      size: 100,
      entryPrice: 0.40,
      exitPrice: 0.60,
      reason: 'stop_loss',
    };

    const eventSpy = vi.fn();
    service.on('position:closed', eventSpy);

    await service.close(params);

    expect(eventSpy).toHaveBeenCalledWith({
      marketId: 'market-abc',
      reason: 'stop_loss',
    });
  });

  it('should NOT emit position:closed event when close fails', async () => {
    vi.mocked(transaction).mockRejectedValue(new Error('DB down'));

    const eventSpy = vi.fn();
    service.on('position:closed', eventSpy);

    await service.close({
      positionId: 1, marketId: 'm1', tokenId: 't1', side: 'long',
      size: 100, entryPrice: 0.50, exitPrice: 0.60, reason: 'signal',
    });

    expect(eventSpy).not.toHaveBeenCalled();
  });

  describe('singleton', () => {
    it('should return the same instance from getPositionClosingService', () => {
      const instance1 = getPositionClosingService();
      const instance2 = getPositionClosingService();
      expect(instance1).toBe(instance2);
    });
  });
});
