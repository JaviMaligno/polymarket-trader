/**
 * API Types for the Dashboard Frontend
 */

export interface DashboardState {
  isConnected: boolean;
  isTrading: boolean;
  lastUpdate: Date;
  equity: number;
  cash: number;
  totalPnl: number;
  todayPnl: number;
  openPositions: number;
  openOrders: number;
  exposure: number;
  drawdown: number;
  isTradingHalted: boolean;
  activeStrategies: number;
}

export interface Position {
  marketId: string;
  outcome: string;
  size: number;
  avgEntryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  openedAt: Date;
}

export interface Order {
  id: string;
  marketId: string;
  outcome: string;
  type: 'MARKET' | 'LIMIT' | 'STOP';
  side: 'BUY' | 'SELL';
  size: number;
  price?: number;
  status: string;
  createdAt: Date;
}

export interface TradeEntry {
  id: string;
  timestamp: Date;
  marketId: string;
  marketQuestion: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  fees: number;
  realizedPnl?: number;
  strategyId?: string;
}

export interface PerformanceMetrics {
  totalReturn: number;
  annualizedReturn: number;
  volatility: number;
  sharpeRatio: number;
  sortinoRatio: number;
  maxDrawdown: number;
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
}

export interface JournalStats {
  totalEntries: number;
  openPositions: number;
  closedTrades: number;
  totalPnl: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
}

export interface Alert {
  id: string;
  severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
  title: string;
  message: string;
  timestamp: Date;
}

export interface Strategy {
  id: string;
  name: string;
  isRunning: boolean;
  todayPnl: number;
  todayTrades: number;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: Date;
}
