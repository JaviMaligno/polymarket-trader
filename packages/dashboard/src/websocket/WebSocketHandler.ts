/**
 * WebSocket Handler
 *
 * Handles real-time updates to connected clients.
 */

import type { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { DashboardContext } from '../api/server.js';
import type {
  WsMessage,
  WsMessageType,
  StateUpdatePayload,
  PositionUpdatePayload,
  AlertPayload,
  PriceUpdatePayload,
} from '../types/index.js';

interface Client {
  ws: WebSocket;
  subscriptions: Set<string>;
  lastPing: Date;
}

export class WebSocketHandler {
  private clients: Map<string, Client> = new Map();
  private context: DashboardContext;
  private pingInterval: NodeJS.Timeout | null = null;
  private updateInterval: NodeJS.Timeout | null = null;

  constructor(context: DashboardContext) {
    this.context = context;
  }

  /**
   * Register WebSocket routes with Fastify
   */
  register(fastify: FastifyInstance): void {
    fastify.register(async (app) => {
      app.get('/ws', { websocket: true }, (connection) => {
        const ws = connection.socket as unknown as WebSocket;
        this.handleConnection(ws);
      });
    });
  }

  /**
   * Start broadcasting updates
   */
  start(): void {
    // Ping clients every 30 seconds
    this.pingInterval = setInterval(() => {
      this.pingClients();
    }, 30000);

    // Broadcast state updates every second
    this.updateInterval = setInterval(() => {
      this.broadcastStateUpdate();
    }, 1000);

    // Subscribe to trading system events
    this.subscribeToEvents();
  }

  /**
   * Stop broadcasting
   */
  stop(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    // Close all connections
    for (const [id, client] of this.clients) {
      try {
        client.ws.close();
      } catch {
        // Ignore close errors
      }
    }
    this.clients.clear();
  }

  /**
   * Handle new WebSocket connection
   */
  private handleConnection(ws: WebSocket): void {
    const clientId = this.generateClientId();

    const client: Client = {
      ws,
      subscriptions: new Set(['state']), // Default subscription
      lastPing: new Date(),
    };

    this.clients.set(clientId, client);

    // Send welcome message
    this.sendToClient(clientId, {
      type: 'state_update',
      payload: this.getStatePayload(),
      timestamp: new Date(),
    });

    // Handle messages
    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString()) as WsMessage;
        this.handleMessage(clientId, message);
      } catch (error) {
        this.sendError(clientId, 'Invalid message format');
      }
    });

    // Handle close
    ws.on('close', () => {
      this.clients.delete(clientId);
    });

    // Handle errors
    ws.on('error', (error) => {
      console.error(`WebSocket error for client ${clientId}:`, error);
      this.clients.delete(clientId);
    });

    // Handle pong
    ws.on('pong', () => {
      const c = this.clients.get(clientId);
      if (c) {
        c.lastPing = new Date();
      }
    });
  }

  /**
   * Handle incoming message from client
   */
  private handleMessage(clientId: string, message: WsMessage): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    switch (message.type) {
      case 'subscribe':
        if (message.channel) {
          client.subscriptions.add(message.channel);
          this.sendToClient(clientId, {
            type: 'subscribe',
            channel: message.channel,
            payload: { subscribed: true },
            timestamp: new Date(),
          });
        }
        break;

      case 'unsubscribe':
        if (message.channel) {
          client.subscriptions.delete(message.channel);
          this.sendToClient(clientId, {
            type: 'unsubscribe',
            channel: message.channel,
            payload: { unsubscribed: true },
            timestamp: new Date(),
          });
        }
        break;

      default:
        this.sendError(clientId, `Unknown message type: ${message.type}`);
    }
  }

  /**
   * Send message to specific client
   */
  private sendToClient(clientId: string, message: WsMessage): void {
    const client = this.clients.get(clientId);
    if (!client || client.ws.readyState !== 1) return; // 1 = OPEN

    try {
      client.ws.send(JSON.stringify(message));
    } catch (error) {
      console.error(`Failed to send to client ${clientId}:`, error);
      this.clients.delete(clientId);
    }
  }

  /**
   * Broadcast message to clients subscribed to a channel
   */
  private broadcast(channel: string, message: WsMessage): void {
    for (const [clientId, client] of this.clients) {
      if (client.subscriptions.has(channel) && client.ws.readyState === 1) {
        try {
          client.ws.send(JSON.stringify(message));
        } catch {
          this.clients.delete(clientId);
        }
      }
    }
  }

  /**
   * Broadcast to all connected clients
   */
  private broadcastAll(message: WsMessage): void {
    for (const [clientId, client] of this.clients) {
      if (client.ws.readyState === 1) {
        try {
          client.ws.send(JSON.stringify(message));
        } catch {
          this.clients.delete(clientId);
        }
      }
    }
  }

  /**
   * Send error to client
   */
  private sendError(clientId: string, error: string): void {
    this.sendToClient(clientId, {
      type: 'error',
      payload: { error },
      timestamp: new Date(),
    });
  }

  /**
   * Ping all clients to keep connections alive
   */
  private pingClients(): void {
    const now = new Date();
    const timeout = 60000; // 60 seconds

    for (const [clientId, client] of this.clients) {
      // Remove stale clients
      if (now.getTime() - client.lastPing.getTime() > timeout) {
        try {
          client.ws.close();
        } catch {
          // Ignore
        }
        this.clients.delete(clientId);
        continue;
      }

      // Ping active clients
      if (client.ws.readyState === 1) {
        try {
          client.ws.ping();
        } catch {
          this.clients.delete(clientId);
        }
      }
    }
  }

  /**
   * Broadcast state update to all subscribed clients
   */
  private broadcastStateUpdate(): void {
    const payload = this.getStatePayload();

    this.broadcast('state', {
      type: 'state_update',
      channel: 'state',
      payload,
      timestamp: new Date(),
    });
  }

  /**
   * Get current state payload
   */
  private getStatePayload(): StateUpdatePayload {
    const { tradingSystem } = this.context;

    if (!tradingSystem) {
      return {
        equity: 0,
        cash: 0,
        pnl: 0,
        positions: [],
        openOrders: 0,
        exposure: 0,
        drawdown: 0,
      };
    }

    const portfolio = tradingSystem.engine.getPortfolioState();
    const snapshot = tradingSystem.riskMonitor.getSnapshot();

    return {
      equity: portfolio.equity,
      cash: portfolio.cash,
      pnl: snapshot.trading.totalPnl,
      positions: portfolio.positions.map((p) => ({
        marketId: p.marketId,
        marketQuestion: p.marketId, // Would need market data
        outcome: p.outcome,
        size: p.size,
        entryPrice: p.avgEntryPrice,
        currentPrice: p.currentPrice,
        unrealizedPnl: p.unrealizedPnl,
        unrealizedPnlPct: p.avgEntryPrice > 0
          ? (p.currentPrice - p.avgEntryPrice) / p.avgEntryPrice
          : 0,
        holdingPeriod: 0, // Would need entry time
      })),
      openOrders: portfolio.openOrders.length,
      exposure: snapshot.risk.portfolioExposure,
      drawdown: snapshot.trading.currentDrawdown,
    };
  }

  /**
   * Subscribe to trading system events
   */
  private subscribeToEvents(): void {
    const { tradingSystem } = this.context;
    if (!tradingSystem) return;

    // Position updates
    tradingSystem.engine.on('position:opened', (position) => {
      this.broadcast('positions', {
        type: 'position_update',
        channel: 'positions',
        payload: {
          action: 'opened',
          position: {
            marketId: position.marketId,
            marketQuestion: position.marketId,
            outcome: position.outcome,
            size: position.size,
            entryPrice: position.avgEntryPrice,
            currentPrice: position.currentPrice,
            unrealizedPnl: position.unrealizedPnl,
            unrealizedPnlPct: 0,
            holdingPeriod: 0,
          },
        } as PositionUpdatePayload,
        timestamp: new Date(),
      });
    });

    tradingSystem.engine.on('position:closed', (position) => {
      this.broadcast('positions', {
        type: 'position_update',
        channel: 'positions',
        payload: {
          action: 'closed',
          position: {
            marketId: position.marketId,
            marketQuestion: position.marketId,
            outcome: position.outcome,
            size: position.size,
            entryPrice: position.avgEntryPrice,
            currentPrice: position.currentPrice,
            unrealizedPnl: position.unrealizedPnl,
            unrealizedPnlPct: 0,
            holdingPeriod: 0,
          },
        } as PositionUpdatePayload,
        timestamp: new Date(),
      });
    });

    // Order updates
    tradingSystem.engine.on('order:filled', (order) => {
      this.broadcast('orders', {
        type: 'order_update',
        channel: 'orders',
        payload: {
          action: 'filled',
          orderId: order.id,
          marketId: order.marketId,
          side: order.side,
          size: order.size,
          filledSize: order.filledSize,
          avgFillPrice: order.avgFillPrice,
        },
        timestamp: new Date(),
      });
    });

    // Alerts
    tradingSystem.alertSystem.on('sent', (alert, _channel) => {
      this.broadcast('alerts', {
        type: 'alert',
        channel: 'alerts',
        payload: {
          id: alert.id,
          severity: alert.severity,
          title: alert.title,
          message: alert.message,
          timestamp: alert.timestamp,
        } as AlertPayload,
        timestamp: new Date(),
      });
    });

    // Price updates
    tradingSystem.feed.on('price', (data) => {
      this.broadcast(`market:${data.marketId}`, {
        type: 'price_update',
        channel: `market:${data.marketId}`,
        payload: {
          marketId: data.marketId,
          outcome: data.outcome,
          price: data.price,
          bid: data.bid,
          ask: data.ask,
          volume: 0,
        } as PriceUpdatePayload,
        timestamp: new Date(),
      });
    });

    // Risk warnings
    tradingSystem.riskMonitor.on('limit:warning', (limitType, value, threshold) => {
      this.broadcast('risk', {
        type: 'risk_warning',
        channel: 'risk',
        payload: {
          type: limitType.toLowerCase().replace(/\s+/g, '_'),
          level: 'warning',
          current: value,
          threshold: threshold,
          message: `${limitType} approaching warning level`,
        },
        timestamp: new Date(),
      });
    });

    tradingSystem.riskMonitor.on('limit:breach', (limitType, value, threshold) => {
      this.broadcast('risk', {
        type: 'risk_warning',
        channel: 'risk',
        payload: {
          type: limitType.toLowerCase().replace(/\s+/g, '_'),
          level: 'critical',
          current: value,
          threshold: threshold,
          message: `${limitType} breached! Trading halted.`,
        },
        timestamp: new Date(),
      });
    });
  }

  /**
   * Generate unique client ID
   */
  private generateClientId(): string {
    return `client_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Get connected client count
   */
  getClientCount(): number {
    return this.clients.size;
  }
}

export function createWebSocketHandler(context: DashboardContext): WebSocketHandler {
  return new WebSocketHandler(context);
}
