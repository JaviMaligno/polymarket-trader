/**
 * Polymarket Service
 *
 * Connects to Polymarket CLOB API for real-time market data.
 * Integrates with SignalEngine to provide live price feeds.
 */

import { EventEmitter } from 'events';
import { isDatabaseConfigured, query } from '../database/index.js';
import { getSignalEngine } from './SignalEngine.js';
import { getDataCollectorService, type PriceData } from './DataCollectorService.js';

export interface PolymarketConfig {
  apiUrl: string;
  wsUrl: string;
  pollingIntervalMs: number;
  maxMarketsToTrack: number;
  marketsToFetch: number;        // Fetch more markets for diversification
  maxMarketsPerCategory: number; // Max markets per category for diversification
  autoDiscoverMarkets: boolean;
  minVolume24h: number;
  minLiquidity: number;
  // Rate limiting
  requestDelayMs: number;       // Delay between individual requests
  maxRequestsPerMinute: number; // Max requests per minute
  backoffMultiplier: number;    // Multiplier for exponential backoff
  maxBackoffMs: number;         // Max backoff delay
}

const DEFAULT_CONFIG: PolymarketConfig = {
  apiUrl: 'https://clob.polymarket.com',
  wsUrl: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
  pollingIntervalMs: 60000,  // 60 seconds (increased from 30)
  maxMarketsToTrack: 50,     // Reduced from 100: e2-micro OOM with 100 markets
  marketsToFetch: 200,       // Fetch more for diversified selection
  maxMarketsPerCategory: 8,  // Max 8 per category ensures diversity across ~6+ categories
  autoDiscoverMarkets: true,
  minVolume24h: 1000,
  minLiquidity: 500,
  // Rate limiting - very conservative to avoid 429s
  requestDelayMs: 1000,         // 1 second between requests (1 req/sec max)
  maxRequestsPerMinute: 30,     // 30 requests per minute
  backoffMultiplier: 3,         // Triple backoff on each 429
  maxBackoffMs: 60000,          // Max 60 second backoff
};

// Startup delay to allow rate limits to reset during deploy (2 minutes default)
const STARTUP_DELAY_MS = parseInt(process.env.POLYMARKET_STARTUP_DELAY_MS || '120000', 10);

export interface PolymarketMarket {
  id: string;
  conditionId: string;
  question: string;
  outcomes: string[];
  outcomePrices: number[];
  tokenIds: string[];
  volume: number;
  liquidity: number;
  endDate: Date;
  isActive: boolean;
  lastUpdate: Date;
  tags: string[];
  category: string;  // Primary category for diversification
}

export interface PolymarketPrice {
  marketId: string;
  tokenId: string;
  outcome: string;
  price: number;
  bid: number;
  ask: number;
  spread: number;
  timestamp: Date;
}

interface ClobMarketResponse {
  condition_id: string;
  question_id: string;
  question: string;
  tokens: Array<{
    token_id: string;
    outcome: string;
    price: number;
  }>;
  volume: number;
  liquidity: number;
  end_date_iso: string;
  active: boolean;
  tags?: string[];
}

interface ClobMarketsResponse {
  data?: ClobMarketResponse[];
  next_cursor?: string;
}

export class PolymarketService extends EventEmitter {
  private config: PolymarketConfig;
  private isRunning = false;
  private markets: Map<string, PolymarketMarket> = new Map();
  private prices: Map<string, PolymarketPrice> = new Map();
  private pollingInterval: NodeJS.Timeout | null = null;
  private discoveryInterval: NodeJS.Timeout | null = null;
  private lastUpdate: Date | null = null;
  private errorCount = 0;
  private currentBackoffMs = 0;
  private consecutiveErrors = 0;
  private isPolling = false;  // Lock to prevent concurrent polling

  constructor(config?: Partial<PolymarketConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Sleep for a specified duration
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Calculate backoff delay based on consecutive errors
   */
  private calculateBackoff(): number {
    if (this.consecutiveErrors === 0) return 0;
    const backoff = this.config.requestDelayMs * Math.pow(this.config.backoffMultiplier, this.consecutiveErrors);
    return Math.min(backoff, this.config.maxBackoffMs);
  }

  /**
   * Start the Polymarket service
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[PolymarketService] Already running');
      return;
    }

    this.isRunning = true;

    // Emit started immediately so health checks pass
    this.emit('started');
    console.log('[PolymarketService] Service registered');

    // Add startup delay to allow rate limits to reset during deploy
    // This prevents the new instance from hitting 429s immediately
    if (STARTUP_DELAY_MS > 0) {
      console.log(`[PolymarketService] Waiting ${STARTUP_DELAY_MS / 1000}s before making API calls (rate limit cooldown)...`);
      await this.sleep(STARTUP_DELAY_MS);
    }

    console.log('[PolymarketService] Starting API operations...');

    // Verify API is reachable
    try {
      await this.healthCheck();
      console.log('[PolymarketService] API health check passed');
      this.consecutiveErrors = 0;
    } catch (error) {
      console.warn('[PolymarketService] API health check failed, will retry later:', error);
      this.consecutiveErrors++;
    }

    // Discover markets if enabled (with extra delay if health check failed)
    if (this.config.autoDiscoverMarkets) {
      if (this.consecutiveErrors > 0) {
        console.log('[PolymarketService] Waiting 30s after health check failure before discovery...');
        await this.sleep(30000);
      }
      await this.discoverMarkets();
    }

    // Start polling (with delay to avoid immediate rate limits after discovery)
    console.log(`[PolymarketService] Will start polling in ${this.config.pollingIntervalMs}ms`);
    this.pollingInterval = setInterval(() => {
      this.pollMarkets();
    }, this.config.pollingIntervalMs);

    // Discovery interval (every 10 minutes instead of 5)
    if (this.config.autoDiscoverMarkets) {
      this.discoveryInterval = setInterval(() => {
        this.discoverMarkets();
      }, 600000);  // 10 minutes
    }

    console.log('[PolymarketService] Fully started');
  }

  /**
   * Stop the service
   */
  stop(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    if (this.discoveryInterval) {
      clearInterval(this.discoveryInterval);
      this.discoveryInterval = null;
    }

    this.isRunning = false;
    console.log('[PolymarketService] Stopped');
    this.emit('stopped');
  }

  /**
   * Health check the API
   */
  private async healthCheck(): Promise<void> {
    const response = await fetch(`${this.config.apiUrl}/`);
    if (!response.ok) {
      throw new Error(`API health check failed: ${response.status}`);
    }
  }

  /**
   * Extract primary category from tags array
   * Priority: Politics > Crypto > Sports > Entertainment > Other
   */
  private extractCategory(tags: string[]): string {
    if (!tags || tags.length === 0) return 'Other';

    const normalizedTags = tags.map(t => t.toLowerCase());

    // Politics category
    if (normalizedTags.some(t =>
      t.includes('politic') || t.includes('election') || t.includes('president') ||
      t.includes('congress') || t.includes('senate') || t.includes('trump') ||
      t.includes('biden') || t.includes('republican') || t.includes('democrat')
    )) return 'Politics';

    // Crypto category
    if (normalizedTags.some(t =>
      t.includes('crypto') || t.includes('bitcoin') || t.includes('ethereum') ||
      t.includes('blockchain') || t.includes('defi') || t.includes('nft') ||
      t.includes('token')
    )) return 'Crypto';

    // Sports category
    if (normalizedTags.some(t =>
      t.includes('nba') || t.includes('nfl') || t.includes('nhl') ||
      t.includes('mlb') || t.includes('soccer') || t.includes('football') ||
      t.includes('basketball') || t.includes('sports') || t.includes('ncaa') ||
      t.includes('tennis') || t.includes('golf') || t.includes('ufc') ||
      t.includes('mma') || t.includes('boxing') || t.includes('f1') ||
      t.includes('racing')
    )) return 'Sports';

    // Entertainment category
    if (normalizedTags.some(t =>
      t.includes('entertainment') || t.includes('movie') || t.includes('oscar') ||
      t.includes('music') || t.includes('award') || t.includes('celebrity') ||
      t.includes('tv') || t.includes('streaming')
    )) return 'Entertainment';

    // Finance/Economy category
    if (normalizedTags.some(t =>
      t.includes('finance') || t.includes('economy') || t.includes('stock') ||
      t.includes('market') || t.includes('fed') || t.includes('inflation') ||
      t.includes('interest rate')
    )) return 'Finance';

    // Tech category
    if (normalizedTags.some(t =>
      t.includes('tech') || t.includes('ai') || t.includes('artificial intelligence') ||
      t.includes('openai') || t.includes('google') || t.includes('apple') ||
      t.includes('microsoft') || t.includes('meta')
    )) return 'Tech';

    // Science/Weather
    if (normalizedTags.some(t =>
      t.includes('science') || t.includes('weather') || t.includes('climate') ||
      t.includes('space') || t.includes('nasa')
    )) return 'Science';

    return 'Other';
  }

  /**
   * Select diversified markets across categories
   * Ensures no single category dominates the selection
   */
  private selectDiversifiedMarkets(allMarkets: PolymarketMarket[]): PolymarketMarket[] {
    // Group markets by category
    const byCategory = new Map<string, PolymarketMarket[]>();

    for (const market of allMarkets) {
      const cat = market.category;
      if (!byCategory.has(cat)) {
        byCategory.set(cat, []);
      }
      byCategory.get(cat)!.push(market);
    }

    // Sort each category by volume (highest first)
    for (const markets of byCategory.values()) {
      markets.sort((a, b) => b.volume - a.volume);
    }

    const selected: PolymarketMarket[] = [];
    const maxPerCategory = this.config.maxMarketsPerCategory;
    const maxTotal = this.config.maxMarketsToTrack;

    // First pass: take up to maxPerCategory from each category
    for (const [category, markets] of byCategory) {
      const toTake = Math.min(maxPerCategory, markets.length);
      selected.push(...markets.slice(0, toTake));
      console.log(`[PolymarketService] Category '${category}': ${toTake}/${markets.length} markets selected`);
    }

    // If we have less than maxTotal, fill with remaining high-volume markets
    if (selected.length < maxTotal) {
      const selectedIds = new Set(selected.map(m => m.id));
      const remaining = allMarkets
        .filter(m => !selectedIds.has(m.id))
        .sort((a, b) => b.volume - a.volume);

      const needed = maxTotal - selected.length;
      selected.push(...remaining.slice(0, needed));

      if (remaining.length > 0) {
        console.log(`[PolymarketService] Added ${Math.min(needed, remaining.length)} additional high-volume markets`);
      }
    }

    // If we have more than maxTotal, trim (shouldn't happen with proper config)
    if (selected.length > maxTotal) {
      // Sort by volume and keep top N
      selected.sort((a, b) => b.volume - a.volume);
      selected.length = maxTotal;
    }

    return selected;
  }

  /**
   * Discover active markets with good volume
   * Fetches more markets than needed and applies diversified selection
   */
  async discoverMarkets(): Promise<PolymarketMarket[]> {
    console.log('[PolymarketService] Discovering markets...');

    try {
      // Apply any current backoff before making request
      const backoff = this.calculateBackoff();
      if (backoff > 0) {
        console.log(`[PolymarketService] Applying backoff: ${backoff}ms before discovery`);
        await this.sleep(backoff);
      }

      // Fetch more markets than we need for diversified selection
      const response = await fetch(
        `${this.config.apiUrl}/markets?active=true&closed=false&limit=${this.config.marketsToFetch}`
      );

      // Handle rate limiting (429)
      if (response.status === 429) {
        this.consecutiveErrors++;
        const waitTime = this.calculateBackoff();
        console.warn(`[PolymarketService] Rate limited (429) during discovery, will retry in ${waitTime / 1000}s`);
        await this.sleep(waitTime);
        // Return empty array, will retry on next interval
        return [];
      }

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      // Reset consecutive errors on success
      this.consecutiveErrors = 0;

      const data = await response.json() as ClobMarketsResponse;
      const marketsData = Array.isArray(data) ? data : (data.data || []);
      const candidateMarkets: PolymarketMarket[] = [];

      // First pass: filter and categorize all markets
      for (const m of marketsData) {
        // Filter by volume and liquidity
        if (m.volume < this.config.minVolume24h) continue;
        if (m.liquidity < this.config.minLiquidity) continue;

        const tags = m.tags || [];
        const category = this.extractCategory(tags);

        const market: PolymarketMarket = {
          id: m.condition_id,
          conditionId: m.condition_id,
          question: m.question,
          outcomes: m.tokens.map((t: { outcome: string }) => t.outcome),
          outcomePrices: m.tokens.map((t: { price: number }) => t.price),
          tokenIds: m.tokens.map((t: { token_id: string }) => t.token_id),
          volume: m.volume,
          liquidity: m.liquidity,
          endDate: new Date(m.end_date_iso),
          isActive: m.active,
          lastUpdate: new Date(),
          tags,
          category,
        };

        candidateMarkets.push(market);
      }

      console.log(`[PolymarketService] Found ${candidateMarkets.length} candidate markets (from ${marketsData.length} fetched)`);

      // Apply diversified selection
      const selectedMarkets = this.selectDiversifiedMarkets(candidateMarkets);

      // Update internal state with selected markets
      this.markets.clear();
      for (const market of selectedMarkets) {
        this.markets.set(market.id, market);

        // Also cache prices
        for (let i = 0; i < market.tokenIds.length; i++) {
          const price: PolymarketPrice = {
            marketId: market.id,
            tokenId: market.tokenIds[i],
            outcome: market.outcomes[i],
            price: market.outcomePrices[i],
            bid: market.outcomePrices[i] * 0.99,
            ask: market.outcomePrices[i] * 1.01,
            spread: market.outcomePrices[i] * 0.02,
            timestamp: new Date(),
          };
          this.prices.set(`${market.id}:${market.tokenIds[i]}`, price);
        }
      }

      console.log(`[PolymarketService] Selected ${selectedMarkets.length} diversified markets`);

      // Update SignalEngine with discovered markets
      this.updateSignalEngineMarkets(selectedMarkets);

      this.emit('markets:discovered', selectedMarkets);
      return selectedMarkets;

    } catch (error) {
      console.error('[PolymarketService] Market discovery failed:', error);
      this.errorCount++;
      return [];
    }
  }

  /**
   * Poll all tracked markets for price updates
   */
  private async pollMarkets(): Promise<void> {
    if (this.markets.size === 0) {
      return;
    }

    // Prevent concurrent polling
    if (this.isPolling) {
      console.log('[PolymarketService] Poll already in progress, skipping');
      return;
    }
    this.isPolling = true;

    const priceUpdates: PriceData[] = [];
    const marketIds = Array.from(this.markets.keys());
    let successCount = 0;
    let errorCount = 0;

    for (const marketId of marketIds) {
      // Apply rate limiting delay
      const delay = this.config.requestDelayMs + this.calculateBackoff();
      if (delay > 0) {
        await this.sleep(delay);
      }

      try {
        const updatedMarket = await this.fetchMarket(marketId);

        if (updatedMarket) {
          this.markets.set(marketId, updatedMarket);
          successCount++;

          // Reset consecutive errors on success
          if (this.consecutiveErrors > 0) {
            this.consecutiveErrors = Math.max(0, this.consecutiveErrors - 1);
          }

          // Update prices
          for (let i = 0; i < updatedMarket.tokenIds.length; i++) {
            const price: PolymarketPrice = {
              marketId: updatedMarket.id,
              tokenId: updatedMarket.tokenIds[i],
              outcome: updatedMarket.outcomes[i],
              price: updatedMarket.outcomePrices[i],
              bid: updatedMarket.outcomePrices[i] * 0.99,
              ask: updatedMarket.outcomePrices[i] * 1.01,
              spread: updatedMarket.outcomePrices[i] * 0.02,
              timestamp: new Date(),
            };

            this.prices.set(`${marketId}:${price.tokenId}`, price);
            this.emit('price', price);

            // Collect for data collector
            priceUpdates.push({
              marketId: price.marketId,
              tokenId: price.tokenId,
              price: price.price,
              bid: price.bid,
              ask: price.ask,
            });
          }
        }
      } catch (error) {
        errorCount++;
        // Check for rate limit error
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('429')) {
          this.consecutiveErrors++;
          const backoff = this.calculateBackoff();
          console.warn(`[PolymarketService] Rate limited, stopping poll early and backing off for ${backoff}ms`);
          await this.sleep(backoff);
          // Break out of the loop - don't continue polling after 429
          break;
        }
      }
    }

    this.lastUpdate = new Date();
    this.errorCount = errorCount;

    if (successCount > 0 || errorCount > 0) {
      console.log(`[PolymarketService] Polled ${successCount}/${marketIds.length} markets (${errorCount} errors)`);
    }

    // Send price updates to data collector
    if (priceUpdates.length > 0) {
      const collector = getDataCollectorService();
      collector.recordPrices(priceUpdates);
    }

    // Release polling lock
    this.isPolling = false;
    this.emit('prices:updated', priceUpdates.length);
  }

  /**
   * Fetch a single market
   */
  private async fetchMarket(marketId: string): Promise<PolymarketMarket | null> {
    try {
      const response = await fetch(`${this.config.apiUrl}/markets/${marketId}`);

      if (!response.ok) {
        if (response.status === 404) {
          this.markets.delete(marketId);
          return null;
        }
        // For 429, throw a specific error so pollMarkets can handle it
        if (response.status === 429) {
          throw new Error('Rate limited: 429');
        }
        throw new Error(`API error: ${response.status}`);
      }

      const m = await response.json() as ClobMarketResponse;
      const tags = m.tags || [];
      const category = this.extractCategory(tags);

      return {
        id: marketId,
        conditionId: m.condition_id,
        question: m.question,
        outcomes: m.tokens.map((t: { outcome: string }) => t.outcome),
        outcomePrices: m.tokens.map((t: { price: number }) => t.price),
        tokenIds: m.tokens.map((t: { token_id: string }) => t.token_id),
        volume: m.volume,
        liquidity: m.liquidity,
        endDate: new Date(m.end_date_iso),
        isActive: m.active,
        lastUpdate: new Date(),
        tags,
        category,
      };
    } catch (error) {
      console.error(`[PolymarketService] Failed to fetch market ${marketId}:`, error);
      return null;
    }
  }

  /**
   * Update SignalEngine with current markets
   */
  private updateSignalEngineMarkets(markets: PolymarketMarket[]): void {
    try {
      const engine = getSignalEngine();

      const activeMarkets = markets
        .filter(m => m.isActive)
        .slice(0, this.config.maxMarketsToTrack)
        .map(m => ({
          id: m.id,
          question: m.question,
          tokenIdYes: m.tokenIds[0],
          tokenIdNo: m.tokenIds[1],
          currentPrice: m.outcomePrices[0],
          volume24h: m.volume,
        }));

      engine.setActiveMarkets(activeMarkets);
      console.log(`[PolymarketService] Updated SignalEngine with ${activeMarkets.length} markets`);
    } catch (error) {
      console.error('[PolymarketService] Failed to update SignalEngine:', error);
    }
  }

  /**
   * Manually subscribe to a market
   */
  async subscribeMarket(marketId: string): Promise<PolymarketMarket | null> {
    const market = await this.fetchMarket(marketId);
    if (market) {
      this.markets.set(marketId, market);
      console.log(`[PolymarketService] Subscribed to market: ${marketId}`);
      this.emit('market:subscribed', market);
    }
    return market;
  }

  /**
   * Unsubscribe from a market
   */
  unsubscribeMarket(marketId: string): void {
    this.markets.delete(marketId);
    // Remove prices
    for (const key of this.prices.keys()) {
      if (key.startsWith(`${marketId}:`)) {
        this.prices.delete(key);
      }
    }
    console.log(`[PolymarketService] Unsubscribed from market: ${marketId}`);
    this.emit('market:unsubscribed', marketId);
  }

  /**
   * Search for markets by query
   */
  async searchMarkets(query: string): Promise<PolymarketMarket[]> {
    try {
      const response = await fetch(
        `${this.config.apiUrl}/markets?active=true&closed=false&limit=20`
      );

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const data = await response.json() as ClobMarketsResponse;
      const marketsData = Array.isArray(data) ? data : (data.data || []);

      const queryLower = query.toLowerCase();

      return marketsData
        .filter(m => m.question.toLowerCase().includes(queryLower))
        .map(m => {
          const tags = m.tags || [];
          return {
            id: m.condition_id,
            conditionId: m.condition_id,
            question: m.question,
            outcomes: m.tokens.map((t: { outcome: string }) => t.outcome),
            outcomePrices: m.tokens.map((t: { price: number }) => t.price),
            tokenIds: m.tokens.map((t: { token_id: string }) => t.token_id),
            volume: m.volume,
            liquidity: m.liquidity,
            endDate: new Date(m.end_date_iso),
            isActive: m.active,
            lastUpdate: new Date(),
            tags,
            category: this.extractCategory(tags),
          };
        });
    } catch (error) {
      console.error('[PolymarketService] Search failed:', error);
      return [];
    }
  }

  /**
   * Get all tracked markets
   */
  getMarkets(): PolymarketMarket[] {
    return Array.from(this.markets.values());
  }

  /**
   * Get a specific market
   */
  getMarket(marketId: string): PolymarketMarket | undefined {
    return this.markets.get(marketId);
  }

  /**
   * Get price for a token
   */
  getPrice(marketId: string, tokenId: string): PolymarketPrice | undefined {
    return this.prices.get(`${marketId}:${tokenId}`);
  }

  /**
   * Get all prices
   */
  getAllPrices(): PolymarketPrice[] {
    return Array.from(this.prices.values());
  }

  /**
   * Get service status
   */
  getStatus(): {
    isRunning: boolean;
    marketCount: number;
    lastUpdate: Date | null;
    errorCount: number;
    config: PolymarketConfig;
  } {
    return {
      isRunning: this.isRunning,
      marketCount: this.markets.size,
      lastUpdate: this.lastUpdate,
      errorCount: this.errorCount,
      config: { ...this.config },
    };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<PolymarketConfig>): void {
    const wasRunning = this.isRunning;

    if (wasRunning && updates.pollingIntervalMs) {
      this.stop();
    }

    this.config = { ...this.config, ...updates };

    if (wasRunning && updates.pollingIntervalMs) {
      this.start();
    }

    this.emit('config:updated', this.config);
  }
}

// Singleton instance
let polymarketService: PolymarketService | null = null;

export function getPolymarketService(): PolymarketService {
  if (!polymarketService) {
    polymarketService = new PolymarketService();
  }
  return polymarketService;
}

export function initializePolymarketService(config?: Partial<PolymarketConfig>): PolymarketService {
  polymarketService = new PolymarketService(config);
  return polymarketService;
}
