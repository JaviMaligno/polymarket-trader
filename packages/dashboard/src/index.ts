/**
 * @polymarket-trader/dashboard
 *
 * Web dashboard and analytics for Polymarket trading.
 */

// Types
export * from './types/index.js';

// Analytics
export { PerformanceAnalytics, createPerformanceAnalytics } from './analytics/PerformanceAnalytics.js';
export { TradeJournal, createTradeJournal } from './analytics/TradeJournal.js';

// Server
export { DashboardServer, createDashboardServer, type ServerConfig, type DashboardContext } from './api/server.js';

// WebSocket
export { WebSocketHandler, createWebSocketHandler } from './websocket/WebSocketHandler.js';
