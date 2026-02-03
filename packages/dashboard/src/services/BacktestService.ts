/**
 * Backtest Service
 *
 * Integrates the backtesting engine with the dashboard API.
 * Provides endpoints to run backtests and view results.
 */

import { EventEmitter } from 'events';
import {
  createBacktestEngine,
  createBacktestConfig,
  PerformanceCalculator,
  PredictionMarketCalculator,
  AGGRESSIVE_PROFILE,
  type BacktestConfig,
  type BacktestResult,
  type MarketData,
  type HistoricalBar,
  type PerformanceMetrics,
  type PredictionMarketMetrics,
} from '@polymarket-trader/backtest';
import {
  MomentumSignal,
  MeanReversionSignal,
  WalletTrackingSignal,
  WeightedAverageCombiner,
  type ISignal,
} from '@polymarket-trader/signals';
import { isDatabaseConfigured, query } from '../database/index.js';

export interface BacktestRequest {
  startDate: string;
  endDate: string;
  initialCapital: number;
  marketIds?: string[];
  signalTypes?: string[];
  signalWeights?: Record<string, number>;
  riskConfig?: {
    maxPositionSizePct?: number;
    maxExposurePct?: number;
    maxDrawdownPct?: number;
    stopLossPct?: number;
    takeProfitPct?: number;
  };
  signalFilters?: {
    minStrength?: number;
    minConfidence?: number;
  };
}

export interface StoredBacktest {
  id: string;
  name: string;
  config: BacktestConfig;
  result: BacktestResult;
  createdAt: Date;
  status: 'pending' | 'running' | 'completed' | 'failed';
  error?: string;
}

export interface BacktestServiceConfig {
  maxConcurrentBacktests: number;
  maxHistoryDays: number;
  defaultSignalTypes: string[];
}

const DEFAULT_CONFIG: BacktestServiceConfig = {
  maxConcurrentBacktests: 3,
  maxHistoryDays: 365,
  defaultSignalTypes: ['momentum', 'mean_reversion'],
};

export class BacktestService extends EventEmitter {
  private config: BacktestServiceConfig;
  private runningBacktests: Map<string, { status: string; progress: number }> = new Map();
  private backtestHistory: StoredBacktest[] = [];

  constructor(config?: Partial<BacktestServiceConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Run a backtest with the given configuration
   */
  async runBacktest(request: BacktestRequest): Promise<StoredBacktest> {
    const backtestId = this.generateBacktestId();

    // Check concurrent limit
    if (this.runningBacktests.size >= this.config.maxConcurrentBacktests) {
      throw new Error('Maximum concurrent backtests reached');
    }

    // Create stored backtest record
    const storedBacktest: StoredBacktest = {
      id: backtestId,
      name: `Backtest ${new Date().toISOString()}`,
      config: this.createConfig(request),
      result: null as unknown as BacktestResult,
      createdAt: new Date(),
      status: 'pending',
    };

    this.runningBacktests.set(backtestId, { status: 'pending', progress: 0 });
    this.emit('backtest:started', backtestId);

    try {
      storedBacktest.status = 'running';
      this.runningBacktests.set(backtestId, { status: 'running', progress: 0 });

      // Fetch historical data
      this.updateProgress(backtestId, 10, 'Fetching historical data');
      const marketData = await this.fetchHistoricalData(
        new Date(request.startDate),
        new Date(request.endDate),
        request.marketIds
      );

      if (marketData.length === 0) {
        throw new Error('No historical data found for the specified period');
      }

      // Create signals
      this.updateProgress(backtestId, 30, 'Initializing signals');
      const signals = this.createSignals(
        request.signalTypes || this.config.defaultSignalTypes
      );

      // Create combiner with weights
      const weights = request.signalWeights || {
        momentum: 0.5,
        mean_reversion: 0.5,
        wallet_tracking: 0.3,
      };
      const combiner = new WeightedAverageCombiner(weights);

      // Create backtest engine
      this.updateProgress(backtestId, 40, 'Creating backtest engine');
      const engine = createBacktestEngine({
        config: storedBacktest.config,
        marketData,
        signals,
        combiner,
        riskConfig: storedBacktest.config.risk,
      });

      // Run backtest
      this.updateProgress(backtestId, 50, 'Running backtest');
      const result = await engine.run();

      // Calculate metrics
      this.updateProgress(backtestId, 80, 'Calculating metrics');

      const metrics = PerformanceCalculator.calculate(
        result.trades,
        result.equityCurve,
        storedBacktest.config.initialCapital
      );
      const predMetrics = PredictionMarketCalculator.calculate(result.trades);

      // Store result
      storedBacktest.result = {
        ...result,
        metrics,
        predictionMetrics: predMetrics,
      };
      storedBacktest.status = 'completed';

      this.updateProgress(backtestId, 100, 'Completed');
      this.backtestHistory.push(storedBacktest);
      this.runningBacktests.delete(backtestId);

      // Save to database if configured
      if (isDatabaseConfigured()) {
        await this.saveBacktestToDb(storedBacktest);
      }

      this.emit('backtest:completed', backtestId, storedBacktest);
      return storedBacktest;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      storedBacktest.status = 'failed';
      storedBacktest.error = errorMessage;
      this.runningBacktests.delete(backtestId);
      this.backtestHistory.push(storedBacktest);

      this.emit('backtest:failed', backtestId, errorMessage);
      throw error;
    }
  }

  /**
   * Get backtest status
   */
  getBacktestStatus(backtestId: string): { status: string; progress: number } | null {
    return this.runningBacktests.get(backtestId) || null;
  }

  /**
   * Get all backtests
   */
  getBacktestHistory(): StoredBacktest[] {
    return [...this.backtestHistory];
  }

  /**
   * Get a specific backtest by ID
   */
  getBacktest(backtestId: string): StoredBacktest | null {
    return this.backtestHistory.find(b => b.id === backtestId) || null;
  }

  /**
   * Load backtest history from database
   */
  async loadBacktestHistory(): Promise<void> {
    if (!isDatabaseConfigured()) return;

    try {
      const result = await query(
        `SELECT id, name, config, result, created_at, status, error
         FROM backtests
         ORDER BY created_at DESC
         LIMIT 100`
      );

      this.backtestHistory = result.rows.map(row => ({
        id: row.id,
        name: row.name,
        config: row.config,
        result: row.result,
        createdAt: row.created_at,
        status: row.status,
        error: row.error,
      }));

      console.log(`[BacktestService] Loaded ${this.backtestHistory.length} backtests from database`);
    } catch (error) {
      console.error('[BacktestService] Failed to load backtest history:', error);
    }
  }

  /**
   * Create backtest config from request
   */
  private createConfig(request: BacktestRequest): BacktestConfig {
    // Use AGGRESSIVE profile with user overrides only if provided
    const riskConfig = {
      ...AGGRESSIVE_PROFILE,
      ...(request.riskConfig?.maxPositionSizePct && { maxPositionSizePct: request.riskConfig.maxPositionSizePct }),
      ...(request.riskConfig?.maxExposurePct && { maxExposurePct: request.riskConfig.maxExposurePct }),
      ...(request.riskConfig?.maxDrawdownPct && { maxDrawdownPct: request.riskConfig.maxDrawdownPct }),
      ...(request.riskConfig?.stopLossPct && { stopLossPct: request.riskConfig.stopLossPct }),
      ...(request.riskConfig?.takeProfitPct && { takeProfitPct: request.riskConfig.takeProfitPct }),
    };

    return createBacktestConfig({
      startDate: new Date(request.startDate),
      endDate: new Date(request.endDate),
      initialCapital: request.initialCapital,
      feeRate: 0.002,
      granularityMinutes: 60,
      marketIds: request.marketIds,
      risk: riskConfig,
      signalFilters: request.signalFilters,
    });
  }

  /**
   * Fetch historical data from database
   */
  private async fetchHistoricalData(
    startDate: Date,
    endDate: Date,
    marketIds?: string[]
  ): Promise<MarketData[]> {
    if (!isDatabaseConfigured()) {
      // Return mock data for testing
      return this.generateMockData(startDate, endDate);
    }

    try {
      // Fetch price data from time-series table
      // The price_history table already has OHLC data, so no aggregation needed
      let priceQuery = `
        SELECT
          time,
          market_id,
          token_id,
          open,
          high,
          low,
          close,
          volume,
          COALESCE(trade_count, 1) as trade_count
        FROM price_history
        WHERE time >= $1 AND time <= $2
      `;

      const params: (Date | string[])[] = [startDate, endDate];

      if (marketIds && marketIds.length > 0) {
        priceQuery += ` AND market_id = ANY($3)`;
        params.push(marketIds);
      }

      // Limit to 10000 rows to prevent memory issues on free tier
      priceQuery += ` ORDER BY time DESC LIMIT 10000`;

      const priceResult = await query(priceQuery, params);

      console.log(`[BacktestService] Fetched ${priceResult.rows.length} price bars from database`);

      // Group by market
      const marketMap = new Map<string, MarketData>();

      for (const row of priceResult.rows) {
        const marketId = row.market_id;

        if (!marketMap.has(marketId)) {
          marketMap.set(marketId, {
            marketId,
            question: `Market ${marketId}`,
            resolved: false,
            bars: [],
            trades: [],
          });
        }

        const market = marketMap.get(marketId)!;
        market.bars.push({
          time: new Date(row.time),
          marketId,
          tokenId: row.token_id,
          open: parseFloat(row.open),
          high: parseFloat(row.high),
          low: parseFloat(row.low),
          close: parseFloat(row.close),
          volume: parseFloat(row.volume) || 0,
          tradeCount: parseInt(row.trade_count) || 1,
        });
      }

      console.log(`[BacktestService] Grouped into ${marketMap.size} markets`);
      return Array.from(marketMap.values());
    } catch (error) {
      console.error('[BacktestService] Failed to fetch historical data:', error);
      return this.generateMockData(startDate, endDate);
    }
  }

  /**
   * Generate mock data for testing when no database
   */
  private generateMockData(startDate: Date, endDate: Date): MarketData[] {
    const markets: MarketData[] = [];
    const marketCount = 5;
    const hoursPerDay = 24;
    const daysDiff = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
    const totalBars = daysDiff * hoursPerDay;

    for (let m = 0; m < marketCount; m++) {
      const marketId = `mock_market_${m}`;
      const bars: HistoricalBar[] = [];
      let price = 0.5 + Math.random() * 0.3; // Start between 0.5 and 0.8

      for (let i = 0; i < totalBars; i++) {
        const time = new Date(startDate.getTime() + i * 60 * 60 * 1000);
        const change = (Math.random() - 0.5) * 0.05;
        price = Math.max(0.01, Math.min(0.99, price + change));

        bars.push({
          time,
          marketId,
          tokenId: `${marketId}_yes`,
          open: price,
          high: price * (1 + Math.random() * 0.02),
          low: price * (1 - Math.random() * 0.02),
          close: price + (Math.random() - 0.5) * 0.02,
          volume: Math.random() * 10000,
        });
      }

      markets.push({
        marketId,
        question: `Mock Market ${m + 1}`,
        resolved: false,
        bars,
        trades: [],
      });
    }

    return markets;
  }

  /**
   * Create signal instances
   */
  private createSignals(signalTypes: string[]): ISignal[] {
    const signals: ISignal[] = [];

    for (const type of signalTypes) {
      switch (type.toLowerCase()) {
        case 'momentum':
          signals.push(new MomentumSignal());
          break;
        case 'mean_reversion':
          signals.push(new MeanReversionSignal());
          break;
        case 'wallet_tracking':
          signals.push(new WalletTrackingSignal());
          break;
        default:
          console.warn(`[BacktestService] Unknown signal type: ${type}`);
      }
    }

    if (signals.length === 0) {
      // Default to momentum
      signals.push(new MomentumSignal());
    }

    return signals;
  }

  /**
   * Save backtest to database
   */
  private async saveBacktestToDb(backtest: StoredBacktest): Promise<void> {
    try {
      await query(
        `INSERT INTO backtests (id, name, config, result, created_at, status, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          backtest.id,
          backtest.name,
          JSON.stringify(backtest.config),
          JSON.stringify(backtest.result),
          backtest.createdAt,
          backtest.status,
          backtest.error || null,
        ]
      );
    } catch (error) {
      console.error('[BacktestService] Failed to save backtest:', error);
    }
  }

  /**
   * Update progress
   */
  private updateProgress(backtestId: string, progress: number, message: string): void {
    this.runningBacktests.set(backtestId, { status: message, progress });
    this.emit('backtest:progress', backtestId, progress, message);
  }

  /**
   * Generate unique backtest ID
   */
  private generateBacktestId(): string {
    return `bt_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  /**
   * Get service status
   */
  getStatus(): {
    runningBacktests: number;
    historyCount: number;
    config: BacktestServiceConfig;
  } {
    return {
      runningBacktests: this.runningBacktests.size,
      historyCount: this.backtestHistory.length,
      config: { ...this.config },
    };
  }
}

// Singleton instance
let backtestService: BacktestService | null = null;

export function getBacktestService(): BacktestService {
  if (!backtestService) {
    backtestService = new BacktestService();
  }
  return backtestService;
}

export function initializeBacktestService(config?: Partial<BacktestServiceConfig>): BacktestService {
  backtestService = new BacktestService(config);
  return backtestService;
}
