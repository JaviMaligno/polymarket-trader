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
import { getTradingAutomation, type SignalResult } from '../services/TradingAutomation.js';
import { getSignalEngine } from '../services/SignalEngine.js';
import { getPolymarketService } from '../services/PolymarketService.js';
import { getBacktestService, type BacktestRequest } from '../services/BacktestService.js';

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

  // ============================================
  // Trading Automation Routes
  // ============================================

  // Get automation status
  fastify.get('/api/automation/status', async (_request, reply) => {
    try {
      const automation = getTradingAutomation();
      const status = automation.getStatus();

      return reply.send({
        success: true,
        data: status,
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

  // Get detailed automation stats
  fastify.get('/api/automation/stats', async (_request, reply) => {
    if (!isDatabaseConfigured()) {
      return reply.status(503).send({
        success: false,
        error: 'Database not configured',
        timestamp: new Date(),
      });
    }

    try {
      const automation = getTradingAutomation();
      const stats = await automation.getDetailedStats();

      return reply.send({
        success: true,
        data: stats,
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

  // Start automation
  fastify.post('/api/automation/start', async (_request, reply) => {
    if (!isDatabaseConfigured()) {
      return reply.status(503).send({
        success: false,
        error: 'Database not configured',
        timestamp: new Date(),
      });
    }

    try {
      const automation = getTradingAutomation();
      await automation.start();

      return reply.send({
        success: true,
        data: { message: 'Automation started', status: automation.getStatus() },
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

  // Stop automation
  fastify.post('/api/automation/stop', async (_request, reply) => {
    try {
      const automation = getTradingAutomation();
      automation.stop();

      return reply.send({
        success: true,
        data: { message: 'Automation stopped', status: automation.getStatus() },
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

  // Halt trading (emergency stop)
  fastify.post<{ Body: { reason?: string } }>('/api/automation/halt', async (request, reply) => {
    try {
      const automation = getTradingAutomation();
      await automation.haltTrading(request.body?.reason);

      return reply.send({
        success: true,
        data: { message: 'Trading halted', status: automation.getStatus() },
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

  // Resume trading
  fastify.post('/api/automation/resume', async (_request, reply) => {
    try {
      const automation = getTradingAutomation();
      const resumed = await automation.resumeTrading();

      return reply.send({
        success: true,
        data: { message: resumed ? 'Trading resumed' : 'Cannot resume - risk limits still exceeded', status: automation.getStatus() },
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

  // Force learning evaluation
  fastify.post('/api/automation/evaluate', async (_request, reply) => {
    if (!isDatabaseConfigured()) {
      return reply.status(503).send({
        success: false,
        error: 'Database not configured',
        timestamp: new Date(),
      });
    }

    try {
      const automation = getTradingAutomation();
      await automation.forceEvaluation();

      return reply.send({
        success: true,
        data: { message: 'Evaluation triggered' },
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

  // Submit signals for processing
  fastify.post<{ Body: { signals: SignalResult[] } }>('/api/automation/signals', async (request, reply) => {
    if (!isDatabaseConfigured()) {
      return reply.status(503).send({
        success: false,
        error: 'Database not configured',
        timestamp: new Date(),
      });
    }

    try {
      const automation = getTradingAutomation();

      if (!automation.isTradingAllowed()) {
        return reply.status(400).send({
          success: false,
          error: 'Trading not allowed - automation stopped or halted',
          timestamp: new Date(),
        });
      }

      const signals = request.body?.signals || [];
      const result = await automation.processSignals(signals);

      return reply.send({
        success: true,
        data: result,
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

  // Get risk status
  fastify.get('/api/automation/risk', async (_request, reply) => {
    if (!isDatabaseConfigured()) {
      return reply.status(503).send({
        success: false,
        error: 'Database not configured',
        timestamp: new Date(),
      });
    }

    try {
      const automation = getTradingAutomation();
      const riskStatus = await automation.getRiskManager().checkRisk();

      return reply.send({
        success: true,
        data: riskStatus,
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

  // Get signal performance
  fastify.get('/api/automation/performance', async (_request, reply) => {
    if (!isDatabaseConfigured()) {
      return reply.status(503).send({
        success: false,
        error: 'Database not configured',
        timestamp: new Date(),
      });
    }

    try {
      const automation = getTradingAutomation();
      const performance = await automation.getLearningService().getPerformanceSummary();

      return reply.send({
        success: true,
        data: performance,
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
  // Signal Engine Routes
  // ============================================

  // Get signal engine status
  fastify.get('/api/signals/status', async (_request, reply) => {
    try {
      const engine = getSignalEngine();
      const status = engine.getStatus();

      return reply.send({
        success: true,
        data: status,
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

  // Start signal engine
  fastify.post('/api/signals/start', async (_request, reply) => {
    try {
      const engine = getSignalEngine();
      await engine.start();

      return reply.send({
        success: true,
        data: {
          message: 'Signal engine started',
          status: engine.getStatus(),
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

  // Stop signal engine
  fastify.post('/api/signals/stop', async (_request, reply) => {
    try {
      const engine = getSignalEngine();
      engine.stop();

      return reply.send({
        success: true,
        data: {
          message: 'Signal engine stopped',
          status: engine.getStatus(),
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

  // Force signal computation
  fastify.post('/api/signals/compute', async (_request, reply) => {
    try {
      const engine = getSignalEngine();
      const signals = await engine.forceCompute();

      return reply.send({
        success: true,
        data: {
          signalsGenerated: signals.length,
          signals,
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

  // Set active markets for signal computation
  fastify.post('/api/signals/markets', async (request, reply) => {
    try {
      const { markets } = request.body as {
        markets: Array<{
          id: string;
          question: string;
          tokenIdYes: string;
          tokenIdNo?: string;
          currentPrice: number;
          volume24h?: number;
        }>;
      };

      if (!markets || !Array.isArray(markets)) {
        return reply.status(400).send({
          success: false,
          error: 'markets array is required',
          timestamp: new Date(),
        });
      }

      const engine = getSignalEngine();
      engine.setActiveMarkets(markets);

      return reply.send({
        success: true,
        data: {
          message: `Set ${markets.length} active markets`,
          marketCount: markets.length,
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

  // Get available signal types
  fastify.get('/api/signals/types', async (_request, reply) => {
    try {
      const engine = getSignalEngine();
      const types = engine.getAvailableSignals();

      return reply.send({
        success: true,
        data: types,
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

  // Update signal weights
  fastify.post('/api/signals/weights', async (request, reply) => {
    try {
      const { weights } = request.body as { weights: Record<string, number> };

      if (!weights || typeof weights !== 'object') {
        return reply.status(400).send({
          success: false,
          error: 'weights object is required',
          timestamp: new Date(),
        });
      }

      const engine = getSignalEngine();
      engine.setWeights(weights);

      // Also update in database if configured
      if (isDatabaseConfigured()) {
        for (const [signalType, weight] of Object.entries(weights)) {
          // Use raw query for upsert since repo doesn't have it
          await query(
            `INSERT INTO signal_weights (signal_type, weight, is_enabled, min_confidence, updated_at)
             VALUES ($1, $2, true, 0.6, NOW())
             ON CONFLICT (signal_type) DO UPDATE SET
               weight = EXCLUDED.weight,
               updated_at = NOW()`,
            [signalType, weight]
          );
        }
      }

      return reply.send({
        success: true,
        data: {
          message: 'Weights updated',
          weights: engine.getStatus().weights,
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

  // ============================================
  // Polymarket Routes
  // ============================================

  // Get Polymarket service status
  fastify.get('/api/polymarket/status', async (_request, reply) => {
    try {
      const service = getPolymarketService();
      const status = service.getStatus();

      return reply.send({
        success: true,
        data: status,
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

  // Start Polymarket service
  fastify.post('/api/polymarket/start', async (_request, reply) => {
    try {
      const service = getPolymarketService();
      await service.start();

      return reply.send({
        success: true,
        data: {
          message: 'Polymarket service started',
          status: service.getStatus(),
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

  // Stop Polymarket service
  fastify.post('/api/polymarket/stop', async (_request, reply) => {
    try {
      const service = getPolymarketService();
      service.stop();

      return reply.send({
        success: true,
        data: {
          message: 'Polymarket service stopped',
          status: service.getStatus(),
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

  // Discover markets
  fastify.post('/api/polymarket/discover', async (_request, reply) => {
    try {
      const service = getPolymarketService();
      const markets = await service.discoverMarkets();

      return reply.send({
        success: true,
        data: {
          marketsFound: markets.length,
          markets: markets.slice(0, 20), // Return first 20
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

  // Get all tracked markets
  fastify.get('/api/polymarket/markets', async (_request, reply) => {
    try {
      const service = getPolymarketService();
      const markets = service.getMarkets();

      return reply.send({
        success: true,
        data: markets,
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

  // Get a specific market
  fastify.get('/api/polymarket/markets/:marketId', async (request, reply) => {
    try {
      const { marketId } = request.params as { marketId: string };
      const service = getPolymarketService();
      const market = service.getMarket(marketId);

      if (!market) {
        return reply.status(404).send({
          success: false,
          error: 'Market not found',
          timestamp: new Date(),
        });
      }

      return reply.send({
        success: true,
        data: market,
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

  // Subscribe to a market
  fastify.post('/api/polymarket/subscribe/:marketId', async (request, reply) => {
    try {
      const { marketId } = request.params as { marketId: string };
      const service = getPolymarketService();
      const market = await service.subscribeMarket(marketId);

      if (!market) {
        return reply.status(404).send({
          success: false,
          error: 'Market not found on Polymarket',
          timestamp: new Date(),
        });
      }

      return reply.send({
        success: true,
        data: market,
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

  // Unsubscribe from a market
  fastify.delete('/api/polymarket/unsubscribe/:marketId', async (request, reply) => {
    try {
      const { marketId } = request.params as { marketId: string };
      const service = getPolymarketService();
      service.unsubscribeMarket(marketId);

      return reply.send({
        success: true,
        data: { message: `Unsubscribed from market ${marketId}` },
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

  // Search markets
  fastify.get('/api/polymarket/search', async (request, reply) => {
    try {
      const { q } = request.query as { q?: string };

      if (!q) {
        return reply.status(400).send({
          success: false,
          error: 'Query parameter q is required',
          timestamp: new Date(),
        });
      }

      const service = getPolymarketService();
      const markets = await service.searchMarkets(q);

      return reply.send({
        success: true,
        data: markets,
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

  // Get all prices
  fastify.get('/api/polymarket/prices', async (_request, reply) => {
    try {
      const service = getPolymarketService();
      const prices = service.getAllPrices();

      return reply.send({
        success: true,
        data: prices,
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
  // Database-backed Market Routes
  // ============================================

  // Get markets from database (collected by data-collector)
  fastify.get<{ Querystring: { limit?: number; offset?: number; active?: string; category?: string; search?: string; sortBy?: string; sortOrder?: string } }>(
    '/api/db/markets',
    async (request, reply) => {
      if (!isDatabaseConfigured()) {
        return reply.status(503).send({
          success: false,
          error: 'Database not configured',
          timestamp: new Date(),
        });
      }

      try {
        const {
          limit = 50,
          offset = 0,
          active,
          category,
          search,
          sortBy = 'volume_24h',
          sortOrder = 'DESC'
        } = request.query;

        // Build query with optional filters
        const conditions: string[] = [];
        const params: any[] = [];
        let paramIndex = 1;

        if (active !== undefined) {
          conditions.push(`is_active = $${paramIndex++}`);
          params.push(active === 'true');
        }

        if (category) {
          conditions.push(`category = $${paramIndex++}`);
          params.push(category);
        }

        if (search) {
          conditions.push(`question ILIKE $${paramIndex++}`);
          params.push(`%${search}%`);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        // Validate sort column to prevent SQL injection
        const validSortColumns = ['volume_24h', 'liquidity', 'current_price_yes', 'updated_at', 'created_at', 'question'];
        const safeSort = validSortColumns.includes(sortBy) ? sortBy : 'volume_24h';
        const safeOrder = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

        // Get total count
        const countResult = await query<{ count: string }>(
          `SELECT COUNT(*) as count FROM markets ${whereClause}`,
          params
        );
        const total = parseInt(countResult.rows[0]?.count || '0');

        // Get markets
        params.push(limit);
        params.push(offset);

        const result = await query<{
          id: string;
          event_id: string;
          clob_token_id_yes: string;
          clob_token_id_no: string;
          condition_id: string;
          question: string;
          description: string;
          category: string;
          end_date: Date;
          current_price_yes: string;
          current_price_no: string;
          spread: string;
          volume_24h: string;
          liquidity: string;
          best_bid: string;
          best_ask: string;
          last_trade_price: string;
          is_active: boolean;
          is_resolved: boolean;
          resolution_outcome: string;
          updated_at: Date;
        }>(
          `SELECT
            id, event_id, clob_token_id_yes, clob_token_id_no, condition_id,
            question, description, category, end_date,
            current_price_yes, current_price_no, spread,
            volume_24h, liquidity, best_bid, best_ask, last_trade_price,
            is_active, is_resolved, resolution_outcome, updated_at
          FROM markets
          ${whereClause}
          ORDER BY ${safeSort} ${safeOrder} NULLS LAST
          LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
          params
        );

        const markets = result.rows.map(row => ({
          id: row.id,
          eventId: row.event_id,
          conditionId: row.condition_id,
          question: row.question,
          description: row.description,
          category: row.category,
          endDate: row.end_date,
          tokenIds: [row.clob_token_id_yes, row.clob_token_id_no].filter(Boolean),
          outcomes: ['Yes', 'No'],
          outcomePrices: [
            parseFloat(row.current_price_yes || '0'),
            parseFloat(row.current_price_no || '0')
          ],
          volume24h: parseFloat(row.volume_24h || '0'),
          liquidity: parseFloat(row.liquidity || '0'),
          spread: parseFloat(row.spread || '0'),
          bestBid: parseFloat(row.best_bid || '0'),
          bestAsk: parseFloat(row.best_ask || '0'),
          lastTradePrice: parseFloat(row.last_trade_price || '0'),
          isActive: row.is_active,
          isResolved: row.is_resolved,
          resolutionOutcome: row.resolution_outcome,
          updatedAt: row.updated_at,
        }));

        return reply.send({
          success: true,
          data: {
            markets,
            total,
            limit,
            offset,
            hasMore: offset + markets.length < total,
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
    }
  );

  // Get a specific market from database
  fastify.get<{ Params: { marketId: string } }>('/api/db/markets/:marketId', async (request, reply) => {
    if (!isDatabaseConfigured()) {
      return reply.status(503).send({
        success: false,
        error: 'Database not configured',
        timestamp: new Date(),
      });
    }

    try {
      const { marketId } = request.params;

      const result = await query<{
        id: string;
        event_id: string;
        clob_token_id_yes: string;
        clob_token_id_no: string;
        condition_id: string;
        question: string;
        description: string;
        category: string;
        end_date: Date;
        current_price_yes: string;
        current_price_no: string;
        spread: string;
        volume_24h: string;
        liquidity: string;
        best_bid: string;
        best_ask: string;
        last_trade_price: string;
        is_active: boolean;
        is_resolved: boolean;
        resolution_outcome: string;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT * FROM markets WHERE id = $1`,
        [marketId]
      );

      const row = result.rows[0];
      if (!row) {
        return reply.status(404).send({
          success: false,
          error: 'Market not found',
          timestamp: new Date(),
        });
      }

      return reply.send({
        success: true,
        data: {
          id: row.id,
          eventId: row.event_id,
          conditionId: row.condition_id,
          question: row.question,
          description: row.description,
          category: row.category,
          endDate: row.end_date,
          tokenIds: [row.clob_token_id_yes, row.clob_token_id_no].filter(Boolean),
          outcomes: ['Yes', 'No'],
          outcomePrices: [
            parseFloat(row.current_price_yes || '0'),
            parseFloat(row.current_price_no || '0')
          ],
          volume24h: parseFloat(row.volume_24h || '0'),
          liquidity: parseFloat(row.liquidity || '0'),
          spread: parseFloat(row.spread || '0'),
          bestBid: parseFloat(row.best_bid || '0'),
          bestAsk: parseFloat(row.best_ask || '0'),
          lastTradePrice: parseFloat(row.last_trade_price || '0'),
          isActive: row.is_active,
          isResolved: row.is_resolved,
          resolutionOutcome: row.resolution_outcome,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
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

  // Get market price history from database
  fastify.get<{ Params: { marketId: string }; Querystring: { interval?: string; limit?: number; outcome?: string } }>(
    '/api/db/markets/:marketId/prices',
    async (request, reply) => {
      if (!isDatabaseConfigured()) {
        return reply.status(503).send({
          success: false,
          error: 'Database not configured',
          timestamp: new Date(),
        });
      }

      try {
        const { marketId } = request.params;
        const { limit = 100, outcome = 'yes' } = request.query;

        // First get the market's token IDs
        const marketResult = await query<{
          clob_token_id_yes: string;
          clob_token_id_no: string;
        }>(
          'SELECT clob_token_id_yes, clob_token_id_no FROM markets WHERE id = $1',
          [marketId]
        );

        const market = marketResult.rows[0];
        if (!market) {
          return reply.status(404).send({
            success: false,
            error: 'Market not found',
            timestamp: new Date(),
          });
        }

        // Select the appropriate token based on outcome
        const tokenId = outcome === 'no' ? market.clob_token_id_no : market.clob_token_id_yes;

        if (!tokenId) {
          return reply.send({
            success: true,
            data: [],
            timestamp: new Date(),
          });
        }

        // Query price history by token_id (more reliable than market_id due to data sync issues)
        const result = await query<{
          time: Date;
          open: string;
          high: string;
          low: string;
          close: string;
          volume: string;
          token_id: string;
        }>(
          `SELECT time, open, high, low, close, volume, token_id
           FROM price_history
           WHERE token_id = $1
           ORDER BY time DESC
           LIMIT $2`,
          [tokenId, limit]
        );

        const prices = result.rows.map(row => ({
          time: row.time,
          open: parseFloat(row.open || '0'),
          high: parseFloat(row.high || '0'),
          low: parseFloat(row.low || '0'),
          close: parseFloat(row.close || '0'),
          volume: parseFloat(row.volume || '0'),
          tokenId: row.token_id,
        }));

        return reply.send({
          success: true,
          data: prices.reverse(), // Return in chronological order
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

  // Get market stats summary from database
  fastify.get('/api/db/stats', async (_request, reply) => {
    if (!isDatabaseConfigured()) {
      return reply.status(503).send({
        success: false,
        error: 'Database not configured',
        timestamp: new Date(),
      });
    }

    try {
      const [marketsResult, eventsResult, priceHistoryResult, categoriesResult] = await Promise.all([
        query<{ total: string; active: string; resolved: string }>(
          `SELECT
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE is_active = true) as active,
            COUNT(*) FILTER (WHERE is_resolved = true) as resolved
          FROM markets`
        ),
        query<{ total: string; active: string }>(
          `SELECT
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE is_active = true) as active
          FROM events`
        ),
        query<{ count: string; min_time: Date; max_time: Date }>(
          `SELECT
            COUNT(*) as count,
            MIN(time) as min_time,
            MAX(time) as max_time
          FROM price_history`
        ),
        query<{ category: string; count: string }>(
          `SELECT category, COUNT(*) as count
           FROM markets
           WHERE category IS NOT NULL
           GROUP BY category
           ORDER BY count DESC`
        ),
      ]);

      const markets = marketsResult.rows[0];
      const events = eventsResult.rows[0];
      const priceHistory = priceHistoryResult.rows[0];

      const categories: Record<string, number> = {};
      for (const row of categoriesResult.rows) {
        categories[row.category] = parseInt(row.count);
      }

      return reply.send({
        success: true,
        data: {
          markets: {
            total: parseInt(markets?.total || '0'),
            active: parseInt(markets?.active || '0'),
            resolved: parseInt(markets?.resolved || '0'),
          },
          events: {
            total: parseInt(events?.total || '0'),
            active: parseInt(events?.active || '0'),
          },
          priceHistory: {
            totalRecords: parseInt(priceHistory?.count || '0'),
            oldestRecord: priceHistory?.min_time,
            newestRecord: priceHistory?.max_time,
          },
          categories,
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

  // ============================================
  // Backtest Routes
  // ============================================

  // Get backtest service status
  fastify.get('/api/backtest/status', async (_request, reply) => {
    try {
      const service = getBacktestService();
      const status = service.getStatus();

      return reply.send({
        success: true,
        data: status,
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

  // Run a new backtest
  fastify.post('/api/backtest/run', async (request, reply) => {
    try {
      const backtestRequest = request.body as BacktestRequest;

      // Validate required fields
      if (!backtestRequest.startDate || !backtestRequest.endDate || !backtestRequest.initialCapital) {
        return reply.status(400).send({
          success: false,
          error: 'Required fields: startDate, endDate, initialCapital',
          timestamp: new Date(),
        });
      }

      const service = getBacktestService();
      const result = await service.runBacktest(backtestRequest);

      return reply.send({
        success: true,
        data: {
          id: result.id,
          status: result.status,
          summary: result.result?.summary,
          metrics: result.result?.metrics,
          predictionMetrics: result.result?.predictionMetrics,
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

  // Get backtest progress
  fastify.get('/api/backtest/:id/status', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const service = getBacktestService();
      const status = service.getBacktestStatus(id);

      if (!status) {
        // Check if it's a completed backtest
        const backtest = service.getBacktest(id);
        if (backtest) {
          return reply.send({
            success: true,
            data: {
              status: backtest.status,
              progress: 100,
            },
            timestamp: new Date(),
          });
        }

        return reply.status(404).send({
          success: false,
          error: 'Backtest not found',
          timestamp: new Date(),
        });
      }

      return reply.send({
        success: true,
        data: status,
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

  // Get backtest result
  fastify.get('/api/backtest/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const service = getBacktestService();
      const backtest = service.getBacktest(id);

      if (!backtest) {
        return reply.status(404).send({
          success: false,
          error: 'Backtest not found',
          timestamp: new Date(),
        });
      }

      return reply.send({
        success: true,
        data: backtest,
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

  // Get backtest history
  fastify.get('/api/backtest/history', async (_request, reply) => {
    try {
      const service = getBacktestService();
      const history = service.getBacktestHistory();

      return reply.send({
        success: true,
        data: history.map(b => ({
          id: b.id,
          name: b.name,
          status: b.status,
          createdAt: b.createdAt,
          summary: b.result?.summary,
          metrics: b.result?.metrics,
          error: b.error,
        })),
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

  // Get backtest trades
  fastify.get('/api/backtest/:id/trades', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const service = getBacktestService();
      const backtest = service.getBacktest(id);

      if (!backtest) {
        return reply.status(404).send({
          success: false,
          error: 'Backtest not found',
          timestamp: new Date(),
        });
      }

      return reply.send({
        success: true,
        data: backtest.result?.trades || [],
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

  // Get backtest equity curve
  fastify.get('/api/backtest/:id/equity', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const service = getBacktestService();
      const backtest = service.getBacktest(id);

      if (!backtest) {
        return reply.status(404).send({
          success: false,
          error: 'Backtest not found',
          timestamp: new Date(),
        });
      }

      return reply.send({
        success: true,
        data: backtest.result?.equityCurve || [],
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
  // Feed Management Routes
  // ============================================

  // Get feed status
  fastify.get('/api/feed/status', async (_request, reply) => {
    if (!tradingSystem) {
      return reply.status(400).send({
        success: false,
        error: 'Trading system not initialized',
        timestamp: new Date(),
      });
    }

    const state = tradingSystem.feed.getState();
    const markets = tradingSystem.feed.getAllMarkets();

    return reply.send({
      success: true,
      data: {
        status: state.status,
        connectedAt: state.connectedAt,
        lastMessageAt: state.lastMessageAt,
        subscriptions: state.subscriptions,
        subscriptionCount: state.subscriptions.length,
        marketCount: markets.length,
        markets: markets.slice(0, 10).map(m => ({
          id: m.id,
          question: m.question?.slice(0, 50),
          volume: m.volume,
        })),
      },
      timestamp: new Date(),
    });
  });

  // Subscribe to markets
  fastify.post<{ Body: { marketIds: string[] } }>('/api/feed/subscribe', async (request, reply) => {
    if (!tradingSystem) {
      return reply.status(400).send({
        success: false,
        error: 'Trading system not initialized',
        timestamp: new Date(),
      });
    }

    const { marketIds } = request.body;

    if (!marketIds || !Array.isArray(marketIds)) {
      return reply.status(400).send({
        success: false,
        error: 'marketIds array required',
        timestamp: new Date(),
      });
    }

    tradingSystem.feed.subscribeMany(marketIds);

    return reply.send({
      success: true,
      data: {
        subscribed: marketIds.length,
        total: tradingSystem.feed.getSubscriptions().length,
      },
      timestamp: new Date(),
    });
  });

  // Subscribe to a single market
  fastify.post<{ Params: { marketId: string } }>('/api/feed/subscribe/:marketId', async (request, reply) => {
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
      data: {
        subscribed: marketId,
        total: tradingSystem.feed.getSubscriptions().length,
      },
      timestamp: new Date(),
    });
  });

  // Unsubscribe from a market
  fastify.delete<{ Params: { marketId: string } }>('/api/feed/unsubscribe/:marketId', async (request, reply) => {
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
      data: {
        unsubscribed: marketId,
        total: tradingSystem.feed.getSubscriptions().length,
      },
      timestamp: new Date(),
    });
  });

  // Get all subscriptions
  fastify.get('/api/feed/subscriptions', async (_request, reply) => {
    if (!tradingSystem) {
      return reply.status(400).send({
        success: false,
        error: 'Trading system not initialized',
        timestamp: new Date(),
      });
    }

    return reply.send({
      success: true,
      data: tradingSystem.feed.getSubscriptions(),
      timestamp: new Date(),
    });
  });
}
