import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../database/index.js', () => ({
  query: vi.fn(),
  isDatabaseConfigured: vi.fn(() => true),
}));

vi.mock('../database/repositories.js', () => ({
  paperPositionsRepo: { getAll: vi.fn() },
  portfolioSnapshotsRepo: {},
}));

vi.mock('@polymarket-trader/backtest', () => ({
  getDefaultRiskProfile: vi.fn(() => ({
    enabled: true,
    profileType: 'AGGRESSIVE',
    maxDrawdownPct: 20,
    haltDrawdownPct: 30,
    maxDailyLossPct: 5,
    maxPositionSizePct: 10,
    maxExposurePct: 60,
    cooldownAfterHaltMs: 1800000,
    autoResumeAfterCooldown: true,
    checkIntervalMs: 60000,
    adaptiveMode: 'NONE',
  })),
  mergeRiskConfig: vi.fn((_profile: string, overrides: any) => ({
    enabled: true,
    profileType: 'AGGRESSIVE',
    maxDrawdownPct: 20,
    haltDrawdownPct: 30,
    maxDailyLossPct: 5,
    maxPositionSizePct: 10,
    maxExposurePct: 60,
    cooldownAfterHaltMs: 1800000,
    autoResumeAfterCooldown: true,
    checkIntervalMs: 60000,
    adaptiveMode: 'NONE',
    ...overrides,
  })),
  calculateAdaptiveMultiplier: vi.fn(() => 1.0),
}));

import { query } from '../database/index.js';
import { paperPositionsRepo } from '../database/repositories.js';
import { RiskManager } from './RiskManager.js';

describe('RiskManager — canOpenPosition fail-closed', () => {
  let rm: RiskManager;

  beforeEach(() => {
    vi.clearAllMocks();
    rm = new RiskManager({ enabled: true });
  });

  it('should BLOCK trades when DB query fails', async () => {
    vi.mocked(query).mockRejectedValue(new Error('connection refused'));

    const result = await rm.canOpenPosition(100);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('risk_check_failed');
    expect(result.adaptiveMultiplier).toBe(0);
  });

  it('should ALLOW trades when DB query succeeds and within limits', async () => {
    vi.mocked(query).mockResolvedValue({
      rows: [{ initial_capital: '10000' }],
    } as any);
    vi.mocked(paperPositionsRepo.getAll).mockResolvedValue([]);

    const result = await rm.canOpenPosition(100);
    expect(result.allowed).toBe(true);
  });

  it('halts trading after repeated risk check database failures', async () => {
    rm = new RiskManager({
      enabled: true,
      consecutiveFailureHaltThreshold: 2,
    } as any);

    vi.mocked(query).mockRejectedValue(new Error('connection timeout'));

    const firstStatus = await rm.checkRisk();
    expect(firstStatus.isHalted).toBe(false);

    const secondStatus = await rm.checkRisk();
    expect(secondStatus.isHalted).toBe(true);
    expect(secondStatus.haltReason).toBe('system');
    expect((secondStatus as any).consecutiveCheckFailures).toBe(2);
    expect((secondStatus as any).lastCheckError).toContain('connection timeout');
  });

  it('resets the failure counter after a successful risk check', async () => {
    rm = new RiskManager({
      enabled: true,
      consecutiveFailureHaltThreshold: 3,
    } as any);

    vi.mocked(query)
      .mockRejectedValueOnce(new Error('connection timeout'))
      .mockResolvedValueOnce({
        rows: [{ initial_capital: '10000', current_capital: '10000', peak_equity: '10000' }],
      } as any)
      .mockResolvedValueOnce({
        rows: [{ current_capital: '10000' }],
      } as any)
      .mockResolvedValueOnce({
        rows: [],
      } as any);

    vi.mocked(paperPositionsRepo.getAll).mockResolvedValue([]);

    await rm.checkRisk();
    const status = await rm.checkRisk();

    expect(status.isHalted).toBe(false);
    expect((status as any).consecutiveCheckFailures).toBe(0);
    expect((status as any).lastCheckError).toBeNull();
  });
});
