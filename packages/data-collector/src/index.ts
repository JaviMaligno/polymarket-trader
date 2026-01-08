import 'dotenv/config';
import http from 'node:http';
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

  // Start health check HTTP server
  const healthPort = parseInt(process.env.HEALTH_PORT || process.env.PORT || '10000', 10);
  const healthServer = http.createServer(async (req, res) => {
    if (req.url === '/health' || req.url === '/') {
      const dbHealthy = await healthCheck();
      const status = {
        status: dbHealthy ? 'healthy' : 'unhealthy',
        timestamp: new Date().toISOString(),
        database: dbHealthy,
        scheduler: scheduler.getStatus().isRunning,
        uptime: process.uptime(),
      };

      res.writeHead(dbHealthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  healthServer.listen(healthPort, '0.0.0.0', () => {
    logger.info({ port: healthPort }, 'Health check server started');
  });

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
    healthServer.close();
    scheduler.stop();

    // Wait for running jobs to complete before closing pool
    await scheduler.waitForRunningJobs(30000);
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
