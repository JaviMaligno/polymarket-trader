/**
 * API Client for Dashboard
 */

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  const data = await response.json();
  return data.data;
}

// System
export const getStatus = () => fetchApi('/api/status');
export const startSystem = () => fetchApi('/api/system/start', { method: 'POST', body: '{}' });
export const stopSystem = () => fetchApi('/api/system/stop', { method: 'POST', body: '{}' });

// Portfolio
export const getPortfolio = () => fetchApi('/api/portfolio');
export const getPositions = () => fetchApi('/api/positions');
export const getOrders = () => fetchApi('/api/orders');

// Trading
export const submitOrder = (order: {
  marketId: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  size: number;
  type?: 'MARKET' | 'LIMIT';
  price?: number;
}) => fetchApi('/api/orders', { method: 'POST', body: JSON.stringify(order) });

export const cancelOrder = (orderId: string) =>
  fetchApi(`/api/orders/${orderId}`, { method: 'DELETE' });

export const closePosition = (marketId: string, outcome: string) =>
  fetchApi(`/api/positions/${marketId}/${outcome}/close`, { method: 'POST', body: '{}' });

// Strategies
export const getStrategies = () => fetchApi('/api/strategies');
export const startStrategy = (id: string) =>
  fetchApi(`/api/strategies/${id}/start`, { method: 'POST', body: '{}' });
export const stopStrategy = (id: string) =>
  fetchApi(`/api/strategies/${id}/stop`, { method: 'POST', body: '{}' });

// Analytics
export const getPerformance = () => fetchApi('/api/analytics/performance');
export const getEquityCurve = () => fetchApi('/api/analytics/equity-curve');

// Journal
export const getJournal = (params?: {
  page?: number;
  pageSize?: number;
  strategyId?: string;
}) => {
  const searchParams = new URLSearchParams();
  if (params?.page) searchParams.set('page', String(params.page));
  if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize));
  if (params?.strategyId) searchParams.set('strategyId', params.strategyId);
  return fetchApi(`/api/journal?${searchParams}`);
};

export const getJournalStats = () => fetchApi('/api/journal/stats');

// Alerts
export const getAlerts = (count?: number) =>
  fetchApi(`/api/alerts${count ? `?count=${count}` : ''}`);

// Markets
export const getMarkets = () => fetchApi('/api/markets');
export const getMarket = (id: string) => fetchApi(`/api/markets/${id}`);
export const subscribeMarket = (id: string) =>
  fetchApi(`/api/markets/${id}/subscribe`, { method: 'POST', body: '{}' });
export const unsubscribeMarket = (id: string) =>
  fetchApi(`/api/markets/${id}/unsubscribe`, { method: 'POST', body: '{}' });

// ============================================
// Automation API
// ============================================

// Trading Automation
export const getAutomationStatus = () => fetchApi('/api/automation/status');
export const startAutomation = () => fetchApi('/api/automation/start', { method: 'POST', body: '{}' });
export const stopAutomation = () => fetchApi('/api/automation/stop', { method: 'POST', body: '{}' });
export const sendSignal = (signal: {
  marketId: string;
  tokenId: string;
  direction: 'long' | 'short';
  strength: number;
  confidence: number;
  price: number;
}) => fetchApi('/api/automation/signal', { method: 'POST', body: JSON.stringify(signal) });

// Signal Engine
export const getSignalEngineStatus = () => fetchApi('/api/signals/status');
export const startSignalEngine = () => fetchApi('/api/signals/start', { method: 'POST', body: '{}' });
export const stopSignalEngine = () => fetchApi('/api/signals/stop', { method: 'POST', body: '{}' });
export const computeSignals = () => fetchApi('/api/signals/compute', { method: 'POST', body: '{}' });

// Polymarket Service
export const getPolymarketStatus = () => fetchApi('/api/polymarket/status');
export const startPolymarket = () => fetchApi('/api/polymarket/start', { method: 'POST', body: '{}' });
export const stopPolymarket = () => fetchApi('/api/polymarket/stop', { method: 'POST', body: '{}' });
export const discoverMarkets = () => fetchApi('/api/polymarket/discover', { method: 'POST', body: '{}' });
export const getPolymarketMarkets = () => fetchApi('/api/polymarket/markets');
export const searchPolymarketMarkets = (query: string) => fetchApi(`/api/polymarket/search?q=${encodeURIComponent(query)}`);
export const getPolymarketPrices = () => fetchApi('/api/polymarket/prices');

// Backtesting
export const getBacktestStatus = () => fetchApi('/api/backtest/status');
export const runBacktest = (params: {
  startDate: string;
  endDate: string;
  initialCapital: number;
  signalTypes?: string[];
  riskConfig?: {
    maxPositionSizePct?: number;
    maxExposurePct?: number;
    stopLossPct?: number;
  };
}) => fetchApi('/api/backtest/run', { method: 'POST', body: JSON.stringify(params) });
export const getBacktestHistory = () => fetchApi('/api/backtest/history');
export const getBacktest = (id: string) => fetchApi(`/api/backtest/${id}`);
export const getBacktestTrades = (id: string) => fetchApi(`/api/backtest/${id}/trades`);
export const getBacktestEquity = (id: string) => fetchApi(`/api/backtest/${id}/equity`);

// Paper Trading
export const getPaperTradingStatus = () => fetchApi('/api/paper-trading/status');
export const getPaperTrades = () => fetchApi('/api/paper-trading/trades');
export const getPaperPositions = () => fetchApi('/api/paper-trading/positions');
