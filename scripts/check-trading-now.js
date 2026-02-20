const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  // Recent trades
  const trades = await pool.query(`
    SELECT time, market_id, side, executed_size, executed_price, value_usd, signal_type
    FROM paper_trades
    ORDER BY time DESC
    LIMIT 10
  `);

  console.log('=== RECENT TRADES ===');
  trades.rows.forEach(t => {
    const time = new Date(t.time).toLocaleTimeString('es-ES');
    const mktId = t.market_id.substring(0, 12);
    console.log(`${time} | ${t.side.padEnd(4)} | $${parseFloat(t.value_usd).toFixed(2).padStart(6)} | ${mktId} | ${t.signal_type || 'N/A'}`);
  });

  // Open positions
  const positions = await pool.query(`
    SELECT COUNT(*) as count FROM paper_positions WHERE closed_at IS NULL
  `);
  console.log(`\nOpen positions: ${positions.rows[0].count}`);

  // Account status
  const account = await pool.query(`
    SELECT current_capital, available_capital, total_realized_pnl,
           winning_trades, losing_trades
    FROM paper_account WHERE id = 1
  `);
  if (account.rows.length > 0) {
    const a = account.rows[0];
    console.log(`Capital: $${parseFloat(a.current_capital).toFixed(2)} | Available: $${parseFloat(a.available_capital).toFixed(2)}`);
    console.log(`Realized PnL: $${parseFloat(a.total_realized_pnl).toFixed(2)} | W/L: ${a.winning_trades}/${a.losing_trades}`);
  }

  // Check if trades are recent (within last 5 minutes)
  const recentTrades = await pool.query(`
    SELECT COUNT(*) as count FROM paper_trades WHERE time > NOW() - INTERVAL '5 minutes'
  `);
  console.log(`\nTrades in last 5 min: ${recentTrades.rows[0].count}`);

  await pool.end();
}

check().catch(e => { console.error(e); process.exit(1); });
