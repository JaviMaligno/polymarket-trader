const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function investigate() {
  console.log('=== SIGNAL DIRECTION ANALYSIS ===\n');

  // Check signal directions in recent trades
  const directions = await pool.query(`
    SELECT
      side,
      signal_type,
      COUNT(*) as count
    FROM paper_trades
    WHERE time > NOW() - INTERVAL '24 hours'
    GROUP BY side, signal_type
    ORDER BY count DESC
  `);
  console.log('Trade Side + Signal Type:');
  directions.rows.forEach(r => {
    console.log('  ' + r.side + ' + ' + (r.signal_type || 'null') + ': ' + r.count);
  });

  // Check what's happening with SHORT signals
  console.log('\n=== SHORT SIGNAL INVESTIGATION ===');
  const shortTrades = await pool.query(`
    SELECT COUNT(*) as count
    FROM paper_trades
    WHERE time > NOW() - INTERVAL '24 hours'
      AND signal_type = 'combined'
      AND side = 'sell'
  `);
  console.log('Sell trades from combined signals:', shortTrades.rows[0].count);

  // Check if positions are being opened but not closed
  const openPositions = await pool.query(`
    SELECT COUNT(*) as count
    FROM paper_positions
    WHERE closed_at IS NULL
  `);
  console.log('Currently open positions:', openPositions.rows[0].count);

  // Check how positions are being closed
  console.log('\n=== HOW POSITIONS ARE CLOSED ===');
  const closureReasons = await pool.query(`
    SELECT
      pt.signal_type as closure_reason,
      COUNT(*) as count
    FROM paper_positions pp
    JOIN paper_trades pt ON pp.market_id = pt.market_id AND pt.side = 'sell'
      AND pt.time >= pp.created_at AND pt.time <= pp.closed_at + INTERVAL '1 second'
    WHERE pp.closed_at IS NOT NULL
      AND pp.closed_at > NOW() - INTERVAL '24 hours'
    GROUP BY pt.signal_type
    ORDER BY count DESC
  `);
  closureReasons.rows.forEach(r => {
    console.log('  ' + (r.closure_reason || 'unknown') + ': ' + r.count);
  });

  // Check signal weights
  console.log('\n=== SIGNAL WEIGHTS ===');
  const weights = await pool.query(`
    SELECT signal_name, weight, is_enabled
    FROM signal_weights
    ORDER BY weight DESC
  `);
  weights.rows.forEach(r => {
    console.log('  ' + r.signal_name + ': ' + parseFloat(r.weight).toFixed(3) + (r.is_enabled ? '' : ' (disabled)'));
  });

  // Check combiner parameters
  console.log('\n=== COMBINER CONFIG ===');
  const combinerConfig = await pool.query(`
    SELECT key, value FROM config WHERE key LIKE 'combiner%'
  `);
  if (combinerConfig.rows.length > 0) {
    combinerConfig.rows.forEach(r => {
      console.log('  ' + r.key + ': ' + r.value);
    });
  } else {
    console.log('  No combiner config in database (using defaults)');
  }

  // Check the actual prices when positions were opened vs closed
  console.log('\n=== PRICE MOVEMENT ANALYSIS (sample) ===');
  const priceMovement = await pool.query(`
    SELECT
      pp.market_id,
      pp.side,
      pp.avg_entry_price,
      pp.current_price,
      pp.realized_pnl,
      m.question
    FROM paper_positions pp
    LEFT JOIN markets m ON pp.market_id = m.id
    WHERE pp.closed_at IS NOT NULL
      AND pp.closed_at > NOW() - INTERVAL '24 hours'
      AND pp.realized_pnl != 0
    ORDER BY pp.realized_pnl ASC
    LIMIT 5
  `);
  console.log('Worst trades:');
  priceMovement.rows.forEach(r => {
    const entry = parseFloat(r.avg_entry_price || 0);
    const exit = parseFloat(r.current_price || 0);
    const pnl = parseFloat(r.realized_pnl || 0);
    console.log('  Entry: $' + entry.toFixed(4) + ' -> Exit: $' + exit.toFixed(4) + ' | P&L: $' + pnl.toFixed(2) + ' | ' + (r.question || r.market_id).substring(0, 40) + '...');
  });

  await pool.end();
}

investigate().catch(e => { console.error(e); process.exit(1); });
