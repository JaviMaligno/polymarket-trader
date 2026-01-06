/**
 * Data Collector Service
 *
 * Collects and stores market data to the database.
 * Saves price history for backtesting and analysis.
 */

import { EventEmitter } from 'events';
import { isDatabaseConfigured, query } from '../database/index.js';

export interface PriceData {
  marketId: string;
  tokenId: string;
  price: number;
  bid?: number;
  ask?: number;
  volume?: number;
}

export interface CollectorConfig {
  enabled: boolean;
  snapshotIntervalMs: number;   // How often to save snapshots (60000 = 1 min)
  batchSize: number;            // Number of prices to batch before insert
  retentionDays: number;        // How long to keep data (30 days)
  cleanupIntervalMs: number;    // How often to run cleanup (86400000 = 24h)
}

const DEFAULT_CONFIG: CollectorConfig = {
  enabled: true,
  snapshotIntervalMs: 60000,  // 1 minute
  batchSize: 50,
  retentionDays: 30,
  cleanupIntervalMs: 86400000,  // 24 hours
};

export class DataCollectorService extends EventEmitter {
  private config: CollectorConfig;
  private priceBuffer: Map<string, PriceData> = new Map();
  private snapshotInterval: NodeJS.Timeout | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private recordCount = 0;

  constructor(config?: Partial<CollectorConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the data collector
   */
  start(): void {
    if (this.isRunning) {
      console.log('[DataCollector] Already running');
      return;
    }

    if (!isDatabaseConfigured()) {
      console.warn('[DataCollector] Database not configured - cannot start');
      return;
    }

    this.isRunning = true;
    console.log(`[DataCollector] Started (snapshot interval: ${this.config.snapshotIntervalMs / 1000}s)`);

    // Schedule periodic snapshots
    this.snapshotInterval = setInterval(() => {
      this.saveSnapshot();
    }, this.config.snapshotIntervalMs);

    // Schedule cleanup
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupIntervalMs);

    this.emit('started');
  }

  /**
   * Stop the data collector
   */
  stop(): void {
    if (this.snapshotInterval) {
      clearInterval(this.snapshotInterval);
      this.snapshotInterval = null;
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Save any remaining buffered data
    this.saveSnapshot();

    this.isRunning = false;
    console.log('[DataCollector] Stopped');
    this.emit('stopped');
  }

  /**
   * Record a price update
   */
  recordPrice(data: PriceData): void {
    if (!this.config.enabled) return;

    const key = `${data.marketId}:${data.tokenId}`;
    this.priceBuffer.set(key, {
      ...data,
      // Keep best values if updating
      bid: data.bid ?? this.priceBuffer.get(key)?.bid,
      ask: data.ask ?? this.priceBuffer.get(key)?.ask,
      volume: data.volume ?? this.priceBuffer.get(key)?.volume,
    });

    // Auto-save if buffer gets large
    if (this.priceBuffer.size >= this.config.batchSize) {
      this.saveSnapshot();
    }
  }

  /**
   * Record multiple price updates
   */
  recordPrices(prices: PriceData[]): void {
    for (const price of prices) {
      this.recordPrice(price);
    }
  }

  /**
   * Save current price buffer to database
   */
  private async saveSnapshot(): Promise<void> {
    if (this.priceBuffer.size === 0) return;
    if (!isDatabaseConfigured()) return;

    const prices = Array.from(this.priceBuffer.values());
    this.priceBuffer.clear();

    const now = new Date();

    try {
      // Batch insert into price_history
      for (const price of prices) {
        await query(
          `INSERT INTO price_history (time, market_id, token_id, close, bid, ask, spread, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (time, market_id, token_id) DO UPDATE SET
             close = EXCLUDED.close,
             bid = EXCLUDED.bid,
             ask = EXCLUDED.ask,
             spread = EXCLUDED.spread`,
          [
            now,
            price.marketId,
            price.tokenId,
            price.price,
            price.bid ?? price.price * 0.99,
            price.ask ?? price.price * 1.01,
            (price.ask ?? price.price * 1.01) - (price.bid ?? price.price * 0.99),
            'collector',
          ]
        );
      }

      this.recordCount += prices.length;

      this.emit('snapshot:saved', {
        timestamp: now,
        count: prices.length,
        totalRecords: this.recordCount,
      });

    } catch (error) {
      console.error('[DataCollector] Failed to save snapshot:', error);
      // Put prices back in buffer to retry
      for (const price of prices) {
        this.priceBuffer.set(`${price.marketId}:${price.tokenId}`, price);
      }
      this.emit('snapshot:error', error);
    }
  }

  /**
   * Clean up old data
   */
  private async cleanup(): Promise<void> {
    if (!isDatabaseConfigured()) return;

    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.config.retentionDays);

      // TimescaleDB has efficient chunk-based deletion
      const result = await query(
        `DELETE FROM price_history WHERE time < $1`,
        [cutoffDate]
      );

      console.log(`[DataCollector] Cleanup: removed old records before ${cutoffDate.toISOString()}`);
      this.emit('cleanup:complete', { cutoffDate });

    } catch (error) {
      console.error('[DataCollector] Cleanup failed:', error);
      this.emit('cleanup:error', error);
    }
  }

  /**
   * Get current buffer size
   */
  getBufferSize(): number {
    return this.priceBuffer.size;
  }

  /**
   * Get collector statistics
   */
  getStats(): {
    isRunning: boolean;
    recordCount: number;
    bufferSize: number;
    config: CollectorConfig;
  } {
    return {
      isRunning: this.isRunning,
      recordCount: this.recordCount,
      bufferSize: this.priceBuffer.size,
      config: { ...this.config },
    };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<CollectorConfig>): void {
    this.config = { ...this.config, ...updates };

    // Restart if interval changed
    if (this.isRunning && (updates.snapshotIntervalMs || updates.cleanupIntervalMs)) {
      this.stop();
      this.start();
    }

    this.emit('config:updated', this.config);
  }

  /**
   * Force save current buffer
   */
  async forceSave(): Promise<void> {
    await this.saveSnapshot();
  }
}

// Singleton instance
let dataCollectorService: DataCollectorService | null = null;

export function getDataCollectorService(): DataCollectorService {
  if (!dataCollectorService) {
    dataCollectorService = new DataCollectorService();
  }
  return dataCollectorService;
}

export function initializeDataCollectorService(config?: Partial<CollectorConfig>): DataCollectorService {
  dataCollectorService = new DataCollectorService(config);
  return dataCollectorService;
}
