import { describe, it, expect } from 'vitest';
import { ShadowLedger } from './shadowLedger.js';

const t = (s: number) => new Date(Date.UTC(2026, 5, 12, 10, 0, s));

const place = (l: ShadowLedger, side: -1 | 1, price: number, queue: number, size = 20, flags: string[] = []) =>
  l.place({ tokenId: 'T', marketId: 'M', side, price, size, queueInitial: queue,
            time: t(0), spread: 0.04, vol: 0, flags });

describe('ShadowLedger — drain por trades, precio anclado', () => {
  it('trade at our price drains the queue; crossing it fills the remainder', () => {
    const l = new ShadowLedger();
    place(l, -1, 0.48, 10); // queue=10: trade1=10 drains it exactly; trade2=25 then crosses
    expect(l.onTrade({ tokenId: 'T', time: t(1), price: 0.48, size: 10 }, null)).toEqual([]);
    const fills = l.onTrade({ tokenId: 'T', time: t(2), price: 0.48, size: 25 }, null);
    const f = fills.find((x) => x.bound === 'trades')!;
    expect(f.price).toBe(0.48);          // anclado
    expect(f.size).toBe(20);
    expect(f.side).toBe(-1);
  });

  it('a trade below our bid fills immediately (level swept)', () => {
    const l = new ShadowLedger();
    place(l, -1, 0.48, 100);
    const fills = l.onTrade({ tokenId: 'T', time: t(1), price: 0.45, size: 1 }, null);
    expect(fills.find((x) => x.bound === 'trades')!.price).toBe(0.48);
  });

  it('ask mirror: trade above our ask fills; at our ask drains', () => {
    const l = new ShadowLedger();
    place(l, 1, 0.52, 10);
    const fills = l.onTrade({ tokenId: 'T', time: t(1), price: 0.55, size: 1 }, null);
    expect(fills.find((x) => x.bound === 'trades')!.side).toBe(1);
  });

  it('PRICE MOVES BETWEEN PLACEMENT AND FILL: fill price stays anchored', () => {
    // La clase de bug del re-pricing fantasma: el libro desliza, el fill
    // debe registrarse al precio de colocación.
    const l = new ShadowLedger();
    place(l, -1, 0.48, 30);
    l.onTrade({ tokenId: 'T', time: t(1), price: 0.48, size: 20 }, null);
    // el bid baja a 0.46; un trade a 0.46 < 0.48 traspasa nuestro nivel
    const fills = l.onTrade({ tokenId: 'T', time: t(2), price: 0.46, size: 5 }, null);
    expect(fills.find((x) => x.bound === 'trades')!.price).toBe(0.48); // NO 0.46
  });

  it('partial fills accumulate up to quote size', () => {
    const l = new ShadowLedger();
    place(l, -1, 0.48, 0, 20); // queue 0: front of queue
    const f1 = l.onTrade({ tokenId: 'T', time: t(1), price: 0.48, size: 8 }, null);
    expect(f1.find((x) => x.bound === 'trades')!.size).toBe(8);
    const f2 = l.onTrade({ tokenId: 'T', time: t(2), price: 0.48, size: 30 }, null);
    expect(f2.find((x) => x.bound === 'trades')!.size).toBe(12); // resto
    // quote agotada: nada más
    expect(l.onTrade({ tokenId: 'T', time: t(3), price: 0.48, size: 5 }, null)).toEqual([]);
  });

  it('trades on other tokens or the opposite side do not touch our queue', () => {
    const l = new ShadowLedger();
    place(l, -1, 0.48, 10);
    expect(l.onTrade({ tokenId: 'X', time: t(1), price: 0.40, size: 99 }, null)).toEqual([]);
    expect(l.onTrade({ tokenId: 'T', time: t(1), price: 0.52, size: 99 }, null)).toEqual([]);
  });

  it('profit/adverse matrix: retained sign comes from anchored price vs later mid (computed offline)', () => {
    // El ledger NO calcula retained (lo hace el validator con mids forward);
    // aquí verificamos que el fill registra los datos necesarios.
    const l = new ShadowLedger();
    place(l, 1, 0.52, 0, 20, ['exit_improve']);
    const f = l.onTrade({ tokenId: 'T', time: t(1), price: 0.52, size: 20 }, null)
      .find((x) => x.bound === 'trades')!;
    expect(f.flags).toBe('exit_improve');
    expect(f.queueInitial).toBe(0);
    expect(f.spreadAtPlacement).toBe(0.04);
  });
});

describe('ShadowLedger — bound cancels', () => {
  it('cancels bound fills earlier when the level shrinks without trades', () => {
    const l = new ShadowLedger();
    place(l, -1, 0.48, 50);
    // El nivel se encogió a 5 (cancels delante asumidos): el bound cancels
    // se llena con un trade de 10; el bound trades aún no (cola 50).
    const fills = l.onTrade({ tokenId: 'T', time: t(1), price: 0.48, size: 10 }, 5);
    expect(fills.map((f) => f.bound)).toEqual(['cancels']);
    expect(fills[0].size).toBe(5); // 10 - queue(5)
  });

  it('cancels queue never exceeds trades queue (invariant: cancels fills first)', () => {
    const l = new ShadowLedger();
    place(l, -1, 0.48, 40);
    // secuencia generada: el bound cancels nunca debe llenarse DESPUÉS del trades
    const seq: Array<{ size: number; level: number | null }> = [
      { size: 5, level: 35 }, { size: 10, level: 20 }, { size: 15, level: 10 }, { size: 25, level: 2 },
    ];
    let tradesFilled = 0, cancelsFilled = 0, i = 0;
    for (const s of seq) {
      i += 1;
      for (const f of l.onTrade({ tokenId: 'T', time: t(i), price: 0.48, size: s.size }, s.level)) {
        if (f.bound === 'trades') tradesFilled += f.size;
        if (f.bound === 'cancels') cancelsFilled += f.size;
      }
      expect(cancelsFilled).toBeGreaterThanOrEqual(tradesFilled);
    }
  });

  it('queue never goes negative after reset (re-place)', () => {
    const l = new ShadowLedger();
    place(l, -1, 0.48, 10);
    l.onTrade({ tokenId: 'T', time: t(1), price: 0.48, size: 100 }, null); // fill total
    place(l, -1, 0.47, 30); // re-place
    const q = l.active('T', -1)!;
    expect(q.bounds.trades.queue).toBe(30);
    expect(q.bounds.trades.remaining).toBe(20);
  });

  it('out-of-order trade events do not crash and are processed deterministically', () => {
    const l = new ShadowLedger();
    place(l, -1, 0.48, 20);
    const f1 = l.onTrade({ tokenId: 'T', time: t(5), price: 0.48, size: 15 }, null);
    const f2 = l.onTrade({ tokenId: 'T', time: t(3), price: 0.48, size: 15 }, null); // anterior en el tiempo
    expect(f1).toEqual([]);
    expect(f2.find((x) => x.bound === 'trades')!.size).toBe(10); // 30 acumulado - 20 cola
  });
});

describe('ShadowLedger — expiración y reemplazo', () => {
  it('expired() lists quotes past their TTL (event-time clock)', () => {
    const l = new ShadowLedger();
    place(l, -1, 0.48, 10); // placed at t(0)
    expect(l.expired(t(60), 30_000).map((q) => q.side)).toEqual([-1]);
    expect(l.expired(t(10), 30_000)).toEqual([]);
  });

  it('replace cancels and re-places with fresh queue (priority lost)', () => {
    const l = new ShadowLedger();
    place(l, -1, 0.48, 10);
    l.onTrade({ tokenId: 'T', time: t(1), price: 0.48, size: 8 }, null); // cola 2
    l.cancel('T', -1);
    place(l, -1, 0.49, 25); // nuevo touch, nueva cola
    const q = l.active('T', -1)!;
    expect(q.price).toBe(0.49);
    expect(q.bounds.trades.queue).toBe(25);
  });

  it('clearToken on gap invalidates both sides', () => {
    const l = new ShadowLedger();
    place(l, -1, 0.48, 10);
    place(l, 1, 0.52, 10);
    l.clearToken('T');
    expect(l.active('T', -1)).toBeUndefined();
    expect(l.active('T', 1)).toBeUndefined();
  });
});
