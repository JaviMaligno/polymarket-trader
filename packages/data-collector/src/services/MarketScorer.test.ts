import { describe, it, expect } from 'vitest';
import {
  MarketScorer,
  type ScoreDimensions,
} from './MarketScorer.js';

describe('MarketScorer', () => {
  // ─── tradeabilityScore ───────────────────────────────────────────────
  describe('tradeabilityScore', () => {
    it('returns 0 for null price', () => {
      expect(MarketScorer.tradeabilityScore(null)).toBe(0);
    });

    it('returns 0 for price < 0.05', () => {
      expect(MarketScorer.tradeabilityScore(0.0)).toBe(0);
      expect(MarketScorer.tradeabilityScore(0.02)).toBe(0);
      expect(MarketScorer.tradeabilityScore(0.049)).toBe(0);
    });

    it('returns 0 for price > 0.95', () => {
      expect(MarketScorer.tradeabilityScore(0.951)).toBe(0);
      expect(MarketScorer.tradeabilityScore(0.99)).toBe(0);
      expect(MarketScorer.tradeabilityScore(1.0)).toBe(0);
    });

    it('returns 0 for 50/50 zone [0.45-0.55]', () => {
      expect(MarketScorer.tradeabilityScore(0.45)).toBe(0);
      expect(MarketScorer.tradeabilityScore(0.50)).toBe(0);
      expect(MarketScorer.tradeabilityScore(0.55)).toBe(0);
    });

    it('returns 1.0 for optimal low range [0.15-0.40]', () => {
      expect(MarketScorer.tradeabilityScore(0.15)).toBe(1.0);
      expect(MarketScorer.tradeabilityScore(0.25)).toBe(1.0);
      expect(MarketScorer.tradeabilityScore(0.40)).toBe(1.0);
    });

    it('returns 1.0 for optimal high range [0.60-0.85]', () => {
      expect(MarketScorer.tradeabilityScore(0.60)).toBe(1.0);
      expect(MarketScorer.tradeabilityScore(0.70)).toBe(1.0);
      expect(MarketScorer.tradeabilityScore(0.85)).toBe(1.0);
    });

    it('linearly ramps from 0 to 1 between 0.05 and 0.15', () => {
      expect(MarketScorer.tradeabilityScore(0.05)).toBe(0);
      expect(MarketScorer.tradeabilityScore(0.10)).toBeCloseTo(0.5, 5);
      expect(MarketScorer.tradeabilityScore(0.15)).toBe(1.0);
    });

    it('linearly ramps from 1 to 0 between 0.40 and 0.45', () => {
      expect(MarketScorer.tradeabilityScore(0.40)).toBe(1.0);
      expect(MarketScorer.tradeabilityScore(0.425)).toBeCloseTo(0.5, 5);
      expect(MarketScorer.tradeabilityScore(0.45)).toBe(0);
    });

    it('linearly ramps from 0 to 1 between 0.55 and 0.60', () => {
      expect(MarketScorer.tradeabilityScore(0.55)).toBe(0);
      expect(MarketScorer.tradeabilityScore(0.575)).toBeCloseTo(0.5, 5);
      expect(MarketScorer.tradeabilityScore(0.60)).toBe(1.0);
    });

    it('linearly ramps from 1 to 0 between 0.85 and 0.95', () => {
      expect(MarketScorer.tradeabilityScore(0.85)).toBe(1.0);
      expect(MarketScorer.tradeabilityScore(0.90)).toBeCloseTo(0.5, 5);
      expect(MarketScorer.tradeabilityScore(0.95)).toBe(0);
    });

    it('is symmetric around 0.50', () => {
      expect(MarketScorer.tradeabilityScore(0.30)).toBe(
        MarketScorer.tradeabilityScore(0.70),
      );
      expect(MarketScorer.tradeabilityScore(0.10)).toBeCloseTo(
        MarketScorer.tradeabilityScore(0.90),
        5,
      );
      expect(MarketScorer.tradeabilityScore(0.42)).toBeCloseTo(
        MarketScorer.tradeabilityScore(0.58),
        5,
      );
    });
  });

  // ─── liquidityScore ──────────────────────────────────────────────────
  describe('liquidityScore', () => {
    it('returns 0 for null volume', () => {
      expect(MarketScorer.liquidityScore(null, 0.02)).toBe(0);
    });

    it('returns 0 for zero volume', () => {
      expect(MarketScorer.liquidityScore(0, 0.02)).toBe(0);
    });

    it('returns 0 for null spread with null volume', () => {
      expect(MarketScorer.liquidityScore(null, null)).toBe(0);
    });

    it('increases with higher volume (log scale)', () => {
      const low = MarketScorer.liquidityScore(1000, 0.01);
      const mid = MarketScorer.liquidityScore(100_000, 0.01);
      const high = MarketScorer.liquidityScore(10_000_000, 0.01);
      expect(low).toBeGreaterThan(0);
      expect(mid).toBeGreaterThan(low);
      expect(high).toBeGreaterThan(mid);
    });

    it('caps at 1.0 for very high volume', () => {
      const score = MarketScorer.liquidityScore(100_000_000, 0.01);
      expect(score).toBeLessThanOrEqual(1.0);
    });

    it('applies 50% penalty when spread > 0.03', () => {
      const narrow = MarketScorer.liquidityScore(1_000_000, 0.02);
      const wide = MarketScorer.liquidityScore(1_000_000, 0.04);
      expect(wide).toBeCloseTo(narrow * 0.5, 5);
    });

    it('no penalty when spread is exactly 0.03', () => {
      const at = MarketScorer.liquidityScore(1_000_000, 0.03);
      const below = MarketScorer.liquidityScore(1_000_000, 0.02);
      expect(at).toBe(below);
    });

    it('treats null spread as no penalty', () => {
      const noSpread = MarketScorer.liquidityScore(1_000_000, null);
      const narrowSpread = MarketScorer.liquidityScore(1_000_000, 0.02);
      expect(noSpread).toBe(narrowSpread);
    });
  });

  // ─── ttrScore ────────────────────────────────────────────────────────
  describe('ttrScore', () => {
    it('returns 0.5 for null endDate', () => {
      expect(MarketScorer.ttrScore(null)).toBe(0.5);
    });

    it('returns 0 for past dates', () => {
      const yesterday = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      expect(MarketScorer.ttrScore(yesterday)).toBe(0);
    });

    it('returns 0.1 for < 24h from now', () => {
      const in12h = new Date(Date.now() + 12 * 60 * 60 * 1000);
      expect(MarketScorer.ttrScore(in12h)).toBe(0.1);
    });

    it('ramps from 0.1 to 1.0 for 1-7 days', () => {
      const in1d = new Date(Date.now() + 1 * 24 * 60 * 60 * 1000);
      const in4d = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000);
      const in7d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const score1d = MarketScorer.ttrScore(in1d);
      const score4d = MarketScorer.ttrScore(in4d);
      const score7d = MarketScorer.ttrScore(in7d);

      expect(score1d).toBeCloseTo(0.1, 1);
      expect(score4d).toBeGreaterThan(score1d);
      expect(score4d).toBeLessThan(score7d);
      expect(score7d).toBeCloseTo(1.0, 1);
    });

    it('returns 1.0 for 7-60 day window', () => {
      const in14d = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
      const in30d = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const in60d = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
      expect(MarketScorer.ttrScore(in14d)).toBe(1.0);
      expect(MarketScorer.ttrScore(in30d)).toBe(1.0);
      expect(MarketScorer.ttrScore(in60d)).toBe(1.0);
    });

    it('decays from 1.0 to 0.5 for 60-180 days', () => {
      const in90d = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
      const in120d = new Date(Date.now() + 120 * 24 * 60 * 60 * 1000);
      const in180d = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000);

      const score90 = MarketScorer.ttrScore(in90d);
      const score120 = MarketScorer.ttrScore(in120d);
      const score180 = MarketScorer.ttrScore(in180d);

      expect(score90).toBeLessThan(1.0);
      expect(score90).toBeGreaterThan(0.5);
      expect(score120).toBeLessThan(score90);
      expect(score120).toBeGreaterThan(0.5);
      expect(score180).toBeCloseTo(0.5, 1);
    });

    it('returns 0.5 for > 180 days', () => {
      const in365d = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
      expect(MarketScorer.ttrScore(in365d)).toBe(0.5);
    });
  });

  // ─── volatilityScore ────────────────────────────────────────────────
  describe('volatilityScore', () => {
    it('returns 0 for null', () => {
      expect(MarketScorer.volatilityScore(null)).toBe(0);
    });

    it('returns 0 for zero stddev', () => {
      expect(MarketScorer.volatilityScore(0)).toBe(0);
    });

    it('peaks near stddev=0.07', () => {
      const peak = MarketScorer.volatilityScore(0.07);
      const below = MarketScorer.volatilityScore(0.03);
      const above = MarketScorer.volatilityScore(0.12);
      expect(peak).toBeCloseTo(1.0, 1);
      expect(peak).toBeGreaterThan(below);
      expect(peak).toBeGreaterThan(above);
    });

    it('caps at 1.0', () => {
      expect(MarketScorer.volatilityScore(0.07)).toBeLessThanOrEqual(1.0);
    });

    it('returns low scores for very high stddev', () => {
      const score = MarketScorer.volatilityScore(0.30);
      expect(score).toBeLessThan(0.1);
    });

    it('returns low scores for very low stddev', () => {
      const score = MarketScorer.volatilityScore(0.005);
      // Gaussian with peak=0.07, width=0.06: exp(-((0.005-0.07)^2)/(2*0.06^2)) ≈ 0.556
      expect(score).toBeLessThan(0.6);
      // Much lower than the peak
      expect(score).toBeLessThan(MarketScorer.volatilityScore(0.07));
    });
  });

  // ─── dataQualityScore ───────────────────────────────────────────────
  describe('dataQualityScore', () => {
    it('returns 0 for totalBars=0', () => {
      expect(MarketScorer.dataQualityScore(0, 0)).toBe(0);
    });

    it('returns ratio of informative/total', () => {
      expect(MarketScorer.dataQualityScore(50, 100)).toBe(0.5);
      expect(MarketScorer.dataQualityScore(25, 100)).toBe(0.25);
    });

    it('caps at 1.0', () => {
      expect(MarketScorer.dataQualityScore(200, 100)).toBe(1.0);
    });

    it('returns 1.0 when all bars are informative', () => {
      expect(MarketScorer.dataQualityScore(100, 100)).toBe(1.0);
    });
  });

  // ─── compositeScore ─────────────────────────────────────────────────
  describe('compositeScore', () => {
    it('returns 1.0 when all dimensions are 1.0', () => {
      const dims: ScoreDimensions = {
        tradeability: 1.0,
        liquidity: 1.0,
        volatility: 1.0,
        ttr: 1.0,
        dataQuality: 1.0,
      };
      expect(MarketScorer.compositeScore(dims)).toBeCloseTo(1.0, 5);
    });

    it('returns 0 when all dimensions are 0', () => {
      const dims: ScoreDimensions = {
        tradeability: 0,
        liquidity: 0,
        volatility: 0,
        ttr: 0,
        dataQuality: 0,
      };
      expect(MarketScorer.compositeScore(dims)).toBe(0);
    });

    it('applies correct weights', () => {
      // Only tradeability=1.0, rest=0
      const trade: ScoreDimensions = {
        tradeability: 1.0,
        liquidity: 0,
        volatility: 0,
        ttr: 0,
        dataQuality: 0,
      };
      expect(MarketScorer.compositeScore(trade)).toBeCloseTo(0.30, 5);

      // Only liquidity=1.0
      const liq: ScoreDimensions = {
        tradeability: 0,
        liquidity: 1.0,
        volatility: 0,
        ttr: 0,
        dataQuality: 0,
      };
      expect(MarketScorer.compositeScore(liq)).toBeCloseTo(0.25, 5);

      // Only volatility=1.0
      const vol: ScoreDimensions = {
        tradeability: 0,
        liquidity: 0,
        volatility: 1.0,
        ttr: 0,
        dataQuality: 0,
      };
      expect(MarketScorer.compositeScore(vol)).toBeCloseTo(0.20, 5);

      // Only ttr=1.0
      const ttr: ScoreDimensions = {
        tradeability: 0,
        liquidity: 0,
        volatility: 0,
        ttr: 1.0,
        dataQuality: 0,
      };
      expect(MarketScorer.compositeScore(ttr)).toBeCloseTo(0.15, 5);

      // Only dataQuality=1.0
      const dq: ScoreDimensions = {
        tradeability: 0,
        liquidity: 0,
        volatility: 0,
        ttr: 0,
        dataQuality: 1.0,
      };
      expect(MarketScorer.compositeScore(dq)).toBeCloseTo(0.10, 5);
    });

    it('normalizes by available weights when volatility is null', () => {
      const dims: ScoreDimensions = {
        tradeability: 1.0,
        liquidity: 1.0,
        volatility: null,
        ttr: 1.0,
        dataQuality: 1.0,
      };
      // Available weights: 0.30 + 0.25 + 0.15 + 0.10 = 0.80
      // Score = (0.30 + 0.25 + 0.15 + 0.10) / 0.80 = 1.0
      expect(MarketScorer.compositeScore(dims)).toBeCloseTo(1.0, 5);
    });

    it('normalizes by available weights when dataQuality is null', () => {
      const dims: ScoreDimensions = {
        tradeability: 1.0,
        liquidity: 1.0,
        volatility: 1.0,
        ttr: 1.0,
        dataQuality: null,
      };
      // Available weights: 0.30 + 0.25 + 0.20 + 0.15 = 0.90
      // Score = 0.90 / 0.90 = 1.0
      expect(MarketScorer.compositeScore(dims)).toBeCloseTo(1.0, 5);
    });

    it('normalizes when both volatility and dataQuality are null', () => {
      const dims: ScoreDimensions = {
        tradeability: 1.0,
        liquidity: 1.0,
        volatility: null,
        ttr: 1.0,
        dataQuality: null,
      };
      // Available weights: 0.30 + 0.25 + 0.15 = 0.70
      // Score = 0.70 / 0.70 = 1.0
      expect(MarketScorer.compositeScore(dims)).toBeCloseTo(1.0, 5);
    });

    it('returns correct partial score with null dimensions', () => {
      const dims: ScoreDimensions = {
        tradeability: 0.5,
        liquidity: 0.8,
        volatility: null,
        ttr: 0.6,
        dataQuality: null,
      };
      // Available weights: 0.30 + 0.25 + 0.15 = 0.70
      // Weighted sum = 0.5*0.30 + 0.8*0.25 + 0.6*0.15 = 0.15 + 0.20 + 0.09 = 0.44
      // Normalized = 0.44 / 0.70 = 0.6285...
      expect(MarketScorer.compositeScore(dims)).toBeCloseTo(0.44 / 0.70, 4);
    });

    it('handles mixed scores correctly', () => {
      const dims: ScoreDimensions = {
        tradeability: 0.8,
        liquidity: 0.6,
        volatility: 0.5,
        ttr: 0.9,
        dataQuality: 0.7,
      };
      const expected =
        0.8 * 0.3 + 0.6 * 0.25 + 0.5 * 0.2 + 0.9 * 0.15 + 0.7 * 0.1;
      expect(MarketScorer.compositeScore(dims)).toBeCloseTo(expected, 5);
    });
  });
});
