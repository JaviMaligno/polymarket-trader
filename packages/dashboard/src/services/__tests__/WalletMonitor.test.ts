import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WalletMonitor } from '../WalletMonitor.js';

const mockNotify = vi.fn();
const mockSetConfig = vi.fn();
const mockGetBalance = vi.fn();

describe('WalletMonitor', () => {
  let monitor: WalletMonitor;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockNotify.mockReset();
    mockSetConfig.mockReset();
    mockGetBalance.mockReset();
    mockNotify.mockResolvedValue(undefined);
    mockSetConfig.mockResolvedValue(undefined);

    monitor = new WalletMonitor({
      getUSDCBalance: mockGetBalance,
      notify: mockNotify,
      setRealTradingEnabled: mockSetConfig,
      minBalanceThreshold: 50,
      warningThreshold: 100,
      checkIntervalMs: 1000,
    });
  });

  it('returns cached balance', async () => {
    mockGetBalance.mockResolvedValue(200);
    await monitor.check();
    expect(monitor.getCachedBalance()).toBe(200);
  });

  it('does nothing when balance is above warning threshold', async () => {
    mockGetBalance.mockResolvedValue(200);
    await monitor.check();
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockSetConfig).not.toHaveBeenCalled();
  });

  it('sends warning when balance below warning threshold but above min', async () => {
    mockGetBalance.mockResolvedValue(75);
    await monitor.check();
    expect(mockNotify).toHaveBeenCalledWith('funds_warning', expect.objectContaining({ balance: 75 }));
    expect(mockSetConfig).not.toHaveBeenCalled();
  });

  it('disables real trading and notifies when balance below min threshold', async () => {
    mockGetBalance.mockResolvedValue(30);
    await monitor.check();
    expect(mockSetConfig).toHaveBeenCalledWith(false);
    expect(mockNotify).toHaveBeenCalledWith('funds_low', expect.objectContaining({ balance: 30 }));
  });

  it('does not send duplicate warnings within cooldown', async () => {
    mockGetBalance.mockResolvedValue(75);
    await monitor.check();
    await monitor.check();
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it('handles balance check errors gracefully', async () => {
    // Set an initial known balance
    mockGetBalance.mockResolvedValue(150);
    await monitor.check();
    expect(monitor.getCachedBalance()).toBe(150);

    // Now simulate an RPC error — balance should be preserved, not reset to 0
    mockGetBalance.mockRejectedValue(new Error('RPC timeout'));
    await expect(monitor.check()).resolves.not.toThrow();
    expect(monitor.getCachedBalance()).toBe(150);
  });
});
