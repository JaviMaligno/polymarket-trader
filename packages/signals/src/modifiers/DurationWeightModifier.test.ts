import { describe, it, expect, beforeEach } from 'vitest';
import { DurationWeightModifier } from './DurationWeightModifier.js';

describe('DurationWeightModifier', () => {
  let modifier: DurationWeightModifier;

  beforeEach(() => {
    modifier = new DurationWeightModifier();
  });

  describe('getDurationBand', () => {
    it('returns immediate for 3 days to resolution', () => {
      const endDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
      expect(modifier.getDurationBand(endDate)).toBe('immediate');
    });

    it('returns short for 14 days to resolution', () => {
      const endDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
      expect(modifier.getDurationBand(endDate)).toBe('short');
    });

    it('returns medium for 60 days to resolution', () => {
      const endDate = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
      expect(modifier.getDurationBand(endDate)).toBe('medium');
    });

    it('returns long for 180 days to resolution', () => {
      const endDate = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000);
      expect(modifier.getDurationBand(endDate)).toBe('long');
    });

    it('returns short for null endDate', () => {
      expect(modifier.getDurationBand(null)).toBe('short');
    });

    it('returns short for undefined endDate', () => {
      expect(modifier.getDurationBand(undefined)).toBe('short');
    });

    it('returns immediate for past endDate', () => {
      const endDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      expect(modifier.getDurationBand(endDate)).toBe('immediate');
    });
  });

  describe('getWeightMultiplier', () => {
    it('returns 1.0 for momentum in immediate band', () => {
      expect(modifier.getWeightMultiplier('momentum', 'immediate')).toBe(1.0);
    });

    it('returns 0 for momentum in medium band', () => {
      expect(modifier.getWeightMultiplier('momentum', 'medium')).toBe(0);
    });

    it('returns 1.0 for hawkes in all bands', () => {
      expect(modifier.getWeightMultiplier('hawkes', 'immediate')).toBe(1.0);
      expect(modifier.getWeightMultiplier('hawkes', 'short')).toBe(1.0);
      expect(modifier.getWeightMultiplier('hawkes', 'medium')).toBe(1.0);
      expect(modifier.getWeightMultiplier('hawkes', 'long')).toBe(1.0);
    });

    it('returns 0.5 for unknown signal', () => {
      expect(modifier.getWeightMultiplier('unknown_signal', 'immediate')).toBe(0.5);
      expect(modifier.getWeightMultiplier('unknown_signal', 'long')).toBe(0.5);
    });
  });

  describe('modifyWeights', () => {
    it('applies multipliers correctly for medium band (momentum weight becomes 0)', () => {
      const endDate = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000); // 60 days → medium
      const weights = {
        momentum: 0.4,
        hawkes: 0.3,
        ofi: 0.3,
      };
      const modified = modifier.modifyWeights(weights, endDate);

      // momentum multiplier in medium = 0, so weight becomes 0
      expect(modified['momentum']).toBe(0);
      // hawkes multiplier in medium = 1.0
      expect(modified['hawkes']).toBe(0.3);
      // ofi multiplier in medium = 1.0
      expect(modified['ofi']).toBe(0.3);
    });
  });

  describe('updateMatrix and getMatrix', () => {
    it('allows updating the matrix', () => {
      modifier.updateMatrix({ momentum: { immediate: 0.5, short: 0.5, medium: 0.5, long: 0.5 } });
      expect(modifier.getWeightMultiplier('momentum', 'immediate')).toBe(0.5);
      expect(modifier.getWeightMultiplier('momentum', 'long')).toBe(0.5);
    });

    it('getMatrix returns the full matrix', () => {
      const matrix = modifier.getMatrix();
      expect(matrix).toHaveProperty('momentum');
      expect(matrix).toHaveProperty('hawkes');
      expect(matrix['hawkes']).toEqual({ immediate: 1.0, short: 1.0, medium: 1.0, long: 1.0 });
    });
  });

  describe('custom matrix constructor', () => {
    it('accepts custom matrix overrides', () => {
      const custom = new DurationWeightModifier({
        momentum: { immediate: 0.1, short: 0.1, medium: 0.1, long: 0.1 },
      });
      expect(custom.getWeightMultiplier('momentum', 'immediate')).toBe(0.1);
      // Other signals remain at defaults
      expect(custom.getWeightMultiplier('hawkes', 'long')).toBe(1.0);
    });
  });
});
