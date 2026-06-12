import type { Side } from './types.js';

interface Pos { shares: number; avg: number; realized: number }

/** Contabilidad de fills sombra por mercado. side -1 = compra, +1 = venta.
 *  Invariante: equity(mids) === cash() + m2m(mids). */
export class InventoryBook {
  private pos = new Map<string, Pos>();
  private cashAcc = 0;

  applyFill(marketId: string, side: Side, price: number, size: number): void {
    const p = this.pos.get(marketId) ?? { shares: 0, avg: 0, realized: 0 };
    const delta = side === -1 ? size : -size;       // compra suma shares
    this.cashAcc += side === -1 ? -price * size : price * size;

    const sameSign = p.shares === 0 || Math.sign(p.shares) === Math.sign(delta);
    if (sameSign) {
      const newShares = p.shares + delta;
      p.avg = newShares === 0 ? 0 : (p.avg * Math.abs(p.shares) + price * Math.abs(delta)) / Math.abs(newShares);
      p.shares = newShares;
    } else {
      const closing = Math.min(Math.abs(p.shares), Math.abs(delta));
      // long cerrado por venta gana (price - avg); short cerrado por compra gana (avg - price)
      p.realized += closing * (p.shares > 0 ? price - p.avg : p.avg - price);
      const remaining = Math.abs(delta) - closing;
      p.shares = p.shares + delta;
      if (remaining > 0) p.avg = price;             // posición nueva al otro lado
      else if (p.shares === 0) p.avg = 0;
    }
    this.pos.set(marketId, p);
  }

  position(m: string): number { return this.pos.get(m)?.shares ?? 0 }
  avgPrice(m: string): number { return this.pos.get(m)?.avg ?? 0 }
  realized(m: string): number { return this.pos.get(m)?.realized ?? 0 }
  notional(m: string): number { const p = this.pos.get(m); return p ? Math.abs(p.shares) * p.avg : 0 }
  totalNotional(): number { let t = 0; for (const m of this.pos.keys()) t += this.notional(m); return t }
  cash(): number { return this.cashAcc }

  m2m(mids: Map<string, number>): number {
    let t = 0;
    for (const [m, p] of this.pos) t += p.shares * (mids.get(m) ?? p.avg);
    return t;
  }
  equity(mids: Map<string, number>): number { return this.cashAcc + this.m2m(mids) }
  totalRealized(): number { let t = 0; for (const p of this.pos.values()) t += p.realized; return t }
}
