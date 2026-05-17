import { describe, it, expect } from 'vitest';
import {
  ResolutionPriorV2Generator,
  DEFAULT_RESOLUTION_PRIOR_V2_PARAMS,
} from './ResolutionPriorV2Generator.js';
import type { SignalContext, PriceBar } from '../../core/types/signal.types.js';

const NOW = new Date('2026-05-17T12:00:00Z');

function bars(closes: number[]): PriceBar[] {
  return closes.map((close, i) => ({
    time: new Date(NOW.getTime() - (closes.length - i) * 5 * 60_000),
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
  return {
    market: {
      id: 'mkt',
      question: 'q',
      isActive: true,
      isResolved: false,
      tokenIdYes: 'tok-yes',
      endDate: new Date(NOW.getTime() + daysToResolution * 24 * 60 * 60 * 1000),
    },
    priceBars: bars(closes),
    recentTrades: [],
    currentTime: NOW,
  };
}

/** anchor window 24 bars at 0.30, recent window 24 bars climbing to 0.50.
 *  Total 48 bars. Used as the canonical "directional move" fixture. */
function divergenceFixture(): number[] {
  const anchor = Array(24).fill(0.30);
  const recent = Array.from({ length: 24 }, (_, i) => 0.30 + (i + 1) * (0.20 / 24));
  return [...anchor, ...recent];
}

describe('ResolutionPriorV2Generator', () => {
  describe('basic behaviour', () => {
    it('signalId is "resolution_prior_v2"', () => {
      const gen = new ResolutionPriorV2Generator();
      expect(gen.signalId).toBe('resolution_prior_v2');
    });

    it('uses sensible defaults', () => {
      expect(DEFAULT_RESOLUTION_PRIOR_V2_PARAMS.anchorWindow).toBe(24);
      expect(DEFAULT_RESOLUTION_PRIOR_V2_PARAMS.recentWindow).toBe(24);
      expect(DEFAULT_RESOLUTION_PRIOR_V2_PARAMS.cutoffDays).toBe(7);
      expect(DEFAULT_RESOLUTION_PRIOR_V2_PARAMS.minZScore).toBe(2.5);
    });

    it('getRequiredLookback returns anchorWindow + recentWindow', () => {
      const gen = new ResolutionPriorV2Generator();
      expect(gen.getRequiredLookback()).toBe(48);
    });

    it('isReady requires endDate AND enough price bars', () => {
      const gen = new ResolutionPriorV2Generator();
      const ctxWithoutBars = context([], 3);
      expect(gen.isReady(ctxWithoutBars)).toBe(false);

      const ctxFewBars = context([0.5, 0.5, 0.5], 3);
      expect(gen.isReady(ctxFewBars)).toBe(false);

      const ctxEnough = context(Array(48).fill(0.5), 3);
      expect(gen.isReady(ctxEnough)).toBe(true);

      const noEndDate: SignalContext = {
        ...ctxEnough,
        market: { ...ctxEnough.market, endDate: undefined },
      };
      expect(gen.isReady(noEndDate)).toBe(false);
    });
  });

  describe('cutoff and resolution gating', () => {
    it('returns null when daysToResolution > cutoffDays', async () => {
      const gen = new ResolutionPriorV2Generator();
      const out = await gen.compute(context(divergenceFixture(), 14));
      expect(out).toBeNull();
    });

    it('returns null when daysToResolution <= 0 (resolved or expired)', async () => {
      const gen = new ResolutionPriorV2Generator();
      expect(await gen.compute(context(divergenceFixture(), 0))).toBeNull();
      expect(await gen.compute(context(divergenceFixture(), -1))).toBeNull();
    });

    it('fires within cutoff window', async () => {
      const gen = new ResolutionPriorV2Generator();
      const out = await gen.compute(context(divergenceFixture(), 3));
      expect(out).not.toBeNull();
    });
  });

  describe('direction (mean-reversion vs anchor)', () => {
    it('emits SHORT when current price is significantly ABOVE the anchor', async () => {
      const gen = new ResolutionPriorV2Generator();
      const out = await gen.compute(context(divergenceFixture(), 3));
      expect(out).not.toBeNull();
      expect(out!.direction).toBe('SHORT');
      expect(out!.strength).toBeLessThan(0);
    });

    it('emits LONG when current price is significantly BELOW the anchor', async () => {
      const gen = new ResolutionPriorV2Generator();
      // Reverse: anchor at 0.70, recent drift down to 0.50
      const anchor = Array(24).fill(0.70);
      const recent = Array.from({ length: 24 }, (_, i) => 0.70 - (i + 1) * (0.20 / 24));
      const out = await gen.compute(context([...anchor, ...recent], 3));
      expect(out).not.toBeNull();
      expect(out!.direction).toBe('LONG');
      expect(out!.strength).toBeGreaterThan(0);
    });

    it('returns null when current price is at the anchor (no divergence)', async () => {
      const gen = new ResolutionPriorV2Generator();
      const out = await gen.compute(context(Array(48).fill(0.50), 3));
      expect(out).toBeNull();
    });
  });

  describe('z-score gating', () => {
    it('returns null when |z| is below minZScore threshold', async () => {
      // Small divergence: anchor 0.50, recent 0.51. With σ ~ 0.003, z ~ 3 — should fire.
      // To stay BELOW z=2.5: divergence small AND σ large. Use very tight anchor + very noisy recent.
      const anchor = Array(24).fill(0.50);
      const recent = [0.50, 0.55, 0.45, 0.55, 0.45, 0.55, 0.45, 0.55, 0.45, 0.55, 0.45, 0.55,
                      0.45, 0.55, 0.45, 0.55, 0.45, 0.55, 0.45, 0.55, 0.45, 0.55, 0.45, 0.51];
      // anchor SMA = 0.50, recent mean ≈ 0.50, σ ≈ 0.05; z ≈ (0.51-0.50)/0.05 = 0.2 — below 2.5.
      const gen = new ResolutionPriorV2Generator();
      const out = await gen.compute(context([...anchor, ...recent], 3));
      expect(out).toBeNull();
    });

    it('saturates strength at high z (z > 5 hits magnitude 1)', async () => {
      // Extreme divergence: anchor 0.30, recent constant at 0.80
      const anchor = Array(24).fill(0.30);
      const recent = Array(24).fill(0.80);
      const gen = new ResolutionPriorV2Generator();
      const out = await gen.compute(context([...anchor, ...recent], 3));
      expect(out).not.toBeNull();
      // recent stddev = 0 → would blow up. The minSigma floor (0.005) saves us.
      // With σ=0.005 and deviation 0.50, z = 100. Magnitude saturates at 1.
      expect(Math.abs(out!.strength)).toBeCloseTo(1, 5);
    });
  });

  describe('low-volatility guard (minSigma)', () => {
    it('uses the minSigma floor when recent stddev is below it', async () => {
      const anchor = Array(24).fill(0.50);
      const recent = Array(24).fill(0.55);  // σ = 0 — must use floor
      const gen = new ResolutionPriorV2Generator();
      const out = await gen.compute(context([...anchor, ...recent], 3));
      // deviation = 0.05, σ_floor = 0.005, z = 10 — fires SHORT.
      expect(out).not.toBeNull();
      expect(out!.direction).toBe('SHORT');
    });
  });

  describe('terminal / invalid prices', () => {
    it('returns null when current price is 0', async () => {
      const gen = new ResolutionPriorV2Generator();
      const closes = [...Array(47).fill(0.50), 0];
      expect(await gen.compute(context(closes, 3))).toBeNull();
    });

    it('returns null when current price is 1', async () => {
      const gen = new ResolutionPriorV2Generator();
      const closes = [...Array(47).fill(0.50), 1];
      expect(await gen.compute(context(closes, 3))).toBeNull();
    });

    it('returns null when anchor SMA falls outside (0, 1)', async () => {
      const gen = new ResolutionPriorV2Generator();
      // Anchor entirely at 0 (data corruption) — division-safe but signal meaningless
      const closes = [...Array(24).fill(0), ...Array(24).fill(0.5)];
      expect(await gen.compute(context(closes, 3))).toBeNull();
    });
  });

  describe('output shape', () => {
    it('strength stays within [-1, 1]', async () => {
      const gen = new ResolutionPriorV2Generator();
      const out = await gen.compute(context(divergenceFixture(), 3));
      expect(out!.strength).toBeGreaterThanOrEqual(-1);
      expect(out!.strength).toBeLessThanOrEqual(1);
    });

    it('confidence is in [0.4, 0.9]', async () => {
      const gen = new ResolutionPriorV2Generator();
      const out = await gen.compute(context(divergenceFixture(), 3));
      expect(out!.confidence).toBeGreaterThanOrEqual(0.4);
      expect(out!.confidence).toBeLessThanOrEqual(0.9);
    });

    it('attaches diagnostic metadata', async () => {
      const gen = new ResolutionPriorV2Generator();
      const out = await gen.compute(context(divergenceFixture(), 3));
      expect(out!.metadata).toMatchObject({
        anchor: expect.any(Number),
        sigma: expect.any(Number),
        zScore: expect.any(Number),
        currentPrice: expect.any(Number),
      });
    });
  });

  describe('parameter overrides', () => {
    it('respects custom cutoffDays', async () => {
      const gen = new ResolutionPriorV2Generator({ cutoffDays: 14 });
      const out = await gen.compute(context(divergenceFixture(), 10));
      expect(out).not.toBeNull();  // would be null with default cutoff=7
    });

    it('respects custom minZScore (relaxed)', async () => {
      const gen = new ResolutionPriorV2Generator({ minZScore: 0.5 });
      const anchor = Array(24).fill(0.50);
      const recent = Array(24).fill(0.51);  // small divergence, would not fire at default 2.5
      const out = await gen.compute(context([...anchor, ...recent], 3));
      expect(out).not.toBeNull();
    });

    it('respects custom anchorWindow/recentWindow', async () => {
      const gen = new ResolutionPriorV2Generator({ anchorWindow: 12, recentWindow: 12 });
      expect(gen.getRequiredLookback()).toBe(24);

      const anchor = Array(12).fill(0.30);
      const recent = Array(12).fill(0.55);
      const out = await gen.compute(context([...anchor, ...recent], 3));
      expect(out).not.toBeNull();
    });
  });
});
