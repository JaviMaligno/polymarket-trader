/**
 * Strategy Commands
 *
 * Commands for managing trading strategies.
 */

import {
  bold,
  cyan,
  green,
  red,
  yellow,
  dim,
  formatCurrency,
  formatPercent,
  formatDate,
  statusBadge,
  createTable,
  divider,
} from '../utils/display.js';
import { getContext, addStrategy, removeStrategy } from '../utils/context.js';
import {
  MomentumSignal,
  MeanReversionSignal,
  WalletTrackingSignal,
  WeightedAverageCombiner,
  getAvailableSignals,
  createSignal,
} from '@polymarket-trader/signals';
import type { StrategyConfig, StrategyRiskLimits, ExecutionParams } from '../../types/index.js';

// ============================================
// List Strategies
// ============================================

export function listStrategies(): void {
  const ctx = getContext();

  console.log('\n' + bold(cyan('═══ STRATEGIES ═══')) + '\n');

  if (ctx.strategies.size === 0) {
    console.log(dim('No strategies registered'));
    console.log(dim('Use "strategy create" to create a new strategy'));
    console.log();
    return;
  }

  const table = createTable([
    'ID',
    'Name',
    'Signals',
    'Status',
    'Today P&L',
    'Trades',
  ]);

  for (const [id, { config }] of ctx.strategies) {
    let state = null;
    if (ctx.system) {
      state = ctx.system.orchestrator.getStrategyState(id);
    }

    table.push([
      id,
      config.name,
      config.signals.join(', '),
      state?.isRunning ? green('Running') : yellow('Stopped'),
      state ? formatCurrency(state.todayPnl) : '-',
      state?.todayTrades?.toString() || '0',
    ]);
  }

  console.log(table.toString());
  console.log();
}

// ============================================
// Show Strategy Details
// ============================================

export function showStrategyDetails(strategyId: string): void {
  const ctx = getContext();

  const strategy = ctx.strategies.get(strategyId);
  if (!strategy) {
    console.log(red(`Strategy "${strategyId}" not found`));
    console.log();
    return;
  }

  const { config, signals } = strategy;

  console.log('\n' + bold(cyan(`═══ STRATEGY: ${config.name} ═══`)) + '\n');

  // Basic info
  console.log(`  ${bold('ID:')} ${config.id}`);
  console.log(`  ${bold('Status:')} ${config.enabled ? green('Enabled') : yellow('Disabled')}`);
  console.log();

  // Signals
  console.log(bold('  Signals:'));
  for (const signal of signals) {
    console.log(`    - ${signal.signalId}: ${signal.name}`);
  }
  console.log();

  // Risk Limits
  console.log(bold('  Risk Limits:'));
  const limits = config.riskLimits;
  console.log(`    Max Position Size: ${formatCurrency(limits.maxPositionSize)}`);
  console.log(`    Max Position %: ${formatPercent(limits.maxPositionPct / 100)}`);
  console.log(`    Max Daily Loss: ${formatCurrency(limits.maxDailyLoss)}`);
  console.log(`    Max Drawdown: ${formatPercent(limits.maxDrawdown / 100)}`);
  console.log(`    Max Open Positions: ${limits.maxOpenPositions}`);
  if (limits.stopLossPct) {
    console.log(`    Stop Loss: ${formatPercent(limits.stopLossPct / 100)}`);
  }
  if (limits.takeProfitPct) {
    console.log(`    Take Profit: ${formatPercent(limits.takeProfitPct / 100)}`);
  }
  console.log();

  // Execution Params
  console.log(bold('  Execution:'));
  const exec = config.executionParams;
  console.log(`    Order Type: ${exec.orderType}`);
  console.log(`    Min Edge: ${formatPercent(exec.minEdge)}`);
  console.log(`    Min Confidence: ${formatPercent(exec.minConfidence)}`);
  console.log(`    Slippage Tolerance: ${formatPercent(exec.slippageTolerance)}`);
  console.log(`    Cooldown: ${exec.cooldownMs}ms`);
  console.log();

  // State if running
  if (ctx.system) {
    const state = ctx.system.orchestrator.getStrategyState(strategyId);
    if (state) {
      console.log(bold('  Current State:'));
      console.log(`    Running: ${state.isRunning ? green('Yes') : red('No')}`);
      console.log(`    Today P&L: ${formatCurrency(state.todayPnl)}`);
      console.log(`    Today Trades: ${state.todayTrades}`);
      console.log(`    Open Positions: ${state.positions.length}`);
      console.log(`    Open Orders: ${state.openOrders.length}`);
      if (state.lastSignalTime) {
        console.log(`    Last Signal: ${formatDate(state.lastSignalTime)}`);
      }
      if (state.lastTradeTime) {
        console.log(`    Last Trade: ${formatDate(state.lastTradeTime)}`);
      }
      console.log();
    }
  }
}

// ============================================
// Create Strategy
// ============================================

export function createStrategy(
  id: string,
  name: string,
  signalIds: string[],
  options?: Partial<{
    maxPositionSize: number;
    maxPositionPct: number;
    maxDailyLoss: number;
    maxDrawdown: number;
    maxOpenPositions: number;
    stopLossPct: number;
    takeProfitPct: number;
    orderType: 'MARKET' | 'LIMIT';
    minEdge: number;
    minConfidence: number;
  }>
): void {
  const ctx = getContext();

  if (ctx.strategies.has(id)) {
    console.log(red(`Strategy "${id}" already exists`));
    console.log();
    return;
  }

  // Create signals
  const signals = [];
  const weights: Record<string, number> = {};

  for (const signalId of signalIds) {
    const signal = createSignal(signalId);
    if (signal) {
      signals.push(signal);
      weights[signalId] = 1 / signalIds.length; // Equal weights
    } else {
      console.log(yellow(`Unknown signal: ${signalId}`));
    }
  }

  if (signals.length === 0) {
    console.log(red('No valid signals provided'));
    console.log(`Available: ${getAvailableSignals().join(', ')}`);
    console.log();
    return;
  }

  // Create combiner
  const combiner = new WeightedAverageCombiner(weights);

  // Build config
  const riskLimits: StrategyRiskLimits = {
    maxPositionSize: options?.maxPositionSize ?? 1000,
    maxPositionPct: options?.maxPositionPct ?? 10,
    maxDailyLoss: options?.maxDailyLoss ?? 500,
    maxDrawdown: options?.maxDrawdown ?? 15,
    maxOpenPositions: options?.maxOpenPositions ?? 5,
    stopLossPct: options?.stopLossPct,
    takeProfitPct: options?.takeProfitPct,
  };

  const executionParams: ExecutionParams = {
    orderType: options?.orderType ?? 'MARKET',
    slippageTolerance: 0.01,
    minEdge: options?.minEdge ?? 0.02,
    minConfidence: options?.minConfidence ?? 0.6,
    cooldownMs: 60000,
    maxRetries: 3,
  };

  const config: StrategyConfig = {
    id,
    name,
    enabled: false,
    signals: signalIds,
    riskLimits,
    executionParams,
  };

  // Store in context
  addStrategy(config, signals, combiner);

  // Register with orchestrator if system is running
  if (ctx.system) {
    ctx.system.orchestrator.registerStrategy(config, signals, combiner);
  }

  console.log(green(`Strategy "${name}" created`));
  console.log(`  ID: ${id}`);
  console.log(`  Signals: ${signalIds.join(', ')}`);
  console.log();
}

// ============================================
// Delete Strategy
// ============================================

export function deleteStrategy(strategyId: string): void {
  const ctx = getContext();

  if (!ctx.strategies.has(strategyId)) {
    console.log(red(`Strategy "${strategyId}" not found`));
    console.log();
    return;
  }

  // Unregister from orchestrator
  if (ctx.system) {
    ctx.system.orchestrator.unregisterStrategy(strategyId);
  }

  removeStrategy(strategyId);

  console.log(yellow(`Strategy "${strategyId}" deleted`));
  console.log();
}

// ============================================
// Start/Stop Strategy
// ============================================

export function startStrategy(strategyId: string): void {
  const ctx = getContext();

  if (!ctx.system) {
    console.log(red('System not initialized. Run "start" first.'));
    return;
  }

  const strategy = ctx.strategies.get(strategyId);
  if (!strategy) {
    console.log(red(`Strategy "${strategyId}" not found`));
    console.log();
    return;
  }

  // Register if not already
  const state = ctx.system.orchestrator.getStrategyState(strategyId);
  if (!state) {
    ctx.system.orchestrator.registerStrategy(
      strategy.config,
      strategy.signals,
      strategy.combiner
    );
  }

  ctx.system.orchestrator.startStrategy(strategyId);
  strategy.config.enabled = true;

  console.log(green(`Strategy "${strategyId}" started`));
  console.log();
}

export function stopStrategy(strategyId: string): void {
  const ctx = getContext();

  if (!ctx.system) {
    console.log(red('System not initialized.'));
    return;
  }

  const strategy = ctx.strategies.get(strategyId);
  if (!strategy) {
    console.log(red(`Strategy "${strategyId}" not found`));
    console.log();
    return;
  }

  ctx.system.orchestrator.stopStrategy(strategyId);
  strategy.config.enabled = false;

  console.log(yellow(`Strategy "${strategyId}" stopped`));
  console.log();
}

// ============================================
// List Available Signals
// ============================================

export function listAvailableSignals(): void {
  console.log('\n' + bold(cyan('═══ AVAILABLE SIGNALS ═══')) + '\n');

  const signals = getAvailableSignals();

  const table = createTable(['ID', 'Description']);

  const descriptions: Record<string, string> = {
    momentum: 'Trend-following based on price momentum',
    mean_reversion: 'Counter-trend based on overbought/oversold',
    wallet_tracking: 'Follows smart money wallet activity',
    cross_market_arb: 'Arbitrage across related markets',
  };

  for (const signalId of signals) {
    table.push([
      signalId,
      descriptions[signalId] || 'Custom signal',
    ]);
  }

  console.log(table.toString());
  console.log();
}

// ============================================
// Quick Strategy Templates
// ============================================

export function createMomentumStrategy(): void {
  createStrategy('momentum-default', 'Momentum Strategy', ['momentum'], {
    maxPositionPct: 5,
    minEdge: 0.03,
    minConfidence: 0.65,
  });
}

export function createMeanReversionStrategy(): void {
  createStrategy('mean-rev-default', 'Mean Reversion Strategy', ['mean_reversion'], {
    maxPositionPct: 5,
    minEdge: 0.02,
    minConfidence: 0.6,
  });
}

export function createComboStrategy(): void {
  createStrategy('combo-default', 'Combined Strategy', ['momentum', 'mean_reversion'], {
    maxPositionPct: 8,
    minEdge: 0.025,
    minConfidence: 0.7,
  });
}
