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
  OrderFlowImbalanceSignal,
  HawkesSignal,
  VolumeAnomalyGenerator,
  MultiLevelOFISignal,
  SpreadCompressionGenerator,
  type ISignal,
  type OrderBookSnapshot,
} from '@polymarket-trader/signals';
import { isDatabaseConfigured, query, transaction, type PoolClient } from '../database/index.js';

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
    maxPositions?: number;
  };
  signalFilters?: {
    minStrength?: number;
    minConfidence?: number;
  };
  /** Signal construction config for Optuna optimization */
  momentumConfig?: {
    rsiPeriod?: number;
    rsiOverbought?: number;
    rsiOversold?: number;
    macdFast?: number;
    macdSlow?: number;
    macdSignal?: number;
  };
  meanReversionConfig?: {
    bbPeriod?: number;
    bbStdDev?: number;
    zScoreThreshold?: number;
  };
  /** Combiner config for Optuna optimization */
  combinerConfig?: {
    momentumWeight?: number;
    meanReversionWeight?: number;
    ofiWeight?: number;
    hawkesWeight?: number;
    volumeAnomalyWeight?: number;
    mlofiWeight?: number;
    spreadCompressionWeight?: number;
    minCombinedConfidence?: number;
    minCombinedStrength?: number;
    onlyDirection?: string | null;
    conflictResolution?: string;
    /** Consensus discount floor ∈ [0, 1]. Optional — combiner default (0.5)
     *  applies when omitted. Optuna tunes this value via weekly retraining. */
    consensusDiscountFloor?: number;
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
  async runBacktest(request: BacktestRequest, preloadedData?: MarketData[]): Promise<StoredBacktest> {
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

      // Use preloaded data if available, otherwise fetch from DB
      this.updateProgress(backtestId, 10, preloadedData ? 'Using cached data' : 'Fetching historical data');
      const marketData = preloadedData ?? await this.fetchHistoricalData(
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
        request.signalTypes || this.config.defaultSignalTypes,
        request.momentumConfig,
        request.meanReversionConfig,
      );

      // Create combiner with weights
      const cc = request.combinerConfig;
      const weights = request.signalWeights || {
        momentum: cc?.momentumWeight ?? 0.5,
        mean_reversion: cc?.meanReversionWeight ?? 0.5,
        ofi: cc?.ofiWeight ?? 0,
        hawkes: cc?.hawkesWeight ?? 0,
        volume_anomaly: cc?.volumeAnomalyWeight ?? 0,
        mlofi: cc?.mlofiWeight ?? 0,
        spread_compression: cc?.spreadCompressionWeight ?? 0,
        wallet_tracking: 0.3,
      };
      const combiner = new WeightedAverageCombiner(weights, cc ? {
        minCombinedConfidence: cc.minCombinedConfidence,
        minCombinedStrength: cc.minCombinedStrength,
        conflictResolution: cc.conflictResolution as any,
        ...(cc.consensusDiscountFloor !== undefined
          ? { consensusDiscountFloor: cc.consensusDiscountFloor }
          : {}),
      } : undefined);

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
        marketsEvaluated: marketData.length,
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
      ...(request.riskConfig?.maxPositions && { maxPositions: request.riskConfig.maxPositions }),
    };

    // Map combinerConfig.onlyDirection to BacktestConfig.onlyDirection
    const onlyDirection = request.combinerConfig?.onlyDirection as ('LONG' | 'SHORT' | undefined) ?? undefined;

    return createBacktestConfig({
      startDate: new Date(request.startDate),
      endDate: new Date(request.endDate),
      initialCapital: request.initialCapital,
      feeRate: 0.002,
      granularityMinutes: 60,
      marketIds: request.marketIds,
      risk: riskConfig,
      signalFilters: request.signalFilters,
      onlyDirection: onlyDirection || undefined,
    });
  }

  /**
   * Fetch historical data from database
   */
  async fetchHistoricalData(
    startDate: Date,
    endDate: Date,
    marketIds?: string[],
    marketType?: string,
  ): Promise<MarketData[]> {
    if (!isDatabaseConfigured()) {
      // Return mock data for testing
      return this.generateMockData(startDate, endDate);
    }

    try {
      // First, find markets with enough data for signal generation (min 35 bars)
      // This prevents the old LIMIT 10000 problem where rows spread across
      // thousands of markets left each with <2 bars (signals need 31+)
      const marketTypeFilter = marketType ? 'AND m.market_type = $TYPE_PARAM' : '';

      let topMarketsQuery: string;
      let topMarketsParams: (Date | string[] | string)[];

      if (marketIds && marketIds.length > 0) {
        topMarketsQuery = `
          SELECT ph.market_id FROM price_history ph
          JOIN markets m ON ph.market_id = m.id
          WHERE ph.time >= $1 AND ph.time <= $2
            AND ph.market_id = ANY($3)
            AND ph.token_id = m.clob_token_id_yes
            ${marketTypeFilter}
          GROUP BY ph.market_id HAVING COUNT(*) >= 35
          ORDER BY COUNT(*) DESC LIMIT 20
        `.replace('$TYPE_PARAM', marketType ? '$4' : '');
        topMarketsParams = marketType
          ? [startDate, endDate, marketIds, marketType]
          : [startDate, endDate, marketIds];
      } else {
        topMarketsQuery = `
          SELECT ph.market_id FROM price_history ph
          JOIN markets m ON ph.market_id = m.id
          WHERE ph.time >= $1 AND ph.time <= $2
            AND ph.token_id = m.clob_token_id_yes
            ${marketTypeFilter}
          GROUP BY ph.market_id HAVING COUNT(*) >= 35
          ORDER BY COUNT(*) DESC LIMIT 20
        `.replace('$TYPE_PARAM', marketType ? '$3' : '');
        topMarketsParams = marketType
          ? [startDate, endDate, marketType]
          : [startDate, endDate];
      }

      // TimescaleDB vectorized aggregation cannot handle VARCHAR columns (market_id)
      // in GROUP BY on compressed hypertable chunks — yields
      // "a variable with non-vectorizable type character varying is marked as vectorized".
      // Disable for this transaction only to avoid crashing the optimizer.
      const topMarketsResult = await transaction(async (client: PoolClient) => {
        await client.query('SET LOCAL timescaledb.enable_vectorized_aggregation = off');
        return client.query<{ market_id: string }>(topMarketsQuery, topMarketsParams);
      });
      const selectedMarkets = topMarketsResult.rows.map(r => r.market_id);

      if (selectedMarkets.length === 0) {
        console.log('[BacktestService] No markets with sufficient data (35+ bars) in date range');
        return [];
      }

      console.log(`[BacktestService] Selected ${selectedMarkets.length} markets with sufficient data`);

      // Fetch all bars for selected markets (Yes token only to avoid mixing Yes/No prices)
      const priceQuery = `
        SELECT
          ph.time,
          ph.market_id,
          ph.token_id,
          ph.open,
          ph.high,
          ph.low,
          ph.close,
          ph.volume,
          COALESCE(ph.trade_count, 1) as trade_count
        FROM price_history ph
        JOIN markets m ON ph.market_id = m.id
        WHERE ph.time >= $1 AND ph.time <= $2
          AND ph.market_id = ANY($3)
          AND ph.token_id = m.clob_token_id_yes
        ORDER BY ph.time ASC
      `;

      const priceResult = await query(priceQuery, [startDate, endDate, selectedMarkets]);

      console.log(`[BacktestService] Fetched ${priceResult.rows.length} price bars from database`);

      // Fetch orderbook snapshots at 5-min cadence (DISTINCT ON bucket keeps latest per bucket)
      const orderBookResult = await transaction(async (client: PoolClient) => {
        await client.query('SET LOCAL timescaledb.enable_vectorized_aggregation = off');
        return client.query<{
          time: Date;
          market_id: string;
          token_id: string;
          best_bid: string;
          best_ask: string;
          spread: string;
          mid_price: string;
          bid_depth_10pct: string | null;
          ask_depth_10pct: string | null;
        }>(
          `SELECT DISTINCT ON (market_id, bucket)
             ob.time, ob.market_id, ob.token_id,
             ob.best_bid, ob.best_ask, ob.spread, ob.mid_price,
             ob.bid_depth_10pct, ob.ask_depth_10pct,
             date_trunc('hour', ob.time)
               + (EXTRACT(MINUTE FROM ob.time)::int / 5) * INTERVAL '5 minutes' AS bucket
           FROM orderbook_snapshots ob
           JOIN markets m ON ob.market_id = m.id
           WHERE ob.time >= $1 AND ob.time <= $2
             AND ob.market_id = ANY($3)
             AND ob.token_id = m.clob_token_id_yes
           ORDER BY market_id, bucket, time DESC`,
          [startDate, endDate, selectedMarkets],
        );
      });

      console.log(`[BacktestService] Fetched ${orderBookResult.rows.length} orderbook snapshots`);

      // Group orderbook snapshots by market_id
      const orderBookByMarket = new Map<string, OrderBookSnapshot[]>();
      for (const row of orderBookResult.rows) {
        const list = orderBookByMarket.get(row.market_id) || [];
        list.push({
          time: row.time,
          marketId: row.market_id,
          tokenId: row.token_id,
          bestBid: parseFloat(row.best_bid),
          bestAsk: parseFloat(row.best_ask),
          spread: parseFloat(row.spread),
          midPrice: parseFloat(row.mid_price),
          bidDepth10Pct: row.bid_depth_10pct ? parseFloat(row.bid_depth_10pct) : undefined,
          askDepth10Pct: row.ask_depth_10pct ? parseFloat(row.ask_depth_10pct) : undefined,
        });
        orderBookByMarket.set(row.market_id, list);
      }

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
            orderBook: orderBookByMarket.get(marketId) || [],
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
  private createSignals(
    signalTypes: string[],
    momentumConfig?: BacktestRequest['momentumConfig'],
    meanReversionConfig?: BacktestRequest['meanReversionConfig'],
  ): ISignal[] {
    const signals: ISignal[] = [];

    for (const type of signalTypes) {
      switch (type.toLowerCase()) {
        case 'momentum':
          signals.push(new MomentumSignal(momentumConfig ? {
            rsiPeriod: momentumConfig.rsiPeriod,
            rsiOverbought: momentumConfig.rsiOverbought,
            rsiOversold: momentumConfig.rsiOversold,
            macdFast: momentumConfig.macdFast,
            macdSlow: momentumConfig.macdSlow,
            macdSignal: momentumConfig.macdSignal,
          } : undefined));
          break;
        case 'mean_reversion':
          signals.push(new MeanReversionSignal(meanReversionConfig ? {
            bbPeriod: meanReversionConfig.bbPeriod,
            bbStdDev: meanReversionConfig.bbStdDev,
            zScoreThreshold: meanReversionConfig.zScoreThreshold,
          } : undefined));
          break;
        case 'wallet_tracking':
          signals.push(new WalletTrackingSignal());
          break;
        case 'ofi':
          signals.push(new OrderFlowImbalanceSignal());
          break;
        case 'hawkes':
          signals.push(new HawkesSignal());
          break;
        case 'volume_anomaly':
          signals.push(new VolumeAnomalyGenerator());
          break;
        case 'mlofi':
          signals.push(new MultiLevelOFISignal());
          break;
        case 'spread_compression':
          signals.push(new SpreadCompressionGenerator());
          break;
        default:
          console.warn(`[BacktestService] Unknown signal type: ${type}`);
      }
    }

    if (signals.length === 0) {
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
