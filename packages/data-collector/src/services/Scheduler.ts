import * as cron from 'node-cron';
import { pino } from 'pino';
import { getGammaCollector } from '../collectors/GammaCollector.js';
import { getClobCollector } from '../collectors/ClobCollector.js';
import { getRateLimiter } from './RateLimiter.js';
import { getPool, query } from '../database/connection.js';
import { AdaptiveSyncManager } from './AdaptiveSyncManager.js';
import { ExternalDataCollector } from '../collectors/ExternalDataCollector.js';
import { MarketScorer } from './MarketScorer.js';
import { MarketRotator, parseAllowedMarketTypes } from './MarketRotator.js';
import { optimizeScorerWeights } from './ScorerWeightOptimizer.js';
import {
  updateCategoryPriors,
  updateShadowCategoryPerformance,
  resolveShadowTrades,
} from './MarketPerformanceTracker.js';
import { refreshEdgeCapacity, resolveEdgeRefreshConfig } from './EdgeCapacityRefresher.js';
import { NewsCollector } from '../collectors/NewsCollector.js';

const logger = pino({ name: 'scheduler' });

/**
 * Compute realized volatility (stddev of first differences of close prices
 * over the last 24h) for every token that has enough bars, and null out
 * vols for tokens whose recent data has aged out. Sub-project B.1.
 */
export async function computeRealizedVolatility(): Promise<void> {
  try {
    const start = Date.now();
    const result = await query(`
      UPDATE markets m
      SET realized_volatility_24h = s.vol,
          realized_volatility_bar_count = s.n_bars
      FROM (
        SELECT token_id,
               STDDEV_POP(d) AS vol,
               COUNT(d) AS n_bars
        FROM (
          SELECT token_id,
                 close - LAG(close) OVER (PARTITION BY token_id ORDER BY time) AS d
          FROM price_history
          WHERE time > NOW() - INTERVAL '24 hours'
        ) diffs
        GROUP BY token_id
        HAVING COUNT(d) >= 5
      ) s
      WHERE s.token_id = m.clob_token_id_yes
    `);

    // Null out markets that no longer have qualifying recent data.
    const nullResult = await query(`
      UPDATE markets
      SET realized_volatility_24h = NULL, realized_volatility_bar_count = NULL
      WHERE realized_volatility_24h IS NOT NULL
        AND clob_token_id_yes NOT IN (
          SELECT token_id FROM price_history
          WHERE time > NOW() - INTERVAL '24 hours'
          GROUP BY token_id
          HAVING COUNT(*) >= 6
        )
    `);

    logger.info({
      duration_ms: Date.now() - start,
      updated: result.rowCount ?? 0,
      nulled: nullResult.rowCount ?? 0,
    }, 'Realized volatility computed');
  } catch (err) {
    logger.error({ err }, 'Realized volatility compute failed — skipping this cycle');
  }
}

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
  private adaptiveSyncManager?: AdaptiveSyncManager;
  private externalDataCollector?: ExternalDataCollector;
  private marketScorer: MarketScorer;
  private marketRotator: MarketRotator;
  private newsCollector: NewsCollector;

  constructor(adaptiveSyncManager?: AdaptiveSyncManager, externalDataCollector?: ExternalDataCollector) {
    this.adaptiveSyncManager = adaptiveSyncManager;
    this.externalDataCollector = externalDataCollector;
    this.marketScorer = new MarketScorer();
    this.marketRotator = new MarketRotator();
    this.newsCollector = new NewsCollector();
    // Define all scheduled jobs
    this.defineJob('sync-markets', '17 * * * *', this.syncMarkets.bind(this));      // Hourly at :17
    this.defineJob('sync-resolved-markets', '33 * * * *', this.syncResolvedMarkets.bind(this));  // Hourly at :33
    this.defineJob('sync-events', '47 */2 * * *', this.syncEvents.bind(this));     // Every 2h at :47
    this.defineJob('sync-prices', '*/5 * * * *', this.syncPrices.bind(this));  // Every 5min (only for market selection, not trading)
    // DISABLED: CLOB /prices-history returns complementary (No) prices for Yes tokens.
    // Snapshots from syncPrices() are the only reliable price source.
    // See: docs/plans/2026-03-28-centralized-price-service-design.md
    // this.defineJob('sync-price-history', '*/5 * * * *', this.syncPriceHistory.bind(this));
    this.defineJob('sync-orderbooks', '*/10 * * * *', this.syncOrderBooks.bind(this));  // Order book snapshots every 10 min
    this.defineJob('sync-trades', '*/5 * * * *', this.syncTrades.bind(this));  // Real trades every 5 min
    this.defineJob('log-stats', '*/5 * * * *', this.logStats.bind(this));
    this.defineJob('prune-zombies', '0 */6 * * *', this.pruneZombieMarkets.bind(this));  // Every 6 hours
    this.defineJob('fetch-external-prices', '0 * * * *', this.fetchExternalPrices.bind(this));  // Hourly
    this.defineJob('match-external-markets', '0 3 * * *', this.matchExternalMarkets.bind(this));  // Daily at 3 UTC
    this.defineJob('optimize-scorer-weights', '17 3 * * 1', this.optimizeScorerWeights.bind(this));  // Every Monday at 03:17 UTC
    this.defineJob('compute-market-priors', '45 2 * * *', this.computeMarketPriors.bind(this));  // Daily at 02:45 UTC
    // Phase 4 (2026-05-13): refresh per-(market_type) cost-aware edge_capacity
    // from generator_predictions × price_history forward drift. Runs just
    // before compute-market-priors so both data sources are fresh for the next
    // MarketScorer cycle. See docs/plans/2026-05-13-phase4-edge-aware-scorer-design.md.
    this.defineJob('refresh-edge-capacity', '30 2 * * *', this.refreshEdgeCapacity.bind(this));  // Daily at 02:30 UTC
    this.defineJob('collect-news', '*/15 * * * *', this.collectNews.bind(this));  // News pipeline every 15 minutes
    this.defineJob('compute-realized-volatility', '*/15 * * * *', computeRealizedVolatility);  // Every 15 min
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
   * Wait for all running jobs to complete
   */
  async waitForRunningJobs(timeoutMs: number = 30000): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const runningJobs = Array.from(this.jobs.values()).filter(job => job.isRunning);

      if (runningJobs.length === 0) {
        logger.info('All jobs completed');
        return;
      }

      logger.info({ runningJobs: runningJobs.map(j => j.name) }, 'Waiting for running jobs to complete');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    logger.warn('Timeout waiting for jobs to complete');
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
      this.adaptiveSyncManager?.reportJobSkip(name);
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
        case 'sync-resolved-markets':
          await this.syncResolvedMarkets();
          break;
        case 'sync-price-history':
          // DISABLED: see job registration comment
          // await this.syncPriceHistory();
          break;
        case 'sync-orderbooks':
          await this.syncOrderBooks();
          break;
        case 'sync-trades':
          await this.syncTrades();
          break;
        case 'log-stats':
          await this.logStats();
          break;
        case 'prune-zombies':
          await this.pruneZombieMarkets();
          break;
        case 'fetch-external-prices':
          await this.fetchExternalPrices();
          break;
        case 'match-external-markets':
          await this.matchExternalMarkets();
          break;
        case 'optimize-scorer-weights':
          await this.optimizeScorerWeights();
          break;
        case 'compute-market-priors':
          await this.computeMarketPriors();
          break;
        case 'refresh-edge-capacity':
          // Phase 4 (2026-05-13). PR #224 defined the job + binding but
          // forgot to add the runJob switch case → cron fired daily but
          // fell through to 'No handler for job' (lastDuration=0ms, no
          // upserts). Discovered 2026-05-15 in the daily-autoreview validation.
          await this.refreshEdgeCapacity();
          break;
        case 'collect-news':
          await this.collectNews();
          break;
        case 'compute-realized-volatility':
          await computeRealizedVolatility();
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
      this.adaptiveSyncManager?.reportJobComplete(name);
    }
  }

  /**
   * Run a promise with a timeout. Returns null if the timeout fires first.
   */
  private async withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T | null> {
    const timeout = new Promise<null>((resolve) => {
      setTimeout(() => {
        // Note: the original promise continues running — Promise.race cannot cancel it.
        // MAX_SYNC_PAGES limits the actual work, so runaway duration is unlikely.
        logger.warn(`[Scheduler] ${label} timed out after ${ms / 1000}s`);
        resolve(null);
      }, ms);
    });
    return Promise.race([promise, timeout]);
  }

  /**
   * Run initial data sync on startup
   */
  private async runInitialSync(): Promise<void> {
    logger.info('Running initial data sync');

    try {
      // First sync events (includes markets)
      await this.withTimeout(this.syncEvents(), 120_000, 'Initial sync-events');

      // Then sync markets directly
      await this.withTimeout(this.syncMarkets(), 120_000, 'Initial sync-markets');

      // Update current prices
      await this.withTimeout(this.syncPrices(), 60_000, 'Initial sync-prices');

      // DISABLED: CLOB /prices-history returns inverted prices (see sync-price-history comment above)
      // await this.withTimeout(this.syncPriceHistory(), 120_000, 'Initial sync-price-history');

      // Sync order books
      await this.withTimeout(this.syncOrderBooks(), 60_000, 'Initial sync-orderbooks');

      // Sync trades
      await this.withTimeout(this.syncTrades(), 60_000, 'Initial sync-trades');

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
    logger.info({ inserted: result.inserted, updated: result.updated }, 'Markets synced from Gamma API');

    // Score all markets after sync
    try {
      const scoreResult = await this.marketScorer.scoreAllMarkets();
      logger.info(scoreResult, 'Markets scored');
    } catch (err) {
      logger.error({ err }, 'Market scoring failed');
    }

    // Rotate tracked markets based on scores — both live and shadow lanes
    try {
      const rotateResult = await this.marketRotator.rotateAll();
      logger.info(rotateResult, 'Market rotation complete (both lanes)');
    } catch (err) {
      logger.error({ err }, 'Market rotation failed');
    }
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
   * Pull resolution status for closed markets so the daily shadow-trade
   * resolver can score theoretical PnL. Only touches rows we already track.
   */
  private async syncResolvedMarkets(): Promise<void> {
    const collector = getGammaCollector();
    const result = await collector.resolveOurMarkets();
    logger.info({ resolved: result.resolved, checked: result.checked }, 'Resolved our markets');
  }

  /**
   * Update current prices for all markets (used for market selection only)
   */
  private async syncPrices(): Promise<void> {
    const collector = getClobCollector();
    const result = await collector.updateAllMarketPrices();
    logger.debug({ updated: result.updated, errors: result.errors }, 'Prices updated');

    // Snapshot current prices into price_history so all tracked markets have continuous bars
    try {
      const snapResult = await collector.snapshotCurrentPricesToHistory();
      if (snapResult.inserted > 0) {
        // Notify dashboard of new price data
        const pool = getPool();
        const payload = JSON.stringify({
          inserted: snapResult.inserted,
          markets: snapResult.inserted,
          time: new Date().toISOString(),
          source: 'snapshot',
        });
        await pool.query(`SELECT pg_notify('price_sync_complete', $1)`, [payload]);
      }
    } catch (err) {
      logger.warn({ error: err }, 'Price snapshot failed');
    }
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

    // Notify consumers (dashboard) that fresh price data is available
    if (result.totalInserted > 0) {
      try {
        const pool = getPool();
        const payload = JSON.stringify({
          inserted: result.totalInserted,
          markets: result.markets,
          time: new Date().toISOString(),
        });
        await pool.query(`SELECT pg_notify('price_sync_complete', $1)`, [payload]);
        logger.debug({ inserted: result.totalInserted }, 'Sent price_sync_complete notification');
      } catch (notifyErr) {
        logger.warn({ error: notifyErr }, 'Failed to send pg_notify');
      }
    }
  }

  /**
   * Sync order book snapshots for all markets
   */
  private async syncOrderBooks(): Promise<void> {
    const collector = getClobCollector();
    const result = await collector.syncAllOrderBooks();
    logger.info({ synced: result.synced, errors: result.errors }, 'Order books synced');
  }

  /**
   * Sync real trades from CLOB API
   */
  private async syncTrades(): Promise<void> {
    const collector = getClobCollector();
    const result = await collector.syncAllTrades();
    logger.info({ markets: result.markets, inserted: result.totalInserted, errors: result.errors }, 'Trades synced');
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
   * Fetch current prices from external platforms for matched markets
   * and store price divergence signals. Runs hourly.
   */
  private async fetchExternalPrices(): Promise<void> {
    if (!this.externalDataCollector) {
      logger.debug('ExternalDataCollector not configured, skipping fetch-external-prices');
      return;
    }
    const stored = await this.externalDataCollector.fetchMatchedMarketPrices();
    logger.info({ stored }, 'External price divergence signals stored');
  }

  /**
   * Match unmatched long-duration Polymarket markets against external platforms
   * using Haiku. Runs daily at 3 UTC.
   */
  private async matchExternalMarkets(): Promise<void> {
    if (!this.externalDataCollector) {
      logger.debug('ExternalDataCollector not configured, skipping match-external-markets');
      return;
    }
    const matched = await this.externalDataCollector.runDailyMatching();
    logger.info({ matched }, 'Daily external market matching complete');
  }

  /**
   * Optimize MarketScorer dimension weights via random search.
   * Guard: no-op when fewer than MIN_TRADES closed trades exist.
   * Runs every Monday at 03:17 UTC.
   */
  private async optimizeScorerWeights(): Promise<void> {
    await optimizeScorerWeights();
  }

  /**
   * Compute category performance priors from closed trade outcomes.
   * Updates category_performance table; MarketScorer reads priors at next scoring run.
   * Daily at 02:45 UTC.
   */
  private async computeMarketPriors(): Promise<void> {
    await updateCategoryPriors();
    await updateShadowCategoryPerformance();
    await resolveShadowTrades();
  }

  /**
   * Phase 4 (2026-05-13): nightly refresh of `market_type_edge_capacity` from
   * generator_predictions. MarketScorer reads on next scoreAllMarkets (hourly :17).
   * Daily at 02:30 UTC. Uses 1% default RT cost per type — production should
   * later pass a measured per-type cost map from scripts/measure-rt-cost.js.
   */
  private async refreshEdgeCapacity(): Promise<void> {
    // sampleSize / perTypeTimeoutMs are env-overridable (defaults 10000 / 600s).
    // The 300s default timed out all types on 2026-05-30 under DB contention
    // (#284) → 0 upserts → generator_edge stale. See resolveEdgeRefreshConfig.
    const { sampleSize, perTypeTimeoutMs } = resolveEdgeRefreshConfig();
    // Edge-measurement scope is decoupled from the LIVE trade allowlist
    // (ALLOWED_MARKET_TYPES). #290 tied the two purely to dodge event_long's
    // 600s timeout; migration 034's generator_predictions(market_type,direction,
    // time) index removed that cost (event_short >600s→41s), so there's no
    // longer a reason to starve shadow-only types of edge observability. Read a
    // dedicated EDGE_REFRESH_ALLOWED_TYPES: unset/empty → [] → measure ALL
    // discovered types (incl. event_long); set → restrict to that list.
    const allowedTypes = parseAllowedMarketTypes(process.env.EDGE_REFRESH_ALLOWED_TYPES);
    await refreshEdgeCapacity({
      windowDays: 7,
      horizonHours: 4,
      defaultRtCost: 0.01,
      minN: 50,
      sampleSize,
      perTypeTimeoutMs,
      allowedTypes,
    });
  }

  /**
   * Collect news from Google News RSS + Finnhub, score sentiment,
   * match to active markets, write signals to external_signals.
   * Every 15 minutes.
   */
  private async collectNews(): Promise<void> {
    const signalsWritten = await this.newsCollector.collect();
    logger.info({ signalsWritten }, 'News collection completed');
  }

  /**
   * Prune zombie markets: mark as inactive if no volume and no price updates for 7+ days.
   * Reduces DB bloat and speeds up queries/classification.
   */
  private async pruneZombieMarkets(): Promise<void> {
    const pool = getPool();
    // Two zombie criteria:
    //  1. End date passed by >1 day — market is no longer tradeable regardless
    //     of update recency. (The previous `updated_at < NOW() - 7d` gate never
    //     fired because sync-markets refreshes updated_at every 5 min, so
    //     43k+ expired markets were left is_active=true. Discovered 2026-05-12
    //     investigating event_short supply: 43,138 expired event_short alone.)
    //  2. No volume + no recent update >7d — legacy criterion for null-end_date
    //     markets that drifted out of activity.
    const result = await pool.query(`
      UPDATE markets
      SET is_active = false, updated_at = NOW()
      WHERE is_active = true
        AND COALESCE(is_resolved, false) = false
        AND (
          (end_date IS NOT NULL AND end_date < NOW() - INTERVAL '1 day')
          OR (
            (volume_24h IS NULL OR volume_24h = 0)
            AND updated_at < NOW() - INTERVAL '7 days'
          )
        )
    `);
    const pruned = result.rowCount ?? 0;
    if (pruned > 0) {
      logger.info({ pruned }, 'Pruned zombie markets (expired or stale)');
    }
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

export function getScheduler(adaptiveSyncManager?: AdaptiveSyncManager, externalDataCollector?: ExternalDataCollector): Scheduler {
  if (!schedulerInstance) {
    schedulerInstance = new Scheduler(adaptiveSyncManager, externalDataCollector);
  }
  return schedulerInstance;
}
