/**
 * Strategy Orchestrator
 *
 * Coordinates signals, risk management, and trade execution.
 * Manages multiple strategies and their lifecycle.
 */

import pino from 'pino';
import { EventEmitter } from 'eventemitter3';
import type {
  StrategyConfig,
  StrategyState,
  StrategyRiskLimits,
  ExecutionParams,
  Position,
  Order,
  OrderRequest,
  LivePrice,
  LiveMarket,
} from '../types/index.js';
import type { LiveDataFeed } from '../feeds/LiveDataFeed.js';
import type { PaperTradingEngine } from '../engine/PaperTradingEngine.js';
import type { ISignal, ISignalCombiner, SignalContext, SignalOutput, CombinedSignalOutput, MarketInfo, PriceBar } from '@polymarket-trader/signals';

const logger = pino({ name: 'StrategyOrchestrator' });

// ============================================
// Types
// ============================================

export interface OrchestratorConfig {
  /** How often to evaluate signals (ms) */
  evaluationIntervalMs: number;
  /** Maximum concurrent strategy evaluations */
  maxConcurrentEvaluations: number;
  /** Enable position sizing */
  enablePositionSizing: boolean;
  /** Kelly criterion fraction (0-1) */
  kellyFraction: number;
  /** Minimum time between trades for same market (ms) */
  marketCooldownMs: number;
}

export interface OrchestratorEvents {
  'strategy:started': (strategyId: string) => void;
  'strategy:stopped': (strategyId: string) => void;
  'signal:generated': (strategyId: string, signal: CombinedSignalOutput, marketId: string) => void;
  'trade:executed': (strategyId: string, order: Order) => void;
  'trade:skipped': (strategyId: string, reason: string) => void;
  'risk:triggered': (strategyId: string, limitType: string, value: number) => void;
  'error': (strategyId: string, error: Error) => void;
}

interface StrategyRuntime {
  config: StrategyConfig;
  state: StrategyState;
  signals: ISignal[];
  combiner: ISignalCombiner;
  lastTradeByMarket: Map<string, Date>;
  dailyPnlStart: number;
  dailyPnlDate: string;
}

// ============================================
// Default Configuration
// ============================================

const DEFAULT_CONFIG: OrchestratorConfig = {
  evaluationIntervalMs: 5000,
  maxConcurrentEvaluations: 5,
  enablePositionSizing: true,
  kellyFraction: 0.25,
  marketCooldownMs: 60000,
};

// ============================================
// Strategy Orchestrator
// ============================================

export class StrategyOrchestrator extends EventEmitter<OrchestratorEvents> {
  private config: OrchestratorConfig;
  private feed: LiveDataFeed;
  private engine: PaperTradingEngine;

  private strategies: Map<string, StrategyRuntime> = new Map();
  private evaluationInterval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private evaluating: boolean = false;

  /** Price history buffer for each market (max 100 bars) */
  private priceHistory: Map<string, PriceBar[]> = new Map();
  private readonly MAX_HISTORY_BARS = 100;

  constructor(
    feed: LiveDataFeed,
    engine: PaperTradingEngine,
    config?: Partial<OrchestratorConfig>
  ) {
    super();
    this.feed = feed;
    this.engine = engine;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ============================================
  // Lifecycle Management
  // ============================================

  /**
   * Start the orchestrator
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Orchestrator already running');
      return;
    }

    logger.info('Starting strategy orchestrator');

    this.isRunning = true;

    // Start evaluation loop
    this.evaluationInterval = setInterval(() => {
      this.evaluateStrategies();
    }, this.config.evaluationIntervalMs);

    // Initial evaluation
    this.evaluateStrategies();
  }

  /**
   * Stop the orchestrator
   */
  stop(): void {
    if (!this.isRunning) return;

    logger.info('Stopping strategy orchestrator');

    this.isRunning = false;

    if (this.evaluationInterval) {
      clearInterval(this.evaluationInterval);
      this.evaluationInterval = null;
    }

    // Stop all strategies
    for (const strategyId of this.strategies.keys()) {
      this.stopStrategy(strategyId);
    }
  }

  // ============================================
  // Strategy Management
  // ============================================

  /**
   * Register a strategy
   */
  registerStrategy(
    config: StrategyConfig,
    signals: ISignal[],
    combiner: ISignalCombiner
  ): void {
    if (this.strategies.has(config.id)) {
      logger.warn({ strategyId: config.id }, 'Strategy already registered');
      return;
    }

    const runtime: StrategyRuntime = {
      config,
      state: {
        config,
        isRunning: false,
        lastSignalTime: null,
        lastTradeTime: null,
        todayPnl: 0,
        todayTrades: 0,
        positions: [],
        openOrders: [],
      },
      signals,
      combiner,
      lastTradeByMarket: new Map(),
      dailyPnlStart: this.engine.getEquity(),
      dailyPnlDate: this.getTodayDateString(),
    };

    this.strategies.set(config.id, runtime);
    logger.info({ strategyId: config.id, signals: config.signals }, 'Strategy registered');
  }

  /**
   * Unregister a strategy
   */
  unregisterStrategy(strategyId: string): void {
    const runtime = this.strategies.get(strategyId);
    if (!runtime) return;

    if (runtime.state.isRunning) {
      this.stopStrategy(strategyId);
    }

    this.strategies.delete(strategyId);
    logger.info({ strategyId }, 'Strategy unregistered');
  }

  /**
   * Start a strategy
   */
  startStrategy(strategyId: string): void {
    const runtime = this.strategies.get(strategyId);
    if (!runtime) {
      logger.warn({ strategyId }, 'Strategy not found');
      return;
    }

    if (runtime.state.isRunning) {
      logger.warn({ strategyId }, 'Strategy already running');
      return;
    }

    runtime.state.isRunning = true;
    runtime.config.enabled = true;

    this.emit('strategy:started', strategyId);
    logger.info({ strategyId }, 'Strategy started');
  }

  /**
   * Stop a strategy
   */
  stopStrategy(strategyId: string): void {
    const runtime = this.strategies.get(strategyId);
    if (!runtime) return;

    runtime.state.isRunning = false;
    runtime.config.enabled = false;

    this.emit('strategy:stopped', strategyId);
    logger.info({ strategyId }, 'Strategy stopped');
  }

  /**
   * Get strategy state
   */
  getStrategyState(strategyId: string): StrategyState | undefined {
    const runtime = this.strategies.get(strategyId);
    if (!runtime) return undefined;

    // Update positions and orders
    runtime.state.positions = this.getStrategyPositions(strategyId);
    runtime.state.openOrders = this.engine.getOpenOrders(strategyId);

    // Update daily P&L
    this.updateDailyPnl(runtime);

    return { ...runtime.state };
  }

  /**
   * Get all strategy states
   */
  getAllStrategyStates(): Map<string, StrategyState> {
    const states = new Map<string, StrategyState>();
    for (const strategyId of this.strategies.keys()) {
      const state = this.getStrategyState(strategyId);
      if (state) {
        states.set(strategyId, state);
      }
    }
    return states;
  }

  // ============================================
  // Signal Evaluation
  // ============================================

  /**
   * Evaluate all active strategies
   */
  private async evaluateStrategies(): Promise<void> {
    if (this.evaluating) return;
    this.evaluating = true;

    try {
      const activeStrategies = Array.from(this.strategies.entries())
        .filter(([_, runtime]) => runtime.config.enabled && runtime.state.isRunning);

      // Get all subscribed markets
      const markets = this.feed.getAllMarkets().filter(m => m.isActive);

      // Evaluate each strategy
      for (const [strategyId, runtime] of activeStrategies) {
        try {
          await this.evaluateStrategy(runtime, markets);
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          this.emit('error', strategyId, err);
          logger.error({ strategyId, error: err.message }, 'Strategy evaluation failed');
        }
      }
    } finally {
      this.evaluating = false;
    }
  }

  /**
   * Evaluate a single strategy
   */
  private async evaluateStrategy(
    runtime: StrategyRuntime,
    markets: LiveMarket[]
  ): Promise<void> {
    const { config, signals, combiner } = runtime;

    // Filter markets for this strategy
    const filteredMarkets = this.filterMarkets(markets, config);

    for (const market of filteredMarkets) {
      // Check cooldown
      if (!this.canTradeMarket(runtime, market.id)) {
        continue;
      }

      // Build signal context
      const context = this.buildSignalContext(market);
      if (!context) continue;

      // Log price history size periodically
      const historySize = context.priceBars.length;
      if (historySize % 10 === 0 || historySize < 5) {
        logger.info({ strategyId: config.id, marketId: market.id, priceBars: historySize }, 'Evaluating with price history');
      }

      // Get individual signal outputs
      const signalOutputs: SignalOutput[] = [];

      for (const signal of signals) {
        const output = await signal.compute(context);
        if (output) {
          signalOutputs.push(output);
          logger.info({ strategyId: config.id, signalId: signal.signalId, direction: output.direction, strength: output.strength, confidence: output.confidence }, 'Signal generated');
        }
      }

      // Skip if no signals
      if (signalOutputs.length === 0) continue;

      // Combine signals
      const combined = combiner.combine(signalOutputs);

      // Skip if no combined signal
      if (!combined) continue;

      runtime.state.lastSignalTime = new Date();
      this.emit('signal:generated', config.id, combined, market.id);

      // Check if signal meets execution thresholds
      if (!this.shouldExecute(combined, config.executionParams)) {
        continue;
      }

      // Check risk limits
      const riskCheck = this.checkRiskLimits(runtime, market.id);
      if (!riskCheck.passed) {
        this.emit('risk:triggered', config.id, riskCheck.limitType!, riskCheck.value!);
        this.emit('trade:skipped', config.id, `Risk limit: ${riskCheck.limitType}`);
        continue;
      }

      // Calculate position size
      const positionSize = this.calculatePositionSize(runtime, combined, market);
      if (positionSize <= 0) {
        this.emit('trade:skipped', config.id, 'Position size too small');
        continue;
      }

      // Execute trade
      await this.executeTrade(runtime, market, combined, positionSize);
    }
  }

  /**
   * Build signal context from market data
   */
  private buildSignalContext(market: LiveMarket): SignalContext | null {
    const prices = market.outcomes.map(outcome =>
      this.feed.getPrice(market.id, outcome)
    ).filter(Boolean);

    if (prices.length === 0) return null;

    const currentPrice = prices[0]!.price;
    const now = new Date();

    // Build price bar from current price
    const priceBar: PriceBar = {
      time: now,
      open: currentPrice,
      high: currentPrice,
      low: currentPrice,
      close: currentPrice,
      volume: market.volume,
    };

    // Add to price history
    this.addPriceBar(market.id, priceBar);

    // Get accumulated price history
    const priceBars = this.getPriceHistory(market.id);

    const marketInfo: MarketInfo = {
      id: market.id,
      question: market.question,
      endDate: market.endDate,
      isActive: market.isActive,
      isResolved: !market.isActive,
      tokenIdYes: market.outcomes[0] || 'yes',
      tokenIdNo: market.outcomes[1] || 'no',
      currentPriceYes: market.outcomePrices[0] || currentPrice,
      currentPriceNo: market.outcomePrices[1] || (1 - currentPrice),
      volume24h: market.volume,
      liquidity: market.liquidity,
    };

    return {
      currentTime: now,
      market: marketInfo,
      priceBars,
      recentTrades: [],
    };
  }

  /**
   * Add a price bar to history
   */
  private addPriceBar(marketId: string, bar: PriceBar): void {
    let history = this.priceHistory.get(marketId);
    if (!history) {
      history = [];
      this.priceHistory.set(marketId, history);
    }

    // Only add if enough time has passed since last bar (5 seconds)
    const lastBar = history[history.length - 1];
    if (lastBar && bar.time.getTime() - lastBar.time.getTime() < 5000) {
      // Update existing bar's high/low
      lastBar.high = Math.max(lastBar.high, bar.close);
      lastBar.low = Math.min(lastBar.low, bar.close);
      lastBar.close = bar.close;
      lastBar.volume = bar.volume;
      return;
    }

    history.push(bar);

    // Trim to max size
    if (history.length > this.MAX_HISTORY_BARS) {
      history.shift();
    }
  }

  /**
   * Get price history for a market
   */
  private getPriceHistory(marketId: string): PriceBar[] {
    return this.priceHistory.get(marketId) || [];
  }

  /**
   * Check if signal meets execution thresholds
   */
  private shouldExecute(signal: CombinedSignalOutput | null, params: ExecutionParams): boolean {
    if (!signal) return false;
    if (signal.direction === 'NEUTRAL') return false;
    if (Math.abs(signal.strength) < params.minEdge) return false;
    if (signal.confidence < params.minConfidence) return false;
    return true;
  }

  /**
   * Check risk limits
   */
  private checkRiskLimits(
    runtime: StrategyRuntime,
    marketId: string
  ): { passed: boolean; limitType?: string; value?: number } {
    const { config, state } = runtime;
    const limits = config.riskLimits;
    const portfolio = this.engine.getPortfolioState();

    // Check max positions
    const strategyPositions = this.getStrategyPositions(config.id);
    if (strategyPositions.length >= limits.maxOpenPositions) {
      return { passed: false, limitType: 'maxOpenPositions', value: strategyPositions.length };
    }

    // Check daily loss
    this.updateDailyPnl(runtime);
    if (state.todayPnl < -limits.maxDailyLoss) {
      return { passed: false, limitType: 'maxDailyLoss', value: Math.abs(state.todayPnl) };
    }

    // Check drawdown
    const drawdown = 1 - (portfolio.equity / this.config.kellyFraction);
    if (drawdown > limits.maxDrawdown) {
      return { passed: false, limitType: 'maxDrawdown', value: drawdown };
    }

    // Check position size limit (done during sizing)
    return { passed: true };
  }

  /**
   * Calculate position size
   */
  private calculatePositionSize(
    runtime: StrategyRuntime,
    signal: CombinedSignalOutput,
    market: LiveMarket
  ): number {
    const { config } = runtime;
    const limits = config.riskLimits;
    const portfolio = this.engine.getPortfolioState();

    // Base position size as fraction of equity
    let positionSize = portfolio.equity * (limits.maxPositionPct / 100);

    // Apply Kelly criterion if enabled
    if (this.config.enablePositionSizing && signal.confidence > 0) {
      // Simplified Kelly: f = (bp - q) / b
      // where b = odds, p = probability of win, q = 1 - p
      const prob = (signal.confidence + 1) / 2; // Convert confidence to probability
      const odds = 1; // Even odds in prediction markets (simplified)
      const kelly = (odds * prob - (1 - prob)) / odds;

      // Apply Kelly fraction
      const kellySize = portfolio.equity * kelly * this.config.kellyFraction;

      // Take minimum of Kelly and max position size
      positionSize = Math.min(positionSize, kellySize);
    }

    // Apply max position size limit
    positionSize = Math.min(positionSize, limits.maxPositionSize);

    // Convert to number of shares based on price
    const price = signal.direction === 'LONG'
      ? market.outcomePrices[0]
      : market.outcomePrices[1];

    const shares = positionSize / price;

    return Math.max(0, Math.floor(shares * 100) / 100); // Round to 2 decimals
  }

  /**
   * Execute a trade
   */
  private async executeTrade(
    runtime: StrategyRuntime,
    market: LiveMarket,
    signal: CombinedSignalOutput,
    size: number
  ): Promise<void> {
    const { config } = runtime;
    const params = config.executionParams;

    // Determine outcome based on signal direction
    const outcome = signal.direction === 'LONG' ? market.outcomes[0] : market.outcomes[1];
    const price = signal.direction === 'LONG'
      ? market.outcomePrices[0]
      : market.outcomePrices[1];

    // Build order request
    const orderRequest: OrderRequest = {
      marketId: market.id,
      outcome,
      type: params.orderType,
      side: 'BUY',
      size,
      price: params.orderType === 'LIMIT' ? price * (1 + params.slippageTolerance) : undefined,
      strategyId: config.id,
      metadata: {
        signal: {
          direction: signal.direction,
          strength: signal.strength,
          confidence: signal.confidence,
        },
      },
    };

    // Submit order
    const order = await this.engine.submitOrder(orderRequest);

    if (order.status === 'FILLED' || order.status === 'OPEN') {
      runtime.state.lastTradeTime = new Date();
      runtime.state.todayTrades++;
      runtime.lastTradeByMarket.set(market.id, new Date());

      this.emit('trade:executed', config.id, order);
      logger.info({
        strategyId: config.id,
        marketId: market.id,
        direction: signal.direction,
        size,
        price,
      }, 'Trade executed');
    } else {
      this.emit('trade:skipped', config.id, `Order ${order.status}`);
    }
  }

  // ============================================
  // Helper Methods
  // ============================================

  /**
   * Filter markets based on strategy config
   */
  private filterMarkets(markets: LiveMarket[], config: StrategyConfig): LiveMarket[] {
    let filtered = markets;

    for (const filter of config.marketFilters || []) {
      switch (filter.type) {
        case 'volume':
          const minVolume = filter.params.minVolume as number || 0;
          filtered = filtered.filter(m => m.volume >= minVolume);
          break;

        case 'liquidity':
          const minLiquidity = filter.params.minLiquidity as number || 0;
          filtered = filtered.filter(m => m.liquidity >= minLiquidity);
          break;

        case 'endDate':
          const minDays = filter.params.minDaysToExpiry as number || 0;
          const maxDays = filter.params.maxDaysToExpiry as number || Infinity;
          const now = new Date();
          filtered = filtered.filter(m => {
            const daysToExpiry = (m.endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
            return daysToExpiry >= minDays && daysToExpiry <= maxDays;
          });
          break;
      }
    }

    return filtered;
  }

  /**
   * Check if we can trade a market (cooldown)
   */
  private canTradeMarket(runtime: StrategyRuntime, marketId: string): boolean {
    const lastTrade = runtime.lastTradeByMarket.get(marketId);
    if (!lastTrade) return true;

    const elapsed = Date.now() - lastTrade.getTime();
    return elapsed >= this.config.marketCooldownMs;
  }

  /**
   * Get positions for a strategy
   */
  private getStrategyPositions(strategyId: string): Position[] {
    // In a full implementation, we'd track positions by strategy
    // For now, return all positions
    return this.engine.getAllPositions();
  }

  /**
   * Update daily P&L tracking
   */
  private updateDailyPnl(runtime: StrategyRuntime): void {
    const today = this.getTodayDateString();

    // Reset if new day
    if (runtime.dailyPnlDate !== today) {
      runtime.dailyPnlStart = this.engine.getEquity();
      runtime.dailyPnlDate = today;
      runtime.state.todayTrades = 0;
    }

    runtime.state.todayPnl = this.engine.getEquity() - runtime.dailyPnlStart;
  }

  /**
   * Get today's date as string
   */
  private getTodayDateString(): string {
    return new Date().toISOString().split('T')[0];
  }
}

/**
 * Create a strategy orchestrator
 */
export function createStrategyOrchestrator(
  feed: LiveDataFeed,
  engine: PaperTradingEngine,
  config?: Partial<OrchestratorConfig>
): StrategyOrchestrator {
  return new StrategyOrchestrator(feed, engine, config);
}
