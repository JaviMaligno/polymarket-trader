/**
 * Tests for RiskProfiles
 */

import { describe, it, expect } from 'vitest';
import {
  getRiskProfile,
  getDefaultRiskProfile,
  mergeRiskConfig,
  validateRiskConfig,
  calculateAdaptiveMultiplier,
  calculateVolatilityAdjustedSL,
  calculateVolatilityAdjustedTP,
  convertUSDLimitToPercent,
  convertPercentLimitToUSD,
  AGGRESSIVE_PROFILE,
  MODERATE_PROFILE,
  CONSERVATIVE_PROFILE,
} from './RiskProfiles.js';

describe('RiskProfiles', () => {
  describe('Profile Definitions', () => {
    it('should have all three risk profiles defined', () => {
      expect(AGGRESSIVE_PROFILE).toBeDefined();
      expect(MODERATE_PROFILE).toBeDefined();
      expect(CONSERVATIVE_PROFILE).toBeDefined();
    });

    it('AGGRESSIVE profile should have correct type and aggressive parameters', () => {
      expect(AGGRESSIVE_PROFILE.profileType).toBe('AGGRESSIVE');
      expect(AGGRESSIVE_PROFILE.maxPositionSizePct).toBeGreaterThan(MODERATE_PROFILE.maxPositionSizePct);
      expect(AGGRESSIVE_PROFILE.maxExposurePct).toBeGreaterThanOrEqual(MODERATE_PROFILE.maxExposurePct);
      expect(AGGRESSIVE_PROFILE.haltDrawdownPct).toBeGreaterThan(MODERATE_PROFILE.haltDrawdownPct);
    });

    it('MODERATE profile should be between conservative and aggressive', () => {
      expect(MODERATE_PROFILE.profileType).toBe('MODERATE');
      expect(MODERATE_PROFILE.maxPositionSizePct).toBeGreaterThan(CONSERVATIVE_PROFILE.maxPositionSizePct);
      expect(MODERATE_PROFILE.maxPositionSizePct).toBeLessThan(AGGRESSIVE_PROFILE.maxPositionSizePct);
    });

    it('CONSERVATIVE profile should have most restrictive parameters', () => {
      expect(CONSERVATIVE_PROFILE.profileType).toBe('CONSERVATIVE');
      expect(CONSERVATIVE_PROFILE.maxPositionSizePct).toBeLessThan(MODERATE_PROFILE.maxPositionSizePct);
      expect(CONSERVATIVE_PROFILE.haltDrawdownPct).toBeLessThan(MODERATE_PROFILE.haltDrawdownPct);
    });
  });

  describe('getRiskProfile', () => {
    it('should return AGGRESSIVE profile', () => {
      const profile = getRiskProfile('AGGRESSIVE');
      expect(profile.profileType).toBe('AGGRESSIVE');
      expect(profile).toEqual(AGGRESSIVE_PROFILE);
    });

    it('should return MODERATE profile', () => {
      const profile = getRiskProfile('MODERATE');
      expect(profile.profileType).toBe('MODERATE');
      expect(profile).toEqual(MODERATE_PROFILE);
    });

    it('should return CONSERVATIVE profile', () => {
      const profile = getRiskProfile('CONSERVATIVE');
      expect(profile.profileType).toBe('CONSERVATIVE');
      expect(profile).toEqual(CONSERVATIVE_PROFILE);
    });

    it('should return a deep copy, not reference', () => {
      const profile1 = getRiskProfile('AGGRESSIVE');
      const profile2 = getRiskProfile('AGGRESSIVE');
      expect(profile1).toEqual(profile2);
      expect(profile1).not.toBe(profile2); // Different objects
    });
  });

  describe('getDefaultRiskProfile', () => {
    it('should return AGGRESSIVE profile by default', () => {
      const profile = getDefaultRiskProfile();
      expect(profile.profileType).toBe('AGGRESSIVE');
    });
  });

  describe('mergeRiskConfig', () => {
    it('should merge custom config with base profile', () => {
      const merged = mergeRiskConfig('MODERATE', {
        maxPositionSizePct: 20,
        enabled: false,
      });

      expect(merged.profileType).toBe('MODERATE');
      expect(merged.maxPositionSizePct).toBe(20); // Overridden
      expect(merged.enabled).toBe(false); // Overridden
      expect(merged.maxExposurePct).toBe(MODERATE_PROFILE.maxExposurePct); // Not overridden
    });

    it('should merge with RiskConfig object instead of string', () => {
      const merged = mergeRiskConfig(CONSERVATIVE_PROFILE, {
        maxDrawdownPct: 25,
      });

      expect(merged.profileType).toBe('CONSERVATIVE');
      expect(merged.maxDrawdownPct).toBe(25);
    });
  });

  describe('validateRiskConfig', () => {
    it('should validate AGGRESSIVE profile as valid', () => {
      const result = validateRiskConfig(AGGRESSIVE_PROFILE);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should validate all default profiles', () => {
      [AGGRESSIVE_PROFILE, MODERATE_PROFILE, CONSERVATIVE_PROFILE].forEach(profile => {
        const result = validateRiskConfig(profile);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });
    });

    it('should detect invalid maxPositionSizePct', () => {
      const config = { ...MODERATE_PROFILE, maxPositionSizePct: -5 };
      const result = validateRiskConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('maxPositionSizePct must be between 0 and 100');
    });

    it('should detect invalid drawdown hierarchy', () => {
      const config = {
        ...MODERATE_PROFILE,
        warningDrawdownPct: 30,
        maxDrawdownPct: 20,
        haltDrawdownPct: 40,
      };
      const result = validateRiskConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('warningDrawdownPct'))).toBe(true);
    });

    it('should detect invalid TP/SL ratio', () => {
      const config = {
        ...MODERATE_PROFILE,
        stopLossPct: 30,
        takeProfitPct: 10,
      };
      const result = validateRiskConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('takeProfitPct'))).toBe(true);
    });

    it('should detect invalid Kelly fraction', () => {
      const config = { ...MODERATE_PROFILE, kellyFraction: 1.5 };
      const result = validateRiskConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('kellyFraction must be between 0 and 1');
    });
  });

  describe('calculateAdaptiveMultiplier', () => {
    const config = AGGRESSIVE_PROFILE;

    it('should return 1.0 when drawdown is below recovery threshold', () => {
      const multiplier = calculateAdaptiveMultiplier(5, config);
      expect(multiplier).toBe(1.0);
    });

    it('should return reduction factor when drawdown >= reduction threshold', () => {
      const multiplier = calculateAdaptiveMultiplier(25, config);
      expect(multiplier).toBeLessThan(1.0);
      expect(multiplier).toBe(config.adaptiveReductionFactor);
    });

    it('should interpolate between thresholds in GRADUAL mode', () => {
      const midDrawdown = (config.adaptiveRecoveryThresholdPct + config.adaptiveReductionThresholdPct) / 2;
      const multiplier = calculateAdaptiveMultiplier(midDrawdown, config);

      expect(multiplier).toBeGreaterThan(config.adaptiveReductionFactor);
      expect(multiplier).toBeLessThan(1.0);
    });

    it('should return 0 in NONE mode when drawdown >= max', () => {
      const noneConfig = { ...config, adaptiveMode: 'NONE' as const };
      const multiplier = calculateAdaptiveMultiplier(30, noneConfig);
      expect(multiplier).toBe(0);
    });

    it('should use exponential decay in DYNAMIC mode', () => {
      const dynamicConfig = { ...config, adaptiveMode: 'DYNAMIC' as const };
      const mult1 = calculateAdaptiveMultiplier(5, dynamicConfig);   // Lower drawdown
      const mult2 = calculateAdaptiveMultiplier(15, dynamicConfig);  // Higher drawdown

      expect(mult1).toBeGreaterThan(mult2);
      expect(mult2).toBeGreaterThanOrEqual(config.adaptiveReductionFactor);
      expect(mult1).toBeLessThanOrEqual(1.0); // Never exceed 1.0
    });
  });

  describe('calculateVolatilityAdjustedSL', () => {
    const config = AGGRESSIVE_PROFILE;
    const baseStopLoss = 15;
    const avgVolatility = 10;

    it('should return base SL when feature disabled', () => {
      const disabledConfig = { ...config, useVolatilityAdjusted: false };
      const adjusted = calculateVolatilityAdjustedSL(baseStopLoss, 20, avgVolatility, disabledConfig);
      expect(adjusted).toBe(baseStopLoss);
    });

    it('should increase SL when volatility is high', () => {
      const highVol = 20;
      const adjusted = calculateVolatilityAdjustedSL(baseStopLoss, highVol, avgVolatility, config);
      expect(adjusted).toBeGreaterThan(baseStopLoss);
    });

    it('should decrease SL when volatility is low', () => {
      const lowVol = 5;
      const adjusted = calculateVolatilityAdjustedSL(baseStopLoss, lowVol, avgVolatility, config);
      expect(adjusted).toBeLessThan(baseStopLoss);
    });

    it('should cap adjusted SL at 3x base', () => {
      const extremeVol = 1000;
      const adjusted = calculateVolatilityAdjustedSL(baseStopLoss, extremeVol, avgVolatility, config);
      expect(adjusted).toBeLessThanOrEqual(baseStopLoss * 3);
    });

    it('should not go below 0.5x base', () => {
      const tinyVol = 0.1;
      const adjusted = calculateVolatilityAdjustedSL(baseStopLoss, tinyVol, avgVolatility, config);
      expect(adjusted).toBeGreaterThanOrEqual(baseStopLoss * 0.5);
    });
  });

  describe('calculateVolatilityAdjustedTP', () => {
    const config = AGGRESSIVE_PROFILE;
    const baseTakeProfit = 40;
    const avgVolatility = 10;

    it('should return base TP when feature disabled', () => {
      const disabledConfig = { ...config, useVolatilityAdjusted: false };
      const adjusted = calculateVolatilityAdjustedTP(baseTakeProfit, 20, avgVolatility, disabledConfig);
      expect(adjusted).toBe(baseTakeProfit);
    });

    it('should increase TP when volatility is high', () => {
      const highVol = 20;
      const adjusted = calculateVolatilityAdjustedTP(baseTakeProfit, highVol, avgVolatility, config);
      expect(adjusted).toBeGreaterThan(baseTakeProfit);
    });

    it('should decrease TP when volatility is low', () => {
      const lowVol = 5;
      const adjusted = calculateVolatilityAdjustedTP(baseTakeProfit, lowVol, avgVolatility, config);
      expect(adjusted).toBeLessThan(baseTakeProfit);
    });
  });

  describe('Currency Conversion Utilities', () => {
    it('should convert USD limit to percentage correctly', () => {
      const percent = convertUSDLimitToPercent(500, 10000);
      expect(percent).toBe(5);
    });

    it('should convert percentage limit to USD correctly', () => {
      const usd = convertPercentLimitToUSD(5, 10000);
      expect(usd).toBe(500);
    });

    it('should handle zero portfolio value', () => {
      const percent = convertUSDLimitToPercent(500, 0);
      expect(percent).toBe(0);
    });

    it('should round-trip correctly', () => {
      const portfolioValue = 50000;
      const originalUSD = 2500;

      const percent = convertUSDLimitToPercent(originalUSD, portfolioValue);
      const backToUSD = convertPercentLimitToUSD(percent, portfolioValue);

      expect(backToUSD).toBe(originalUSD);
    });
  });

  describe('Profile Scalability', () => {
    it('should scale well for small portfolio ($10k)', () => {
      const portfolio = 10000;
      const dailyLossPct = AGGRESSIVE_PROFILE.maxDailyLossPct;
      const maxDailyLossUSD = convertPercentLimitToUSD(dailyLossPct, portfolio);

      expect(maxDailyLossUSD).toBeGreaterThan(0);
      expect(maxDailyLossUSD).toBeLessThan(portfolio); // Shouldn't exceed portfolio
    });

    it('should scale well for large portfolio ($1M)', () => {
      const portfolio = 1000000;
      const dailyLossPct = AGGRESSIVE_PROFILE.maxDailyLossPct;
      const maxDailyLossUSD = convertPercentLimitToUSD(dailyLossPct, portfolio);

      expect(maxDailyLossUSD / portfolio).toBeCloseTo(dailyLossPct / 100, 2);
    });
  });

  describe('Consistency Across Profiles', () => {
    it('all profiles should have same structure', () => {
      const profiles = [AGGRESSIVE_PROFILE, MODERATE_PROFILE, CONSERVATIVE_PROFILE];
      const firstKeys = Object.keys(profiles[0]).sort();

      profiles.forEach(profile => {
        const keys = Object.keys(profile).sort();
        expect(keys).toEqual(firstKeys);
      });
    });

    it('all profiles should be enabled by default', () => {
      expect(AGGRESSIVE_PROFILE.enabled).toBe(true);
      expect(MODERATE_PROFILE.enabled).toBe(true);
      expect(CONSERVATIVE_PROFILE.enabled).toBe(true);
    });

    it('all profiles should have valid adaptive mode', () => {
      const validModes = ['NONE', 'GRADUAL', 'DYNAMIC'];
      expect(validModes).toContain(AGGRESSIVE_PROFILE.adaptiveMode);
      expect(validModes).toContain(MODERATE_PROFILE.adaptiveMode);
      expect(validModes).toContain(CONSERVATIVE_PROFILE.adaptiveMode);
    });
  });
});
