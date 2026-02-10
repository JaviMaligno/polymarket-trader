/**
 * Dashboard Server Entry Point
 *
 * Starts the dashboard server independently or integrated with trading system.
 * Includes auto-initialization of markets and strategies on startup.
 */

import { createDashboardServer } from './api/server.js';
import { createTradingSystem } from '@polymarket-trader/trader';
import { initializeDatabase, closeDatabase, healthCheck, isDatabaseConfigured } from './database/index.js';
import { autoInitialize, createAndStartStrategy } from './services/AutoInitService.js';
import { initializeOptimizationScheduler } from './services/OptimizationScheduler.js';
import { initializePaperTradingService } from './services/PaperTradingService.js';
import { initializeSignalEngine } from './services/SignalEngine.js';
import { getPolymarketService } from './services/PolymarketService.js';
import { getTradingAutomation } from './services/TradingAutomation.js';

async function main(): Promise<void> {
  // Parse command line arguments
  const port = parseInt(process.env.PORT ?? '3001', 10);
  const host = process.env.HOST ?? '0.0.0.0';

  // Initialize database connection
  if (isDatabaseConfigured()) {
    console.log('Initializing database connection...');
    initializeDatabase();

    const dbHealth = await healthCheck();
    if (dbHealth.connected) {
      console.log(`Database connected (latency: ${dbHealth.latency}ms)`);
    } else {
      console.error('Database connection failed:', dbHealth.error);
      console.log('Continuing without database - some features will be disabled');
    }
  } else {
    console.log('DATABASE_URL not configured - running without database');
  }

  // Create dashboard server
  const server = createDashboardServer({
    port,
    host,
    cors: {
      origin: process.env.CORS_ORIGIN ?? '*',
    },
  });

  // Optionally create and connect trading system
  const connectTrader = process.env.CONNECT_TRADER === 'true';

  if (connectTrader) {
    console.log('Initializing trading system...');

    const tradingSystem = createTradingSystem({
      feed: {
        apiUrl: process.env.POLYMARKET_API_URL ?? 'https://clob.polymarket.com',
      },
      trading: {
        initialCapital: parseFloat(process.env.INITIAL_CAPITAL ?? '10000'),
        feeRate: parseFloat(process.env.FEE_RATE ?? '0.001'),
      },
      riskMonitor: {
        maxDrawdown: parseFloat(process.env.MAX_DRAWDOWN ?? '0.15'),
        maxDailyLoss: parseFloat(process.env.MAX_DAILY_LOSS ?? '500'),
      },
      alerts: {
        channels: ['CONSOLE'],
        minSeverity: 'INFO',
      },
    });

    server.setTradingSystem(tradingSystem);

    // Connect paper trading persistence
    if (isDatabaseConfigured()) {
      const paperTradingService = initializePaperTradingService(
        parseFloat(process.env.INITIAL_CAPITAL ?? '10000')
      );

      // Listen to order fills and persist trades
      tradingSystem.engine.on('order:filled', (order: any, fill: any) => {
        // Extract signalInfo from order metadata (set by StrategyOrchestrator)
        const signalInfo = order.metadata?.signalInfo as {
          signalId?: number;
          signalType?: string;
          direction?: string;
          strength?: number;
          confidence?: number;
        } | undefined;

        paperTradingService.recordTrade(order, fill, signalInfo).catch((err: Error) => {
          console.error('Failed to record trade:', err);
        });
      });

      // Listen to position changes and persist
      tradingSystem.engine.on('position:opened', (position: any) => {
        paperTradingService.updatePosition(position).catch((err: Error) => {
          console.error('Failed to update position:', err);
        });
      });

      tradingSystem.engine.on('position:updated', (position: any) => {
        paperTradingService.updatePosition(position).catch((err: Error) => {
          console.error('Failed to update position:', err);
        });
      });

      tradingSystem.engine.on('position:closed', (position: any) => {
        paperTradingService.closePosition(position.marketId).catch((err: Error) => {
          console.error('Failed to close position:', err);
        });
      });

      // Start periodic equity snapshots (every 5 minutes)
      paperTradingService.startSnapshotRecording(
        () => tradingSystem.engine.getPortfolioState(),
        () => {
          const stats = tradingSystem.engine.getStatistics();
          return {
            totalTrades: stats.totalTrades,
          };
        },
        300000 // 5 minutes
      );

      console.log('Paper trading persistence connected');
    }

    // Start trading system
    await tradingSystem.start();
    console.log('Trading system connected');

    // Auto-initialize markets and strategy
    if (isDatabaseConfigured()) {
      console.log('Running auto-initialization...');
      await autoInitialize(tradingSystem as any);
    }
  }

  // Start server
  await server.start();

  // After server is up, create and start strategy via API
  if (connectTrader && isDatabaseConfigured()) {
    const baseUrl = `http://localhost:${port}`;
    // Delay to ensure server is fully ready
    setTimeout(async () => {
      console.log('Creating and starting auto-optimized strategy...');
      await createAndStartStrategy(baseUrl);
    }, 5000);
  }

  // Start optimization scheduler (runs every 6 hours)
  const enableOptimization = process.env.ENABLE_OPTIMIZATION !== 'false';
  if (enableOptimization && isDatabaseConfigured()) {
    const baseUrl = `http://localhost:${port}`;
    const scheduler = initializeOptimizationScheduler(baseUrl);

    // Delay scheduler start to allow trading system to initialize
    setTimeout(async () => {
      console.log('Starting optimization scheduler...');
      await scheduler.start();
    }, 30000); // 30 second delay
  }

  // Start SignalEngine (uses database price history for proper signal generation)
  const enableSignalEngine = process.env.ENABLE_SIGNAL_ENGINE !== 'false';
  if (enableSignalEngine && isDatabaseConfigured()) {
    setTimeout(async () => {
      console.log('Starting SignalEngine (database-based signals)...');

      // Initialize SignalEngine with optimized parameters
      const signalEngine = initializeSignalEngine({
        enabled: true,
        computeIntervalMs: 60000,  // Compute signals every 1 minute
        maxMarketsPerCycle: 50,    // Process top 50 markets per cycle
        minPriceBars: 30,          // Require at least 30 price bars
      });

      // Start the Polymarket service to load markets (it will update SignalEngine)
      const polymarketService = getPolymarketService();
      await polymarketService.start();

      // Start the signal engine
      await signalEngine.start();
      console.log('SignalEngine started');

      // Start TradingAutomation so signals can be executed
      const automation = getTradingAutomation();
      await automation.start();
      console.log('TradingAutomation started');
    }, 10000); // 10 second delay to let server fully initialize
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    await server.stop();
    await closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
