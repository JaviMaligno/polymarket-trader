/**
 * Validation Service
 *
 * Integrates the validation framework (walk-forward, monte carlo, overfit detection)
 * with the dashboard to validate strategies before deployment.
 */

import pino from 'pino';
import {
  createValidationReportGenerator,
  createOverfitDetector,
  type ValidationReport,
  type BacktestResult,
  type PerformanceMetrics,
} from '@polymarket-trader/backtest';

const logger = pino({ name: 'ValidationService' });

// ============================================
// Types
// ============================================

export interface ValidationServiceConfig {
  /** Minimum required Sharpe ratio for deployment */
  minSharpeRatio: number;
  /** Maximum acceptable Sharpe ratio (above this is likely overfit) */
  maxSharpeRatio: number;
  /** Minimum trades required */
  minTrades: number;
  /** Maximum drawdown allowed */
  maxDrawdown: number;
  /** Maximum overfit probability allowed */
  maxOverfitProbability: number;
  /** Enable strict validation (requires all checks to pass) */
  strictMode: boolean;
}

export interface ValidationDecision {
  shouldDeploy: boolean;
  confidence: number;
  decision: 'GO' | 'NO_GO' | 'CONDITIONAL';
  reasons: string[];
  warnings: string[];
  report?: ValidationReport;
}

export interface SimpleBacktestResult {
  metrics: PerformanceMetrics;
  trades: Array<{
    entryTime: Date;
    exitTime?: Date;
    pnl: number;
    direction: 'LONG' | 'SHORT';
  }>;
  equityCurve: Array<{
    timestamp: Date;
    equity: number;
  }>;
  params: Record<string, number>;
}

// ============================================
// Default Configuration
// ============================================

const DEFAULT_CONFIG: ValidationServiceConfig = {
  minSharpeRatio: 0.5,        // Minimum viable Sharpe
  maxSharpeRatio: 5.0,        // Above this is suspicious (likely overfit)
  minTrades: 20,              // Need enough trades for significance
  maxDrawdown: 0.30,          // Max 30% drawdown
  maxOverfitProbability: 0.5, // Max 50% overfit probability
  strictMode: false,          // Allow conditional deployment
};

// ============================================
// Validation Service
// ============================================

export class ValidationService {
  private config: ValidationServiceConfig;
  private reportGenerator;
  private overfitDetector;

  constructor(config?: Partial<ValidationServiceConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.reportGenerator = createValidationReportGenerator({
      minOosSharpe: this.config.minSharpeRatio,
      minConsistencyRatio: 0.6,
      maxOverfitProbability: this.config.maxOverfitProbability,
      minSignificance: 0.95,
      minTrades: this.config.minTrades,
      maxBrierScore: 0.25,
    });
    this.overfitDetector = createOverfitDetector({
      maxSharpeDegradation: 0.5, // Allow 50% degradation
      maxReturnDegradation: 0.5,
      minParameterStability: 0.3,
      minSampleSize: this.config.minTrades,
    });
  }

  /**
   * Validate a strategy's backtest results
   * Returns a GO/NO_GO decision with reasoning
   */
  async validateStrategy(
    strategyId: string,
    backtestResult: BacktestResult,
    inSampleResult?: BacktestResult
  ): Promise<ValidationDecision> {
    logger.info({ strategyId }, 'Validating strategy');

    const reasons: string[] = [];
    const warnings: string[] = [];
    let shouldDeploy = true;
    let decision: 'GO' | 'NO_GO' | 'CONDITIONAL' = 'GO';
    let confidence = 1.0;

    const metrics = backtestResult.metrics;

    // ============================================
    // Basic Sanity Checks
    // ============================================

    // Check minimum trades
    if (metrics.totalTrades < this.config.minTrades) {
      reasons.push(`Insufficient trades: ${metrics.totalTrades} < ${this.config.minTrades} required`);
      shouldDeploy = false;
      decision = 'NO_GO';
      confidence *= 0.5;
    }

    // Check Sharpe ratio bounds
    if (metrics.sharpeRatio < this.config.minSharpeRatio) {
      reasons.push(`Sharpe ratio ${metrics.sharpeRatio.toFixed(2)} below minimum ${this.config.minSharpeRatio}`);
      shouldDeploy = false;
      decision = 'NO_GO';
      confidence *= 0.7;
    }

    // Check for suspiciously high Sharpe (overfit indicator)
    if (metrics.sharpeRatio > this.config.maxSharpeRatio) {
      warnings.push(`Sharpe ratio ${metrics.sharpeRatio.toFixed(2)} is suspiciously high (likely overfit)`);
      confidence *= 0.5;
      if (this.config.strictMode) {
        reasons.push('Sharpe ratio exceeds maximum threshold');
        shouldDeploy = false;
        decision = 'NO_GO';
      } else {
        decision = 'CONDITIONAL';
      }
    }

    // Check max drawdown
    if (metrics.maxDrawdown > this.config.maxDrawdown) {
      warnings.push(`Max drawdown ${(metrics.maxDrawdown * 100).toFixed(1)}% exceeds ${(this.config.maxDrawdown * 100).toFixed(1)}%`);
      if (this.config.strictMode) {
        reasons.push('Max drawdown exceeds threshold');
        shouldDeploy = false;
        decision = 'NO_GO';
      } else if (decision !== 'NO_GO') {
        decision = 'CONDITIONAL';
      }
      confidence *= 0.8;
    }

    // Check win rate is reasonable
    if (metrics.winRate < 0.3) {
      warnings.push(`Low win rate: ${(metrics.winRate * 100).toFixed(1)}%`);
      confidence *= 0.9;
    }

    if (metrics.winRate > 0.9) {
      warnings.push(`Suspiciously high win rate: ${(metrics.winRate * 100).toFixed(1)}% (possible overfit)`);
      confidence *= 0.7;
    }

    // Check for negative returns
    if (metrics.totalReturn < 0) {
      reasons.push(`Negative total return: ${(metrics.totalReturn * 100).toFixed(2)}%`);
      shouldDeploy = false;
      decision = 'NO_GO';
    }

    // Check profit factor
    if (metrics.profitFactor < 1.0) {
      reasons.push(`Profit factor ${metrics.profitFactor.toFixed(2)} is below 1.0`);
      shouldDeploy = false;
      decision = 'NO_GO';
    }

    // ============================================
    // Overfit Detection
    // ============================================

    if (inSampleResult) {
      try {
        // Use quickCheck for fast overfit detection
        const inSampleSharpe = inSampleResult.metrics.sharpeRatio;
        const outOfSampleSharpe = backtestResult.metrics.sharpeRatio;
        // Estimate number of parameters from config (risk config has ~7 params)
        const numParams = 7;
        const numTrades = metrics.totalTrades;

        const overfitCheck = this.overfitDetector.quickCheck(
          inSampleSharpe,
          outOfSampleSharpe,
          numParams,
          numTrades
        );

        if (overfitCheck.isOverfit) {
          warnings.push(`Overfit detected: ${overfitCheck.reason}`);
          if (this.config.strictMode) {
            reasons.push('Overfitting detected in quick check');
            shouldDeploy = false;
            decision = 'NO_GO';
          } else if (decision !== 'NO_GO') {
            decision = 'CONDITIONAL';
          }
          confidence *= 0.6;
        }

        // Check for severe Sharpe degradation
        if (inSampleSharpe > 0) {
          const degradation = (inSampleSharpe - outOfSampleSharpe) / inSampleSharpe;
          if (degradation > 0.5) {
            warnings.push(`Severe Sharpe degradation: ${(degradation * 100).toFixed(1)}%`);
            confidence *= 0.7;
          }
        }
      } catch (error) {
        logger.warn({ error }, 'Overfit detection failed, proceeding without it');
        warnings.push('Overfit detection could not be performed');
      }
    } else {
      warnings.push('No in-sample data provided for overfit analysis');
    }

    // ============================================
    // Generate Full Report (optional)
    // ============================================

    let report: ValidationReport | undefined;
    try {
      report = this.reportGenerator.generate(
        strategyId,
        backtestResult,
        undefined, // walk-forward (expensive, skip for quick validation)
        undefined, // monte carlo (expensive, skip for quick validation)
        undefined  // overfit (already checked above)
      );
    } catch (error) {
      logger.warn({ error }, 'Report generation failed');
    }

    // ============================================
    // Final Decision
    // ============================================

    // Ensure consistency
    if (!shouldDeploy && decision === 'GO') {
      decision = 'NO_GO';
    }

    if (decision === 'GO' && warnings.length > 2) {
      decision = 'CONDITIONAL';
    }

    logger.info({
      strategyId,
      decision,
      shouldDeploy,
      confidence: confidence.toFixed(2),
      reasons: reasons.length,
      warnings: warnings.length,
    }, 'Validation complete');

    return {
      shouldDeploy,
      confidence,
      decision,
      reasons,
      warnings,
      report,
    };
  }

  /**
   * Quick validation check (no expensive operations)
   * Returns true if strategy passes basic sanity checks
   */
  quickValidate(metrics: PerformanceMetrics): { passed: boolean; reasons: string[] } {
    const reasons: string[] = [];
    let passed = true;

    if (metrics.totalTrades < this.config.minTrades) {
      reasons.push(`Insufficient trades: ${metrics.totalTrades}`);
      passed = false;
    }

    if (metrics.sharpeRatio < this.config.minSharpeRatio) {
      reasons.push(`Low Sharpe: ${metrics.sharpeRatio.toFixed(2)}`);
      passed = false;
    }

    if (metrics.sharpeRatio > this.config.maxSharpeRatio) {
      reasons.push(`Suspicious Sharpe: ${metrics.sharpeRatio.toFixed(2)} (likely overfit)`);
      passed = false;
    }

    if (metrics.totalReturn < 0) {
      reasons.push(`Negative return: ${(metrics.totalReturn * 100).toFixed(1)}%`);
      passed = false;
    }

    if (metrics.maxDrawdown > this.config.maxDrawdown) {
      reasons.push(`High drawdown: ${(metrics.maxDrawdown * 100).toFixed(1)}%`);
      passed = false;
    }

    if (metrics.profitFactor < 1.0) {
      reasons.push(`Profit factor < 1: ${metrics.profitFactor.toFixed(2)}`);
      passed = false;
    }

    return { passed, reasons };
  }

  /**
   * Get validation thresholds (for display/debugging)
   */
  getConfig(): ValidationServiceConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<ValidationServiceConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

// ============================================
// Singleton
// ============================================

let validationService: ValidationService | null = null;

export function getValidationService(): ValidationService {
  if (!validationService) {
    validationService = new ValidationService();
  }
  return validationService;
}

export function initializeValidationService(
  config?: Partial<ValidationServiceConfig>
): ValidationService {
  validationService = new ValidationService(config);
  return validationService;
}
