import { describe, it, expect } from 'vitest';
import { VolTracker } from './volTracker.js';

const t = (s: number) => new Date(Date.UTC(2026, 5, 12, 10, 0, s));

describe('VolTracker', () => {
  it('reports max |Δmid| within the window', () => {
    const v = new VolTracker(60_000);
    v.add('T', t(0), 0.50);
    v.add('T', t(10), 0.53);
    v.add('T', t(20), 0.51);
    expect(v.recentVol('T', t(20))).toBeCloseTo(0.03, 10);
  });

  it('drops samples older than the window', () => {
    const v = new VolTracker(60_000);
    v.add('T', t(0), 0.10);
    v.add('T', t(70), 0.50);
    v.add('T', t(80), 0.505);
    expect(v.recentVol('T', t(80))).toBeCloseTo(0.005, 10);
  });

  it('returns 0 with fewer than 2 samples', () => {
    const v = new VolTracker(60_000);
    expect(v.recentVol('T', t(0))).toBe(0);
    v.add('T', t(0), 0.5);
    expect(v.recentVol('T', t(0))).toBe(0);
  });
});
