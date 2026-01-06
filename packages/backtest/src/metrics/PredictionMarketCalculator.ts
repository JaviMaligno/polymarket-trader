import type { PredictionMarketMetrics, TradeRecord } from '../types/index.js';

interface CalibrationPoint {
  predicted: number;
  actual: number;
  count: number;
}

/**
 * PredictionMarketCalculator - Calculates prediction market specific metrics
 *
 * These metrics measure how well predictions align with actual outcomes,
 * which is crucial for prediction market trading.
 */
export class PredictionMarketCalculator {
  /**
   * Calculate all prediction market metrics
   */
  static calculate(trades: TradeRecord[]): PredictionMarketMetrics {
    const resolvedTrades = trades.filter(t => t.marketResolved);

    return {
      brierScore: this.calculateBrierScore(resolvedTrades),
      logLoss: this.calculateLogLoss(resolvedTrades),
      calibrationError: this.calculateCalibrationError(resolvedTrades),
      resolutionRate: this.calculateResolutionRate(trades),
      resolutionAccuracy: this.calculateResolutionAccuracy(resolvedTrades),
      avgConfidenceWhenCorrect: this.calculateAvgConfidenceWhenCorrect(resolvedTrades),
      avgConfidenceWhenWrong: this.calculateAvgConfidenceWhenWrong(resolvedTrades),
      calibrationCurve: this.calculateCalibrationCurve(resolvedTrades),
    };
  }

  /**
   * Calculate Brier score
   *
   * Measures the accuracy of probabilistic predictions.
   * Range: 0 (perfect) to 1 (worst)
   * Lower is better.
   */
  static calculateBrierScore(trades: TradeRecord[]): number {
    if (trades.length === 0) return 0;

    let brierSum = 0;

    for (const trade of trades) {
      const predicted = this.getPredictedProbability(trade);
      const actual = this.getActualOutcome(trade);
      brierSum += Math.pow(predicted - actual, 2);
    }

    return brierSum / trades.length;
  }

  /**
   * Calculate log loss (cross-entropy loss)
   *
   * Heavily penalizes confident but wrong predictions.
   * Range: 0 (perfect) to infinity
   * Lower is better.
   */
  static calculateLogLoss(trades: TradeRecord[]): number {
    if (trades.length === 0) return 0;

    const epsilon = 1e-15; // Prevent log(0)
    let logLossSum = 0;

    for (const trade of trades) {
      const predicted = Math.max(epsilon, Math.min(1 - epsilon, this.getPredictedProbability(trade)));
      const actual = this.getActualOutcome(trade);

      logLossSum += -(actual * Math.log(predicted) + (1 - actual) * Math.log(1 - predicted));
    }

    return logLossSum / trades.length;
  }

  /**
   * Calculate calibration error
   *
   * Measures how well predicted probabilities match actual frequencies.
   * Range: 0 (perfectly calibrated) to 1
   * Lower is better.
   */
  static calculateCalibrationError(trades: TradeRecord[]): number {
    const curve = this.calculateCalibrationCurve(trades);

    if (curve.length === 0) return 0;

    let errorSum = 0;
    let totalCount = 0;

    for (const point of curve) {
      errorSum += point.count * Math.abs(point.predicted - point.actual);
      totalCount += point.count;
    }

    return totalCount > 0 ? errorSum / totalCount : 0;
  }

  /**
   * Calculate resolution rate
   *
   * What percentage of trades were on markets that resolved
   * (as opposed to exiting before resolution).
   */
  static calculateResolutionRate(trades: TradeRecord[]): number {
    if (trades.length === 0) return 0;

    const resolved = trades.filter(t => t.marketResolved);
    return resolved.length / trades.length;
  }

  /**
   * Calculate resolution accuracy
   *
   * When trades were held to resolution, how often was the prediction correct?
   */
  static calculateResolutionAccuracy(resolvedTrades: TradeRecord[]): number {
    if (resolvedTrades.length === 0) return 0;

    let correct = 0;

    for (const trade of resolvedTrades) {
      if (this.wasCorrect(trade)) {
        correct++;
      }
    }

    return correct / resolvedTrades.length;
  }

  /**
   * Calculate average confidence when prediction was correct
   */
  static calculateAvgConfidenceWhenCorrect(resolvedTrades: TradeRecord[]): number {
    const correctTrades = resolvedTrades.filter(t => this.wasCorrect(t));

    if (correctTrades.length === 0) return 0;

    const confidenceSum = correctTrades.reduce((sum, t) => {
      return sum + this.getPredictedProbability(t);
    }, 0);

    return confidenceSum / correctTrades.length;
  }

  /**
   * Calculate average confidence when prediction was wrong
   */
  static calculateAvgConfidenceWhenWrong(resolvedTrades: TradeRecord[]): number {
    const wrongTrades = resolvedTrades.filter(t => !this.wasCorrect(t));

    if (wrongTrades.length === 0) return 0;

    const confidenceSum = wrongTrades.reduce((sum, t) => {
      return sum + this.getPredictedProbability(t);
    }, 0);

    return confidenceSum / wrongTrades.length;
  }

  /**
   * Calculate calibration curve
   *
   * Groups predictions into buckets and compares predicted vs actual frequencies.
   */
  static calculateCalibrationCurve(resolvedTrades: TradeRecord[]): CalibrationPoint[] {
    const numBuckets = 10;
    const buckets: { predicted: number; outcomes: number[]; count: number }[] = [];

    // Initialize buckets
    for (let i = 0; i < numBuckets; i++) {
      buckets.push({
        predicted: (i + 0.5) / numBuckets,
        outcomes: [],
        count: 0,
      });
    }

    // Assign trades to buckets
    for (const trade of resolvedTrades) {
      const predicted = this.getPredictedProbability(trade);
      const actual = this.getActualOutcome(trade);
      const bucketIdx = Math.min(numBuckets - 1, Math.floor(predicted * numBuckets));

      buckets[bucketIdx].outcomes.push(actual);
      buckets[bucketIdx].count++;
    }

    // Calculate actual frequency for each bucket
    return buckets
      .filter(b => b.count > 0)
      .map(b => ({
        predicted: b.predicted,
        actual: b.outcomes.reduce((a, c) => a + c, 0) / b.count,
        count: b.count,
      }));
  }

  /**
   * Calculate overconfidence metric
   *
   * Positive means overconfident (predicted > actual when high confidence)
   * Negative means underconfident
   */
  static calculateOverconfidence(resolvedTrades: TradeRecord[]): number {
    const curve = this.calculateCalibrationCurve(resolvedTrades);

    if (curve.length === 0) return 0;

    let overconfidenceSum = 0;
    let totalCount = 0;

    for (const point of curve) {
      // Only consider high-confidence predictions
      if (point.predicted > 0.6) {
        overconfidenceSum += point.count * (point.predicted - point.actual);
        totalCount += point.count;
      }
    }

    return totalCount > 0 ? overconfidenceSum / totalCount : 0;
  }

  /**
   * Calculate edge (alpha) from predictions
   *
   * Measures expected profit per dollar wagered based on prediction accuracy.
   */
  static calculateEdge(resolvedTrades: TradeRecord[]): number {
    if (resolvedTrades.length === 0) return 0;

    let totalWagered = 0;
    let totalReturn = 0;

    for (const trade of resolvedTrades) {
      const wager = trade.size * trade.entryPrice;
      const payout = this.wasCorrect(trade)
        ? trade.size * 1 // Full payout for correct prediction
        : 0;

      totalWagered += wager;
      totalReturn += payout;
    }

    return totalWagered > 0 ? (totalReturn - totalWagered) / totalWagered : 0;
  }

  /**
   * Calculate information ratio
   *
   * Measures how much information the predictions provide vs random chance.
   */
  static calculateInformationRatio(resolvedTrades: TradeRecord[]): number {
    if (resolvedTrades.length === 0) return 0;

    const brierScore = this.calculateBrierScore(resolvedTrades);

    // Reference: Brier score for random predictions on balanced outcomes = 0.25
    const referenceBrier = 0.25;

    return 1 - brierScore / referenceBrier;
  }

  // ==================== Helper Methods ====================

  /**
   * Get predicted probability from trade
   *
   * For LONG trades, entry price represents confidence in YES outcome.
   * For SHORT trades, entry price represents confidence in NO outcome.
   */
  private static getPredictedProbability(trade: TradeRecord): number {
    if (trade.side === 'LONG') {
      return trade.entryPrice;
    } else {
      return 1 - trade.entryPrice;
    }
  }

  /**
   * Get actual outcome (1 for YES, 0 for NO)
   */
  private static getActualOutcome(trade: TradeRecord): number {
    return trade.resolutionOutcome === 'YES' ? 1 : 0;
  }

  /**
   * Check if prediction was correct
   */
  private static wasCorrect(trade: TradeRecord): boolean {
    if (trade.side === 'LONG') {
      return trade.resolutionOutcome === 'YES';
    } else {
      return trade.resolutionOutcome === 'NO';
    }
  }
}
