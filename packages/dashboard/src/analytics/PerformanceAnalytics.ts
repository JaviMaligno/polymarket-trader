/**
 * Performance Analytics
 *
 * Calculates comprehensive performance metrics for trading strategies.
 */

import type {
  PerformanceMetrics,
  DailyPerformance,
  StrategyPerformance,
  TradeSummary,
  EquityCurveData,
  TradeDistribution,
  ChartDataPoint,
} from '../types/index.js';

interface EquityPoint {
  timestamp: Date;
  equity: number;
}

interface TradeRecord {
  timestamp: Date;
  pnl: number;
  holdingPeriod: number; // hours
  side: 'BUY' | 'SELL';
}

export class PerformanceAnalytics {
  private readonly riskFreeRate: number;
  private readonly tradingDaysPerYear: number;

  constructor(options: {
    riskFreeRate?: number;
    tradingDaysPerYear?: number;
  } = {}) {
    this.riskFreeRate = options.riskFreeRate ?? 0.05; // 5% annual
    this.tradingDaysPerYear = options.tradingDaysPerYear ?? 365; // Crypto trades 24/7
  }

  /**
   * Calculate comprehensive performance metrics
   */
  calculateMetrics(
    equityHistory: EquityPoint[],
    trades: TradeRecord[],
    initialCapital: number
  ): PerformanceMetrics {
    if (equityHistory.length < 2) {
      return this.emptyMetrics();
    }

    // Calculate returns
    const dailyReturns = this.calculateDailyReturns(equityHistory);
    const cumulativeReturns = this.calculateCumulativeReturns(dailyReturns);

    // Final equity and returns
    const finalEquity = equityHistory[equityHistory.length - 1].equity;
    const totalReturn = (finalEquity - initialCapital) / initialCapital;

    // Time period in years
    const startDate = equityHistory[0].timestamp;
    const endDate = equityHistory[equityHistory.length - 1].timestamp;
    const daysDiff = (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);
    const years = Math.max(daysDiff / 365, 1 / 365);

    // Annualized return
    const annualizedReturn = Math.pow(1 + totalReturn, 1 / years) - 1;

    // Risk metrics
    const volatility = this.calculateVolatility(dailyReturns);
    const { maxDrawdown, maxDrawdownDuration } = this.calculateDrawdown(equityHistory);

    // Risk-adjusted returns
    const sharpeRatio = this.calculateSharpeRatio(dailyReturns, volatility);
    const sortinoRatio = this.calculateSortinoRatio(dailyReturns);
    const calmarRatio = maxDrawdown !== 0 ? annualizedReturn / Math.abs(maxDrawdown) : 0;

    // Trading metrics
    const { winRate, profitFactor, avgWin, avgLoss } = this.calculateTradeMetrics(trades);
    const avgHoldingPeriod = trades.length > 0
      ? trades.reduce((sum, t) => sum + t.holdingPeriod, 0) / trades.length
      : 0;

    // Exposure metrics (simplified - would need position data for accurate calc)
    const avgExposure = 0.5; // Placeholder
    const maxExposure = 1.0;
    const timeInMarket = trades.length > 0 ? 0.8 : 0;

    return {
      totalReturn,
      annualizedReturn,
      dailyReturns,
      cumulativeReturns,
      volatility,
      sharpeRatio,
      sortinoRatio,
      maxDrawdown,
      maxDrawdownDuration,
      calmarRatio,
      totalTrades: trades.length,
      winRate,
      profitFactor,
      avgWin,
      avgLoss,
      avgHoldingPeriod,
      avgExposure,
      maxExposure,
      timeInMarket,
    };
  }

  /**
   * Calculate daily returns from equity curve
   */
  private calculateDailyReturns(equityHistory: EquityPoint[]): number[] {
    const returns: number[] = [];

    // Group by day
    const dailyEquity = this.groupByDay(equityHistory);
    const days = Array.from(dailyEquity.keys()).sort();

    for (let i = 1; i < days.length; i++) {
      const prevEquity = dailyEquity.get(days[i - 1])!;
      const currEquity = dailyEquity.get(days[i])!;
      returns.push((currEquity - prevEquity) / prevEquity);
    }

    return returns;
  }

  /**
   * Group equity points by day
   */
  private groupByDay(equityHistory: EquityPoint[]): Map<string, number> {
    const daily = new Map<string, number>();

    for (const point of equityHistory) {
      const day = point.timestamp.toISOString().split('T')[0];
      daily.set(day, point.equity); // Take last equity of each day
    }

    return daily;
  }

  /**
   * Calculate cumulative returns
   */
  private calculateCumulativeReturns(dailyReturns: number[]): number[] {
    const cumulative: number[] = [];
    let cumReturn = 1;

    for (const ret of dailyReturns) {
      cumReturn *= (1 + ret);
      cumulative.push(cumReturn - 1);
    }

    return cumulative;
  }

  /**
   * Calculate annualized volatility
   */
  private calculateVolatility(dailyReturns: number[]): number {
    if (dailyReturns.length < 2) return 0;

    const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const squaredDiffs = dailyReturns.map(r => Math.pow(r - mean, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / (dailyReturns.length - 1);

    // Annualize
    return Math.sqrt(variance * this.tradingDaysPerYear);
  }

  /**
   * Calculate max drawdown and duration
   */
  private calculateDrawdown(equityHistory: EquityPoint[]): {
    maxDrawdown: number;
    maxDrawdownDuration: number;
  } {
    let peak = equityHistory[0].equity;
    let maxDrawdown = 0;
    let maxDuration = 0;

    let drawdownStart: Date | null = null;
    let currentDuration = 0;

    for (const point of equityHistory) {
      if (point.equity > peak) {
        peak = point.equity;
        drawdownStart = null;
        currentDuration = 0;
      } else {
        const drawdown = (peak - point.equity) / peak;
        if (drawdown > maxDrawdown) {
          maxDrawdown = drawdown;
        }

        if (!drawdownStart) {
          drawdownStart = point.timestamp;
        }
        currentDuration = (point.timestamp.getTime() - drawdownStart.getTime()) / (1000 * 60 * 60 * 24);
        if (currentDuration > maxDuration) {
          maxDuration = currentDuration;
        }
      }
    }

    return { maxDrawdown, maxDrawdownDuration: maxDuration };
  }

  /**
   * Calculate Sharpe ratio
   */
  private calculateSharpeRatio(dailyReturns: number[], volatility: number): number {
    if (volatility === 0 || dailyReturns.length === 0) return 0;

    const meanReturn = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const annualizedReturn = meanReturn * this.tradingDaysPerYear;
    const excessReturn = annualizedReturn - this.riskFreeRate;

    return excessReturn / volatility;
  }

  /**
   * Calculate Sortino ratio (downside deviation)
   */
  private calculateSortinoRatio(dailyReturns: number[]): number {
    if (dailyReturns.length < 2) return 0;

    const meanReturn = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const negativeReturns = dailyReturns.filter(r => r < 0);

    if (negativeReturns.length === 0) return Infinity;

    const downsideVariance = negativeReturns.reduce((sum, r) => sum + r * r, 0) / negativeReturns.length;
    const downsideDeviation = Math.sqrt(downsideVariance * this.tradingDaysPerYear);

    if (downsideDeviation === 0) return 0;

    const annualizedReturn = meanReturn * this.tradingDaysPerYear;
    const excessReturn = annualizedReturn - this.riskFreeRate;

    return excessReturn / downsideDeviation;
  }

  /**
   * Calculate trade-level metrics
   */
  private calculateTradeMetrics(trades: TradeRecord[]): {
    winRate: number;
    profitFactor: number;
    avgWin: number;
    avgLoss: number;
  } {
    if (trades.length === 0) {
      return { winRate: 0, profitFactor: 0, avgWin: 0, avgLoss: 0 };
    }

    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl < 0);

    const winRate = wins.length / trades.length;

    const totalWins = wins.reduce((sum, t) => sum + t.pnl, 0);
    const totalLosses = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));

    const profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0;

    const avgWin = wins.length > 0 ? totalWins / wins.length : 0;
    const avgLoss = losses.length > 0 ? totalLosses / losses.length : 0;

    return { winRate, profitFactor, avgWin, avgLoss };
  }

  /**
   * Generate daily performance breakdown
   */
  generateDailyPerformance(
    equityHistory: EquityPoint[],
    trades: TradeRecord[]
  ): DailyPerformance[] {
    const dailyEquity = this.groupByDay(equityHistory);
    const days = Array.from(dailyEquity.keys()).sort();

    const result: DailyPerformance[] = [];
    let peak = 0;

    for (let i = 0; i < days.length; i++) {
      const date = new Date(days[i]);
      const equity = dailyEquity.get(days[i])!;
      const prevEquity = i > 0 ? dailyEquity.get(days[i - 1])! : equity;

      peak = Math.max(peak, equity);
      const drawdown = peak > 0 ? (peak - equity) / peak : 0;

      // Count trades for this day
      const dayTrades = trades.filter(t => {
        const tradeDay = t.timestamp.toISOString().split('T')[0];
        return tradeDay === days[i];
      });

      const pnl = equity - prevEquity;
      const dailyReturn = prevEquity > 0 ? pnl / prevEquity : 0;

      result.push({
        date,
        equity,
        pnl,
        return: dailyReturn,
        trades: dayTrades.length,
        exposure: 0.5, // Placeholder
        drawdown,
      });
    }

    return result;
  }

  /**
   * Generate equity curve data for charting
   */
  generateEquityCurve(
    equityHistory: EquityPoint[],
    benchmarkHistory?: EquityPoint[]
  ): EquityCurveData {
    const points: ChartDataPoint[] = equityHistory.map(e => ({
      timestamp: e.timestamp,
      value: e.equity,
    }));

    const benchmark = benchmarkHistory?.map(e => ({
      timestamp: e.timestamp,
      value: e.equity,
    }));

    // Calculate drawdown periods
    const drawdowns: Array<{ start: Date; end: Date; depth: number }> = [];
    let peak = equityHistory[0]?.equity ?? 0;
    let drawdownStart: Date | null = null;
    let currentDepth = 0;

    for (const point of equityHistory) {
      if (point.equity >= peak) {
        if (drawdownStart && currentDepth > 0.01) {
          drawdowns.push({
            start: drawdownStart,
            end: point.timestamp,
            depth: currentDepth,
          });
        }
        peak = point.equity;
        drawdownStart = null;
        currentDepth = 0;
      } else {
        if (!drawdownStart) {
          drawdownStart = point.timestamp;
        }
        const depth = (peak - point.equity) / peak;
        currentDepth = Math.max(currentDepth, depth);
      }
    }

    return { points, benchmark, drawdowns };
  }

  /**
   * Generate trade distribution analysis
   */
  generateTradeDistribution(trades: TradeSummary[]): TradeDistribution {
    // P&L buckets
    const pnlBuckets = [
      { range: '< -$100', count: 0 },
      { range: '-$100 to -$50', count: 0 },
      { range: '-$50 to -$10', count: 0 },
      { range: '-$10 to $0', count: 0 },
      { range: '$0 to $10', count: 0 },
      { range: '$10 to $50', count: 0 },
      { range: '$50 to $100', count: 0 },
      { range: '> $100', count: 0 },
    ];

    for (const trade of trades) {
      const pnl = trade.pnl ?? 0;
      if (pnl < -100) pnlBuckets[0].count++;
      else if (pnl < -50) pnlBuckets[1].count++;
      else if (pnl < -10) pnlBuckets[2].count++;
      else if (pnl < 0) pnlBuckets[3].count++;
      else if (pnl < 10) pnlBuckets[4].count++;
      else if (pnl < 50) pnlBuckets[5].count++;
      else if (pnl < 100) pnlBuckets[6].count++;
      else pnlBuckets[7].count++;
    }

    // Holding period buckets
    const holdingPeriodBuckets = [
      { range: '< 1h', count: 0 },
      { range: '1-4h', count: 0 },
      { range: '4-12h', count: 0 },
      { range: '12-24h', count: 0 },
      { range: '1-3d', count: 0 },
      { range: '> 3d', count: 0 },
    ];

    // Hourly distribution (when trades occur)
    const hourlyDistribution = new Array(24).fill(0);

    // Daily distribution
    const dailyDistribution = new Array(7).fill(0);

    for (const trade of trades) {
      const hour = trade.timestamp.getHours();
      const day = trade.timestamp.getDay();
      hourlyDistribution[hour]++;
      dailyDistribution[day]++;
    }

    return {
      pnlBuckets,
      holdingPeriodBuckets,
      hourlyDistribution,
      dailyDistribution,
    };
  }

  /**
   * Compare multiple strategies
   */
  compareStrategies(strategies: StrategyPerformance[]): {
    comparison: Array<{
      strategyId: string;
      strategyName: string;
      totalReturn: number;
      sharpeRatio: number;
      maxDrawdown: number;
      winRate: number;
      totalTrades: number;
    }>;
    bestByReturn: string;
    bestBySharpe: string;
    bestByWinRate: string;
  } {
    const comparison = strategies.map(s => ({
      strategyId: s.strategyId,
      strategyName: s.strategyName,
      totalReturn: s.metrics.totalReturn,
      sharpeRatio: s.metrics.sharpeRatio,
      maxDrawdown: s.metrics.maxDrawdown,
      winRate: s.metrics.winRate,
      totalTrades: s.metrics.totalTrades,
    }));

    const bestByReturn = comparison.length > 0
      ? comparison.reduce((a, b) => a.totalReturn > b.totalReturn ? a : b).strategyId
      : '';

    const bestBySharpe = comparison.length > 0
      ? comparison.reduce((a, b) => a.sharpeRatio > b.sharpeRatio ? a : b).strategyId
      : '';

    const bestByWinRate = comparison.length > 0
      ? comparison.reduce((a, b) => a.winRate > b.winRate ? a : b).strategyId
      : '';

    return { comparison, bestByReturn, bestBySharpe, bestByWinRate };
  }

  /**
   * Return empty metrics
   */
  private emptyMetrics(): PerformanceMetrics {
    return {
      totalReturn: 0,
      annualizedReturn: 0,
      dailyReturns: [],
      cumulativeReturns: [],
      volatility: 0,
      sharpeRatio: 0,
      sortinoRatio: 0,
      maxDrawdown: 0,
      maxDrawdownDuration: 0,
      calmarRatio: 0,
      totalTrades: 0,
      winRate: 0,
      profitFactor: 0,
      avgWin: 0,
      avgLoss: 0,
      avgHoldingPeriod: 0,
      avgExposure: 0,
      maxExposure: 0,
      timeInMarket: 0,
    };
  }
}

export function createPerformanceAnalytics(options?: {
  riskFreeRate?: number;
  tradingDaysPerYear?: number;
}): PerformanceAnalytics {
  return new PerformanceAnalytics(options);
}
