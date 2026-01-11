/**
 * Centralized Risk Profile Configuration
 *
 * Provides unified risk management profiles across all systems
 * (backtesting, paper trading, production) with consistent,
 * scalable parameters oriented towards aggressive trading.
 */

// ============================================
// Types
// ============================================

export type RiskProfileType = 'CONSERVATIVE' | 'MODERATE' | 'AGGRESSIVE';
export type AdaptiveMode = 'NONE' | 'GRADUAL' | 'DYNAMIC';

/**
 * Unified Risk Configuration
 * All percentage values are 0-100 (not 0-1) for clarity
 * All monetary values are PERCENTAGES of portfolio, not fixed USD
 */
export interface RiskConfig {
  // === Profile Info ===
  profileType: RiskProfileType;
  enabled: boolean;

  // === Position Limits ===
  /** Maximum single position size as % of portfolio (e.g., 15 = 15%) */
  maxPositionSizePct: number;
  /** Maximum total exposure as % of portfolio (e.g., 85 = 85%) */
  maxExposurePct: number;
  /** Maximum concurrent positions */
  maxPositions: number;

  // === Drawdown Limits ===
  /** Warning drawdown threshold (%) - triggers alert */
  warningDrawdownPct: number;
  /** Maximum drawdown before halt (%) */
  maxDrawdownPct: number;
  /** Hard halt drawdown (%) - immediate trading stop */
  haltDrawdownPct: number;

  // === Daily Loss Limits ===
  /** Daily loss warning threshold as % of portfolio */
  warningDailyLossPct: number;
  /** Maximum daily loss as % of portfolio before halt */
  maxDailyLossPct: number;

  // === Stop Loss / Take Profit ===
  /** Stop loss per position (%) - base value */
  stopLossPct: number;
  /** Take profit per position (%) - base value */
  takeProfitPct: number;
  /** Enable trailing stops */
  useTrailingStops: boolean;
  /** Trailing stop distance (%) */
  trailingStopPct: number;
  /** Enable volatility-adjusted SL/TP */
  useVolatilityAdjusted: boolean;
  /** Volatility multiplier for SL/TP adjustment */
  volatilityMultiplier: number;

  // === Correlation & Diversification ===
  /** Maximum correlation between positions (0-1) */
  maxCorrelation: number;
  /** Maximum concentration in single market category (%) */
  maxCategoryConcentrationPct: number;
  /** Enable correlation risk checks */
  enableCorrelationChecks: boolean;

  // === Adaptive Risk Management ===
  /** Adaptive mode: NONE (binary halt), GRADUAL (reduce size), DYNAMIC (full adaptive) */
  adaptiveMode: AdaptiveMode;
  /** Size reduction after drawdown in GRADUAL mode (e.g., 0.5 = 50% size) */
  adaptiveReductionFactor: number;
  /** Drawdown threshold to trigger adaptive reduction (%) */
  adaptiveReductionThresholdPct: number;
  /** Recovery threshold to restore full size (%) - drawdown must be below this */
  adaptiveRecoveryThresholdPct: number;

  // === Kelly Criterion ===
  /** Kelly fraction (0-1) - fraction of full Kelly to use */
  kellyFraction: number;
  /** Minimum Kelly size threshold - reject signals below this */
  minKellySize: number;

  // === Value at Risk ===
  /** VaR confidence level (0-1, e.g., 0.95 = 95%) */
  varConfidence: number;
  /** VaR calculation window (bars) */
  varWindowSize: number;

  // === Monitoring ===
  /** Risk check interval (ms) */
  checkIntervalMs: number;
  /** Cooldown after halt (ms) - how long to wait before resuming */
  cooldownAfterHaltMs: number;
  /** Enable automatic resume after cooldown */
  autoResumeAfterCooldown: boolean;

  // === Leverage ===
  /** Maximum effective leverage (e.g., 1.5 = 1.5x) */
  maxLeverage: number;
}

// ============================================
// Predefined Risk Profiles
// ============================================

/**
 * AGGRESSIVE Profile
 * - Higher risk tolerance
 * - Larger position sizes
 * - More leverage
 * - Adaptive risk reduction (not binary halt)
 * - Oriented for active trading with capital preservation
 */
export const AGGRESSIVE_PROFILE: RiskConfig = {
  profileType: 'AGGRESSIVE',
  enabled: true,

  // Position Limits - Aggressive
  maxPositionSizePct: 15,        // 15% per position
  maxExposurePct: 85,            // 85% total exposure
  maxPositions: 12,              // More concurrent positions

  // Drawdown Limits - Moderate tolerance
  warningDrawdownPct: 15,        // Alert at 15%
  maxDrawdownPct: 25,            // Reduce size at 25%
  haltDrawdownPct: 35,           // Hard stop at 35%

  // Daily Loss Limits - Moderate
  warningDailyLossPct: 3,        // Alert at 3% daily loss
  maxDailyLossPct: 5,            // Reduce at 5% daily loss

  // Stop Loss / Take Profit - Wider for volatility
  stopLossPct: 15,               // 15% stop loss (tighter than before)
  takeProfitPct: 40,             // 40% take profit (more realistic 2.67:1 ratio)
  useTrailingStops: true,        // Enable trailing stops
  trailingStopPct: 8,            // 8% trailing distance
  useVolatilityAdjusted: true,   // Adjust for volatility
  volatilityMultiplier: 1.5,     // 1.5x volatility adjustment

  // Correlation & Diversification
  maxCorrelation: 0.7,           // 70% max correlation (tighter)
  maxCategoryConcentrationPct: 40, // Max 40% in one category
  enableCorrelationChecks: true,

  // Adaptive Risk Management - GRADUAL mode
  adaptiveMode: 'GRADUAL',       // Gradual reduction, not binary
  adaptiveReductionFactor: 0.5,  // Reduce to 50% size
  adaptiveReductionThresholdPct: 20, // Reduce at 20% drawdown
  adaptiveRecoveryThresholdPct: 10,  // Restore at <10% drawdown

  // Kelly Criterion
  kellyFraction: 0.4,            // 40% of full Kelly (aggressive but prudent)
  minKellySize: 0.01,            // 1% minimum

  // Value at Risk
  varConfidence: 0.95,
  varWindowSize: 100,

  // Monitoring
  checkIntervalMs: 5000,         // Check every 5 seconds
  cooldownAfterHaltMs: 900000,   // 15 minutes cooldown
  autoResumeAfterCooldown: true,

  // Leverage
  maxLeverage: 1.5,              // 1.5x leverage allowed
};

/**
 * MODERATE Profile
 * - Balanced risk/reward
 * - Standard position sizes
 * - Moderate leverage
 * - Adaptive risk reduction
 */
export const MODERATE_PROFILE: RiskConfig = {
  profileType: 'MODERATE',
  enabled: true,

  // Position Limits - Moderate
  maxPositionSizePct: 10,
  maxExposurePct: 75,
  maxPositions: 10,

  // Drawdown Limits
  warningDrawdownPct: 10,
  maxDrawdownPct: 20,
  haltDrawdownPct: 28,

  // Daily Loss Limits
  warningDailyLossPct: 2,
  maxDailyLossPct: 3.5,

  // Stop Loss / Take Profit
  stopLossPct: 12,
  takeProfitPct: 30,
  useTrailingStops: true,
  trailingStopPct: 6,
  useVolatilityAdjusted: true,
  volatilityMultiplier: 1.3,

  // Correlation & Diversification
  maxCorrelation: 0.65,
  maxCategoryConcentrationPct: 35,
  enableCorrelationChecks: true,

  // Adaptive Risk Management
  adaptiveMode: 'GRADUAL',
  adaptiveReductionFactor: 0.6,
  adaptiveReductionThresholdPct: 15,
  adaptiveRecoveryThresholdPct: 8,

  // Kelly Criterion
  kellyFraction: 0.3,
  minKellySize: 0.01,

  // Value at Risk
  varConfidence: 0.95,
  varWindowSize: 100,

  // Monitoring
  checkIntervalMs: 10000,
  cooldownAfterHaltMs: 1800000,  // 30 minutes
  autoResumeAfterCooldown: true,

  // Leverage
  maxLeverage: 1.3,
};

/**
 * CONSERVATIVE Profile
 * - Low risk tolerance
 * - Smaller position sizes
 * - Minimal leverage
 * - Binary halt on limits
 */
export const CONSERVATIVE_PROFILE: RiskConfig = {
  profileType: 'CONSERVATIVE',
  enabled: true,

  // Position Limits - Conservative
  maxPositionSizePct: 5,
  maxExposurePct: 60,
  maxPositions: 8,

  // Drawdown Limits
  warningDrawdownPct: 8,
  maxDrawdownPct: 12,
  haltDrawdownPct: 18,

  // Daily Loss Limits
  warningDailyLossPct: 1.5,
  maxDailyLossPct: 2.5,

  // Stop Loss / Take Profit
  stopLossPct: 8,
  takeProfitPct: 20,
  useTrailingStops: true,
  trailingStopPct: 4,
  useVolatilityAdjusted: false,
  volatilityMultiplier: 1.0,

  // Correlation & Diversification
  maxCorrelation: 0.6,
  maxCategoryConcentrationPct: 30,
  enableCorrelationChecks: true,

  // Adaptive Risk Management
  adaptiveMode: 'NONE',          // Binary halt
  adaptiveReductionFactor: 0.5,
  adaptiveReductionThresholdPct: 10,
  adaptiveRecoveryThresholdPct: 5,

  // Kelly Criterion
  kellyFraction: 0.2,
  minKellySize: 0.01,

  // Value at Risk
  varConfidence: 0.95,
  varWindowSize: 100,

  // Monitoring
  checkIntervalMs: 15000,
  cooldownAfterHaltMs: 3600000,  // 60 minutes
  autoResumeAfterCooldown: false,

  // Leverage
  maxLeverage: 1.1,
};

// ============================================
// Helper Functions
// ============================================

/**
 * Get risk profile by type
 */
export function getRiskProfile(type: RiskProfileType): RiskConfig {
  switch (type) {
    case 'AGGRESSIVE':
      return { ...AGGRESSIVE_PROFILE };
    case 'MODERATE':
      return { ...MODERATE_PROFILE };
    case 'CONSERVATIVE':
      return { ...CONSERVATIVE_PROFILE };
    default:
      return { ...AGGRESSIVE_PROFILE };
  }
}

/**
 * Get default risk profile (AGGRESSIVE as per requirements)
 */
export function getDefaultRiskProfile(): RiskConfig {
  return getRiskProfile('AGGRESSIVE');
}

/**
 * Merge custom config with base profile
 */
export function mergeRiskConfig(
  baseProfile: RiskProfileType | RiskConfig,
  overrides: Partial<RiskConfig>
): RiskConfig {
  const base = typeof baseProfile === 'string' ? getRiskProfile(baseProfile) : baseProfile;
  return { ...base, ...overrides };
}

/**
 * Validate risk config
 */
export function validateRiskConfig(config: RiskConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Position limits
  if (config.maxPositionSizePct <= 0 || config.maxPositionSizePct > 100) {
    errors.push('maxPositionSizePct must be between 0 and 100');
  }
  if (config.maxExposurePct <= 0 || config.maxExposurePct > 200) {
    errors.push('maxExposurePct must be between 0 and 200');
  }
  if (config.maxPositions < 1) {
    errors.push('maxPositions must be at least 1');
  }

  // Drawdown hierarchy
  if (config.warningDrawdownPct >= config.maxDrawdownPct) {
    errors.push('warningDrawdownPct must be < maxDrawdownPct');
  }
  if (config.maxDrawdownPct >= config.haltDrawdownPct) {
    errors.push('maxDrawdownPct must be < haltDrawdownPct');
  }

  // Daily loss
  if (config.warningDailyLossPct >= config.maxDailyLossPct) {
    errors.push('warningDailyLossPct must be < maxDailyLossPct');
  }

  // SL/TP ratio should be reasonable
  if (config.takeProfitPct < config.stopLossPct) {
    errors.push('takeProfitPct should be >= stopLossPct for positive risk/reward');
  }

  // Kelly fraction
  if (config.kellyFraction <= 0 || config.kellyFraction > 1) {
    errors.push('kellyFraction must be between 0 and 1');
  }

  // Adaptive thresholds
  if (config.adaptiveRecoveryThresholdPct >= config.adaptiveReductionThresholdPct) {
    errors.push('adaptiveRecoveryThresholdPct must be < adaptiveReductionThresholdPct');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Calculate adaptive position size multiplier based on current drawdown
 */
export function calculateAdaptiveMultiplier(
  currentDrawdownPct: number,
  config: RiskConfig
): number {
  if (config.adaptiveMode === 'NONE') {
    // Binary: full size or halt
    return currentDrawdownPct >= config.maxDrawdownPct ? 0 : 1;
  }

  if (config.adaptiveMode === 'GRADUAL') {
    // Gradual reduction
    if (currentDrawdownPct < config.adaptiveRecoveryThresholdPct) {
      return 1.0; // Full size
    } else if (currentDrawdownPct >= config.adaptiveReductionThresholdPct) {
      return config.adaptiveReductionFactor; // Reduced size
    } else {
      // Linear interpolation between recovery and reduction thresholds
      const range = config.adaptiveReductionThresholdPct - config.adaptiveRecoveryThresholdPct;
      const position = currentDrawdownPct - config.adaptiveRecoveryThresholdPct;
      const factor = position / range;
      return 1.0 - (1.0 - config.adaptiveReductionFactor) * factor;
    }
  }

  if (config.adaptiveMode === 'DYNAMIC') {
    // Dynamic: smooth curve based on drawdown
    if (currentDrawdownPct <= 0) {
      return 1.0;
    }
    // Exponential decay: multiplier = e^(-k * drawdown)
    const k = 2.0 / config.maxDrawdownPct; // Decay factor
    const multiplier = Math.exp(-k * currentDrawdownPct);
    return Math.max(config.adaptiveReductionFactor, multiplier);
  }

  return 1.0;
}

/**
 * Calculate volatility-adjusted stop loss
 */
export function calculateVolatilityAdjustedSL(
  baseStopLossPct: number,
  currentVolatility: number,
  avgVolatility: number,
  config: RiskConfig
): number {
  if (!config.useVolatilityAdjusted || avgVolatility === 0) {
    return baseStopLossPct;
  }

  const volatilityRatio = currentVolatility / avgVolatility;
  const adjustedSL = baseStopLossPct * (1 + (volatilityRatio - 1) * config.volatilityMultiplier);

  // Cap at reasonable bounds (0.5x to 3x base)
  return Math.max(baseStopLossPct * 0.5, Math.min(baseStopLossPct * 3, adjustedSL));
}

/**
 * Calculate volatility-adjusted take profit
 */
export function calculateVolatilityAdjustedTP(
  baseTakeProfitPct: number,
  currentVolatility: number,
  avgVolatility: number,
  config: RiskConfig
): number {
  if (!config.useVolatilityAdjusted || avgVolatility === 0) {
    return baseTakeProfitPct;
  }

  const volatilityRatio = currentVolatility / avgVolatility;
  const adjustedTP = baseTakeProfitPct * (1 + (volatilityRatio - 1) * config.volatilityMultiplier);

  // Cap at reasonable bounds (0.5x to 3x base)
  return Math.max(baseTakeProfitPct * 0.5, Math.min(baseTakeProfitPct * 3, adjustedTP));
}

/**
 * Convert USD limit to percentage of portfolio
 * Helper for migrating old configs
 */
export function convertUSDLimitToPercent(usdLimit: number, portfolioValue: number): number {
  if (portfolioValue === 0) return 0;
  return (usdLimit / portfolioValue) * 100;
}

/**
 * Convert percentage limit to USD
 * Helper for logging/display
 */
export function convertPercentLimitToUSD(percentLimit: number, portfolioValue: number): number {
  return (percentLimit / 100) * portfolioValue;
}

// ============================================
// Exports
// ============================================

export default {
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
};
