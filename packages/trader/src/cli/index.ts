#!/usr/bin/env node

/**
 * Polymarket Trader CLI
 *
 * Interactive command-line interface for paper trading on Polymarket.
 */

import * as readline from 'readline';
import figlet from 'figlet';

import { bold, cyan, green, red, yellow, dim } from './utils/display.js';
import { getContext, resetContext } from './utils/context.js';

// Commands
import {
  showPortfolioSummary,
  showPositions,
  showOrders,
  showEquityCurve,
  showRiskExposure,
} from './commands/portfolio.js';

import {
  submitOrder,
  buyMarket,
  sellMarket,
  cancelOrder,
  cancelAllOrders,
  closePosition,
  closeAllPositions,
  showMarketPrice,
  watchMarket,
  unwatchMarket,
  showWatchedMarkets,
} from './commands/trading.js';

import {
  listStrategies,
  showStrategyDetails,
  createStrategy,
  deleteStrategy,
  startStrategy,
  stopStrategy,
  listAvailableSignals,
  createMomentumStrategy,
  createMeanReversionStrategy,
  createComboStrategy,
} from './commands/strategy.js';

import {
  startSystem,
  stopSystem,
  showSystemStatus,
  showAlerts,
  clearAlerts,
  showConfig,
  setConfig,
  startDashboard,
  resumeTrading,
  haltTrading,
} from './commands/system.js';

// ============================================
// Banner
// ============================================

function showBanner(): void {
  console.log(cyan(figlet.textSync('PM Trader', {
    font: 'Small',
    horizontalLayout: 'default',
  })));
  console.log(dim('  Paper Trading CLI for Polymarket\n'));
}

// ============================================
// Help
// ============================================

function showHelp(): void {
  console.log('\n' + bold(cyan('═══ COMMANDS ═══')) + '\n');

  console.log(bold('  System:'));
  console.log('    start                     Start the trading system');
  console.log('    stop                      Stop the trading system');
  console.log('    status                    Show system status');
  console.log('    config                    Show configuration');
  console.log('    set <key> <value>         Set config value');
  console.log('    dashboard                 Start live dashboard');
  console.log();

  console.log(bold('  Portfolio:'));
  console.log('    portfolio, p              Show portfolio summary');
  console.log('    positions, pos            Show open positions');
  console.log('    orders                    Show open orders');
  console.log('    equity                    Show equity curve');
  console.log('    risk                      Show risk exposure');
  console.log();

  console.log(bold('  Trading:'));
  console.log('    buy <market> <outcome> <size>     Market buy');
  console.log('    sell <market> <outcome> <size>    Market sell');
  console.log('    cancel <orderId>          Cancel an order');
  console.log('    cancel-all                Cancel all orders');
  console.log('    close <market> <outcome>  Close a position');
  console.log('    close-all                 Close all positions');
  console.log('    halt                      Emergency halt');
  console.log('    resume                    Resume after halt');
  console.log();

  console.log(bold('  Markets:'));
  console.log('    watch <marketId>          Subscribe to market');
  console.log('    unwatch <marketId>        Unsubscribe from market');
  console.log('    markets                   Show watched markets');
  console.log('    price <marketId>          Show market price');
  console.log();

  console.log(bold('  Strategies:'));
  console.log('    strategies, strats        List strategies');
  console.log('    strategy <id>             Show strategy details');
  console.log('    signals                   List available signals');
  console.log('    create-momentum           Create momentum strategy');
  console.log('    create-meanrev            Create mean reversion strategy');
  console.log('    create-combo              Create combined strategy');
  console.log('    start-strat <id>          Start a strategy');
  console.log('    stop-strat <id>           Stop a strategy');
  console.log('    delete-strat <id>         Delete a strategy');
  console.log();

  console.log(bold('  Alerts:'));
  console.log('    alerts [count]            Show recent alerts');
  console.log('    clear-alerts              Clear alert history');
  console.log();

  console.log(bold('  Other:'));
  console.log('    help, h, ?                Show this help');
  console.log('    clear, cls                Clear screen');
  console.log('    quit, exit, q             Exit CLI');
  console.log();
}

// ============================================
// Command Parser
// ============================================

async function executeCommand(input: string): Promise<boolean> {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();
  const args = parts.slice(1);

  if (!cmd) return true;

  try {
    switch (cmd) {
      // System
      case 'start':
        await startSystem();
        break;
      case 'stop':
        stopSystem();
        break;
      case 'status':
        showSystemStatus();
        break;
      case 'config':
        showConfig();
        break;
      case 'set':
        if (args.length >= 2) {
          setConfig(args[0], args.slice(1).join(' '));
        } else {
          console.log(red('Usage: set <key> <value>'));
        }
        break;
      case 'dashboard':
      case 'dash':
        startDashboard();
        break;

      // Portfolio
      case 'portfolio':
      case 'p':
        showPortfolioSummary();
        break;
      case 'positions':
      case 'pos':
        showPositions();
        break;
      case 'orders':
        showOrders();
        break;
      case 'equity':
        showEquityCurve();
        break;
      case 'risk':
        showRiskExposure();
        break;

      // Trading
      case 'buy':
        if (args.length >= 3) {
          await buyMarket(args[0], args[1], parseFloat(args[2]));
        } else {
          console.log(red('Usage: buy <marketId> <outcome> <size>'));
        }
        break;
      case 'sell':
        if (args.length >= 3) {
          await sellMarket(args[0], args[1], parseFloat(args[2]));
        } else {
          console.log(red('Usage: sell <marketId> <outcome> <size>'));
        }
        break;
      case 'cancel':
        if (args.length >= 1) {
          await cancelOrder(args[0]);
        } else {
          console.log(red('Usage: cancel <orderId>'));
        }
        break;
      case 'cancel-all':
        await cancelAllOrders();
        break;
      case 'close':
        if (args.length >= 2) {
          await closePosition(args[0], args[1]);
        } else {
          console.log(red('Usage: close <marketId> <outcome>'));
        }
        break;
      case 'close-all':
        await closeAllPositions();
        break;
      case 'halt':
        haltTrading();
        break;
      case 'resume':
        resumeTrading();
        break;

      // Markets
      case 'watch':
        if (args.length >= 1) {
          watchMarket(args[0]);
        } else {
          console.log(red('Usage: watch <marketId>'));
        }
        break;
      case 'unwatch':
        if (args.length >= 1) {
          unwatchMarket(args[0]);
        } else {
          console.log(red('Usage: unwatch <marketId>'));
        }
        break;
      case 'markets':
        showWatchedMarkets();
        break;
      case 'price':
        if (args.length >= 1) {
          showMarketPrice(args[0]);
        } else {
          console.log(red('Usage: price <marketId>'));
        }
        break;

      // Strategies
      case 'strategies':
      case 'strats':
        listStrategies();
        break;
      case 'strategy':
      case 'strat':
        if (args.length >= 1) {
          showStrategyDetails(args[0]);
        } else {
          console.log(red('Usage: strategy <strategyId>'));
        }
        break;
      case 'signals':
        listAvailableSignals();
        break;
      case 'create-momentum':
        createMomentumStrategy();
        break;
      case 'create-meanrev':
        createMeanReversionStrategy();
        break;
      case 'create-combo':
        createComboStrategy();
        break;
      case 'start-strat':
        if (args.length >= 1) {
          startStrategy(args[0]);
        } else {
          console.log(red('Usage: start-strat <strategyId>'));
        }
        break;
      case 'stop-strat':
        if (args.length >= 1) {
          stopStrategy(args[0]);
        } else {
          console.log(red('Usage: stop-strat <strategyId>'));
        }
        break;
      case 'delete-strat':
        if (args.length >= 1) {
          deleteStrategy(args[0]);
        } else {
          console.log(red('Usage: delete-strat <strategyId>'));
        }
        break;

      // Alerts
      case 'alerts':
        showAlerts(args.length > 0 ? parseInt(args[0]) : 10);
        break;
      case 'clear-alerts':
        clearAlerts();
        break;

      // Other
      case 'help':
      case 'h':
      case '?':
        showHelp();
        break;
      case 'clear':
      case 'cls':
        console.clear();
        break;
      case 'quit':
      case 'exit':
      case 'q':
        const ctx = getContext();
        if (ctx.system && ctx.isRunning) {
          console.log(dim('Stopping system...'));
          ctx.system.stop();
        }
        console.log(dim('Goodbye!'));
        return false;

      default:
        console.log(red(`Unknown command: ${cmd}`));
        console.log(dim('Type "help" for available commands'));
        console.log();
    }
  } catch (error) {
    console.log(red(`Error: ${error}`));
    console.log();
  }

  return true;
}

// ============================================
// REPL
// ============================================

async function startRepl(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: cyan('trader> '),
  });

  showBanner();
  console.log(dim('Type "help" for available commands, "quit" to exit\n'));

  rl.prompt();

  rl.on('line', async (line) => {
    const shouldContinue = await executeCommand(line);
    if (shouldContinue) {
      rl.prompt();
    } else {
      rl.close();
    }
  });

  rl.on('close', () => {
    process.exit(0);
  });
}

// ============================================
// Main
// ============================================

async function main(): Promise<void> {
  // Check for command line arguments
  const args = process.argv.slice(2);

  if (args.length > 0) {
    // Execute single command
    await executeCommand(args.join(' '));
  } else {
    // Start interactive REPL
    await startRepl();
  }
}

main().catch((error) => {
  console.error(red(`Fatal error: ${error}`));
  process.exit(1);
});
