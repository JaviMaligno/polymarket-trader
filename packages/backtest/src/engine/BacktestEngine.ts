import pino from 'pino';
import { EventBus } from './EventBus.js';
import type {
  BacktestConfig,
  BacktestResult,
  BacktestSummary,
  BacktestEvent,
  PriceUpdateEvent,
  TradeEvent,
  SignalEvent,
  MarketResolvedEvent,
  MarketData,
  HistoricalBar,
  TradeRecord,
  PortfolioSnapshot,
  PerformanceMetrics,
  PredictionMarketMetrics,
} from '../types/index.js';

import type { ISignal, ISignalCombiner, SignalContext, SignalOutput } from '@polymarket-trader/signals';

interface BacktestEngineOptions {
  config: BacktestConfig;
  marketData: MarketData[];
  signals: ISignal[];
  combiner: ISignalCombiner;
}

export interface IPortfolioManager {
  getState(): { cash: number; positions: Map<string, unknown>; totalValue: number };
  getSnapshot(): PortfolioSnapshot;
  getEquityCurve(): PortfolioSnapshot[];
  getTrades(): TradeRecord[];
  handlePriceUpdate(event: PriceUpdateEvent): void;
  handleOrderFilled(event: BacktestEvent): void;
  handleMarketResolved(event: MarketResolvedEvent): void;
  reset(initialCapital: number): void;
}

export interface IOrderBookSimulator {
  handlePriceUpdate(event: PriceUpdateEvent): void;
  handleTrade(event: TradeEvent): void;
  submitOrder(order: unknown): BacktestEvent | null;
  getBestBid(marketId: string, tokenId: string): number | null;
  getBestAsk(marketId: string, tokenId: string): number | null;
  reset(): void;
}

export interface IRiskManager {
  checkOrder(order: unknown, portfolioState: unknown): { allowed: boolean; reason?: string };
  checkPortfolio(portfolioState: unknown): { halt: boolean; reason?: string };
  getDailyPnL(): number;
  reset(): void;
}

/**
 * BacktestEngine - Main orchestrator for backtesting
 *
 * Coordinates:
 * - Historical data replay
 * - Signal generation
 * - Order execution simulation
 * - Portfolio tracking
 * - Performance calculation
 */
export class BacktestEngine {
  private config: BacktestConfig;
  private marketData: Map<string, MarketData> = new Map();
  private signals: ISignal[];
  private combiner: ISignalCombiner;
  private eventBus: EventBus;
  private logger: pino.Logger;

  // Components (to be injected or created)
  private portfolioManager: IPortfolioManager | null = null;
  private orderBookSimulator: IOrderBookSimulator | null = null;
  private riskManager: IRiskManager | null = null;

  // State
  private currentTime: Date;
  private isRunning = false;
  private isPaused = false;

  // Price cache for signal context
  private priceCache: Map<string, { bars: HistoricalBar[]; currentBar: HistoricalBar }> = new Map();

  constructor(options: BacktestEngineOptions) {
    this.config = options.config;
    this.signals = options.signals;
    this.combiner = options.combiner;
    this.currentTime = new Date(options.config.startDate);
    this.eventBus = new EventBus();
    this.logger = pino({ name: 'BacktestEngine' });

    // Index market data
    for (const market of options.marketData) {
      this.marketData.set(market.marketId, market);
    }

    this.setupEventHandlers();
  }

  /**
   * Inject portfolio manager
   */
  setPortfolioManager(manager: IPortfolioManager): void {
    this.portfolioManager = manager;
  }

  /**
   * Inject order book simulator
   */
  setOrderBookSimulator(simulator: IOrderBookSimulator): void {
    this.orderBookSimulator = simulator;
  }

  /**
   * Inject risk manager
   */
  setRiskManager(manager: IRiskManager): void {
    this.riskManager = manager;
  }

  /**
   * Setup event handlers
   */
  private setupEventHandlers(): void {
    this.eventBus.on<PriceUpdateEvent>('PRICE_UPDATE', (event) => {
      this.handlePriceUpdate(event);
    });

    this.eventBus.on<TradeEvent>('TRADE', (event) => {
      this.handleTrade(event);
    });

    this.eventBus.on<SignalEvent>('SIGNAL', (event) => {
      this.handleSignal(event);
    });

    this.eventBus.on<MarketResolvedEvent>('MARKET_RESOLVED', (event) => {
      this.handleMarketResolved(event);
    });
  }

  /**
   * Run the backtest
   */
  async run(): Promise<BacktestResult> {
    if (this.isRunning) {
      throw new Error('Backtest is already running');
    }

    this.isRunning = true;
    this.logger.info({ config: this.config }, 'Starting backtest');

    try {
      // Reset components
      this.reset();

      // Generate all historical events
      const events = this.generateHistoricalEvents();
      this.logger.info({ eventCount: events.length }, 'Generated historical events');

      // Queue all events
      this.eventBus.enqueueMany(events);

      // Process events in chronological order
      const granularityMs = this.config.granularityMinutes * 60 * 1000;
      let tickTime = new Date(this.config.startDate);

      while (tickTime <= this.config.endDate) {
        if (this.isPaused) {
          await this.waitForResume();
        }

        this.currentTime = tickTime;

        // Process events up to current tick
        await this.eventBus.processUntil(tickTime);

        // Generate signals for current state
        await this.generateSignals();

        // Check risk limits
        if (this.riskManager && this.portfolioManager) {
          const check = this.riskManager.checkPortfolio(this.portfolioManager.getState());
          if (check.halt) {
            this.logger.warn({ reason: check.reason }, 'Risk limit hit, halting backtest');
            break;
          }
        }

        // Advance time
        tickTime = new Date(tickTime.getTime() + granularityMs);
      }

      // Process any remaining events
      await this.eventBus.processQueue();

      // Calculate results
      const result = this.calculateResults();
      this.logger.info({ summary: result.summary }, 'Backtest completed');

      return result;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Pause the backtest
   */
  pause(): void {
    this.isPaused = true;
  }

  /**
   * Resume the backtest
   */
  resume(): void {
    this.isPaused = false;
  }

  /**
   * Wait for resume signal
   */
  private async waitForResume(): Promise<void> {
    while (this.isPaused) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  /**
   * Reset the engine state
   */
  private reset(): void {
    this.currentTime = new Date(this.config.startDate);
    this.priceCache.clear();
    this.eventBus.reset();

    if (this.portfolioManager) {
      this.portfolioManager.reset(this.config.initialCapital);
    }
    if (this.orderBookSimulator) {
      this.orderBookSimulator.reset();
    }
    if (this.riskManager) {
      this.riskManager.reset();
    }
  }

  /**
   * Generate historical events from market data
   */
  private generateHistoricalEvents(): BacktestEvent[] {
    const events: BacktestEvent[] = [];
    const marketIds = this.config.marketIds?.length
      ? this.config.marketIds
      : Array.from(this.marketData.keys());

    for (const marketId of marketIds) {
      const market = this.marketData.get(marketId);
      if (!market) continue;

      // Filter bars within backtest period
      const validBars = market.bars.filter(
        bar => bar.time >= this.config.startDate && bar.time <= this.config.endDate
      );

      // Generate price update events from bars
      for (const bar of validBars) {
        const priceEvent: PriceUpdateEvent = {
          type: 'PRICE_UPDATE',
          timestamp: bar.time,
          data: {
            marketId: bar.marketId,
            tokenId: bar.tokenId,
            price: bar.close,
            volume: bar.volume,
            bid: bar.low,
            ask: bar.high,
          },
        };
        events.push(priceEvent);
      }

      // Generate trade events
      const validTrades = market.trades.filter(
        trade => trade.time >= this.config.startDate && trade.time <= this.config.endDate
      );

      for (const trade of validTrades) {
        const tradeEvent: TradeEvent = {
          type: 'TRADE',
          timestamp: trade.time,
          data: {
            marketId: trade.marketId,
            tokenId: trade.tokenId,
            side: trade.side,
            price: trade.price,
            size: trade.size,
          },
        };
        events.push(tradeEvent);
      }

      // Generate market resolved event if applicable
      if (market.resolved && market.resolutionOutcome && market.endDate) {
        const resolvedEvent: MarketResolvedEvent = {
          type: 'MARKET_RESOLVED',
          timestamp: market.endDate,
          data: {
            marketId: market.marketId,
            outcome: market.resolutionOutcome,
            resolutionPrice: market.resolutionOutcome === 'YES' ? 1 : 0,
          },
        };
        events.push(resolvedEvent);
      }
    }

    return events;
  }

  /**
   * Handle price update event
   */
  private handlePriceUpdate(event: PriceUpdateEvent): void {
    const key = `${event.data.marketId}:${event.data.tokenId}`;

    // Update price cache
    let cache = this.priceCache.get(key);
    if (!cache) {
      cache = { bars: [], currentBar: this.priceToBar(event) };
      this.priceCache.set(key, cache);
    }

    cache.bars.push(cache.currentBar);
    cache.currentBar = this.priceToBar(event);

    // Keep only required lookback
    const maxLookback = Math.max(...this.signals.map(s => s.getRequiredLookback()));
    if (cache.bars.length > maxLookback + 10) {
      cache.bars = cache.bars.slice(-maxLookback - 10);
    }

    // Forward to components
    if (this.portfolioManager) {
      this.portfolioManager.handlePriceUpdate(event);
    }
    if (this.orderBookSimulator) {
      this.orderBookSimulator.handlePriceUpdate(event);
    }
  }

  /**
   * Convert price event to bar
   */
  private priceToBar(event: PriceUpdateEvent): HistoricalBar {
    return {
      time: event.timestamp,
      marketId: event.data.marketId,
      tokenId: event.data.tokenId,
      open: event.data.price,
      high: event.data.ask || event.data.price,
      low: event.data.bid || event.data.price,
      close: event.data.price,
      volume: event.data.volume || 0,
    };
  }

  /**
   * Handle trade event
   */
  private handleTrade(event: TradeEvent): void {
    if (this.orderBookSimulator) {
      this.orderBookSimulator.handleTrade(event);
    }
  }

  /**
   * Handle signal event
   */
  private handleSignal(event: SignalEvent): void {
    // Process signal and generate orders
    this.logger.debug({ signal: event.data }, 'Signal received');

    if (!this.portfolioManager || !this.orderBookSimulator) {
      return;
    }

    const { marketId, direction, strength, confidence } = event.data;
    const portfolioState = this.portfolioManager.getState();

    // Calculate position size based on signal strength and Kelly criterion
    const maxPositionPct = this.config.risk.maxPositionSizePct / 100;
    const kellyFraction = Math.min(0.5, confidence * Math.abs(strength));
    const positionSizePct = maxPositionPct * kellyFraction;
    const positionValue = portfolioState.cash * positionSizePct;

    // Skip if position too small
    if (positionValue < 10) {
      return;
    }

    // Get current price from cache
    const market = this.marketData.get(marketId);
    if (!market) return;

    const tokenId = market.bars[0]?.tokenId;
    if (!tokenId) return;

    const cacheKey = `${marketId}:${tokenId}`;
    const cache = this.priceCache.get(cacheKey);
    if (!cache) return;

    const currentPrice = cache.currentBar.close;
    if (currentPrice <= 0 || currentPrice >= 1) return;

    // Create proper Order object with all required fields
    const orderId = `order_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const order = {
      id: orderId,
      marketId,
      tokenId,
      side: (direction === 'LONG' ? 'BUY' : 'SELL') as 'BUY' | 'SELL',
      type: 'MARKET' as const,
      size: positionValue / currentPrice,
      price: currentPrice,
      status: 'PENDING' as const,
      filledSize: 0,
      avgFillPrice: 0,
      createdAt: this.currentTime,
      updatedAt: this.currentTime,
      fills: [],
    };

    // Check with risk manager
    if (this.riskManager) {
      const riskCheck = this.riskManager.checkOrder(order, portfolioState);
      if (!riskCheck.allowed) {
        this.logger.debug({ reason: riskCheck.reason }, 'Order rejected by risk manager');
        return;
      }
    }

    // Submit order
    const fillEvent = this.orderBookSimulator.submitOrder(order);
    if (fillEvent && fillEvent.type === 'ORDER_FILLED') {
      this.portfolioManager.handleOrderFilled(fillEvent);
      this.logger.info({
        marketId,
        direction,
        size: order.size,
        price: currentPrice,
        strength,
        confidence
      }, 'Order filled');
    }
  }

  /**
   * Handle market resolved event
   */
  private handleMarketResolved(event: MarketResolvedEvent): void {
    if (this.portfolioManager) {
      this.portfolioManager.handleMarketResolved(event);
    }
  }

  /**
   * Generate signals for current market state
   */
  private async generateSignals(): Promise<void> {
    const signalOutputs: SignalOutput[] = [];
    let marketsProcessed = 0;
    let signalsGenerated = 0;

    for (const [key, cache] of this.priceCache) {
      const [marketId, tokenId] = key.split(':');
      const market = this.marketData.get(marketId);
      if (!market) continue;
      marketsProcessed++;

      // Build signal context
      const context: SignalContext = {
        market: {
          id: marketId,
          question: market.question,
          category: market.category,
          endDate: market.endDate,
          currentPriceYes: cache.currentBar.close,
          isActive: !market.resolved,
          isResolved: market.resolved,
          tokenIdYes: tokenId,
        },
        currentTime: this.currentTime,
        priceBars: [...cache.bars, cache.currentBar],
        recentTrades: [],
      };

      // Compute each signal
      for (const signal of this.signals) {
        try {
          const output = await signal.compute(context);
          if (output) {
            signalOutputs.push(output);
            signalsGenerated++;
          }
        } catch (error) {
          this.logger.error({ error, signalId: signal.signalId }, 'Error computing signal');
        }
      }
    }

    // Log progress periodically (every 100 ticks)
    if (marketsProcessed > 0 && this.currentTime.getMinutes() === 0 && this.currentTime.getHours() % 6 === 0) {
      this.logger.info({ marketsProcessed, signalsGenerated, priceCache: this.priceCache.size }, 'Signal generation progress');
    }

    // Combine signals if we have any
    if (signalOutputs.length > 0) {
      const combined = this.combiner.combine(signalOutputs);

      // Log combined signal for debugging
      if (combined && (Math.abs(combined.strength) > 0.05 || combined.confidence > 0.1)) {
        this.logger.debug({
          strength: combined.strength,
          confidence: combined.confidence,
          marketId: combined.marketId
        }, 'Combined signal');
      }

      if (combined && Math.abs(combined.strength) > 0.1 && combined.confidence > 0.15) {
        // Emit signal event
        const signalEvent: SignalEvent = {
          type: 'SIGNAL',
          timestamp: this.currentTime,
          data: {
            signalId: 'combined',
            marketId: combined.marketId,
            direction: combined.direction,
            strength: combined.strength,
            confidence: combined.confidence,
          },
        };
        this.eventBus.emit(signalEvent);
      }
    }
  }

  /**
   * Calculate backtest results
   */
  private calculateResults(): BacktestResult {
    const trades = this.portfolioManager?.getTrades() || [];
    const equityCurve = this.portfolioManager?.getEquityCurve() || [];
    const finalState = this.portfolioManager?.getState();

    // Calculate summary
    const summary = this.calculateSummary(trades, finalState);

    // Calculate performance metrics
    const metrics = this.calculatePerformanceMetrics(trades, equityCurve);

    // Calculate prediction market specific metrics
    const predictionMetrics = this.calculatePredictionMetrics(trades);

    return {
      config: this.config,
      summary,
      trades,
      equityCurve,
      metrics,
      predictionMetrics,
    };
  }

  /**
   * Calculate summary statistics
   */
  private calculateSummary(
    trades: TradeRecord[],
    finalState: { cash: number; totalValue: number } | undefined
  ): BacktestSummary {
    const winningTrades = trades.filter(t => t.pnl > 0);
    const losingTrades = trades.filter(t => t.pnl < 0);

    const totalDays = Math.ceil(
      (this.config.endDate.getTime() - this.config.startDate.getTime()) / (1000 * 60 * 60 * 24)
    );

    const finalCapital = finalState?.totalValue || this.config.initialCapital;
    const totalReturn = (finalCapital - this.config.initialCapital) / this.config.initialCapital;
    const annualizedReturn = Math.pow(1 + totalReturn, 365 / totalDays) - 1;

    const totalFees = trades.reduce((sum, t) => sum + t.fees, 0);

    return {
      startDate: this.config.startDate,
      endDate: this.config.endDate,
      totalDays,
      initialCapital: this.config.initialCapital,
      finalCapital,
      totalReturn,
      annualizedReturn,
      totalTrades: trades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: trades.length > 0 ? winningTrades.length / trades.length : 0,
      avgWin: winningTrades.length > 0
        ? winningTrades.reduce((sum, t) => sum + t.pnl, 0) / winningTrades.length
        : 0,
      avgLoss: losingTrades.length > 0
        ? Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0) / losingTrades.length)
        : 0,
      largestWin: winningTrades.length > 0
        ? Math.max(...winningTrades.map(t => t.pnl))
        : 0,
      largestLoss: losingTrades.length > 0
        ? Math.abs(Math.min(...losingTrades.map(t => t.pnl)))
        : 0,
      totalFees,
    };
  }

  /**
   * Calculate performance metrics
   */
  private calculatePerformanceMetrics(
    trades: TradeRecord[],
    equityCurve: PortfolioSnapshot[]
  ): PerformanceMetrics {
    // Extract returns series
    const returns: number[] = [];
    for (let i = 1; i < equityCurve.length; i++) {
      const prevValue = equityCurve[i - 1].totalValue;
      const currValue = equityCurve[i].totalValue;
      if (prevValue > 0) {
        returns.push((currValue - prevValue) / prevValue);
      }
    }

    // Calculate metrics
    const totalReturn = equityCurve.length > 0
      ? (equityCurve[equityCurve.length - 1].totalValue - equityCurve[0].totalValue) / equityCurve[0].totalValue
      : 0;

    const totalDays = equityCurve.length > 0
      ? (equityCurve[equityCurve.length - 1].timestamp.getTime() - equityCurve[0].timestamp.getTime()) / (1000 * 60 * 60 * 24)
      : 1;

    const annualizedReturn = Math.pow(1 + totalReturn, 365 / Math.max(1, totalDays)) - 1;

    // Sharpe ratio (assuming 0 risk-free rate)
    const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const stdDev = returns.length > 0
      ? Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length)
      : 0;
    const sharpeRatio = stdDev > 0 ? (avgReturn * Math.sqrt(252)) / (stdDev * Math.sqrt(252)) : 0;

    // Sortino ratio (downside deviation only)
    const negativeReturns = returns.filter(r => r < 0);
    const downsideDev = negativeReturns.length > 0
      ? Math.sqrt(negativeReturns.reduce((sum, r) => sum + r * r, 0) / negativeReturns.length)
      : 0;
    const sortinoRatio = downsideDev > 0 ? (avgReturn * Math.sqrt(252)) / (downsideDev * Math.sqrt(252)) : 0;

    // Max drawdown
    let maxDrawdown = 0;
    let maxDrawdownDuration = 0;
    let peak = equityCurve[0]?.totalValue || this.config.initialCapital;
    let drawdownStart = 0;

    for (let i = 0; i < equityCurve.length; i++) {
      const value = equityCurve[i].totalValue;
      if (value > peak) {
        peak = value;
        drawdownStart = i;
      }
      const drawdown = (peak - value) / peak;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
        maxDrawdownDuration = i - drawdownStart;
      }
    }

    // Win rate and profit factor
    const winningTrades = trades.filter(t => t.pnl > 0);
    const losingTrades = trades.filter(t => t.pnl < 0);
    const winRate = trades.length > 0 ? winningTrades.length / trades.length : 0;

    const grossProfit = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
    const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    // Average trade stats
    const avgTradeReturn = trades.length > 0
      ? trades.reduce((sum, t) => sum + t.pnlPct, 0) / trades.length
      : 0;
    const avgWin = winningTrades.length > 0
      ? winningTrades.reduce((sum, t) => sum + t.pnlPct, 0) / winningTrades.length
      : 0;
    const avgLoss = losingTrades.length > 0
      ? Math.abs(losingTrades.reduce((sum, t) => sum + t.pnlPct, 0) / losingTrades.length)
      : 0;

    // Expectancy
    const expectancy = winRate * avgWin - (1 - winRate) * avgLoss;

    // Average holding period
    const avgHoldingPeriod = trades.length > 0
      ? trades.reduce((sum, t) => sum + t.holdingPeriodMs, 0) / trades.length / (1000 * 60 * 60)
      : 0;

    // Kelly fraction
    const kellyFraction = avgLoss > 0 ? winRate - (1 - winRate) / (avgWin / avgLoss) : 0;

    // Calmar ratio
    const calmarRatio = maxDrawdown > 0 ? annualizedReturn / maxDrawdown : 0;

    return {
      totalReturn,
      annualizedReturn,
      sharpeRatio,
      sortinoRatio,
      maxDrawdown,
      maxDrawdownDuration,
      calmarRatio,
      winRate,
      profitFactor,
      avgTradeReturn,
      avgWin,
      avgLoss,
      expectancy,
      totalTrades: trades.length,
      avgHoldingPeriod,
      kellyFraction: Math.max(0, Math.min(1, kellyFraction)),
    };
  }

  /**
   * Calculate prediction market specific metrics
   */
  private calculatePredictionMetrics(trades: TradeRecord[]): PredictionMarketMetrics {
    const resolvedTrades = trades.filter(t => t.marketResolved);
    const resolutionRate = trades.length > 0 ? resolvedTrades.length / trades.length : 0;

    // Calculate Brier score and accuracy
    let brierSum = 0;
    let logLossSum = 0;
    let correctPredictions = 0;

    const calibrationBuckets: { predicted: number; actual: number; count: number }[] = [];
    for (let i = 0; i < 10; i++) {
      calibrationBuckets.push({ predicted: (i + 0.5) / 10, actual: 0, count: 0 });
    }

    const confidenceWhenCorrect: number[] = [];
    const confidenceWhenWrong: number[] = [];

    for (const trade of resolvedTrades) {
      // For prediction markets, entry price represents confidence
      const predictedProb = trade.side === 'LONG' ? trade.entryPrice : 1 - trade.entryPrice;
      const actualOutcome = trade.resolutionOutcome === 'YES' ? 1 : 0;

      // Brier score component
      brierSum += Math.pow(predictedProb - actualOutcome, 2);

      // Log loss component
      const epsilon = 1e-15;
      const clampedProb = Math.max(epsilon, Math.min(1 - epsilon, predictedProb));
      logLossSum += -(actualOutcome * Math.log(clampedProb) + (1 - actualOutcome) * Math.log(1 - clampedProb));

      // Accuracy
      const wasCorrect = (trade.side === 'LONG' && actualOutcome === 1) ||
                         (trade.side === 'SHORT' && actualOutcome === 0);
      if (wasCorrect) {
        correctPredictions++;
        confidenceWhenCorrect.push(predictedProb);
      } else {
        confidenceWhenWrong.push(predictedProb);
      }

      // Calibration buckets
      const bucketIdx = Math.min(9, Math.floor(predictedProb * 10));
      calibrationBuckets[bucketIdx].actual += actualOutcome;
      calibrationBuckets[bucketIdx].count++;
    }

    // Finalize calibration buckets
    const calibrationCurve = calibrationBuckets
      .filter(b => b.count > 0)
      .map(b => ({
        predicted: b.predicted,
        actual: b.actual / b.count,
        count: b.count,
      }));

    // Calculate calibration error
    let calibrationError = 0;
    for (const bucket of calibrationCurve) {
      calibrationError += bucket.count * Math.abs(bucket.predicted - bucket.actual);
    }
    calibrationError = resolvedTrades.length > 0 ? calibrationError / resolvedTrades.length : 0;

    return {
      brierScore: resolvedTrades.length > 0 ? brierSum / resolvedTrades.length : 0,
      logLoss: resolvedTrades.length > 0 ? logLossSum / resolvedTrades.length : 0,
      calibrationError,
      resolutionRate,
      resolutionAccuracy: resolvedTrades.length > 0 ? correctPredictions / resolvedTrades.length : 0,
      avgConfidenceWhenCorrect: confidenceWhenCorrect.length > 0
        ? confidenceWhenCorrect.reduce((a, b) => a + b, 0) / confidenceWhenCorrect.length
        : 0,
      avgConfidenceWhenWrong: confidenceWhenWrong.length > 0
        ? confidenceWhenWrong.reduce((a, b) => a + b, 0) / confidenceWhenWrong.length
        : 0,
      calibrationCurve,
    };
  }

  /**
   * Get current simulation time
   */
  getCurrentTime(): Date {
    return this.currentTime;
  }

  /**
   * Get event bus (for testing/debugging)
   */
  getEventBus(): EventBus {
    return this.eventBus;
  }
}
