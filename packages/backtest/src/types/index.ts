/**
 * Core types for the backtesting engine
 */

// ============================================
// Event Types
// ============================================

export type EventType =
  | 'PRICE_UPDATE'
  | 'TRADE'
  | 'ORDER_BOOK_UPDATE'
  | 'SIGNAL'
  | 'ORDER_PLACED'
  | 'ORDER_FILLED'
  | 'ORDER_CANCELLED'
  | 'POSITION_OPENED'
  | 'POSITION_CLOSED'
  | 'MARKET_RESOLVED'
  | 'TICK';

export interface BacktestEvent {
  type: EventType;
  timestamp: Date;
  data: unknown;
}

export interface PriceUpdateEvent extends BacktestEvent {
  type: 'PRICE_UPDATE';
  data: {
    marketId: string;
    tokenId: string;
    price: number;
    volume?: number;
    bid?: number;
    ask?: number;
  };
}

export interface TradeEvent extends BacktestEvent {
  type: 'TRADE';
  data: {
    marketId: string;
    tokenId: string;
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    makerAddress?: string;
    takerAddress?: string;
  };
}

export interface SignalEvent extends BacktestEvent {
  type: 'SIGNAL';
  data: {
    signalId: string;
    marketId: string;
    direction: 'LONG' | 'SHORT' | 'NEUTRAL';
    strength: number;
    confidence: number;
  };
}

export interface OrderEvent extends BacktestEvent {
  type: 'ORDER_PLACED' | 'ORDER_FILLED' | 'ORDER_CANCELLED';
  data: Order;
}

export interface MarketResolvedEvent extends BacktestEvent {
  type: 'MARKET_RESOLVED';
  data: {
    marketId: string;
    outcome: 'YES' | 'NO' | 'INVALID';
    resolutionPrice: number;
  };
}

// ============================================
// Order Types
// ============================================

export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT';
export type OrderStatus = 'PENDING' | 'OPEN' | 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELLED';

export interface Order {
  id: string;
  marketId: string;
  tokenId: string;
  side: OrderSide;
  type: OrderType;
  size: number;
  price?: number;  // For limit orders
  status: OrderStatus;
  filledSize: number;
  avgFillPrice: number;
  createdAt: Date;
  updatedAt: Date;
  fills: OrderFill[];
}

export interface OrderFill {
  price: number;
  size: number;
  fee: number;
  timestamp: Date;
}

// ============================================
// Position Types
// ============================================

export interface Position {
  id: string;
  marketId: string;
  tokenId: string;
  side: 'LONG' | 'SHORT';
  size: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  openedAt: Date;
  closedAt?: Date;
  orders: string[];  // Order IDs
}

// ============================================
// Portfolio Types
// ============================================

export interface PortfolioState {
  timestamp: Date;
  cash: number;
  positions: Map<string, Position>;
  totalValue: number;
  unrealizedPnl: number;
  realizedPnl: number;
  marginUsed: number;
  marginAvailable: number;
}

export interface PortfolioSnapshot {
  timestamp: Date;
  cash: number;
  positionsValue: number;
  totalValue: number;
  unrealizedPnl: number;
  realizedPnl: number;
  drawdown: number;
  highWaterMark: number;
}

// ============================================
// Backtest Configuration
// ============================================

export interface BacktestConfig {
  /** Start date of backtest */
  startDate: Date;
  /** End date of backtest */
  endDate: Date;
  /** Initial capital */
  initialCapital: number;
  /** Trading fee rate (0.01 = 1%) */
  feeRate: number;
  /** Slippage model configuration */
  slippage: SlippageConfig;
  /** Risk management settings */
  risk: RiskConfig;
  /** Markets to include (empty = all) */
  marketIds?: string[];
  /** Data granularity in minutes */
  granularityMinutes: number;
}

export interface SlippageConfig {
  /** Slippage model type */
  model: 'fixed' | 'proportional' | 'orderbook';
  /** Fixed slippage in price units */
  fixedSlippage?: number;
  /** Proportional slippage rate */
  proportionalRate?: number;
  /** Order book impact factor */
  impactFactor?: number;
}

export interface RiskConfig {
  /** Maximum position size as % of portfolio */
  maxPositionSizePct: number;
  /** Maximum total exposure as % of portfolio */
  maxExposurePct: number;
  /** Maximum drawdown before halt (%) */
  maxDrawdownPct: number;
  /** Daily loss limit in USD */
  dailyLossLimit: number;
  /** Maximum concurrent positions */
  maxPositions: number;
  /** Stop loss per position (%) */
  stopLossPct: number;
  /** Take profit per position (%) */
  takeProfitPct: number;
}

// ============================================
// Backtest Results
// ============================================

export interface BacktestResult {
  config: BacktestConfig;
  summary: BacktestSummary;
  trades: TradeRecord[];
  equityCurve: PortfolioSnapshot[];
  metrics: PerformanceMetrics;
  predictionMetrics: PredictionMarketMetrics;
}

export interface BacktestSummary {
  startDate: Date;
  endDate: Date;
  totalDays: number;
  initialCapital: number;
  finalCapital: number;
  totalReturn: number;
  annualizedReturn: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  totalFees: number;
}

export interface TradeRecord {
  id: string;
  marketId: string;
  tokenId: string;
  marketQuestion: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  size: number;
  pnl: number;
  pnlPct: number;
  fees: number;
  entryTime: Date;
  exitTime: Date;
  holdingPeriodMs: number;
  signals: string[];
  marketResolved: boolean;
  resolutionOutcome?: 'YES' | 'NO' | 'INVALID';
}

export interface PerformanceMetrics {
  /** Total return as decimal (0.1 = 10%) */
  totalReturn: number;
  /** Annualized return */
  annualizedReturn: number;
  /** Sharpe ratio (risk-free rate = 0) */
  sharpeRatio: number;
  /** Sortino ratio */
  sortinoRatio: number;
  /** Maximum drawdown */
  maxDrawdown: number;
  /** Maximum drawdown duration in days */
  maxDrawdownDuration: number;
  /** Calmar ratio (annualized return / max drawdown) */
  calmarRatio: number;
  /** Win rate */
  winRate: number;
  /** Profit factor (gross profit / gross loss) */
  profitFactor: number;
  /** Average trade return */
  avgTradeReturn: number;
  /** Average winning trade */
  avgWin: number;
  /** Average losing trade */
  avgLoss: number;
  /** Expectancy per trade */
  expectancy: number;
  /** Total number of trades */
  totalTrades: number;
  /** Average holding period in hours */
  avgHoldingPeriod: number;
  /** Kelly criterion optimal bet size */
  kellyFraction: number;
}

export interface PredictionMarketMetrics {
  /** Brier score (lower is better, 0-1) */
  brierScore: number;
  /** Log loss */
  logLoss: number;
  /** Calibration error */
  calibrationError: number;
  /** Resolution rate (% of positions that resolved) */
  resolutionRate: number;
  /** Accuracy on resolved markets */
  resolutionAccuracy: number;
  /** Average confidence when correct */
  avgConfidenceWhenCorrect: number;
  /** Average confidence when wrong */
  avgConfidenceWhenWrong: number;
  /** Calibration curve points */
  calibrationCurve: { predicted: number; actual: number; count: number }[];
}

// ============================================
// Data Types
// ============================================

export interface HistoricalBar {
  time: Date;
  marketId: string;
  tokenId: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap?: number;
  tradeCount?: number;
}

export interface HistoricalTrade {
  time: Date;
  marketId: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
}

export interface MarketData {
  marketId: string;
  question: string;
  category?: string;
  endDate?: Date;
  resolved: boolean;
  resolutionOutcome?: 'YES' | 'NO' | 'INVALID';
  bars: HistoricalBar[];
  trades: HistoricalTrade[];
}
