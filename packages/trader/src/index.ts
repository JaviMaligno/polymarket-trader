/**
 * @polymarket-trader/trader
 *
 * Paper trading engine and live integration for Polymarket.
 *
 * Features:
 * - Real-time data feed from Polymarket CLOB
 * - Paper trading with realistic simulation
 * - Strategy orchestration and signal execution
 * - Real-time risk monitoring
 * - Multi-channel alert system
 */

// Core types
export * from './types/index.js';

// Data Feeds
export {
  LiveDataFeed,
  createLiveDataFeed,
  type LiveDataFeedEvents,
} from './feeds/LiveDataFeed.js';

// Trading Engine
export {
  PaperTradingEngine,
  createPaperTradingEngine,
  type PaperTradingConfig,
  type PaperTradingEvents,
} from './engine/PaperTradingEngine.js';

// Strategy Orchestrator
export {
  StrategyOrchestrator,
  createStrategyOrchestrator,
  type OrchestratorConfig,
  type OrchestratorEvents,
} from './orchestrator/StrategyOrchestrator.js';

// Risk Monitoring
export {
  RiskMonitor,
  createRiskMonitor,
  type RiskMonitorConfig,
  type RiskMonitorEvents,
  type RiskLimit,
} from './monitoring/RiskMonitor.js';

// Alert System
export {
  AlertSystem,
  createAlertSystem,
  type AlertSystemEvents,
  type AlertRule,
} from './alerts/AlertSystem.js';

// ============================================
// Factory Functions
// ============================================

import { LiveDataFeed, createLiveDataFeed } from './feeds/LiveDataFeed.js';
import { PaperTradingEngine, createPaperTradingEngine, type PaperTradingConfig } from './engine/PaperTradingEngine.js';
import { StrategyOrchestrator, createStrategyOrchestrator, type OrchestratorConfig } from './orchestrator/StrategyOrchestrator.js';
import { RiskMonitor, createRiskMonitor, type RiskMonitorConfig } from './monitoring/RiskMonitor.js';
import { AlertSystem, createAlertSystem } from './alerts/AlertSystem.js';
import type { FeedConfig, AlertConfig } from './types/index.js';

/**
 * Full trading system configuration
 */
export interface TradingSystemConfig {
  feed?: Partial<FeedConfig>;
  trading?: Partial<PaperTradingConfig>;
  orchestrator?: Partial<OrchestratorConfig>;
  riskMonitor?: Partial<RiskMonitorConfig>;
  alerts?: Partial<AlertConfig>;
}

/**
 * Complete trading system
 */
export interface TradingSystem {
  feed: LiveDataFeed;
  engine: PaperTradingEngine;
  orchestrator: StrategyOrchestrator;
  riskMonitor: RiskMonitor;
  alertSystem: AlertSystem;
  start: () => Promise<void>;
  stop: () => void;
}

/**
 * Create a complete trading system
 */
export function createTradingSystem(config?: TradingSystemConfig): TradingSystem {
  // Create components
  const feed = createLiveDataFeed(config?.feed);
  const engine = createPaperTradingEngine(feed, config?.trading);
  const orchestrator = createStrategyOrchestrator(feed, engine, config?.orchestrator);
  const riskMonitor = createRiskMonitor(engine, config?.riskMonitor);
  const alertSystem = createAlertSystem(config?.alerts);

  // Wire up alerts
  riskMonitor.on('alert', (alert) => {
    alertSystem.send(alert);
  });

  // Register default alert rules
  alertSystem.registerDefaultRules();

  return {
    feed,
    engine,
    orchestrator,
    riskMonitor,
    alertSystem,

    async start() {
      // Connect feed first
      await feed.connect();

      // Start engine
      engine.start();

      // Start monitoring
      riskMonitor.start();

      // Start orchestrator last
      orchestrator.start();
    },

    stop() {
      // Stop in reverse order
      orchestrator.stop();
      riskMonitor.stop();
      engine.stop();
      feed.disconnect();
    },
  };
}

/**
 * Default trading system configuration
 */
export const DEFAULT_TRADING_CONFIG: TradingSystemConfig = {
  trading: {
    initialCapital: 10000,
    feeRate: 0.002,
    slippageModel: 'proportional',
    proportionalSlippage: 0.001,
  },
  orchestrator: {
    evaluationIntervalMs: 5000,
    kellyFraction: 0.25,
  },
  riskMonitor: {
    maxExposure: 0.8,
    maxDrawdown: 0.15,
    maxDailyLoss: 500,
  },
  alerts: {
    channels: ['CONSOLE'],
    minSeverity: 'INFO',
  },
};
