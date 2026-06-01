import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../database/connection.js', () => ({
  query: vi.fn(),
  getPool: vi.fn(),
}));

// Mock the EdgeCapacityRefresher module so runJob('refresh-edge-capacity')
// can be exercised without hitting the real SQL pipeline.
vi.mock('./EdgeCapacityRefresher.js', () => ({
  refreshEdgeCapacity: vi.fn().mockResolvedValue({ upserts: 0, perType: new Map() }),
  // Scheduler.refreshEdgeCapacity() resolves env-overridable knobs through this
  // before invoking refreshEdgeCapacity (#284 timeout fix).
  resolveEdgeRefreshConfig: vi.fn().mockReturnValue({ sampleSize: 10000, perTypeTimeoutMs: 600_000 }),
}));

// Mock GammaCollector module so syncResolvedMarkets tests don't hit network/DB.
vi.mock('../collectors/GammaCollector.js', () => ({
  getGammaCollector: vi.fn(),
}));

import { query } from '../database/connection.js';
import { computeRealizedVolatility } from './Scheduler.js';
import { Scheduler } from './Scheduler.js';
import { refreshEdgeCapacity } from './EdgeCapacityRefresher.js';
import * as gammaModule from '../collectors/GammaCollector.js';

describe('computeRealizedVolatility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('executes the UPDATE and the NULL-out UPDATE without throwing', async () => {
    (query as unknown as Mock).mockResolvedValue({ rowCount: 10, rows: [] });
    await expect(computeRealizedVolatility()).resolves.not.toThrow();
    // Two UPDATE statements issued: set vols + null out stale
    const updateCalls = (query as unknown as Mock).mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].trim().startsWith('UPDATE markets'),
    );
    expect(updateCalls.length).toBe(2);
  });

  it('swallows DB errors and does not abort the scheduler', async () => {
    (query as unknown as Mock).mockRejectedValue(new Error('db down'));
    await expect(computeRealizedVolatility()).resolves.not.toThrow();
  });
});

describe('Scheduler.runJob — handler dispatch (Phase 4 hotfix 2026-05-15)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runJob("refresh-edge-capacity") invokes the EdgeCapacityRefresher (PR-D regression)', async () => {
    // Regression: PR #224 registered the cron + binding but forgot the
    // switch case in runJob(). The job fired but fell through to the
    // 'No handler for job' default → lastDuration=0, never wrote.
    // Discovered 2026-05-15 in daily auto-review validation.
    const scheduler = new Scheduler();
    await scheduler.runJob('refresh-edge-capacity');
    expect(refreshEdgeCapacity).toHaveBeenCalledTimes(1);
  });

  it('edge measurement scope is decoupled from ALLOWED_MARKET_TYPES (2026-06-01)', async () => {
    // #290 tied the refresher's allowedTypes to the LIVE trade allowlist
    // (ALLOWED_MARKET_TYPES) purely to dodge event_long's timeout. Migration
    // 034's index removed that cost, so edge measurement should cover ALL types
    // (incl. shadow-only event_long) for full observability. Reads
    // EDGE_REFRESH_ALLOWED_TYPES instead; unset → [] → measure all discovered.
    vi.stubEnv('ALLOWED_MARKET_TYPES', 'crypto_intraday,event_short');
    vi.stubEnv('EDGE_REFRESH_ALLOWED_TYPES', '');
    const scheduler = new Scheduler();
    await scheduler.runJob('refresh-edge-capacity');
    expect(refreshEdgeCapacity).toHaveBeenCalledWith(
      expect.objectContaining({ allowedTypes: [] }),
    );
    vi.unstubAllEnvs();
  });

  it('edge measurement scope honours EDGE_REFRESH_ALLOWED_TYPES when set', async () => {
    vi.stubEnv('ALLOWED_MARKET_TYPES', 'crypto_intraday');
    vi.stubEnv('EDGE_REFRESH_ALLOWED_TYPES', 'event_short, event_long');
    const scheduler = new Scheduler();
    await scheduler.runJob('refresh-edge-capacity');
    expect(refreshEdgeCapacity).toHaveBeenCalledWith(
      expect.objectContaining({ allowedTypes: ['event_short', 'event_long'] }),
    );
    vi.unstubAllEnvs();
  });
});

describe('Scheduler — sync-resolved-markets uses resolveOurMarkets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sync-resolved-markets dispatches to resolveOurMarkets', async () => {
    const resolveOurMarkets = vi.fn().mockResolvedValue({ resolved: 0, checked: 0 });
    (gammaModule.getGammaCollector as unknown as Mock).mockReturnValue({ resolveOurMarkets } as any);
    const scheduler = new Scheduler();
    // Exercise via runJob so the test also guards the runJob switch dispatch,
    // not just the handler body.
    await scheduler.runJob('sync-resolved-markets');
    expect(resolveOurMarkets).toHaveBeenCalled();
  });
});
