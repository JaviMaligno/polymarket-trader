/**
 * Trader Package Types
 *
 * Types for live data feeds, paper trading, and strategy orchestration.
 */

// ============================================
// Market & Price Types
// ============================================

export interface LiveMarket {
  id: string;
  conditionId: string;
  question: string;
  outcomes: string[];
  outcomePrices: number[];
  volume: number;
  liquidity: number;
  endDate: Date;
  isActive: boolean;
  lastUpdate: Date;
}

export interface LivePrice {
  marketId: string;
  outcome: string;
  price: number;
  bid: number;
  ask: number;
  spread: number;
  timestamp: Date;
}

export interface OrderBook {
  marketId: string;
  outcome: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: Date;
}

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface Trade {
  marketId: string;
  outcome: string;
  price: number;
  size: number;
  side: 'BUY' | 'SELL';
  timestamp: Date;
}

// ============================================
// Order Types
// ============================================

export type OrderType = 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';
export type OrderSide = 'BUY' | 'SELL';
export type OrderStatus = 'PENDING' | 'OPEN' | 'FILLED' | 'PARTIAL' | 'CANCELLED' | 'REJECTED' | 'EXPIRED';

export interface Order {
  id: string;
  marketId: string;
  outcome: string;
  type: OrderType;
  side: OrderSide;
  size: number;
  price?: number;
  stopPrice?: number;
  status: OrderStatus;
  filledSize: number;
  avgFillPrice: number;
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
  strategyId?: string;
  metadata?: Record<string, unknown>;
}

export interface OrderRequest {
  marketId: string;
  outcome: string;
  type: OrderType;
  side: OrderSide;
  size: number;
  price?: number;
  stopPrice?: number;
  expiresAt?: Date;
  strategyId?: string;
  metadata?: Record<string, unknown>;
}

export interface OrderFill {
  orderId: string;
  marketId: string;
  outcome: string;
  side: OrderSide;
  size: number;
  price: number;
  fee: number;
  timestamp: Date;
}

// ============================================
// Position Types
// ============================================

export interface Position {
  marketId: string;
  outcome: string;
  size: number;
  avgEntryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  openedAt: Date;
  lastUpdate: Date;
}

export interface PortfolioState {
  cash: number;
  equity: number;
  positions: Position[];
  openOrders: Order[];
  totalUnrealizedPnl: number;
  totalRealizedPnl: number;
  marginUsed: number;
  marginAvailable: number;
  timestamp: Date;
}

// ============================================
// Strategy Types
// ============================================

export interface StrategyConfig {
  id: string;
  name: string;
  enabled: boolean;
  signals: string[];
  marketFilters?: MarketFilter[];
  riskLimits: StrategyRiskLimits;
  executionParams: ExecutionParams;
}

export interface MarketFilter {
  type: 'volume' | 'liquidity' | 'endDate' | 'category' | 'custom';
  params: Record<string, unknown>;
}

export interface StrategyRiskLimits {
  maxPositionSize: number;
  maxPositionPct: number;
  maxDailyLoss: number;
  maxDrawdown: number;
  maxOpenPositions: number;
  stopLossPct?: number;
  takeProfitPct?: number;
}

export interface ExecutionParams {
  orderType: OrderType;
  slippageTolerance: number;
  minEdge: number;
  minConfidence: number;
  cooldownMs: number;
  maxRetries: number;
}

export interface StrategyState {
  config: StrategyConfig;
  isRunning: boolean;
  lastSignalTime: Date | null;
  lastTradeTime: Date | null;
  todayPnl: number;
  todayTrades: number;
  positions: Position[];
  openOrders: Order[];
}

// ============================================
// Event Types
// ============================================

export type TradingEventType =
  | 'PRICE_UPDATE'
  | 'ORDER_BOOK_UPDATE'
  | 'TRADE'
  | 'ORDER_CREATED'
  | 'ORDER_FILLED'
  | 'ORDER_CANCELLED'
  | 'ORDER_REJECTED'
  | 'POSITION_OPENED'
  | 'POSITION_CLOSED'
  | 'POSITION_UPDATED'
  | 'SIGNAL_GENERATED'
  | 'STRATEGY_STARTED'
  | 'STRATEGY_STOPPED'
  | 'RISK_LIMIT_TRIGGERED'
  | 'ALERT';

export interface TradingEvent {
  type: TradingEventType;
  timestamp: Date;
  data: unknown;
}

export interface PriceUpdateEvent extends TradingEvent {
  type: 'PRICE_UPDATE';
  data: LivePrice;
}

export interface OrderEvent extends TradingEvent {
  type: 'ORDER_CREATED' | 'ORDER_FILLED' | 'ORDER_CANCELLED' | 'ORDER_REJECTED';
  data: {
    order: Order;
    fill?: OrderFill;
    reason?: string;
  };
}

export interface PositionEvent extends TradingEvent {
  type: 'POSITION_OPENED' | 'POSITION_CLOSED' | 'POSITION_UPDATED';
  data: {
    position: Position;
    previousPosition?: Position;
  };
}

export interface SignalEvent extends TradingEvent {
  type: 'SIGNAL_GENERATED';
  data: {
    strategyId: string;
    marketId: string;
    direction: 'LONG' | 'SHORT' | 'NEUTRAL';
    strength: number;
    confidence: number;
  };
}

export interface RiskEvent extends TradingEvent {
  type: 'RISK_LIMIT_TRIGGERED';
  data: {
    limitType: string;
    currentValue: number;
    limitValue: number;
    action: 'WARN' | 'REDUCE' | 'HALT';
  };
}

// ============================================
// Alert Types
// ============================================

export type AlertSeverity = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
export type AlertChannel = 'CONSOLE' | 'EMAIL' | 'SLACK' | 'WEBHOOK' | 'SMS';

export interface Alert {
  id: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  timestamp: Date;
  source: string;
  data?: Record<string, unknown>;
  acknowledged: boolean;
}

export interface AlertConfig {
  channels: AlertChannel[];
  minSeverity: AlertSeverity;
  rateLimit?: {
    maxPerMinute: number;
    maxPerHour: number;
  };
  webhookUrl?: string;
  slackWebhookUrl?: string;
  emailConfig?: {
    to: string[];
    from: string;
    smtpHost: string;
    smtpPort: number;
    smtpUser?: string;
    smtpPass?: string;
    secure?: boolean;
  };
}

// ============================================
// Monitoring Types
// ============================================

export interface SystemMetrics {
  cpuUsage: number;
  memoryUsage: number;
  eventQueueSize: number;
  latencyMs: number;
  uptime: number;
  timestamp: Date;
}

export interface TradingMetrics {
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  sharpeRatio: number;
  maxDrawdown: number;
  currentDrawdown: number;
  todayPnl: number;
  totalPnl: number;
  avgTradeSize: number;
  avgHoldTime: number;
}

export interface RiskMetrics {
  portfolioExposure: number;
  maxPositionExposure: number;
  concentrationRisk: number;
  correlationRisk: number;
  liquidityRisk: number;
  valueAtRisk: number;
}

export interface MonitoringSnapshot {
  timestamp: Date;
  system: SystemMetrics;
  trading: TradingMetrics;
  risk: RiskMetrics;
  positions: Position[];
  openOrders: Order[];
  recentAlerts: Alert[];
}

// ============================================
// Feed Types
// ============================================

export type FeedStatus = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'ERROR';

export interface FeedConfig {
  apiUrl: string;
  wsUrl?: string;
  apiKey?: string;
  reconnectIntervalMs: number;
  maxReconnectAttempts: number;
  heartbeatIntervalMs: number;
  subscriptionBatchSize: number;
}

export interface FeedState {
  status: FeedStatus;
  connectedAt: Date | null;
  lastMessageAt: Date | null;
  reconnectAttempts: number;
  subscriptions: string[];
  error: string | null;
}
