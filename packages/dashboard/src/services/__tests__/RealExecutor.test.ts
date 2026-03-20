import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RealExecutor, type OrderIntent, type OrderResult } from '../RealExecutor.js';

const mockPostOrder = vi.fn();
const mockCreateOrder = vi.fn();
const mockClobClient = {
  createOrder: mockCreateOrder,
  postOrder: mockPostOrder,
};

describe('RealExecutor', () => {
  let executor: RealExecutor;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockCreateOrder.mockReset();
    mockPostOrder.mockReset();
    mockCreateOrder.mockResolvedValue({ id: 'order-123', signed: true });
    mockPostOrder.mockResolvedValue({
      orderID: 'order-123',
      status: 'matched',
      transactionsHashes: ['0xabc'],
    });

    executor = new RealExecutor({
      clobClient: mockClobClient as any,
      maxSlippage: 0.02,
      dryRun: false,
    });
  });

  it('builds and submits a BUY order', async () => {
    const intent: OrderIntent = {
      tokenId: 'token-yes-123',
      side: 'BUY',
      price: 0.65,
      size: 100,
    };

    const result = await executor.execute(intent);

    // BUY price adjusted up by maxSlippage (0.02): 0.65 + 0.02 = 0.67
    expect(mockCreateOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenID: 'token-yes-123',
        side: 'BUY',
        price: 0.67,
        size: 100,
      })
    );
    expect(mockPostOrder).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.orderId).toBe('order-123');
  });

  it('builds and submits a SELL order', async () => {
    const intent: OrderIntent = {
      tokenId: 'token-yes-123',
      side: 'SELL',
      price: 0.80,
      size: 50,
    };

    const result = await executor.execute(intent);

    // SELL price adjusted down by maxSlippage (0.02): 0.80 - 0.02 = 0.78
    expect(mockCreateOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        side: 'SELL',
        price: 0.78,
        size: 50,
      })
    );
    expect(result.success).toBe(true);
  });

  it('in dry-run mode, builds but does not submit', async () => {
    executor = new RealExecutor({
      clobClient: mockClobClient as any,
      maxSlippage: 0.02,
      dryRun: true,
    });

    const intent: OrderIntent = {
      tokenId: 'token-yes-123',
      side: 'BUY',
      price: 0.65,
      size: 100,
    };

    const result = await executor.execute(intent);

    expect(mockCreateOrder).toHaveBeenCalled();
    expect(mockPostOrder).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
  });

  it('respects dryRunOverride=true even when constructed with dryRun=false', async () => {
    const intent: OrderIntent = {
      tokenId: 'token-yes-123',
      side: 'BUY',
      price: 0.65,
      size: 100,
    };

    const result = await executor.execute(intent, true);

    expect(mockCreateOrder).toHaveBeenCalled();
    expect(mockPostOrder).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
  });

  it('handles CLOB rejection gracefully', async () => {
    mockPostOrder.mockRejectedValue(new Error('Insufficient balance'));

    const intent: OrderIntent = {
      tokenId: 'token-yes-123',
      side: 'BUY',
      price: 0.65,
      size: 100,
    };

    const result = await executor.execute(intent);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Insufficient balance');
  });

  it('retries once on network timeout', async () => {
    mockPostOrder
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValueOnce({
        orderID: 'order-123',
        status: 'matched',
        transactionsHashes: ['0xabc'],
      });

    const intent: OrderIntent = {
      tokenId: 'token-yes-123',
      side: 'BUY',
      price: 0.65,
      size: 100,
    };

    const result = await executor.execute(intent);

    expect(mockPostOrder).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
  });

  it('does not retry on non-network errors', async () => {
    mockPostOrder.mockRejectedValue(new Error('Market closed'));

    const intent: OrderIntent = {
      tokenId: 'token-yes-123',
      side: 'BUY',
      price: 0.65,
      size: 100,
    };

    await executor.execute(intent);
    expect(mockPostOrder).toHaveBeenCalledTimes(1);
  });
});
