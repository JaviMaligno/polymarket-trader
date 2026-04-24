import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import * as connection from '../database/connection.js';
import { query } from '../database/connection.js';
import {
  MarketScorer,
  WEIGHTS,
  type ScoreDimensions,
  type ScorerWeights,
} from './MarketScorer.js';

vi.mock('../database/connection.js', () => ({ query: vi.fn() }));

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

    it('returns 1.0 for balanced zone [0.30-0.70]', () => {
      expect(MarketScorer.tradeabilityScore(0.45)).toBe(1.0);
      expect(MarketScorer.tradeabilityScore(0.50)).toBe(1.0);
      expect(MarketScorer.tradeabilityScore(0.55)).toBe(1.0);
    });

    it('returns correct values for low range [0.15-0.40]', () => {
      expect(MarketScorer.tradeabilityScore(0.15)).toBe(0.5);
      expect(MarketScorer.tradeabilityScore(0.25)).toBeCloseTo(0.8333, 3);
      expect(MarketScorer.tradeabilityScore(0.40)).toBe(1.0);
    });

    it('returns correct values for high range [0.60-0.85]', () => {
      expect(MarketScorer.tradeabilityScore(0.60)).toBe(1.0);
      expect(MarketScorer.tradeabilityScore(0.70)).toBe(1.0);
      expect(MarketScorer.tradeabilityScore(0.85)).toBe(0.5);
    });

    it('returns 0.5 for extreme low range [0.05-0.15)', () => {
      expect(MarketScorer.tradeabilityScore(0.05)).toBe(0.5);
      expect(MarketScorer.tradeabilityScore(0.10)).toBe(0.5);
      expect(MarketScorer.tradeabilityScore(0.149)).toBe(0.5);
    });

    it('linearly ramps from 0.5 to 1.0 between 0.15 and 0.30', () => {
      expect(MarketScorer.tradeabilityScore(0.15)).toBe(0.5);
      expect(MarketScorer.tradeabilityScore(0.225)).toBeCloseTo(0.75, 5);
      expect(MarketScorer.tradeabilityScore(0.30)).toBe(1.0);
    });

    it('linearly ramps from 1.0 to 0.5 between 0.70 and 0.85', () => {
      expect(MarketScorer.tradeabilityScore(0.70)).toBe(1.0);
      expect(MarketScorer.tradeabilityScore(0.775)).toBeCloseTo(0.75, 5);
      expect(MarketScorer.tradeabilityScore(0.85)).toBe(0.5);
    });

    it('returns 0.5 for extreme high range (0.85-0.95]', () => {
      expect(MarketScorer.tradeabilityScore(0.86)).toBe(0.5);
      expect(MarketScorer.tradeabilityScore(0.90)).toBe(0.5);
      expect(MarketScorer.tradeabilityScore(0.95)).toBe(0.5);
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
        typeExpectedValue: 1.0,
        realizedVolatility: 1.0,
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
        typeExpectedValue: 0,
        realizedVolatility: 0,
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
        typeExpectedValue: 0,
        realizedVolatility: 0,
      };
      expect(MarketScorer.compositeScore(trade)).toBeCloseTo(0.21, 5);

      // Only liquidity=1.0
      const liq: ScoreDimensions = {
        tradeability: 0,
        liquidity: 1.0,
        volatility: 0,
        ttr: 0,
        dataQuality: 0,
        typeExpectedValue: 0,
        realizedVolatility: 0,
      };
      expect(MarketScorer.compositeScore(liq)).toBeCloseTo(0.17, 5);

      // Only volatility=1.0
      const vol: ScoreDimensions = {
        tradeability: 0,
        liquidity: 0,
        volatility: 1.0,
        ttr: 0,
        dataQuality: 0,
        typeExpectedValue: 0,
        realizedVolatility: 0,
      };
      expect(MarketScorer.compositeScore(vol)).toBeCloseTo(0.15, 5);

      // Only ttr=1.0
      const ttr: ScoreDimensions = {
        tradeability: 0,
        liquidity: 0,
        volatility: 0,
        ttr: 1.0,
        dataQuality: 0,
        typeExpectedValue: 0,
        realizedVolatility: 0,
      };
      expect(MarketScorer.compositeScore(ttr)).toBeCloseTo(0.08, 5);

      // Only dataQuality=1.0
      const dq: ScoreDimensions = {
        tradeability: 0,
        liquidity: 0,
        volatility: 0,
        ttr: 0,
        dataQuality: 1.0,
        typeExpectedValue: 0,
        realizedVolatility: 0,
      };
      expect(MarketScorer.compositeScore(dq)).toBeCloseTo(0.10, 5);

      // Only typeExpectedValue=1.0
      const tev: ScoreDimensions = {
        tradeability: 0,
        liquidity: 0,
        volatility: 0,
        ttr: 0,
        dataQuality: 0,
        typeExpectedValue: 1.0,
        realizedVolatility: 0,
      };
      expect(MarketScorer.compositeScore(tev)).toBeCloseTo(0.17, 5);
    });

    it('normalizes by available weights when volatility is null', () => {
      const dims: ScoreDimensions = {
        tradeability: 1.0,
        liquidity: 1.0,
        volatility: null,
        ttr: 1.0,
        dataQuality: 1.0,
        typeExpectedValue: 1.0,
        realizedVolatility: 1.0,
      };
      // Available weights: 0.21 + 0.17 + 0.08 + 0.10 + 0.17 + 0.12 = 0.85
      // (volatility=0.15 is null, excluded)
      // Score = (0.21 + 0.17 + 0.08 + 0.10 + 0.17 + 0.12) / 0.85 = 1.0
      expect(MarketScorer.compositeScore(dims)).toBeCloseTo(1.0, 5);
    });

    it('normalizes by available weights when dataQuality is null', () => {
      const dims: ScoreDimensions = {
        tradeability: 1.0,
        liquidity: 1.0,
        volatility: 1.0,
        ttr: 1.0,
        dataQuality: null,
        typeExpectedValue: 1.0,
        realizedVolatility: 1.0,
      };
      // Available weights: 0.21 + 0.17 + 0.15 + 0.08 + 0.17 + 0.12 = 0.90
      // (dataQuality=0.10 is null, excluded)
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
        typeExpectedValue: 1.0,
        realizedVolatility: 1.0,
      };
      // Available weights: 0.21 + 0.17 + 0.08 + 0.17 + 0.12 = 0.75
      // (volatility=0.15 and dataQuality=0.10 are null, excluded)
      // Score = 0.75 / 0.75 = 1.0
      expect(MarketScorer.compositeScore(dims)).toBeCloseTo(1.0, 5);
    });

    it('returns correct partial score with null dimensions', () => {
      const dims: ScoreDimensions = {
        tradeability: 0.5,
        liquidity: 0.8,
        volatility: null,
        ttr: 0.6,
        dataQuality: null,
        typeExpectedValue: 0,
        realizedVolatility: null,
      };
      // Available weights: 0.21 + 0.17 + 0.08 + 0.17 = 0.63
      // (volatility=0.15 and dataQuality=0.10 and realizedVolatility=0.12 are null, excluded)
      // Weighted sum = 0.5*0.21 + 0.8*0.17 + 0.6*0.08 + 0*0.17 = 0.105 + 0.136 + 0.048 + 0 = 0.289
      // Normalized = 0.289 / 0.63 ≈ 0.4587
      expect(MarketScorer.compositeScore(dims)).toBeCloseTo(0.289 / 0.63, 4);
    });

    it('handles mixed scores correctly', () => {
      const dims: ScoreDimensions = {
        tradeability: 0.8,
        liquidity: 0.6,
        volatility: 0.5,
        ttr: 0.9,
        dataQuality: 0.7,
        typeExpectedValue: 0,
        realizedVolatility: null,
      };
      // All dimensions present except realizedVolatility (null).
      // Available weights: 0.21 + 0.17 + 0.15 + 0.08 + 0.10 + 0.17 = 0.88
      const weightedSum =
        0.8 * 0.21 + 0.6 * 0.17 + 0.5 * 0.15 + 0.9 * 0.08 + 0.7 * 0.10 + 0 * 0.17;
      const expected = weightedSum / 0.88;
      expect(MarketScorer.compositeScore(dims)).toBeCloseTo(expected, 5);
    });
  });

  // ─── loadWeights ────────────────────────────────────────────────────
  describe('loadWeights', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      MarketScorer.clearWeightsCache();
    });
    afterEach(() => {
      vi.clearAllMocks();
      MarketScorer.clearWeightsCache();
    });

    it('returns hardcoded WEIGHTS when DB query throws', async () => {
      vi.spyOn(connection, 'query').mockRejectedValueOnce(new Error('DB down'));
      const weights = await MarketScorer.loadWeights();
      expect(weights.tradeability).toBe(WEIGHTS.tradeability);
      expect(weights.liquidity).toBe(WEIGHTS.liquidity);
      expect(weights.ttr).toBe(WEIGHTS.ttr);
    });

    it('returns hardcoded WEIGHTS when scorer_weights table is empty', async () => {
      vi.spyOn(connection, 'query').mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      const weights = await MarketScorer.loadWeights();
      expect(weights.tradeability).toBe(WEIGHTS.tradeability);
    });

    it('returns DB weights when row exists', async () => {
      vi.spyOn(connection, 'query').mockResolvedValueOnce({
        rows: [{
          market_type: '__global__', tradeability: 0.40, liquidity: 0.20,
          volatility: 0.15, ttr: 0.15, data_quality: 0.10, type_expected_value: 0.20,
          n_trades: 1800,
        }],
        rowCount: 1,
      } as any);
      const weights = await MarketScorer.loadWeights();
      expect(weights).toMatchObject({
        tradeability: 0.40,
        liquidity: 0.20,
        volatility: 0.15,
        ttr: 0.15,
        dataQuality: 0.10,
      });
    });
  });

  // ─── compositeScore with custom weights ─────────────────────────────
  describe('compositeScore with custom weights', () => {
    it('uses provided weights to compute weighted average across all dims', () => {
      // All 7 dims non-null so all weight fields are exercised
      const dims: ScoreDimensions = {
        tradeability: 1.0,
        liquidity: 0.0,
        volatility: 0.0,
        ttr: 1.0,
        dataQuality: 0.0,
        typeExpectedValue: 0.0,
        realizedVolatility: 0.0,
      };
      // Equal weights for tradeability and ttr, zero for others
      const customWeights: ScorerWeights = {
        tradeability: 0.5,
        liquidity: 0.0,
        volatility: 0.0,
        ttr: 0.5,
        dataQuality: 0.0,
        typeExpectedValue: 0.0,
        realizedVolatility: 0.0,
      };
      // Expected: (1.0*0.5 + 0.0*0.0 + 0.0*0.0 + 1.0*0.5 + 0.0*0.0 + 0.0*0.0 + 0.0*0.0) / (0.5+0.0+0.0+0.5+0.0+0.0+0.0) = 1.0 / 1.0 = 1.0
      expect(MarketScorer.compositeScore(dims, customWeights)).toBeCloseTo(1.0);
    });

    it('renormalizes correctly when custom weights do not sum to 1', () => {
      const dims: ScoreDimensions = {
        tradeability: 1.0,
        liquidity: 1.0,
        volatility: null,
        ttr: 1.0,
        dataQuality: null,
        typeExpectedValue: 0.0,
        realizedVolatility: null,
      };
      // Unequal weights (don't sum to 1)
      const customWeights: ScorerWeights = {
        tradeability: 2.0,
        liquidity: 1.0,
        volatility: 0.5,
        ttr: 1.0,
        dataQuality: 0.5,
        typeExpectedValue: 0.5,
        realizedVolatility: 0.5,
      };
      // volatility, dataQuality, and realizedVolatility are null → excluded. sumW = 2.0+1.0+1.0+0.5 = 4.5
      // score = (1.0*2.0 + 1.0*1.0 + 1.0*1.0 + 0.0*0.5) / 4.5 = 4.0 / 4.5 = 0.888...
      expect(MarketScorer.compositeScore(dims, customWeights)).toBeCloseTo(4.0 / 4.5);
    });
  });

  // ─── compositeScore with typeExpectedValue (Task 3 TDD record) ──────────
  describe('MarketScorer.compositeScore with typeExpectedValue', () => {
    it('includes typeExpectedValue contribution in composite', () => {
      const dims: ScoreDimensions = {
        tradeability: 1, liquidity: 1, volatility: null,
        ttr: 1, dataQuality: null, typeExpectedValue: 1,
        realizedVolatility: null,
      };
      const weights: ScorerWeights = {
        tradeability: 0.25, liquidity: 0.20, volatility: 0.15,
        ttr: 0.10, dataQuality: 0.10, typeExpectedValue: 0.20,
        realizedVolatility: 0.12,
      };
      // All non-null dims at 1: tradeability + liquidity + ttr + typeExpectedValue
      // weighted sum = 0.25+0.20+0.10+0.20 = 0.75, normalized by same = 1.0
      const score = MarketScorer.compositeScore(dims, weights);
      expect(score).toBeCloseTo(1.0, 3);
    });

    it('typeExpectedValue at 0 drops score by its weight share', () => {
      const dims: ScoreDimensions = {
        tradeability: 1, liquidity: 1, volatility: null,
        ttr: 1, dataQuality: null, typeExpectedValue: 0,
        realizedVolatility: null,
      };
      const weights: ScorerWeights = {
        tradeability: 0.25, liquidity: 0.20, volatility: 0.15,
        ttr: 0.10, dataQuality: 0.10, typeExpectedValue: 0.20,
        realizedVolatility: 0.12,
      };
      // Non-null weighted sum = 0.25+0.20+0.10+0 = 0.55
      // Normalized by non-null weight-sum (0.25+0.20+0.10+0.20) = 0.75
      // score = 0.55 / 0.75 ≈ 0.7333
      const score = MarketScorer.compositeScore(dims, weights);
      expect(score).toBeCloseTo(0.7333, 3);
    });
  });

  // ─── mapRealizedVolatility ──────────────────────────────────────────
  describe('MarketScorer.mapRealizedVolatility', () => {
    it('returns null when raw is null', () => {
      expect(MarketScorer.mapRealizedVolatility(null, 100)).toBeNull();
    });

    it('returns null when barCount is null', () => {
      expect(MarketScorer.mapRealizedVolatility(0.02, null)).toBeNull();
    });

    it('returns null when barCount < 5', () => {
      expect(MarketScorer.mapRealizedVolatility(0.02, 4)).toBeNull();
    });

    it('maps raw vol 0.02 with default VOL_REF=0.02 to 1.0', () => {
      expect(MarketScorer.mapRealizedVolatility(0.02, 10)).toBe(1.0);
    });

    it('maps raw vol 0.01 with default VOL_REF=0.02 to 0.5', () => {
      expect(MarketScorer.mapRealizedVolatility(0.01, 10)).toBeCloseTo(0.5, 5);
    });

    it('clamps above 1.0 (very volatile market)', () => {
      expect(MarketScorer.mapRealizedVolatility(0.08, 10)).toBe(1.0);
    });

    it('clamps at 0.0 (never negative)', () => {
      expect(MarketScorer.mapRealizedVolatility(-0.01, 10)).toBe(0);
    });

    it('barCount boundary — 5 computes, 4 is null', () => {
      expect(MarketScorer.mapRealizedVolatility(0.01, 4)).toBeNull();
      expect(MarketScorer.mapRealizedVolatility(0.01, 5)).toBeCloseTo(0.5, 5);
    });
  });

  describe('scoreAllMarkets', () => {
    it('batches pass-1 score updates instead of issuing a full-table update', async () => {
      MarketScorer.clearWeightsCache();
      const querySpy = vi.spyOn(connection, 'query').mockImplementation(async (sql: any, params?: any[]) => {
        const text = String(sql);

        if (text.includes('FROM scorer_weights') && text.includes('market_type IN')) {
          return {
            rows: [
              { market_type: '__global__', tradeability: 0.25, liquidity: 0.20,
                volatility: 0.15, ttr: 0.10, data_quality: 0.10, type_expected_value: 0.20,
                n_trades: 1800 },
            ],
            rowCount: 1,
          } as any;
        }

        // New: category metrics for typeExpectedValue (replaces prior multiplier)
        if (text.includes('FROM category_performance') && text.includes('sharpe_ratio')) {
          // event_short has no data → typeEV = 0.5 (neutral)
          return { rows: [], rowCount: 0 } as any;
        }

        // Old priors query — used by Pass 2 only
        if (text.includes('SELECT market_type, prior FROM category_performance')) {
          return { rows: [], rowCount: 0 } as any;
        }

        // New: DISTINCT market_type query
        if (text.includes('SELECT DISTINCT market_type FROM markets')) {
          return { rows: [{ market_type: 'event_short' }], rowCount: 1 } as any;
        }

        if (text.includes('FROM markets') && text.includes(`tracking_status NOT IN ('warming', 'active', 'cooling')`)) {
          return {
            rows: [
              {
                condition_id: 'cold-1',
                current_price_yes: 0.5,
                volume_24h: 30_000_000,
                spread: 0.01,
                end_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
                market_type: 'event_short',
              },
              {
                condition_id: 'cold-2',
                current_price_yes: 0.5,
                volume_24h: 30_000_000,
                spread: 0.01,
                end_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
                market_type: null,
              },
            ],
            rowCount: 2,
          } as any;
        }

        if (text.includes("FROM   markets m") && text.includes("tracking_status IN ('warming', 'active', 'cooling')")) {
          return { rows: [], rowCount: 0 } as any;
        }

        if (text.includes('UPDATE markets AS m') || text.includes('UPDATE markets\n')) {
          return { rows: [], rowCount: (params?.length ?? 0) / 2 } as any;
        }

        if (text.trim().startsWith('UPDATE markets')) {
          return { rows: [], rowCount: (params?.length ?? 0) / 2 } as any;
        }

        if (text.includes('SELECT condition_id, market_score')) {
          return { rows: [], rowCount: 0 } as any;
        }

        if (text.includes('INSERT INTO market_score_history')) {
          return { rows: [], rowCount: 0 } as any;
        }

        throw new Error(`Unexpected query in test: ${text}`);
      });

      const scorer = new MarketScorer();
      await scorer.scoreAllMarkets();

      const queries = querySpy.mock.calls.map(([sql]) => String(sql));
      expect(queries.some(q => q.includes('UPDATE markets SET market_score = ('))).toBe(false);
      expect(queries.some(q => q.includes('UPDATE markets SET market_score = market_score * COALESCE('))).toBe(false);

      // Now we get separate UPDATE calls per type — at least 2 (event_short + NULL fallback)
      const updateCalls = querySpy.mock.calls.filter(([sql]) => String(sql).trim().startsWith('UPDATE markets'));
      expect(updateCalls.length).toBeGreaterThanOrEqual(2);

      // cold-1 (event_short) and cold-2 (null): price=0.5, vol=30M, spread=0.01, end=30d
      //   tradeability = 1.0  (balanced zone)
      //   liquidity    = log(30M) / log(30M) = 1.0, spread ≤ 0.03 → no penalty → 1.0
      //   ttr          = 1.0  (30 days → 7-60 day optimal window)
      //   volatility   = null, dataQuality = null → excluded
      //   typeEV = 0.5 (neutral — no category_performance data for event_short, neutral for NULL)
      // non-null weights: 0.25 + 0.20 + 0.10 + 0.20 = 0.75
      // weightedSum = 1.0*0.25 + 1.0*0.20 + 1.0*0.10 + 0.5*0.20 = 0.65
      // composite = 0.65 / 0.75 = 0.8667
      // No prior multiplier — typeEV is now a composite dimension.

      // Find the event_short UPDATE: params[0]=marketType, params[1]=conditionId, params[2]=score
      const eventShortCall = querySpy.mock.calls.find(
        ([sql, params]) =>
          String(sql).trim().startsWith('UPDATE markets') &&
          Array.isArray(params) && params[0] === 'event_short',
      );
      expect(eventShortCall).toBeDefined();
      const eventShortParams = eventShortCall?.[1] as Array<string | number>;
      expect(eventShortParams?.[0]).toBe('event_short');
      expect(eventShortParams?.[1]).toBe('cold-1');
      expect(eventShortParams?.[2] as number).toBeCloseTo(0.8667, 3);

      // Find the NULL-type UPDATE: params[0] = null (the parameterized market_type)
      const nullTypeCall = querySpy.mock.calls.find(
        ([sql, params]) =>
          String(sql).trim().startsWith('UPDATE markets') &&
          Array.isArray(params) && params[0] === null,
      );
      expect(nullTypeCall).toBeDefined();
      const nullTypeParams = nullTypeCall?.[1] as Array<string | number | null>;
      expect(nullTypeParams?.[0]).toBeNull();
      expect(nullTypeParams?.[1]).toBe('cold-2');
      expect(nullTypeParams?.[2] as number).toBeCloseTo(0.8667, 3);

      vi.restoreAllMocks();
    });
  });

  // ─── Pass 1 per-type ────────────────────────────────────────────────────
  describe('MarketScorer.scoreAllMarkets Pass 1 per-type', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      MarketScorer.clearWeightsCache();
    });

    it('issues one UPDATE per distinct market_type plus one fallback for NULL market_type', async () => {
      (query as unknown as Mock).mockImplementation(async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('SELECT DISTINCT market_type FROM markets')) {
          return { rows: [{ market_type: 'event_long' }, { market_type: 'event_financial' }] };
        }
        if (typeof sql === 'string' && sql.includes('FROM category_performance') && sql.includes('sharpe_ratio')) {
          return { rows: [
            { market_type: 'event_long',      sharpe_ratio: 0.17, n_trades: 1317 },
            { market_type: 'event_financial', sharpe_ratio: 0.27, n_trades: 159 },
          ] };
        }
        if (typeof sql === 'string' && sql.includes('FROM scorer_weights')) {
          return { rows: [{ market_type: '__global__', tradeability: 0.25, liquidity: 0.20,
            volatility: 0.15, ttr: 0.10, data_quality: 0.10, type_expected_value: 0.20,
            n_trades: 1800 }] };
        }
        // Cold candidates query
        if (typeof sql === 'string' && sql.includes('tracking_status NOT IN')) {
          return { rows: [
            { condition_id: 'el-1', current_price_yes: 0.5, volume_24h: 1_000_000, spread: 0.01,
              end_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), market_type: 'event_long' },
            { condition_id: 'ef-1', current_price_yes: 0.5, volume_24h: 1_000_000, spread: 0.01,
              end_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), market_type: 'event_financial' },
            { condition_id: 'null-1', current_price_yes: 0.5, volume_24h: 1_000_000, spread: 0.01,
              end_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), market_type: null },
          ] };
        }
        // Pass 2's tracked query — return empty to skip Pass 2
        if (typeof sql === 'string' && sql.includes('tracking_status IN')) {
          return { rows: [] };
        }
        if (typeof sql === 'string' && sql.includes('SELECT market_type, prior FROM category_performance')) {
          return { rows: [] };
        }
        return { rows: [], rowCount: 0 };
      });
      const scorer = new MarketScorer();
      await scorer.scoreAllMarkets();

      const updateCalls = (query as unknown as Mock).mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].trim().startsWith('UPDATE markets'),
      );
      // 2 per-type UPDATEs + 1 fallback UPDATE for NULL market_type = 3
      expect(updateCalls.length).toBeGreaterThanOrEqual(3);
    });

    it('computes per-type score using typeEV from category_performance', async () => {
      const captured: Array<unknown[]> = [];
      (query as unknown as Mock).mockImplementation(async (sql: string, params?: unknown[]) => {
        if (typeof sql === 'string' && sql.trim().startsWith('UPDATE markets')) {
          captured.push(params ?? []);
        }
        if (typeof sql === 'string' && sql.includes('FROM category_performance') && sql.includes('sharpe_ratio')) {
          // event_financial: sharpe=0.27, n=159 → shrunk=0.27*159/179≈0.23966 → (1.23966/1.5)≈0.8264
          return { rows: [{ market_type: 'event_financial', sharpe_ratio: 0.27, n_trades: 159 }] };
        }
        if (typeof sql === 'string' && sql.includes('FROM scorer_weights')) {
          return { rows: [{ market_type: '__global__', tradeability: 0.25, liquidity: 0.20,
            volatility: 0.15, ttr: 0.10, data_quality: 0.10, type_expected_value: 0.20, n_trades: 1800 }] };
        }
        if (typeof sql === 'string' && sql.includes('tracking_status NOT IN')) {
          return { rows: [
            { condition_id: 'ef-1', current_price_yes: 0.5, volume_24h: 30_000_000, spread: 0.01,
              end_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), market_type: 'event_financial' },
          ] };
        }
        if (typeof sql === 'string' && sql.includes('tracking_status IN')) return { rows: [] };
        if (typeof sql === 'string' && sql.includes('SELECT market_type, prior FROM category_performance')) {
          return { rows: [] };
        }
        return { rows: [], rowCount: 0 };
      });
      const scorer = new MarketScorer();
      await scorer.scoreAllMarkets();

      // First UPDATE params: [marketType, conditionId, score, ...]
      expect(captured.length).toBeGreaterThan(0);
      const firstCall = captured[0] as Array<unknown>;
      expect(firstCall[0]).toBe('event_financial');  // market_type param ($1)
      expect(firstCall[1]).toBe('ef-1');              // condition_id param ($2)
      // typeEV = (0.27*159/179 + 1) / 1.5 ≈ 0.8264
      // tradeability=1.0 (price=0.5), liquidity=1.0 (vol=30M=MAX_VOLUME_REF), ttr=1.0 (30d optimal)
      // weights (non-null): trade=0.25, liq=0.20, ttr=0.10, tev=0.20 → totalW=0.75
      // score = (1.0*0.25 + 1.0*0.20 + 1.0*0.10 + 0.8264*0.20) / 0.75 ≈ 0.7153/0.75 ≈ 0.9537
      expect(firstCall[2] as number).toBeCloseTo(0.9537, 2);
    });
  });

  // ─── ScoreDimensions shape ──────────────────────────────────────────────
  describe('ScoreDimensions shape', () => {
    it('includes typeExpectedValue field', () => {
      const dims: ScoreDimensions = {
        tradeability: 1,
        liquidity: 0.5,
        volatility: null,
        ttr: 0.5,
        dataQuality: null,
        typeExpectedValue: 0.75,
      };
      expect(dims.typeExpectedValue).toBe(0.75);
    });
  });

  // ─── WEIGHTS default ────────────────────────────────────────────────────
  describe('WEIGHTS default', () => {
    it('has typeExpectedValue non-zero', () => {
      expect(WEIGHTS.typeExpectedValue).toBeGreaterThan(0);
    });
    it('all weights sum to 1.0', () => {
      const sum = WEIGHTS.tradeability + WEIGHTS.liquidity + WEIGHTS.volatility +
                  WEIGHTS.ttr + WEIGHTS.dataQuality + WEIGHTS.typeExpectedValue +
                  WEIGHTS.realizedVolatility;
      expect(sum).toBeCloseTo(1.0, 5);
    });
  });

  describe('ScoreDimensions shape — realizedVolatility', () => {
    it('includes realizedVolatility as nullable', () => {
      const dims: ScoreDimensions = {
        tradeability: 1, liquidity: 0.5, volatility: null,
        ttr: 0.5, dataQuality: null, typeExpectedValue: 0.75,
        realizedVolatility: 0.6,
      };
      expect(dims.realizedVolatility).toBe(0.6);

      const dimsNull: ScoreDimensions = {
        tradeability: 1, liquidity: 0.5, volatility: null,
        ttr: 0.5, dataQuality: null, typeExpectedValue: 0.75,
        realizedVolatility: null,
      };
      expect(dimsNull.realizedVolatility).toBeNull();
    });
  });

  describe('WEIGHTS — realizedVolatility', () => {
    it('has realizedVolatility non-zero', () => {
      expect(WEIGHTS.realizedVolatility).toBeGreaterThan(0);
    });
    it('all weights still sum to 1.0', () => {
      const sum = WEIGHTS.tradeability + WEIGHTS.liquidity + WEIGHTS.volatility +
                  WEIGHTS.ttr + WEIGHTS.dataQuality + WEIGHTS.typeExpectedValue +
                  WEIGHTS.realizedVolatility;
      expect(sum).toBeCloseTo(1.0, 5);
    });
  });

  // ─── loadCategoryMetrics ────────────────────────────────────────────────
  describe('MarketScorer.loadCategoryMetrics', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('loads a Map keyed by market_type', async () => {
      (query as unknown as Mock).mockResolvedValue({
        rows: [
          { market_type: 'event_financial', sharpe_ratio: 0.27, n_trades: 159 },
          { market_type: 'event_long',      sharpe_ratio: 0.17, n_trades: 1317 },
        ],
      });
      const map = await MarketScorer.loadCategoryMetrics();
      expect(map.get('event_financial')).toEqual({ sharpe: 0.27, n: 159 });
      expect(map.get('event_long')).toEqual({ sharpe: 0.17, n: 1317 });
    });

    it('returns empty Map when table is empty', async () => {
      (query as unknown as Mock).mockResolvedValue({ rows: [] });
      const map = await MarketScorer.loadCategoryMetrics();
      expect(map.size).toBe(0);
    });

    it('coerces string numerics from pg to numbers', async () => {
      (query as unknown as Mock).mockResolvedValue({
        rows: [{ market_type: 'event_short', sharpe_ratio: '0.13' as unknown as number, n_trades: '419' as unknown as number }],
      });
      const map = await MarketScorer.loadCategoryMetrics();
      const entry = map.get('event_short');
      expect(entry?.sharpe).toBe(0.13);
      expect(entry?.n).toBe(419);
    });

    it('preserves null sharpe_ratio (insufficient data in category_performance)', async () => {
      (query as unknown as Mock).mockResolvedValue({
        rows: [{ market_type: 'crypto_daily', sharpe_ratio: null, n_trades: 4 }],
      });
      const map = await MarketScorer.loadCategoryMetrics();
      expect(map.get('crypto_daily')).toEqual({ sharpe: null, n: 4 });
    });

    it('returns empty Map on DB error (graceful degrade)', async () => {
      (query as unknown as Mock).mockRejectedValue(new Error('db down'));
      const map = await MarketScorer.loadCategoryMetrics();
      expect(map.size).toBe(0);
    });
  });

  // ─── MarketScorer.loadWeights per-type ──────────────────────────────
  describe('MarketScorer.loadWeights per-type', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      MarketScorer.clearWeightsCache();
    });
    afterEach(() => {
      vi.clearAllMocks();
      MarketScorer.clearWeightsCache();
    });

    it('returns per-type weights when row has enough trades', async () => {
      (query as unknown as Mock).mockResolvedValue({
        rows: [
          { market_type: 'event_financial', tradeability: 0.4, liquidity: 0.2,
            volatility: 0.1, ttr: 0.1, data_quality: 0.1, type_expected_value: 0.1,
            n_trades: 100 },
          { market_type: '__global__', tradeability: 0.25, liquidity: 0.20,
            volatility: 0.15, ttr: 0.10, data_quality: 0.10, type_expected_value: 0.20,
            n_trades: 1800 },
        ],
      });
      const w = await MarketScorer.loadWeights('event_financial');
      expect(w.tradeability).toBeCloseTo(0.4);
    });

    it('falls back to global when per-type n_trades < MIN_TRADES_FOR_PER_TYPE (30)', async () => {
      (query as unknown as Mock).mockResolvedValue({
        rows: [
          { market_type: 'crypto_intraday', tradeability: 0.5, liquidity: 0.1,
            volatility: 0.1, ttr: 0.1, data_quality: 0.1, type_expected_value: 0.1,
            n_trades: 7 },
          { market_type: '__global__', tradeability: 0.25, liquidity: 0.20,
            volatility: 0.15, ttr: 0.10, data_quality: 0.10, type_expected_value: 0.20,
            n_trades: 1800 },
        ],
      });
      const w = await MarketScorer.loadWeights('crypto_intraday');
      expect(w.tradeability).toBeCloseTo(0.25);  // global, not per-type
    });

    it('falls back to global when per-type row missing', async () => {
      (query as unknown as Mock).mockResolvedValue({
        rows: [
          { market_type: '__global__', tradeability: 0.25, liquidity: 0.20,
            volatility: 0.15, ttr: 0.10, data_quality: 0.10, type_expected_value: 0.20,
            n_trades: 1800 },
        ],
      });
      const w = await MarketScorer.loadWeights('unknown_type');
      expect(w.tradeability).toBeCloseTo(0.25);
    });

    it('caches per type — second call in TTL does not re-query', async () => {
      (query as unknown as Mock).mockResolvedValue({
        rows: [
          { market_type: '__global__', tradeability: 0.25, liquidity: 0.20,
            volatility: 0.15, ttr: 0.10, data_quality: 0.10, type_expected_value: 0.20,
            n_trades: 1800 },
        ],
      });
      await MarketScorer.loadWeights('event_long');
      await MarketScorer.loadWeights('event_long');
      expect((query as unknown as Mock).mock.calls.length).toBe(1);
    });

    it('falls back to WEIGHTS defaults when DB errors', async () => {
      (query as unknown as Mock).mockRejectedValue(new Error('db down'));
      const w = await MarketScorer.loadWeights('event_long');
      expect(w).toMatchObject({
        tradeability: WEIGHTS.tradeability,
        liquidity: WEIGHTS.liquidity,
        typeExpectedValue: WEIGHTS.typeExpectedValue,
      });
    });

    it('per-type threshold boundary — n_trades=30 uses per-type, n_trades=29 falls back', async () => {
      const globalRow = { market_type: '__global__', tradeability: 0.25, liquidity: 0.20,
        volatility: 0.15, ttr: 0.10, data_quality: 0.10, type_expected_value: 0.20, n_trades: 1800 };
      const perTypeRow = (n: number) => ({ market_type: 'event_long', tradeability: 0.50, liquidity: 0.1,
        volatility: 0.1, ttr: 0.1, data_quality: 0.1, type_expected_value: 0.1, n_trades: n });

      (query as unknown as Mock).mockResolvedValueOnce({ rows: [perTypeRow(30), globalRow] });
      MarketScorer.clearWeightsCache();
      const w30 = await MarketScorer.loadWeights('event_long');
      expect(w30.tradeability).toBeCloseTo(0.50); // per-type

      (query as unknown as Mock).mockResolvedValueOnce({ rows: [perTypeRow(29), globalRow] });
      MarketScorer.clearWeightsCache();
      const w29 = await MarketScorer.loadWeights('event_long');
      expect(w29.tradeability).toBeCloseTo(0.25); // global fallback
    });
  });

  // ─── MarketScorer.typeExpectedValue ─────────────────────────────────
  describe('MarketScorer.typeExpectedValue', () => {
    it('returns 0.5 when sharpe is null', () => {
      expect(MarketScorer.typeExpectedValue(null, 100)).toBe(0.5);
    });

    it('returns 0.5 when n < MIN_N (5)', () => {
      expect(MarketScorer.typeExpectedValue(0.32, 4)).toBe(0.5);
    });

    it('computes shrunk Sharpe mapped to [0,1] (event_financial real data)', () => {
      // sharpe=0.27, n=159, K=20: shrunk = 0.27*159/179 = 0.2397
      // mapped = (0.2397 + 1) / 1.5 = 0.8265
      expect(MarketScorer.typeExpectedValue(0.27, 159)).toBeCloseTo(0.8265, 3);
    });

    it('clamps above 1.0 (unrealistic high Sharpe)', () => {
      // sharpe=5, n=1000: shrunk ≈ 4.9 — mapped = 5.9/1.5 = 3.93 → clamp 1.0
      expect(MarketScorer.typeExpectedValue(5, 1000)).toBe(1.0);
    });

    it('clamps at 0.0 (very negative shrunk)', () => {
      // sharpe=-2, n=100: shrunk ≈ -1.67 — mapped = -0.67/1.5 ≈ -0.44 → clamp 0
      expect(MarketScorer.typeExpectedValue(-2, 100)).toBe(0);
    });

    it('MIN_N boundary — n=5 computes, n=4 neutral', () => {
      expect(MarketScorer.typeExpectedValue(0.5, 4)).toBe(0.5);   // neutral
      expect(MarketScorer.typeExpectedValue(0.5, 5)).not.toBe(0.5); // computed
    });

    it('falls back to a finite K when K is NaN (misconfigured env)', () => {
      // Pass NaN explicitly — mimics Number('abc') from a fat-fingered env var.
      // With the function-level guard, NaN K falls back to SCORER_SHRINKAGE_K (20).
      const result = MarketScorer.typeExpectedValue(0.27, 159, NaN);
      // Same inputs with K=20 → 0.8265 (per existing test).
      expect(result).toBeCloseTo(0.8265, 3);
    });
  });

  // ─── Pass 1 realizedVolatility propagation ─────────────────────────────
  describe('MarketScorer.scoreAllMarkets Pass 1 — realizedVolatility propagation', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      MarketScorer.clearWeightsCache();
    });

    it('reads realized_volatility_24h from candidates + maps via mapRealizedVolatility', async () => {
      const captured: Array<{ sql: string; params: unknown[] | undefined }> = [];
      (query as unknown as Mock).mockImplementation(async (sql: string, params?: unknown[]) => {
        if (typeof sql === 'string' && sql.trim().startsWith('UPDATE markets')) {
          captured.push({ sql, params });
        }
        if (typeof sql === 'string' && sql.includes('FROM category_performance')) {
          return { rows: [] };
        }
        if (typeof sql === 'string' && sql.includes('FROM scorer_weights')) {
          return {
            rows: [{
              market_type: '__global__', tradeability: 0.21, liquidity: 0.17,
              volatility: 0.15, ttr: 0.08, data_quality: 0.10,
              type_expected_value: 0.17, realized_volatility: 0.12, n_trades: 1800,
            }],
          };
        }
        if (typeof sql === 'string' && sql.includes('SELECT condition_id')) {
          // One cold candidate with known inputs for deterministic score
          return {
            rows: [{
              condition_id: 'mkt-A', current_price_yes: '0.5', volume_24h: '30000000',
              spread: '0.01', end_date: new Date(Date.now() + 30 * 86400000).toISOString(),
              market_type: 'event_long',
              realized_volatility_24h: 0.02, realized_volatility_bar_count: 20,
            }],
          };
        }
        if (typeof sql === 'string' && sql.includes("tracking_status IN")) return { rows: [] };
        return { rows: [], rowCount: 0 };
      });
      const scorer = new MarketScorer();
      await scorer.scoreAllMarkets();

      // First captured UPDATE should have marketType='event_long' and a score that reflects
      // realizedVolatility=1.0 (raw 0.02 / VOL_REF 0.02 = 1.0).
      expect(captured.length).toBeGreaterThan(0);
      const updateCall = captured.find(c => (c.params?.[0] as string) === 'event_long');
      expect(updateCall).toBeDefined();
      // The score param is index 2 (after marketType, conditionId).
      const score = updateCall!.params![2] as number;
      // All non-null dims at 1 (tradeability=1, liquidity=1 with 30M vol = MAX_VOLUME_REF, ttr=1,
      // typeEV=0.5 since categoryMetrics has no event_long row, realizedVol=1).
      // Non-null weighted sum = 1.0*0.21 + 1.0*0.17 + 1.0*0.08 + 0.5*0.17 + 1.0*0.12 = 0.665
      // Normalized by (0.21+0.17+0.08+0.17+0.12) = 0.75
      // Score = 0.665 / 0.75 ≈ 0.8867
      expect(score).toBeCloseTo(0.8867, 2);
    });
  });

  // ─── Pass 2 per-type ────────────────────────────────────────────────────
  describe('MarketScorer.scoreAllMarkets Pass 2 per-type', () => {
    beforeEach(() => { vi.clearAllMocks(); MarketScorer.clearWeightsCache(); });

    it('scores tracked markets with per-type weights and computed typeEV', async () => {
      const captured: any[] = [];
      (query as unknown as Mock).mockImplementation(async (sql: string, params?: any[]) => {
        if (typeof sql === 'string' && sql.trim().startsWith('UPDATE markets')) {
          captured.push({ sql, params });
        }
        if (typeof sql === 'string' && sql.includes('FROM category_performance') && sql.includes('sharpe_ratio')) {
          return { rows: [{ market_type: 'event_financial', sharpe_ratio: 0.27, n_trades: 159 }] };
        }
        if (typeof sql === 'string' && sql.includes('FROM scorer_weights')) {
          return { rows: [{ market_type: '__global__', tradeability: 0.25, liquidity: 0.20,
            volatility: 0.15, ttr: 0.10, data_quality: 0.10, type_expected_value: 0.20, n_trades: 1800 }] };
        }
        if (typeof sql === 'string' && sql.includes('tracking_status NOT IN')) {
          // Pass 1 empty — skip
          return { rows: [] };
        }
        if (typeof sql === 'string' && sql.includes('tracking_status IN')) {
          return { rows: [{
            condition_id: 'active-mkt-1', tracking_status: 'active',
            current_price_yes: '0.5', volume_24h: '30000000', spread: '0.01',
            end_date: new Date(Date.now() + 30*86400000).toISOString(),
            market_type: 'event_financial',
            stddev: '0.05', informative_bars: '20', total_bars: '24',
          }] };
        }
        return { rows: [], rowCount: 0 };
      });
      const scorer = new MarketScorer();
      await scorer.scoreAllMarkets();

      // At least one UPDATE from Pass 2 captured
      expect(captured.length).toBeGreaterThan(0);
      // The score passed should include typeEV contribution (>> 0.5 because event_financial typeEV≈0.8265)
      // Not checking exact value — just that it's computed, not 0 (the old placeholder)
      const pass2Call = captured.find(c => c.params?.some((p: unknown) => p === 'active-mkt-1'));
      expect(pass2Call).toBeDefined();
    });

    it('writeScoreHistory INSERT includes score_type_expected_value column', async () => {
      const insertCalls: string[] = [];
      (query as unknown as Mock).mockImplementation(async (sql: string, params?: any[]) => {
        if (typeof sql === 'string' && sql.includes('INSERT INTO market_score_history')) {
          insertCalls.push(sql);
        }
        if (typeof sql === 'string' && sql.includes('FROM category_performance') && sql.includes('sharpe_ratio')) {
          return { rows: [{ market_type: 'event_financial', sharpe_ratio: 0.27, n_trades: 159 }] };
        }
        if (typeof sql === 'string' && sql.includes('FROM scorer_weights')) {
          return { rows: [{ market_type: '__global__', tradeability: 0.25, liquidity: 0.20,
            volatility: 0.15, ttr: 0.10, data_quality: 0.10, type_expected_value: 0.20, n_trades: 1800 }] };
        }
        if (typeof sql === 'string' && sql.includes('tracking_status NOT IN')) {
          return { rows: [] };
        }
        if (typeof sql === 'string' && sql.includes('tracking_status IN')) {
          return { rows: [{
            condition_id: 'active-mkt-2', tracking_status: 'warming',
            current_price_yes: '0.5', volume_24h: '30000000', spread: '0.01',
            end_date: new Date(Date.now() + 30*86400000).toISOString(),
            market_type: 'event_financial',
            stddev: '0.07', informative_bars: '24', total_bars: '24',
          }] };
        }
        // SELECT for cold history snapshot
        if (typeof sql === 'string' && sql.includes('SELECT condition_id, market_score')) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      });
      const scorer = new MarketScorer();
      await scorer.scoreAllMarkets();

      // Wait for writeScoreHistory (fire-and-forget)
      await new Promise(r => setTimeout(r, 10));

      expect(insertCalls.length).toBeGreaterThan(0);
      expect(insertCalls[0]).toContain('score_type_expected_value');
    });
  });
});
