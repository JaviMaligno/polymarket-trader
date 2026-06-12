import { describe, it, expect } from 'vitest';
import { desiredQuotes } from './quotePolicy.js';
import { loadConfig } from './config.js';
import type { PolicyInput } from './types.js';

const cfg = loadConfig({ MM_QUOTER_MODE: 'shadow' });

const base: PolicyInput = {
  bestBid: 0.48, bestAsk: 0.52,
  recentVol: 0, msToResolution: 7 * 24 * 3_600_000,
  rewards: null,
  inventoryShares: 0, inventoryNotional: 0, totalNotional: 0,
};

describe('desiredQuotes — guards', () => {
  it('joins the touch on both sides in the happy path', () => {
    const q = desiredQuotes(base, cfg);
    expect(q.bid).toEqual({ price: 0.48, size: 20, flags: [] });
    expect(q.ask).toEqual({ price: 0.52, size: 20, flags: [] });
  });

  it('no quote when the book is one-sided', () => {
    expect(desiredQuotes({ ...base, bestAsk: null }, cfg)).toEqual({ bid: null, ask: null });
    expect(desiredQuotes({ ...base, bestBid: null }, cfg)).toEqual({ bid: null, ask: null });
  });

  it('no quote near resolution', () => {
    const q = desiredQuotes({ ...base, msToResolution: 23 * 3_600_000 }, cfg);
    expect(q).toEqual({ bid: null, ask: null });
  });

  it('unknown end_date does NOT block', () => {
    expect(desiredQuotes({ ...base, msToResolution: null }, cfg).bid).not.toBeNull();
  });

  it('volatility pause pulls both sides when recentVol exceeds threshold', () => {
    const tight = { ...cfg, volPause: 0.02 };
    expect(desiredQuotes({ ...base, recentVol: 0.03 }, tight)).toEqual({ bid: null, ask: null });
    expect(desiredQuotes({ ...base, recentVol: 0.01 }, tight).bid).not.toBeNull();
  });

  it('spread floor suppresses quotes on tight books', () => {
    const floor = { ...cfg, minSpread: 0.05 };
    expect(desiredQuotes(base, floor)).toEqual({ bid: null, ask: null }); // spread 0.04
  });
});

describe('desiredQuotes — rewards', () => {
  it('uses max(quoteSize, rewardsMinSize)', () => {
    const q = desiredQuotes({ ...base, rewards: { minSize: 50, maxSpreadCents: null, dailyRate: 10 } }, cfg);
    expect(q.bid!.size).toBe(50);
  });

  it('rewards_constrained: touch fuera de banda -> quote en el borde elegible', () => {
    // mid=0.50, maxSpread 1¢ -> banda [0.49, 0.51]; touch bid 0.48 queda fuera
    const q = desiredQuotes({ ...base, rewards: { minSize: null, maxSpreadCents: 1, dailyRate: 10 } }, cfg);
    expect(q.bid!.price).toBeCloseTo(0.49, 10);
    expect(q.bid!.flags).toContain('rewards_constrained');
    expect(q.ask!.price).toBeCloseTo(0.51, 10);
  });

  it('touch dentro de banda -> join the touch sin flag', () => {
    const q = desiredQuotes({ ...base, rewards: { minSize: null, maxSpreadCents: 5, dailyRate: 10 } }, cfg);
    expect(q.bid!.price).toBe(0.48);
    expect(q.bid!.flags).toEqual([]);
  });

  it('touch exactamente en el borde de banda (maxSpreadCents=2) -> join-the-touch, sin rewards_constrained', () => {
    // mid=0.50, band=0.02 -> borde en 0.48/0.52; IEEE noise como 0.020000000000000004 no debe disparar la flag
    const q = desiredQuotes({ ...base, rewards: { minSize: null, maxSpreadCents: 2, dailyRate: 10 } }, cfg);
    expect(q.bid!.price).toBe(0.48);
    expect(q.ask!.price).toBe(0.52);
    expect(q.bid!.flags).not.toContain('rewards_constrained');
    expect(q.ask!.flags).not.toContain('rewards_constrained');
  });
});

describe('desiredQuotes — inventario', () => {
  it('hard cap per market: suprime el lado que aumenta inventario', () => {
    // long 0.48*50=24$ > maxInvPerMarket 20 -> bid (aumenta long) fuera; ask sigue
    const q = desiredQuotes({ ...base, inventoryShares: 50, inventoryNotional: 24, totalNotional: 24 }, cfg);
    expect(q.bid).toBeNull();
    expect(q.ask).not.toBeNull();
  });

  it('hard cap total: suprime el lado que aumenta cualquier inventario', () => {
    const q = desiredQuotes({ ...base, inventoryShares: 10, inventoryNotional: 5, totalNotional: 61 }, cfg);
    expect(q.bid).toBeNull();
    expect(q.ask).not.toBeNull(); // reduce el long de este mercado
  });

  it('exit_improve: sobre el soft cap, el lado reductor mejora 1 tick', () => {
    // long sobre softInvPerMarket=10 -> ask (reduce) mejora: bestAsk - tick
    const q = desiredQuotes({ ...base, inventoryShares: 30, inventoryNotional: 15, totalNotional: 15 }, cfg);
    expect(q.ask!.price).toBeCloseTo(0.51, 10); // 0.52 - 0.01
    expect(q.ask!.flags).toContain('exit_improve');
    expect(q.bid).not.toBeNull(); // bajo el hard cap, el bid sigue
  });

  it('exit_improve nunca cruza: queda al menos 1 tick del lado opuesto', () => {
    const narrow = { ...base, bestBid: 0.50, bestAsk: 0.51, inventoryShares: 30, inventoryNotional: 15, totalNotional: 15 };
    const q = desiredQuotes(narrow, cfg);
    expect(q.ask!.price).toBeCloseTo(0.51, 10); // no puede mejorar sin cruzar -> se queda al touch
    expect(q.ask!.flags).not.toContain('exit_improve');
  });

  it('short inventory: espejo — bid reduce y puede mejorar', () => {
    const q = desiredQuotes({ ...base, inventoryShares: -30, inventoryNotional: 15, totalNotional: 15 }, cfg);
    expect(q.bid!.price).toBeCloseTo(0.49, 10);
    expect(q.bid!.flags).toContain('exit_improve');
  });
});
