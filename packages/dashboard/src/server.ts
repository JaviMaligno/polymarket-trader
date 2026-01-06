/**
 * Dashboard Server Entry Point
 *
 * Starts the dashboard server independently or integrated with trading system.
 */

import { createDashboardServer } from './api/server.js';
import { createTradingSystem } from '@polymarket-trader/trader';
import { initializeDatabase, closeDatabase, healthCheck, isDatabaseConfigured } from './database/index.js';

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

    // Start trading system
    await tradingSystem.start();
    console.log('Trading system connected');
  }

  // Start server
  await server.start();

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
