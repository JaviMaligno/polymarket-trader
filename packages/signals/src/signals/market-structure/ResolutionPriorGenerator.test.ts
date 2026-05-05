import { describe, it, expect } from 'vitest';
import {
  ResolutionPriorGenerator,
  DEFAULT_RESOLUTION_PRIOR_PARAMS,
} from './ResolutionPriorGenerator.js';
import type { SignalContext, PriceBar } from '../../core/types/signal.types.js';

const NOW = new Date('2026-05-05T12:00:00Z');

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

function context(
  closes: number[],
  daysToResolution: number,
): SignalContext {
  const priceBars = bars(closes);
  return {
    market: {
      id: 'mkt',
      question: 'q',
      isActive: true,
      isResolved: false,
      tokenIdYes: 'tok-yes',
      endDate: new Date(NOW.getTime() + daysToResolution * 24 * 60 * 60 * 1000),
    },
    priceBars,
    recentTrades: [],
    currentTime: NOW,
  };
}

describe('ResolutionPriorGenerator', () => {
  describe('basic behaviour', () => {
    it('signalId is "resolution_prior"', () => {
      const gen = new ResolutionPriorGenerator();
      expect(gen.signalId).toBe('resolution_prior');
    });

    it('uses sensible defaults: cutoffDays=14, minPriceDistance=0.05', () => {
      expect(DEFAULT_RESOLUTION_PRIOR_PARAMS.cutoffDays).toBe(14);
      expect(DEFAULT_RESOLUTION_PRIOR_PARAMS.minPriceDistance).toBe(0.05);
    });

    it('isReady returns false without an endDate', () => {
      const gen = new ResolutionPriorGenerator();
      const ctx = context([0.3], 5);
      delete (ctx.market as { endDate?: Date }).endDate;
      expect(gen.isReady(ctx)).toBe(false);
    });
  });

  describe('LONG bias for price > 0.5 near expiry', () => {
    it('emits LONG when price=0.85 and 2d to resolution', async () => {
      const gen = new ResolutionPriorGenerator();
      const result = await gen.compute(context([0.85], 2));
      expect(result).not.toBeNull();
      expect(result!.direction).toBe('LONG');
      expect(result!.strength).toBeGreaterThan(0);
    });

    it('strength scales with time proximity (closer to expiry = stronger)', async () => {
      const gen = new ResolutionPriorGenerator();
      const close = await gen.compute(context([0.85], 1));
      const far = await gen.compute(context([0.85], 12));
      expect(close).not.toBeNull();
      expect(far).not.toBeNull();
      expect(close!.strength).toBeGreaterThan(far!.strength);
    });

    it('strength scales with price distance (extremes = stronger)', async () => {
      const gen = new ResolutionPriorGenerator();
      const extreme = await gen.compute(context([0.95], 5));
      const moderate = await gen.compute(context([0.65], 5));
      expect(extreme).not.toBeNull();
      expect(moderate).not.toBeNull();
      expect(extreme!.strength).toBeGreaterThan(moderate!.strength);
    });
  });

  describe('SHORT bias for price < 0.5 near expiry', () => {
    it('emits SHORT when price=0.20 and 3d to resolution', async () => {
      const gen = new ResolutionPriorGenerator();
      const result = await gen.compute(context([0.20], 3));
      expect(result).not.toBeNull();
      expect(result!.direction).toBe('SHORT');
      expect(result!.strength).toBeLessThan(0);
    });

    it('emits SHORT for price=0.10 with 1d (very strong)', async () => {
      const gen = new ResolutionPriorGenerator();
      const result = await gen.compute(context([0.10], 1));
      expect(result).not.toBeNull();
      expect(result!.direction).toBe('SHORT');
      expect(Math.abs(result!.strength)).toBeGreaterThan(0.7);
    });
  });

  describe('null/skip cases', () => {
    it('returns null when daysToResolution > cutoffDays', async () => {
      const gen = new ResolutionPriorGenerator();
      expect(await gen.compute(context([0.20], 30))).toBeNull();
    });

    it('returns null when market already expired (daysToResolution <= 0)', async () => {
      const gen = new ResolutionPriorGenerator();
      expect(await gen.compute(context([0.20], 0))).toBeNull();
      expect(await gen.compute(context([0.20], -1))).toBeNull();
    });

    it('returns null when price is at the coin-flip prior (within minPriceDistance)', async () => {
      const gen = new ResolutionPriorGenerator();
      expect(await gen.compute(context([0.50], 5))).toBeNull();
      expect(await gen.compute(context([0.48], 5))).toBeNull();
      expect(await gen.compute(context([0.52], 5))).toBeNull();
    });

    it('returns null at extreme prices already at resolution (0 / 1)', async () => {
      const gen = new ResolutionPriorGenerator();
      expect(await gen.compute(context([0.0], 5))).toBeNull();
      expect(await gen.compute(context([1.0], 5))).toBeNull();
    });

    it('returns null when no price bars available', async () => {
      const gen = new ResolutionPriorGenerator();
      const ctx = context([], 5);
      expect(await gen.compute(ctx)).toBeNull();
    });

    it('returns null when no endDate set on market', async () => {
      const gen = new ResolutionPriorGenerator();
      const ctx = context([0.20], 5);
      delete (ctx.market as { endDate?: Date }).endDate;
      expect(await gen.compute(ctx)).toBeNull();
    });
  });

  describe('strength bounds', () => {
    it('|strength| stays within [0, 1] across the parameter ranges', async () => {
      const gen = new ResolutionPriorGenerator();
      for (const price of [0.05, 0.20, 0.40, 0.60, 0.80, 0.95]) {
        for (const days of [0.1, 1, 5, 10, 13]) {
          const result = await gen.compute(context([price], days));
          if (result) {
            expect(Math.abs(result.strength)).toBeLessThanOrEqual(1);
            expect(Math.abs(result.strength)).toBeGreaterThanOrEqual(0);
          }
        }
      }
    });

    it('confidence stays within [0, 1]', async () => {
      const gen = new ResolutionPriorGenerator();
      for (const price of [0.05, 0.20, 0.80, 0.95]) {
        for (const days of [0.1, 5, 13]) {
          const result = await gen.compute(context([price], days));
          if (result) {
            expect(result.confidence).toBeGreaterThanOrEqual(0);
            expect(result.confidence).toBeLessThanOrEqual(1);
          }
        }
      }
    });
  });

  describe('config overrides', () => {
    it('accepts a smaller cutoffDays', async () => {
      const gen = new ResolutionPriorGenerator({ cutoffDays: 5 });
      expect(await gen.compute(context([0.20], 6))).toBeNull();
      expect(await gen.compute(context([0.20], 4))).not.toBeNull();
    });

    it('accepts a larger minPriceDistance', async () => {
      const gen = new ResolutionPriorGenerator({ minPriceDistance: 0.30 });
      // priceDistance is |price - 0.5| / 0.5. minPriceDistance=0.30 → require
      // |price - 0.5| >= 0.15 → price ∉ (0.35, 0.65).
      expect(await gen.compute(context([0.42], 5))).toBeNull();   // 0.16 < 0.30
      expect(await gen.compute(context([0.15], 5))).not.toBeNull(); // 0.70 > 0.30
    });
  });

  describe('metadata', () => {
    it('emits the inputs as metadata for downstream debug', async () => {
      const gen = new ResolutionPriorGenerator();
      const result = await gen.compute(context([0.20], 3));
      expect(result?.metadata).toMatchObject({
        currentPrice: 0.20,
        daysToResolution: expect.any(Number),
        priceDistance: expect.any(Number),
        timeProximity: expect.any(Number),
      });
    });
  });
});
