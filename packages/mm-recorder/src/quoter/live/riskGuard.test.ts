import { describe, it, expect, vi } from 'vitest';
import { RiskGuard } from './riskGuard.js';

function deps() {
  return {
    cfg: { maxInvPerMarket: 20, maxInvTotal: 60, maxNotionalTotal: 100, maxCumLoss: 50 },
    onKill: vi.fn().mockResolvedValue(undefined),
    persistState: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn().mockResolvedValue(undefined),
  };
}

describe('RiskGuard', () => {
  it('dispara kill por cum loss y persiste mode=off una sola vez', async () => {
    const d = deps();
    const g = new RiskGuard(d.cfg as any, d.onKill, d.persistState, d.notify);
    await g.check({ totalNotional: 10, maxInvNotional: 5, totalInvNotional: 5, openNotional: 10, cumPnl: -55, balanceLow: false });
    expect(g.state()).toBe('killed');
    expect(d.onKill).toHaveBeenCalledTimes(1);
    expect(d.persistState).toHaveBeenCalledWith(expect.objectContaining({ kill_state: 'killed', mode: 'off' }));
    await g.check({ totalNotional: 10, maxInvNotional: 5, totalInvNotional: 5, openNotional: 10, cumPnl: -55, balanceLow: false });
    expect(d.onKill).toHaveBeenCalledTimes(1); // no re-dispara
  });

  it('no dispara dentro de límites', async () => {
    const d = deps();
    const g = new RiskGuard(d.cfg as any, d.onKill, d.persistState, d.notify);
    await g.check({ totalNotional: 50, maxInvNotional: 10, totalInvNotional: 30, openNotional: 40, cumPnl: -10, balanceLow: false });
    expect(g.state()).toBe('running');
    expect(d.onKill).not.toHaveBeenCalled();
  });

  it('dispara por balance bajo', async () => {
    const d = deps();
    const g = new RiskGuard(d.cfg as any, d.onKill, d.persistState, d.notify);
    await g.check({ totalNotional: 0, maxInvNotional: 0, totalInvNotional: 0, openNotional: 0, cumPnl: 0, balanceLow: true });
    expect(g.state()).toBe('killed');
  });
});
