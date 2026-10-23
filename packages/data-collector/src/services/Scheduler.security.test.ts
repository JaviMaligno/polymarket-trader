import { afterEach, describe, expect, it, vi } from 'vitest';
import { validate, type ScheduledTask } from 'node-cron';

const guards = vi.hoisted(() => ({
  forbidden: vi.fn(() => { throw new Error('Forbidden job/provider/database access'); }),
  stopRateLimiter: vi.fn(),
}));
vi.mock('../database/connection.js', () => ({ query: guards.forbidden, getPool: guards.forbidden }));
vi.mock('../collectors/GammaCollector.js', () => ({ getGammaCollector: guards.forbidden }));
vi.mock('../collectors/ClobCollector.js', () => ({ getClobCollector: guards.forbidden }));
vi.mock('./RateLimiter.js', () => ({ getRateLimiter: () => ({ stop: guards.stopRateLimiter }) }));
vi.mock('./AdaptiveSyncManager.js', () => ({ AdaptiveSyncManager: class {} }));
vi.mock('../collectors/ExternalDataCollector.js', () => ({ ExternalDataCollector: class {} }));
vi.mock('./MarketScorer.js', () => ({ MarketScorer: class {} }));
vi.mock('./MarketRotator.js', () => ({ MarketRotator: class {}, parseAllowedMarketTypes: guards.forbidden }));
vi.mock('../collectors/NewsCollector.js', () => ({ NewsCollector: class {} }));
vi.mock('./ScorerWeightOptimizer.js', () => ({ optimizeScorerWeights: guards.forbidden }));
vi.mock('./EdgeCapacityRefresher.js', () => ({ refreshEdgeCapacity: guards.forbidden, resolveEdgeRefreshConfig: guards.forbidden }));
vi.mock('./MarketPerformanceTracker.js', () => ({
  updateCategoryPriors: guards.forbidden,
  updateShadowCategoryPerformance: guards.forbidden,
  resolveShadowTrades: guards.forbidden,
  materializePredictionOutcomes: guards.forbidden,
}));

import { Scheduler } from './Scheduler.js';

describe('node-cron parent compatibility without business jobs', () => {
  let scheduler: Scheduler | undefined;
  let tasks: ScheduledTask[] = [];

  afterEach(async () => {
    scheduler?.stop();
    await Promise.all(tasks.map(task => task.stop()));
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('registers and stops the actual scheduler using fake time without initial sync or callbacks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-23T12:00:00Z'));
    scheduler = new Scheduler();
    const initialSync = vi.spyOn(scheduler as unknown as { runInitialSync(): Promise<void> }, 'runInitialSync').mockResolvedValue(undefined);
    const runJob = vi.spyOn(scheduler, 'runJob').mockImplementation(guards.forbidden);
    scheduler.start();
    const jobs = (scheduler as unknown as { jobs: Map<string, { schedule: string; task: ScheduledTask | null }> }).jobs;
    expect(jobs.size).toBeGreaterThan(0);
    expect([...jobs.values()].every(job => validate(job.schedule))).toBe(true);
    tasks = [...jobs.values()].map(job => job.task!);
    expect(tasks.every(task => task.getStatus() === 'idle')).toBe(true);
    expect(initialSync).toHaveBeenCalledOnce();
    expect(runJob).not.toHaveBeenCalled();
    expect(guards.forbidden).not.toHaveBeenCalled();
    scheduler.stop();
    await Promise.all(tasks.map(task => task.stop()));
    expect(tasks.every(task => task.getStatus() === 'stopped')).toBe(true);
  });
});
