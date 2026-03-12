import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AdaptiveSyncManager, type AdaptiveSyncConfig } from './AdaptiveSyncManager.js';

const DEFAULT_CONFIG: AdaptiveSyncConfig = {
  lagThresholdDegraded: 500,
  lagThresholdCritical: 1000,
  recoveryThreshold: 200,
  checkIntervalMs: 10000,
  degradedChecksRequired: 3,
  recoveryDurationMs: 300000,
  maxIntervalMultiplier: 4,
  skipEscalationThreshold: 3,
};

describe('AdaptiveSyncManager', () => {
  let manager: AdaptiveSyncManager;
  let fakeNow: number;
  const clock = () => fakeNow;

  beforeEach(() => {
    vi.useFakeTimers();
    fakeNow = 1_000_000; // arbitrary start
    manager = new AdaptiveSyncManager(DEFAULT_CONFIG, clock);
    manager.start();
  });

  afterEach(() => {
    manager.stop();
    vi.useRealTimers();
  });

  // Test 1: starts in NORMAL state with multiplier=1
  it('starts in NORMAL state with multiplier=1', () => {
    expect(manager.getState()).toBe('NORMAL');
    expect(manager.getIntervalMultiplier()).toBe(1);
  });

  // Test 2: transitions to DEGRADED after 3 consecutive high-lag reports (>500ms)
  it('transitions to DEGRADED after degradedChecksRequired consecutive high-lag reports', () => {
    manager.reportLag(600);
    expect(manager.getState()).toBe('NORMAL'); // only 1 check
    manager.reportLag(600);
    expect(manager.getState()).toBe('NORMAL'); // only 2 checks
    manager.reportLag(600);
    expect(manager.getState()).toBe('DEGRADED'); // 3rd check — threshold reached
    expect(manager.getIntervalMultiplier()).toBe(2);
  });

  // Test 3: transitions to CRITICAL immediately on >1000ms lag
  it('transitions to CRITICAL immediately on lag exceeding lagThresholdCritical', () => {
    manager.reportLag(1500);
    expect(manager.getState()).toBe('CRITICAL');
    expect(manager.getIntervalMultiplier()).toBe(3);
  });

  // Test 4: recovers to NORMAL after sustained low lag
  it('recovers to NORMAL after sustained low lag for recoveryDurationMs', () => {
    // Drive into CRITICAL
    manager.reportLag(1500);
    expect(manager.getState()).toBe('CRITICAL');

    // Report low lag — starts recovery timer at fakeNow=1_000_000
    manager.reportLag(100);
    expect(manager.getState()).toBe('CRITICAL'); // not recovered yet

    // Advance fake clock past recoveryDurationMs
    fakeNow += DEFAULT_CONFIG.recoveryDurationMs + 1;
    manager.reportLag(100);
    expect(manager.getState()).toBe('NORMAL');
    expect(manager.getIntervalMultiplier()).toBe(1);
  });

  // Test 5: multiplier never exceeds maxIntervalMultiplier
  it('multiplier never exceeds maxIntervalMultiplier', () => {
    manager.reportLag(9999);
    expect(manager.getIntervalMultiplier()).toBeLessThanOrEqual(DEFAULT_CONFIG.maxIntervalMultiplier);
  });

  // Test 6: reportJobSkip increments per-job counter
  it('reportJobSkip increments the per-job skip counter', () => {
    manager.reportJobSkip('sync-prices');
    manager.reportJobSkip('sync-prices');
    // 2 skips — not yet at threshold (3)
    expect(manager.shouldEscalateForJob('sync-prices')).toBe(false);
  });

  // Test 7: reportJobComplete resets skip count
  it('reportJobComplete resets the skip count for the job', () => {
    manager.reportJobSkip('sync-prices');
    manager.reportJobSkip('sync-prices');
    manager.reportJobComplete('sync-prices');
    // After complete, counter resets → should not be at threshold
    expect(manager.shouldEscalateForJob('sync-prices')).toBe(false);
  });

  // Test 8: shouldEscalateForJob returns true at threshold
  it('shouldEscalateForJob returns true when skip count reaches skipEscalationThreshold', () => {
    manager.reportJobSkip('sync-trades');
    manager.reportJobSkip('sync-trades');
    manager.reportJobSkip('sync-trades');
    expect(manager.shouldEscalateForJob('sync-trades')).toBe(true);
  });

  // Bonus: skip escalation drives state to DEGRADED when NORMAL
  it('3+ consecutive skips on a job escalates NORMAL → DEGRADED', () => {
    expect(manager.getState()).toBe('NORMAL');
    manager.reportJobSkip('sync-markets');
    manager.reportJobSkip('sync-markets');
    manager.reportJobSkip('sync-markets');
    expect(manager.getState()).toBe('DEGRADED');
  });

  // Bonus: DEGRADED does not drop to NORMAL on single low-lag without sufficient duration
  it('stays DEGRADED if low-lag duration not yet met', () => {
    manager.reportLag(600);
    manager.reportLag(600);
    manager.reportLag(600);
    expect(manager.getState()).toBe('DEGRADED');

    manager.reportLag(100); // low lag, but recovery timer just started — too soon
    expect(manager.getState()).toBe('DEGRADED');
  });
});
