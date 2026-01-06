/**
 * CLI Context
 *
 * Holds the trading system state for CLI commands.
 */

import type { TradingSystem } from '../../index.js';
import type { StrategyConfig } from '../../types/index.js';
import type { ISignal, ISignalCombiner } from '@polymarket-trader/signals';

export interface CLIContext {
  system: TradingSystem | null;
  isRunning: boolean;
  strategies: Map<string, {
    config: StrategyConfig;
    signals: ISignal[];
    combiner: ISignalCombiner;
  }>;
  watchedMarkets: Set<string>;
  config: CLIConfig;
}

export interface CLIConfig {
  initialCapital: number;
  feeRate: number;
  maxDrawdown: number;
  maxDailyLoss: number;
  apiUrl: string;
  refreshIntervalMs: number;
  alertChannels: string[];
}

const DEFAULT_CONFIG: CLIConfig = {
  initialCapital: 10000,
  feeRate: 0.002,
  maxDrawdown: 0.15,
  maxDailyLoss: 500,
  apiUrl: 'https://clob.polymarket.com',
  refreshIntervalMs: 5000,
  alertChannels: ['CONSOLE'],
};

let context: CLIContext = {
  system: null,
  isRunning: false,
  strategies: new Map(),
  watchedMarkets: new Set(),
  config: { ...DEFAULT_CONFIG },
};

export function getContext(): CLIContext {
  return context;
}

export function setSystem(system: TradingSystem): void {
  context.system = system;
}

export function setRunning(running: boolean): void {
  context.isRunning = running;
}

export function updateConfig(config: Partial<CLIConfig>): void {
  context.config = { ...context.config, ...config };
}

export function addStrategy(
  config: StrategyConfig,
  signals: ISignal[],
  combiner: ISignalCombiner
): void {
  context.strategies.set(config.id, { config, signals, combiner });
}

export function removeStrategy(strategyId: string): void {
  context.strategies.delete(strategyId);
}

export function watchMarket(marketId: string): void {
  context.watchedMarkets.add(marketId);
}

export function unwatchMarket(marketId: string): void {
  context.watchedMarkets.delete(marketId);
}

export function resetContext(): void {
  context = {
    system: null,
    isRunning: false,
    strategies: new Map(),
    watchedMarkets: new Set(),
    config: { ...DEFAULT_CONFIG },
  };
}
