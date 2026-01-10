const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  // Get positions with $1.00 entry price
  const positions = await pool.query(`
    SELECT
      market_id,
      token_id,
      avg_entry_price::numeric as entry,
      current_price::numeric as current,
      size::numeric as size,
      opened_at,
      signal_type
    FROM paper_positions
    WHERE closed_at IS NULL AND avg_entry_price::numeric >= 0.99
    ORDER BY opened_at DESC
  `);

  console.log('=== POSICIONES CON PRECIO ~$1.00 ===\n');

  for (const p of positions.rows) {
    console.log('Market: ' + p.market_id);
    console.log('Token:  ' + p.token_id);
    console.log('Entry:  $' + parseFloat(p.entry).toFixed(4));
    console.log('Current: $' + parseFloat(p.current || p.entry).toFixed(4));
    console.log('Size:   ' + parseFloat(p.size).toFixed(2));
    console.log('Opened: ' + p.opened_at.toISOString());
    console.log('Signal: ' + (p.signal_type || 'n/a'));
    console.log('');
  }

  // Check the trades that created these positions
  console.log('=== TRADES QUE CREARON ESTAS POSICIONES ===\n');

  const trades = await pool.query(`
    SELECT
      time,
      market_id,
      side,
      executed_price::numeric as price,
      executed_size::numeric as size,
      best_bid::numeric as bid,
      best_ask::numeric as ask,
      signal_type
    FROM paper_trades
    WHERE executed_price::numeric >= 0.99
    ORDER BY time DESC
    LIMIT 10
  `);

  trades.rows.forEach(t => {
    console.log(t.time.toISOString().substring(11,19) + ' | ' + t.side + ' @ $' + parseFloat(t.price).toFixed(4));
    console.log('  Bid: $' + (t.bid ? parseFloat(t.bid).toFixed(4) : 'n/a') + ' | Ask: $' + (t.ask ? parseFloat(t.ask).toFixed(4) : 'n/a'));
    console.log('  Market: ' + t.market_id.substring(0, 50) + '...');
    console.log('');
  });

  // Check if these markets might be resolved
  console.log('=== VERIFICANDO SI HAY DATOS DE PRECIO EN DB ===\n');

  for (const p of positions.rows) {
    const prices = await pool.query(`
      SELECT time, mid_price::numeric as price
      FROM market_prices
      WHERE market_id = $1
      ORDER BY time DESC
      LIMIT 3
    `, [p.market_id]);

    console.log('Market: ' + p.market_id.substring(0, 40) + '...');
    if (prices.rows.length === 0) {
      console.log('  NO HAY DATOS DE PRECIO EN market_prices');
    } else {
      prices.rows.forEach(pr => {
        console.log('  ' + pr.time.toISOString().substring(11,19) + ' | $' + parseFloat(pr.price).toFixed(4));
      });
    }
    console.log('');
  }

  await pool.end();
}
check().catch(e => { console.error(e.message); process.exit(1); });
