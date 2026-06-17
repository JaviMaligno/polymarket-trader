import { describe, it, expect, vi } from 'vitest';
import { LiveLedger } from './liveLedger.js';
import { InventoryBook } from '../inventoryBook.js';

const noopPersist = { insertFill: vi.fn().mockResolvedValue(undefined) };

describe('LiveLedger', () => {
  it('round-trip realized = (p_ask - p_bid) * size exacto', async () => {
    const l = new LiveLedger(noopPersist as any, 'mktA');
    await l.applyFill({ time: new Date(), orderId: 'o1', tokenId: 'tok', side: -1, fillPrice: 0.40, fillSize: 20 }, { queueInitial: 0, spreadAtPlacement: null, midBefore: null, flags: '' });
    await l.applyFill({ time: new Date(), orderId: 'o2', tokenId: 'tok', side: 1, fillPrice: 0.45, fillSize: 20 }, { queueInitial: 0, spreadAtPlacement: null, midBefore: null, flags: '' });
    expect(l.totalRealized()).toBeCloseTo((0.45 - 0.40) * 20, 9);
    expect(l.position('mktA')).toBe(0);
  });

  it('equity = cash + M2M; persiste cada fill', async () => {
    const persist = { insertFill: vi.fn().mockResolvedValue(undefined) };
    const l = new LiveLedger(persist as any, 'mktA');
    await l.applyFill({ time: new Date(), orderId: 'o1', tokenId: 'tok', side: -1, fillPrice: 0.40, fillSize: 10 }, { queueInitial: 0, spreadAtPlacement: null, midBefore: null, flags: '' });
    const mids = new Map([['mktA', 0.42]]);
    expect(l.equity(mids)).toBeCloseTo(-0.40 * 10 + 10 * 0.42, 9);
    expect(persist.insertFill).toHaveBeenCalledTimes(1);
  });

  it('identidad shadow↔live: misma secuencia de fills ⇒ mismo inventario/PnL que InventoryBook', async () => {
    const l = new LiveLedger(noopPersist as any, 'mktA');
    const shadow = new InventoryBook();
    const seq: Array<[-1 | 1, number, number]> = [[-1, 0.40, 10], [1, 0.50, 4], [-1, 0.38, 6], [1, 0.47, 12]];
    for (const [side, price, size] of seq) {
      await l.applyFill({ time: new Date(), orderId: 'x', tokenId: 'tok', side, fillPrice: price, fillSize: size }, { queueInitial: 0, spreadAtPlacement: null, midBefore: null, flags: '' });
      shadow.applyFill('mktA', side, price, size);
    }
    const mids = new Map([['mktA', 0.44]]);
    expect(l.totalRealized()).toBeCloseTo(shadow.totalRealized(), 9);
    expect(l.equity(mids)).toBeCloseTo(shadow.equity(mids), 9);
    expect(l.position('mktA')).toBe(shadow.position('mktA'));
  });
});
