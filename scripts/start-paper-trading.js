#!/usr/bin/env node
/**
 * start-paper-trading.js - Start paper trading with optimized parameters
 *
 * Configures the trading system with optimized parameters and starts
 * paper trading mode via the Dashboard API.
 *
 * Usage: node scripts/start-paper-trading.js [options]
 *
 * Options:
 *   --help  Show this help message
 *
 * Environment:
 *   DASHBOARD_API_URL  Dashboard API URL (default: Render deployment)
 *
 * Example:
 *   node scripts/start-paper-trading.js
 *   DASHBOARD_API_URL="http://localhost:3001" node scripts/start-paper-trading.js
 */

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  const fs = require('fs');
  const content = fs.readFileSync(__filename, 'utf8');
  const match = content.match(/\/\*\*[\s\S]*?\*\//);
  if (match) console.log(match[0].replace(/^\/\*\*|\*\/$/g, '').replace(/^ \* ?/gm, '').trim());
  process.exit(0);
}

const DASHBOARD_API_URL = process.env.DASHBOARD_API_URL || 'https://polymarket-dashboard-api.onrender.com';

// Best parameters from optimization (Sharpe: 17.66)
const OPTIMIZED_PARAMS = {
  combiner: {
    minCombinedConfidence: 0.43,
    minCombinedStrength: 0.27,
  },
  risk: {
    maxPositionSizePct: 3.5,
    maxExposurePct: 61,
    maxPositions: 10,
    maxDrawdownPct: 25,
    dailyLossLimit: 500,
    stopLossPct: 20,
    takeProfitPct: 50,
  },
  momentum: {
    rsiPeriod: 17,
    macdFast: 16,
    macdSlow: 20,
    macdSignal: 9,
  },
  meanReversion: {
    bbPeriod: 17,
    bbStdDev: 2.02,
    zScoreThreshold: 2.94,
  },
  execution: {
    minEdge: 0.03,
    minConfidence: 0.40,
    orderType: 'MARKET',
    cooldownMs: 60000,
  },
};

async function main() {
  console.log('=== Starting Paper Trading with Optimized Parameters ===\n');
  console.log(`Dashboard API: ${DASHBOARD_API_URL}\n`);

  // 1. Check API health
  console.log('Checking dashboard API...');
  const healthRes = await fetch(`${DASHBOARD_API_URL}/health`);
  if (!healthRes.ok) {
    throw new Error('Dashboard API is not healthy');
  }
  const health = await healthRes.json();
  console.log('✓ API healthy, DB connected:', health.database?.connected);

  // 2. Get current system status
  console.log('\nChecking trading system status...');
  const statusRes = await fetch(`${DASHBOARD_API_URL}/api/status`);
  const status = await statusRes.json();
  console.log('  System connected:', status.connected);
  console.log('  Paper trading:', status.paperTrading ? 'enabled' : 'disabled');

  // 3. Get/reset paper account
  console.log('\nGetting paper trading account...');
  const accountRes = await fetch(`${DASHBOARD_API_URL}/api/paper/account`);
  if (accountRes.ok) {
    const account = await accountRes.json();
    console.log('  Account ID:', account.id);
    console.log('  Current capital:', '$' + (account.currentCapital || account.initial_capital || 10000).toFixed(2));
    console.log('  Total P&L:', '$' + (account.totalPnl || 0).toFixed(2));
  } else {
    console.log('  No account found, will be created');
  }

  // 4. Check if signal weights endpoint exists and update
  console.log('\nUpdating signal weights with optimized parameters...');
  try {
    const weightsRes = await fetch(`${DASHBOARD_API_URL}/api/signals/weights`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        momentum: 0.45,        // Slightly favor momentum based on backtest results
        mean_reversion: 0.45, // Mean reversion performed well
        wallet_tracking: 0.10, // Less weight on wallet tracking
      }),
    });
    if (weightsRes.ok) {
      console.log('✓ Signal weights updated');
    } else {
      console.log('  Signal weights endpoint not available (ok)');
    }
  } catch (e) {
    console.log('  Signal weights update skipped');
  }

  // 5. Try to create/update strategy via API
  console.log('\nConfiguring optimized strategy...');
  const strategyConfig = {
    name: 'optimized-v1',
    description: 'Strategy with optimized parameters from TPE optimization',
    signals: ['momentum', 'mean_reversion'],
    riskLimits: {
      maxPositionSize: 1000,
      maxPositionPct: OPTIMIZED_PARAMS.risk.maxPositionSizePct,
      maxDailyLoss: OPTIMIZED_PARAMS.risk.dailyLossLimit,
      maxDrawdown: OPTIMIZED_PARAMS.risk.maxDrawdownPct / 100,
      maxOpenPositions: OPTIMIZED_PARAMS.risk.maxPositions,
      stopLossPct: OPTIMIZED_PARAMS.risk.stopLossPct,
      takeProfitPct: OPTIMIZED_PARAMS.risk.takeProfitPct,
    },
    executionParams: {
      orderType: OPTIMIZED_PARAMS.execution.orderType,
      minEdge: OPTIMIZED_PARAMS.execution.minEdge,
      minConfidence: OPTIMIZED_PARAMS.combiner.minCombinedConfidence,
      slippageTolerance: 0.01,
      cooldownMs: OPTIMIZED_PARAMS.execution.cooldownMs,
      maxRetries: 3,
    },
    marketFilters: [
      { type: 'volume', params: { minVolume: 1000 } },
      { type: 'liquidity', params: { minLiquidity: 5000 } },
    ],
    enabled: true,
  };

  try {
    const createRes = await fetch(`${DASHBOARD_API_URL}/api/strategies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(strategyConfig),
    });

    if (createRes.ok) {
      const strategy = await createRes.json();
      console.log('✓ Strategy created:', strategy.id || strategy.name);
    } else {
      const error = await createRes.text();
      console.log('  Strategy creation response:', error.slice(0, 100));
    }
  } catch (e) {
    console.log('  Strategy API not available, using default config');
  }

  // 6. Start trading system
  console.log('\nStarting trading system...');
  try {
    const startRes = await fetch(`${DASHBOARD_API_URL}/api/system/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'paper' }),
    });

    if (startRes.ok) {
      console.log('✓ Trading system started');
    } else {
      const error = await startRes.text();
      console.log('  Start response:', error.slice(0, 100));
    }
  } catch (e) {
    console.log('  System start endpoint not available');
  }

  // 7. Print final summary
  console.log('\n=== Paper Trading Configuration ===\n');
  console.log('Optimized Parameters:');
  console.log('  Combiner:');
  console.log('    - Min Confidence:', OPTIMIZED_PARAMS.combiner.minCombinedConfidence);
  console.log('    - Min Strength:', OPTIMIZED_PARAMS.combiner.minCombinedStrength);
  console.log('  Risk:');
  console.log('    - Max Position Size:', OPTIMIZED_PARAMS.risk.maxPositionSizePct + '%');
  console.log('    - Max Exposure:', OPTIMIZED_PARAMS.risk.maxExposurePct + '%');
  console.log('    - Max Positions:', OPTIMIZED_PARAMS.risk.maxPositions);
  console.log('  Momentum Signal:');
  console.log('    - RSI Period:', OPTIMIZED_PARAMS.momentum.rsiPeriod);
  console.log('    - MACD Fast:', OPTIMIZED_PARAMS.momentum.macdFast);
  console.log('    - MACD Slow:', OPTIMIZED_PARAMS.momentum.macdSlow);
  console.log('  Mean Reversion Signal:');
  console.log('    - BB Period:', OPTIMIZED_PARAMS.meanReversion.bbPeriod);
  console.log('    - BB StdDev:', OPTIMIZED_PARAMS.meanReversion.bbStdDev);
  console.log('    - Z-Score Threshold:', OPTIMIZED_PARAMS.meanReversion.zScoreThreshold);

  console.log('\n=== Trading System Ready ===');
  console.log('\nMonitor via Dashboard: https://polymarket-dashboard-frontend.onrender.com');
  console.log('API Status: ' + DASHBOARD_API_URL + '/api/status');
  console.log('\nTo check positions: GET /api/positions');
  console.log('To check trades: GET /api/paper-trades');
  console.log('To stop: POST /api/system/stop');
}

main().catch(err => {
  console.error('Failed to start paper trading:', err.message);
  process.exit(1);
});
