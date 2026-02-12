const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function cleanup() {
  console.log('=== LIMPIEZA DE DATOS INFLADOS ===\n');

  // 1. Count inflated trades
  const inflated = await pool.query(`
    SELECT COUNT(*) as count, SUM(value_usd) as value
    FROM paper_trades
    WHERE executed_size = 663 AND executed_price BETWEEN 0.88 AND 0.89 AND side = 'sell'
  `);
  console.log('Trades duplicados encontrados:', inflated.rows[0].count);
  console.log('Valor total inflado: $' + parseFloat(inflated.rows[0].value || 0).toFixed(2));

  // Keep only the first sell trade, delete the rest
  const first = await pool.query(`
    SELECT id FROM paper_trades
    WHERE executed_size = 663 AND executed_price BETWEEN 0.88 AND 0.89 AND side = 'sell'
    ORDER BY time ASC
    LIMIT 1
  `);

  if (first.rows.length > 0) {
    const firstId = first.rows[0].id;
    console.log('\nManteniendo primer trade ID:', firstId);

    // Delete duplicates (all except the first)
    const deleted = await pool.query(`
      DELETE FROM paper_trades
      WHERE executed_size = 663
        AND executed_price BETWEEN 0.88 AND 0.89
        AND side = 'sell'
        AND id != $1
      RETURNING id
    `, [firstId]);
    console.log('Trades duplicados eliminados:', deleted.rowCount);

    // Calculate the amount to subtract from account
    const valuePerTrade = 663 * 0.8804;
    const feePerTrade = valuePerTrade * 0.001;
    const subtractValue = deleted.rowCount * (valuePerTrade - feePerTrade);
    const subtractFees = deleted.rowCount * feePerTrade;
    const pnlPerTrade = (0.8804 - 0.1196) * 663 - feePerTrade; // ~503
    const subtractPnl = deleted.rowCount * pnlPerTrade;

    console.log('\n=== CORRIGIENDO CUENTA ===');
    console.log('Restando capital: $' + subtractValue.toFixed(2));
    console.log('Restando fees: $' + subtractFees.toFixed(2));
    console.log('Restando PnL: $' + subtractPnl.toFixed(2));
    console.log('Restando trades:', deleted.rowCount);
    console.log('Restando wins:', deleted.rowCount);

    // Update account
    await pool.query(`
      UPDATE paper_account SET
        current_capital = current_capital - $1,
        available_capital = available_capital - $1,
        total_fees_paid = total_fees_paid - $2,
        total_realized_pnl = total_realized_pnl - $3,
        total_trades = total_trades - $4,
        winning_trades = winning_trades - $4,
        updated_at = NOW()
      WHERE id = 1
    `, [subtractValue, subtractFees, subtractPnl, deleted.rowCount]);
    console.log('Cuenta actualizada.');
  }

  // 2. Close the position properly
  console.log('\n=== CERRANDO POSICIÓN ===');
  const closePos = await pool.query(`
    UPDATE paper_positions
    SET closed_at = NOW(), size = 0, realized_pnl = 503.50
    WHERE market_id LIKE '0x1abcad%' AND closed_at IS NULL
    RETURNING market_id
  `);
  console.log('Posiciones cerradas:', closePos.rowCount);

  // 3. Show corrected account
  const account = await pool.query('SELECT * FROM paper_account LIMIT 1');
  const a = account.rows[0];
  console.log('\n=== CUENTA CORREGIDA ===');
  console.log('Capital:', '$' + parseFloat(a.current_capital).toFixed(2));
  console.log('PnL realizado:', '$' + parseFloat(a.total_realized_pnl).toFixed(2));
  console.log('Total trades:', a.total_trades);
  console.log('Wins:', a.winning_trades, '| Losses:', a.losing_trades);

  await pool.end();
}

cleanup().catch(e => console.error('Error:', e.message));
