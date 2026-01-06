/**
 * Monte Carlo Simulator
 *
 * Performs Monte Carlo simulations and permutation tests to validate
 * strategy performance and estimate confidence intervals.
 */

import pino from 'pino';
import type { TradeRecord, PerformanceMetrics } from '../types/index.js';

const logger = pino({ name: 'MonteCarloSimulator' });

// ============================================
// Types
// ============================================

export interface MonteCarloConfig {
  /** Number of simulations to run */
  numSimulations: number;
  /** Random seed for reproducibility */
  randomSeed?: number;
  /** Confidence level for intervals (e.g., 0.95) */
  confidenceLevel: number;
  /** Whether to use bootstrapping (with replacement) */
  bootstrap: boolean;
}

export interface MonteCarloResult {
  config: MonteCarloConfig;
  /** Original strategy metrics */
  originalMetrics: SimulationMetrics;
  /** Distribution of simulated metrics */
  distribution: SimulationDistribution;
  /** Statistical significance tests */
  significanceTests: SignificanceTests;
  /** Confidence intervals */
  confidenceIntervals: ConfidenceIntervals;
  /** Risk metrics from simulations */
  riskMetrics: RiskMetrics;
}

export interface SimulationMetrics {
  totalReturn: number;
  sharpeRatio: number;
  maxDrawdown: number;
  winRate: number;
  profitFactor: number;
  avgTradeReturn: number;
}

export interface SimulationDistribution {
  returns: number[];
  sharpes: number[];
  drawdowns: number[];
  winRates: number[];
}

export interface SignificanceTests {
  /** P-value for returns being positive */
  returnsPValue: number;
  /** P-value for Sharpe > 0 */
  sharpePValue: number;
  /** P-value for strategy beating random */
  vsRandomPValue: number;
  /** Whether strategy is statistically significant */
  isSignificant: boolean;
}

export interface ConfidenceIntervals {
  returns: { lower: number; upper: number };
  sharpe: { lower: number; upper: number };
  drawdown: { lower: number; upper: number };
  winRate: { lower: number; upper: number };
}

export interface RiskMetrics {
  /** Value at Risk at confidence level */
  valueAtRisk: number;
  /** Conditional VaR (Expected Shortfall) */
  conditionalVaR: number;
  /** Probability of ruin (losing X% of capital) */
  probabilityOfRuin: number;
  /** Expected worst drawdown */
  expectedWorstDrawdown: number;
  /** Tail ratio (upside/downside) */
  tailRatio: number;
}

// ============================================
// Monte Carlo Simulator
// ============================================

export class MonteCarloSimulator {
  private config: MonteCarloConfig;
  private rng: () => number;

  constructor(config: MonteCarloConfig) {
    this.config = config;
    this.rng = this.createRng(config.randomSeed);
  }

  /**
   * Create a seeded random number generator
   */
  private createRng(seed?: number): () => number {
    if (seed === undefined) {
      return Math.random;
    }

    // Simple seeded RNG (Mulberry32)
    let state = seed;
    return () => {
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Run Monte Carlo simulation on trades
   */
  simulate(trades: TradeRecord[]): MonteCarloResult {
    if (trades.length < 10) {
      throw new Error('Need at least 10 trades for Monte Carlo simulation');
    }

    logger.info({ numTrades: trades.length, numSimulations: this.config.numSimulations }, 'Starting Monte Carlo simulation');

    // Calculate original metrics
    const originalMetrics = this.calculateMetrics(trades);

    // Run simulations
    const distribution = this.runSimulations(trades);

    // Calculate statistical tests
    const significanceTests = this.calculateSignificance(originalMetrics, distribution);

    // Calculate confidence intervals
    const confidenceIntervals = this.calculateConfidenceIntervals(distribution);

    // Calculate risk metrics
    const riskMetrics = this.calculateRiskMetrics(distribution, trades);

    return {
      config: this.config,
      originalMetrics,
      distribution,
      significanceTests,
      confidenceIntervals,
      riskMetrics,
    };
  }

  /**
   * Run permutation test to compare strategy to random
   */
  permutationTest(
    trades: TradeRecord[],
    numPermutations: number = 1000
  ): { pValue: number; isSignificant: boolean; randomReturns: number[] } {
    const originalReturn = this.calculateTotalReturn(trades);
    const randomReturns: number[] = [];

    for (let i = 0; i < numPermutations; i++) {
      // Randomly shuffle trade outcomes (but keep sizes/entries)
      const permutedTrades = this.permuteOutcomes(trades);
      randomReturns.push(this.calculateTotalReturn(permutedTrades));
    }

    // P-value: proportion of random returns >= original
    const betterCount = randomReturns.filter(r => r >= originalReturn).length;
    const pValue = betterCount / numPermutations;

    return {
      pValue,
      isSignificant: pValue < 0.05,
      randomReturns,
    };
  }

  /**
   * Run bootstrap analysis for confidence intervals
   */
  bootstrapAnalysis(
    trades: TradeRecord[],
    numBootstraps: number = 1000
  ): { metrics: SimulationMetrics[]; confidenceIntervals: ConfidenceIntervals } {
    const metrics: SimulationMetrics[] = [];

    for (let i = 0; i < numBootstraps; i++) {
      const sample = this.bootstrapSample(trades);
      metrics.push(this.calculateMetrics(sample));
    }

    const distribution: SimulationDistribution = {
      returns: metrics.map(m => m.totalReturn),
      sharpes: metrics.map(m => m.sharpeRatio),
      drawdowns: metrics.map(m => m.maxDrawdown),
      winRates: metrics.map(m => m.winRate),
    };

    return {
      metrics,
      confidenceIntervals: this.calculateConfidenceIntervals(distribution),
    };
  }

  /**
   * Run simulations with trade shuffling/resampling
   */
  private runSimulations(trades: TradeRecord[]): SimulationDistribution {
    const returns: number[] = [];
    const sharpes: number[] = [];
    const drawdowns: number[] = [];
    const winRates: number[] = [];

    for (let i = 0; i < this.config.numSimulations; i++) {
      const sample = this.config.bootstrap
        ? this.bootstrapSample(trades)
        : this.shuffleTrades(trades);

      const metrics = this.calculateMetrics(sample);

      returns.push(metrics.totalReturn);
      sharpes.push(metrics.sharpeRatio);
      drawdowns.push(metrics.maxDrawdown);
      winRates.push(metrics.winRate);
    }

    return { returns, sharpes, drawdowns, winRates };
  }

  /**
   * Calculate metrics from trades
   */
  private calculateMetrics(trades: TradeRecord[]): SimulationMetrics {
    if (trades.length === 0) {
      return {
        totalReturn: 0,
        sharpeRatio: 0,
        maxDrawdown: 0,
        winRate: 0,
        profitFactor: 0,
        avgTradeReturn: 0,
      };
    }

    const returns = trades.map(t => t.pnlPct / 100);
    const totalReturn = this.calculateTotalReturn(trades);

    // Sharpe ratio (annualized, assuming daily returns)
    const avgReturn = this.mean(returns);
    const stdReturn = this.std(returns);
    const sharpeRatio = stdReturn > 0 ? (avgReturn * Math.sqrt(252)) / stdReturn : 0;

    // Max drawdown
    const maxDrawdown = this.calculateMaxDrawdown(trades);

    // Win rate
    const wins = trades.filter(t => t.pnl > 0);
    const winRate = wins.length / trades.length;

    // Profit factor
    const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
    const grossLoss = Math.abs(trades.filter(t => t.pnl < 0).reduce((sum, t) => sum + t.pnl, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    // Average trade return
    const avgTradeReturn = this.mean(returns);

    return {
      totalReturn,
      sharpeRatio,
      maxDrawdown,
      winRate,
      profitFactor,
      avgTradeReturn,
    };
  }

  /**
   * Calculate total return from trades
   */
  private calculateTotalReturn(trades: TradeRecord[]): number {
    let equity = 1;
    for (const trade of trades) {
      equity *= (1 + trade.pnlPct / 100);
    }
    return equity - 1;
  }

  /**
   * Calculate maximum drawdown from trades
   */
  private calculateMaxDrawdown(trades: TradeRecord[]): number {
    let equity = 1;
    let peak = 1;
    let maxDrawdown = 0;

    for (const trade of trades) {
      equity *= (1 + trade.pnlPct / 100);
      if (equity > peak) {
        peak = equity;
      }
      const drawdown = (peak - equity) / peak;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }

    return maxDrawdown;
  }

  /**
   * Bootstrap sample (with replacement)
   */
  private bootstrapSample(trades: TradeRecord[]): TradeRecord[] {
    const sample: TradeRecord[] = [];
    for (let i = 0; i < trades.length; i++) {
      const idx = Math.floor(this.rng() * trades.length);
      sample.push(trades[idx]);
    }
    return sample;
  }

  /**
   * Shuffle trades (without replacement)
   */
  private shuffleTrades(trades: TradeRecord[]): TradeRecord[] {
    const shuffled = [...trades];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  /**
   * Permute trade outcomes for permutation test
   */
  private permuteOutcomes(trades: TradeRecord[]): TradeRecord[] {
    // Shuffle the PnL values while keeping trade structure
    const pnls = trades.map(t => t.pnl);
    const pnlPcts = trades.map(t => t.pnlPct);

    // Shuffle
    for (let i = pnls.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [pnls[i], pnls[j]] = [pnls[j], pnls[i]];
      [pnlPcts[i], pnlPcts[j]] = [pnlPcts[j], pnlPcts[i]];
    }

    // Assign shuffled PnLs back
    return trades.map((t, i) => ({
      ...t,
      pnl: pnls[i],
      pnlPct: pnlPcts[i],
    }));
  }

  /**
   * Calculate statistical significance
   */
  private calculateSignificance(
    original: SimulationMetrics,
    distribution: SimulationDistribution
  ): SignificanceTests {
    // P-value for returns being positive (one-tailed)
    const returnsBelowZero = distribution.returns.filter(r => r <= 0).length;
    const returnsPValue = returnsBelowZero / distribution.returns.length;

    // P-value for Sharpe > 0
    const sharpeBelowZero = distribution.sharpes.filter(s => s <= 0).length;
    const sharpePValue = sharpeBelowZero / distribution.sharpes.length;

    // P-value vs random (how many simulations beat original)
    const betterThanOriginal = distribution.returns.filter(r => r >= original.totalReturn).length;
    const vsRandomPValue = betterThanOriginal / distribution.returns.length;

    return {
      returnsPValue,
      sharpePValue,
      vsRandomPValue,
      isSignificant: returnsPValue < 0.05 && sharpePValue < 0.05,
    };
  }

  /**
   * Calculate confidence intervals
   */
  private calculateConfidenceIntervals(distribution: SimulationDistribution): ConfidenceIntervals {
    const alpha = 1 - this.config.confidenceLevel;

    return {
      returns: this.percentileInterval(distribution.returns, alpha),
      sharpe: this.percentileInterval(distribution.sharpes, alpha),
      drawdown: this.percentileInterval(distribution.drawdowns, alpha),
      winRate: this.percentileInterval(distribution.winRates, alpha),
    };
  }

  /**
   * Calculate percentile-based confidence interval
   */
  private percentileInterval(values: number[], alpha: number): { lower: number; upper: number } {
    const sorted = [...values].sort((a, b) => a - b);
    const lowerIdx = Math.floor((alpha / 2) * sorted.length);
    const upperIdx = Math.floor((1 - alpha / 2) * sorted.length);

    return {
      lower: sorted[lowerIdx] ?? sorted[0],
      upper: sorted[upperIdx] ?? sorted[sorted.length - 1],
    };
  }

  /**
   * Calculate risk metrics
   */
  private calculateRiskMetrics(
    distribution: SimulationDistribution,
    trades: TradeRecord[]
  ): RiskMetrics {
    const alpha = 1 - this.config.confidenceLevel;
    const sorted = [...distribution.returns].sort((a, b) => a - b);

    // Value at Risk (VaR)
    const varIdx = Math.floor(alpha * sorted.length);
    const valueAtRisk = Math.abs(sorted[varIdx] ?? 0);

    // Conditional VaR (Expected Shortfall)
    const tailReturns = sorted.slice(0, varIdx);
    const conditionalVaR = tailReturns.length > 0
      ? Math.abs(this.mean(tailReturns))
      : valueAtRisk;

    // Probability of ruin (losing 50%+)
    const ruinCount = distribution.returns.filter(r => r <= -0.5).length;
    const probabilityOfRuin = ruinCount / distribution.returns.length;

    // Expected worst drawdown
    const sortedDrawdowns = [...distribution.drawdowns].sort((a, b) => b - a);
    const expectedWorstDrawdown = sortedDrawdowns[0] ?? 0;

    // Tail ratio (upside/downside)
    const upside95 = sorted[Math.floor(0.95 * sorted.length)] ?? 0;
    const downside5 = Math.abs(sorted[Math.floor(0.05 * sorted.length)] ?? 0);
    const tailRatio = downside5 > 0 ? upside95 / downside5 : upside95 > 0 ? Infinity : 1;

    return {
      valueAtRisk,
      conditionalVaR,
      probabilityOfRuin,
      expectedWorstDrawdown,
      tailRatio,
    };
  }

  /**
   * Calculate mean
   */
  private mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  /**
   * Calculate standard deviation
   */
  private std(values: number[]): number {
    if (values.length < 2) return 0;
    const m = this.mean(values);
    const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length;
    return Math.sqrt(variance);
  }
}

/**
 * Create a Monte Carlo simulator with default config
 */
export function createMonteCarloSimulator(
  options?: Partial<MonteCarloConfig>
): MonteCarloSimulator {
  return new MonteCarloSimulator({
    numSimulations: options?.numSimulations ?? 10000,
    randomSeed: options?.randomSeed,
    confidenceLevel: options?.confidenceLevel ?? 0.95,
    bootstrap: options?.bootstrap ?? true,
  });
}
