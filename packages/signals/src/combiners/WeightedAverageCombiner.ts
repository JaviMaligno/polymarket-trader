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
  /** Consensus discount floor ∈ [0, 1]. 1.0 = no effect. 0.0 = aggressive
   *  filter. Optuna tunes this value weekly via signal_weights table. */
  consensusDiscountFloor: number;
  /** Signal IDs disabled entirely. Filtered before weight lookup so they
   *  contribute zero regardless of signal_weights rows or per-type weights.
   *  Mirrors EXECUTOR_BLOCKED_TYPE_DIRECTIONS semantics for signal_type-level
   *  control. The Optimizer can still write rows for these signals — they're
   *  ignored here, immune to oscillation. */
  disabledSignalIds: Set<string>;
}

/**
 * Compute Shannon-entropy-based consensus on directional tallies.
 * Returns null if fewer than 3 informative (non-NEUTRAL) signals — not enough
 * granularity. NEUTRAL signals are excluded from the tally.
 * Formula: consensus = 1 - H(p_long, p_short) where H is Shannon entropy in
 * log base 2 (so H ∈ [0,1] naturally for 2 categories).
 *   - Unanimous (5,0) → consensus = 1.0
 *   - Balanced (3,2)  → consensus ≈ 0.029
 *   - Balanced (2,3)  → consensus ≈ 0.029 (symmetric)
 */
export function signalConsensus(signals: SignalOutput[]): {
  consensus: number | null;
  longCount: number;
  shortCount: number;
  neutralCount: number;
} {
  let longCount = 0;
  let shortCount = 0;
  let neutralCount = 0;
  for (const s of signals) {
    if (s.direction === 'LONG') longCount++;
    else if (s.direction === 'SHORT') shortCount++;
    else if (s.direction === 'NEUTRAL') neutralCount++;
  }
  const N = longCount + shortCount;
  if (N < 3) {
    return { consensus: null, longCount, shortCount, neutralCount };
  }
  const pL = longCount / N;
  const pS = shortCount / N;
  const H = -(pL > 0 ? pL * Math.log2(pL) : 0) - (pS > 0 ? pS * Math.log2(pS) : 0);
  return {
    consensus: 1 - H,
    longCount,
    shortCount,
    neutralCount,
  };
}

/**
 * Linear floor-shifted discount: discount(c) = floor + (1-floor) * c.
 * Returns 1.0 when consensus is null (no-op — matches pre-B.2 behavior).
 * - floor=1.0 → always 1.0 (consensus has no effect)
 * - floor=0.5 → 50/50 signal gets 0.5×, unanimous 1.0× (initial default)
 * - floor=0.0 → consensus fully scales confidence (aggressive filtering)
 */
export function consensusDiscount(
  consensus: number | null,
  floor: number,
): number {
  if (consensus === null) return 1.0;
  return floor + (1 - floor) * consensus;
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
/** Default signal weights per market type.
 * Momentum is NEGATIVE (contrarian) — prediction markets are mean-reverting
 * at all intraday timescales (autocorrelation -0.38 to -0.41). */
const DEFAULT_TYPE_WEIGHTS: Record<string, Record<string, number>> = {
  crypto_intraday: { momentum: -0.3, mean_reversion: 0.5, ofi: 0.5, mlofi: 0.5, hawkes: 0.4 },
  crypto_daily:    { momentum: -0.3, mean_reversion: 0.6, ofi: 0.4, mlofi: 0.4, hawkes: 0.3 },
  // event_financial: commodities/rates/indices have continuous underlying; use microstructure-heavy weights like crypto_daily
  event_financial: { momentum: -0.3, mean_reversion: 0.6, ofi: 0.4, mlofi: 0.4, hawkes: 0.3 },
  event_short:     { momentum: -0.4, mean_reversion: 0.6, ofi: 0.3, mlofi: 0.3, hawkes: 0.2 },
  event_long:      { momentum: -0.4, mean_reversion: 0.6, ofi: 0.2, mlofi: 0.2, hawkes: 0.1 },
};

export class WeightedAverageCombiner implements ISignalCombiner {
  private logger: Logger;
  private weights: Record<string, number> = {};
  private typeWeights: Record<string, Record<string, number>>;
  private parameters: WeightedAverageParams;
  /** Multiplier applied to combined strength before direction determination.
   *  -1 = flip all signals (contrarian). Context overrides are stored separately
   *  so market-type-specific signal weights remain independent from direction policy.
   *  Default -1 (contrarian/flip); callers can override per context key for exploration. */
  private directionMultiplier: number = -1;
  private contextDirectionMultipliers: Record<string, number> = {};

  constructor(
    initialWeights: Record<string, number> = {},
    params: Partial<WeightedAverageParams> = {}
  ) {
    this.logger = pino({ name: 'weighted-average-combiner' });
    this.weights = { ...initialWeights };
    // Per-type weights are populated externally via setTypeWeights() —
    // typically from DB in SignalEngine.setupCombiner(). DEFAULT_TYPE_WEIGHTS
    // constant is kept in this file as dead code for one release cycle
    // (rollback safety).
    this.typeWeights = {};
    this.parameters = {
      minConfidence: 0.2,
      normalizeWeights: true,
      minCombinedConfidence: 0.2,   // Optimized for SHORT strategy
      minCombinedStrength: 0.3,     // Optimized: filters weak signals
      conflictResolution: 'weighted',
      timeDecayFactor: 0.9,
      maxSignalAgeMs: 5 * 60 * 1000, // 5 minutes
      consensusDiscountFloor: 0.5,
      disabledSignalIds: new Set<string>(),
      ...params,
    };
  }

  /** Replace the disabled signal-id set. Pass empty Set to re-enable everything. */
  setDisabledSignalIds(ids: Iterable<string>): void {
    this.parameters.disabledSignalIds = new Set(ids);
    this.logger.info({ disabled: Array.from(this.parameters.disabledSignalIds) }, 'Disabled signal IDs updated');
  }

  getDisabledSignalIds(): Set<string> {
    return new Set(this.parameters.disabledSignalIds);
  }

  /**
   * Set per-type weights (from optimizer)
   */
  setTypeWeights(typeWeights: Record<string, Record<string, number>>): void {
    this.typeWeights = { ...this.typeWeights, ...typeWeights };
    this.logger.info({ types: Object.keys(typeWeights) }, 'Type weights updated');
  }

  /**
   * Set direction multiplier. -1 = flip all signals (contrarian).
   * Prediction market signals anti-correlate with outcomes (detect information
   * as "overextension"), so flipping converts them into trend-followers.
   */
  setDirectionMultiplier(multiplier: number, contextKey?: string): void {
    if (contextKey) {
      this.contextDirectionMultipliers[contextKey] = multiplier;
    } else {
      this.directionMultiplier = multiplier;
    }
    this.logger.info({ multiplier, contextKey: contextKey ?? 'global' }, 'Direction multiplier updated');
  }

  setDirectionMultipliers(multipliers: Record<string, number>): void {
    this.contextDirectionMultipliers = { ...multipliers };
    this.logger.info({ count: Object.keys(multipliers).length }, 'Direction multiplier overrides replaced');
  }

  getDirectionMultiplier(contextKey?: string): number {
    if (contextKey && this.contextDirectionMultipliers[contextKey] !== undefined) {
      return this.contextDirectionMultipliers[contextKey];
    }
    return this.directionMultiplier;
  }

  /**
   * Combine multiple signals into one
   * @param signals Array of signals to combine
   * @param currentTime Optional current time for backtesting (defaults to wall-clock time)
   * @param marketType Optional market type for per-type weight selection
   */
  combine(
    signals: SignalOutput[],
    currentTime?: Date,
    marketType?: string,
    directionContextKey?: string
  ): CombinedSignalOutput | null {
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
        weight: this.getSignalWeight(s, now, marketType),
        timeDecay: this.calculateTimeDecay(s, now),
      }))
      .filter(s => s.weight !== 0 && s.timeDecay > 0);

    if (validSignals.length === 0) {
      return null;
    }

    // Resolve conflicts if present
    const resolved = this.resolveSignals(validSignals);

    // Apply direction multiplier (e.g., -1 to flip signals for contrarian trading)
    const multiplier = this.getDirectionMultiplier(directionContextKey);
    const strength = resolved.strength * multiplier;
    const confidence = resolved.confidence;
    const direction = this.getDirection(strength);
    const usedSignals = resolved.usedSignals;

    // Check minimum thresholds
    if (Math.abs(strength) < params.minCombinedStrength) {
      this.logger.debug(
        { strength, threshold: params.minCombinedStrength },
        'Combined strength below threshold'
      );
      return null;
    }

    // Consensus discount on combined confidence
    const consensusResult = signalConsensus(usedSignals.map(s => s.signal));
    const discount = consensusDiscount(consensusResult.consensus, params.consensusDiscountFloor);
    const rawConfidence = confidence;
    const finalConfidence = confidence * discount;

    if (finalConfidence < params.minCombinedConfidence) {
      this.logger.info(
        {
          confidence: rawConfidence,
          finalConfidence,
          consensus: consensusResult.consensus,
          longCount: consensusResult.longCount,
          shortCount: consensusResult.shortCount,
          discount,
          threshold: params.minCombinedConfidence,
        },
        'Combined confidence (post-consensus-discount) below threshold'
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
      confidence: finalConfidence,
      timestamp: now,
      ttlMs: Math.min(...usedSignals.map(s => s.signal.ttlMs)),
      componentSignals: usedSignals.map(s => s.signal),
      weights: this.getCurrentWeights(usedSignals),
      appliedDirectionMultiplier: multiplier,
      wasExploration: false,  // enrichCombinedWithDirection overwrites this when exploration is active
      metadata: {
        combinerType: 'weighted_average',
        signalCount: usedSignals.length,
        conflictResolution: params.conflictResolution,
        // B.2 consensus discount fields:
        consensus: consensusResult.consensus,
        consensusDiscount: discount,
        rawConfidence,
        componentCounts: {
          long: consensusResult.longCount,
          short: consensusResult.shortCount,
          neutral: consensusResult.neutralCount,
        },
      },
    };

    this.logger.info(
      {
        direction,
        strength: strength.toFixed(3),
        confidence: finalConfidence.toFixed(3),
        rawConfidence: rawConfidence.toFixed(3),
        consensus: consensusResult.consensus?.toFixed(3) ?? null,
        discount: discount.toFixed(3),
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
      totalWeight += Math.abs(effectiveWeight);  // Normalize by absolute weight sum
      weightedStrength += signal.strength * effectiveWeight;
      weightedConfidence += signal.confidence * Math.abs(effectiveWeight);
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
   * Get weight for a specific signal, using market-type-specific weights if available
   */
  private getSignalWeight(signal: SignalOutput, now: Date, marketType?: string): number {
    // Hard disable: configured via SIGNAL_TYPES_DISABLED env var. Immune to
    // signal_weights rows (the Optimizer can write whatever it wants — this
    // gate ignores them). Resolves the oscillation discovered 2026-05-12 where
    // dashboard boot cleanup deleted rows but Optuna re-wrote them every 6h.
    if (this.parameters.disabledSignalIds.has(signal.signalId)) {
      return 0;
    }
    // Per-type weights are explicit allowlists — generators not listed for this
    // market_type intentionally do not contribute. Default 0 honors that intent
    // (a previous default of 1 caused unlisted generators to dominate via the
    // normalize pass). The legacy this.weights branch keeps default 1 for
    // backward compatibility with markets that have no type-specific entry.
    let weight: number;
    let weightSource: Record<string, number>;
    if (marketType && this.typeWeights[marketType]) {
      weightSource = this.typeWeights[marketType];
      weight = weightSource[signal.signalId] ?? 0;
    } else {
      weightSource = this.weights;
      weight = weightSource[signal.signalId] ?? 1;
    }

    // Normalize if configured
    if (this.parameters.normalizeWeights) {
      const totalWeight = Object.values(weightSource).reduce((a, b) => a + b, 0);
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
