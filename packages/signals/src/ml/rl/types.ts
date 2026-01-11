/**
 * Reinforcement Learning Types
 *
 * Type definitions for RL-based market making.
 */

/**
 * State representation for RL agent
 */
export interface RLState {
  /** Normalized order book levels [bid1, ask1, bid2, ask2, ...] */
  orderBook: number[];
  /** Current position in this market (-1 to 1 normalized) */
  position: number;
  /** Unrealized PnL normalized */
  unrealizedPnL: number;
  /** Recent price changes */
  priceHistory: number[];
  /** Order flow imbalance */
  ofi: number;
  /** Current volatility */
  volatility: number;
  /** Time to market resolution (normalized 0-1) */
  timeToResolution: number;
  /** Current market regime (one-hot encoded) */
  regime: number[];
  /** Inventory risk (how exposed we are) */
  inventoryRisk: number;
}

/**
 * Action space for market maker
 */
export interface RLAction {
  /** Bid price offset from mid (-1 to 1, negative = more aggressive) */
  bidOffset: number;
  /** Ask price offset from mid (-1 to 1, positive = more aggressive) */
  askOffset: number;
  /** Bid size (0 to 1, fraction of max position) */
  bidSize: number;
  /** Ask size (0 to 1, fraction of max position) */
  askSize: number;
  /** Whether to cancel all orders (binary) */
  cancelAll: boolean;
}

/**
 * Discrete action (for DQN)
 */
export enum DiscreteAction {
  /** Do nothing */
  HOLD = 0,
  /** Tight spread, small size */
  TIGHT_SMALL = 1,
  /** Tight spread, medium size */
  TIGHT_MEDIUM = 2,
  /** Tight spread, large size */
  TIGHT_LARGE = 3,
  /** Wide spread, small size */
  WIDE_SMALL = 4,
  /** Wide spread, medium size */
  WIDE_MEDIUM = 5,
  /** Wide spread, large size */
  WIDE_LARGE = 6,
  /** Cancel all orders */
  CANCEL_ALL = 7,
  /** Buy only (one-sided) */
  BUY_ONLY = 8,
  /** Sell only (one-sided) */
  SELL_ONLY = 9,
}

/**
 * Experience tuple for replay buffer
 */
export interface Experience {
  state: RLState;
  action: number | RLAction;
  reward: number;
  nextState: RLState;
  done: boolean;
}

/**
 * Training batch
 */
export interface TrainingBatch {
  states: RLState[];
  actions: (number | RLAction)[];
  rewards: number[];
  nextStates: RLState[];
  dones: boolean[];
}

/**
 * Agent configuration
 */
export interface AgentConfig {
  /** State dimension */
  stateDim: number;
  /** Action dimension (discrete) or continuous action space size */
  actionDim: number;
  /** Learning rate */
  learningRate: number;
  /** Discount factor (gamma) */
  gamma: number;
  /** Epsilon for exploration (epsilon-greedy) */
  epsilon: number;
  /** Epsilon decay rate */
  epsilonDecay: number;
  /** Minimum epsilon */
  epsilonMin: number;
  /** Batch size for training */
  batchSize: number;
  /** Target network update frequency */
  targetUpdateFreq: number;
  /** Hidden layer sizes */
  hiddenLayers: number[];
  /** Whether to use double DQN */
  useDoubleDQN: boolean;
  /** Whether to use dueling DQN */
  useDuelingDQN: boolean;
  /** Whether to use prioritized experience replay */
  usePER: boolean;
}

/**
 * Market making environment configuration
 */
export interface EnvironmentConfig {
  /** Maximum position size */
  maxPosition: number;
  /** Tick size (minimum price increment) */
  tickSize: number;
  /** Maker fee (rebate if negative) */
  makerFee: number;
  /** Taker fee */
  takerFee: number;
  /** Inventory penalty factor */
  inventoryPenalty: number;
  /** Risk aversion factor */
  riskAversion: number;
  /** Order book depth to consider */
  orderBookDepth: number;
  /** Price history length */
  priceHistoryLength: number;
  /** Episode length (number of steps) */
  episodeLength: number;
  /** Reward scaling factor */
  rewardScale: number;
}

/**
 * Market maker metrics
 */
export interface MarketMakerMetrics {
  /** Total PnL */
  totalPnL: number;
  /** Number of trades made */
  numTrades: number;
  /** Average spread earned */
  avgSpread: number;
  /** Inventory turnover */
  inventoryTurnover: number;
  /** Maximum drawdown */
  maxDrawdown: number;
  /** Sharpe ratio */
  sharpeRatio: number;
  /** Win rate */
  winRate: number;
  /** Average position held */
  avgPosition: number;
  /** Time in market (percentage) */
  timeInMarket: number;
  /** Adverse selection cost */
  adverseSelectionCost: number;
}

/**
 * Neural network layer definition
 */
export interface LayerDef {
  type: 'dense' | 'lstm' | 'conv1d' | 'attention';
  units: number;
  activation?: 'relu' | 'tanh' | 'sigmoid' | 'linear' | 'softmax';
  dropout?: number;
}

/**
 * Model checkpoint
 */
export interface ModelCheckpoint {
  weights: number[][][];
  config: AgentConfig;
  metrics: MarketMakerMetrics;
  epoch: number;
  timestamp: Date;
}

/**
 * Calculate state dimension dynamically based on environment config
 * orderBook: orderBookDepth * 4 = 5 * 4 = 20
 * position: 1
 * unrealizedPnL: 1
 * priceHistory: priceHistoryLength = 20
 * ofi: 1
 * volatility: 1
 * timeToResolution: 1
 * regime: 5 (one-hot for 5 market regimes)
 * inventoryRisk: 1
 * Total = 20 + 1 + 1 + 20 + 1 + 1 + 1 + 5 + 1 = 51
 */
export function calculateStateDim(envConfig: EnvironmentConfig): number {
  return (
    envConfig.orderBookDepth * 4 + // bid/ask price/size for each level
    1 + // position
    1 + // unrealizedPnL
    envConfig.priceHistoryLength + // price history
    1 + // ofi
    1 + // volatility
    1 + // timeToResolution
    5 + // regime (one-hot encoded for 5 regimes)
    1 // inventoryRisk
  );
}

/** Default agent configuration */
export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  stateDim: 51, // FIXED: Matches actual state vector size
  actionDim: 10, // DiscreteAction enum size
  learningRate: 0.001,
  gamma: 0.99,
  epsilon: 1.0,
  epsilonDecay: 0.995,
  epsilonMin: 0.01,
  batchSize: 32,
  targetUpdateFreq: 100,
  hiddenLayers: [64, 64],
  useDoubleDQN: true,
  useDuelingDQN: false,
  usePER: false,
};

/** Default environment configuration */
export const DEFAULT_ENV_CONFIG: EnvironmentConfig = {
  maxPosition: 1000,
  tickSize: 0.001,
  makerFee: -0.001, // Rebate
  takerFee: 0.002,
  inventoryPenalty: 0.0001,
  riskAversion: 0.5,
  orderBookDepth: 5,
  priceHistoryLength: 20,
  episodeLength: 1000,
  rewardScale: 100,
};
