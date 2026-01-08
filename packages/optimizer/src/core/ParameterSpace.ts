/**
 * Parameter Space Definition
 *
 * Defines all tunable parameters for trading strategy optimization.
 * ~45 parameters organized by category.
 */

export interface ParameterDefinition {
  name: string;
  type: 'float' | 'int' | 'categorical';
  low?: number;
  high?: number;
  choices?: (string | number | boolean | null)[];
  log?: boolean;
  description?: string;
  category: string;
}

export interface ParameterValue {
  [key: string]: number | string | boolean | null;
}

export interface ParameterSpaceConfig {
  /** Include combiner parameters */
  includeCombiner?: boolean;
  /** Include risk parameters */
  includeRisk?: boolean;
  /** Include sizing parameters */
  includeSizing?: boolean;
  /** Include momentum signal parameters */
  includeMomentum?: boolean;
  /** Include mean reversion signal parameters */
  includeMeanReversion?: boolean;
  /** Include market filter parameters */
  includeMarketFilters?: boolean;
  /** Include timing parameters */
  includeTiming?: boolean;
  /** Include execution parameters */
  includeExecution?: boolean;
}

/**
 * Full parameter space definition (~45 parameters)
 */
export const FULL_PARAMETER_SPACE: ParameterDefinition[] = [
  // ============================================
  // COMBINER PARAMETERS
  // ============================================
  {
    name: 'combiner.minCombinedConfidence',
    type: 'float',
    low: 0.1,
    high: 0.7,
    category: 'combiner',
    description: 'Minimum combined confidence to emit signal',
  },
  {
    name: 'combiner.minCombinedStrength',
    type: 'float',
    low: 0.1,
    high: 0.7,
    category: 'combiner',
    description: 'Minimum combined strength to emit signal',
  },
  {
    name: 'combiner.onlyDirection',
    type: 'categorical',
    choices: [null, 'LONG', 'SHORT'],
    category: 'combiner',
    description: 'Only trade signals in this direction',
  },
  {
    name: 'combiner.momentumWeight',
    type: 'float',
    low: 0.0,
    high: 3.0,
    category: 'combiner',
    description: 'Weight for momentum signals',
  },
  {
    name: 'combiner.meanReversionWeight',
    type: 'float',
    low: 0.0,
    high: 3.0,
    category: 'combiner',
    description: 'Weight for mean reversion signals',
  },
  {
    name: 'combiner.conflictResolution',
    type: 'categorical',
    choices: ['weighted', 'strongest', 'majority'],
    category: 'combiner',
    description: 'How to resolve conflicting signals',
  },
  {
    name: 'combiner.timeDecayFactor',
    type: 'float',
    low: 0.5,
    high: 1.0,
    category: 'combiner',
    description: 'Decay factor for older signals',
  },
  {
    name: 'combiner.maxSignalAgeMinutes',
    type: 'int',
    low: 5,
    high: 60,
    category: 'combiner',
    description: 'Maximum age of signal before full decay',
  },

  // ============================================
  // RISK PARAMETERS
  // ============================================
  {
    name: 'risk.maxPositionSizePct',
    type: 'float',
    low: 1.0,
    high: 25.0,
    category: 'risk',
    description: 'Maximum position size as % of portfolio',
  },
  {
    name: 'risk.maxExposurePct',
    type: 'float',
    low: 20.0,
    high: 100.0,
    category: 'risk',
    description: 'Maximum total exposure as % of portfolio',
  },
  {
    name: 'risk.stopLossPct',
    type: 'float',
    low: 5.0,
    high: 40.0,
    category: 'risk',
    description: 'Stop loss percentage per position',
  },
  {
    name: 'risk.takeProfitPct',
    type: 'float',
    low: 10.0,
    high: 150.0,
    category: 'risk',
    description: 'Take profit percentage per position',
  },
  {
    name: 'risk.maxPositions',
    type: 'int',
    low: 3,
    high: 30,
    category: 'risk',
    description: 'Maximum concurrent positions',
  },
  {
    name: 'risk.maxDrawdownPct',
    type: 'float',
    low: 10.0,
    high: 40.0,
    category: 'risk',
    description: 'Maximum drawdown before stopping',
  },
  {
    name: 'risk.minCashBufferPct',
    type: 'float',
    low: 5.0,
    high: 30.0,
    category: 'risk',
    description: 'Minimum cash buffer percentage',
  },

  // ============================================
  // SIZING PARAMETERS
  // ============================================
  {
    name: 'sizing.method',
    type: 'categorical',
    choices: ['fixed', 'kelly', 'volatility_adjusted'],
    category: 'sizing',
    description: 'Position sizing method',
  },
  {
    name: 'sizing.kellyFraction',
    type: 'float',
    low: 0.1,
    high: 0.5,
    category: 'sizing',
    description: 'Fraction of Kelly criterion to use',
  },
  {
    name: 'sizing.volatilityLookback',
    type: 'int',
    low: 10,
    high: 50,
    category: 'sizing',
    description: 'Lookback period for volatility calculation',
  },

  // ============================================
  // MOMENTUM SIGNAL PARAMETERS
  // ============================================
  {
    name: 'momentum.rsiPeriod',
    type: 'int',
    low: 5,
    high: 28,
    category: 'momentum',
    description: 'RSI calculation period',
  },
  {
    name: 'momentum.rsiOverbought',
    type: 'float',
    low: 60.0,
    high: 90.0,
    category: 'momentum',
    description: 'RSI overbought threshold',
  },
  {
    name: 'momentum.rsiOversold',
    type: 'float',
    low: 10.0,
    high: 40.0,
    category: 'momentum',
    description: 'RSI oversold threshold',
  },
  {
    name: 'momentum.macdFast',
    type: 'int',
    low: 6,
    high: 18,
    category: 'momentum',
    description: 'MACD fast EMA period',
  },
  {
    name: 'momentum.macdSlow',
    type: 'int',
    low: 18,
    high: 35,
    category: 'momentum',
    description: 'MACD slow EMA period',
  },
  {
    name: 'momentum.macdSignal',
    type: 'int',
    low: 5,
    high: 15,
    category: 'momentum',
    description: 'MACD signal line period',
  },
  {
    name: 'momentum.trendLookback',
    type: 'int',
    low: 10,
    high: 50,
    category: 'momentum',
    description: 'Trend direction lookback period',
  },
  {
    name: 'momentum.minTrendStrength',
    type: 'float',
    low: 0.0,
    high: 0.3,
    category: 'momentum',
    description: 'Minimum trend strength to trade',
  },

  // ============================================
  // MEAN REVERSION SIGNAL PARAMETERS
  // ============================================
  {
    name: 'meanReversion.bollingerPeriod',
    type: 'int',
    low: 10,
    high: 40,
    category: 'meanReversion',
    description: 'Bollinger Bands period',
  },
  {
    name: 'meanReversion.bollingerStdDev',
    type: 'float',
    low: 1.0,
    high: 4.0,
    category: 'meanReversion',
    description: 'Bollinger Bands standard deviation multiplier',
  },
  {
    name: 'meanReversion.zScorePeriod',
    type: 'int',
    low: 5,
    high: 40,
    category: 'meanReversion',
    description: 'Z-score calculation period',
  },
  {
    name: 'meanReversion.zScoreThreshold',
    type: 'float',
    low: 1.0,
    high: 4.0,
    category: 'meanReversion',
    description: 'Z-score threshold for signals',
  },
  {
    name: 'meanReversion.meanType',
    type: 'categorical',
    choices: ['sma', 'ema', 'wma'],
    category: 'meanReversion',
    description: 'Type of moving average for mean',
  },

  // ============================================
  // MARKET FILTER PARAMETERS
  // ============================================
  {
    name: 'marketFilters.minVolume24h',
    type: 'float',
    low: 100.0,
    high: 10000.0,
    log: true,
    category: 'marketFilters',
    description: 'Minimum 24h volume in USD',
  },
  {
    name: 'marketFilters.minLiquidity',
    type: 'float',
    low: 1000.0,
    high: 50000.0,
    log: true,
    category: 'marketFilters',
    description: 'Minimum liquidity in USD',
  },
  {
    name: 'marketFilters.priceRangeMin',
    type: 'float',
    low: 0.02,
    high: 0.15,
    category: 'marketFilters',
    description: 'Minimum price to trade',
  },
  {
    name: 'marketFilters.priceRangeMax',
    type: 'float',
    low: 0.85,
    high: 0.98,
    category: 'marketFilters',
    description: 'Maximum price to trade',
  },
  {
    name: 'marketFilters.minDaysToExpiry',
    type: 'int',
    low: 1,
    high: 14,
    category: 'marketFilters',
    description: 'Minimum days to market expiry',
  },

  // ============================================
  // TIMING PARAMETERS
  // ============================================
  {
    name: 'timing.tradingHoursStart',
    type: 'int',
    low: 0,
    high: 12,
    category: 'timing',
    description: 'Trading hours start (UTC)',
  },
  {
    name: 'timing.tradingHoursEnd',
    type: 'int',
    low: 12,
    high: 24,
    category: 'timing',
    description: 'Trading hours end (UTC)',
  },
  {
    name: 'timing.avoidWeekends',
    type: 'categorical',
    choices: [true, false],
    category: 'timing',
    description: 'Avoid trading on weekends',
  },
  {
    name: 'timing.minBarsBetweenTrades',
    type: 'int',
    low: 1,
    high: 24,
    category: 'timing',
    description: 'Minimum bars between trades on same market',
  },

  // ============================================
  // EXECUTION PARAMETERS
  // ============================================
  {
    name: 'execution.slippageModel',
    type: 'categorical',
    choices: ['fixed', 'proportional', 'orderbook'],
    category: 'execution',
    description: 'Slippage model type',
  },
  {
    name: 'execution.fixedSlippageBps',
    type: 'int',
    low: 10,
    high: 100,
    category: 'execution',
    description: 'Fixed slippage in basis points',
  },
  {
    name: 'execution.maxSlippagePct',
    type: 'float',
    low: 0.5,
    high: 3.0,
    category: 'execution',
    description: 'Maximum slippage percentage',
  },
];

/**
 * Minimal parameter space for quick optimization (~8 parameters)
 */
export const MINIMAL_PARAMETER_SPACE: ParameterDefinition[] =
  FULL_PARAMETER_SPACE.filter((p) =>
    [
      'combiner.minCombinedConfidence',
      'combiner.minCombinedStrength',
      'combiner.onlyDirection',
      'risk.maxPositionSizePct',
      'risk.maxPositions',
      'momentum.rsiPeriod',
      'meanReversion.bollingerPeriod',
      'meanReversion.zScoreThreshold',
    ].includes(p.name)
  );

// Type alias for nested parameter values
export type ParameterValues = Record<string, Record<string, unknown>>;

// Type alias for parameter category
export type ParameterCategory =
  | 'combiner'
  | 'risk'
  | 'sizing'
  | 'momentum'
  | 'meanReversion'
  | 'marketFilters'
  | 'timing'
  | 'execution';

/**
 * Parameter Space class for managing optimization parameters
 */
export class ParameterSpace {
  private parameters: ParameterDefinition[];

  constructor(configOrParams?: ParameterSpaceConfig | ParameterDefinition[]) {
    if (!configOrParams) {
      // Use full parameter space by default
      this.parameters = [...FULL_PARAMETER_SPACE];
    } else if (Array.isArray(configOrParams)) {
      // Direct parameter definitions passed
      this.parameters = configOrParams;
    } else {
      // Build custom parameter space based on config
      const config = configOrParams;
      this.parameters = FULL_PARAMETER_SPACE.filter((p) => {
        switch (p.category) {
          case 'combiner':
            return config.includeCombiner !== false;
          case 'risk':
            return config.includeRisk !== false;
          case 'sizing':
            return config.includeSizing !== false;
          case 'momentum':
            return config.includeMomentum !== false;
          case 'meanReversion':
            return config.includeMeanReversion !== false;
          case 'marketFilters':
            return config.includeMarketFilters !== false;
          case 'timing':
            return config.includeTiming !== false;
          case 'execution':
            return config.includeExecution !== false;
          default:
            return true;
        }
      });
    }
  }

  /**
   * Get all parameter definitions
   */
  getParameters(): ParameterDefinition[] {
    return this.parameters;
  }

  /**
   * Get parameters for a specific category
   */
  getParametersByCategory(category: string): ParameterDefinition[] {
    return this.parameters.filter((p) => p.category === category);
  }

  /**
   * Get all categories
   */
  getCategories(): string[] {
    return [...new Set(this.parameters.map((p) => p.category))];
  }

  /**
   * Convert to format expected by Python optimizer
   */
  toOptunaFormat(): Array<{
    name: string;
    type: string;
    low?: number;
    high?: number;
    choices?: (string | number | boolean | null)[];
    log: boolean;
  }> {
    return this.parameters.map((p) => ({
      name: p.name,
      type: p.type,
      low: p.low,
      high: p.high,
      choices: p.choices,
      log: p.log || false,
    }));
  }

  /**
   * Parse flat parameter values into nested structure
   */
  parseParams(flat: ParameterValue): ParameterValues {
    const result: ParameterValues = {};

    for (const [key, value] of Object.entries(flat)) {
      const [category, name] = key.split('.');
      if (!result[category]) {
        result[category] = {};
      }
      result[category][name] = value;
    }

    return result;
  }

  /**
   * Flatten nested parameters to dot notation
   */
  flattenParams(nested: ParameterValues): ParameterValue {
    const result: ParameterValue = {};

    for (const [category, params] of Object.entries(nested)) {
      for (const [name, value] of Object.entries(params)) {
        result[`${category}.${name}`] = value as
          | number
          | string
          | boolean
          | null;
      }
    }

    return result;
  }

  /**
   * Validate parameter values
   */
  validate(params: ParameterValue): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    for (const def of this.parameters) {
      const value = params[def.name];

      if (value === undefined) {
        continue; // Optional parameter
      }

      if (def.type === 'float' || def.type === 'int') {
        if (typeof value !== 'number') {
          errors.push(`${def.name}: expected number, got ${typeof value}`);
          continue;
        }

        if (def.low !== undefined && value < def.low) {
          errors.push(`${def.name}: ${value} is below minimum ${def.low}`);
        }

        if (def.high !== undefined && value > def.high) {
          errors.push(`${def.name}: ${value} is above maximum ${def.high}`);
        }

        if (def.type === 'int' && !Number.isInteger(value)) {
          errors.push(`${def.name}: expected integer, got float`);
        }
      } else if (def.type === 'categorical') {
        if (!def.choices?.includes(value)) {
          errors.push(
            `${def.name}: ${value} is not a valid choice. Valid: ${def.choices?.join(', ')}`
          );
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Get default parameter values
   */
  getDefaults(): ParameterValue {
    const defaults: ParameterValue = {};

    for (const def of this.parameters) {
      if (def.type === 'float' || def.type === 'int') {
        // Use midpoint of range
        defaults[def.name] = (def.low! + def.high!) / 2;
      } else if (def.type === 'categorical') {
        // Use first choice
        defaults[def.name] = def.choices![0];
      }
    }

    return defaults;
  }

  /**
   * Get parameter count
   */
  get size(): number {
    return this.parameters.length;
  }
}

/**
 * Create a parameter space with the specified configuration
 */
export function createParameterSpace(
  config?: ParameterSpaceConfig
): ParameterSpace {
  return new ParameterSpace(config);
}

/**
 * Create a minimal parameter space for quick optimization
 */
export function createMinimalParameterSpace(): ParameterSpace {
  const space = new ParameterSpace();
  // @ts-expect-error - overriding private property for minimal space
  space.parameters = MINIMAL_PARAMETER_SPACE;
  return space;
}
