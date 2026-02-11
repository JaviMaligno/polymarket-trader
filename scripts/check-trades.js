const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  // Últimos trades
  const trades = await pool.query(`
    SELECT time, side, executed_size, executed_price, value_usd, fee, signal_type, fill_type
    FROM paper_trades
    ORDER BY time DESC
    LIMIT 10
  `);
  console.log('=== ÚLTIMOS 10 TRADES ===');
  console.table(trades.rows.map(t => ({
    time: new Date(t.time).toISOString().slice(11, 19),
    side: t.side,
    size: parseFloat(t.executed_size).toFixed(2),
    price: parseFloat(t.executed_price).toFixed(4),
    value: '$' + parseFloat(t.value_usd || 0).toFixed(2),
    fee: parseFloat(t.fee || 0).toFixed(4),
    signal: t.signal_type,
    fill: t.fill_type
  })));

  // Resumen por hora de las últimas 6h
  const hourly = await pool.query(`
    SELECT
      date_trunc('hour', time) as hour,
      COUNT(*) as trades,
      SUM(value_usd) as total_value,
      SUM(fee) as total_fees
    FROM paper_trades
    WHERE time > NOW() - INTERVAL '6 hours'
    GROUP BY date_trunc('hour', time)
    ORDER BY hour DESC
  `);
  console.log('\n=== TRADES POR HORA (últimas 6h) ===');
  console.table(hourly.rows.map(h => ({
    hour: new Date(h.hour).toISOString().slice(11, 16),
    trades: h.trades,
    value: '$' + parseFloat(h.total_value || 0).toFixed(2),
    fees: '$' + parseFloat(h.total_fees || 0).toFixed(4)
  })));

  // Totales últimas 24h
  const stats24h = await pool.query(`
    SELECT COUNT(*) as total_trades, SUM(value_usd) as total_value, SUM(fee) as total_fees
    FROM paper_trades
    WHERE time > NOW() - INTERVAL '24 hours'
  `);
  console.log('\n=== ESTADÍSTICAS 24H ===');
  console.log('Trades:', stats24h.rows[0].total_trades);
  console.log('Valor total:', '$' + parseFloat(stats24h.rows[0].total_value || 0).toFixed(2));
  console.log('Fees pagados:', '$' + parseFloat(stats24h.rows[0].total_fees || 0).toFixed(2));

  // Signal types distribution
  const signals = await pool.query(`
    SELECT signal_type, COUNT(*) as count
    FROM paper_trades
    WHERE time > NOW() - INTERVAL '24 hours'
    GROUP BY signal_type
    ORDER BY count DESC
  `);
  console.log('\n=== SEÑALES USADAS (24h) ===');
  signals.rows.forEach(s => console.log(' ', s.signal_type || 'unknown', ':', s.count));

  await pool.end();
}
check().catch(e => console.error(e.message));
