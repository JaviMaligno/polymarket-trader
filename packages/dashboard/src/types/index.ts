/**
 * Dashboard Types
 *
 * Type definitions for analytics, API, and WebSocket.
 */

// ============================================
// Performance Analytics Types
// ============================================

export interface PerformanceMetrics {
  // Returns
  totalReturn: number;
  annualizedReturn: number;
  dailyReturns: number[];
  cumulativeReturns: number[];

  // Risk
  volatility: number;
  sharpeRatio: number;
  sortinoRatio: number;
  maxDrawdown: number;
  maxDrawdownDuration: number; // days
  calmarRatio: number;

  // Trading
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  avgHoldingPeriod: number; // hours

  // Exposure
  avgExposure: number;
  maxExposure: number;
  timeInMarket: number;
}

export interface DailyPerformance {
  date: Date;
  equity: number;
  pnl: number;
  return: number;
  trades: number;
  exposure: number;
  drawdown: number;
}

export interface StrategyPerformance {
  strategyId: string;
  strategyName: string;
  metrics: PerformanceMetrics;
  dailyPerformance: DailyPerformance[];
  positions: PositionSummary[];
  recentTrades: TradeSummary[];
}

export interface PositionSummary {
  marketId: string;
  marketQuestion: string;
  outcome: string;
  size: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  holdingPeriod: number; // hours
  strategyId?: string;
}

export interface TradeSummary {
  id: string;
  timestamp: Date;
  marketId: string;
  marketQuestion: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  fees: number;
  pnl?: number;
  strategyId?: string;
}

// ============================================
// Trade Journal Types
// ============================================

export interface TradeEntry {
  id: string;
  timestamp: Date;

  // Trade details
  marketId: string;
  marketQuestion: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  fees: number;

  // Context
  strategyId?: string;
  signalStrength?: number;
  confidence?: number;

  // Result (filled when closed)
  exitTimestamp?: Date;
  exitPrice?: number;
  exitFees?: number;
  realizedPnl?: number;
  holdingPeriod?: number;

  // Notes
  notes?: string;
  tags?: string[];
}

export interface JournalFilter {
  startDate?: Date;
  endDate?: Date;
  strategyId?: string;
  marketId?: string;
  side?: 'BUY' | 'SELL';
  minPnl?: number;
  maxPnl?: number;
  tags?: string[];
}

export interface JournalStats {
  totalEntries: number;
  openPositions: number;
  closedTrades: number;
  totalPnl: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  bestTrade: TradeSummary | null;
  worstTrade: TradeSummary | null;
}

// ============================================
// API Types
// ============================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: Date;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

// Dashboard state
export interface DashboardState {
  isConnected: boolean;
  isTrading: boolean;
  lastUpdate: Date;

  // Portfolio
  equity: number;
  cash: number;
  totalPnl: number;
  todayPnl: number;

  // Positions
  openPositions: number;
  openOrders: number;

  // Risk
  exposure: number;
  drawdown: number;
  isTradingHalted: boolean;

  // Strategies
  activeStrategies: number;
  totalStrategies: number;
}

// ============================================
// WebSocket Types
// ============================================

export type WsMessageType =
  | 'subscribe'
  | 'unsubscribe'
  | 'state_update'
  | 'position_update'
  | 'order_update'
  | 'trade_executed'
  | 'alert'
  | 'price_update'
  | 'strategy_signal'
  | 'risk_warning'
  | 'error';

export interface WsMessage {
  type: WsMessageType;
  channel?: string;
  payload: unknown;
  timestamp: Date;
}

export interface WsSubscription {
  channel: string;
  params?: Record<string, unknown>;
}

// State update payloads
export interface StateUpdatePayload {
  equity: number;
  cash: number;
  pnl: number;
  positions: PositionSummary[];
  openOrders: number;
  exposure: number;
  drawdown: number;
}

export interface PositionUpdatePayload {
  action: 'opened' | 'updated' | 'closed';
  position: PositionSummary;
}

export interface OrderUpdatePayload {
  action: 'created' | 'filled' | 'cancelled' | 'rejected';
  orderId: string;
  marketId: string;
  side: 'BUY' | 'SELL';
  size: number;
  price?: number;
  filledSize?: number;
  avgFillPrice?: number;
}

export interface TradeExecutedPayload {
  trade: TradeSummary;
}

export interface AlertPayload {
  id: string;
  severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
  title: string;
  message: string;
  timestamp: Date;
}

export interface PriceUpdatePayload {
  marketId: string;
  outcome: string;
  price: number;
  bid: number;
  ask: number;
  volume: number;
}

export interface StrategySignalPayload {
  strategyId: string;
  marketId: string;
  outcome: string;
  direction: 'BUY' | 'SELL' | 'HOLD';
  strength: number;
  confidence: number;
}

export interface RiskWarningPayload {
  type: 'exposure' | 'drawdown' | 'daily_loss' | 'position_size';
  level: 'warning' | 'critical';
  current: number;
  threshold: number;
  message: string;
}

// ============================================
// Chart Types
// ============================================

export interface ChartDataPoint {
  timestamp: Date;
  value: number;
}

export interface CandlestickData {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface EquityCurveData {
  points: ChartDataPoint[];
  benchmark?: ChartDataPoint[];
  drawdowns: Array<{
    start: Date;
    end: Date;
    depth: number;
  }>;
}

export interface TradeDistribution {
  pnlBuckets: Array<{
    range: string;
    count: number;
  }>;
  holdingPeriodBuckets: Array<{
    range: string;
    count: number;
  }>;
  hourlyDistribution: number[]; // 24 hours
  dailyDistribution: number[]; // 7 days
}
