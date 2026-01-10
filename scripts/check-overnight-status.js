/**
 * Check system status after overnight run
 */
const { Pool } = require('pg');

async function check() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log('=== SYSTEM STATUS CHECK ===\n');

  // 1. Check paper account
  console.log('--- Paper Account ---');
  const account = await pool.query('SELECT * FROM paper_account LIMIT 1');
  if (account.rows.length > 0) {
    const a = account.rows[0];
    console.log('Initial capital:', a.initial_capital);
    console.log('Current capital:', a.current_capital);
    console.log('Available capital:', a.available_capital);
    console.log('Total trades:', a.total_trades);
    console.log('Total fees paid:', a.total_fees_paid);
    console.log('Last updated:', a.updated_at);
  }

  // 2. Check recent trades
  console.log('\n--- Recent Trades (last 24h) ---');
  const trades = await pool.query(`
    SELECT time, market_id, side, executed_size, executed_price, value_usd, signal_type
    FROM paper_trades
    WHERE time > NOW() - INTERVAL '24 hours'
    ORDER BY time DESC
    LIMIT 10
  `);
  console.log('Trades in last 24h:', trades.rows.length);
  trades.rows.forEach(t => {
    console.log(`  ${t.time.toISOString().substring(0,19)} | ${t.side} | $${parseFloat(t.value_usd).toFixed(2)} | ${t.signal_type || 'N/A'}`);
  });

  // 3. Check open positions
  console.log('\n--- Open Positions ---');
  const positions = await pool.query(`
    SELECT market_id, side, size, avg_entry_price, current_price, unrealized_pnl, signal_type
    FROM paper_positions
    WHERE closed_at IS NULL
  `);
  console.log('Open positions:', positions.rows.length);
  positions.rows.forEach(p => {
    const pnl = parseFloat(p.unrealized_pnl || 0);
    console.log(`  ${p.side} ${p.size} @ ${parseFloat(p.avg_entry_price).toFixed(4)} | PnL: $${pnl.toFixed(2)} | ${p.signal_type || 'N/A'}`);
  });

  // 4. Check signal predictions
  console.log('\n--- Recent Signal Predictions (last 24h) ---');
  const signals = await pool.query(`
    SELECT direction, COUNT(*) as count
    FROM signal_predictions
    WHERE time > NOW() - INTERVAL '24 hours'
    GROUP BY direction
  `);
  signals.rows.forEach(s => {
    console.log(`  ${s.direction}: ${s.count}`);
  });

  // 5. Check optimizations
  console.log('\n--- Recent Optimizations ---');
  const opts = await pool.query(`
    SELECT created_at, sharpe_ratio, total_return, win_rate, total_trades
    FROM optimization_results
    ORDER BY created_at DESC
    LIMIT 5
  `);
  console.log('Recent optimizations:', opts.rows.length);
  opts.rows.forEach(o => {
    console.log(`  ${o.created_at.toISOString().substring(0,19)} | Sharpe: ${parseFloat(o.sharpe_ratio || 0).toFixed(2)} | Return: ${(parseFloat(o.total_return || 0) * 100).toFixed(2)}% | WinRate: ${(parseFloat(o.win_rate || 0) * 100).toFixed(1)}%`);
  });

  // 6. Check price data collection
  console.log('\n--- Price Data Collection ---');
  const priceStats = await pool.query(`
    SELECT
      COUNT(*) as total_rows,
      COUNT(DISTINCT token_id) as tokens,
      MIN(time) as oldest,
      MAX(time) as newest
    FROM price_history
    WHERE time > NOW() - INTERVAL '24 hours'
  `);
  const ps = priceStats.rows[0];
  console.log('Price rows (24h):', ps.total_rows);
  console.log('Unique tokens:', ps.tokens);
  console.log('Newest data:', ps.newest);

  // 7. Check for errors in signal generation
  console.log('\n--- Signal Strength Distribution (last 24h) ---');
  const strengthDist = await pool.query(`
    SELECT
      CASE
        WHEN strength IS NULL OR strength = 'NaN' THEN 'NULL/NaN'
        WHEN ABS(strength::float) < 0.01 THEN '< 0.01 (very weak)'
        WHEN ABS(strength::float) < 0.05 THEN '0.01-0.05 (weak)'
        WHEN ABS(strength::float) < 0.1 THEN '0.05-0.1 (moderate)'
        ELSE '> 0.1 (strong)'
      END as strength_range,
      COUNT(*) as count
    FROM signal_predictions
    WHERE time > NOW() - INTERVAL '24 hours'
    GROUP BY strength_range
    ORDER BY count DESC
  `);
  strengthDist.rows.forEach(r => {
    console.log(`  ${r.strength_range}: ${r.count}`);
  });

  await pool.end();
}

check().catch(e => { console.error(e.message); process.exit(1); });
