import { InventoryBook } from '../inventoryBook.js';
import type { LivePersistence } from './livePersistence.js';
import type { LiveFill } from './orderGateway.js';

export interface FillContext {
  queueInitial: number; spreadAtPlacement: number | null; midBefore: number | null; flags: string;
}

/** Contabilidad de fills reales. marketId fijo del mapa token→market en el engine.
 *  Reusa InventoryBook (mismos invariantes que el shadow). */
export class LiveLedger {
  private inv = new InventoryBook();
  constructor(
    private readonly persistence: Pick<LivePersistence, 'insertFill'>,
    private readonly marketId: string,
  ) {}

  async applyFill(f: LiveFill, ctx: FillContext): Promise<void> {
    this.inv.applyFill(this.marketId, f.side, f.fillPrice, f.fillSize);
    await this.persistence.insertFill({
      time: f.time, tokenId: f.tokenId, orderId: f.orderId, side: f.side,
      fillPrice: f.fillPrice, fillSize: f.fillSize,
      queueInitial: ctx.queueInitial, spreadAtPlacement: ctx.spreadAtPlacement,
      midBefore: ctx.midBefore, flags: ctx.flags,
    });
  }

  position(m: string): number { return this.inv.position(m) }
  notional(m: string): number { return this.inv.notional(m) }
  totalNotional(): number { return this.inv.totalNotional() }
  totalRealized(): number { return this.inv.totalRealized() }
  equity(mids: Map<string, number>): number { return this.inv.equity(mids) }
  book(): InventoryBook { return this.inv }
}
