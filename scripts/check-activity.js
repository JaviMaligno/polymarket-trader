const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  console.log('=== ESTADO ACTUAL ===\n');

  // Mercados totales
  const markets = await pool.query(`SELECT COUNT(*) as count FROM markets`);
  console.log('Total mercados:', markets.rows[0].count);

  // Mercados con precios recientes (activos)
  const active = await pool.query(`
    SELECT COUNT(DISTINCT market_id) as count
    FROM price_history
    WHERE time > NOW() - INTERVAL '1 day'
  `);
  console.log('Mercados con precios (24h):', active.rows[0].count);

  // Últimos precios recolectados
  const prices = await pool.query(`
    SELECT MAX(time) as latest, COUNT(*) as today
    FROM price_history
    WHERE time > NOW() - INTERVAL '1 day'
  `);
  console.log('Precios hoy:', prices.rows[0].today, '| Último:', prices.rows[0].latest);

  // Trades recientes
  const trades = await pool.query(`
    SELECT COUNT(*) as count, MAX(time) as latest
    FROM paper_trades
    WHERE time > NOW() - INTERVAL '1 day'
  `);
  console.log('Trades hoy:', trades.rows[0].count, '| Último:', trades.rows[0].latest);

  // Paper account
  const account = await pool.query(`SELECT * FROM paper_account LIMIT 1`);
  if (account.rows.length > 0) {
    const a = account.rows[0];
    const capital = parseFloat(a.current_capital);
    const initial = parseFloat(a.initial_capital);
    const pnlPct = ((capital / initial) - 1) * 100;
    console.log('\n=== CUENTA PAPER ===');
    console.log('Capital:', '$' + capital.toFixed(2), '(inicial: $' + initial.toFixed(2) + ')');
    console.log('Disponible:', '$' + parseFloat(a.available_capital).toFixed(2));
    console.log('PnL realizado:', '$' + parseFloat(a.total_realized_pnl).toFixed(2));
    console.log('PnL no realizado:', '$' + parseFloat(a.total_unrealized_pnl).toFixed(2));
    console.log('Rentabilidad:', pnlPct.toFixed(2) + '%');
    console.log('Max drawdown:', (parseFloat(a.max_drawdown) * 100).toFixed(2) + '%');
    console.log('Trades:', a.total_trades, '| Wins:', a.winning_trades, '| Losses:', a.losing_trades);
  }

  // Posiciones abiertas
  const positions = await pool.query(`
    SELECT COUNT(*) as count, SUM(size * avg_entry_price) as value
    FROM paper_positions
    WHERE size > 0
  `);
  console.log('\n=== POSICIONES ABIERTAS ===');
  console.log('Cantidad:', positions.rows[0].count);
  console.log('Valor:', '$' + parseFloat(positions.rows[0].value || 0).toFixed(2));

  // Señales por tipo (últimos trades)
  const signals = await pool.query(`
    SELECT signal_type, COUNT(*) as count
    FROM paper_trades
    WHERE time > NOW() - INTERVAL '24 hours'
    GROUP BY signal_type
    ORDER BY count DESC
  `);
  console.log('\n=== SEÑALES USADAS (24h) ===');
  if (signals.rows.length === 0) {
    console.log('(ningún trade todavía)');
  } else {
    signals.rows.forEach(s => console.log(' ', s.signal_type || 'unknown', ':', s.count));
  }

  await pool.end();
}
check().catch(e => console.error(e.message));
