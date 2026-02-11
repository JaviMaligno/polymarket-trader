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
    console.log('\n=== CUENTA PAPER ===');
    console.log('Balance:', '$' + parseFloat(a.balance).toFixed(2));
    console.log('Equity:', '$' + parseFloat(a.equity).toFixed(2));
    console.log('Trades totales:', a.total_trades);
    const pnl = ((a.equity / 10000) - 1) * 100;
    console.log('PnL total:', pnl.toFixed(2) + '%');
  }

  // Señales recientes
  const signals = await pool.query(`
    SELECT signal_type, COUNT(*) as count
    FROM signal_history
    WHERE time > NOW() - INTERVAL '1 hour'
    GROUP BY signal_type
    ORDER BY count DESC
    LIMIT 5
  `);
  console.log('\n=== SEÑALES ÚLTIMA HORA ===');
  if (signals.rows.length === 0) {
    console.log('(ninguna señal todavía)');
  } else {
    console.table(signals.rows);
  }

  // Trading config actual
  const config = await pool.query(`SELECT * FROM trading_config LIMIT 1`);
  if (config.rows.length > 0) {
    console.log('\n=== CONFIG TRADING ===');
    console.log('Auto-trade:', config.rows[0].auto_trade_enabled);
    console.log('Max position:', '$' + config.rows[0].max_position_size);
  }

  await pool.end();
}
check().catch(e => console.error(e.message));
