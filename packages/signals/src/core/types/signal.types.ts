/**
 * Core type definitions for the signal framework
 */

// ============================================
// Signal Direction & Output
// ============================================

export type SignalDirection = 'LONG' | 'SHORT' | 'NEUTRAL';

export interface SignalOutput {
  /** Unique identifier for this signal instance */
  signalId: string;

  /** Market this signal applies to */
  marketId: string;

  /** Token ID (YES or NO token) */
  tokenId: string;

  /** Trading direction recommendation */
  direction: SignalDirection;

  /** Signal strength from -1 (strong short) to +1 (strong long) */
  strength: number;

  /** Confidence level from 0 (no confidence) to 1 (high confidence) */
  confidence: number;

  /** When this signal was generated */
  timestamp: Date;

  /** Time-to-live in milliseconds - signal expires after this */
  ttlMs: number;

  /** Optional feature vector for ML training */
  features?: number[];

  /** Optional metadata for debugging/analysis */
  metadata?: Record<string, unknown>;
}

// ============================================
// Signal Context (Input Data)
// ============================================

export interface PriceBar {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap?: number;
  tradeCount?: number;
}

export interface OrderBookSnapshot {
  time: Date;
  marketId: string;
  tokenId: string;
  bestBid: number;
  bestAsk: number;
  spread: number;
  midPrice: number;
  bidDepth10Pct?: number;
  askDepth10Pct?: number;
}

export interface Trade {
  time: Date;
  marketId: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  valueUsd?: number;
  makerAddress?: string;
  takerAddress?: string;
}

export interface WalletActivity {
  address: string;
  marketId: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  time: Date;
}

export interface MarketInfo {
  id: string;
  question: string;
  category?: string;
  endDate?: Date;
  isActive: boolean;
  isResolved: boolean;
  tokenIdYes: string;
  tokenIdNo?: string;
  currentPriceYes?: number;
  currentPriceNo?: number;
  volume24h?: number;
  liquidity?: number;
}

export interface SignalContext {
  /** Current timestamp for the signal computation */
  currentTime: Date;

  /** Market information */
  market: MarketInfo;

  /** Historical price bars (sorted oldest to newest) */
  priceBars: PriceBar[];

  /** Recent trades */
  recentTrades: Trade[];

  /** Current order book state */
  orderBook?: OrderBookSnapshot;

  /** Tracked wallet activities */
  walletActivities?: WalletActivity[];

  /** Related markets for cross-market analysis */
  relatedMarkets?: MarketInfo[];

  /** Custom data that specific signals might need */
  custom?: Record<string, unknown>;
}

// ============================================
// Signal Interface
// ============================================

export interface ISignal {
  /** Unique identifier for this signal type */
  readonly signalId: string;

  /** Human-readable name */
  readonly name: string;

  /** Description of what this signal detects */
  readonly description: string;

  /** Compute the signal for a given context */
  compute(context: SignalContext): Promise<SignalOutput | null>;

  /** Minimum number of price bars needed */
  getRequiredLookback(): number;

  /** Check if signal has enough data to compute */
  isReady(context: SignalContext): boolean;

  /** Get signal parameters for serialization */
  getParameters(): Record<string, unknown>;

  /** Update signal parameters */
  setParameters(params: Record<string, unknown>): void;
}

// ============================================
// Signal Combiner
// ============================================

export interface CombinedSignalOutput extends SignalOutput {
  /** Individual signals that contributed */
  componentSignals: SignalOutput[];

  /** Weights used for each signal */
  weights: Record<string, number>;
}

export interface ISignalCombiner {
  /** Combine multiple signals into one (currentTime is optional for backtesting) */
  combine(signals: SignalOutput[], currentTime?: Date): CombinedSignalOutput | null;

  /** Get current weights */
  getWeights(): Record<string, number>;

  /** Update weights */
  setWeights(weights: Record<string, number>): void;
}

// ============================================
// Signal Registry
// ============================================

export interface SignalConfig {
  signalId: string;
  enabled: boolean;
  weight: number;
  parameters: Record<string, unknown>;
}

export interface SignalRegistryConfig {
  signals: SignalConfig[];
  combiner: {
    type: 'weighted_average' | 'ml_combiner';
    parameters: Record<string, unknown>;
  };
}

// ============================================
// Backtesting Types
// ============================================

export interface SignalBacktestResult {
  signalId: string;
  totalSignals: number;
  correctSignals: number;
  accuracy: number;
  avgStrength: number;
  avgConfidence: number;
  profitFactor: number;
  sharpeRatio: number;
  maxDrawdown: number;
  brierScore: number;
}
