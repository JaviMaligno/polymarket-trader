/**
 * Dashboard Server
 *
 * Fastify server with REST API and WebSocket support.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';

import { registerRoutes } from './routes.js';
import { createWebSocketHandler, type WebSocketHandler } from '../websocket/WebSocketHandler.js';
import { createPerformanceAnalytics, type PerformanceAnalytics } from '../analytics/PerformanceAnalytics.js';
import { createTradeJournal, type TradeJournal } from '../analytics/TradeJournal.js';

// Re-export types needed by routes
import type { TradingSystem } from '@polymarket-trader/trader';

export interface DashboardContext {
  tradingSystem: TradingSystem | null;
  analytics: PerformanceAnalytics;
  journal: TradeJournal;
}

export interface ServerConfig {
  port: number;
  host: string;
  cors?: {
    origin: string | string[];
  };
  staticDir?: string;
}

export class DashboardServer {
  private fastify: FastifyInstance;
  private wsHandler: WebSocketHandler;
  private context: DashboardContext;
  private config: ServerConfig;

  constructor(config: ServerConfig) {
    this.config = config;

    // Initialize context
    this.context = {
      tradingSystem: null,
      analytics: createPerformanceAnalytics(),
      journal: createTradeJournal(),
    };

    // Initialize Fastify with environment-appropriate logging
    const isProduction = process.env.NODE_ENV === 'production';
    this.fastify = Fastify({
      logger: isProduction
        ? { level: 'info' }
        : {
            level: 'info',
            transport: {
              target: 'pino-pretty',
              options: {
                translateTime: 'HH:MM:ss Z',
                ignore: 'pid,hostname',
              },
            },
          },
    });

    // Initialize WebSocket handler
    this.wsHandler = createWebSocketHandler(this.context);
  }

  /**
   * Set the trading system reference
   */
  setTradingSystem(system: TradingSystem): void {
    this.context.tradingSystem = system;
  }

  /**
   * Get the trade journal
   */
  getJournal(): TradeJournal {
    return this.context.journal;
  }

  /**
   * Get the analytics module
   */
  getAnalytics(): PerformanceAnalytics {
    return this.context.analytics;
  }

  /**
   * Start the server
   */
  async start(): Promise<void> {
    // Register plugins
    await this.fastify.register(cors, {
      origin: this.config.cors?.origin ?? true,
      credentials: true,
    });

    await this.fastify.register(websocket);

    // Serve static files if directory provided
    if (this.config.staticDir) {
      await this.fastify.register(fastifyStatic, {
        root: path.resolve(this.config.staticDir),
        prefix: '/',
      });
    }

    // Register API routes
    await registerRoutes(this.fastify, this.context);

    // Register WebSocket
    this.wsHandler.register(this.fastify);

    // Start WebSocket updates
    this.wsHandler.start();

    // Start server
    try {
      await this.fastify.listen({
        port: this.config.port,
        host: this.config.host,
      });

      console.log(`Dashboard server running at http://${this.config.host}:${this.config.port}`);
    } catch (error) {
      this.fastify.log.error(error);
      throw error;
    }
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    this.wsHandler.stop();
    await this.fastify.close();
  }

  /**
   * Get server instance
   */
  getServer(): FastifyInstance {
    return this.fastify;
  }

  /**
   * Get WebSocket handler
   */
  getWebSocketHandler(): WebSocketHandler {
    return this.wsHandler;
  }
}

export function createDashboardServer(config: ServerConfig): DashboardServer {
  return new DashboardServer(config);
}
