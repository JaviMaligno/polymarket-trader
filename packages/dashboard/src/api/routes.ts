/**
 * API Routes
 *
 * RESTful API endpoints for the trading dashboard.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { DashboardContext } from './server.js';
import type { JournalFilter, ApiResponse, PaginatedResponse } from '../types/index.js';

export async function registerRoutes(
  fastify: FastifyInstance,
  context: DashboardContext
): Promise<void> {
  const { tradingSystem, analytics, journal } = context;

  // ============================================
  // System Routes
  // ============================================

  fastify.get('/api/status', async (_request, reply) => {
    const isConnected = tradingSystem?.feed.getState().status === 'CONNECTED';
    const isTrading = tradingSystem ? !tradingSystem.riskMonitor.isTradingHalted() : false;

    const portfolio = tradingSystem?.engine.getPortfolioState();
    const snapshot = tradingSystem?.riskMonitor.getSnapshot();

    const response: ApiResponse<any> = {
      success: true,
      data: {
        isConnected,
        isTrading,
        lastUpdate: new Date(),
        equity: portfolio?.equity ?? 0,
        cash: portfolio?.cash ?? 0,
        totalPnl: snapshot?.trading.totalPnl ?? 0,
        todayPnl: snapshot?.trading.todayPnl ?? 0,
        openPositions: portfolio?.positions.length ?? 0,
        openOrders: portfolio?.openOrders.length ?? 0,
        exposure: snapshot?.risk.portfolioExposure ?? 0,
        drawdown: snapshot?.trading.currentDrawdown ?? 0,
        isTradingHalted: tradingSystem?.riskMonitor.isTradingHalted() ?? false,
        activeStrategies: tradingSystem?.orchestrator.getAllStrategyStates().size ?? 0,
      },
      timestamp: new Date(),
    };

    return reply.send(response);
  });

  fastify.post('/api/system/start', async (_request, reply) => {
    if (!tradingSystem) {
      return reply.status(400).send({
        success: false,
        error: 'Trading system not initialized',
        timestamp: new Date(),
      });
    }

    try {
      await tradingSystem.start();
      return reply.send({
        success: true,
        data: { message: 'System started' },
        timestamp: new Date(),
      });
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: String(error),
        timestamp: new Date(),
      });
    }
  });

  fastify.post('/api/system/stop', async (_request, reply) => {
    if (!tradingSystem) {
      return reply.status(400).send({
        success: false,
        error: 'Trading system not initialized',
        timestamp: new Date(),
      });
    }

    tradingSystem.stop();
    return reply.send({
      success: true,
      data: { message: 'System stopped' },
      timestamp: new Date(),
    });
  });

  // ============================================
  // Portfolio Routes
  // ============================================

  fastify.get('/api/portfolio', async (_request, reply) => {
    if (!tradingSystem) {
      return reply.status(400).send({
        success: false,
        error: 'Trading system not initialized',
        timestamp: new Date(),
      });
    }

    const portfolio = tradingSystem.engine.getPortfolioState();
    const stats = tradingSystem.engine.getStatistics();

    return reply.send({
      success: true,
      data: {
        equity: portfolio.equity,
        cash: portfolio.cash,
        totalUnrealizedPnl: portfolio.totalUnrealizedPnl,
        totalRealizedPnl: portfolio.totalRealizedPnl,
        positions: portfolio.positions,
        openOrders: portfolio.openOrders,
        stats: {
          totalPnl: stats.totalPnl,
          totalTrades: stats.totalTrades,
          winRate: stats.winRate,
          totalFees: stats.totalFees,
        },
      },
      timestamp: new Date(),
    });
  });

  fastify.get('/api/positions', async (_request, reply) => {
    if (!tradingSystem) {
      return reply.status(400).send({
        success: false,
        error: 'Trading system not initialized',
        timestamp: new Date(),
      });
    }

    const positions = tradingSystem.engine.getAllPositions();

    return reply.send({
      success: true,
      data: positions,
      timestamp: new Date(),
    });
  });

  fastify.get('/api/orders', async (_request, reply) => {
    if (!tradingSystem) {
      return reply.status(400).send({
        success: false,
        error: 'Trading system not initialized',
        timestamp: new Date(),
      });
    }

    const orders = tradingSystem.engine.getOpenOrders();

    return reply.send({
      success: true,
      data: orders,
      timestamp: new Date(),
    });
  });

  // ============================================
  // Trading Routes
  // ============================================

  interface OrderBody {
    marketId: string;
    outcome: string;
    side: 'BUY' | 'SELL';
    size: number;
    type?: 'MARKET' | 'LIMIT';
    price?: number;
  }

  fastify.post<{ Body: OrderBody }>('/api/orders', async (request, reply) => {
    if (!tradingSystem) {
      return reply.status(400).send({
        success: false,
        error: 'Trading system not initialized',
        timestamp: new Date(),
      });
    }

    const { marketId, outcome, side, size, type = 'MARKET', price } = request.body;

    try {
      const order = await tradingSystem.engine.submitOrder({
        marketId,
        outcome,
        side,
        size,
        type,
        price,
      });

      // Record in journal
      const market = tradingSystem.feed.getMarket(marketId);
      journal.recordTrade({
        timestamp: new Date(),
        marketId,
        marketQuestion: market?.question ?? marketId,
        outcome,
        side,
        size,
        price: order.avgFillPrice || price || 0,
        fees: 0, // Fees calculated separately
      });

      return reply.send({
        success: true,
        data: order,
        timestamp: new Date(),
      });
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: String(error),
        timestamp: new Date(),
      });
    }
  });

  fastify.delete<{ Params: { orderId: string } }>('/api/orders/:orderId', async (request, reply) => {
    if (!tradingSystem) {
      return reply.status(400).send({
        success: false,
        error: 'Trading system not initialized',
        timestamp: new Date(),
      });
    }

    const { orderId } = request.params;

    try {
      const success = await tradingSystem.engine.cancelOrder(orderId);
      return reply.send({
        success,
        data: { cancelled: success },
        timestamp: new Date(),
      });
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: String(error),
        timestamp: new Date(),
      });
    }
  });

  fastify.post<{ Params: { marketId: string; outcome: string } }>(
    '/api/positions/:marketId/:outcome/close',
    async (request, reply) => {
      if (!tradingSystem) {
        return reply.status(400).send({
          success: false,
          error: 'Trading system not initialized',
          timestamp: new Date(),
        });
      }

      const { marketId, outcome } = request.params;

      try {
        const order = await tradingSystem.engine.closePosition(marketId, outcome);
        return reply.send({
          success: true,
          data: order,
          timestamp: new Date(),
        });
      } catch (error) {
        return reply.status(500).send({
          success: false,
          error: String(error),
          timestamp: new Date(),
        });
      }
    }
  );

  // ============================================
  // Strategy Routes
  // ============================================

  fastify.get('/api/strategies', async (_request, reply) => {
    if (!tradingSystem) {
      return reply.status(400).send({
        success: false,
        error: 'Trading system not initialized',
        timestamp: new Date(),
      });
    }

    const strategies = tradingSystem.orchestrator.getAllStrategyStates();
    const data = Array.from(strategies.entries()).map(([id, state]) => ({
      id,
      ...state,
    }));

    return reply.send({
      success: true,
      data,
      timestamp: new Date(),
    });
  });

  fastify.post<{ Params: { strategyId: string } }>(
    '/api/strategies/:strategyId/start',
    async (request, reply) => {
      if (!tradingSystem) {
        return reply.status(400).send({
          success: false,
          error: 'Trading system not initialized',
          timestamp: new Date(),
        });
      }

      const { strategyId } = request.params;

      try {
        tradingSystem.orchestrator.startStrategy(strategyId);
        return reply.send({
          success: true,
          data: { message: `Strategy ${strategyId} started` },
          timestamp: new Date(),
        });
      } catch (error) {
        return reply.status(500).send({
          success: false,
          error: String(error),
          timestamp: new Date(),
        });
      }
    }
  );

  fastify.post<{ Params: { strategyId: string } }>(
    '/api/strategies/:strategyId/stop',
    async (request, reply) => {
      if (!tradingSystem) {
        return reply.status(400).send({
          success: false,
          error: 'Trading system not initialized',
          timestamp: new Date(),
        });
      }

      const { strategyId } = request.params;

      try {
        tradingSystem.orchestrator.stopStrategy(strategyId);
        return reply.send({
          success: true,
          data: { message: `Strategy ${strategyId} stopped` },
          timestamp: new Date(),
        });
      } catch (error) {
        return reply.status(500).send({
          success: false,
          error: String(error),
          timestamp: new Date(),
        });
      }
    }
  );

  // ============================================
  // Analytics Routes
  // ============================================

  fastify.get('/api/analytics/performance', async (_request, reply) => {
    if (!tradingSystem) {
      return reply.status(400).send({
        success: false,
        error: 'Trading system not initialized',
        timestamp: new Date(),
      });
    }

    // Build equity history from current state
    const portfolio = tradingSystem.engine.getPortfolioState();
    const equityHistory = [
      { timestamp: new Date(), equity: portfolio.equity },
    ];

    // Get closed trades from journal
    const closedTrades = journal.getClosedTrades().map((t) => ({
      timestamp: t.timestamp,
      pnl: t.realizedPnl ?? 0,
      holdingPeriod: t.holdingPeriod ?? 0,
      side: t.side,
    }));

    const initialCapital = 10000; // Should come from config
    const metrics = analytics.calculateMetrics(equityHistory, closedTrades, initialCapital);

    return reply.send({
      success: true,
      data: metrics,
      timestamp: new Date(),
    });
  });

  fastify.get('/api/analytics/equity-curve', async (_request, reply) => {
    if (!tradingSystem) {
      return reply.status(400).send({
        success: false,
        error: 'Trading system not initialized',
        timestamp: new Date(),
      });
    }

    // Build equity history from current state
    const portfolio = tradingSystem.engine.getPortfolioState();
    const equityHistory = [
      { timestamp: new Date(), equity: portfolio.equity },
    ];

    const curveData = analytics.generateEquityCurve(equityHistory);

    return reply.send({
      success: true,
      data: curveData,
      timestamp: new Date(),
    });
  });

  // ============================================
  // Journal Routes
  // ============================================

  interface JournalQuery {
    page?: number;
    pageSize?: number;
    strategyId?: string;
    marketId?: string;
    startDate?: string;
    endDate?: string;
  }

  fastify.get<{ Querystring: JournalQuery }>('/api/journal', async (request, reply) => {
    const { page = 1, pageSize = 20, strategyId, marketId, startDate, endDate } = request.query;

    const filter: JournalFilter = {};
    if (strategyId) filter.strategyId = strategyId;
    if (marketId) filter.marketId = marketId;
    if (startDate) filter.startDate = new Date(startDate);
    if (endDate) filter.endDate = new Date(endDate);

    const entries = journal.getEntries(filter);
    const total = entries.length;
    const start = (page - 1) * pageSize;
    const items = entries.slice(start, start + pageSize);

    const response: ApiResponse<PaginatedResponse<any>> = {
      success: true,
      data: {
        items,
        total,
        page,
        pageSize,
        hasMore: start + pageSize < total,
      },
      timestamp: new Date(),
    };

    return reply.send(response);
  });

  fastify.get('/api/journal/stats', async (_request, reply) => {
    const stats = journal.getStats();

    return reply.send({
      success: true,
      data: stats,
      timestamp: new Date(),
    });
  });

  fastify.get<{ Params: { id: string } }>('/api/journal/:id', async (request, reply) => {
    const { id } = request.params;
    const entry = journal.getTrade(id);

    if (!entry) {
      return reply.status(404).send({
        success: false,
        error: 'Trade not found',
        timestamp: new Date(),
      });
    }

    return reply.send({
      success: true,
      data: entry,
      timestamp: new Date(),
    });
  });

  interface NoteBody {
    notes: string;
  }

  fastify.patch<{ Params: { id: string }; Body: NoteBody }>(
    '/api/journal/:id/notes',
    async (request, reply) => {
      const { id } = request.params;
      const { notes } = request.body;

      const entry = journal.addNotes(id, notes);

      if (!entry) {
        return reply.status(404).send({
          success: false,
          error: 'Trade not found',
          timestamp: new Date(),
        });
      }

      return reply.send({
        success: true,
        data: entry,
        timestamp: new Date(),
      });
    }
  );

  // ============================================
  // Alerts Routes
  // ============================================

  fastify.get<{ Querystring: { count?: number } }>('/api/alerts', async (request, reply) => {
    if (!tradingSystem) {
      return reply.status(400).send({
        success: false,
        error: 'Trading system not initialized',
        timestamp: new Date(),
      });
    }

    const { count = 50 } = request.query;
    const alerts = tradingSystem.alertSystem.getHistory(count);

    return reply.send({
      success: true,
      data: alerts,
      timestamp: new Date(),
    });
  });

  // ============================================
  // Markets Routes
  // ============================================

  fastify.get('/api/markets', async (_request, reply) => {
    if (!tradingSystem) {
      return reply.status(400).send({
        success: false,
        error: 'Trading system not initialized',
        timestamp: new Date(),
      });
    }

    const subscriptions = tradingSystem.feed.getSubscriptions();
    const markets = subscriptions.map((id) => {
      const market = tradingSystem.feed.getMarket(id);
      return market ?? { id, question: 'Loading...', isActive: false };
    });

    return reply.send({
      success: true,
      data: markets,
      timestamp: new Date(),
    });
  });

  fastify.get<{ Params: { marketId: string } }>('/api/markets/:marketId', async (request, reply) => {
    if (!tradingSystem) {
      return reply.status(400).send({
        success: false,
        error: 'Trading system not initialized',
        timestamp: new Date(),
      });
    }

    const { marketId } = request.params;
    const market = tradingSystem.feed.getMarket(marketId);

    if (!market) {
      return reply.status(404).send({
        success: false,
        error: 'Market not found',
        timestamp: new Date(),
      });
    }

    // Get prices for all outcomes
    const prices = market.outcomes.map((outcome) => ({
      outcome,
      ...tradingSystem.feed.getPrice(marketId, outcome),
    }));

    return reply.send({
      success: true,
      data: { ...market, prices },
      timestamp: new Date(),
    });
  });

  fastify.post<{ Params: { marketId: string } }>('/api/markets/:marketId/subscribe', async (request, reply) => {
    if (!tradingSystem) {
      return reply.status(400).send({
        success: false,
        error: 'Trading system not initialized',
        timestamp: new Date(),
      });
    }

    const { marketId } = request.params;
    tradingSystem.feed.subscribe(marketId);

    return reply.send({
      success: true,
      data: { message: `Subscribed to ${marketId}` },
      timestamp: new Date(),
    });
  });

  fastify.post<{ Params: { marketId: string } }>('/api/markets/:marketId/unsubscribe', async (request, reply) => {
    if (!tradingSystem) {
      return reply.status(400).send({
        success: false,
        error: 'Trading system not initialized',
        timestamp: new Date(),
      });
    }

    const { marketId } = request.params;
    tradingSystem.feed.unsubscribe(marketId);

    return reply.send({
      success: true,
      data: { message: `Unsubscribed from ${marketId}` },
      timestamp: new Date(),
    });
  });

  // Health check
  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: new Date() };
  });
}
