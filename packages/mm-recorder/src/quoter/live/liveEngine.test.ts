import { describe, it, expect, vi } from 'vitest';
import { LiveEngine } from './liveEngine.js';

function harness() {
  const gateway = {
    postLimit: vi.fn().mockResolvedValue('o1'),
    replace: vi.fn().mockResolvedValue('o2'),
    cancel: vi.fn().mockResolvedValue(undefined),
    pollFills: vi.fn().mockResolvedValue([]),
    expireDue: vi.fn().mockResolvedValue(undefined),
    getOpen: vi.fn(),
    openOrders: vi.fn().mockReturnValue([]),
  };
  const ledger = { applyFill: vi.fn().mockResolvedValue(undefined), position: () => 0, notional: () => 0, totalNotional: () => 0, totalRealized: () => 0, equity: () => 0, book: () => ({ position: () => 0, avgPrice: () => 0 }) };
  const risk = { check: vi.fn().mockResolvedValue(undefined), state: vi.fn().mockReturnValue('running') };
  return { gateway, ledger, risk };
}

const cfg = { mode: 'live', quoteSize: 20, orderTtlMs: 1_800_000, requoteMinMs: 1000, nearResolutionMs: 0, minSpread: 0, volPause: Infinity, volWindowMs: 60_000, maxInvPerMarket: 20, maxInvTotal: 60, maxCumLoss: 50, softInvPerMarket: 10, tick: 0.01, maxNotionalTotal: 100, fillPollMs: 3000, walletSecretName: '', liveSubset: ['mktA'] } as any;

const bookRow = (t: string) => ({ tokenId: t, marketId: 'mktA', time: new Date('2026-06-17T00:00:00Z'), bestBid: 0.40, bestAsk: 0.60, mid: 0.50 } as any);

describe('LiveEngine', () => {
  it('postea quote para un token del subset', async () => {
    const h = harness();
    const eng = new LiveEngine({ cfg, gateway: h.gateway as any, ledger: h.ledger as any, risk: h.risk as any,
      marketByToken: new Map([['tok', 'mktA']]), endDateByMarket: new Map(), rewardsByMarket: new Map() });
    await eng.onBook({ tokenId: 'tok', time: bookRow('tok').time } as any, bookRow('tok'));
    expect(h.gateway.postLimit).toHaveBeenCalled();
  });

  it('no postea si el mercado no está en el subset', async () => {
    const h = harness();
    const eng = new LiveEngine({ cfg: { ...cfg, liveSubset: ['otro'] }, gateway: h.gateway as any, ledger: h.ledger as any, risk: h.risk as any,
      marketByToken: new Map([['tok', 'mktA']]), endDateByMarket: new Map(), rewardsByMarket: new Map() });
    await eng.onBook({ tokenId: 'tok', time: bookRow('tok').time } as any, bookRow('tok'));
    expect(h.gateway.postLimit).not.toHaveBeenCalled();
  });

  it('no postea si RiskGuard está killed', async () => {
    const h = harness();
    h.risk.state.mockReturnValue('killed');
    const eng = new LiveEngine({ cfg, gateway: h.gateway as any, ledger: h.ledger as any, risk: h.risk as any,
      marketByToken: new Map([['tok', 'mktA']]), endDateByMarket: new Map(), rewardsByMarket: new Map() });
    await eng.onBook({ tokenId: 'tok', time: bookRow('tok').time } as any, bookRow('tok'));
    expect(h.gateway.postLimit).not.toHaveBeenCalled();
  });

  it('tick reconcilia fills hacia ledger y risk', async () => {
    const h = harness();
    h.gateway.pollFills.mockResolvedValue([{ time: new Date(), orderId: 'o1', tokenId: 'tok', side: -1, fillPrice: 0.40, fillSize: 5 }]);
    h.gateway.getOpen.mockReturnValue({ queueInitial: 100 });
    const eng = new LiveEngine({ cfg, gateway: h.gateway as any, ledger: h.ledger as any, risk: h.risk as any,
      marketByToken: new Map([['tok', 'mktA']]), endDateByMarket: new Map(), rewardsByMarket: new Map() });
    await eng.tick(new Date());
    expect(h.ledger.applyFill).toHaveBeenCalled();
    expect(h.risk.check).toHaveBeenCalled();
    expect(h.gateway.expireDue).toHaveBeenCalled();
  });
});
