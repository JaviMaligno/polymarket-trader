import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutionRouter } from '../ExecutionRouter.js';

const mockRealExecute = vi.fn();
const mockGetCachedBalance = vi.fn();
const mockGetConfig = vi.fn();
const mockNotify = vi.fn();

describe('ExecutionRouter', () => {
  let router: ExecutionRouter;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockRealExecute.mockReset();
    mockGetCachedBalance.mockReset();
    mockGetConfig.mockReset();
    mockNotify.mockReset();

    mockGetCachedBalance.mockReturnValue(500);
    mockGetConfig.mockResolvedValue({
      real_trading_enabled: true,
      real_trading_dry_run: false,
      min_balance_threshold: 50,
    });
    mockRealExecute.mockResolvedValue({
      success: true,
      orderId: 'order-123',
    });
    mockNotify.mockResolvedValue(undefined);

    router = new ExecutionRouter({
      realExecutor: { execute: mockRealExecute } as any,
      getCachedBalance: mockGetCachedBalance,
      getConfig: mockGetConfig,
      notify: mockNotify,
    });
  });

  it('routes to real executor when enabled and funded', async () => {
    const result = await router.execute({
      tokenId: 'token-123',
      side: 'BUY',
      price: 0.65,
      size: 100,
    });

    expect(mockRealExecute).toHaveBeenCalled();
    expect(result.execution_mode).toBe('real');
  });

  it('routes to paper when real trading disabled', async () => {
    mockGetConfig.mockResolvedValue({
      real_trading_enabled: false,
      real_trading_dry_run: false,
      min_balance_threshold: 50,
    });

    const result = await router.execute({
      tokenId: 'token-123',
      side: 'BUY',
      price: 0.65,
      size: 100,
    });

    expect(mockRealExecute).not.toHaveBeenCalled();
    expect(result.execution_mode).toBe('paper');
  });

  it('routes to paper when balance below threshold', async () => {
    mockGetCachedBalance.mockReturnValue(30);

    const result = await router.execute({
      tokenId: 'token-123',
      side: 'BUY',
      price: 0.65,
      size: 100,
    });

    expect(mockRealExecute).not.toHaveBeenCalled();
    expect(result.execution_mode).toBe('paper');
  });

  it('routes to dry_run when configured', async () => {
    mockGetConfig.mockResolvedValue({
      real_trading_enabled: true,
      real_trading_dry_run: true,
      min_balance_threshold: 50,
    });

    const result = await router.execute({
      tokenId: 'token-123',
      side: 'BUY',
      price: 0.65,
      size: 100,
    });

    expect(mockRealExecute).toHaveBeenCalled();
    expect(result.execution_mode).toBe('dry_run');
  });

  it('falls back to paper if real execution fails', async () => {
    mockRealExecute.mockResolvedValue({ success: false, error: 'CLOB down' });

    const result = await router.execute({
      tokenId: 'token-123',
      side: 'BUY',
      price: 0.65,
      size: 100,
    });

    expect(result.execution_mode).toBe('paper');
    expect(mockNotify).toHaveBeenCalledWith('error', expect.objectContaining({ message: expect.stringContaining('CLOB') }));
  });

  it('reports current mode via getMode()', async () => {
    const mode = await router.getMode();
    expect(mode).toBe('real');
  });
});
