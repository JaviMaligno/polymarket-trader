/**
 * Hawkes Process Signal
 *
 * Models self-exciting point processes for trade arrival prediction.
 * Trades tend to cluster - one trade often triggers more trades.
 * This signal predicts the probability of trade bursts and large moves.
 *
 * Mathematical model:
 * λ(t) = μ + Σ α * exp(-β * (t - t_i))
 *
 * Where:
 * - λ(t) is the intensity (probability rate) at time t
 * - μ is the base intensity
 * - α is the jump size (excitation)
 * - β is the decay rate
 * - t_i are past event times
 */

import { BaseSignal } from '../../core/base/BaseSignal.js';
import type {
  SignalOutput,
  SignalContext,
  SignalDirection,
  Trade,
} from '../../core/types/signal.types.js';

/**
 * Hawkes Signal Configuration
 */
export interface HawkesSignalConfig {
  /** Base intensity (μ) - baseline event rate */
  baseIntensity: number;
  /** Jump size (α) - how much each event increases intensity */
  alpha: number;
  /** Decay rate (β) - how quickly excitation decays */
  beta: number;
  /** Window size in milliseconds for analysis */
  windowMs: number;
  /** Minimum trades to analyze */
  minTrades: number;
  /** Threshold intensity for signal generation */
  intensityThreshold: number;
  /** Enable volume-weighted excitation */
  volumeWeighted: boolean;
  /** Separate buy/sell processes */
  separateSides: boolean;
  /** Enable online parameter estimation */
  enableOnlineLearning: boolean;
  /** Learning rate for parameter updates */
  learningRate: number;
}

/** Default Hawkes signal configuration */
export const DEFAULT_HAWKES_PARAMS: HawkesSignalConfig = {
  baseIntensity: 0.1,
  alpha: 0.5,
  beta: 1.0,
  windowMs: 5 * 60 * 1000, // 5 minutes
  minTrades: 10,
  intensityThreshold: 0.3,
  volumeWeighted: true,
  separateSides: true,
  enableOnlineLearning: true,
  learningRate: 0.01,
};

/**
 * Hawkes process event
 */
interface HawkesEvent {
  timestamp: number; // ms since epoch
  volume: number;
  side: 'BUY' | 'SELL';
  price: number;
}

/**
 * Hawkes process state
 */
interface HawkesState {
  intensity: number;
  buyIntensity: number;
  sellIntensity: number;
  lastUpdate: number;
  eventCount: number;
  avgVolume: number;
}

/**
 * Hawkes Signal
 *
 * Predicts trade arrival clustering using self-exciting point processes.
 */
export class HawkesSignal extends BaseSignal {
  readonly signalId = 'hawkes';
  readonly name = 'Hawkes Process';
  readonly description =
    'Self-exciting point process for trade arrival prediction and clustering detection';

  private config: HawkesSignalConfig;
  private events: HawkesEvent[];
  private state: HawkesState;

  // Learned parameters
  private learnedMu: number;
  private learnedAlpha: number;
  private learnedBeta: number;

  // History for learning
  private intensityHistory: Array<{ intensity: number; actual: number; timestamp: number }>;

  // Track last processed trade to avoid duplication
  private lastProcessedTradeTime: number = 0;

  constructor(config: Partial<HawkesSignalConfig> = {}) {
    super();
    this.config = { ...DEFAULT_HAWKES_PARAMS, ...config };
    this.events = [];
    this.state = {
      intensity: this.config.baseIntensity,
      buyIntensity: this.config.baseIntensity / 2,
      sellIntensity: this.config.baseIntensity / 2,
      lastUpdate: Date.now(),
      eventCount: 0,
      avgVolume: 100,
    };

    // Initialize learned parameters
    this.learnedMu = this.config.baseIntensity;
    this.learnedAlpha = this.config.alpha;
    this.learnedBeta = this.config.beta;

    this.intensityHistory = [];
  }

  /**
   * Get minimum price bars required
   */
  getRequiredLookback(): number {
    return 0; // Uses trades, not price bars
  }

  /**
   * Compute the Hawkes intensity at a given time
   */
  private computeIntensity(
    events: HawkesEvent[],
    currentTime: number,
    side?: 'BUY' | 'SELL'
  ): number {
    const mu = this.learnedMu;
    const alpha = this.learnedAlpha;
    const beta = this.learnedBeta;

    let intensity = mu;

    for (const event of events) {
      if (event.timestamp >= currentTime) continue;
      if (side && event.side !== side) continue;

      const dt = (currentTime - event.timestamp) / 1000; // Convert to seconds
      if (dt < 0) continue;

      // Exponential kernel
      let excitation = alpha * Math.exp(-beta * dt);

      // Volume weighting
      if (this.config.volumeWeighted && this.state.avgVolume > 0) {
        const volumeFactor = event.volume / this.state.avgVolume;
        excitation *= Math.sqrt(volumeFactor); // Square root dampening
      }

      intensity += excitation;
    }

    return intensity;
  }

  /**
   * Update events from trades
   * Only adds trades newer than lastProcessedTradeTime to avoid duplication
   */
  private updateEvents(trades: Trade[], currentTime: number): void {
    // Convert trades to Hawkes events, only adding new ones
    for (const trade of trades) {
      const tradeTime = trade.time.getTime();

      // Skip trades we've already processed
      if (tradeTime <= this.lastProcessedTradeTime) {
        continue;
      }

      const event: HawkesEvent = {
        timestamp: tradeTime,
        volume: trade.size,
        side: trade.side,
        price: trade.price,
      };
      this.events.push(event);

      // Update last processed time
      if (tradeTime > this.lastProcessedTradeTime) {
        this.lastProcessedTradeTime = tradeTime;
      }
    }

    // Remove old events outside window
    const cutoff = currentTime - this.config.windowMs;
    this.events = this.events.filter((e) => e.timestamp > cutoff);

    // Update average volume
    if (this.events.length > 0) {
      const totalVolume = this.events.reduce((sum, e) => sum + e.volume, 0);
      this.state.avgVolume = totalVolume / this.events.length;
    }

    this.state.eventCount = this.events.length;
  }

  /**
   * Update state
   */
  private updateState(currentTime: number): void {
    this.state.intensity = this.computeIntensity(this.events, currentTime);

    if (this.config.separateSides) {
      this.state.buyIntensity = this.computeIntensity(this.events, currentTime, 'BUY');
      this.state.sellIntensity = this.computeIntensity(this.events, currentTime, 'SELL');
    }

    this.state.lastUpdate = currentTime;
  }

  /**
   * Online parameter estimation using MLE approximation
   */
  private updateParameters(): void {
    if (!this.config.enableOnlineLearning) return;
    if (this.events.length < this.config.minTrades * 2) return;

    // Simple gradient-based update
    // We want to maximize log-likelihood:
    // L = Σ log(λ(t_i)) - ∫λ(t)dt

    const n = this.events.length;
    const T = (this.events[n - 1].timestamp - this.events[0].timestamp) / 1000;
    if (T <= 0) return;

    // Estimate mu from event rate
    const empiricalRate = n / T;

    // Calculate branching ratio estimate (α/β)
    let sumExcitation = 0;
    for (let i = 1; i < n; i++) {
      const dt = (this.events[i].timestamp - this.events[i - 1].timestamp) / 1000;
      if (dt > 0 && dt < 60) {
        // Only consider events within 60 seconds
        sumExcitation += Math.exp(-this.learnedBeta * dt);
      }
    }
    const avgExcitation = sumExcitation / (n - 1);

    // Update parameters with momentum
    const lr = this.config.learningRate;

    // Mu update: empirical rate minus excitation contribution
    const targetMu = Math.max(0.01, empiricalRate * (1 - avgExcitation * this.learnedAlpha));
    this.learnedMu = this.learnedMu * (1 - lr) + targetMu * lr;

    // Beta update: based on average time between correlated events
    // Update beta FIRST so we can constrain alpha relative to it
    if (avgExcitation > 0.1) {
      const avgInterarrival =
        this.events.slice(1).reduce((sum, e, i) => {
          return sum + (e.timestamp - this.events[i].timestamp);
        }, 0) /
        (n - 1);
      const targetBeta = Math.min(10, Math.max(0.1, 1000 / avgInterarrival)); // Convert from ms
      this.learnedBeta = this.learnedBeta * (1 - lr) + targetBeta * lr;
    }

    // Alpha update: based on autocorrelation of events
    // CRITICAL: Constrain alpha < beta * 0.9 to ensure branching ratio < 0.9 (stable process)
    const maxAlpha = this.learnedBeta * 0.9; // Ensures branching ratio < 0.9
    const targetAlpha = Math.min(maxAlpha, Math.max(0.1, avgExcitation));
    this.learnedAlpha = this.learnedAlpha * (1 - lr) + targetAlpha * lr;

    // Final safety check: enforce stability constraint
    if (this.learnedAlpha >= this.learnedBeta) {
      this.learnedAlpha = this.learnedBeta * 0.9;
    }
  }

  /**
   * Compute signal
   */
  async compute(context: SignalContext): Promise<SignalOutput | null> {
    const currentTime = context.currentTime.getTime();
    const params = this.getParameters() as Partial<HawkesSignalConfig>;
    const config = { ...this.config, ...params };

    // Update events from recent trades
    if (context.recentTrades && context.recentTrades.length > 0) {
      this.updateEvents(context.recentTrades, currentTime);
    }

    // Need minimum trades
    if (this.events.length < config.minTrades) {
      return null;
    }

    // Update state
    this.updateState(currentTime);

    // Online parameter update
    this.updateParameters();

    // Calculate signal based on intensity
    const intensity = this.state.intensity;
    const baseIntensity = this.learnedMu;

    // Intensity ratio shows how "excited" the market is
    const excitationRatio = intensity / Math.max(baseIntensity, 0.01);

    // Buy/sell imbalance from separate intensities
    let sideImbalance = 0;
    if (config.separateSides) {
      const totalSideIntensity = this.state.buyIntensity + this.state.sellIntensity;
      if (totalSideIntensity > 0) {
        sideImbalance =
          (this.state.buyIntensity - this.state.sellIntensity) / totalSideIntensity;
      }
    }

    // Predict if trade burst is coming
    const burstProbability = 1 - Math.exp(-intensity * 0.1); // Next 100ms

    // Determine signal direction and strength
    let direction: SignalDirection;
    let strength: number;
    let confidence: number;

    if (excitationRatio > 2 && Math.abs(sideImbalance) > 0.3) {
      // High excitation with side imbalance - momentum signal
      direction = sideImbalance > 0 ? 'LONG' : 'SHORT';
      strength = Math.min(1, Math.abs(sideImbalance) * (excitationRatio - 1));
      confidence = Math.min(0.9, burstProbability * 0.7 + 0.3);
    } else if (excitationRatio > 3) {
      // Very high excitation without clear direction - volatility spike expected
      // In prediction markets near resolution, this often precedes moves
      direction = 'NEUTRAL';
      strength = 0;
      confidence = Math.min(0.8, (excitationRatio - 3) * 0.2 + 0.4);
    } else if (excitationRatio < 0.5) {
      // Low activity - market is quiet
      direction = 'NEUTRAL';
      strength = 0;
      confidence = 0.3;
    } else {
      // Normal activity
      if (Math.abs(sideImbalance) > 0.2) {
        direction = sideImbalance > 0 ? 'LONG' : 'SHORT';
        strength = Math.abs(sideImbalance) * 0.5;
        confidence = 0.4;
      } else {
        direction = 'NEUTRAL';
        strength = 0;
        confidence = 0.3;
      }
    }

    // Check threshold
    if (intensity < config.intensityThreshold && Math.abs(strength) < 0.1) {
      return null;
    }

    // Store for history
    this.intensityHistory.push({
      intensity,
      actual: this.events.length > 0 ? 1 : 0,
      timestamp: currentTime,
    });

    // Keep history bounded
    if (this.intensityHistory.length > 1000) {
      this.intensityHistory.shift();
    }

    return {
      signalId: this.signalId,
      marketId: context.market.id,
      tokenId: context.market.tokenIdYes,
      direction,
      strength,
      confidence,
      timestamp: context.currentTime,
      ttlMs: this.defaultTtlMs,
      metadata: {
        intensity,
        excitationRatio,
        sideImbalance,
        burstProbability,
        eventCount: this.events.length,
        learnedMu: this.learnedMu,
        learnedAlpha: this.learnedAlpha,
        learnedBeta: this.learnedBeta,
        buyIntensity: this.state.buyIntensity,
        sellIntensity: this.state.sellIntensity,
      },
    };
  }

  /**
   * Predict intensity for next time period
   */
  predictIntensity(horizonMs: number = 1000): number {
    const currentTime = Date.now();
    const futureTime = currentTime + horizonMs;

    // Intensity decays over time
    let predictedIntensity = this.learnedMu;

    for (const event of this.events) {
      const dt = (futureTime - event.timestamp) / 1000;
      if (dt > 0) {
        predictedIntensity += this.learnedAlpha * Math.exp(-this.learnedBeta * dt);
      }
    }

    return predictedIntensity;
  }

  /**
   * Estimate probability of N events in next T milliseconds
   * Uses log-space computation to prevent overflow
   */
  predictEventProbability(n: number, horizonMs: number): number {
    // Validate input
    if (n < 0 || !Number.isInteger(n)) return 0;
    if (n > 170) {
      // For very large n, probability is effectively 0
      return 0;
    }

    const avgIntensity = (this.state.intensity + this.predictIntensity(horizonMs)) / 2;
    const lambda = avgIntensity * (horizonMs / 1000);

    if (lambda <= 0) return n === 0 ? 1 : 0;

    // Use log-space to prevent overflow: log(P) = n*log(λ) - λ - log(n!)
    const logProb = n * Math.log(lambda) - lambda - this.logFactorial(n);

    // Convert back, clamping to prevent underflow
    return Math.exp(Math.max(-700, logProb)); // exp(-700) ≈ 0
  }

  /**
   * Compute log(n!) using Stirling's approximation for large n
   */
  private logFactorial(n: number): number {
    if (n <= 1) return 0;
    if (n <= 20) {
      // Direct computation for small n
      let result = 0;
      for (let i = 2; i <= n; i++) {
        result += Math.log(i);
      }
      return result;
    }
    // Stirling's approximation: log(n!) ≈ n*log(n) - n + 0.5*log(2πn)
    return n * Math.log(n) - n + 0.5 * Math.log(2 * Math.PI * n);
  }

  /**
   * Get current state
   */
  getState(): HawkesState {
    return { ...this.state };
  }

  /**
   * Get learned parameters
   */
  getLearnedParameters(): { mu: number; alpha: number; beta: number } {
    return {
      mu: this.learnedMu,
      alpha: this.learnedAlpha,
      beta: this.learnedBeta,
    };
  }

  /**
   * Calculate branching ratio (should be < 1 for stability)
   */
  getBranchingRatio(): number {
    return this.learnedAlpha / this.learnedBeta;
  }

  /**
   * Get model fitness statistics
   */
  getModelStats(): {
    branchingRatio: number;
    isStable: boolean;
    avgIntensity: number;
    eventRate: number;
  } {
    const branchingRatio = this.getBranchingRatio();
    const windowSeconds = this.config.windowMs / 1000;
    const eventRate = this.events.length / windowSeconds;

    return {
      branchingRatio,
      isStable: branchingRatio < 1,
      avgIntensity: this.state.intensity,
      eventRate,
    };
  }

  /**
   * Reset the signal
   */
  reset(): void {
    this.events = [];
    this.state = {
      intensity: this.config.baseIntensity,
      buyIntensity: this.config.baseIntensity / 2,
      sellIntensity: this.config.baseIntensity / 2,
      lastUpdate: Date.now(),
      eventCount: 0,
      avgVolume: 100,
    };
    this.learnedMu = this.config.baseIntensity;
    this.learnedAlpha = this.config.alpha;
    this.learnedBeta = this.config.beta;
    this.intensityHistory = [];
    this.lastProcessedTradeTime = 0;
  }
}
