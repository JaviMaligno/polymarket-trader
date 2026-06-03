import { describe, it, expect, beforeEach } from 'vitest';
import { getFLBConfig } from './FLBConfig.js';

const FLB_ENV = [
  'FLB_EXECUTOR_ENABLED','FLB_DRY_RUN','FLB_SCAN_INTERVAL_MS','FLB_RECONCILE_INTERVAL_MS',
  'FLB_LONGSHOT_LO','FLB_LONGSHOT_HI','FLB_MIN_TTR_HOURS','FLB_MAX_ENTRY_COST_PCT',
  'FLB_MAX_POSITION_PCT','FLB_MAX_LOCKED_CAPITAL_PCT','FLB_MAX_SAME_WEEK_POSITIONS','FLB_ELIGIBLE_TYPES',
];

describe('getFLBConfig', () => {
  beforeEach(() => { for (const k of FLB_ENV) delete process.env[k]; });

  it('returns documented defaults when env unset', () => {
    const c = getFLBConfig();
    expect(c.enabled).toBe(false);
    expect(c.dryRun).toBe(false);
    expect(c.scanIntervalMs).toBe(21_600_000);
    expect(c.reconcileIntervalMs).toBe(21_600_000);
    expect(c.longshotLo).toBe(0.02);
    expect(c.longshotHi).toBe(0.10);
    expect(c.minTtrHours).toBe(48);
    expect(c.maxEntryCostPct).toBe(1.0);
    expect(c.maxPositionPct).toBe(0.21);
    expect(c.maxLockedCapitalPct).toBe(5.0);
    expect(c.maxSameWeekPositions).toBe(50);
    expect(c.eligibleTypes).toEqual(['crypto_daily','event_financial','event_short','event_long']);
  });

  it('honours FLB_EXECUTOR_ENABLED=true', () => {
    process.env.FLB_EXECUTOR_ENABLED = 'true';
    expect(getFLBConfig().enabled).toBe(true);
  });

  it('parses numeric overrides', () => {
    process.env.FLB_MAX_POSITION_PCT = '0.5';
    process.env.FLB_MAX_SAME_WEEK_POSITIONS = '30';
    const c = getFLBConfig();
    expect(c.maxPositionPct).toBe(0.5);
    expect(c.maxSameWeekPositions).toBe(30);
  });

  it('falls back to default on non-numeric override', () => {
    process.env.FLB_MAX_ENTRY_COST_PCT = 'abc';
    expect(getFLBConfig().maxEntryCostPct).toBe(1.0);
  });

  it('parses eligible types CSV, trimming blanks', () => {
    process.env.FLB_ELIGIBLE_TYPES = 'crypto_daily, event_short ,';
    expect(getFLBConfig().eligibleTypes).toEqual(['crypto_daily','event_short']);
  });
});
