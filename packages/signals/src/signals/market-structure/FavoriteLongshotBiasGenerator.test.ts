import { describe, it, expect } from 'vitest';
import {
  FavoriteLongshotBiasGenerator,
  DEFAULT_FAVORITE_LONGSHOT_BIAS_PARAMS,
} from './FavoriteLongshotBiasGenerator.js';
import type { SignalContext, PriceBar } from '../../core/types/signal.types.js';

const NOW = new Date('2026-05-17T12:00:00Z');

function bars(closes: number[]): PriceBar[] {
  return closes.map((close, i) => ({
    time: new Date(NOW.getTime() - (closes.length - i) * 60_000),
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 1000,
    tradeCount: 1,
  }));
}

function context(closes: number[]): SignalContext {
  return {
    market: {
      id: 'mkt',
      question: 'q',
      isActive: true,
      isResolved: false,
      tokenIdYes: 'tok-yes',
    },
    priceBars: bars(closes),
    recentTrades: [],
    currentTime: NOW,
  };
}

describe('FavoriteLongshotBiasGenerator', () => {
  describe('basic behaviour', () => {
    it('signalId is "favorite_longshot_bias"', () => {
      const gen = new FavoriteLongshotBiasGenerator();
      expect(gen.signalId).toBe('favorite_longshot_bias');
    });

    it('uses sensible defaults: longshotThreshold=0.10, favoriteThreshold=0.90', () => {
      expect(DEFAULT_FAVORITE_LONGSHOT_BIAS_PARAMS.longshotThreshold).toBe(0.10);
      expect(DEFAULT_FAVORITE_LONGSHOT_BIAS_PARAMS.favoriteThreshold).toBe(0.90);
    });

    it('isReady requires at least one price bar', () => {
      const gen = new FavoriteLongshotBiasGenerator();
      expect(gen.isReady(context([]))).toBe(false);
      expect(gen.isReady(context([0.5]))).toBe(true);
    });

    it('getRequiredLookback returns 0 (point estimate only)', () => {
      const gen = new FavoriteLongshotBiasGenerator();
      expect(gen.getRequiredLookback()).toBe(0);
    });
  });

  describe('longshot band (price < longshotThreshold)', () => {
    it('emits LONG when price is well below longshotThreshold', async () => {
      const gen = new FavoriteLongshotBiasGenerator();
      const out = await gen.compute(context([0.03]));
      expect(out).not.toBeNull();
      expect(out!.direction).toBe('LONG');
      expect(out!.strength).toBeGreaterThan(0);
    });

    it('strength scales with distance from boundary (deeper longshot = stronger)', async () => {
      const gen = new FavoriteLongshotBiasGenerator();
      const out01 = await gen.compute(context([0.01]));
      const out08 = await gen.compute(context([0.08]));
      expect(out01).not.toBeNull();
      expect(out08).not.toBeNull();
      expect(out01!.strength).toBeGreaterThan(out08!.strength);
    });

    it('returns null near the boundary (strength below minStrength)', async () => {
      // price = 0.099 → magnitude = (0.10 - 0.099) / 0.10 = 0.01, below default 0.05 minStrength
      const gen = new FavoriteLongshotBiasGenerator();
      const out = await gen.compute(context([0.099]));
      expect(out).toBeNull();
    });
  });

  describe('favorite band (price > favoriteThreshold)', () => {
    it('emits SHORT when price is well above favoriteThreshold', async () => {
      const gen = new FavoriteLongshotBiasGenerator();
      const out = await gen.compute(context([0.97]));
      expect(out).not.toBeNull();
      expect(out!.direction).toBe('SHORT');
      expect(out!.strength).toBeLessThan(0);
    });

    it('strength magnitude scales with distance from boundary (deeper favorite = stronger)', async () => {
      const gen = new FavoriteLongshotBiasGenerator();
      const out99 = await gen.compute(context([0.99]));
      const out92 = await gen.compute(context([0.92]));
      expect(out99).not.toBeNull();
      expect(out92).not.toBeNull();
      expect(Math.abs(out99!.strength)).toBeGreaterThan(Math.abs(out92!.strength));
    });

    it('returns null near the boundary (strength below minStrength)', async () => {
      // price = 0.901 → magnitude = (0.901 - 0.90) / 0.10 = 0.01, below default 0.05 minStrength
      const gen = new FavoriteLongshotBiasGenerator();
      const out = await gen.compute(context([0.901]));
      expect(out).toBeNull();
    });
  });

  describe('mid-range (no edge)', () => {
    it('returns null when price is in (longshotThreshold, favoriteThreshold)', async () => {
      const gen = new FavoriteLongshotBiasGenerator();
      for (const p of [0.15, 0.30, 0.50, 0.70, 0.85]) {
        const out = await gen.compute(context([p]));
        expect(out, `price ${p} should not emit a signal`).toBeNull();
      }
    });
  });

  describe('terminal / invalid prices', () => {
    it('returns null when price is 0 (market resolved NO)', async () => {
      const gen = new FavoriteLongshotBiasGenerator();
      expect(await gen.compute(context([0]))).toBeNull();
    });

    it('returns null when price is 1 (market resolved YES)', async () => {
      const gen = new FavoriteLongshotBiasGenerator();
      expect(await gen.compute(context([1]))).toBeNull();
    });

    it('returns null on negative price (data corruption)', async () => {
      const gen = new FavoriteLongshotBiasGenerator();
      expect(await gen.compute(context([-0.05]))).toBeNull();
    });

    it('returns null on price > 1 (data corruption)', async () => {
      const gen = new FavoriteLongshotBiasGenerator();
      expect(await gen.compute(context([1.05]))).toBeNull();
    });

    it('returns null on empty price bars', async () => {
      const gen = new FavoriteLongshotBiasGenerator();
      expect(await gen.compute(context([]))).toBeNull();
    });
  });

  describe('output shape', () => {
    it('strength stays within [-1, 1]', async () => {
      const gen = new FavoriteLongshotBiasGenerator();
      const longshot = await gen.compute(context([0.001]));
      const favorite = await gen.compute(context([0.999]));
      expect(longshot!.strength).toBeGreaterThanOrEqual(-1);
      expect(longshot!.strength).toBeLessThanOrEqual(1);
      expect(favorite!.strength).toBeGreaterThanOrEqual(-1);
      expect(favorite!.strength).toBeLessThanOrEqual(1);
    });

    it('confidence is in [0.4, 0.9] for non-null outputs', async () => {
      const gen = new FavoriteLongshotBiasGenerator();
      for (const p of [0.001, 0.05, 0.08, 0.92, 0.95, 0.999]) {
        const out = await gen.compute(context([p]));
        expect(out, `price ${p} should emit`).not.toBeNull();
        expect(out!.confidence).toBeGreaterThanOrEqual(0.4);
        expect(out!.confidence).toBeLessThanOrEqual(0.9);
      }
    });

    it('confidence scales with edge magnitude', async () => {
      const gen = new FavoriteLongshotBiasGenerator();
      const weak = await gen.compute(context([0.08]));
      const strong = await gen.compute(context([0.01]));
      expect(strong!.confidence).toBeGreaterThan(weak!.confidence);
    });

    it('attaches diagnostic metadata (currentPrice, band)', async () => {
      const gen = new FavoriteLongshotBiasGenerator();
      const out = await gen.compute(context([0.05]));
      expect(out!.metadata).toMatchObject({
        currentPrice: 0.05,
        band: 'longshot',
      });
    });
  });

  describe('parameter overrides', () => {
    it('respects custom longshotThreshold', async () => {
      const gen = new FavoriteLongshotBiasGenerator({ longshotThreshold: 0.20 });
      const out = await gen.compute(context([0.15])); // would be null under default
      expect(out).not.toBeNull();
      expect(out!.direction).toBe('LONG');
    });

    it('respects custom favoriteThreshold', async () => {
      const gen = new FavoriteLongshotBiasGenerator({ favoriteThreshold: 0.80 });
      const out = await gen.compute(context([0.85])); // would be null under default
      expect(out).not.toBeNull();
      expect(out!.direction).toBe('SHORT');
    });

    it('respects custom minStrength gate', async () => {
      const lax = new FavoriteLongshotBiasGenerator({ minStrength: 0.0 });
      const strict = new FavoriteLongshotBiasGenerator({ minStrength: 0.5 });
      const out_lax = await lax.compute(context([0.09]));
      const out_strict = await strict.compute(context([0.09]));
      expect(out_lax).not.toBeNull();
      expect(out_strict).toBeNull();
    });
  });
});
