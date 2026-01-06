import * as cron from 'node-cron';
import { pino } from 'pino';
import { getGammaCollector } from '../collectors/GammaCollector.js';
import { getClobCollector } from '../collectors/ClobCollector.js';
import { getRateLimiter } from './RateLimiter.js';

const logger = pino({ name: 'scheduler' });

interface ScheduledJob {
  name: string;
  schedule: string;
  task: cron.ScheduledTask | null;
  lastRun: Date | null;
  lastDuration: number | null;
  lastError: string | null;
  isRunning: boolean;
}

export class Scheduler {
  private jobs: Map<string, ScheduledJob> = new Map();
  private isRunning = false;

  constructor() {
    // Define all scheduled jobs
    this.defineJob('sync-markets', '*/5 * * * *', this.syncMarkets.bind(this));
    this.defineJob('sync-events', '*/10 * * * *', this.syncEvents.bind(this));
    this.defineJob('sync-prices', '* * * * *', this.syncPrices.bind(this));
    this.defineJob('sync-price-history', '*/15 * * * *', this.syncPriceHistory.bind(this));
    this.defineJob('log-stats', '*/5 * * * *', this.logStats.bind(this));
  }

  /**
   * Define a scheduled job
   */
  private defineJob(name: string, schedule: string, handler: () => Promise<void>): void {
    this.jobs.set(name, {
      name,
      schedule,
      task: null,
      lastRun: null,
      lastDuration: null,
      lastError: null,
      isRunning: false,
    });

    logger.info({ name, schedule }, 'Defined scheduled job');
  }

  /**
   * Start all scheduled jobs
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Scheduler already running');
      return;
    }

    logger.info('Starting scheduler');

    for (const [name, job] of this.jobs) {
      job.task = cron.schedule(job.schedule, async () => {
        await this.runJob(name);
      });

      logger.info({ name, schedule: job.schedule }, 'Started scheduled job');
    }

    this.isRunning = true;

    // Run initial sync immediately
    this.runInitialSync();
  }

  /**
   * Stop all scheduled jobs
   */
  stop(): void {
    logger.info('Stopping scheduler');

    for (const [name, job] of this.jobs) {
      if (job.task) {
        job.task.stop();
        job.task = null;
      }
    }

    this.isRunning = false;
    getRateLimiter().stop();
  }

  /**
   * Run a specific job by name
   */
  async runJob(name: string): Promise<void> {
    const job = this.jobs.get(name);
    if (!job) {
      logger.warn({ name }, 'Unknown job');
      return;
    }

    if (job.isRunning) {
      logger.debug({ name }, 'Job already running, skipping');
      return;
    }

    job.isRunning = true;
    const startTime = Date.now();

    try {
      logger.debug({ name }, 'Running job');

      switch (name) {
        case 'sync-markets':
          await this.syncMarkets();
          break;
        case 'sync-events':
          await this.syncEvents();
          break;
        case 'sync-prices':
          await this.syncPrices();
          break;
        case 'sync-price-history':
          await this.syncPriceHistory();
          break;
        case 'log-stats':
          await this.logStats();
          break;
        default:
          logger.warn({ name }, 'No handler for job');
      }

      job.lastRun = new Date();
      job.lastDuration = Date.now() - startTime;
      job.lastError = null;

      logger.debug({ name, duration: job.lastDuration }, 'Job completed');

    } catch (error: any) {
      job.lastError = error.message;
      logger.error({ error, name }, 'Job failed');
    } finally {
      job.isRunning = false;
    }
  }

  /**
   * Run initial data sync on startup
   */
  private async runInitialSync(): Promise<void> {
    logger.info('Running initial data sync');

    try {
      // First sync events (includes markets)
      await this.syncEvents();

      // Then sync markets directly
      await this.syncMarkets();

      // Update current prices
      await this.syncPrices();

      // Start historical price sync
      await this.syncPriceHistory();

      logger.info('Initial sync completed');
    } catch (error) {
      logger.error({ error }, 'Initial sync failed');
    }
  }

  /**
   * Sync markets from Gamma API
   */
  private async syncMarkets(): Promise<void> {
    const collector = getGammaCollector();
    const result = await collector.syncMarketsToDb();
    logger.info({ inserted: result.inserted, updated: result.updated }, 'Markets synced');
  }

  /**
   * Sync events from Gamma API
   */
  private async syncEvents(): Promise<void> {
    const collector = getGammaCollector();
    const result = await collector.syncEventsToDb();
    logger.info({ inserted: result.inserted, updated: result.updated }, 'Events synced');
  }

  /**
   * Update current prices for all markets
   */
  private async syncPrices(): Promise<void> {
    const collector = getClobCollector();
    const result = await collector.updateAllMarketPrices();
    logger.debug({ updated: result.updated, errors: result.errors }, 'Prices updated');
  }

  /**
   * Sync historical price data
   */
  private async syncPriceHistory(): Promise<void> {
    const collector = getClobCollector();
    const result = await collector.syncAllMarketsPriceHistory();
    logger.info({
      markets: result.markets,
      inserted: result.totalInserted,
      skipped: result.totalSkipped,
      errors: result.errors,
    }, 'Price history synced');
  }

  /**
   * Log current statistics
   */
  private async logStats(): Promise<void> {
    const gammaCollector = getGammaCollector();
    const rateLimiter = getRateLimiter();

    const marketStats = await gammaCollector.getMarketStats();
    const rateLimitStats = rateLimiter.getStats();

    logger.info({
      markets: marketStats,
      rateLimits: rateLimitStats,
      jobs: this.getJobStats(),
    }, 'System statistics');
  }

  /**
   * Get job statistics
   */
  getJobStats(): Record<string, {
    lastRun: string | null;
    lastDuration: number | null;
    lastError: string | null;
    isRunning: boolean;
  }> {
    const stats: Record<string, any> = {};

    for (const [name, job] of this.jobs) {
      stats[name] = {
        lastRun: job.lastRun?.toISOString() || null,
        lastDuration: job.lastDuration,
        lastError: job.lastError,
        isRunning: job.isRunning,
      };
    }

    return stats;
  }

  /**
   * Get scheduler status
   */
  getStatus(): {
    isRunning: boolean;
    jobs: string[];
    stats: Record<string, any>;
  } {
    return {
      isRunning: this.isRunning,
      jobs: Array.from(this.jobs.keys()),
      stats: this.getJobStats(),
    };
  }
}

// Singleton instance
let schedulerInstance: Scheduler | null = null;

export function getScheduler(): Scheduler {
  if (!schedulerInstance) {
    schedulerInstance = new Scheduler();
  }
  return schedulerInstance;
}
