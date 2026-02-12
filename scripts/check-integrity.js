const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  // Check all positions (including closed)
  const all = await pool.query('SELECT COUNT(*) as total, SUM(size * avg_entry_price) as value FROM paper_positions');
  console.log('=== TODAS LAS POSICIONES (incl. cerradas) ===');
  console.log('Total:', all.rows[0].total);
  console.log('Valor:', '$' + parseFloat(all.rows[0].value || 0).toFixed(2));

  // Closed positions
  const closed = await pool.query('SELECT COUNT(*) as total, SUM(realized_pnl) as pnl FROM paper_positions WHERE closed_at IS NOT NULL');
  console.log('\n=== POSICIONES CERRADAS ===');
  console.log('Total:', closed.rows[0].total);
  console.log('PnL realizado:', '$' + parseFloat(closed.rows[0].pnl || 0).toFixed(2));

  // Positions with size=0 but not closed
  const zombie = await pool.query('SELECT COUNT(*) as total FROM paper_positions WHERE size = 0 AND closed_at IS NULL');
  console.log('\n=== POSICIONES ZOMBIE (size=0, no cerradas) ===');
  console.log('Total:', zombie.rows[0].total);

  // Unique markets in trades vs positions
  const tradeMkts = await pool.query("SELECT COUNT(DISTINCT market_id) as count FROM paper_trades WHERE side = 'buy'");
  const posMkts = await pool.query('SELECT COUNT(DISTINCT market_id) as count FROM paper_positions');
  console.log('\n=== MERCADOS ÚNICOS ===');
  console.log('En trades (compras):', tradeMkts.rows[0].count);
  console.log('En posiciones:', posMkts.rows[0].count);

  // Sample of buy trades without corresponding position
  console.log('\n=== COMPRAS SIN POSICIÓN CORRESPONDIENTE ===');
  const orphan = await pool.query(`
    SELECT t.market_id, t.token_id, SUM(t.executed_size) as bought, SUM(t.value_usd) as value
    FROM paper_trades t
    LEFT JOIN paper_positions p ON t.market_id = p.market_id AND t.token_id = p.token_id
    WHERE t.side = 'buy' AND p.id IS NULL
    GROUP BY t.market_id, t.token_id
    ORDER BY SUM(t.value_usd) DESC
    LIMIT 10
  `);
  console.log('Top 10 compras huérfanas (sin posición):');
  orphan.rows.forEach(o => console.log('  ' + o.market_id?.slice(0,25) + '... | Valor: $' + parseFloat(o.value).toFixed(2)));

  // Total orphan value
  const orphanTotal = await pool.query(`
    SELECT COUNT(*) as count, SUM(t.value_usd) as value
    FROM paper_trades t
    LEFT JOIN paper_positions p ON t.market_id = p.market_id AND t.token_id = p.token_id
    WHERE t.side = 'buy' AND p.id IS NULL
  `);
  console.log('\nTotal compras huérfanas:', orphanTotal.rows[0].count);
  console.log('Valor perdido:', '$' + parseFloat(orphanTotal.rows[0].value || 0).toFixed(2));

  // Check if positions were created with different token_id
  console.log('\n=== ANÁLISIS DE TOKEN_ID MISMATCH ===');
  const mismatch = await pool.query(`
    SELECT
      t.market_id,
      t.token_id as trade_token,
      p.token_id as pos_token,
      t.value_usd
    FROM paper_trades t
    JOIN paper_positions p ON t.market_id = p.market_id
    WHERE t.side = 'buy' AND t.token_id != p.token_id
    LIMIT 5
  `);
  if (mismatch.rows.length > 0) {
    console.log('Trades con token_id diferente a posición:');
    mismatch.rows.forEach(m => {
      console.log('  Market:', m.market_id?.slice(0,20));
      console.log('    Trade token:', m.trade_token?.slice(0,20));
      console.log('    Position token:', m.pos_token?.slice(0,20));
    });
  } else {
    console.log('No se encontraron mismatches de token_id');
  }

  await pool.end();
}

check().catch(e => console.error('Error:', e.message));
