import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BudgetTracker } from './BudgetTracker.js';

describe('BudgetTracker', () => {
  let tracker: BudgetTracker;

  beforeEach(() => {
    tracker = new BudgetTracker(1.0);
  });

  it('allows spending when under budget', () => {
    expect(tracker.canSpend()).toBe(true);
  });

  it('blocks spending when budget exceeded', () => {
    tracker.record(4_000_000, 0);
    expect(tracker.canSpend()).toBe(false);
  });

  it('tracks cumulative spend', () => {
    tracker.record(1_000_000, 0);
    expect(tracker.canSpend()).toBe(true);
    tracker.record(1_000_000, 0);
    expect(tracker.canSpend()).toBe(true);
    tracker.record(2_000_000, 0);
    expect(tracker.canSpend()).toBe(false);
  });

  it('resets at new day', () => {
    tracker.record(4_000_000, 0);
    expect(tracker.canSpend()).toBe(false);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 25 * 60 * 60 * 1000));
    tracker.resetIfNewDay();
    expect(tracker.canSpend()).toBe(true);
    vi.useRealTimers();
  });

  it('reports spent amount', () => {
    tracker.record(1_000_000, 100_000);
    expect(tracker.getSpentUSD()).toBeCloseTo(0.375, 2);
  });
});
