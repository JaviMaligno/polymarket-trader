/**
 * Signal Engine Service
 *
 * Integrates the signal generation framework with the automation system.
 * - Loads and manages signal generators (Momentum, MeanReversion, WalletTracking)
 * - Combines signals using weighted average
 * - Syncs weights from database
 * - Runs periodic signal computation
 * - Sends qualifying signals to AutoSignalExecutor
 */

import { EventEmitter } from 'events';
import { isDatabaseConfigured, query } from '../database/index.js';
import { signalWeightsRepo } from '../database/repositories.js';
import { getTradingAutomation } from './TradingAutomation.js';
import type { SignalResult } from './AutoSignalExecutor.js';


// Import from signals package
import {
  MomentumSignal,
  MeanReversionSignal,
  OrderFlowImbalanceSignal,
  MultiLevelOFISignal,
  HawkesSignal,
  WeightedAverageCombiner,
  type ISignal,
  type SignalContext,
  type SignalOutput,
  type MarketInfo,
  type PriceBar,
  type Trade,
} from '@polymarket-trader/signals';

// Import OrderBookSnapshot directly from signal types to avoid name conflict with RL's OrderBookSnapshot
import type { OrderBookSnapshot } from '@polymarket-trader/signals/dist/core/types/signal.types.js';

export interface SignalEngineConfig {
  enabled: boolean;
  computeIntervalMs: number;     // How often to compute signals (60000 = 1 min)
  maxMarketsPerCycle: number;    // Max markets to process per cycle
  minPriceBars: number;          // Minimum price bars needed
  syncWeightsIntervalMs: number; // How often to sync weights from DB
  minCombinedConfidence?: number; // Minimum combined signal confidence (0-1)
  minCombinedStrength?: number;   // Minimum combined signal strength (0-1)
}

const DEFAULT_CONFIG: SignalEngineConfig = {
  enabled: true,
  computeIntervalMs: 60000,      // 1 minute
  maxMarketsPerCycle: 50,
  minPriceBars: 30,
  syncWeightsIntervalMs: 300000, // 5 minutes
  minCombinedConfidence: 0.60,   // Default: high confidence only
  minCombinedStrength: 0.45,     // Default: strong signals only
};

interface ActiveMarket {
  id: string;
  question: string;
  tokenIdYes: string;
  tokenIdNo?: string;
  currentPrice: number;
  volume24h?: number;
  isActive?: boolean;    // Market is still active for trading
  isResolved?: boolean;  // Market has been resolved
}

export class SignalEngine extends EventEmitter {
  private config: SignalEngineConfig;
  private signals: Map<string, ISignal> = new Map();
  private combiner: WeightedAverageCombiner;
  private computeInterval: NodeJS.Timeout | null = null;
  private syncInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private activeMarkets: ActiveMarket[] = [];
  private lastComputeTime: Date | null = null;
  private signalsGenerated = 0;

  constructor(config?: Partial<SignalEngineConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Initialize signal generators
    this.initializeSignals();

    // Initialize combiner with weights for 5 active generators
    // Core signals: 40%, Microstructure: 60%
    this.combiner = new WeightedAverageCombiner(
      {
        // Core signals (40%)
        momentum: 0.20,
        mean_reversion: 0.20,
        // Microstructure signals (60%)
        ofi: 0.20,           // Order Flow Imbalance
        mlofi: 0.20,         // Multi-Level OFI
        hawkes: 0.20,        // Trade clustering (Hawkes process)
      },
      {
        // Use config values (can be overridden from optimization_runs)
        minCombinedConfidence: this.config.minCombinedConfidence ?? 0.60,
        minCombinedStrength: this.config.minCombinedStrength ?? 0.45,
      }
    );
  }

  /**
   * Initialize all signal generators
   * NOTE: WalletTracking disabled (no wallet data source)
   * NOTE: RL disabled (no trained model deployed)
   */
  private initializeSignals(): void {
    // Core signals
    this.signals.set('momentum', new MomentumSignal());
    this.signals.set('mean_reversion', new MeanReversionSignal());

    // Microstructure signals (order flow analysis)
    this.signals.set('ofi', new OrderFlowImbalanceSignal());
    this.signals.set('mlofi', new MultiLevelOFISignal());
    this.signals.set('hawkes', new HawkesSignal());

    console.log(`[SignalEngine] Initialized ${this.signals.size} signal generators`);
  }

  /**
   * Start the signal engine
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[SignalEngine] Already running');
      return;
    }

    if (!this.config.enabled) {
      console.log('[SignalEngine] Disabled in config');
      return;
    }

    this.isRunning = true;
    console.log(`[SignalEngine] Starting (interval: ${this.config.computeIntervalMs / 1000}s)`);

    // Sync weights from database
    await this.syncWeightsFromDatabase();

    // Schedule periodic signal computation
    this.computeInterval = setInterval(() => {
      this.computeSignals();
    }, this.config.computeIntervalMs);

    // Schedule periodic weight sync
    this.syncInterval = setInterval(() => {
      this.syncWeightsFromDatabase();
    }, this.config.syncWeightsIntervalMs);

    // Initial computation
    await this.computeSignals();

    this.emit('started');
  }

  /**
   * Stop the signal engine
   */
  stop(): void {
    if (this.computeInterval) {
      clearInterval(this.computeInterval);
      this.computeInterval = null;
    }
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }

    this.isRunning = false;
    console.log('[SignalEngine] Stopped');
    this.emit('stopped');
  }

  /**
   * Sync signal weights from database
   */
  async syncWeightsFromDatabase(): Promise<void> {
    if (!isDatabaseConfigured()) return;

    try {
      const weights = await signalWeightsRepo.getAll();
      const weightMap: Record<string, number> = {};

      for (const w of weights) {
        if (w.is_enabled) {
          weightMap[w.signal_type] = parseFloat(String(w.weight));
        }
      }

      if (Object.keys(weightMap).length > 0) {
        this.combiner.setWeights(weightMap);
        console.log('[SignalEngine] Synced weights from database:', weightMap);
      }
    } catch (error) {
      console.error('[SignalEngine] Failed to sync weights:', error);
    }
  }

  /**
   * Set active markets to compute signals for
   * Filters out inactive, resolved, and extreme-priced markets
   */
  setActiveMarkets(markets: ActiveMarket[]): void {
    const MIN_PRICE = 0.05;
    const MAX_PRICE = 0.95;

    let inactiveCount = 0;
    let resolvedCount = 0;
    let extremePriceCount = 0;

    const filtered = markets.filter(m => {
      // Filter 1: Skip inactive markets
      if (m.isActive === false) {
        inactiveCount++;
        return false;
      }

      // Filter 2: Skip resolved markets
      if (m.isResolved === true) {
        resolvedCount++;
        return false;
      }

      // Filter 3: Skip extreme prices (no profitable trade opportunity)
      const price = m.currentPrice;
      if (price < MIN_PRICE || price > MAX_PRICE) {
        extremePriceCount++;
        return false;
      }

      return true;
    });

    // Log filtering summary
    const totalExcluded = inactiveCount + resolvedCount + extremePriceCount;
    if (totalExcluded > 0) {
      console.log(`[SignalEngine] Filtered markets: ${inactiveCount} inactive, ${resolvedCount} resolved, ${extremePriceCount} extreme prices`);
    }

    this.activeMarkets = filtered;
    console.log(`[SignalEngine] Updated active markets: ${filtered.length}`);
    this.emit('markets:updated', filtered.length);
  }

  /**
   * Add a market to active list
   */
  addMarket(market: ActiveMarket): void {
    if (!this.activeMarkets.find(m => m.id === market.id)) {
      this.activeMarkets.push(market);
    }
  }

  /**
   * Remove a market from active list
   */
  removeMarket(marketId: string): void {
    this.activeMarkets = this.activeMarkets.filter(m => m.id !== marketId);
  }

  /**
   * Compute signals for all active markets
   */
  async computeSignals(): Promise<SignalResult[]> {
    if (!this.isRunning || this.activeMarkets.length === 0) {
      return [];
    }

    const startTime = Date.now();
    const results: SignalResult[] = [];
    const marketsToProcess = this.activeMarkets.slice(0, this.config.maxMarketsPerCycle);

    // console.log(`[SignalEngine] Computing signals for ${marketsToProcess.length} markets`);

    for (const market of marketsToProcess) {
      try {
        const signal = await this.computeSignalForMarket(market);
        if (signal) {
          results.push(signal);
        }
      } catch (error) {
        console.error(`[SignalEngine] Error computing signal for ${market.id}:`, error);
      }
    }

    this.lastComputeTime = new Date();
    this.signalsGenerated += results.length;

    const elapsed = Date.now() - startTime;
    // console.log(`[SignalEngine] Generated ${results.length} signals in ${elapsed}ms`);

    // Send signals to automation if any
    if (results.length > 0) {
      this.emit('signals:generated', results);
      await this.sendSignalsToAutomation(results);
    }

    return results;
  }

  /**
   * Compute signal for a single market
   */
  private async computeSignalForMarket(market: ActiveMarket): Promise<SignalResult | null> {
    // Build signal context
    const context = await this.buildSignalContext(market);

    if (!context || context.priceBars.length < this.config.minPriceBars) {
      return null;
    }

    // Compute all individual signals
    const signalOutputs: SignalOutput[] = [];

    for (const [signalId, signal] of this.signals) {
      if (!signal.isReady(context)) continue;

      try {
        const output = await signal.compute(context);
        if (output) {
          signalOutputs.push(output);
        }
      } catch (error) {
        console.error(`[SignalEngine] ${signalId} computation failed:`, error);
      }
    }

    if (signalOutputs.length === 0) {
      return null;
    }

    // Combine signals
    const combined = this.combiner.combine(signalOutputs);

    if (!combined || combined.direction === 'NEUTRAL') {
      return null;
    }

    // Convert to SignalResult format for AutoSignalExecutor
    return this.convertToSignalResult(combined, market);
  }

  /**
   * Build SignalContext from market data
   */
  private async buildSignalContext(market: ActiveMarket): Promise<SignalContext | null> {
    if (!isDatabaseConfigured()) {
      return this.buildMockContext(market);
    }

    try {
      // Get price history from database
      // NOTE: market.id from PolymarketService is the condition_id from CLOB API,
      // but price_history.market_id uses Gamma's market.id
      // We JOIN with markets table to find prices by either id or condition_id
      const priceHistory = await query<{
        time: Date;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number | null;
        bid: number;
        ask: number;
      }>(
        `SELECT ph.time, ph.open, ph.high, ph.low, ph.close, ph.volume, ph.bid, ph.ask
         FROM price_history ph
         JOIN markets m ON ph.market_id = m.id
         WHERE m.id = $1 OR m.condition_id = $1
         ORDER BY ph.time DESC
         LIMIT 100`,
        [market.id]
      );

      if (priceHistory.rows.length < this.config.minPriceBars) {
        return this.buildMockContext(market);
      }

      // Convert to PriceBar format (oldest to newest)
      // Use actual OHLC data from database (populated by data-collector with volatility estimation)
      const priceBars: PriceBar[] = priceHistory.rows
        .reverse()
        .map(row => ({
          time: new Date(row.time),
          open: parseFloat(String(row.open)) || parseFloat(String(row.close)),
          high: parseFloat(String(row.high)) || parseFloat(String(row.close)),
          low: parseFloat(String(row.low)) || parseFloat(String(row.close)),
          close: parseFloat(String(row.close)),
          volume: row.volume ? parseFloat(String(row.volume)) : 1000,
        }));

      const marketInfo: MarketInfo = {
        id: market.id,
        question: market.question,
        isActive: market.isActive ?? true,
        isResolved: market.isResolved ?? false,
        tokenIdYes: market.tokenIdYes,
        tokenIdNo: market.tokenIdNo,
        currentPriceYes: market.currentPrice,
        volume24h: market.volume24h,
      };

      // Fetch latest order book snapshot from DB
      const orderBook = await this.fetchOrderBookFromDb(market);

      // Synthesize trades from price bar changes (for OFI and Hawkes)
      const recentTrades = this.synthesizeTradesFromBars(priceBars, market);

      return {
        currentTime: new Date(),
        market: marketInfo,
        priceBars,
        recentTrades,
        orderBook: orderBook ?? undefined,
      };
    } catch (error) {
      console.error('[SignalEngine] Failed to build context from DB:', error);
      return this.buildMockContext(market);
    }
  }

  /**
   * Fetch latest order book snapshot from database
   */
  private async fetchOrderBookFromDb(market: ActiveMarket): Promise<OrderBookSnapshot | null> {
    try {
      const result = await query<{
        time: Date;
        market_id: string;
        token_id: string;
        best_bid: number;
        best_ask: number;
        spread: number;
        mid_price: number;
        bid_depth_10pct: number;
        ask_depth_10pct: number;
      }>(
        `SELECT os.time, os.market_id, os.token_id, os.best_bid, os.best_ask,
                os.spread, os.mid_price, os.bid_depth_10pct, os.ask_depth_10pct
         FROM orderbook_snapshots os
         JOIN markets m ON os.market_id = m.id
         WHERE (m.id = $1 OR m.condition_id = $1)
           AND os.time > NOW() - INTERVAL '10 minutes'
         ORDER BY os.time DESC
         LIMIT 1`,
        [market.id]
      );

      if (result.rows.length === 0) return null;

      const row = result.rows[0];
      return {
        time: new Date(row.time),
        marketId: row.market_id,
        tokenId: row.token_id,
        bestBid: parseFloat(String(row.best_bid)) || 0,
        bestAsk: parseFloat(String(row.best_ask)) || 0,
        spread: parseFloat(String(row.spread)) || 0,
        midPrice: parseFloat(String(row.mid_price)) || 0,
        bidDepth10Pct: parseFloat(String(row.bid_depth_10pct)) || 0,
        askDepth10Pct: parseFloat(String(row.ask_depth_10pct)) || 0,
      };
    } catch (error) {
      console.error('[SignalEngine] Failed to fetch order book:', error);
      return null;
    }
  }

  /**
   * Synthesize Trade objects from price bar changes
   * Since we don't have real trade data, infer trades from OHLC movement
   */
  private synthesizeTradesFromBars(priceBars: PriceBar[], market: ActiveMarket): Trade[] {
    const trades: Trade[] = [];
    const recentBars = priceBars.slice(-30); // Last 30 bars

    for (let i = 1; i < recentBars.length; i++) {
      const bar = recentBars[i];
      const prevBar = recentBars[i - 1];
      const priceChange = bar.close - prevBar.close;

      // Each bar represents aggregated trading activity
      // Infer trade direction from price movement
      const side: 'BUY' | 'SELL' = priceChange >= 0 ? 'BUY' : 'SELL';
      const size = bar.volume > 0 ? bar.volume : 1000;

      // Create a trade from the bar's close
      trades.push({
        time: bar.time,
        marketId: market.id,
        tokenId: market.tokenIdYes,
        side,
        price: bar.close,
        size,
      });

      // If there's significant intra-bar movement (high-low range), add extra trades
      const range = bar.high - bar.low;
      if (range > 0.001) {
        // Add a buy near the low and sell near the high
        trades.push({
          time: bar.time,
          marketId: market.id,
          tokenId: market.tokenIdYes,
          side: 'BUY',
          price: bar.low + range * 0.25,
          size: size * 0.3,
        });
        trades.push({
          time: bar.time,
          marketId: market.id,
          tokenId: market.tokenIdYes,
          side: 'SELL',
          price: bar.high - range * 0.25,
          size: size * 0.3,
        });
      }
    }

    return trades;
  }

  /**
   * Build mock context for testing
   */
  private buildMockContext(market: ActiveMarket): SignalContext {
    const now = new Date();
    const priceBars: PriceBar[] = [];

    // Generate synthetic price history
    let price = market.currentPrice || 0.5;
    for (let i = 60; i >= 0; i--) {
      const time = new Date(now.getTime() - i * 60000);
      const change = (Math.random() - 0.5) * 0.02;
      price = Math.max(0.01, Math.min(0.99, price + change));

      priceBars.push({
        time,
        open: price,
        high: price * 1.005,
        low: price * 0.995,
        close: price,
        volume: Math.random() * 10000,
      });
    }

    const marketInfo: MarketInfo = {
      id: market.id,
      question: market.question,
      isActive: market.isActive ?? true,
      isResolved: market.isResolved ?? false,
      tokenIdYes: market.tokenIdYes,
      tokenIdNo: market.tokenIdNo,
      currentPriceYes: market.currentPrice,
    };

    return {
      currentTime: now,
      market: marketInfo,
      priceBars,
      recentTrades: [],
    };
  }

  /**
   * Convert SignalOutput to SignalResult format
   * Returns null if market price is extreme (no profitable trade possible)
   */
  private convertToSignalResult(
    output: SignalOutput,
    market: ActiveMarket
  ): SignalResult | null {
    // Reject signals for markets with extreme prices
    const MIN_PRICE = 0.05;
    const MAX_PRICE = 0.95;
    if (market.currentPrice < MIN_PRICE || market.currentPrice > MAX_PRICE) {
      return null;
    }

    // Map direction: LONG/SHORT -> long/short
    const direction: 'long' | 'short' = output.direction === 'LONG' ? 'long' : 'short';

    // Preserve original strength (negative = SHORT, positive = LONG)
    const strength = output.strength;

    // Calculate correct price based on direction:
    // - LONG: buy Yes token at Yes price (market.currentPrice)
    // - SHORT: buy No token at No price (1 - Yes price)
    const price = direction === 'long'
      ? market.currentPrice
      : 1 - market.currentPrice;

    // Use the appropriate token ID
    // For SHORT signals, we MUST have a valid No token - don't fallback to Yes
    const tokenId = direction === 'long'
      ? market.tokenIdYes
      : market.tokenIdNo;

    // Skip signal if we don't have the required token
    if (!tokenId) {
      console.log(`[SignalEngine] Skipping ${direction.toUpperCase()} signal for ${output.marketId.substring(0, 12)}... - no valid token_id`);
      return null;
    }

    return {
      signalId: output.signalId,
      marketId: output.marketId,
      tokenId,
      direction,
      strength,
      confidence: output.confidence,
      price,
      metadata: output.metadata,
    };
  }

  /**
   * Send signals to the automation system
   */
  private async sendSignalsToAutomation(signals: SignalResult[]): Promise<void> {
    try {
      const automation = getTradingAutomation();

      if (!automation.isTradingAllowed()) {
        console.log('[SignalEngine] Trading not allowed, skipping signal submission');
        return;
      }

      const result = await automation.processSignals(signals);
      // console.log(`[SignalEngine] Automation processed ${result.processed}, executed ${result.executed}`);

      this.emit('signals:processed', result);
    } catch (error) {
      console.error('[SignalEngine] Failed to send signals to automation:', error);
    }
  }

  /**
   * Manually trigger signal computation
   */
  async forceCompute(): Promise<SignalResult[]> {
    return this.computeSignals();
  }

  /**
   * Get engine status
   */
  getStatus(): {
    isRunning: boolean;
    signalCount: number;
    marketCount: number;
    lastCompute: Date | null;
    signalsGenerated: number;
    weights: Record<string, number>;
  } {
    return {
      isRunning: this.isRunning,
      signalCount: this.signals.size,
      marketCount: this.activeMarkets.length,
      lastCompute: this.lastComputeTime,
      signalsGenerated: this.signalsGenerated,
      weights: this.combiner.getWeights(),
    };
  }

  /**
   * Get available signal types
   */
  getAvailableSignals(): string[] {
    return Array.from(this.signals.keys());
  }

  /**
   * Update weights
   */
  setWeights(weights: Record<string, number>): void {
    this.combiner.setWeights(weights);
    this.emit('weights:updated', weights);
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<SignalEngineConfig>): void {
    const wasRunning = this.isRunning;

    if (wasRunning && (updates.computeIntervalMs || updates.syncWeightsIntervalMs)) {
      this.stop();
    }

    this.config = { ...this.config, ...updates };

    if (wasRunning && (updates.computeIntervalMs || updates.syncWeightsIntervalMs)) {
      this.start();
    }

    this.emit('config:updated', this.config);
  }
}

// Singleton instance
let signalEngine: SignalEngine | null = null;

export function getSignalEngine(): SignalEngine {
  if (!signalEngine) {
    signalEngine = new SignalEngine();
  }
  return signalEngine;
}

export function initializeSignalEngine(config?: Partial<SignalEngineConfig>): SignalEngine {
  signalEngine = new SignalEngine(config);
  return signalEngine;
}
