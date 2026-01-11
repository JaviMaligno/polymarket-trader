/**
 * RL Signal
 *
 * Uses a trained DQN agent to generate trading signals.
 * The agent learns optimal bid/ask strategies from historical data.
 */

import { BaseSignal } from '../../core/base/BaseSignal.js';
import type {
  SignalOutput,
  SignalContext,
} from '../../core/types/signal.types.js';
import { DQNAgent } from '../../ml/rl/DQNAgent.js';
import type { RLState, AgentConfig } from '../../ml/rl/types.js';
import { DiscreteAction } from '../../ml/rl/types.js';

/**
 * RL Signal configuration
 */
export interface RLSignalConfig {
  /** Minimum confidence to generate signal */
  minConfidence: number;
  /** State dimension (must match trained model) */
  stateDim: number;
  /** Action dimension */
  actionDim: number;
  /** Order book depth to use */
  orderBookDepth: number;
  /** Price history length */
  priceHistoryLength: number;
}

const DEFAULT_CONFIG: RLSignalConfig = {
  minConfidence: 0.6,
  stateDim: 22,
  actionDim: 10,
  orderBookDepth: 4,
  priceHistoryLength: 5,
};

/**
 * Reinforcement Learning Signal
 *
 * Uses a trained DQN agent to generate buy/sell signals based on
 * market microstructure features.
 */
export class RLSignal extends BaseSignal {
  readonly signalId = 'rl';
  readonly name = 'RL Signal';
  readonly description = 'Reinforcement learning based trading signal using DQN agent';

  private config: RLSignalConfig;
  private agent: DQNAgent | null = null;
  private isModelLoaded = false;

  constructor(config: Partial<RLSignalConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Load trained model weights
   */
  loadModel(modelData: {
    weights: number[][][];
    biases?: number[][];
    config?: Partial<AgentConfig>;
  }): void {
    // Initialize agent with matching config (must match training script)
    const agentConfig: Partial<AgentConfig> = {
      stateDim: this.config.stateDim,
      actionDim: this.config.actionDim,
      hiddenLayers: [64, 32], // Must match training script
      ...modelData.config,
    };

    this.agent = new DQNAgent(agentConfig);
    this.agent.load(modelData);
    this.agent.setEpsilon(0); // No exploration in production
    this.isModelLoaded = true;
  }

  /**
   * Check if model is loaded and ready
   */
  isReady(context: SignalContext): boolean {
    if (!this.isModelLoaded || !this.agent) {
      return false;
    }

    // Need minimum price bars
    return context.priceBars.length >= this.config.priceHistoryLength;
  }

  /**
   * Get required lookback period
   */
  getRequiredLookback(): number {
    return this.config.priceHistoryLength + 1;
  }

  /**
   * Compute signal using the trained RL agent
   */
  async compute(context: SignalContext): Promise<SignalOutput | null> {
    if (!this.agent || !this.isModelLoaded) {
      return null;
    }

    if (!this.isReady(context)) {
      return null;
    }

    // Build state from context
    const state = this.buildState(context);

    // Get action and Q-values from agent
    const qValues = this.agent.getQValues(state);
    const action = this.agent.selectAction(state, false) as DiscreteAction;

    // Calculate confidence from Q-values (softmax probability)
    const maxQ = Math.max(...qValues);
    const expValues = qValues.map(q => Math.exp(q - maxQ));
    const sumExp = expValues.reduce((a, b) => a + b, 0);
    const confidence = expValues[action] / sumExp;

    // Skip if confidence too low
    if (confidence < this.config.minConfidence) {
      return null;
    }

    // Convert action to signal
    const { direction, strength } = this.actionToSignal(action, qValues);

    if (direction === 'NEUTRAL') {
      return null;
    }

    const tokenId = direction === 'LONG'
      ? context.market.tokenIdYes
      : (context.market.tokenIdNo ?? context.market.tokenIdYes);

    return this.createOutput(context, direction, strength, confidence, {
      tokenId,
      metadata: {
        action: DiscreteAction[action],
        qValues,
        regime: state.regime,
        ofi: state.ofi,
        volatility: state.volatility,
      },
    });
  }

  /**
   * Build RLState from SignalContext
   */
  private buildState(context: SignalContext): RLState {
    const { priceBars, market } = context;
    const currentPrice = market.currentPriceYes ?? priceBars[priceBars.length - 1].close;

    // Build order book representation (simplified - use bid/ask from price)
    const orderBook: number[] = [];
    for (let i = 0; i < this.config.orderBookDepth; i++) {
      const spread = 0.01 * (i + 1);
      orderBook.push(currentPrice - spread / 2); // bid
      orderBook.push(currentPrice + spread / 2); // ask
    }

    // Price history (normalized returns)
    const priceHistory: number[] = [];
    const recentBars = priceBars.slice(-this.config.priceHistoryLength - 1);
    for (let i = 1; i < recentBars.length; i++) {
      const ret = (recentBars[i].close - recentBars[i - 1].close) / recentBars[i - 1].close;
      priceHistory.push(ret);
    }

    // Pad if not enough history
    while (priceHistory.length < this.config.priceHistoryLength) {
      priceHistory.unshift(0);
    }

    // Calculate OFI (Order Flow Imbalance) from volume
    const recentVolumes = priceBars.slice(-10);
    let ofi = 0;
    for (let i = 1; i < recentVolumes.length; i++) {
      const priceChange = recentVolumes[i].close - recentVolumes[i - 1].close;
      ofi += priceChange > 0 ? recentVolumes[i].volume : -recentVolumes[i].volume;
    }
    const totalVolume = recentVolumes.reduce((sum, bar) => sum + bar.volume, 0);
    ofi = totalVolume > 0 ? ofi / totalVolume : 0;

    // Calculate volatility (standard deviation of returns)
    const returns = priceHistory.filter(r => r !== 0);
    const meanReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const variance = returns.length > 0
      ? returns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / returns.length
      : 0;
    const volatility = Math.sqrt(variance);

    // Time to resolution (normalized)
    let timeToResolution = 1;
    if (market.endDate) {
      const now = context.currentTime.getTime();
      const end = new Date(market.endDate).getTime();
      const totalDuration = 30 * 24 * 60 * 60 * 1000; // 30 days
      timeToResolution = Math.max(0, Math.min(1, (end - now) / totalDuration));
    }

    // Regime detection (simplified one-hot)
    // [bullish, bearish, neutral]
    const regime = [0, 0, 1]; // Default neutral
    if (priceHistory.length > 0) {
      const avgReturn = priceHistory.reduce((a, b) => a + b, 0) / priceHistory.length;
      if (avgReturn > 0.001) {
        regime[0] = 1; regime[2] = 0; // Bullish
      } else if (avgReturn < -0.001) {
        regime[1] = 1; regime[2] = 0; // Bearish
      }
    }

    return {
      orderBook,
      position: 0, // No position tracking in signal mode
      unrealizedPnL: 0,
      priceHistory,
      ofi,
      volatility,
      timeToResolution,
      regime,
      inventoryRisk: 0,
    };
  }

  /**
   * Convert discrete action to signal direction and strength
   */
  private actionToSignal(
    action: DiscreteAction,
    qValues: number[]
  ): { direction: 'LONG' | 'SHORT' | 'NEUTRAL'; strength: number } {
    // Calculate strength from Q-value magnitude
    const maxQ = Math.max(...qValues);
    const minQ = Math.min(...qValues);
    const range = maxQ - minQ;
    const normalizedQ = range > 0 ? (qValues[action] - minQ) / range : 0.5;

    switch (action) {
      case DiscreteAction.HOLD:
      case DiscreteAction.CANCEL_ALL:
        return { direction: 'NEUTRAL', strength: 0 };

      case DiscreteAction.TIGHT_SMALL:
      case DiscreteAction.TIGHT_MEDIUM:
      case DiscreteAction.TIGHT_LARGE:
        // Tight spread = confident in current price, slight long bias
        return { direction: 'LONG', strength: normalizedQ * 0.5 };

      case DiscreteAction.WIDE_SMALL:
      case DiscreteAction.WIDE_MEDIUM:
      case DiscreteAction.WIDE_LARGE:
        // Wide spread = uncertain, slight short bias (defensive)
        return { direction: 'SHORT', strength: normalizedQ * 0.3 };

      case DiscreteAction.BUY_ONLY:
        return { direction: 'LONG', strength: normalizedQ };

      case DiscreteAction.SELL_ONLY:
        return { direction: 'SHORT', strength: normalizedQ };

      default:
        return { direction: 'NEUTRAL', strength: 0 };
    }
  }

  /**
   * Get model statistics
   */
  getModelStats(): {
    isLoaded: boolean;
    epsilon: number;
    bufferSize: number;
  } | null {
    if (!this.agent) return null;

    return {
      isLoaded: this.isModelLoaded,
      epsilon: this.agent.getEpsilon(),
      bufferSize: this.agent.getBufferSize(),
    };
  }

  /**
   * Set parameters
   */
  setParameters(params: Record<string, unknown>): void {
    super.setParameters(params);
    if (params.minConfidence !== undefined) {
      this.config.minConfidence = params.minConfidence as number;
    }
  }
}
