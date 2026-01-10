const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  // Check trades origin
  console.log('=== TRADE SOURCES ===');
  const sources = await pool.query(`
    SELECT signal_type, COUNT(*) as count
    FROM paper_trades
    GROUP BY signal_type
    ORDER BY count DESC
  `);
  sources.rows.forEach(r => console.log('  ', r.signal_type || 'NULL', ':', r.count));

  // Check equity snapshots
  console.log('\n=== EQUITY SNAPSHOTS (last 10) ===');
  const equity = await pool.query(`
    SELECT time, total_equity, cash, positions_value, unrealized_pnl
    FROM paper_equity_snapshots
    ORDER BY time DESC
    LIMIT 10
  `);
  equity.rows.forEach(e => {
    console.log('  ', e.time.toISOString().substring(0,19),
                '| Equity:', parseFloat(e.total_equity).toFixed(2),
                '| Cash:', parseFloat(e.cash).toFixed(2),
                '| Pos:', parseFloat(e.positions_value || 0).toFixed(2));
  });

  // Check signal weights config
  console.log('\n=== SIGNAL WEIGHTS ===');
  const weights = await pool.query('SELECT * FROM signal_weights');
  weights.rows.forEach(w => {
    console.log('  ', w.signal_type, '| weight:', w.weight, '| enabled:', w.is_enabled);
  });

  // Check a sample of price data to see if there's volatility
  console.log('\n=== PRICE VOLATILITY CHECK (sample market) ===');
  const samplePrices = await pool.query(`
    SELECT token_id,
           MIN(close) as min_price,
           MAX(close) as max_price,
           AVG(close) as avg_price,
           COUNT(*) as data_points,
           (MAX(close) - MIN(close)) / NULLIF(AVG(close), 0) * 100 as range_pct
    FROM price_history
    WHERE time > NOW() - INTERVAL '6 hours'
    GROUP BY token_id
    HAVING COUNT(*) > 10
    ORDER BY range_pct DESC NULLS LAST
    LIMIT 5
  `);
  console.log('Top 5 most volatile tokens (6h):');
  samplePrices.rows.forEach(p => {
    console.log('  Range:', parseFloat(p.range_pct || 0).toFixed(2) + '%',
                '| Points:', p.data_points,
                '| Min:', parseFloat(p.min_price).toFixed(4),
                '| Max:', parseFloat(p.max_price).toFixed(4));
  });

  await pool.end();
}

check().catch(e => console.error(e));
