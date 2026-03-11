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
});
