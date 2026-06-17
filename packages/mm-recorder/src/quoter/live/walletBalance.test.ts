import { describe, it, expect, vi } from 'vitest';
import { WalletBalance } from './walletBalance.js';

describe('WalletBalance', () => {
  it('cachea el último balance y detecta saldo bajo', async () => {
    const get = vi.fn().mockResolvedValue(42);
    const w = new WalletBalance(get, 50);
    await w.refresh();
    expect(w.cached()).toBe(42);
    expect(w.isLow()).toBe(true);
  });

  it('retiene el último balance conocido si la lectura falla', async () => {
    const get = vi.fn().mockResolvedValueOnce(100).mockRejectedValueOnce(new Error('rpc'));
    const w = new WalletBalance(get, 50);
    await w.refresh();
    await w.refresh(); // falla
    expect(w.cached()).toBe(100);
    expect(w.isLow()).toBe(false);
  });
});
