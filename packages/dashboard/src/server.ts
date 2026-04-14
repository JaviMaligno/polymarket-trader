/**
 * Dashboard Server Entry Point
 *
 * Starts the dashboard server independently or integrated with trading system.
 * Includes auto-initialization of markets and strategies on startup.
 */

import pino from 'pino';
import { createDashboardServer } from './api/server.js';
import { initializeDatabase, closeDatabase, healthCheck, isDatabaseConfigured, query } from './database/index.js';
import { signalWeightsRepo, tradingConfigRepo } from './database/repositories.js';
import { initializeOptimizationScheduler } from './services/OptimizationScheduler.js';
import { initializeSignalEngine } from './services/SignalEngine.js';
import { getPolymarketService } from './services/PolymarketService.js';
import { getTradingAutomation } from './services/TradingAutomation.js';
import { initializePositionCleanupService } from './services/PositionCleanupService.js';
import { getPositionClosingService } from './services/PositionClosingService.js';
import { initializeStopLossService } from './services/StopLossService.js';
import { initializeCircuitBreakerService } from './services/CircuitBreakerService.js';
import { getDbEventListener } from './services/DbEventListener.js';
import { loadPrivateKey } from './services/SecretManager.js';
import { RealExecutor } from './services/RealExecutor.js';
import { ExecutionRouter, setExecutionRouter } from './services/ExecutionRouter.js';
import { WalletMonitor, setWalletMonitor } from './services/WalletMonitor.js';
import { getNotificationService } from './services/NotificationService.js';

const logger = pino({ name: 'server' });

async function initializeRealTrading(): Promise<void> {
  const config = await tradingConfigRepo.getAll();
  const walletAddress = config.wallet_address as string;

  if (!walletAddress || walletAddress === 'null') {
    logger.info('No wallet configured — real trading disabled');
    // Still create a paper-only ExecutionRouter so getExecutionRouter() works
    const paperRouter = new ExecutionRouter({
      realExecutor: { execute: async () => ({ success: false, error: 'No wallet configured' }) },
      getCachedBalance: () => 0,
      getConfig: async () => ({
        real_trading_enabled: false,
        real_trading_dry_run: false,
        min_balance_threshold: 0,
      }),
      notify: async () => {},
    });
    setExecutionRouter(paperRouter);
    return;
  }

  try {
    const secretName = process.env.GCP_SECRET_NAME || '';
    const privateKey = await loadPrivateKey(secretName);

    // Initialize viem wallet client for ClobClient (v5.8.0 expects viem WalletClient)
    const { createWalletClient, http } = await import('viem');
    const { privateKeyToAccount } = await import('viem/accounts');
    const { polygon } = await import('viem/chains');

    const viemAccount = privateKeyToAccount(privateKey as `0x${string}`);
    const walletClient = createWalletClient({
      account: viemAccount,
      chain: polygon,
      transport: http(process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com'),
    });

    // Initialize CLOB client with viem WalletClient
    const { ClobClient } = await import('@polymarket/clob-client');
    const clobClient = new ClobClient(
      process.env.CLOB_API_URL || 'https://clob.polymarket.com',
      137, // Polygon chainId
      walletClient
    );

    // Initialize ethers provider for USDC balance checks (read-only)
    const { ethers } = await import('ethers');
    const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com');

    const dryRun = config.real_trading_dry_run === true || config.real_trading_dry_run === 'true';
    const maxSlippage = parseFloat(String(config.max_slippage ?? '0.02'));

    const realExecutor = new RealExecutor({ clobClient, maxSlippage, dryRun });
    const USDC_ADDRESS = process.env.USDC_CONTRACT_ADDRESS || '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC on Polygon
    const usdcAbi = ['function balanceOf(address) view returns (uint256)'];
    const usdcContract = new ethers.Contract(USDC_ADDRESS, usdcAbi, provider);

    const minBalance = parseFloat(String(config.min_balance_threshold ?? '50'));
    const warningBalance = parseFloat(String(config.warning_balance_threshold ?? String(minBalance * 2)));

    const walletMonitor = new WalletMonitor({
      getUSDCBalance: async () => {
        const balance = await usdcContract.balanceOf(walletAddress);
        return Number(ethers.formatUnits(balance, 6)); // USDC has 6 decimals
      },
      notify: (type, payload) => getNotificationService().notify(type as any, payload),
      setRealTradingEnabled: async (enabled) => {
        await tradingConfigRepo.set('real_trading_enabled', enabled);
      },
      minBalanceThreshold: minBalance,
      warningThreshold: warningBalance,
    });

    // Initialize ExecutionRouter
    const executionRouter = new ExecutionRouter({
      realExecutor,
      getCachedBalance: () => walletMonitor.getCachedBalance(),
      getConfig: async () => {
        const cfg = await tradingConfigRepo.getAll();
        return {
          real_trading_enabled: cfg.real_trading_enabled === true || cfg.real_trading_enabled === 'true',
          real_trading_dry_run: cfg.real_trading_dry_run === true || cfg.real_trading_dry_run === 'true',
          min_balance_threshold: parseFloat(String(cfg.min_balance_threshold ?? '50')),
        };
      },
      notify: (type, payload) => getNotificationService().notify(type as any, payload),
    });

    setExecutionRouter(executionRouter);
    setWalletMonitor(walletMonitor);
    walletMonitor.start();
    logger.info({ walletAddress, dryRun }, 'Real trading services initialized');
  } catch (err) {
    logger.error({ err }, 'Failed to initialize real trading — running in paper-only mode');
    // Create paper-only router as fallback
    const paperRouter = new ExecutionRouter({
      realExecutor: { execute: async () => ({ success: false, error: 'Initialization failed' }) },
      getCachedBalance: () => 0,
      getConfig: async () => ({
        real_trading_enabled: false,
        real_trading_dry_run: false,
        min_balance_threshold: 0,
      }),
      notify: async () => {},
    });
    setExecutionRouter(paperRouter);
  }
}

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

      // Configure autovacuum for markets table to prevent long-running locks
      await query(`
        ALTER TABLE markets SET (
          autovacuum_vacuum_scale_factor = 0.1,
          autovacuum_analyze_scale_factor = 0.05,
          autovacuum_vacuum_cost_delay = 5
        )
      `).catch(() => {});

      // Create function to cancel autovacuum blocking queries for >30 minutes
      await query(`
        CREATE OR REPLACE FUNCTION cancel_blocking_autovacuum()
        RETURNS void AS $fn$
        DECLARE
          r RECORD;
        BEGIN
          FOR r IN
            SELECT pid FROM pg_stat_activity
            WHERE query LIKE 'autovacuum:%'
              AND state = 'active'
              AND wait_event_type = 'Lock'
              AND NOW() - query_start > INTERVAL '30 minutes'
          LOOP
            PERFORM pg_cancel_backend(r.pid);
            RAISE NOTICE 'Cancelled blocking autovacuum pid %', r.pid;
          END LOOP;
        END;
        $fn$ LANGUAGE plpgsql
      `).catch(() => {});

      // Check for blocking autovacuum every 15 minutes
      setInterval(async () => {
        try {
          const result = await query('SELECT cancel_blocking_autovacuum()');
          // Only log if there was something to cancel (function raises NOTICE)
        } catch {
          // Function may not exist yet on first run
        }
      }, 15 * 60 * 1000);
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

  // Start server
  await server.start();

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
    // Start DbEventListener BEFORE consumers so they can subscribe
    try {
      await getDbEventListener().start();
      console.log('DbEventListener started');
    } catch (err) {
      console.error('DbEventListener failed to start (consumers will use fallback timers):', err);
    }

    setTimeout(async () => {
      console.log('Starting SignalEngine (database-based signals)...');

      // Load optimized parameters from database, but enforce minimum thresholds
      const MIN_CONFIDENCE = 0.43;  // Minimum confidence threshold
      const MIN_STRENGTH = 0.27;    // Minimum strength threshold

      let optimizedParams = { minCombinedConfidence: MIN_CONFIDENCE, minCombinedStrength: MIN_STRENGTH };
      try {
        const result = await query<{ best_params: any }>(`
          SELECT best_params
          FROM optimization_runs
          WHERE status = 'completed' AND best_score IS NOT NULL
          ORDER BY best_score DESC
          LIMIT 1
        `);
        if (result.rows.length > 0 && result.rows[0].best_params) {
          const params = result.rows[0].best_params;
          const dbConfidence = params['combiner.minCombinedConfidence'] ?? params.minConfidence;
          const dbStrength = params['combiner.minCombinedStrength'] ?? params.minEdge;

          // Use MAX of optimized and minimum thresholds (more conservative wins)
          optimizedParams = {
            minCombinedConfidence: Math.max(dbConfidence ?? MIN_CONFIDENCE, MIN_CONFIDENCE),
            minCombinedStrength: Math.max(dbStrength ?? MIN_STRENGTH, MIN_STRENGTH),
          };
          console.log('Loaded params from DB:', { dbConfidence, dbStrength });
          console.log('Applied conservative minimums:', optimizedParams);

          // Signal weights are NOT loaded from optimization_runs on startup.
          // They live in signal_weights table and are synced by SignalEngine
          // every 5 minutes via syncWeightsFromDatabase(). The old startup-load
          // was overwriting manual/contrarian weights with stale optimization
          // results on every container restart.
        } else {
          console.log('No optimization results found, using default conservative thresholds');
        }
      } catch (error) {
        console.warn('Failed to load optimized params, using defaults:', error);
      }

      // Initialize SignalEngine with optimized parameters
      const signalEngine = initializeSignalEngine({
        enabled: true,
        computeIntervalMs: parseInt(process.env.SIGNAL_INTERVAL_MS || '60000', 10),
        maxMarketsPerCycle: parseInt(process.env.MAX_SIGNAL_MARKETS || '15', 10),
        minPriceBars: 3,           // Bayesian confidence cap handles data scarcity
        minCombinedConfidence: optimizedParams.minCombinedConfidence,
        minCombinedStrength: optimizedParams.minCombinedStrength,
      });

      // Start market classifier (classifies new markets via Haiku every 30min)
      const { MarketClassifier } = await import('./services/MarketClassifier.js');
      const classifier = new MarketClassifier();
      classifier.start();

      // Start the Polymarket service to load markets (it will update SignalEngine)
      const polymarketService = getPolymarketService();
      await polymarketService.start();

      // Start the signal engine
      await signalEngine.start();
      console.log('SignalEngine started');

      // Start TradingAutomation so signals can be executed
      const automation = getTradingAutomation();
      await automation.start();
      automation.getExecutor().registerStopLossCooldown(getPositionClosingService());
      await automation.getExecutor().loadPersistedCooldowns();
      await automation.getExecutor().ensureShadowTradesTable();
      console.log('TradingAutomation started');

      // Start PositionCleanupService to auto-close positions in inactive/resolved markets
      const cleanupService = initializePositionCleanupService({
        enabled: true,
        checkIntervalMs: 30 * 60 * 1000,  // Check every 30 minutes
        closeInactiveMarkets: true,
        closeResolvedMarkets: true,
      });
      await cleanupService.start();
      console.log('PositionCleanupService started');

      // Start StopLossService to auto-close positions on stop-loss/take-profit
      const stopLossService = initializeStopLossService({
        enabled: true,
        checkIntervalMs: 5 * 60 * 1000,    // Fallback: 5min (primary trigger: event-driven via DbEventListener)
        defaultStopLossPct: parseFloat(process.env.STOP_LOSS_PCT || '20'),   // 20% stop loss
        defaultTakeProfitPct: parseFloat(process.env.TAKE_PROFIT_PCT || '40'), // 40% take profit
        useTrailingStop: false,
      });
      await stopLossService.start();
      console.log('StopLossService started');

      // Start CircuitBreakerService to auto-reset account on excessive drawdown
      const circuitBreakerService = initializeCircuitBreakerService({
        enabled: true,
        checkIntervalMs: 5 * 60 * 1000,    // Fallback: 5min (primary trigger: event-driven via trade/stopLoss events)
        maxDrawdownPct: parseFloat(process.env.MAX_DRAWDOWN || '0.15') * 100,  // env is decimal (0.15 = 15%)
        initialCapital: parseFloat(process.env.INITIAL_CAPITAL || '10000'),
      });
      await circuitBreakerService.start();
      console.log('CircuitBreakerService started');

      // Initialize real trading (non-blocking — failure doesn't prevent paper trading)
      await initializeRealTrading();
    }, 10000); // 10 second delay to let server fully initialize
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    await getDbEventListener().stop();
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
