/**
 * Signal Learning Service
 *
 * Automatically adjusts signal weights based on historical performance.
 * Implements a simple adaptive learning algorithm with safety bounds.
 */

import { EventEmitter } from 'events';
import { isDatabaseConfigured, query } from '../database/index.js';
import {
  signalPredictionsRepo,
  signalWeightsRepo,
} from '../database/repositories.js';

export interface LearningConfig {
  enabled: boolean;
  evaluationIntervalMs: number;  // How often to evaluate (3600000 = 1 hour)
  lookbackDays: number;          // Days of history to consider (7)
  minPredictions: number;        // Minimum predictions to adjust weight (10)
  learningRate: number;          // How fast to adjust (0.1)
  minWeight: number;             // Minimum allowed weight (0.1)
  maxWeight: number;             // Maximum allowed weight (0.9)
  accuracyThreshold: number;     // Target accuracy (0.55)
  disableThreshold: number;      // Disable signal if accuracy below (0.4)
}

const DEFAULT_CONFIG: LearningConfig = {
  enabled: true,
  evaluationIntervalMs: 3600000,  // 1 hour
  lookbackDays: 7,
  minPredictions: 10,
  learningRate: 0.1,
  minWeight: 0.1,
  maxWeight: 0.9,
  accuracyThreshold: 0.55,
  disableThreshold: 0.4,
};

interface SignalPerformance {
  signalType: string;
  totalPredictions: number;
  correctPredictions: number;
  accuracy: number;
  avgPnl: number;
  currentWeight: number;
  recommendedWeight: number;
  shouldDisable: boolean;
}

export class SignalLearningService extends EventEmitter {
  private config: LearningConfig;
  private evaluationInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private lastEvaluation: Date | null = null;

  constructor(config?: Partial<LearningConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the learning service
   */
  start(): void {
    if (this.isRunning) {
      console.log('[SignalLearning] Already running');
      return;
    }

    if (!isDatabaseConfigured()) {
      console.warn('[SignalLearning] Database not configured - cannot start');
      return;
    }

    this.isRunning = true;
    console.log(`[SignalLearning] Started (interval: ${this.config.evaluationIntervalMs / 60000} min)`);

    // Run initial evaluation
    this.evaluate();

    // Schedule periodic evaluations
    this.evaluationInterval = setInterval(() => {
      this.evaluate();
    }, this.config.evaluationIntervalMs);

    this.emit('started');
  }

  /**
   * Stop the learning service
   */
  stop(): void {
    if (this.evaluationInterval) {
      clearInterval(this.evaluationInterval);
      this.evaluationInterval = null;
    }
    this.isRunning = false;
    console.log('[SignalLearning] Stopped');
    this.emit('stopped');
  }

  /**
   * Evaluate all signals and adjust weights
   */
  async evaluate(): Promise<{
    evaluated: number;
    adjusted: number;
    performances: SignalPerformance[];
  }> {
    if (!this.config.enabled || !isDatabaseConfigured()) {
      return { evaluated: 0, adjusted: 0, performances: [] };
    }

    console.log('[SignalLearning] Running evaluation...');
    this.lastEvaluation = new Date();

    try {
      // Get accuracy metrics for all signal types
      const accuracyMetrics = await signalPredictionsRepo.getAccuracyByType(this.config.lookbackDays);

      // Get current weights
      const currentWeights = await signalWeightsRepo.getAll();
      const weightsMap = new Map(currentWeights.map(w => [w.signal_type, w]));

      const performances: SignalPerformance[] = [];
      let adjusted = 0;

      for (const metric of accuracyMetrics) {
        const currentWeight = weightsMap.get(metric.signal_type);
        const weight = currentWeight ? Number(currentWeight.weight) : 0.5;

        // Calculate recommended weight based on accuracy
        const accuracy = metric.accuracy ?? 0.5;
        const avgPnl = metric.avg_pnl ?? 0;

        // Performance score combines accuracy and PnL
        const performanceScore = accuracy * 0.7 + Math.min(Math.max(avgPnl / 10 + 0.5, 0), 1) * 0.3;

        // Calculate new weight using exponential moving average
        let recommendedWeight = weight + this.config.learningRate * (performanceScore - 0.5);
        recommendedWeight = Math.max(this.config.minWeight, Math.min(this.config.maxWeight, recommendedWeight));

        const shouldDisable = accuracy < this.config.disableThreshold && metric.total >= this.config.minPredictions;

        const performance: SignalPerformance = {
          signalType: metric.signal_type,
          totalPredictions: metric.total,
          correctPredictions: metric.correct,
          accuracy,
          avgPnl,
          currentWeight: weight,
          recommendedWeight,
          shouldDisable,
        };
        performances.push(performance);

        // Only adjust if we have enough data
        if (metric.total >= this.config.minPredictions) {
          const weightChange = Math.abs(recommendedWeight - weight);

          // Only update if change is significant (> 0.01)
          if (weightChange > 0.01 || shouldDisable) {
            try {
              // Determine reason
              let reason: string;
              if (shouldDisable) {
                reason = `Disabled: accuracy ${(accuracy * 100).toFixed(1)}% below threshold`;
              } else if (recommendedWeight > weight) {
                reason = `Increased: accuracy ${(accuracy * 100).toFixed(1)}%, avg PnL ${avgPnl.toFixed(2)}%`;
              } else {
                reason = `Decreased: accuracy ${(accuracy * 100).toFixed(1)}%, avg PnL ${avgPnl.toFixed(2)}%`;
              }

              await signalWeightsRepo.update(metric.signal_type, recommendedWeight, reason);

              // Update is_enabled if should disable
              if (shouldDisable) {
                await query(
                  'UPDATE signal_weights SET is_enabled = false, updated_at = NOW() WHERE signal_type = $1',
                  [metric.signal_type]
                );
              }

              // Update accuracy metrics in signal_weights table
              await query(
                `UPDATE signal_weights SET
                  min_confidence = $1,
                  updated_at = NOW()
                WHERE signal_type = $2`,
                [shouldDisable ? 0.99 : 0.6, metric.signal_type]  // High min_confidence effectively disables
              );

              adjusted++;
              console.log(`[SignalLearning] ${metric.signal_type}: ${weight.toFixed(3)} -> ${recommendedWeight.toFixed(3)} (${reason})`);

              this.emit('weight:adjusted', {
                signalType: metric.signal_type,
                oldWeight: weight,
                newWeight: recommendedWeight,
                reason,
                performance,
              });

            } catch (error) {
              console.error(`[SignalLearning] Failed to update weight for ${metric.signal_type}:`, error);
            }
          }
        }
      }

      console.log(`[SignalLearning] Evaluation complete: ${performances.length} signals, ${adjusted} adjusted`);

      this.emit('evaluation:complete', {
        timestamp: new Date(),
        evaluated: performances.length,
        adjusted,
        performances,
      });

      return { evaluated: performances.length, adjusted, performances };

    } catch (error) {
      console.error('[SignalLearning] Evaluation failed:', error);
      this.emit('evaluation:error', error);
      return { evaluated: 0, adjusted: 0, performances: [] };
    }
  }

  /**
   * Resolve pending signal predictions based on current prices
   */
  async resolvePredictions(priceUpdates: Array<{
    marketId: string;
    currentPrice: number;
  }>): Promise<number> {
    if (!isDatabaseConfigured()) return 0;

    let resolved = 0;

    try {
      // Get unresolved predictions
      const unresolvedPredictions = await signalPredictionsRepo.getUnresolved(100);

      for (const prediction of unresolvedPredictions) {
        // Find price update for this market
        const priceUpdate = priceUpdates.find(p => p.marketId === prediction.market_id);
        if (!priceUpdate) continue;

        // Check if prediction is old enough to resolve (at least 1 hour old)
        const predictionAge = Date.now() - new Date(prediction.time).getTime();
        if (predictionAge < 3600000) continue;  // 1 hour minimum

        // Calculate P&L
        const entryPrice = Number(prediction.price_at_signal);
        const currentPrice = priceUpdate.currentPrice;
        const direction = prediction.direction;

        const pnlPct = direction === 'long'
          ? ((currentPrice - entryPrice) / entryPrice) * 100
          : ((entryPrice - currentPrice) / entryPrice) * 100;

        const wasCorrect = pnlPct > 0;

        try {
          await signalPredictionsRepo.resolve(prediction.id!, prediction.time, {
            price_at_resolution: currentPrice,
            was_correct: wasCorrect,
            pnl_pct: pnlPct,
          });
          resolved++;

          this.emit('prediction:resolved', {
            prediction,
            currentPrice,
            pnlPct,
            wasCorrect,
          });

        } catch (error) {
          console.error(`[SignalLearning] Failed to resolve prediction ${prediction.id}:`, error);
        }
      }

      if (resolved > 0) {
        console.log(`[SignalLearning] Resolved ${resolved} predictions`);
      }

    } catch (error) {
      console.error('[SignalLearning] Failed to resolve predictions:', error);
    }

    return resolved;
  }

  /**
   * Get current signal performance summary
   */
  async getPerformanceSummary(): Promise<SignalPerformance[]> {
    if (!isDatabaseConfigured()) return [];

    try {
      const accuracyMetrics = await signalPredictionsRepo.getAccuracyByType(this.config.lookbackDays);
      const currentWeights = await signalWeightsRepo.getAll();
      const weightsMap = new Map(currentWeights.map(w => [w.signal_type, w]));

      return accuracyMetrics.map(metric => {
        const currentWeight = weightsMap.get(metric.signal_type);
        const weight = currentWeight ? Number(currentWeight.weight) : 0.5;
        const accuracy = metric.accuracy ?? 0.5;

        return {
          signalType: metric.signal_type,
          totalPredictions: metric.total,
          correctPredictions: metric.correct,
          accuracy,
          avgPnl: metric.avg_pnl ?? 0,
          currentWeight: weight,
          recommendedWeight: weight,  // Not calculated here
          shouldDisable: accuracy < this.config.disableThreshold,
        };
      });
    } catch (error) {
      console.error('[SignalLearning] Failed to get performance summary:', error);
      return [];
    }
  }

  /**
   * Get learning service status
   */
  getStatus(): {
    isRunning: boolean;
    lastEvaluation: Date | null;
    config: LearningConfig;
  } {
    return {
      isRunning: this.isRunning,
      lastEvaluation: this.lastEvaluation,
      config: { ...this.config },
    };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<LearningConfig>): void {
    this.config = { ...this.config, ...updates };

    // Restart if interval changed
    if (this.isRunning && updates.evaluationIntervalMs) {
      this.stop();
      this.start();
    }

    this.emit('config:updated', this.config);
  }

  /**
   * Force an immediate evaluation
   */
  async forceEvaluate(): Promise<ReturnType<typeof this.evaluate>> {
    return this.evaluate();
  }
}

// Singleton instance
let signalLearningService: SignalLearningService | null = null;

export function getSignalLearningService(): SignalLearningService {
  if (!signalLearningService) {
    signalLearningService = new SignalLearningService();
  }
  return signalLearningService;
}

export function initializeSignalLearningService(config?: Partial<LearningConfig>): SignalLearningService {
  signalLearningService = new SignalLearningService(config);
  return signalLearningService;
}
