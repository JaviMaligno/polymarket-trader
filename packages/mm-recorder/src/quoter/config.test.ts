import { describe, it, expect } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('defaults to off mode with shadow-permissive thresholds', () => {
    const cfg = loadConfig({});
    expect(cfg.mode).toBe('off');
    expect(cfg.quoteSize).toBe(20);
    expect(cfg.orderTtlMs).toBe(30 * 60_000);
    expect(cfg.requoteMinMs).toBe(1000);
    expect(cfg.nearResolutionMs).toBe(24 * 3_600_000);
    expect(cfg.minSpread).toBe(0);
    expect(cfg.volPause).toBe(Infinity);
    expect(cfg.volWindowMs).toBe(60_000);
    expect(cfg.maxInvPerMarket).toBe(20);
    expect(cfg.maxInvTotal).toBe(60);
    expect(cfg.maxCumLoss).toBe(50);
    expect(cfg.softInvPerMarket).toBe(10);
    expect(cfg.tick).toBe(0.01);
  });

  it('reads overrides from env-like record', () => {
    const cfg = loadConfig({
      MM_QUOTER_MODE: 'shadow', MM_QUOTE_SIZE: '40', MM_ORDER_TTL_MS: '600000',
      MM_VOL_PAUSE: '0.02', MM_MIN_SPREAD: '0.01', MM_TICK: '0.001',
    });
    expect(cfg.mode).toBe('shadow');
    expect(cfg.quoteSize).toBe(40);
    expect(cfg.orderTtlMs).toBe(600_000);
    expect(cfg.volPause).toBe(0.02);
    expect(cfg.minSpread).toBe(0.01);
    expect(cfg.tick).toBe(0.001);
  });

  it('rejects unknown mode', () => {
    expect(() => loadConfig({ MM_QUOTER_MODE: 'yolo' })).toThrow();
  });

  it('throws on non-numeric value', () => {
    expect(() => loadConfig({ MM_QUOTE_SIZE: 'abc' })).toThrow();
  });

  it('converts MM_NEAR_RESOLUTION_HOURS to ms', () => {
    const cfg = loadConfig({ MM_NEAR_RESOLUTION_HOURS: '48' });
    expect(cfg.nearResolutionMs).toBe(48 * 3_600_000);
  });
});

describe('loadConfig — live fields', () => {
  it('parsea campos live con defaults seguros', () => {
    const c = loadConfig({ MM_QUOTER_MODE: 'live' });
    expect(c.maxNotionalTotal).toBe(100);
    expect(c.fillPollMs).toBe(3000);
    expect(c.walletSecretName).toBe('');
    expect(c.liveSubset).toEqual([]); // vacío = ningún mercado habilitado para live
  });

  it('parsea subset CSV y secret name', () => {
    const c = loadConfig({
      MM_QUOTER_MODE: 'live',
      MM_LIVE_SUBSET: 'mktA, mktB ,mktC',
      MM_WALLET_SECRET_NAME: 'projects/x/secrets/mm-key/versions/latest',
      MM_MAX_NOTIONAL_TOTAL: '250',
      MM_FILL_POLL_MS: '2000',
    });
    expect(c.liveSubset).toEqual(['mktA', 'mktB', 'mktC']);
    expect(c.walletSecretName).toBe('projects/x/secrets/mm-key/versions/latest');
    expect(c.maxNotionalTotal).toBe(250);
    expect(c.fillPollMs).toBe(2000);
  });
});
