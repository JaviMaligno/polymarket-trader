/**
 * System Commands
 *
 * Commands for system control, monitoring, and alerts.
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
  formatDuration,
  statusBadge,
  createTable,
  clearScreen,
  spinner,
} from '../utils/display.js';
import { getContext, setSystem, setRunning, updateConfig } from '../utils/context.js';
import { createTradingSystem, type TradingSystemConfig } from '../../index.js';

// ============================================
// Start/Stop System
// ============================================

export async function startSystem(): Promise<void> {
  const ctx = getContext();

  if (ctx.isRunning) {
    console.log(yellow('System is already running'));
    console.log();
    return;
  }

  console.log();
  const spin = spinner();
  spin.start('Initializing trading system...');

  try {
    // Build config from CLI context
    const config: TradingSystemConfig = {
      feed: {
        apiUrl: ctx.config.apiUrl,
      },
      trading: {
        initialCapital: ctx.config.initialCapital,
        feeRate: ctx.config.feeRate,
      },
      riskMonitor: {
        maxDrawdown: ctx.config.maxDrawdown,
        maxDailyLoss: ctx.config.maxDailyLoss,
      },
      alerts: {
        channels: ctx.config.alertChannels as any[],
        minSeverity: 'INFO',
      },
    };

    const system = createTradingSystem(config);
    setSystem(system);

    spin.update('Connecting to data feed...');

    // Start the system
    await system.start();

    // Register any existing strategies
    for (const [id, { config: stratConfig, signals, combiner }] of ctx.strategies) {
      system.orchestrator.registerStrategy(stratConfig, signals, combiner);
      if (stratConfig.enabled) {
        system.orchestrator.startStrategy(id);
      }
    }

    // Subscribe to watched markets
    for (const marketId of ctx.watchedMarkets) {
      system.feed.subscribe(marketId);
    }

    setRunning(true);

    spin.stop('System started successfully!');
    console.log();
    console.log(`  ${bold('Initial Capital:')} ${formatCurrency(ctx.config.initialCapital)}`);
    console.log(`  ${bold('API URL:')} ${ctx.config.apiUrl}`);
    console.log(`  ${bold('Strategies:')} ${ctx.strategies.size}`);
    console.log(`  ${bold('Watched Markets:')} ${ctx.watchedMarkets.size}`);
    console.log();

  } catch (error) {
    spin.stop();
    console.log(red(`Failed to start system: ${error}`));
    console.log();
  }
}

export function stopSystem(): void {
  const ctx = getContext();

  if (!ctx.isRunning || !ctx.system) {
    console.log(yellow('System is not running'));
    console.log();
    return;
  }

  ctx.system.stop();
  setRunning(false);

  console.log(yellow('System stopped'));
  console.log();
}

// ============================================
// System Status
// ============================================

export function showSystemStatus(): void {
  const ctx = getContext();

  console.log('\n' + bold(cyan('═══ SYSTEM STATUS ═══')) + '\n');

  // Basic status
  console.log(`  ${bold('Status:')} ${ctx.isRunning ? green('Running') : yellow('Stopped')}`);

  if (!ctx.system) {
    console.log(dim('  System not initialized'));
    console.log();
    return;
  }

  // Feed status
  const feedState = ctx.system.feed.getState();
  console.log(`  ${bold('Data Feed:')} ${statusBadge(feedState.status)}`);
  if (feedState.connectedAt) {
    console.log(`    Connected: ${formatDate(feedState.connectedAt)}`);
  }
  if (feedState.lastMessageAt) {
    console.log(`    Last Data: ${formatDate(feedState.lastMessageAt)}`);
  }
  console.log(`    Subscriptions: ${feedState.subscriptions.length}`);

  // Risk Monitor
  console.log(`  ${bold('Risk Monitor:')} ${ctx.system.riskMonitor.isTradingHalted() ? red('HALTED') : green('Active')}`);

  // Strategies
  const strategies = ctx.system.orchestrator.getAllStrategyStates();
  const runningCount = Array.from(strategies.values()).filter(s => s.isRunning).length;
  console.log(`  ${bold('Strategies:')} ${runningCount}/${strategies.size} running`);

  // Portfolio summary
  const portfolio = ctx.system.engine.getPortfolioState();
  console.log();
  console.log(`  ${bold('Equity:')} ${formatCurrency(portfolio.equity)}`);
  console.log(`  ${bold('Positions:')} ${portfolio.positions.length}`);
  console.log(`  ${bold('Open Orders:')} ${portfolio.openOrders.length}`);

  console.log();
}

// ============================================
// Alerts
// ============================================

export function showAlerts(count: number = 10): void {
  const ctx = getContext();

  if (!ctx.system) {
    console.log(red('System not initialized. Run "start" first.'));
    return;
  }

  const alerts = ctx.system.alertSystem.getHistory(count);

  console.log('\n' + bold(cyan(`═══ RECENT ALERTS (${alerts.length}) ═══`)) + '\n');

  if (alerts.length === 0) {
    console.log(dim('No alerts'));
    console.log();
    return;
  }

  const table = createTable(['Time', 'Severity', 'Title', 'Message']);

  for (const alert of alerts.reverse()) {
    let severityStr: string;
    switch (alert.severity) {
      case 'CRITICAL':
        severityStr = red(bold(alert.severity));
        break;
      case 'ERROR':
        severityStr = red(alert.severity);
        break;
      case 'WARNING':
        severityStr = yellow(alert.severity);
        break;
      default:
        severityStr = dim(alert.severity);
    }

    table.push([
      alert.timestamp.toLocaleTimeString(),
      severityStr,
      alert.title.slice(0, 25),
      alert.message.slice(0, 40) + (alert.message.length > 40 ? '...' : ''),
    ]);
  }

  console.log(table.toString());
  console.log();
}

export function clearAlerts(): void {
  const ctx = getContext();

  if (!ctx.system) {
    console.log(red('System not initialized. Run "start" first.'));
    return;
  }

  ctx.system.alertSystem.clearHistory();
  console.log(green('Alerts cleared'));
  console.log();
}

// ============================================
// Configuration
// ============================================

export function showConfig(): void {
  const ctx = getContext();

  console.log('\n' + bold(cyan('═══ CONFIGURATION ═══')) + '\n');

  const table = createTable(['Setting', 'Value']);

  table.push(
    ['Initial Capital', formatCurrency(ctx.config.initialCapital)],
    ['Fee Rate', formatPercent(ctx.config.feeRate)],
    ['Max Drawdown', formatPercent(ctx.config.maxDrawdown)],
    ['Max Daily Loss', formatCurrency(ctx.config.maxDailyLoss)],
    ['API URL', ctx.config.apiUrl],
    ['Refresh Interval', `${ctx.config.refreshIntervalMs}ms`],
    ['Alert Channels', ctx.config.alertChannels.join(', ')],
  );

  console.log(table.toString());
  console.log();
}

export function setConfig(key: string, value: string): void {
  const ctx = getContext();

  switch (key.toLowerCase()) {
    case 'capital':
    case 'initialcapital':
      updateConfig({ initialCapital: parseFloat(value) });
      console.log(green(`Initial capital set to ${formatCurrency(parseFloat(value))}`));
      break;

    case 'feerate':
      updateConfig({ feeRate: parseFloat(value) });
      console.log(green(`Fee rate set to ${formatPercent(parseFloat(value))}`));
      break;

    case 'maxdrawdown':
      updateConfig({ maxDrawdown: parseFloat(value) });
      console.log(green(`Max drawdown set to ${formatPercent(parseFloat(value))}`));
      break;

    case 'maxdailyloss':
      updateConfig({ maxDailyLoss: parseFloat(value) });
      console.log(green(`Max daily loss set to ${formatCurrency(parseFloat(value))}`));
      break;

    case 'apiurl':
      updateConfig({ apiUrl: value });
      console.log(green(`API URL set to ${value}`));
      break;

    default:
      console.log(red(`Unknown config key: ${key}`));
      console.log(dim('Available: capital, feeRate, maxDrawdown, maxDailyLoss, apiUrl'));
  }

  console.log();
}

// ============================================
// Live Dashboard
// ============================================

export function startDashboard(): void {
  const ctx = getContext();

  if (!ctx.system) {
    console.log(red('System not initialized. Run "start" first.'));
    return;
  }

  let running = true;

  // Handle exit
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.on('data', (key) => {
    if (key.toString() === 'q' || key.toString() === '\x03') {
      running = false;
      process.stdin.setRawMode?.(false);
      console.log('\nDashboard closed');
    }
  });

  console.log(dim('Press "q" to exit dashboard'));

  const refresh = () => {
    if (!running) return;

    clearScreen();

    const portfolio = ctx.system!.engine.getPortfolioState();
    const snapshot = ctx.system!.riskMonitor.getSnapshot();
    const feedState = ctx.system!.feed.getState();

    // Header
    console.log(bold(cyan('╔════════════════════════════════════════════════════════════╗')));
    console.log(bold(cyan('║           POLYMARKET TRADER - LIVE DASHBOARD               ║')));
    console.log(bold(cyan('╚════════════════════════════════════════════════════════════╝')));
    console.log();

    // Top row: Equity and P&L
    const initialCapital = ctx.config.initialCapital;
    const totalPnl = portfolio.equity - initialCapital;
    const totalReturn = totalPnl / initialCapital;

    console.log(`  ${bold('EQUITY')}: ${formatCurrency(portfolio.equity)}   ${bold('P&L')}: ${formatCurrency(totalPnl)} (${formatPercent(totalReturn)})`);
    console.log(`  ${bold('CASH')}: ${formatCurrency(portfolio.cash)}   ${bold('POSITIONS')}: ${portfolio.positions.length}   ${bold('ORDERS')}: ${portfolio.openOrders.length}`);
    console.log();

    // Feed status
    console.log(`  ${bold('FEED')}: ${statusBadge(feedState.status)}   ${bold('RISK')}: ${ctx.system!.riskMonitor.isTradingHalted() ? red('HALTED') : green('OK')}`);
    console.log();

    // Positions
    if (portfolio.positions.length > 0) {
      console.log(bold('  POSITIONS'));
      const posTable = createTable(['Market', 'Size', 'Entry', 'Current', 'P&L']);
      for (const pos of portfolio.positions.slice(0, 5)) {
        posTable.push([
          pos.marketId.slice(0, 16),
          pos.size.toFixed(2),
          pos.avgEntryPrice.toFixed(4),
          pos.currentPrice.toFixed(4),
          formatCurrency(pos.unrealizedPnl),
        ]);
      }
      console.log(posTable.toString());
    }

    // Risk
    console.log();
    console.log(bold('  RISK METRICS'));
    console.log(`    Exposure: ${formatPercent(snapshot.risk.portfolioExposure)}   Drawdown: ${formatPercent(snapshot.trading.currentDrawdown)}   VaR: ${formatCurrency(snapshot.risk.valueAtRisk)}`);

    // Time
    console.log();
    console.log(dim(`  Updated: ${new Date().toLocaleTimeString()}   Press 'q' to exit`));
  };

  // Initial render
  refresh();

  // Refresh loop
  const interval = setInterval(() => {
    if (!running) {
      clearInterval(interval);
      return;
    }
    refresh();
  }, ctx.config.refreshIntervalMs);
}

// ============================================
// Resume/Halt Trading
// ============================================

export function resumeTrading(): void {
  const ctx = getContext();

  if (!ctx.system) {
    console.log(red('System not initialized. Run "start" first.'));
    return;
  }

  ctx.system.riskMonitor.resumeTrading();
  console.log(green('Trading resumed'));
  console.log();
}

export function haltTrading(): void {
  const ctx = getContext();

  if (!ctx.system) {
    console.log(red('System not initialized. Run "start" first.'));
    return;
  }

  // Close all and halt
  ctx.system.engine.closeAllPositions();
  ctx.system.engine.cancelAllOrders();

  // The risk monitor will emit halt, but we can't directly halt it
  // as it's based on risk limits. For manual halt, we stop strategies.
  for (const strategyId of ctx.strategies.keys()) {
    ctx.system.orchestrator.stopStrategy(strategyId);
  }

  console.log(yellow('Trading halted - all strategies stopped'));
  console.log();
}
