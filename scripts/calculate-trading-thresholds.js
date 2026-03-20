// scripts/calculate-trading-thresholds.js
// Calculates initial min_balance_threshold and warning_balance_threshold
// from paper trading history.
//
// Usage: NODE_TLS_REJECT_UNAUTHORIZED=0 DATABASE_URL="..." node scripts/calculate-trading-thresholds.js

const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  // Average trade cost (executed_size * executed_price) for buy trades
  const avgCost = await pool.query(`
    SELECT
      AVG(value_usd) as avg_trade_cost,
      PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY value_usd) as p75_trade_cost,
      MAX(value_usd) as max_trade_cost,
      COUNT(*) as total_trades
    FROM paper_trades
    WHERE side = 'buy'
    AND time > NOW() - INTERVAL '14 days'
  `);

  // Average number of trades per day
  const dailyTrades = await pool.query(`
    SELECT
      AVG(daily_count) as avg_daily_trades,
      MAX(daily_count) as max_daily_trades
    FROM (
      SELECT DATE(time) as day, COUNT(*) as daily_count
      FROM paper_trades
      WHERE side = 'buy'
      AND time > NOW() - INTERVAL '14 days'
      GROUP BY DATE(time)
    ) daily
  `);

  // Average concurrent open positions
  const avgPositions = await pool.query(`
    SELECT
      AVG(size * avg_entry_price) as avg_position_value,
      COUNT(*) as current_open
    FROM paper_positions
    WHERE closed_at IS NULL
  `);

  const stats = avgCost.rows[0];
  const daily = dailyTrades.rows[0];
  const positions = avgPositions.rows[0];

  const avgTradeCost = parseFloat(stats.avg_trade_cost) || 50;
  const p75TradeCost = parseFloat(stats.p75_trade_cost) || 75;
  const avgDailyTrades = parseFloat(daily.avg_daily_trades) || 5;

  // min_balance = enough for 2-3 average trades (buffer to avoid constant degradation)
  const minBalance = Math.ceil(p75TradeCost * 3);
  // warning = enough for ~1 day of trading
  const warningBalance = Math.ceil(p75TradeCost * avgDailyTrades);

  console.log('=== Paper Trading Statistics (last 14 days) ===');
  console.log(`Total buy trades: ${stats.total_trades}`);
  console.log(`Average trade cost: $${parseFloat(stats.avg_trade_cost).toFixed(2)}`);
  console.log(`P75 trade cost: $${parseFloat(stats.p75_trade_cost).toFixed(2)}`);
  console.log(`Max trade cost: $${parseFloat(stats.max_trade_cost).toFixed(2)}`);
  console.log(`Average daily trades: ${parseFloat(daily.avg_daily_trades).toFixed(1)}`);
  console.log(`Max daily trades: ${daily.max_daily_trades}`);
  console.log(`Current open positions: ${positions.current_open}`);
  console.log(`Average position value: $${parseFloat(positions.avg_position_value || 0).toFixed(2)}`);
  console.log('');
  console.log('=== Recommended Thresholds ===');
  console.log(`min_balance_threshold: $${minBalance} (covers ~3 trades at P75 cost)`);
  console.log(`warning_balance_threshold: $${warningBalance} (covers ~1 day of trading)`);
  console.log('');
  console.log('To apply these thresholds:');
  console.log(`  curl -X POST http://localhost:3001/api/trading/mode -H "Content-Type: application/json" \\`);
  console.log(`    -d '{"min_balance_threshold": ${minBalance}, "warning_balance_threshold": ${warningBalance}}'`);

  await pool.end();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
