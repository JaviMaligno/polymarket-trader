import type { DrainBound, ShadowFill, Side } from './types.js';

export interface Placement {
  tokenId: string; marketId: string; side: Side;
  price: number; size: number; queueInitial: number;
  time: Date; spread: number | null; vol: number; flags: string[];
}

export interface LedgerTrade { tokenId: string; time: Date; price: number; size: number }

interface BoundState { queue: number; remaining: number }

interface Quote extends Placement {
  bounds: Record<DrainBound, BoundState>;
}

/** Quotes virtuales con dos colas paralelas (bound trades / cancels).
 *  Fill SIEMPRE al precio de colocación (anclado — guarda contra phantom re-pricing).
 *
 *  Drain rules para un bid a precio P:
 *    trade.price < P  → nivel traspasado → fill del resto (bound trades)
 *    trade.price === P → drena trade.size de la cola; overflow más allá de la cola → fill
 *  Espejo para ask (trade.price > P traspasa).
 *
 *  bound 'cancels': antes de computar el drain, la cola se clampea a levelSize
 *  (optimista: asume que las cancelaciones ocurrieron delante de nosotros).
 *
 *  Comparación de precios: se cuantiza a la rejilla de ticks porque los precios
 *  computados por la política (round(mid ± band, tick)) pueden llevar ruido FP
 *  (ej. 0.35000000000000003) mientras que los precios del feed se parsean como
 *  decimales exactos (0.35). La comparación directa con === fallaría silenciosamente. */
export class ShadowLedger {
  private quotes = new Map<string, Quote>(); // key = tokenId:side

  constructor(private tick = 0.01) {}

  private key(tokenId: string, side: Side): string { return `${tokenId}:${side}` }

  place(p: Placement): void {
    this.quotes.set(this.key(p.tokenId, p.side), {
      ...p,
      bounds: {
        trades: { queue: p.queueInitial, remaining: p.size },
        cancels: { queue: p.queueInitial, remaining: p.size },
      },
    });
  }

  active(tokenId: string, side: Side): Quote | undefined {
    return this.quotes.get(this.key(tokenId, side));
  }

  cancel(tokenId: string, side: Side): void {
    this.quotes.delete(this.key(tokenId, side));
  }

  /** Procesa un trade contra todas las quotes activas del tokenId.
   *  levelSize: size actual del nivel donde está nuestra quote (bound cancels);
   *  null si no se conoce. */
  onTrade(tr: LedgerTrade, levelSize: number | null): ShadowFill[] {
    const fills: ShadowFill[] = [];
    for (const side of [-1, 1] as Side[]) {
      const q = this.quotes.get(this.key(tr.tokenId, side));
      if (!q) continue;
      // bid: traspasado si trade.price < q.price; ask: traspasado si trade.price > q.price
      // Cuantizar a ticks enteros para evitar fallos de igualdad por ruido FP.
      const tTicks = Math.round(tr.price / this.tick);
      const qTicks = Math.round(q.price / this.tick);
      const crossed = side === -1 ? tTicks < qTicks : tTicks > qTicks;
      const atLevel = tTicks === qTicks;
      if (!crossed && !atLevel) continue;

      for (const bound of ['trades', 'cancels'] as DrainBound[]) {
        const st = q.bounds[bound];
        if (st.remaining <= 0) continue;

        // bound cancels: clampar la cola al nivel actual (asume cancels delante)
        if (bound === 'cancels' && levelSize !== null) {
          st.queue = Math.min(st.queue, levelSize);
        }

        let fillSize = 0;
        if (crossed) {
          fillSize = st.remaining;                  // nivel traspasado: fill todo el resto
        } else {
          // trade at our level: drain queue, overflow fills us
          const drained = Math.max(0, tr.size - Math.max(0, st.queue));
          st.queue = Math.max(0, st.queue - tr.size);
          fillSize = Math.min(st.remaining, drained);
        }

        if (fillSize > 0) {
          st.remaining -= fillSize;
          fills.push({
            time: tr.time,
            tokenId: q.tokenId,
            marketId: q.marketId,
            side: q.side,
            bound,
            price: q.price,          // ANCLADO al precio de colocación
            size: fillSize,
            queueInitial: q.queueInitial,
            spreadAtPlacement: q.spread,
            volAtPlacement: q.vol,
            flags: q.flags.join(','),
            midAtFill: null,
          });
        }
      }

      // Retirar la quote solo cuando AMBOS bounds estén agotados
      if (q.bounds.trades.remaining <= 0 && q.bounds.cancels.remaining <= 0) {
        this.quotes.delete(this.key(tr.tokenId, side));
      }
    }
    return fills;
  }

  /** Quotes cuya colocación es anterior a now − ttlMs (reloj = event time). */
  expired(now: Date, ttlMs: number): Quote[] {
    const out: Quote[] = [];
    for (const q of this.quotes.values()) {
      if (now.getTime() - q.time.getTime() >= ttlMs) out.push(q);
    }
    return out;
  }

  clearToken(tokenId: string): void {
    this.quotes.delete(this.key(tokenId, -1));
    this.quotes.delete(this.key(tokenId, 1));
  }

  clearAll(): void { this.quotes.clear() }
}
