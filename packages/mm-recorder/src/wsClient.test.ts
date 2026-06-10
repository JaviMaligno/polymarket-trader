import { describe, it, expect } from 'vitest';
import { buildSubscribe, backoffMs, GapTracker } from './wsClient.js';

describe('wsClient helpers', () => {
  it('builds the market-channel subscribe payload', () => {
    const p = JSON.parse(buildSubscribe(['A', 'B']));
    expect(p.type).toBe('market');
    expect(p.assets_ids).toEqual(['A', 'B']);
    expect(p.custom_feature_enabled).toBeUndefined();
  });

  it('backoff grows and caps at 30s', () => {
    expect(backoffMs(0)).toBe(1000);
    expect(backoffMs(1)).toBe(2000);
    expect(backoffMs(2)).toBe(4000);
    expect(backoffMs(10)).toBe(30000);
  });
});

describe('GapTracker — a gap is [disconnect, reconnect], never the uptime session', () => {
  const t = (s: number) => new Date(1_700_000_000_000 + s * 1000);

  it('no gap on first connect (no prior disconnect)', () => {
    const g = new GapTracker();
    expect(g.up(t(0))).toBeNull();
  });

  it('records [downAt, upAt] for a single disconnect/reconnect cycle', () => {
    const g = new GapTracker();
    g.down(t(10), 'close');
    expect(g.up(t(12))).toEqual({ start: t(10), end: t(12), reason: 'close' });
  });

  it('repeated downs before a reconnect keep the FIRST disconnect time', () => {
    const g = new GapTracker();
    g.down(t(10), 'close');
    g.down(t(40), 'error');
    expect(g.up(t(41))).toEqual({ start: t(10), end: t(41), reason: 'close' });
  });

  it('resets after a reconnect so the next cycle is independent', () => {
    const g = new GapTracker();
    g.down(t(10), 'close');
    g.up(t(11));
    expect(g.up(t(20))).toBeNull();
    g.down(t(30), 'close');
    expect(g.up(t(33))).toEqual({ start: t(30), end: t(33), reason: 'close' });
  });
});
