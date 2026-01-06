/**
 * API Routes
 *
 * RESTful API endpoints for the trading dashboard.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { DashboardContext } from './server.js';
import type { JournalFilter, ApiResponse, PaginatedResponse } from '../types/index.js';
import { healthCheck as dbHealthCheck, isDatabaseConfigured } from '../database/index.js';
import {
  signalPredictionsRepo,
  signalWeightsRepo,
  paperTradesRepo,
  paperPositionsRepo,
  portfolioSnapshotsRepo,
} from '../database/repositories.js';
import { query } from '../database/index.js';
import { getPaperTradingService } from '../services/PaperTradingService.js';

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

  // Create a new strategy
  fastify.post<{
    Body: {
      type: 'momentum' | 'mean_reversion' | 'combo';
      name?: string;
      maxPositionPct?: number;
      minEdge?: number;
      minConfidence?: number;
      disableFilters?: boolean;
    };
  }>('/api/strategies', async (request, reply) => {
    if (!tradingSystem) {
      return reply.status(400).send({
        success: false,
        error: 'Trading system not initialized',
        timestamp: new Date(),
      });
    }

    const {
      type = 'momentum',
      name,
      maxPositionPct = 0.05,
      minEdge = 0.02,
      minConfidence = 0.6,
      disableFilters = false,
    } = request.body || {};

    try {
      // Import signal creators dynamically
      const { createSignal, WeightedAverageCombiner } = await import('@polymarket-trader/signals');

      let strategyId: string;
      let strategyName: string;
      let signals: any[];
      let weightsMap: Record<string, number>;

      switch (type) {
        case 'momentum':
          strategyId = `momentum-${Date.now()}`;
          strategyName = name || 'Momentum Strategy';
          signals = [createSignal('momentum')];
          weightsMap = { momentum: 1.0 };
          break;

        case 'mean_reversion':
          strategyId = `meanrev-${Date.now()}`;
          strategyName = name || 'Mean Reversion Strategy';
          signals = [createSignal('mean_reversion')];
          weightsMap = { mean_reversion: 1.0 };
          break;

        case 'combo':
          strategyId = `combo-${Date.now()}`;
          strategyName = name || 'Combined Strategy';
          signals = [createSignal('momentum'), createSignal('mean_reversion')];
          weightsMap = { momentum: 0.6, mean_reversion: 0.4 };
          break;

        default:
          return reply.status(400).send({
            success: false,
            error: `Unknown strategy type: ${type}`,
            timestamp: new Date(),
          });
      }

      const combiner = new WeightedAverageCombiner(weightsMap);

      const config = {
        id: strategyId,
        name: strategyName,
        enabled: true,
        signals: signals.map((s: any) => s.signalId),
        riskLimits: {
          maxPositionPct,
          maxDailyLoss: 200,
          maxDrawdown: 0.05,
          maxOpenPositions: 5,
          maxPositionSize: 500,
          stopLossPct: 0.1,
          takeProfitPct: 0.2,
        },
        executionParams: {
          orderType: 'MARKET' as const,
          slippageTolerance: 0.01,
          minEdge,
          minConfidence,
          cooldownMs: 30000,
          maxRetries: 2,
        },
        marketFilters: disableFilters ? [] : [
          { type: 'volume' as const, params: { minVolume: 1000 } },
          { type: 'liquidity' as const, params: { minLiquidity: 500 } },
        ],
      };

      tradingSystem.orchestrator.registerStrategy(config, signals, combiner);

      return reply.send({
        success: true,
        data: {
          id: strategyId,
          name: strategyName,
          type,
          config,
          message: `Strategy ${strategyId} created successfully`,
        },
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
    const dbHealth = isDatabaseConfigured() ? await dbHealthCheck() : { connected: false, error: 'Not configured' };

    return {
      status: 'ok',
      timestamp: new Date(),
      database: {
        configured: isDatabaseConfigured(),
        connected: dbHealth.connected,
        latency: dbHealth.latency,
        error: dbHealth.error,
      },
    };
  });

  // ============================================
  // Signal & Paper Trading Routes (Database)
  // ============================================

  // Signal weights
  fastify.get('/api/signals/weights', async (_request, reply) => {
    if (!isDatabaseConfigured()) {
      return reply.status(503).send({
        success: false,
        error: 'Database not configured',
        timestamp: new Date(),
      });
    }

    try {
      const weights = await signalWeightsRepo.getAll();
      return reply.send({
        success: true,
        data: weights,
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

  // Signal accuracy metrics
  fastify.get<{ Querystring: { days?: number } }>('/api/signals/accuracy', async (request, reply) => {
    if (!isDatabaseConfigured()) {
      return reply.status(503).send({
        success: false,
        error: 'Database not configured',
        timestamp: new Date(),
      });
    }

    try {
      const { days = 7 } = request.query;
      const accuracy = await signalPredictionsRepo.getAccuracyByType(days);
      return reply.send({
        success: true,
        data: accuracy,
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

  // Signal weight history
  fastify.get<{ Params: { signalType: string }; Querystring: { limit?: number } }>(
    '/api/signals/:signalType/history',
    async (request, reply) => {
      if (!isDatabaseConfigured()) {
        return reply.status(503).send({
          success: false,
          error: 'Database not configured',
          timestamp: new Date(),
        });
      }

      try {
        const { signalType } = request.params;
        const { limit = 50 } = request.query;
        const history = await signalWeightsRepo.getHistory(signalType, limit);
        return reply.send({
          success: true,
          data: history,
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

  // Paper trades
  fastify.get<{ Querystring: { limit?: number } }>('/api/paper-trades', async (request, reply) => {
    if (!isDatabaseConfigured()) {
      return reply.status(503).send({
        success: false,
        error: 'Database not configured',
        timestamp: new Date(),
      });
    }

    try {
      const { limit = 50 } = request.query;
      const trades = await paperTradesRepo.getRecent(limit);
      return reply.send({
        success: true,
        data: trades,
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

  // Paper positions
  fastify.get('/api/paper-positions', async (_request, reply) => {
    if (!isDatabaseConfigured()) {
      return reply.status(503).send({
        success: false,
        error: 'Database not configured',
        timestamp: new Date(),
      });
    }

    try {
      const positions = await paperPositionsRepo.getAll();
      return reply.send({
        success: true,
        data: positions,
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

  // Portfolio equity curve
  fastify.get<{ Querystring: { days?: number } }>('/api/portfolio/equity-curve', async (request, reply) => {
    if (!isDatabaseConfigured()) {
      return reply.status(503).send({
        success: false,
        error: 'Database not configured',
        timestamp: new Date(),
      });
    }

    try {
      const { days = 30 } = request.query;
      const curve = await portfolioSnapshotsRepo.getEquityCurve(days);
      return reply.send({
        success: true,
        data: curve,
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

  // Portfolio snapshot (latest)
  fastify.get('/api/portfolio/snapshot', async (_request, reply) => {
    if (!isDatabaseConfigured()) {
      return reply.status(503).send({
        success: false,
        error: 'Database not configured',
        timestamp: new Date(),
      });
    }

    try {
      const snapshot = await portfolioSnapshotsRepo.getLatest();
      return reply.send({
        success: true,
        data: snapshot,
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

  // ============================================
  // Paper Trading Account Routes
  // ============================================

  // Get paper account state
  fastify.get('/api/paper/account', async (_request, reply) => {
    if (!isDatabaseConfigured()) {
      return reply.status(503).send({
        success: false,
        error: 'Database not configured',
        timestamp: new Date(),
      });
    }

    try {
      const result = await query<{
        initial_capital: string;
        current_capital: string;
        available_capital: string;
        total_realized_pnl: string;
        total_unrealized_pnl: string;
        total_fees_paid: string;
        max_drawdown: string;
        peak_equity: string;
        total_trades: number;
        winning_trades: number;
        losing_trades: number;
        updated_at: Date;
      }>('SELECT * FROM paper_account LIMIT 1');

      const account = result.rows[0];
      if (!account) {
        return reply.send({
          success: true,
          data: {
            initial_capital: 10000,
            current_capital: 10000,
            available_capital: 10000,
            total_realized_pnl: 0,
            total_unrealized_pnl: 0,
            total_fees_paid: 0,
            max_drawdown: 0,
            total_trades: 0,
            winning_trades: 0,
            losing_trades: 0,
            win_rate: 0,
          },
          timestamp: new Date(),
        });
      }

      const totalTrades = account.total_trades || 0;
      const winningTrades = account.winning_trades || 0;

      return reply.send({
        success: true,
        data: {
          initial_capital: parseFloat(account.initial_capital),
          current_capital: parseFloat(account.current_capital),
          available_capital: parseFloat(account.available_capital),
          total_realized_pnl: parseFloat(account.total_realized_pnl || '0'),
          total_unrealized_pnl: parseFloat(account.total_unrealized_pnl || '0'),
          total_fees_paid: parseFloat(account.total_fees_paid || '0'),
          max_drawdown: parseFloat(account.max_drawdown || '0'),
          peak_equity: parseFloat(account.peak_equity || account.current_capital),
          total_trades: totalTrades,
          winning_trades: winningTrades,
          losing_trades: account.losing_trades || 0,
          win_rate: totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0,
          updated_at: account.updated_at,
        },
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

  // Submit a paper trade (manual or from signal)
  interface PaperTradeBody {
    market_id: string;
    token_id: string;
    side: 'buy' | 'sell';
    size: number;
    price: number;
    signal_type?: string;
    best_bid?: number;
    best_ask?: number;
  }

  fastify.post<{ Body: PaperTradeBody }>('/api/paper-trades', async (request, reply) => {
    if (!isDatabaseConfigured()) {
      return reply.status(503).send({
        success: false,
        error: 'Database not configured',
        timestamp: new Date(),
      });
    }

    try {
      const { market_id, token_id, side, size, price, signal_type, best_bid, best_ask } = request.body;

      // Get current account state
      const accountResult = await query<{
        current_capital: string;
        available_capital: string;
        total_fees_paid: string;
        total_trades: number;
      }>('SELECT current_capital, available_capital, total_fees_paid, total_trades FROM paper_account LIMIT 1');

      const account = accountResult.rows[0];
      if (!account) {
        return reply.status(400).send({
          success: false,
          error: 'Paper account not initialized',
          timestamp: new Date(),
        });
      }

      const availableCapital = parseFloat(account.available_capital);
      const orderValue = size * price;
      const feeRate = 0.001; // 0.1% fee
      const fee = orderValue * feeRate;
      const totalCost = orderValue + fee;

      // Check if we have enough capital for buy orders
      if (side === 'buy' && totalCost > availableCapital) {
        return reply.status(400).send({
          success: false,
          error: `Insufficient capital. Available: $${availableCapital.toFixed(2)}, Required: $${totalCost.toFixed(2)}`,
          timestamp: new Date(),
        });
      }

      // Calculate slippage (simulated)
      const slippagePct = best_ask && best_bid
        ? side === 'buy'
          ? ((price - best_ask) / best_ask) * 100
          : ((best_bid - price) / best_bid) * 100
        : 0;

      // Create the trade
      const trade = await paperTradesRepo.create({
        time: new Date(),
        market_id,
        token_id,
        side,
        requested_size: size,
        executed_size: size,
        requested_price: price,
        executed_price: price,
        slippage_pct: slippagePct,
        fee,
        value_usd: orderValue,
        signal_type,
        order_type: 'market',
        fill_type: 'full',
        best_bid,
        best_ask,
      });

      // Update paper account
      const newCapital = side === 'buy'
        ? parseFloat(account.current_capital) - totalCost
        : parseFloat(account.current_capital) + orderValue - fee;

      const newAvailable = side === 'buy'
        ? availableCapital - totalCost
        : availableCapital + orderValue - fee;

      await query(
        `UPDATE paper_account SET
          current_capital = $1,
          available_capital = $2,
          total_fees_paid = total_fees_paid + $3,
          total_trades = total_trades + 1,
          updated_at = NOW()
        WHERE id = 1`,
        [newCapital, newAvailable, fee]
      );

      // Update or create position
      const positionResult = await query<{ size: string; avg_entry_price: string }>(
        'SELECT size, avg_entry_price FROM paper_positions WHERE market_id = $1',
        [market_id]
      );

      const existingPosition = positionResult.rows[0];

      if (side === 'buy') {
        if (existingPosition) {
          // Average into existing position
          const currentSize = parseFloat(existingPosition.size);
          const currentAvg = parseFloat(existingPosition.avg_entry_price);
          const newSize = currentSize + size;
          const newAvg = (currentSize * currentAvg + size * price) / newSize;

          await paperPositionsRepo.upsert({
            market_id,
            token_id,
            side: 'long',
            size: newSize,
            avg_entry_price: newAvg,
            current_price: price,
            unrealized_pnl: 0,
            opened_at: new Date(),
            signal_type,
          });
        } else {
          // Open new position
          await paperPositionsRepo.upsert({
            market_id,
            token_id,
            side: 'long',
            size,
            avg_entry_price: price,
            current_price: price,
            unrealized_pnl: 0,
            opened_at: new Date(),
            signal_type,
          });
        }
      } else if (side === 'sell' && existingPosition) {
        const currentSize = parseFloat(existingPosition.size);
        const currentAvg = parseFloat(existingPosition.avg_entry_price);
        const pnl = (price - currentAvg) * Math.min(size, currentSize);

        // Update account with realized PnL
        const isWin = pnl > 0;
        await query(
          `UPDATE paper_account SET
            total_realized_pnl = total_realized_pnl + $1,
            winning_trades = winning_trades + $2,
            losing_trades = losing_trades + $3,
            updated_at = NOW()
          WHERE id = 1`,
          [pnl, isWin ? 1 : 0, isWin ? 0 : 1]
        );

        if (size >= currentSize) {
          // Close position
          await paperPositionsRepo.close(market_id);
        } else {
          // Reduce position
          await paperPositionsRepo.upsert({
            market_id,
            token_id,
            side: 'long',
            size: currentSize - size,
            avg_entry_price: currentAvg,
            current_price: price,
            unrealized_pnl: 0,
            realized_pnl: pnl,
            opened_at: new Date(),
            signal_type,
          });
        }
      }

      return reply.send({
        success: true,
        data: {
          trade,
          fee,
          new_capital: newCapital,
          new_available: newAvailable,
        },
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

  // Reset paper account
  fastify.post('/api/paper/account/reset', async (_request, reply) => {
    if (!isDatabaseConfigured()) {
      return reply.status(503).send({
        success: false,
        error: 'Database not configured',
        timestamp: new Date(),
      });
    }

    try {
      // Reset account to initial state
      await query(
        `UPDATE paper_account SET
          current_capital = initial_capital,
          available_capital = initial_capital,
          total_realized_pnl = 0,
          total_unrealized_pnl = 0,
          total_fees_paid = 0,
          max_drawdown = 0,
          peak_equity = initial_capital,
          total_trades = 0,
          winning_trades = 0,
          losing_trades = 0,
          updated_at = NOW()
        WHERE id = 1`
      );

      // Clear positions
      await query('DELETE FROM paper_positions');

      // Note: We keep trade history for analysis

      return reply.send({
        success: true,
        data: { message: 'Paper account reset successfully' },
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

  // Take a portfolio snapshot
  fastify.post('/api/paper/snapshot', async (_request, reply) => {
    if (!isDatabaseConfigured()) {
      return reply.status(503).send({
        success: false,
        error: 'Database not configured',
        timestamp: new Date(),
      });
    }

    try {
      // Get current account state
      const accountResult = await query<{
        initial_capital: string;
        current_capital: string;
        available_capital: string;
        total_realized_pnl: string;
        total_trades: number;
        winning_trades: number;
        losing_trades: number;
        max_drawdown: string;
      }>('SELECT * FROM paper_account LIMIT 1');

      const account = accountResult.rows[0];
      if (!account) {
        return reply.status(400).send({
          success: false,
          error: 'Paper account not initialized',
          timestamp: new Date(),
        });
      }

      // Get positions for exposure calculation
      const positionsResult = await query<{ size: string; current_price: string }>(
        'SELECT size, current_price FROM paper_positions'
      );

      const totalExposure = positionsResult.rows.reduce(
        (sum, p) => sum + parseFloat(p.size) * parseFloat(p.current_price || '0'),
        0
      );

      const initialCapital = parseFloat(account.initial_capital);
      const currentCapital = parseFloat(account.current_capital);
      const totalPnl = currentCapital - initialCapital;
      const totalPnlPct = (totalPnl / initialCapital) * 100;
      const totalTrades = account.total_trades || 0;
      const winningTrades = account.winning_trades || 0;

      await portfolioSnapshotsRepo.create({
        time: new Date(),
        initial_capital: initialCapital,
        current_capital: currentCapital,
        available_capital: parseFloat(account.available_capital),
        total_pnl: totalPnl,
        total_pnl_pct: totalPnlPct,
        max_drawdown: parseFloat(account.max_drawdown || '0'),
        total_trades: totalTrades,
        winning_trades: winningTrades,
        losing_trades: account.losing_trades || 0,
        win_rate: totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0,
        open_positions: positionsResult.rows.length,
        total_exposure: totalExposure,
      });

      return reply.send({
        success: true,
        data: { message: 'Snapshot recorded' },
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
}
