const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function fixBalance() {
  console.log('=== CORRECCIÓN DE BALANCE ===\n');

  // Calculate correct values from trades
  const buys = await pool.query("SELECT SUM(value_usd) as total, SUM(fee) as fees FROM paper_trades WHERE side = 'buy'");
  const sells = await pool.query("SELECT SUM(value_usd) as total, SUM(fee) as fees FROM paper_trades WHERE side = 'sell'");

  const totalBuys = parseFloat(buys.rows[0].total || 0);
  const buyFees = parseFloat(buys.rows[0].fees || 0);
  const totalSells = parseFloat(sells.rows[0].total || 0);
  const sellFees = parseFloat(sells.rows[0].fees || 0);
  const totalFees = buyFees + sellFees;

  // Cash = initial - buys - buyFees + sells - sellFees
  const initial = 10000;
  const cash = initial - totalBuys - buyFees + totalSells - sellFees;

  // Position values
  const posEntry = await pool.query('SELECT SUM(size * avg_entry_price) as value FROM paper_positions WHERE size > 0 AND closed_at IS NULL');
  const posCurrent = await pool.query('SELECT SUM(size * current_price) as value FROM paper_positions WHERE size > 0 AND closed_at IS NULL');

  const positionEntryValue = parseFloat(posEntry.rows[0].value || 0);
  const positionCurrentValue = parseFloat(posCurrent.rows[0].value || 0);
  const unrealizedPnl = positionCurrentValue - positionEntryValue;

  // Realized PnL from closed positions
  const realizedPnl = await pool.query('SELECT SUM(realized_pnl) as total FROM paper_positions WHERE closed_at IS NOT NULL');
  const totalRealizedPnl = parseFloat(realizedPnl.rows[0].total || 0);

  // Trade counts
  const tradeCounts = await pool.query('SELECT COUNT(*) as total FROM paper_trades');
  const winLoss = await pool.query(`
    SELECT
      SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) as losses
    FROM paper_positions WHERE closed_at IS NOT NULL
  `);

  // Calculate correct equity
  // Equity = cash + current value of positions
  const correctEquity = cash + positionCurrentValue;
  const correctAvailable = cash;

  console.log('=== VALORES CALCULADOS ===');
  console.log('Efectivo (cash):', '$' + cash.toFixed(2));
  console.log('Valor posiciones (entrada):', '$' + positionEntryValue.toFixed(2));
  console.log('Valor posiciones (actual):', '$' + positionCurrentValue.toFixed(2));
  console.log('PnL no realizado:', '$' + unrealizedPnl.toFixed(2));
  console.log('PnL realizado:', '$' + totalRealizedPnl.toFixed(2));
  console.log('Total fees:', '$' + totalFees.toFixed(2));
  console.log('');
  console.log('Equity correcta:', '$' + correctEquity.toFixed(2));
  console.log('Disponible correcto:', '$' + correctAvailable.toFixed(2));

  // Get current values
  const current = await pool.query('SELECT current_capital, available_capital FROM paper_account LIMIT 1');
  console.log('\n=== VALORES ACTUALES (INCORRECTOS) ===');
  console.log('current_capital:', '$' + parseFloat(current.rows[0].current_capital).toFixed(2));
  console.log('available_capital:', '$' + parseFloat(current.rows[0].available_capital).toFixed(2));

  // Update account
  console.log('\n=== ACTUALIZANDO CUENTA ===');
  await pool.query(`
    UPDATE paper_account SET
      current_capital = $1,
      available_capital = $2,
      total_realized_pnl = $3,
      total_unrealized_pnl = $4,
      total_fees_paid = $5,
      total_trades = $6,
      winning_trades = $7,
      losing_trades = $8,
      updated_at = NOW()
    WHERE id = 1
  `, [
    correctEquity,
    correctAvailable,
    totalRealizedPnl,
    unrealizedPnl,
    totalFees,
    parseInt(tradeCounts.rows[0].total),
    parseInt(winLoss.rows[0].wins || 0),
    parseInt(winLoss.rows[0].losses || 0)
  ]);

  // Verify
  const verify = await pool.query('SELECT * FROM paper_account LIMIT 1');
  const v = verify.rows[0];
  console.log('\n=== CUENTA CORREGIDA ===');
  console.log('current_capital:', '$' + parseFloat(v.current_capital).toFixed(2));
  console.log('available_capital:', '$' + parseFloat(v.available_capital).toFixed(2));
  console.log('total_realized_pnl:', '$' + parseFloat(v.total_realized_pnl).toFixed(2));
  console.log('total_unrealized_pnl:', '$' + parseFloat(v.total_unrealized_pnl).toFixed(2));
  console.log('total_fees_paid:', '$' + parseFloat(v.total_fees_paid).toFixed(2));
  console.log('total_trades:', v.total_trades);
  console.log('winning_trades:', v.winning_trades);
  console.log('losing_trades:', v.losing_trades);

  const pnlPct = ((parseFloat(v.current_capital) / initial) - 1) * 100;
  console.log('\nRentabilidad real:', pnlPct.toFixed(2) + '%');

  await pool.end();
}

fixBalance().catch(e => console.error('Error:', e.message));
