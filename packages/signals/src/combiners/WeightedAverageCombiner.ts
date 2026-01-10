import { pino, Logger } from 'pino';
import type {
  SignalOutput,
  CombinedSignalOutput,
  ISignalCombiner,
  SignalDirection,
} from '../core/types/signal.types.js';

interface WeightedAverageParams {
  /** Minimum confidence to include signal */
  minConfidence: number;
  /** Whether to normalize weights to sum to 1 */
  normalizeWeights: boolean;
  /** Minimum combined confidence to emit signal */
  minCombinedConfidence: number;
  /** Minimum absolute strength to emit signal */
  minCombinedStrength: number;
  /** How to handle conflicting signals */
  conflictResolution: 'weighted' | 'strongest' | 'majority';
  /** Decay factor for older signals */
  timeDecayFactor: number;
  /** Maximum age of signal in ms before full decay */
  maxSignalAgeMs: number;
}

/**
 * Weighted Average Combiner
 *
 * Combines multiple trading signals into a single signal using weighted averaging.
 * Features:
 * - Configurable weights per signal type
 * - Confidence-weighted combination
 * - Time decay for stale signals
 * - Conflict resolution strategies
 * - Adaptive weight adjustments
 */
export class WeightedAverageCombiner implements ISignalCombiner {
  private logger: Logger;
  private weights: Record<string, number> = {};
  private parameters: WeightedAverageParams;

  constructor(
    initialWeights: Record<string, number> = {},
    params: Partial<WeightedAverageParams> = {}
  ) {
    this.logger = pino({ name: 'weighted-average-combiner' });
    this.weights = { ...initialWeights };
    this.parameters = {
      minConfidence: 0.2,
      normalizeWeights: true,
      minCombinedConfidence: 0.2,   // Optimized for SHORT strategy
      minCombinedStrength: 0.3,     // Optimized: filters weak signals
      conflictResolution: 'weighted',
      timeDecayFactor: 0.9,
      maxSignalAgeMs: 5 * 60 * 1000, // 5 minutes
      ...params,
    };
  }

  /**
   * Combine multiple signals into one
   * @param signals Array of signals to combine
   * @param currentTime Optional current time for backtesting (defaults to wall-clock time)
   */
  combine(signals: SignalOutput[], currentTime?: Date): CombinedSignalOutput | null {
    if (signals.length === 0) {
      return null;
    }

    const params = this.parameters;
    const now = currentTime ?? new Date();

    // Filter and prepare signals - exclude null/NaN strength values
    const validSignals = signals
      .filter(s => {
        // Must have valid confidence
        if (s.confidence < params.minConfidence) return false;
        // Must have valid numeric strength (not null, undefined, or NaN)
        if (s.strength == null || Number.isNaN(s.strength)) {
          this.logger.debug(
            { signalId: s.signalId, strength: s.strength },
            'Filtering signal with invalid strength'
          );
          return false;
        }
        return true;
      })
      .map(s => ({
        signal: s,
        weight: this.getSignalWeight(s, now),
        timeDecay: this.calculateTimeDecay(s, now),
      }))
      .filter(s => s.weight > 0 && s.timeDecay > 0);

    if (validSignals.length === 0) {
      return null;
    }

    // Resolve conflicts if present
    const { strength, confidence, direction, usedSignals } = this.resolveSignals(validSignals);

    // Check minimum thresholds
    if (Math.abs(strength) < params.minCombinedStrength) {
      this.logger.debug(
        { strength, threshold: params.minCombinedStrength },
        'Combined strength below threshold'
      );
      return null;
    }

    if (confidence < params.minCombinedConfidence) {
      this.logger.debug(
        { confidence, threshold: params.minCombinedConfidence },
        'Combined confidence below threshold'
      );
      return null;
    }

    // Create combined output
    const firstSignal = validSignals[0].signal;

    const combinedOutput: CombinedSignalOutput = {
      signalId: 'combined',
      marketId: firstSignal.marketId,
      tokenId: firstSignal.tokenId,
      direction,
      strength,
      confidence,
      timestamp: now,
      ttlMs: Math.min(...usedSignals.map(s => s.signal.ttlMs)),
      componentSignals: usedSignals.map(s => s.signal),
      weights: this.getCurrentWeights(usedSignals),
      metadata: {
        combinerType: 'weighted_average',
        signalCount: usedSignals.length,
        conflictResolution: params.conflictResolution,
      },
    };

    this.logger.info(
      {
        direction,
        strength: strength.toFixed(3),
        confidence: confidence.toFixed(3),
        signalCount: usedSignals.length,
      },
      'Combined signal generated'
    );

    return combinedOutput;
  }

  /**
   * Resolve potentially conflicting signals
   */
  private resolveSignals(
    signals: Array<{ signal: SignalOutput; weight: number; timeDecay: number }>
  ): {
    strength: number;
    confidence: number;
    direction: SignalDirection;
    usedSignals: Array<{ signal: SignalOutput; weight: number; timeDecay: number }>;
  } {
    const params = this.parameters;

    switch (params.conflictResolution) {
      case 'strongest':
        return this.resolveByStrongest(signals);
      case 'majority':
        return this.resolveByMajority(signals);
      case 'weighted':
      default:
        return this.resolveByWeightedAverage(signals);
    }
  }

  /**
   * Weighted average resolution
   */
  private resolveByWeightedAverage(
    signals: Array<{ signal: SignalOutput; weight: number; timeDecay: number }>
  ): {
    strength: number;
    confidence: number;
    direction: SignalDirection;
    usedSignals: Array<{ signal: SignalOutput; weight: number; timeDecay: number }>;
  } {
    let totalWeight = 0;
    let weightedStrength = 0;
    let weightedConfidence = 0;

    for (const { signal, weight, timeDecay } of signals) {
      const effectiveWeight = weight * signal.confidence * timeDecay;
      totalWeight += effectiveWeight;
      weightedStrength += signal.strength * effectiveWeight;
      weightedConfidence += signal.confidence * effectiveWeight;
    }

    const strength = totalWeight > 0 ? weightedStrength / totalWeight : 0;
    const confidence = totalWeight > 0 ? weightedConfidence / totalWeight : 0;
    const direction = this.getDirection(strength);

    return { strength, confidence, direction, usedSignals: signals };
  }

  /**
   * Strongest signal wins
   */
  private resolveByStrongest(
    signals: Array<{ signal: SignalOutput; weight: number; timeDecay: number }>
  ): {
    strength: number;
    confidence: number;
    direction: SignalDirection;
    usedSignals: Array<{ signal: SignalOutput; weight: number; timeDecay: number }>;
  } {
    // Sort by absolute weighted strength
    const sorted = [...signals].sort((a, b) => {
      const strengthA = Math.abs(a.signal.strength) * a.weight * a.signal.confidence;
      const strengthB = Math.abs(b.signal.strength) * b.weight * b.signal.confidence;
      return strengthB - strengthA;
    });

    const strongest = sorted[0];
    const strength = strongest.signal.strength;
    const confidence = strongest.signal.confidence;
    const direction = this.getDirection(strength);

    return { strength, confidence, direction, usedSignals: [strongest] };
  }

  /**
   * Majority direction with averaged strength
   */
  private resolveByMajority(
    signals: Array<{ signal: SignalOutput; weight: number; timeDecay: number }>
  ): {
    strength: number;
    confidence: number;
    direction: SignalDirection;
    usedSignals: Array<{ signal: SignalOutput; weight: number; timeDecay: number }>;
  } {
    // Count weighted votes for each direction
    let longVotes = 0;
    let shortVotes = 0;
    let neutralVotes = 0;

    for (const { signal, weight, timeDecay } of signals) {
      const vote = weight * signal.confidence * timeDecay;
      if (signal.direction === 'LONG') longVotes += vote;
      else if (signal.direction === 'SHORT') shortVotes += vote;
      else neutralVotes += vote;
    }

    // Determine majority direction
    let majorityDirection: SignalDirection;
    if (longVotes > shortVotes && longVotes > neutralVotes) {
      majorityDirection = 'LONG';
    } else if (shortVotes > longVotes && shortVotes > neutralVotes) {
      majorityDirection = 'SHORT';
    } else {
      majorityDirection = 'NEUTRAL';
    }

    // Filter to signals matching majority
    const majoritySignals = signals.filter(s => s.signal.direction === majorityDirection);

    if (majoritySignals.length === 0) {
      return { strength: 0, confidence: 0, direction: 'NEUTRAL', usedSignals: [] };
    }

    // Average strength and confidence of majority signals
    let totalWeight = 0;
    let weightedStrength = 0;
    let weightedConfidence = 0;

    for (const { signal, weight, timeDecay } of majoritySignals) {
      const effectiveWeight = weight * timeDecay;
      totalWeight += effectiveWeight;
      weightedStrength += signal.strength * effectiveWeight;
      weightedConfidence += signal.confidence * effectiveWeight;
    }

    const strength = totalWeight > 0 ? weightedStrength / totalWeight : 0;
    const confidence = totalWeight > 0 ? weightedConfidence / totalWeight : 0;

    return { strength, confidence, direction: majorityDirection, usedSignals: majoritySignals };
  }

  /**
   * Get weight for a specific signal
   */
  private getSignalWeight(signal: SignalOutput, now: Date): number {
    let weight = this.weights[signal.signalId] ?? 1;

    // Normalize if configured
    if (this.parameters.normalizeWeights) {
      const totalWeight = Object.values(this.weights).reduce((a, b) => a + b, 0);
      if (totalWeight > 0) {
        weight = weight / totalWeight;
      }
    }

    return weight;
  }

  /**
   * Calculate time decay for a signal
   */
  private calculateTimeDecay(signal: SignalOutput, now: Date): number {
    const ageMs = now.getTime() - signal.timestamp.getTime();

    if (ageMs >= this.parameters.maxSignalAgeMs) {
      return 0;
    }

    if (ageMs >= signal.ttlMs) {
      return 0;
    }

    // Exponential decay based on age
    const decayRatio = ageMs / this.parameters.maxSignalAgeMs;
    return Math.pow(this.parameters.timeDecayFactor, decayRatio * 10);
  }

  /**
   * Get direction from strength
   */
  private getDirection(strength: number): SignalDirection {
    if (strength > 0.1) return 'LONG';
    if (strength < -0.1) return 'SHORT';
    return 'NEUTRAL';
  }

  /**
   * Get current weights as used in combination
   */
  private getCurrentWeights(
    signals: Array<{ signal: SignalOutput; weight: number; timeDecay: number }>
  ): Record<string, number> {
    const weights: Record<string, number> = {};
    for (const { signal, weight, timeDecay } of signals) {
      weights[signal.signalId] = weight * timeDecay;
    }
    return weights;
  }

  /**
   * Get all configured weights
   */
  getWeights(): Record<string, number> {
    return { ...this.weights };
  }

  /**
   * Set weights for signal types
   */
  setWeights(weights: Record<string, number>): void {
    this.weights = { ...this.weights, ...weights };
    this.logger.info({ weights: this.weights }, 'Weights updated');
  }

  /**
   * Update a single weight
   */
  updateWeight(signalId: string, weight: number): void {
    this.weights[signalId] = weight;
    this.logger.debug({ signalId, weight }, 'Weight updated');
  }

  /**
   * Adjust weights based on performance feedback
   * Simple gradient-style update towards better performing signals
   */
  adjustWeights(
    signalPerformance: Record<string, { accuracy: number; profitFactor: number }>,
    learningRate: number = 0.01
  ): void {
    // Calculate average performance
    const performances = Object.values(signalPerformance);
    if (performances.length === 0) return;

    const avgAccuracy = performances.reduce((a, p) => a + p.accuracy, 0) / performances.length;
    const avgProfitFactor = performances.reduce((a, p) => a + p.profitFactor, 0) / performances.length;

    // Adjust weights based on relative performance
    for (const [signalId, perf] of Object.entries(signalPerformance)) {
      const currentWeight = this.weights[signalId] || 1;

      // Combined performance score
      const perfScore = (perf.accuracy / avgAccuracy + perf.profitFactor / avgProfitFactor) / 2;

      // Adjust weight towards better performers
      const adjustment = (perfScore - 1) * learningRate;
      const newWeight = Math.max(0.1, Math.min(5, currentWeight * (1 + adjustment)));

      this.weights[signalId] = newWeight;
    }

    this.logger.info({ newWeights: this.weights }, 'Weights adjusted based on performance');
  }
}
