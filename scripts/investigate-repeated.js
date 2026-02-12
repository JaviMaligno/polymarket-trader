const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function investigate() {
  // 1. Check the repeated exit trades
  console.log('=== TRADES REPETIDOS (663 @ 0.88) ===');
  const repeated = await pool.query(`
    SELECT COUNT(*) as count, MIN(time) as first, MAX(time) as last
    FROM paper_trades
    WHERE executed_size = 663 AND executed_price BETWEEN 0.88 AND 0.89
  `);
  console.log('Total trades 663@0.88:', repeated.rows[0].count);
  console.log('Primero:', repeated.rows[0].first);
  console.log('Último:', repeated.rows[0].last);

  // 2. Check the market_id of these trades
  console.log('\n=== MARKET IDS DE ESTOS TRADES ===');
  const markets = await pool.query(`
    SELECT market_id, token_id, COUNT(*) as count
    FROM paper_trades
    WHERE executed_size = 663 AND executed_price BETWEEN 0.88 AND 0.89
    GROUP BY market_id, token_id
  `);
  markets.rows.forEach(m => console.log(m.market_id?.slice(0,40) + '...', '| count:', m.count));

  // 3. Check if position still exists for that market
  console.log('\n=== POSICIÓN ACTUAL DEL MERCADO ===');
  if (markets.rows.length > 0) {
    const pos = await pool.query(`
      SELECT market_id, token_id, side, size, avg_entry_price, unrealized_pnl
      FROM paper_positions
      WHERE market_id = $1
    `, [markets.rows[0].market_id]);
    if (pos.rows.length > 0) {
      pos.rows.forEach(p => {
        console.log('Market:', p.market_id?.slice(0,40));
        console.log('Size:', parseFloat(p.size).toFixed(2), '| Entry:', parseFloat(p.avg_entry_price).toFixed(4));
      });
    } else {
      console.log('(sin posición abierta)');
    }
  }

  // 4. Total value from these repeated trades
  console.log('\n=== VALOR DE TRADES REPETIDOS ===');
  const inflated = await pool.query(`
    SELECT SUM(value_usd) as total_value, SUM(fee) as total_fees, COUNT(*) as count
    FROM paper_trades
    WHERE executed_size = 663 AND executed_price BETWEEN 0.88 AND 0.89
  `);
  console.log('Trades repetidos:', inflated.rows[0].count);
  console.log('Valor total:', '$' + parseFloat(inflated.rows[0].total_value || 0).toFixed(2));
  console.log('Fees:', '$' + parseFloat(inflated.rows[0].total_fees || 0).toFixed(2));

  // 5. Check the original buy trade
  console.log('\n=== TRADE ORIGINAL DE COMPRA ===');
  const original = await pool.query(`
    SELECT time, side, executed_size, executed_price, value_usd, signal_type
    FROM paper_trades
    WHERE executed_size = 663 AND side = 'buy'
    ORDER BY time ASC
    LIMIT 3
  `);
  original.rows.forEach(t => {
    console.log(new Date(t.time).toISOString().slice(0,19), t.side, t.executed_size, '@', parseFloat(t.executed_price).toFixed(4), t.signal_type);
  });

  // 6. PnL impact - compare realized PnL vs what it should be
  console.log('\n=== IMPACTO EN PNL ===');
  const pnl = await pool.query(`SELECT total_realized_pnl, total_trades FROM paper_account LIMIT 1`);
  console.log('PnL realizado total:', '$' + parseFloat(pnl.rows[0].total_realized_pnl).toFixed(2));
  console.log('Total trades en cuenta:', pnl.rows[0].total_trades);

  // Real PnL should be: (sell_price - buy_price) * size - fees
  // If buy was at 0.12 and sell at 0.88, profit per share = 0.76
  // 663 * 0.76 = $503.88 profit (one time)
  // But if sold 40+ times, inflated by ~40x

  await pool.end();
}
investigate().catch(e => console.error(e.message));
