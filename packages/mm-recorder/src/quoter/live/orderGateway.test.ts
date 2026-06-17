import { describe, it, expect, vi } from 'vitest';
import { OrderGateway } from './orderGateway.js';

function mockClient() {
  return {
    createOrder: vi.fn(async (p: any) => ({ signed: p })),
    postOrder: vi.fn(async (_s: any) => ({ orderID: 'o1' })),
    cancelOrder: vi.fn(async (_a: any) => ({ ok: true })),
    cancelAll: vi.fn(async () => ({ ok: true })),
  };
}

describe('OrderGateway post/cancel', () => {
  it('postLimit mapea side -1→BUY y devuelve el orderId, registrándolo', async () => {
    const c = mockClient();
    const gw = new OrderGateway(c as any, { ttlMs: 1_800_000 }, () => new Date('2026-06-17T00:00:00Z'));
    const id = await gw.postLimit('tok', -1, 0.4, 20);
    expect(id).toBe('o1');
    expect(c.createOrder).toHaveBeenCalledWith(expect.objectContaining({ tokenID: 'tok', side: 'BUY', price: 0.4, size: 20 }), expect.anything());
    expect(gw.openOrderIds()).toContain('o1');
  });

  it('cancel quita la orden del set de abiertas', async () => {
    const c = mockClient();
    const gw = new OrderGateway(c as any, { ttlMs: 1_800_000 }, () => new Date());
    await gw.postLimit('tok', 1, 0.6, 20);
    await gw.cancel('o1');
    expect(c.cancelOrder).toHaveBeenCalledWith({ orderID: 'o1' });
    expect(gw.openOrderIds()).not.toContain('o1');
  });

  it('cancelAll llama al client y vacía el set', async () => {
    const c = mockClient();
    const gw = new OrderGateway(c as any, { ttlMs: 1_800_000 }, () => new Date());
    await gw.postLimit('tok', -1, 0.4, 20);
    await gw.cancelAll();
    expect(c.cancelAll).toHaveBeenCalled();
    expect(gw.openOrderIds()).toHaveLength(0);
  });
});
