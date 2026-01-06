/**
 * Trading Automation
 *
 * Main orchestrator that integrates all automated trading services:
 * - Auto Signal Executor
 * - Signal Learning
 * - Data Collection
 * - Risk Management
 */

import { EventEmitter } from 'events';
import { isDatabaseConfigured } from '../database/index.js';
import {
  AutoSignalExecutor,
  initializeAutoSignalExecutor,
  type ExecutorConfig,
  type SignalResult,
} from './AutoSignalExecutor.js';

// Re-export SignalResult for use by routes
export type { SignalResult };
import {
  SignalLearningService,
  initializeSignalLearningService,
  type LearningConfig,
} from './SignalLearningService.js';
import {
  DataCollectorService,
  initializeDataCollectorService,
  type CollectorConfig,
  type PriceData,
} from './DataCollectorService.js';
import {
  RiskManager,
  initializeRiskManager,
  type RiskConfig,
} from './RiskManager.js';

export interface AutomationConfig {
  enabled: boolean;
  executor: Partial<ExecutorConfig>;
  learning: Partial<LearningConfig>;
  collector: Partial<CollectorConfig>;
  risk: Partial<RiskConfig>;
}

const DEFAULT_CONFIG: AutomationConfig = {
  enabled: true,
  executor: {},
  learning: {},
  collector: {},
  risk: {},
};

export interface AutomationStatus {
  isRunning: boolean;
  executor: {
    enabled: boolean;
    dailyTrades: number;
  };
  learning: {
    enabled: boolean;
    lastEvaluation: Date | null;
  };
  collector: {
    enabled: boolean;
    recordCount: number;
  };
  risk: {
    enabled: boolean;
    isHalted: boolean;
    haltReason: string | null;
  };
}

export class TradingAutomation extends EventEmitter {
  private config: AutomationConfig;
  private executor: AutoSignalExecutor;
  private learning: SignalLearningService;
  private collector: DataCollectorService;
  private risk: RiskManager;
  private isRunning = false;

  constructor(config?: Partial<AutomationConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Initialize all services
    this.executor = initializeAutoSignalExecutor(this.config.executor);
    this.learning = initializeSignalLearningService(this.config.learning);
    this.collector = initializeDataCollectorService(this.config.collector);
    this.risk = initializeRiskManager(this.config.risk);

    // Wire up events
    this.setupEventHandlers();
  }

  /**
   * Set up event handlers to coordinate services
   */
  private setupEventHandlers(): void {
    // When risk manager halts trading, stop the executor
    this.risk.on('trading:halted', (data) => {
      console.log('[TradingAutomation] Trading halted by risk manager:', data.reason);
      this.executor.stop();
      this.emit('trading:halted', data);
    });

    // When trading resumes, restart executor
    this.risk.on('trading:resumed', (data) => {
      console.log('[TradingAutomation] Trading resumed');
      if (this.isRunning) {
        this.executor.start();
      }
      this.emit('trading:resumed', data);
    });

    // Track executed trades for learning
    this.executor.on('trade:executed', async (data) => {
      this.emit('trade:executed', data);

      // Trigger learning evaluation after trades
      // (debounced - learning service handles its own interval)
    });

    // Forward important events
    this.learning.on('weight:adjusted', (data) => {
      this.emit('weight:adjusted', data);
    });

    this.learning.on('evaluation:complete', (data) => {
      this.emit('learning:complete', data);
    });

    this.collector.on('snapshot:saved', (data) => {
      this.emit('data:collected', data);
    });

    this.risk.on('risk:checked', (data) => {
      this.emit('risk:checked', data);
    });
  }

  /**
   * Start all automation services
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[TradingAutomation] Already running');
      return;
    }

    if (!isDatabaseConfigured()) {
      console.warn('[TradingAutomation] Database not configured - cannot start');
      return;
    }

    console.log('[TradingAutomation] Starting all services...');

    this.isRunning = true;

    // Start services in order
    await this.risk.start();        // Start risk first to monitor
    this.collector.start();          // Then data collection
    this.learning.start();           // Then learning

    // Only start executor if not halted
    if (!this.risk.isTradingHalted()) {
      this.executor.start();
    }

    console.log('[TradingAutomation] All services started');
    this.emit('started');
  }

  /**
   * Stop all automation services
   */
  stop(): void {
    if (!this.isRunning) {
      console.log('[TradingAutomation] Not running');
      return;
    }

    console.log('[TradingAutomation] Stopping all services...');

    this.executor.stop();
    this.learning.stop();
    this.collector.stop();
    this.risk.stop();

    this.isRunning = false;
    console.log('[TradingAutomation] All services stopped');
    this.emit('stopped');
  }

  /**
   * Process incoming signals (from external signal engine)
   */
  async processSignals(signals: SignalResult[]): Promise<{
    processed: number;
    executed: number;
  }> {
    if (!this.isRunning || this.risk.isTradingHalted()) {
      return { processed: 0, executed: 0 };
    }

    const result = await this.executor.processSignals(signals);
    return {
      processed: result.processed,
      executed: result.executed,
    };
  }

  /**
   * Process incoming price data
   */
  recordPrices(prices: PriceData[]): void {
    if (!this.isRunning) return;

    // Record to data collector
    this.collector.recordPrices(prices);

    // Resolve pending predictions with price updates
    this.learning.resolvePredictions(
      prices.map(p => ({ marketId: p.marketId, currentPrice: p.price }))
    );
  }

  /**
   * Get automation status
   */
  getStatus(): AutomationStatus {
    const riskStatus = this.risk.getStatus();

    return {
      isRunning: this.isRunning,
      executor: {
        enabled: this.executor.isActive(),
        dailyTrades: this.executor.getStats().dailyTradeCount,
      },
      learning: {
        enabled: this.learning.getStatus().isRunning,
        lastEvaluation: this.learning.getStatus().lastEvaluation,
      },
      collector: {
        enabled: this.collector.getStats().isRunning,
        recordCount: this.collector.getStats().recordCount,
      },
      risk: {
        enabled: this.risk.getConfig().enabled,
        isHalted: riskStatus.isHalted,
        haltReason: riskStatus.haltReason,
      },
    };
  }

  /**
   * Get detailed statistics
   */
  async getDetailedStats(): Promise<{
    status: AutomationStatus;
    riskMetrics: ReturnType<RiskManager['getStatus']>;
    signalPerformance: Awaited<ReturnType<SignalLearningService['getPerformanceSummary']>>;
  }> {
    return {
      status: this.getStatus(),
      riskMetrics: await this.risk.checkRisk(),
      signalPerformance: await this.learning.getPerformanceSummary(),
    };
  }

  /**
   * Force learning evaluation
   */
  async forceEvaluation(): Promise<void> {
    await this.learning.forceEvaluate();
  }

  /**
   * Manually halt trading
   */
  async haltTrading(reason?: string): Promise<void> {
    await this.risk.manualHalt(reason);
  }

  /**
   * Resume trading
   */
  async resumeTrading(): Promise<boolean> {
    return this.risk.resumeTrading('Manual resume');
  }

  /**
   * Check if trading is allowed
   */
  isTradingAllowed(): boolean {
    return this.isRunning && !this.risk.isTradingHalted();
  }

  /**
   * Get executor instance for direct access
   */
  getExecutor(): AutoSignalExecutor {
    return this.executor;
  }

  /**
   * Get learning service instance
   */
  getLearningService(): SignalLearningService {
    return this.learning;
  }

  /**
   * Get collector instance
   */
  getCollector(): DataCollectorService {
    return this.collector;
  }

  /**
   * Get risk manager instance
   */
  getRiskManager(): RiskManager {
    return this.risk;
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<AutomationConfig>): void {
    if (updates.executor) {
      this.executor.updateConfig(updates.executor);
    }
    if (updates.learning) {
      this.learning.updateConfig(updates.learning);
    }
    if (updates.collector) {
      this.collector.updateConfig(updates.collector);
    }
    if (updates.risk) {
      this.risk.updateConfig(updates.risk);
    }
    this.emit('config:updated', this.config);
  }
}

// Singleton instance
let tradingAutomation: TradingAutomation | null = null;

export function getTradingAutomation(): TradingAutomation {
  if (!tradingAutomation) {
    tradingAutomation = new TradingAutomation();
  }
  return tradingAutomation;
}

export function initializeTradingAutomation(config?: Partial<AutomationConfig>): TradingAutomation {
  tradingAutomation = new TradingAutomation(config);
  return tradingAutomation;
}
