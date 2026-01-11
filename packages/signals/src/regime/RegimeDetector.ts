/**
 * Market Regime Detector
 *
 * Uses Hidden Markov Models to detect the current market regime
 * and provide strategy adaptation recommendations.
 */

import { pino, Logger } from 'pino';
import { EventEmitter } from 'events';
import { HiddenMarkovModel } from './HiddenMarkovModel.js';
import {
  MarketRegime,
  RegimeState,
  RegimeParameters,
  MarketObservation,
  DEFAULT_REGIME_PARAMETERS,
} from './types.js';

/**
 * Regime Detector Configuration
 */
export interface RegimeDetectorConfig {
  /** Lookback period for calculating observations - default: 20 */
  lookbackPeriod?: number;
  /** Minimum observations before starting detection - default: 10 */
  minObservations?: number;
  /** Learning rate for online HMM updates - default: 0.01 */
  learningRate?: number;
  /** Whether to use online learning - default: true */
  enableOnlineLearning?: boolean;
  /** Confidence threshold for regime change - default: 0.6 */
  regimeChangeThreshold?: number;
  /** Number of consecutive observations to confirm regime change - default: 3 */
  confirmationBars?: number;
  /** History length to keep - default: 100 */
  historyLength?: number;
  /** Custom regime parameters */
  regimeParams?: Partial<Record<MarketRegime, Partial<RegimeParameters>>>;
}

/**
 * Market Regime Detector
 *
 * Detects the current market regime using:
 * 1. Hidden Markov Model for probabilistic state estimation
 * 2. Returns and volatility as primary observations
 * 3. Online learning to adapt to changing market conditions
 *
 * Events:
 * - 'regime:changed': (from: MarketRegime, to: MarketRegime, state: RegimeState) => void
 * - 'regime:warning': (message: string, state: RegimeState) => void
 */
export class RegimeDetector extends EventEmitter {
  private logger: Logger;
  private config: Required<RegimeDetectorConfig>;
  private hmm: HiddenMarkovModel;
  private regimeParams: Record<MarketRegime, RegimeParameters>;

  /** Current state probabilities */
  private stateProbs: number[];
  /** Current detected regime */
  private currentRegime: MarketRegime;
  /** Duration in current regime (bars) */
  private regimeDuration: number;
  /** Observation history */
  private observations: MarketObservation[];
  /** Regime history */
  private regimeHistory: Array<{ regime: MarketRegime; probability: number; timestamp: Date }>;
  /** Pending regime change (for confirmation) */
  private pendingRegime: { regime: MarketRegime; count: number } | null;
  /** Track previous close price for returns calculation */
  private lastClosePrice: number | null = null;
  /** Track raw volume sum for proper relative volume calculation */
  private volumeSum: number = 0;
  private volumeCount: number = 0;

  /** Mapping from HMM state index to MarketRegime */
  private stateToRegime: MarketRegime[] = [
    MarketRegime.BULL_LOW_VOL,
    MarketRegime.BULL_HIGH_VOL,
    MarketRegime.BEAR_LOW_VOL,
    MarketRegime.BEAR_HIGH_VOL,
    MarketRegime.NEUTRAL,
  ];

  constructor(config?: RegimeDetectorConfig) {
    super();
    this.logger = pino({ name: 'RegimeDetector' });

    this.config = {
      lookbackPeriod: config?.lookbackPeriod ?? 20,
      minObservations: config?.minObservations ?? 10,
      learningRate: config?.learningRate ?? 0.01,
      enableOnlineLearning: config?.enableOnlineLearning ?? true,
      regimeChangeThreshold: config?.regimeChangeThreshold ?? 0.6,
      confirmationBars: config?.confirmationBars ?? 3,
      historyLength: config?.historyLength ?? 100,
      regimeParams: config?.regimeParams ?? {},
    };

    // Initialize HMM with 5 states, 2 observations (returns, volatility)
    this.hmm = new HiddenMarkovModel({
      numStates: 5,
      numObservations: 2,
      learningRate: this.config.learningRate,
    });

    // Merge custom regime params with defaults
    this.regimeParams = { ...DEFAULT_REGIME_PARAMETERS };
    for (const [regime, params] of Object.entries(this.config.regimeParams)) {
      this.regimeParams[regime as MarketRegime] = {
        ...this.regimeParams[regime as MarketRegime],
        ...params,
      };
    }

    // Initialize state
    this.stateProbs = Array(5).fill(0.2); // Uniform initial
    this.currentRegime = MarketRegime.NEUTRAL;
    this.regimeDuration = 0;
    this.observations = [];
    this.regimeHistory = [];
    this.pendingRegime = null;
  }

  /**
   * Process a new price bar and update regime detection
   */
  update(bar: {
    close: number;
    volume: number;
    timestamp: Date;
    previousCloses?: number[];
  }): RegimeState {
    // Calculate observation from price data
    const observation = this.calculateObservation(bar);
    this.observations.push(observation);

    // Trim observation history
    if (this.observations.length > this.config.historyLength) {
      this.observations = this.observations.slice(-this.config.historyLength);
    }

    // Need minimum observations before detecting
    if (this.observations.length < this.config.minObservations) {
      return this.getCurrentState();
    }

    // Create observation vector [returns, volatility]
    const obsVector = [observation.returns, observation.volatility];

    // Update HMM state probabilities
    this.stateProbs = this.hmm.filter(obsVector, this.stateProbs);

    // Online learning
    if (this.config.enableOnlineLearning) {
      this.hmm.updateOnline(obsVector, this.stateProbs);
    }

    // Determine most likely regime
    const { regime, probability } = this.getMostLikelyRegime();

    // Handle regime changes with confirmation
    this.processRegimeChange(regime, probability, observation.timestamp);

    // Update regime history
    this.regimeHistory.push({
      regime: this.currentRegime,
      probability: this.getStateProbability(this.currentRegime),
      timestamp: observation.timestamp,
    });

    // Trim history
    if (this.regimeHistory.length > this.config.historyLength) {
      this.regimeHistory = this.regimeHistory.slice(-this.config.historyLength);
    }

    return this.getCurrentState();
  }

  /**
   * Calculate observation from price bar
   * FIXED: Proper returns calculation using actual price, not reconstructed from returns
   * FIXED: Proper relative volume using raw volume average, not average of relative volumes
   */
  private calculateObservation(bar: {
    close: number;
    volume: number;
    timestamp: Date;
    previousCloses?: number[];
  }): MarketObservation {
    // Calculate returns properly: (current - previous) / previous
    let returns: number;
    if (this.lastClosePrice !== null && this.lastClosePrice > 0) {
      returns = (bar.close - this.lastClosePrice) / this.lastClosePrice;
    } else {
      returns = 0;
    }
    // Update last close for next calculation
    this.lastClosePrice = bar.close;

    // Calculate rolling volatility
    const recentReturns = this.observations.slice(-this.config.lookbackPeriod).map(o => o.returns);
    recentReturns.push(returns);
    const volatility = this.calculateVolatility(recentReturns);

    // Calculate relative volume properly using raw volume average
    // Update running average of raw volumes
    this.volumeSum += bar.volume;
    this.volumeCount++;
    const avgVolume = this.volumeSum / this.volumeCount;
    const relativeVolume = avgVolume > 0 ? bar.volume / avgVolume : 1;

    return {
      timestamp: bar.timestamp,
      returns,
      volatility,
      relativeVolume,
    };
  }

  /**
   * Calculate volatility from returns
   * Uses sample variance (N-1) for unbiased estimate
   */
  private calculateVolatility(returns: number[]): number {
    if (returns.length < 2) return 0.02; // Default volatility

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const squaredDiffs = returns.map(r => Math.pow(r - mean, 2));
    // Use N-1 for sample variance (unbiased estimator)
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / (returns.length - 1);
    return Math.sqrt(variance);
  }

  /**
   * Get the most likely regime from state probabilities
   */
  private getMostLikelyRegime(): { regime: MarketRegime; probability: number } {
    let maxProb = 0;
    let maxIdx = 4; // Default to NEUTRAL

    for (let i = 0; i < this.stateProbs.length; i++) {
      if (this.stateProbs[i] > maxProb) {
        maxProb = this.stateProbs[i];
        maxIdx = i;
      }
    }

    return {
      regime: this.stateToRegime[maxIdx],
      probability: maxProb,
    };
  }

  /**
   * Process potential regime change with confirmation logic
   */
  private processRegimeChange(
    newRegime: MarketRegime,
    probability: number,
    timestamp: Date
  ): void {
    // Check if regime is different
    if (newRegime !== this.currentRegime) {
      // Check if probability exceeds threshold
      if (probability >= this.config.regimeChangeThreshold) {
        // Check for pending confirmation
        if (this.pendingRegime && this.pendingRegime.regime === newRegime) {
          this.pendingRegime.count++;

          // Confirm regime change if enough consecutive bars
          if (this.pendingRegime.count >= this.config.confirmationBars) {
            const oldRegime = this.currentRegime;
            this.currentRegime = newRegime;
            this.regimeDuration = 0;
            this.pendingRegime = null;

            this.logger.info({
              from: oldRegime,
              to: newRegime,
              probability,
            }, 'Regime change confirmed');

            this.emit('regime:changed', oldRegime, newRegime, this.getCurrentState());
          }
        } else {
          // Start new pending regime
          this.pendingRegime = { regime: newRegime, count: 1 };
        }
      } else {
        // Reset pending if probability drops
        if (this.pendingRegime && this.pendingRegime.regime === newRegime) {
          // Keep pending but don't increment
        } else {
          this.pendingRegime = null;
        }
      }
    } else {
      // Same regime - reset pending and increment duration
      this.pendingRegime = null;
      this.regimeDuration++;
    }
  }

  /**
   * Get probability for a specific regime
   */
  private getStateProbability(regime: MarketRegime): number {
    const idx = this.stateToRegime.indexOf(regime);
    return idx >= 0 ? this.stateProbs[idx] : 0;
  }

  /**
   * Get current regime state
   */
  getCurrentState(): RegimeState {
    const stateProbabilities: Record<MarketRegime, number> = {} as Record<MarketRegime, number>;
    for (let i = 0; i < this.stateToRegime.length; i++) {
      stateProbabilities[this.stateToRegime[i]] = this.stateProbs[i];
    }

    return {
      regime: this.currentRegime,
      probability: this.getStateProbability(this.currentRegime),
      stateProbabilities,
      timestamp: this.observations[this.observations.length - 1]?.timestamp ?? new Date(),
      duration: this.regimeDuration,
      history: this.regimeHistory.slice(-20),
    };
  }

  /**
   * Get trading parameters for current regime
   */
  getCurrentParameters(): RegimeParameters {
    return this.regimeParams[this.currentRegime];
  }

  /**
   * Get trading parameters for a specific regime
   */
  getParameters(regime: MarketRegime): RegimeParameters {
    return this.regimeParams[regime];
  }

  /**
   * Check if a signal type is preferred in current regime
   */
  isSignalPreferred(signalId: string): boolean {
    const params = this.getCurrentParameters();
    return params.preferredSignals.includes(signalId);
  }

  /**
   * Check if a signal type should be avoided in current regime
   */
  shouldAvoidSignal(signalId: string): boolean {
    const params = this.getCurrentParameters();
    return params.avoidSignals.includes(signalId);
  }

  /**
   * Get adjusted position size multiplier for current regime
   */
  getPositionSizeMultiplier(): number {
    return this.getCurrentParameters().positionSizeMultiplier;
  }

  /**
   * Get adjusted thresholds for current regime
   */
  getAdjustedThresholds(): { minConfidence: number; minStrength: number } {
    const params = this.getCurrentParameters();
    return {
      minConfidence: params.minConfidence,
      minStrength: params.minStrength,
    };
  }

  /**
   * Batch update with historical data
   */
  batchUpdate(bars: Array<{
    close: number;
    volume: number;
    timestamp: Date;
  }>): RegimeState {
    for (const bar of bars) {
      this.update(bar);
    }
    return this.getCurrentState();
  }

  /**
   * Run Viterbi on accumulated observations to get most likely regime sequence
   */
  getMostLikelySequence(): { regimes: MarketRegime[]; probability: number } {
    if (this.observations.length < 2) {
      return { regimes: [this.currentRegime], probability: 1 };
    }

    const obsVectors = this.observations.map(o => [o.returns, o.volatility]);
    const { states, probability } = this.hmm.viterbi(obsVectors);

    return {
      regimes: states.map(s => this.stateToRegime[s]),
      probability,
    };
  }

  /**
   * Reset detector state
   */
  reset(): void {
    this.stateProbs = Array(5).fill(0.2);
    this.currentRegime = MarketRegime.NEUTRAL;
    this.regimeDuration = 0;
    this.observations = [];
    this.regimeHistory = [];
    this.pendingRegime = null;
    this.lastClosePrice = null;
    this.volumeSum = 0;
    this.volumeCount = 0;
  }

  /**
   * Get HMM parameters for serialization
   */
  getModelParameters(): ReturnType<HiddenMarkovModel['getParameters']> {
    return this.hmm.getParameters();
  }

  /**
   * Load HMM parameters
   */
  loadModelParameters(params: ReturnType<HiddenMarkovModel['getParameters']>): void {
    this.hmm.loadParameters(params);
  }
}
