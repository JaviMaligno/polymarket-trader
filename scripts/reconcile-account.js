const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function reconcile() {
  console.log('=== RECONCILIACIÓN DE CUENTA ===\n');

  // Get account state
  const account = await pool.query('SELECT * FROM paper_account LIMIT 1');
  const a = account.rows[0];

  console.log('=== ESTADO CUENTA (DB) ===');
  console.log('initial_capital:', parseFloat(a.initial_capital).toFixed(2));
  console.log('current_capital:', parseFloat(a.current_capital).toFixed(2));
  console.log('available_capital:', parseFloat(a.available_capital).toFixed(2));
  console.log('total_realized_pnl:', parseFloat(a.total_realized_pnl).toFixed(2));
  console.log('total_unrealized_pnl:', parseFloat(a.total_unrealized_pnl).toFixed(2));
  console.log('total_fees_paid:', parseFloat(a.total_fees_paid).toFixed(2));
  console.log('total_trades:', a.total_trades);

  // Calculate what capital SHOULD be based on trades
  console.log('\n=== CÁLCULO DESDE TRADES ===');

  // All buys
  const buys = await pool.query("SELECT SUM(value_usd) as total, SUM(fee) as fees FROM paper_trades WHERE side = 'buy'");
  const totalBuys = parseFloat(buys.rows[0].total || 0);
  const buyFees = parseFloat(buys.rows[0].fees || 0);

  // All sells
  const sells = await pool.query("SELECT SUM(value_usd) as total, SUM(fee) as fees FROM paper_trades WHERE side = 'sell'");
  const totalSells = parseFloat(sells.rows[0].total || 0);
  const sellFees = parseFloat(sells.rows[0].fees || 0);

  console.log('Total compras:', '$' + totalBuys.toFixed(2));
  console.log('Total ventas:', '$' + totalSells.toFixed(2));
  console.log('Fees en compras:', '$' + buyFees.toFixed(2));
  console.log('Fees en ventas:', '$' + sellFees.toFixed(2));

  // Cash calculation
  const initial = 10000;
  const cashFromTrades = initial - totalBuys - buyFees + totalSells - sellFees;
  console.log('\nEfectivo calculado:', '$' + cashFromTrades.toFixed(2));
  console.log('(10000 - compras - buyFees + ventas - sellFees)');

  // Positions value
  const posValue = await pool.query('SELECT SUM(size * avg_entry_price) as value FROM paper_positions WHERE size > 0 AND closed_at IS NULL');
  const positionsValue = parseFloat(posValue.rows[0].value || 0);
  console.log('\nValor posiciones abiertas:', '$' + positionsValue.toFixed(2));

  // Expected total equity
  const expectedEquity = cashFromTrades + positionsValue;
  console.log('Equity esperada (efectivo + posiciones):', '$' + expectedEquity.toFixed(2));

  // Compare with DB
  const dbEquity = parseFloat(a.current_capital);
  console.log('\n=== COMPARACIÓN ===');
  console.log('Equity en DB:', '$' + dbEquity.toFixed(2));
  console.log('Equity calculada:', '$' + expectedEquity.toFixed(2));
  console.log('Diferencia:', '$' + (dbEquity - expectedEquity).toFixed(2));

  // Check if positions are double-counted
  console.log('\n=== VERIFICACIÓN DOBLE CONTEO ===');
  console.log('available_capital (DB):', '$' + parseFloat(a.available_capital).toFixed(2));
  console.log('Si available = cash:', '$' + cashFromTrades.toFixed(2));
  console.log('Si current = available + posiciones:', '$' + (parseFloat(a.available_capital) + positionsValue).toFixed(2));

  // The actual realized PnL should be: sum of (sell_price - buy_price) * shares for closed positions
  console.log('\n=== PNL REAL CALCULADO ===');
  const realizedPnl = await pool.query('SELECT SUM(realized_pnl) as total FROM paper_positions WHERE closed_at IS NOT NULL');
  console.log('PnL de posiciones cerradas:', '$' + parseFloat(realizedPnl.rows[0].total || 0).toFixed(2));

  // Count how money is distributed
  console.log('\n=== DISTRIBUCIÓN ACTUAL ===');
  const openPosValue = await pool.query('SELECT SUM(size * current_price) as value FROM paper_positions WHERE size > 0 AND closed_at IS NULL');
  console.log('Valor actual posiciones (a precio actual):', '$' + parseFloat(openPosValue.rows[0].value || 0).toFixed(2));

  await pool.end();
}

reconcile().catch(e => console.error('Error:', e.message));
