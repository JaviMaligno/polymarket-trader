import { describe, it, expect } from 'vitest';
import { PriceRangeWeightModifier } from './PriceRangeWeightModifier.js';

describe('PriceRangeWeightModifier', () => {
  const mod = new PriceRangeWeightModifier();

  describe('getPriceBand', () => {
    it('returns normal for price < 0.40', () => {
      expect(mod.getPriceBand(0.30)).toBe('normal');
    });
    it('returns normal for price > 0.60', () => {
      expect(mod.getPriceBand(0.75)).toBe('normal');
    });
    it('returns transitional for price in 0.40–0.45', () => {
      expect(mod.getPriceBand(0.42)).toBe('transitional');
    });
    it('returns transitional for price in 0.55–0.60', () => {
      expect(mod.getPriceBand(0.58)).toBe('transitional');
    });
    it('returns uncertain for price in 0.45–0.55', () => {
      expect(mod.getPriceBand(0.50)).toBe('uncertain');
    });
    it('returns uncertain at exact boundary 0.45', () => {
      expect(mod.getPriceBand(0.45)).toBe('uncertain');
    });
    it('returns uncertain at exact boundary 0.55', () => {
      expect(mod.getPriceBand(0.55)).toBe('uncertain');
    });
  });

  describe('getWeightMultiplier', () => {
    it('momentum is 0 in uncertain band', () => {
      expect(mod.getWeightMultiplier('momentum', 'uncertain')).toBe(0);
    });
    it('momentum is 0.6 in transitional band', () => {
      expect(mod.getWeightMultiplier('momentum', 'transitional')).toBe(0.6);
    });
    it('momentum is 1.0 in normal band', () => {
      expect(mod.getWeightMultiplier('momentum', 'normal')).toBe(1.0);
    });
    it('ofi is 1.0 in all bands', () => {
      expect(mod.getWeightMultiplier('ofi', 'uncertain')).toBe(1.0);
      expect(mod.getWeightMultiplier('ofi', 'transitional')).toBe(1.0);
      expect(mod.getWeightMultiplier('ofi', 'normal')).toBe(1.0);
    });
    it('returns 0.5 for unknown signals', () => {
      expect(mod.getWeightMultiplier('unknown_signal', 'normal')).toBe(0.5);
    });
  });

  describe('modifyWeights', () => {
    it('zeroes momentum/mean_reversion at uncertain price', () => {
      const weights = { momentum: 0.15, ofi: 0.15 };
      const result = mod.modifyWeights(weights, 0.50);
      expect(result.momentum).toBe(0);
      expect(result.ofi).toBe(0.15);
    });
    it('does not mutate the original weights object', () => {
      const weights = { momentum: 0.15 };
      mod.modifyWeights(weights, 0.50);
      expect(weights.momentum).toBe(0.15);
    });
    it('applies 1.0 multiplier for normal price', () => {
      const weights = { momentum: 0.15, ofi: 0.15 };
      const result = mod.modifyWeights(weights, 0.30);
      expect(result.momentum).toBeCloseTo(0.15);
      expect(result.ofi).toBeCloseTo(0.15);
    });
  });

  describe('custom matrix and updateMatrix', () => {
    it('accepts a custom matrix in constructor', () => {
      const custom = new PriceRangeWeightModifier({
        momentum: { normal: 1.0, transitional: 0.0, uncertain: 0.0 },
      });
      expect(custom.getWeightMultiplier('momentum', 'transitional')).toBe(0.0);
    });
    it('updateMatrix overrides at runtime', () => {
      const m = new PriceRangeWeightModifier();
      m.updateMatrix({ hawkes: { normal: 0.5, transitional: 0.5, uncertain: 0.5 } });
      expect(m.getWeightMultiplier('hawkes', 'normal')).toBe(0.5);
    });
  });
});
