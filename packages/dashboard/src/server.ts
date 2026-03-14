/**
 * Dashboard Server Entry Point
 *
 * Starts the dashboard server independently or integrated with trading system.
 * Includes auto-initialization of markets and strategies on startup.
 */

import { createDashboardServer } from './api/server.js';
import { initializeDatabase, closeDatabase, healthCheck, isDatabaseConfigured, query } from './database/index.js';
import { signalWeightsRepo } from './database/repositories.js';
import { initializeOptimizationScheduler } from './services/OptimizationScheduler.js';
import { initializeSignalEngine } from './services/SignalEngine.js';
import { getPolymarketService } from './services/PolymarketService.js';
import { getTradingAutomation } from './services/TradingAutomation.js';
import { initializePositionCleanupService } from './services/PositionCleanupService.js';
import { getPositionClosingService } from './services/PositionClosingService.js';
import { initializeStopLossService } from './services/StopLossService.js';
import { initializeCircuitBreakerService } from './services/CircuitBreakerService.js';
import { getDbEventListener } from './services/DbEventListener.js';

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
      // Ensure market_type column exists (added for adaptive market expansion)
      await query('ALTER TABLE markets ADD COLUMN IF NOT EXISTS market_type VARCHAR(20)').catch(() => {});
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

          // Also load optimized signal weights from best optimization run
          const weightMap: Record<string, string> = {
            'combiner.momentumWeight': 'momentum',
            'combiner.meanReversionWeight': 'mean_reversion',
          };
          for (const [paramKey, signalType] of Object.entries(weightMap)) {
            const w = params[paramKey];
            if (w !== undefined && w !== null) {
              try {
                const clampedWeight = Math.max(0.05, Math.min(0.95, Number(w)));
                await signalWeightsRepo.update(signalType, clampedWeight, 'startup-load');
                console.log(`Loaded optimized weight: ${signalType} = ${clampedWeight}`);
              } catch (err) {
                console.warn(`Failed to load weight ${signalType}:`, err);
              }
            }
          }
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
