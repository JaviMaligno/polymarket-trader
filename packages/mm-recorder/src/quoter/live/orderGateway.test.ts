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

  it('postLimit mapea side +1→SELL', async () => {
    const c = mockClient();
    const gw = new OrderGateway(c as any, { ttlMs: 1_800_000 }, () => new Date());
    await gw.postLimit('tok', 1, 0.6, 20);
    expect(c.createOrder).toHaveBeenCalledWith(expect.objectContaining({ side: 'SELL' }), expect.anything());
  });

  it('cancel quita la orden del set de abiertas', async () => {
    const c = mockClient();
    const gw = new OrderGateway(c as any, { ttlMs: 1_800_000 }, () => new Date());
    await gw.postLimit('tok', 1, 0.6, 20);
    await gw.cancel('o1');
    expect(c.cancelOrder).toHaveBeenCalledWith({ orderID: 'o1' });
    expect(gw.openOrderIds()).not.toContain('o1');
  });

  it('cancel de un id desconocido es no-op (no llega al client)', async () => {
    const c = mockClient();
    const gw = new OrderGateway(c as any, { ttlMs: 1_800_000 }, () => new Date());
    await gw.cancel('desconocido');
    expect(c.cancelOrder).not.toHaveBeenCalled();
  });

  it('cancel suelta el slot localmente aunque el client rechace', async () => {
    const c = mockClient();
    c.cancelOrder = vi.fn(async () => { throw new Error('rate-limit'); });
    const gw = new OrderGateway(c as any, { ttlMs: 1_800_000 }, () => new Date());
    await gw.postLimit('tok', -1, 0.4, 20);
    await expect(gw.cancel('o1')).rejects.toThrow('rate-limit');
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

describe('OrderGateway replace/expire', () => {
  it('replace cancela la vieja y postea una nueva', async () => {
    const c = mockClient();
    c.postOrder = vi.fn().mockResolvedValueOnce({ orderID: 'o1' }).mockResolvedValueOnce({ orderID: 'o2' });
    const gw = new OrderGateway(c as any, { ttlMs: 1_800_000 }, () => new Date());
    await gw.postLimit('tok', -1, 0.4, 20);
    const id2 = await gw.replace('o1', 'tok', -1, 0.41, 20);
    expect(c.cancelOrder).toHaveBeenCalledWith({ orderID: 'o1' });
    expect(id2).toBe('o2');
    expect(gw.openOrderIds()).toEqual(['o2']);
  });

  it('expireDue cancela las órdenes con TTL vencido', async () => {
    const c = mockClient();
    let t = new Date('2026-06-17T00:00:00Z');
    const gw = new OrderGateway(c as any, { ttlMs: 1000 }, () => t);
    await gw.postLimit('tok', -1, 0.4, 20);
    t = new Date('2026-06-17T00:00:02Z'); // +2s > ttl 1s
    await gw.expireDue();
    expect(gw.openOrderIds()).toHaveLength(0);
  });
});

describe('OrderGateway reconcile (poll)', () => {
  it('emite fill parcial y luego completo, ignorando ids desconocidos', async () => {
    const c = mockClient();
    // getOrder devuelve size_matched acumulado
    const statuses: Record<string, any> = { o1: { size_matched: 0 } };
    (c as any).getOrder = vi.fn(async ({ orderID }: any) => statuses[orderID]);
    const gw = new OrderGateway(c as any, { ttlMs: 1_800_000 }, () => new Date('2026-06-17T00:00:00Z'));
    await gw.postLimit('tok', -1, 0.4, 20);

    statuses.o1 = { size_matched: 5 };
    const fills1 = await gw.pollFills();
    expect(fills1).toEqual([expect.objectContaining({ orderId: 'o1', tokenId: 'tok', side: -1, fillPrice: 0.4, fillSize: 5 })]);

    statuses.o1 = { size_matched: 20 }; // resto
    const fills2 = await gw.pollFills();
    expect(fills2[0].fillSize).toBe(15);
    expect(gw.openOrderIds()).not.toContain('o1'); // totalmente lleno → cerrada
  });
});
