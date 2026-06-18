import { describe, it, expect, vi } from 'vitest';
import { buildLiveEngine } from './wiring.js';

describe('buildLiveEngine', () => {
  it('arma engine con subset y arranca tras cancelAll', async () => {
    const gateway = { cancelAll: vi.fn().mockResolvedValue(undefined), openOrders: () => [], postLimit: vi.fn(), pollFills: vi.fn().mockResolvedValue([]), expireDue: vi.fn().mockResolvedValue(undefined), getOpen: vi.fn() };
    const persistence = { ensureSchema: vi.fn().mockResolvedValue(undefined), insertFill: vi.fn() };
    const { engine, risk } = await buildLiveEngine({
      cfg: { liveSubset: ['mktA'], volWindowMs: 60_000, maxInvPerMarket: 20, maxInvTotal: 60, maxNotionalTotal: 100, maxCumLoss: 50 } as any,
      gateway: gateway as any, persistence: persistence as any,
      marketByToken: new Map([['tok', 'mktA']]), endDateByMarket: new Map(), rewardsByMarket: new Map(),
      onKill: vi.fn(), persistState: vi.fn().mockResolvedValue(undefined), notify: vi.fn().mockResolvedValue(undefined),
    });
    expect(persistence.ensureSchema).toHaveBeenCalled();
    expect(gateway.cancelAll).toHaveBeenCalled(); // cancel-all incondicional al boot
    expect(engine).toBeTruthy();
    expect(risk.state()).toBe('running');
  });
});
