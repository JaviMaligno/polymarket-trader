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

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Import from signals package
import {
  MomentumSignal,
  MeanReversionSignal,
  WalletTrackingSignal,
  OrderFlowImbalanceSignal,
  MultiLevelOFISignal,
  HawkesSignal,
  RLSignal,
  WeightedAverageCombiner,
  type ISignal,
  type SignalContext,
  type SignalOutput,
  type MarketInfo,
  type PriceBar,
} from '@polymarket-trader/signals';

export interface SignalEngineConfig {
  enabled: boolean;
  computeIntervalMs: number;     // How often to compute signals (60000 = 1 min)
  maxMarketsPerCycle: number;    // Max markets to process per cycle
  minPriceBars: number;          // Minimum price bars needed
  syncWeightsIntervalMs: number; // How often to sync weights from DB
}

const DEFAULT_CONFIG: SignalEngineConfig = {
  enabled: true,
  computeIntervalMs: 60000,      // 1 minute
  maxMarketsPerCycle: 50,
  minPriceBars: 30,
  syncWeightsIntervalMs: 300000, // 5 minutes
};

interface ActiveMarket {
  id: string;
  question: string;
  tokenIdYes: string;
  tokenIdNo?: string;
  currentPrice: number;
  volume24h?: number;
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

    // Initialize combiner with optimized weights and params
    // Core signals: 50% total, Microstructure: 35%, RL: 15%
    this.combiner = new WeightedAverageCombiner(
      {
        // Core signals (50%)
        momentum: 0.17,
        mean_reversion: 0.17,
        wallet_tracking: 0.16,
        // Microstructure signals (35%)
        ofi: 0.12,           // Order Flow Imbalance
        mlofi: 0.12,         // Multi-Level OFI
        hawkes: 0.11,        // Trade clustering (Hawkes process)
        // RL signal (15%)
        rl: 0.15,            // Reinforcement Learning
      },
      {
        // Optimized params (from optimization runs)
        minCombinedConfidence: 0.43,
        minCombinedStrength: 0.27,
      }
    );
  }

  /**
   * Initialize all signal generators
   */
  private initializeSignals(): void {
    // Core signals
    this.signals.set('momentum', new MomentumSignal());
    this.signals.set('mean_reversion', new MeanReversionSignal());
    this.signals.set('wallet_tracking', new WalletTrackingSignal());

    // Microstructure signals (order flow analysis)
    this.signals.set('ofi', new OrderFlowImbalanceSignal());
    this.signals.set('mlofi', new MultiLevelOFISignal());
    this.signals.set('hawkes', new HawkesSignal());

    // RL Signal (if model is available)
    this.initializeRLSignal();

    console.log(`[SignalEngine] Initialized ${this.signals.size} signal generators`);
  }

  /**
   * Initialize RL signal with trained model
   */
  private initializeRLSignal(): void {
    try {
      // Try to load the RL model from various locations
      const modelPaths = [
        path.join(process.cwd(), 'models', 'rl-model.json'),
        path.join(process.cwd(), 'rl-model.json'),
        '/app/models/rl-model.json', // Docker path
      ];

      let modelData: { weights: number[][][]; biases?: number[][] } | null = null;
      let loadedPath = '';

      for (const modelPath of modelPaths) {
        if (fs.existsSync(modelPath)) {
          const rawData = fs.readFileSync(modelPath, 'utf-8');
          modelData = JSON.parse(rawData);
          loadedPath = modelPath;
          break;
        }
      }

      if (modelData) {
        const rlSignal = new RLSignal({ minConfidence: 0.6 });
        rlSignal.loadModel(modelData);
        this.signals.set('rl', rlSignal);
        console.log(`[SignalEngine] Loaded RL model from ${loadedPath}`);
      } else {
        console.log('[SignalEngine] No RL model found, skipping RL signal');
      }
    } catch (error) {
      console.error('[SignalEngine] Failed to load RL model:', error);
    }
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
   * Filters out markets with extreme prices (no profitable trades possible)
   */
  setActiveMarkets(markets: ActiveMarket[]): void {
    // Filter out markets with extreme prices where there's no profitable trade opportunity
    // - Price < 5%: Market is heavily bearish, buying No at 95%+ has <5% max ROI
    // - Price > 95%: Market is heavily bullish, buying Yes at 95%+ has <5% max ROI
    const MIN_PRICE = 0.05;
    const MAX_PRICE = 0.95;

    const filtered = markets.filter(m => {
      const price = m.currentPrice;
      if (price < MIN_PRICE || price > MAX_PRICE) {
        return false;
      }
      return true;
    });

    const excluded = markets.length - filtered.length;
    if (excluded > 0) {
      console.log(`[SignalEngine] Filtered ${excluded} markets with extreme prices (<${MIN_PRICE * 100}% or >${MAX_PRICE * 100}%)`);
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

    console.log(`[SignalEngine] Computing signals for ${marketsToProcess.length} markets`);

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
    console.log(`[SignalEngine] Generated ${results.length} signals in ${elapsed}ms`);

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
      const priceHistory = await query<{
        time: Date;
        close: number;
        bid: number;
        ask: number;
      }>(
        `SELECT time, close, bid, ask
         FROM price_history
         WHERE market_id = $1
         ORDER BY time DESC
         LIMIT 100`,
        [market.id]
      );

      if (priceHistory.rows.length < this.config.minPriceBars) {
        return this.buildMockContext(market);
      }

      // Convert to PriceBar format (oldest to newest)
      const priceBars: PriceBar[] = priceHistory.rows
        .reverse()
        .map(row => ({
          time: new Date(row.time),
          open: parseFloat(String(row.close)),
          high: parseFloat(String(row.close)) * 1.01,
          low: parseFloat(String(row.close)) * 0.99,
          close: parseFloat(String(row.close)),
          volume: 1000, // Placeholder
        }));

      const marketInfo: MarketInfo = {
        id: market.id,
        question: market.question,
        isActive: true,
        isResolved: false,
        tokenIdYes: market.tokenIdYes,
        tokenIdNo: market.tokenIdNo,
        currentPriceYes: market.currentPrice,
        volume24h: market.volume24h,
      };

      return {
        currentTime: new Date(),
        market: marketInfo,
        priceBars,
        recentTrades: [],
      };
    } catch (error) {
      console.error('[SignalEngine] Failed to build context from DB:', error);
      return this.buildMockContext(market);
    }
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
      isActive: true,
      isResolved: false,
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
    const tokenId = direction === 'long'
      ? market.tokenIdYes
      : (market.tokenIdNo || market.tokenIdYes); // Fallback if No token not available

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
      console.log(`[SignalEngine] Automation processed ${result.processed}, executed ${result.executed}`);

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
