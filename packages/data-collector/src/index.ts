import 'dotenv/config';
import { pino } from 'pino';
import { healthCheck, closePool } from './database/connection.js';
import { getScheduler } from './services/Scheduler.js';
import { getRateLimiter } from './services/RateLimiter.js';

const logger = pino({
  name: 'polymarket-data-collector',
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
    },
  },
});

async function main(): Promise<void> {
  logger.info('Starting Polymarket Data Collector');

  // Check database connection
  logger.info('Checking database connection...');
  const dbHealthy = await healthCheck();

  if (!dbHealthy) {
    logger.error('Database connection failed. Please ensure TimescaleDB is running.');
    logger.info('Run: docker-compose up -d timescaledb');
    process.exit(1);
  }

  logger.info('Database connection successful');

  // Initialize rate limiter
  const rateLimiter = getRateLimiter();
  logger.info({ endpoints: Object.keys(rateLimiter.getStats()) }, 'Rate limiter initialized');

  // Start scheduler
  const scheduler = getScheduler();
  scheduler.start();

  logger.info('Data collector started successfully');
  logger.info('Press Ctrl+C to stop');

  // Print initial stats every 30 seconds
  const statsInterval = setInterval(() => {
    const stats = rateLimiter.getStats();
    const jobStats = scheduler.getJobStats();

    logger.info({ rateLimits: stats, jobs: jobStats }, 'Status update');
  }, 30000);

  // Graceful shutdown handlers
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Received shutdown signal');

    clearInterval(statsInterval);
    scheduler.stop();
    await closePool();

    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Keep process alive
  await new Promise(() => {});
}

// Run main function
main().catch((error) => {
  logger.error({ error }, 'Fatal error');
  process.exit(1);
});
