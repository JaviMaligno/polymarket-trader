import type {
  PerformanceMetrics,
  TradeRecord,
  PortfolioSnapshot,
} from '../types/index.js';

/**
 * PerformanceCalculator - Calculates standard trading performance metrics
 */
export class PerformanceCalculator {
  /**
   * Calculate all performance metrics
   */
  static calculate(
    trades: TradeRecord[],
    equityCurve: PortfolioSnapshot[],
    initialCapital: number
  ): PerformanceMetrics {
    const returns = this.calculateReturns(equityCurve);

    return {
      totalReturn: this.calculateTotalReturn(equityCurve, initialCapital),
      annualizedReturn: this.calculateAnnualizedReturn(equityCurve, initialCapital),
      sharpeRatio: this.calculateSharpeRatio(returns),
      sortinoRatio: this.calculateSortinoRatio(returns),
      maxDrawdown: this.calculateMaxDrawdown(equityCurve),
      maxDrawdownDuration: this.calculateMaxDrawdownDuration(equityCurve),
      calmarRatio: this.calculateCalmarRatio(equityCurve, initialCapital),
      winRate: this.calculateWinRate(trades),
      profitFactor: this.calculateProfitFactor(trades),
      avgTradeReturn: this.calculateAvgTradeReturn(trades),
      avgWin: this.calculateAvgWin(trades),
      avgLoss: this.calculateAvgLoss(trades),
      expectancy: this.calculateExpectancy(trades),
      totalTrades: trades.length,
      avgHoldingPeriod: this.calculateAvgHoldingPeriod(trades),
      kellyFraction: this.calculateKellyFraction(trades),
    };
  }

  /**
   * Calculate period returns from equity curve
   */
  static calculateReturns(equityCurve: PortfolioSnapshot[]): number[] {
    const returns: number[] = [];
    for (let i = 1; i < equityCurve.length; i++) {
      const prevValue = equityCurve[i - 1].totalValue;
      const currValue = equityCurve[i].totalValue;
      if (prevValue > 0) {
        returns.push((currValue - prevValue) / prevValue);
      }
    }
    return returns;
  }

  /**
   * Calculate total return
   */
  static calculateTotalReturn(
    equityCurve: PortfolioSnapshot[],
    initialCapital: number
  ): number {
    if (equityCurve.length === 0) return 0;

    const finalValue = equityCurve[equityCurve.length - 1].totalValue;
    return (finalValue - initialCapital) / initialCapital;
  }

  /**
   * Calculate annualized return
   */
  static calculateAnnualizedReturn(
    equityCurve: PortfolioSnapshot[],
    initialCapital: number
  ): number {
    if (equityCurve.length < 2) return 0;

    const totalReturn = this.calculateTotalReturn(equityCurve, initialCapital);
    const startTime = equityCurve[0].timestamp.getTime();
    const endTime = equityCurve[equityCurve.length - 1].timestamp.getTime();
    const days = Math.max(1, (endTime - startTime) / (1000 * 60 * 60 * 24));

    return Math.pow(1 + totalReturn, 365 / days) - 1;
  }

  /**
   * Calculate Sharpe ratio (assuming 0 risk-free rate)
   */
  static calculateSharpeRatio(returns: number[]): number {
    if (returns.length === 0) return 0;

    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return 0;

    // Annualize: multiply by sqrt(252) for daily returns
    return (avgReturn * Math.sqrt(252)) / (stdDev * Math.sqrt(252));
  }

  /**
   * Calculate Sortino ratio (downside risk only)
   */
  static calculateSortinoRatio(returns: number[]): number {
    if (returns.length === 0) return 0;

    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const negativeReturns = returns.filter(r => r < 0);

    if (negativeReturns.length === 0) {
      return avgReturn > 0 ? Infinity : 0;
    }

    const downsideVariance = negativeReturns.reduce((sum, r) => sum + r * r, 0) / negativeReturns.length;
    const downsideDev = Math.sqrt(downsideVariance);

    if (downsideDev === 0) return 0;

    return (avgReturn * Math.sqrt(252)) / (downsideDev * Math.sqrt(252));
  }

  /**
   * Calculate maximum drawdown
   */
  static calculateMaxDrawdown(equityCurve: PortfolioSnapshot[]): number {
    if (equityCurve.length === 0) return 0;

    let maxDrawdown = 0;
    let peak = equityCurve[0].totalValue;

    for (const snapshot of equityCurve) {
      if (snapshot.totalValue > peak) {
        peak = snapshot.totalValue;
      }
      const drawdown = (peak - snapshot.totalValue) / peak;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }

    return maxDrawdown;
  }

  /**
   * Calculate maximum drawdown duration in days
   */
  static calculateMaxDrawdownDuration(equityCurve: PortfolioSnapshot[]): number {
    if (equityCurve.length === 0) return 0;

    let maxDuration = 0;
    let peak = equityCurve[0].totalValue;
    let peakIndex = 0;

    for (let i = 0; i < equityCurve.length; i++) {
      if (equityCurve[i].totalValue > peak) {
        peak = equityCurve[i].totalValue;
        peakIndex = i;
      } else {
        const duration = i - peakIndex;
        if (duration > maxDuration) {
          maxDuration = duration;
        }
      }
    }

    return maxDuration;
  }

  /**
   * Calculate Calmar ratio (annualized return / max drawdown)
   */
  static calculateCalmarRatio(
    equityCurve: PortfolioSnapshot[],
    initialCapital: number
  ): number {
    const annualizedReturn = this.calculateAnnualizedReturn(equityCurve, initialCapital);
    const maxDrawdown = this.calculateMaxDrawdown(equityCurve);

    if (maxDrawdown === 0) return annualizedReturn > 0 ? Infinity : 0;

    return annualizedReturn / maxDrawdown;
  }

  /**
   * Calculate win rate
   */
  static calculateWinRate(trades: TradeRecord[]): number {
    if (trades.length === 0) return 0;

    const winningTrades = trades.filter(t => t.pnl > 0);
    return winningTrades.length / trades.length;
  }

  /**
   * Calculate profit factor (gross profit / gross loss)
   */
  static calculateProfitFactor(trades: TradeRecord[]): number {
    const winningTrades = trades.filter(t => t.pnl > 0);
    const losingTrades = trades.filter(t => t.pnl < 0);

    const grossProfit = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
    const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0));

    if (grossLoss === 0) return grossProfit > 0 ? Infinity : 0;

    return grossProfit / grossLoss;
  }

  /**
   * Calculate average trade return
   */
  static calculateAvgTradeReturn(trades: TradeRecord[]): number {
    if (trades.length === 0) return 0;

    return trades.reduce((sum, t) => sum + t.pnlPct, 0) / trades.length;
  }

  /**
   * Calculate average winning trade
   */
  static calculateAvgWin(trades: TradeRecord[]): number {
    const winningTrades = trades.filter(t => t.pnl > 0);
    if (winningTrades.length === 0) return 0;

    return winningTrades.reduce((sum, t) => sum + t.pnlPct, 0) / winningTrades.length;
  }

  /**
   * Calculate average losing trade
   */
  static calculateAvgLoss(trades: TradeRecord[]): number {
    const losingTrades = trades.filter(t => t.pnl < 0);
    if (losingTrades.length === 0) return 0;

    return Math.abs(losingTrades.reduce((sum, t) => sum + t.pnlPct, 0) / losingTrades.length);
  }

  /**
   * Calculate expectancy per trade
   */
  static calculateExpectancy(trades: TradeRecord[]): number {
    const winRate = this.calculateWinRate(trades);
    const avgWin = this.calculateAvgWin(trades);
    const avgLoss = this.calculateAvgLoss(trades);

    return winRate * avgWin - (1 - winRate) * avgLoss;
  }

  /**
   * Calculate average holding period in hours
   */
  static calculateAvgHoldingPeriod(trades: TradeRecord[]): number {
    if (trades.length === 0) return 0;

    const totalMs = trades.reduce((sum, t) => sum + t.holdingPeriodMs, 0);
    return totalMs / trades.length / (1000 * 60 * 60); // Convert to hours
  }

  /**
   * Calculate Kelly fraction for optimal bet sizing
   */
  static calculateKellyFraction(trades: TradeRecord[]): number {
    const winRate = this.calculateWinRate(trades);
    const avgWin = this.calculateAvgWin(trades);
    const avgLoss = this.calculateAvgLoss(trades);

    if (avgLoss === 0) return 0;

    const winLossRatio = avgWin / avgLoss;
    const kelly = winRate - (1 - winRate) / winLossRatio;

    // Clamp to reasonable range
    return Math.max(0, Math.min(1, kelly));
  }

  /**
   * Calculate rolling Sharpe ratio
   */
  static calculateRollingSharpe(
    returns: number[],
    window: number
  ): number[] {
    const rollingSharpe: number[] = [];

    for (let i = window; i <= returns.length; i++) {
      const windowReturns = returns.slice(i - window, i);
      rollingSharpe.push(this.calculateSharpeRatio(windowReturns));
    }

    return rollingSharpe;
  }

  /**
   * Calculate Value at Risk (VaR) at given confidence level
   */
  static calculateVaR(returns: number[], confidenceLevel: number = 0.95): number {
    if (returns.length === 0) return 0;

    const sorted = [...returns].sort((a, b) => a - b);
    const index = Math.floor((1 - confidenceLevel) * sorted.length);

    return Math.abs(sorted[index] || 0);
  }

  /**
   * Calculate Conditional VaR (Expected Shortfall)
   */
  static calculateCVaR(returns: number[], confidenceLevel: number = 0.95): number {
    if (returns.length === 0) return 0;

    const sorted = [...returns].sort((a, b) => a - b);
    const cutoffIndex = Math.floor((1 - confidenceLevel) * sorted.length);
    const tail = sorted.slice(0, cutoffIndex + 1);

    if (tail.length === 0) return 0;

    return Math.abs(tail.reduce((a, b) => a + b, 0) / tail.length);
  }
}
