#!/usr/bin/env node
/**
 * Optimizer CLI Commands
 *
 * Usage:
 *   pnpm optimize --name "exp-1" --iterations 500 --metric sharpe
 *   pnpm optimize:results --run-id <uuid>
 *   pnpm optimize:compare --strategies "s1,s2"
 *   pnpm optimize:activate --strategy "s1" --mode paper
 *   pnpm optimize:status
 */

import { Command } from 'commander';
import pg from 'pg';
import { pino } from 'pino';
import { v4 as uuidv4 } from 'uuid';
import { StrategyOptimizer, type OptimizationConfig } from '../core/StrategyOptimizer.js';
import { OptimizationStore } from '../storage/OptimizationStore.js';
import { FULL_PARAMETER_SPACE, MINIMAL_PARAMETER_SPACE } from '../core/ParameterSpace.js';
import type { ObjectiveFunctionName } from '../core/ObjectiveFunctions.js';

const { Pool } = pg;

const logger = pino({
  name: 'optimizer-cli',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true },
  },
});

// ============================================
// Database Connection
// ============================================

function createDbPool(): pg.Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  return new Pool({
    connectionString,
    ssl: connectionString.includes('sslmode=require')
      ? { rejectUnauthorized: false }
      : false,
  });
}

// ============================================
// CLI Program
// ============================================

const program = new Command();

program
  .name('optimizer')
  .description('Strategy optimization CLI for Polymarket trading')
  .version('0.1.0');

// ============================================
// optimize command
// ============================================

program
  .command('run')
  .description('Run a new optimization')
  .requiredOption('-n, --name <name>', 'Name for this optimization run')
  .option('-d, --description <desc>', 'Description of the run')
  .option('-i, --iterations <n>', 'Number of iterations', '100')
  .option('-m, --metric <metric>', 'Objective metric (sharpe_ratio, calmar_ratio, total_return)', 'sharpe_ratio')
  .option('-o, --optimizer <type>', 'Optimizer type (tpe, cmaes, random)', 'tpe')
  .option('-p, --params <type>', 'Parameter space (full, minimal)', 'minimal')
  .option('--start-date <date>', 'Backtest start date (YYYY-MM-DD)')
  .option('--end-date <date>', 'Backtest end date (YYYY-MM-DD)')
  .option('--capital <amount>', 'Initial capital', '10000')
  .option('--exploration', 'Mark results as exploration (less important)', false)
  .option('--server <url>', 'Optimizer server URL', 'http://localhost:8000')
  .action(async (options) => {
    const db = createDbPool();

    try {
      const optimizer = new StrategyOptimizer({ url: options.server }, db);

      // Check server health
      const isHealthy = await optimizer.healthCheck();
      if (!isHealthy) {
        logger.error('Optimizer server is not healthy. Make sure it is running.');
        process.exit(1);
      }

      // Prepare config
      const startDate = options.startDate
        ? new Date(options.startDate)
        : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago

      const endDate = options.endDate
        ? new Date(options.endDate)
        : new Date();

      const config: OptimizationConfig = {
        name: options.name,
        description: options.description,
        iterations: parseInt(options.iterations, 10),
        optimizer: options.optimizer as 'tpe' | 'cmaes' | 'random',
        objective: {
          name: options.metric as ObjectiveFunctionName,
          minTrades: 10,
          maxAllowedDrawdown: 0.5,
        },
        parameterSpace: options.params as 'full' | 'minimal',
        backtest: {
          startDate,
          endDate,
          initialCapital: parseFloat(options.capital),
          granularityMinutes: 60,
        },
        isExploration: options.exploration,
      };

      logger.info({
        name: config.name,
        iterations: config.iterations,
        optimizer: config.optimizer,
        metric: config.objective.name,
        dateRange: `${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`,
      }, 'Starting optimization');

      // Note: In real usage, you would set a backtest runner here
      // optimizer.setBacktestRunner(runner);

      logger.warn('BacktestRunner not configured. This is a dry run showing configuration only.');
      logger.info({ config }, 'Optimization configuration prepared');

      // For actual run, uncomment:
      // const result = await optimizer.runOptimization(config);
      // logger.info({ result }, 'Optimization completed');

    } catch (error) {
      logger.error({ error }, 'Optimization failed');
      process.exit(1);
    } finally {
      await db.end();
    }
  });

// ============================================
// results command
// ============================================

program
  .command('results')
  .description('Show results for an optimization run')
  .requiredOption('-r, --run-id <id>', 'Optimization run ID')
  .option('-l, --limit <n>', 'Number of results to show', '20')
  .option('--best', 'Show only best results by score', false)
  .action(async (options) => {
    const db = createDbPool();

    try {
      const store = new OptimizationStore(db);

      // Get run info
      const run = await store.getRun(options.runId);
      if (!run) {
        logger.error({ runId: options.runId }, 'Run not found');
        process.exit(1);
      }

      logger.info({
        id: run.id,
        name: run.name,
        status: run.status,
        progress: `${run.completedIterations}/${run.totalIterations}`,
        bestScore: run.bestScore?.toFixed(4),
      }, 'Optimization run');

      // Get results
      const limit = parseInt(options.limit, 10);
      const results = options.best
        ? await store.getBestResults(run.id, limit)
        : await store.getResults(run.id, { limit });

      // Get stats
      const stats = await store.getResultStats(run.id);

      logger.info({
        totalResults: stats.count,
        avgScore: stats.avgScore.toFixed(4),
        maxScore: stats.maxScore.toFixed(4),
        avgReturn: (stats.avgReturn * 100).toFixed(2) + '%',
        avgSharpe: stats.avgSharpe.toFixed(2),
      }, 'Result statistics');

      // Print results table
      console.log('\nResults:');
      console.log('─'.repeat(80));
      console.log(
        'Iter'.padEnd(6) +
        'Score'.padEnd(10) +
        'Return'.padEnd(10) +
        'Sharpe'.padEnd(10) +
        'Drawdown'.padEnd(10) +
        'Trades'.padEnd(8)
      );
      console.log('─'.repeat(80));

      for (const result of results) {
        console.log(
          String(result.iteration).padEnd(6) +
          result.objectiveScore.toFixed(4).padEnd(10) +
          ((result.totalReturn * 100).toFixed(2) + '%').padEnd(10) +
          result.sharpeRatio.toFixed(2).padEnd(10) +
          ((result.maxDrawdown * 100).toFixed(2) + '%').padEnd(10) +
          String(result.totalTrades).padEnd(8)
        );
      }

      // Print best params if available
      if (run.bestParams) {
        console.log('\nBest Parameters:');
        console.log('─'.repeat(80));
        console.log(JSON.stringify(run.bestParams, null, 2));
      }

    } catch (error) {
      logger.error({ error }, 'Failed to fetch results');
      process.exit(1);
    } finally {
      await db.end();
    }
  });

// ============================================
// list command
// ============================================

program
  .command('list')
  .description('List optimization runs')
  .option('-s, --status <status>', 'Filter by status (pending, running, completed, failed, cancelled)')
  .option('-l, --limit <n>', 'Number of runs to show', '10')
  .action(async (options) => {
    const db = createDbPool();

    try {
      const store = new OptimizationStore(db);

      const runs = await store.listRuns({
        status: options.status,
        limit: parseInt(options.limit, 10),
      });

      if (runs.length === 0) {
        logger.info('No optimization runs found');
        return;
      }

      console.log('\nOptimization Runs:');
      console.log('─'.repeat(100));
      console.log(
        'ID'.padEnd(38) +
        'Name'.padEnd(20) +
        'Status'.padEnd(12) +
        'Progress'.padEnd(12) +
        'Best Score'.padEnd(12)
      );
      console.log('─'.repeat(100));

      for (const run of runs) {
        console.log(
          run.id.padEnd(38) +
          run.name.substring(0, 18).padEnd(20) +
          run.status.padEnd(12) +
          `${run.completedIterations}/${run.totalIterations}`.padEnd(12) +
          (run.bestScore?.toFixed(4) ?? 'N/A').padEnd(12)
        );
      }

    } catch (error) {
      logger.error({ error }, 'Failed to list runs');
      process.exit(1);
    } finally {
      await db.end();
    }
  });

// ============================================
// strategies command
// ============================================

program
  .command('strategies')
  .description('List saved strategies')
  .option('--active', 'Show only active strategies', false)
  .option('-m, --mode <mode>', 'Filter by mode (backtest, paper, live)')
  .action(async (options) => {
    const db = createDbPool();

    try {
      const store = new OptimizationStore(db);

      const strategies = await store.listStrategies({
        isActive: options.active ? true : undefined,
        mode: options.mode,
      });

      if (strategies.length === 0) {
        logger.info('No saved strategies found');
        return;
      }

      console.log('\nSaved Strategies:');
      console.log('─'.repeat(100));
      console.log(
        'Name'.padEnd(25) +
        'Mode'.padEnd(10) +
        'Active'.padEnd(8) +
        'WF Passed'.padEnd(12) +
        'Return'.padEnd(12) +
        'Sharpe'.padEnd(10)
      );
      console.log('─'.repeat(100));

      for (const strategy of strategies) {
        const metrics = strategy.backtestMetrics;
        console.log(
          strategy.name.substring(0, 23).padEnd(25) +
          strategy.mode.padEnd(10) +
          (strategy.isActive ? 'Yes' : 'No').padEnd(8) +
          (strategy.walkForwardPassed ? 'Yes' : 'No').padEnd(12) +
          ((metrics.totalReturn * 100).toFixed(2) + '%').padEnd(12) +
          metrics.sharpeRatio.toFixed(2).padEnd(10)
        );
      }

    } catch (error) {
      logger.error({ error }, 'Failed to list strategies');
      process.exit(1);
    } finally {
      await db.end();
    }
  });

// ============================================
// activate command
// ============================================

program
  .command('activate')
  .description('Activate a saved strategy')
  .requiredOption('-s, --strategy <name>', 'Strategy name')
  .requiredOption('-m, --mode <mode>', 'Mode (backtest, paper, live)')
  .action(async (options) => {
    const db = createDbPool();

    try {
      const store = new OptimizationStore(db);

      // Find strategy by name
      const strategy = await store.getStrategyByName(options.strategy);
      if (!strategy) {
        logger.error({ name: options.strategy }, 'Strategy not found');
        process.exit(1);
      }

      // Safety check for live mode
      if (options.mode === 'live') {
        logger.error('Live mode activation is disabled for safety. Use paper mode first.');
        process.exit(1);
      }

      // Activate
      const updated = await store.activateStrategy(strategy.id, options.mode);
      if (!updated) {
        logger.error('Failed to activate strategy');
        process.exit(1);
      }

      logger.info({
        name: strategy.name,
        mode: options.mode,
      }, 'Strategy activated');

    } catch (error) {
      logger.error({ error }, 'Failed to activate strategy');
      process.exit(1);
    } finally {
      await db.end();
    }
  });

// ============================================
// save command
// ============================================

program
  .command('save')
  .description('Save best params from a run as a strategy')
  .requiredOption('-r, --run-id <id>', 'Optimization run ID')
  .requiredOption('-n, --name <name>', 'Strategy name')
  .option('-d, --description <desc>', 'Strategy description')
  .action(async (options) => {
    const db = createDbPool();

    try {
      const store = new OptimizationStore(db);

      // Get run
      const run = await store.getRun(options.runId);
      if (!run) {
        logger.error({ runId: options.runId }, 'Run not found');
        process.exit(1);
      }

      if (!run.bestParams || run.bestScore === null) {
        logger.error('Run has no best parameters yet');
        process.exit(1);
      }

      // Check if name already exists
      const existing = await store.getStrategyByName(options.name);
      if (existing) {
        logger.error({ name: options.name }, 'Strategy name already exists');
        process.exit(1);
      }

      // Get stats for the best result
      const bestResults = await store.getBestResults(run.id, 1);
      const bestResult = bestResults[0];

      // Save strategy
      const strategy = await store.saveStrategy({
        id: uuidv4(),
        name: options.name,
        description: options.description || `Saved from run: ${run.name}`,
        params: run.bestParams,
        backtestMetrics: {
          totalReturn: bestResult.totalReturn,
          sharpeRatio: bestResult.sharpeRatio,
          maxDrawdown: bestResult.maxDrawdown,
          winRate: bestResult.winRate,
          profitFactor: bestResult.profitFactor,
          totalTrades: bestResult.totalTrades,
          averageTradeReturn: 0,
          volatility: 0,
        },
        optimizationRunId: run.id,
        walkForwardPassed: false,
        validationMetrics: null,
        isActive: false,
        mode: 'backtest',
        activatedAt: null,
        deactivatedAt: null,
      });

      logger.info({
        id: strategy.id,
        name: strategy.name,
        score: run.bestScore,
      }, 'Strategy saved');

    } catch (error) {
      logger.error({ error }, 'Failed to save strategy');
      process.exit(1);
    } finally {
      await db.end();
    }
  });

// ============================================
// delete command
// ============================================

program
  .command('delete')
  .description('Delete an optimization run and its results')
  .requiredOption('-r, --run-id <id>', 'Optimization run ID')
  .option('--force', 'Skip confirmation', false)
  .action(async (options) => {
    const db = createDbPool();

    try {
      const store = new OptimizationStore(db);

      const run = await store.getRun(options.runId);
      if (!run) {
        logger.error({ runId: options.runId }, 'Run not found');
        process.exit(1);
      }

      if (!options.force) {
        logger.info({
          id: run.id,
          name: run.name,
          iterations: run.completedIterations,
        }, 'About to delete run. Use --force to confirm.');
        process.exit(0);
      }

      const deleted = await store.deleteRun(options.runId);
      if (deleted) {
        logger.info({ runId: options.runId }, 'Run deleted');
      } else {
        logger.error('Failed to delete run');
        process.exit(1);
      }

    } catch (error) {
      logger.error({ error }, 'Failed to delete run');
      process.exit(1);
    } finally {
      await db.end();
    }
  });

// ============================================
// status command
// ============================================

program
  .command('status')
  .description('Show current optimization status')
  .action(async () => {
    const db = createDbPool();

    try {
      const store = new OptimizationStore(db);

      // Get running optimizations
      const running = await store.listRuns({ status: 'running', limit: 5 });

      // Get active strategies
      const activeStrategies = await store.listStrategies({ isActive: true });

      // Get recent completed
      const completed = await store.listRuns({ status: 'completed', limit: 3 });

      console.log('\n=== Optimization Status ===\n');

      console.log('Running Optimizations:');
      if (running.length === 0) {
        console.log('  None');
      } else {
        for (const run of running) {
          console.log(`  - ${run.name}: ${run.completedIterations}/${run.totalIterations} iterations`);
        }
      }

      console.log('\nActive Strategies:');
      if (activeStrategies.length === 0) {
        console.log('  None');
      } else {
        for (const strategy of activeStrategies) {
          console.log(`  - ${strategy.name} (${strategy.mode}): ${(strategy.backtestMetrics.totalReturn * 100).toFixed(2)}% return`);
        }
      }

      console.log('\nRecent Completed Runs:');
      if (completed.length === 0) {
        console.log('  None');
      } else {
        for (const run of completed) {
          console.log(`  - ${run.name}: best score ${run.bestScore?.toFixed(4) ?? 'N/A'}`);
        }
      }

    } catch (error) {
      logger.error({ error }, 'Failed to get status');
      process.exit(1);
    } finally {
      await db.end();
    }
  });

// Parse and run
program.parse();
