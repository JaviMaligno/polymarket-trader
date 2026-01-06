import { pino } from 'pino';
import { RateLimitConfig, RateLimitState } from '../types/index.js';

const logger = pino({ name: 'rate-limiter' });

interface RequestQueueItem {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

/**
 * Token bucket rate limiter with request queuing
 * Ensures we stay within Polymarket's free tier limits
 */
export class RateLimiter {
  private buckets: Map<string, RateLimitState> = new Map();
  private queues: Map<string, RequestQueueItem[]> = new Map();
  private configs: Map<string, RateLimitConfig> = new Map();
  private processingIntervals: Map<string, NodeJS.Timeout> = new Map();

  constructor() {
    // Default rate limit configurations based on Polymarket docs
    this.registerEndpoint({
      endpoint: 'gamma_markets',
      requestsPerWindow: 300,
      windowMs: 10000,
    });

    this.registerEndpoint({
      endpoint: 'gamma_events',
      requestsPerWindow: 500,
      windowMs: 10000,
    });

    this.registerEndpoint({
      endpoint: 'gamma_general',
      requestsPerWindow: 4000,
      windowMs: 10000,
    });

    this.registerEndpoint({
      endpoint: 'clob_prices',
      requestsPerWindow: 1500,
      windowMs: 10000,
    });

    this.registerEndpoint({
      endpoint: 'clob_books',
      requestsPerWindow: 1500,
      windowMs: 10000,
    });

    this.registerEndpoint({
      endpoint: 'clob_history',
      requestsPerWindow: 1000,
      windowMs: 10000,
    });

    this.registerEndpoint({
      endpoint: 'data_trades',
      requestsPerWindow: 200,
      windowMs: 10000,
    });

    this.registerEndpoint({
      endpoint: 'data_positions',
      requestsPerWindow: 150,
      windowMs: 10000,
    });
  }

  /**
   * Register a new rate-limited endpoint
   */
  registerEndpoint(config: RateLimitConfig): void {
    this.configs.set(config.endpoint, config);
    this.buckets.set(config.endpoint, {
      tokens: config.requestsPerWindow,
      lastRefill: Date.now(),
    });
    this.queues.set(config.endpoint, []);

    // Start processing queue
    this.startQueueProcessor(config.endpoint);

    logger.info(
      { endpoint: config.endpoint, limit: config.requestsPerWindow, windowMs: config.windowMs },
      'Registered rate limit endpoint'
    );
  }

  /**
   * Acquire a token for the given endpoint
   * Returns a promise that resolves when a token is available
   */
  async acquire(endpoint: string, timeoutMs: number = 30000): Promise<void> {
    const config = this.configs.get(endpoint);
    if (!config) {
      throw new Error(`Unknown endpoint: ${endpoint}`);
    }

    // Refill tokens if needed
    this.refillTokens(endpoint);

    const bucket = this.buckets.get(endpoint)!;

    // If tokens available, consume immediately
    if (bucket.tokens > 0) {
      bucket.tokens--;
      return;
    }

    // Otherwise, queue the request
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        // Remove from queue on timeout
        const queue = this.queues.get(endpoint)!;
        const index = queue.findIndex((item) => item.resolve === resolve);
        if (index !== -1) {
          queue.splice(index, 1);
        }
        reject(new Error(`Rate limit timeout for ${endpoint}`));
      }, timeoutMs);

      this.queues.get(endpoint)!.push({ resolve, reject, timeout });
    });
  }

  /**
   * Get current token count for an endpoint
   */
  getAvailableTokens(endpoint: string): number {
    this.refillTokens(endpoint);
    return this.buckets.get(endpoint)?.tokens ?? 0;
  }

  /**
   * Get all endpoint stats
   */
  getStats(): Record<string, { available: number; limit: number; queueLength: number }> {
    const stats: Record<string, { available: number; limit: number; queueLength: number }> = {};

    for (const [endpoint, config] of this.configs) {
      this.refillTokens(endpoint);
      stats[endpoint] = {
        available: this.buckets.get(endpoint)!.tokens,
        limit: config.requestsPerWindow,
        queueLength: this.queues.get(endpoint)!.length,
      };
    }

    return stats;
  }

  /**
   * Refill tokens based on elapsed time
   */
  private refillTokens(endpoint: string): void {
    const config = this.configs.get(endpoint);
    const bucket = this.buckets.get(endpoint);

    if (!config || !bucket) return;

    const now = Date.now();
    const elapsed = now - bucket.lastRefill;

    if (elapsed >= config.windowMs) {
      // Full refill
      bucket.tokens = config.requestsPerWindow;
      bucket.lastRefill = now;
    } else {
      // Partial refill (linear replenishment)
      const tokensToAdd = Math.floor(
        (elapsed / config.windowMs) * config.requestsPerWindow
      );

      if (tokensToAdd > 0) {
        bucket.tokens = Math.min(
          config.requestsPerWindow,
          bucket.tokens + tokensToAdd
        );
        bucket.lastRefill = now;
      }
    }
  }

  /**
   * Process queued requests when tokens become available
   */
  private startQueueProcessor(endpoint: string): void {
    const config = this.configs.get(endpoint)!;

    // Process queue at intervals based on refill rate
    const interval = setInterval(() => {
      this.refillTokens(endpoint);

      const bucket = this.buckets.get(endpoint)!;
      const queue = this.queues.get(endpoint)!;

      while (bucket.tokens > 0 && queue.length > 0) {
        const item = queue.shift()!;
        bucket.tokens--;
        clearTimeout(item.timeout);
        item.resolve();
      }
    }, Math.max(100, config.windowMs / config.requestsPerWindow));

    this.processingIntervals.set(endpoint, interval);
  }

  /**
   * Stop all queue processors
   */
  stop(): void {
    for (const interval of this.processingIntervals.values()) {
      clearInterval(interval);
    }
    this.processingIntervals.clear();

    // Reject all pending requests
    for (const [endpoint, queue] of this.queues) {
      for (const item of queue) {
        clearTimeout(item.timeout);
        item.reject(new Error('Rate limiter stopped'));
      }
      queue.length = 0;
    }
  }
}

// Singleton instance
let rateLimiterInstance: RateLimiter | null = null;

export function getRateLimiter(): RateLimiter {
  if (!rateLimiterInstance) {
    rateLimiterInstance = new RateLimiter();
  }
  return rateLimiterInstance;
}
