import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../database/connection.js', () => ({
  query: vi.fn(),
  getPool: vi.fn(),
}));

// Mock the EdgeCapacityRefresher module so runJob('refresh-edge-capacity')
// can be exercised without hitting the real SQL pipeline.
vi.mock('./EdgeCapacityRefresher.js', () => ({
  refreshEdgeCapacity: vi.fn().mockResolvedValue({ upserts: 0, perType: new Map() }),
}));

import { query } from '../database/connection.js';
import { computeRealizedVolatility } from './Scheduler.js';
import { Scheduler } from './Scheduler.js';
import { refreshEdgeCapacity } from './EdgeCapacityRefresher.js';

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
});
