const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function diagnose() {
  // Get the big losing position
  const pos = await pool.query('SELECT * FROM paper_positions WHERE closed_at IS NULL ORDER BY unrealized_pnl ASC LIMIT 1');
  const p = pos.rows[0];
  console.log('=== POSICIÓN PROBLEMÁTICA ===');
  console.log('Market ID:', p.market_id);
  console.log('Size:', parseFloat(p.size).toFixed(0), 'shares');
  console.log('Entry price:', parseFloat(p.avg_entry_price).toFixed(4));
  console.log('Current price:', parseFloat(p.current_price).toFixed(4));
  console.log('Unrealized PnL: $' + parseFloat(p.unrealized_pnl).toFixed(2));
  console.log('Opened at:', p.opened_at);

  // Get market info
  const mkt = await pool.query('SELECT question,category,volume_24h,liquidity FROM markets WHERE id=$1', [p.market_id]);
  if (mkt.rows[0]) {
    console.log('\n=== MERCADO ===');
    console.log('Question:', mkt.rows[0].question);
    console.log('Category:', mkt.rows[0].category);
    console.log('24h Volume:', mkt.rows[0].volume_24h);
    console.log('Liquidity:', mkt.rows[0].liquidity);
  }

  // Get trades for this market
  const trades = await pool.query('SELECT time,side,executed_size,executed_price,signal_type FROM paper_trades WHERE market_id=$1 ORDER BY time DESC LIMIT 20', [p.market_id]);
  console.log('\n=== TRADES EN ESTE MERCADO ===');
  trades.rows.forEach(t => console.log(
    new Date(t.time).toISOString().slice(5, 16),
    t.side.padEnd(4),
    parseFloat(t.executed_size).toFixed(0).padStart(5),
    '@',
    parseFloat(t.executed_price).toFixed(4),
    t.signal_type || '?'
  ));

  // Count total positions
  const count = await pool.query('SELECT COUNT(*) as total FROM paper_positions WHERE closed_at IS NULL');
  console.log('\n=== RESUMEN ===');
  console.log('Total posiciones abiertas:', count.rows[0].total);

  // Position value
  const posValue = parseFloat(p.size) * parseFloat(p.avg_entry_price);
  console.log('Valor invertido en esta posición: $' + posValue.toFixed(2));
  console.log('% del capital inicial:', (posValue / 10000 * 100).toFixed(1) + '%');

  await pool.end();
}

diagnose().catch(e => console.error(e.message));
