import { describe, it, expect, vi } from 'vitest';
import { LivePersistence } from './livePersistence.js';

describe('LivePersistence', () => {
  it('ensureSchema crea ambas tablas', async () => {
    const exec = vi.fn().mockResolvedValue(undefined);
    await new LivePersistence(exec).ensureSchema();
    const sql = exec.mock.calls[0][0] as string;
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS mm_live_orders');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS mm_live_fills');
  });

  it('insertFill pasa los 10 campos en orden', async () => {
    const exec = vi.fn().mockResolvedValue(undefined);
    const p = new LivePersistence(exec);
    const t = new Date('2026-06-17T00:00:00Z');
    await p.insertFill({ time: t, tokenId: 'tok', orderId: 'o1', side: -1, fillPrice: 0.4, fillSize: 5,
      queueInitial: 100, spreadAtPlacement: 0.02, midBefore: 0.41, flags: '' });
    const params = exec.mock.calls[0][1] as unknown[];
    expect(params).toEqual([t, 'tok', 'o1', -1, 0.4, 5, 100, 0.02, 0.41, '']);
  });
});
