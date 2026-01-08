/**
 * Real Optimization Runner
 *
 * Connects the Optuna optimizer server with the BacktestEngine to run
 * real parameter optimization using historical market data.
 */

const pg = require('pg');

// Configuration
const OPTIMIZER_SERVER_URL = process.env.OPTIMIZER_SERVER_URL || 'https://polymarket-optimizer-server.onrender.com';
const DATABASE_URL = process.env.DATABASE_URL;
const ITERATIONS = parseInt(process.env.ITERATIONS || '20', 10);
const OPTIMIZATION_NAME = process.env.OPT_NAME || `opt-${Date.now()}`;

// Disable SSL verification for TimescaleDB
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function main() {
  console.log('=== Starting Real Optimization ===\n');
  console.log(`Optimizer Server: ${OPTIMIZER_SERVER_URL}`);
  console.log(`Iterations: ${ITERATIONS}`);
  console.log(`Name: ${OPTIMIZATION_NAME}\n`);

  // Connect to database
  const pool = new pg.Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    // 1. Check optimizer server health
    console.log('Checking optimizer server...');
    const healthRes = await fetch(`${OPTIMIZER_SERVER_URL}/health`);
    if (!healthRes.ok) {
      throw new Error('Optimizer server is not healthy');
    }
    console.log('✓ Optimizer server healthy\n');

    // 2. Load market data from database
    console.log('Loading market data...');
    const marketData = await loadMarketData(pool);
    console.log(`✓ Loaded ${marketData.length} price bars across ${new Set(marketData.map(m => m.marketId)).size} markets\n`);

    if (marketData.length < 100) {
      throw new Error('Insufficient market data for optimization');
    }

    // 3. Define parameter space (minimal for faster optimization)
    const parameters = [
      // Combiner parameters
      { name: 'combiner_minCombinedConfidence', type: 'float', low: 0.1, high: 0.5 },
      { name: 'combiner_minCombinedStrength', type: 'float', low: 0.05, high: 0.3 },
      // Risk parameters
      { name: 'risk_maxPositionSizePct', type: 'float', low: 1, high: 10 },
      { name: 'risk_maxExposurePct', type: 'float', low: 30, high: 90 },
      // Momentum signal parameters
      { name: 'momentum_rsiPeriod', type: 'int', low: 7, high: 21 },
      { name: 'momentum_macdFast', type: 'int', low: 8, high: 16 },
      { name: 'momentum_macdSlow', type: 'int', low: 20, high: 30 },
      // Mean reversion parameters
      { name: 'meanReversion_bbPeriod', type: 'int', low: 14, high: 28 },
      { name: 'meanReversion_bbStdDev', type: 'float', low: 1.5, high: 2.5 },
      { name: 'meanReversion_zScoreThreshold', type: 'float', low: 1.5, high: 3.0 },
    ];

    // 4. Create optimizer session
    console.log('Creating optimizer session...');
    const createRes = await fetch(`${OPTIMIZER_SERVER_URL}/optimizer/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: OPTIMIZATION_NAME,
        optimizer_type: 'tpe',
        parameters,
      }),
    });

    if (!createRes.ok) {
      const error = await createRes.text();
      throw new Error(`Failed to create optimizer: ${error}`);
    }

    const { optimizer_id } = await createRes.json();
    console.log(`✓ Optimizer created: ${optimizer_id}\n`);

    // 5. Run optimization loop
    console.log('Starting optimization loop...\n');
    console.log('Iter | Score    | Return   | Sharpe | Trades | Best Score');
    console.log('-----|----------|----------|--------|--------|----------');

    let bestScore = -Infinity;
    let bestParams = null;

    for (let i = 0; i < ITERATIONS; i++) {
      // Get parameter suggestion
      const suggestRes = await fetch(`${OPTIMIZER_SERVER_URL}/optimizer/suggest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ optimizer_id }),
      });

      if (!suggestRes.ok) {
        console.error(`Iteration ${i + 1}: Failed to get suggestion`);
        continue;
      }

      const { trial_ids, suggestions } = await suggestRes.json();
      const trialId = trial_ids[0];
      const params = suggestions[0];

      // Run backtest with suggested parameters
      const result = await runBacktest(marketData, params);

      // Calculate objective score (Sharpe ratio with penalties)
      let score = result.sharpeRatio;

      // Penalize low trade count
      if (result.totalTrades < 5) {
        score = score * 0.5;
      }

      // Penalize high drawdown
      if (result.maxDrawdown > 0.3) {
        score = score * (1 - result.maxDrawdown);
      }

      // Penalize very few trades (likely luck)
      if (result.totalTrades < 3) {
        score = -1000; // Reject single-trade results
      }

      // Report result to optimizer
      const reportRes = await fetch(`${OPTIMIZER_SERVER_URL}/optimizer/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          optimizer_id,
          trial_id: trialId,
          score,
          metrics: {
            totalReturn: result.totalReturn,
            sharpeRatio: result.sharpeRatio,
            maxDrawdown: result.maxDrawdown,
            totalTrades: result.totalTrades,
            winRate: result.winRate,
          },
        }),
      });

      const reportData = await reportRes.json();

      if (score > bestScore) {
        bestScore = score;
        bestParams = params;
      }

      // Log progress
      console.log(
        `${String(i + 1).padStart(4)} | ` +
        `${score.toFixed(4).padStart(8)} | ` +
        `${(result.totalReturn * 100).toFixed(2).padStart(6)}% | ` +
        `${result.sharpeRatio.toFixed(2).padStart(6)} | ` +
        `${String(result.totalTrades).padStart(6)} | ` +
        `${bestScore.toFixed(4)}`
      );
    }

    // 6. Get final best results
    console.log('\n=== Optimization Complete ===\n');

    const bestRes = await fetch(`${OPTIMIZER_SERVER_URL}/optimizer/${optimizer_id}/best`);
    const finalBest = await bestRes.json();

    console.log('Best Score:', finalBest.best_score?.toFixed(4) || 'N/A');
    console.log('Total Trials:', finalBest.n_trials);
    console.log('\nBest Parameters:');
    console.log(JSON.stringify(finalBest.best_params, null, 2));

    // 7. Save results to database
    console.log('\nSaving optimization results to database...');
    await saveOptimizationResults(pool, optimizer_id, OPTIMIZATION_NAME, finalBest);
    console.log('✓ Results saved\n');

  } finally {
    await pool.end();
  }
}

/**
 * Load market data from database
 */
async function loadMarketData(pool) {
  // Get date range (last 30 days)
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

  const result = await pool.query(`
    SELECT
      ph.market_id as "marketId",
      m.question,
      ph.time,
      ph.open,
      ph.high,
      ph.low,
      ph.close,
      ph.volume,
      ph.bid,
      ph.ask
    FROM price_history ph
    JOIN markets m ON ph.market_id = m.id
    WHERE ph.time >= $1 AND ph.time <= $2
    ORDER BY ph.market_id, ph.time
  `, [startDate, endDate]);

  return result.rows.map(row => ({
    marketId: row.marketId,
    question: row.question,
    time: new Date(row.time),
    open: parseFloat(row.open),
    high: parseFloat(row.high),
    low: parseFloat(row.low),
    close: parseFloat(row.close),
    volume: parseFloat(row.volume || 0),
    bid: parseFloat(row.bid || row.close),
    ask: parseFloat(row.ask || row.close),
  }));
}

/**
 * Run backtest with given parameters
 * This is a simplified backtest for optimization - not full engine
 */
async function runBacktest(marketData, params) {
  // Group data by market
  const marketGroups = {};
  for (const bar of marketData) {
    if (!marketGroups[bar.marketId]) {
      marketGroups[bar.marketId] = [];
    }
    marketGroups[bar.marketId].push(bar);
  }

  // Simple backtest simulation
  let capital = 10000;
  const initialCapital = capital;
  let maxCapital = capital;
  let minCapital = capital;
  const trades = [];
  let positions = {};

  const maxPositionSize = capital * (params.risk_maxPositionSizePct / 100);
  const minConfidence = params.combiner_minCombinedConfidence;
  const minStrength = params.combiner_minCombinedStrength;

  // Process each market
  for (const [marketId, bars] of Object.entries(marketGroups)) {
    if (bars.length < Math.max(params.momentum_rsiPeriod || 14, params.meanReversion_bbPeriod || 20) + 5) {
      continue; // Not enough data for indicators
    }

    // Calculate simple signals
    for (let i = 20; i < bars.length - 1; i++) {
      const window = bars.slice(i - 20, i + 1);
      const closes = window.map(b => b.close);
      const currentPrice = closes[closes.length - 1];
      const nextBar = bars[i + 1];

      // Skip extreme prices
      if (currentPrice < 0.05 || currentPrice > 0.95) continue;

      // Simple mean reversion signal
      const mean = closes.reduce((a, b) => a + b, 0) / closes.length;
      const std = Math.sqrt(closes.reduce((a, b) => a + (b - mean) ** 2, 0) / closes.length);
      const zScore = std > 0 ? (currentPrice - mean) / std : 0;

      // Simple momentum signal (price change)
      const priceChange = (currentPrice - closes[0]) / closes[0];

      // Combined signal
      let signal = 0;
      let confidence = 0;

      // Mean reversion component
      if (Math.abs(zScore) > (params.meanReversion_zScoreThreshold || 2)) {
        signal -= Math.sign(zScore) * 0.5; // Contrarian
        confidence += 0.3;
      }

      // Momentum component (trend following)
      if (Math.abs(priceChange) > 0.02) {
        signal += Math.sign(priceChange) * 0.3;
        confidence += 0.2;
      }

      // RSI-like overbought/oversold
      const gains = [];
      const losses = [];
      for (let j = 1; j < closes.length; j++) {
        const change = closes[j] - closes[j - 1];
        if (change > 0) gains.push(change);
        else losses.push(-change);
      }
      const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / gains.length : 0;
      const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
      const rs = avgLoss > 0 ? avgGain / avgLoss : 100;
      const rsi = 100 - (100 / (1 + rs));

      if (rsi > 70) {
        signal -= 0.2; // Overbought, expect down
        confidence += 0.15;
      } else if (rsi < 30) {
        signal += 0.2; // Oversold, expect up
        confidence += 0.15;
      }

      // Check thresholds
      if (Math.abs(signal) < minStrength || confidence < minConfidence) {
        continue;
      }

      // Skip if we already have a position in this market
      if (positions[marketId]) continue;

      // Determine trade direction (SHORT only strategy works better)
      const direction = signal < 0 ? 'SHORT' : 'LONG';

      // Calculate position size
      const positionSize = Math.min(maxPositionSize, capital * 0.1);
      if (positionSize < 10) continue; // Minimum position

      // Enter position
      const entryPrice = currentPrice;
      positions[marketId] = {
        direction,
        entryPrice,
        size: positionSize,
        entryTime: bars[i].time,
      };

      capital -= positionSize;

      // Simulate exit at next bar (simplified)
      const exitPrice = nextBar.close;
      let pnl = 0;

      if (direction === 'LONG') {
        pnl = positionSize * (exitPrice - entryPrice) / entryPrice;
      } else {
        pnl = positionSize * (entryPrice - exitPrice) / entryPrice;
      }

      // Apply fees
      pnl -= positionSize * 0.002; // 0.2% round-trip fees

      capital += positionSize + pnl;
      maxCapital = Math.max(maxCapital, capital);
      minCapital = Math.min(minCapital, capital);

      trades.push({
        marketId,
        direction,
        entryPrice,
        exitPrice,
        pnl,
        time: bars[i].time,
      });

      delete positions[marketId];
    }
  }

  // Calculate metrics
  const totalReturn = (capital - initialCapital) / initialCapital;
  const maxDrawdown = maxCapital > initialCapital
    ? (maxCapital - minCapital) / maxCapital
    : (initialCapital - minCapital) / initialCapital;

  const winningTrades = trades.filter(t => t.pnl > 0).length;
  const winRate = trades.length > 0 ? winningTrades / trades.length : 0;

  // Simple Sharpe approximation (annualized)
  const returns = trades.map(t => t.pnl / 10000); // Normalize returns
  const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const stdReturn = returns.length > 1
    ? Math.sqrt(returns.reduce((a, b) => a + (b - avgReturn) ** 2, 0) / (returns.length - 1))
    : 0.01;
  const sharpeRatio = stdReturn > 0 ? (avgReturn * Math.sqrt(252)) / stdReturn : 0;

  return {
    totalReturn,
    sharpeRatio,
    maxDrawdown,
    totalTrades: trades.length,
    winRate,
    finalCapital: capital,
  };
}

/**
 * Save optimization results to database
 */
async function saveOptimizationResults(pool, optimizerId, name, results) {
  const parameterSpace = {
    combiner: ['minCombinedConfidence', 'minCombinedStrength'],
    risk: ['maxPositionSizePct', 'maxExposurePct'],
    momentum: ['rsiPeriod', 'macdFast', 'macdSlow'],
    meanReversion: ['bbPeriod', 'bbStdDev', 'zScoreThreshold'],
  };

  // Date range (last 30 days)
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

  await pool.query(`
    INSERT INTO optimization_runs (
      id, name, status, optimizer_type, objective_metric, parameter_space,
      data_start_date, data_end_date, n_iterations, iterations_completed,
      best_score, best_params, created_at, started_at, completed_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW(), NOW())
    ON CONFLICT (id) DO UPDATE SET
      iterations_completed = $10,
      best_score = $11,
      best_params = $12,
      completed_at = NOW(),
      status = 'completed'
  `, [
    optimizerId,
    name,
    'completed',
    'tpe',
    'sharpe_ratio',
    JSON.stringify(parameterSpace),
    startDate,
    endDate,
    results.n_trials,
    results.n_trials,
    results.best_score,
    JSON.stringify(results.best_params),
  ]);
}

// Run
main().catch(err => {
  console.error('Optimization failed:', err.message);
  process.exit(1);
});
