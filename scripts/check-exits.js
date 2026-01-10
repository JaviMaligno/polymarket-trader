const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  // Check closed positions
  const closed = await pool.query(`
    SELECT market_id, realized_pnl, closed_at, avg_entry_price, size
    FROM paper_positions
    WHERE closed_at IS NOT NULL
    ORDER BY closed_at DESC
    LIMIT 5
  `);
  console.log('=== POSICIONES CERRADAS ===');
  if (closed.rows.length === 0) {
    console.log('  No hay posiciones cerradas');
  } else {
    closed.rows.forEach(p => {
      console.log('  Market: ' + p.market_id.substring(0, 50) + '...');
      console.log('    P&L: $' + parseFloat(p.realized_pnl || 0).toFixed(2) + ', Shares: ' + parseFloat(p.size).toFixed(2));
      console.log('    Closed: ' + p.closed_at.toISOString());
    });
  }

  // Check SHORT signals today
  const shorts = await pool.query(`
    SELECT time, market_id, strength, confidence, price_at_signal
    FROM signal_predictions
    WHERE direction = 'short' AND time > NOW() - INTERVAL '2 hours'
    ORDER BY time DESC
    LIMIT 5
  `);
  console.log('\n=== SEÑALES SHORT (últimas 2h) ===');
  if (shorts.rows.length === 0) {
    console.log('  No hay señales SHORT recientes');
  } else {
    shorts.rows.forEach(s => {
      console.log('  ' + s.time.toISOString().substring(11,19) + ' | str:' + parseFloat(s.strength).toFixed(3) + ' | conf:' + parseFloat(s.confidence).toFixed(3) + ' | price:' + parseFloat(s.price_at_signal).toFixed(4));
    });
  }

  // Check recent trades (sells)
  const sells = await pool.query(`
    SELECT time, market_id, side, executed_size, executed_price, signal_type
    FROM paper_trades
    WHERE side = 'sell' AND time > NOW() - INTERVAL '2 hours'
    ORDER BY time DESC
    LIMIT 5
  `);
  console.log('\n=== VENTAS RECIENTES (últimas 2h) ===');
  if (sells.rows.length === 0) {
    console.log('  No hay ventas en las últimas 2 horas');
  } else {
    sells.rows.forEach(t => {
      console.log('  ' + t.time.toISOString().substring(11,19) + ' | ' + t.side + ' ' + parseFloat(t.executed_size).toFixed(2) + ' @ $' + parseFloat(t.executed_price).toFixed(4) + ' | ' + (t.signal_type || 'n/a'));
    });
  }

  // Account summary
  const acc = await pool.query('SELECT current_capital, total_realized_pnl, winning_trades, losing_trades FROM paper_account LIMIT 1');
  const a = acc.rows[0];
  console.log('\n=== CUENTA ===');
  console.log('  Capital: $' + parseFloat(a.current_capital).toFixed(2));
  console.log('  P&L Realizado: $' + parseFloat(a.total_realized_pnl || 0).toFixed(2));
  console.log('  Trades Win/Lose: ' + a.winning_trades + '/' + a.losing_trades);

  // Position count
  const posCount = await pool.query('SELECT COUNT(*) FILTER (WHERE closed_at IS NULL) as open, COUNT(*) FILTER (WHERE closed_at IS NOT NULL) as closed FROM paper_positions');
  const pc = posCount.rows[0];
  console.log('  Posiciones Abiertas: ' + pc.open + ', Cerradas: ' + pc.closed);

  await pool.end();
}
check().catch(e => { console.error(e.message); process.exit(1); });
