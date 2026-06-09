import { describe, it, expect } from 'vitest';
import { buildSubscribe, backoffMs } from './wsClient.js';

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
