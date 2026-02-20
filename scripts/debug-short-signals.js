const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function debug() {
  console.log('=== DEBUGGING SHORT SIGNAL EXECUTION ===\n');

  // Sample of SHORT signal predictions
  console.log('=== SAMPLE SHORT PREDICTIONS ===');
  const shortPreds = await pool.query(`
    SELECT
      market_id,
      signal_type,
      direction,
      confidence,
      strength,
      created_at
    FROM signal_predictions
    WHERE direction = 'short'
    ORDER BY created_at DESC
    LIMIT 10
  `);
  shortPreds.rows.forEach(r => {
    const time = new Date(r.created_at).toISOString().substring(11, 19);
    console.log('  ' + time + ' | ' + r.direction + ' | conf: ' + 
      parseFloat(r.confidence).toFixed(3) + ' | str: ' + parseFloat(r.strength).toFixed(3) + 
      ' | ' + r.market_id.substring(0, 15) + '...');
  });

  // Check if these markets have trades
  console.log('\n=== CHECKING IF SHORT-SIGNALED MARKETS HAVE TRADES ===');
  const shortMarketsWithTrades = await pool.query(`
    SELECT
      sp.market_id,
      sp.direction,
      COUNT(pt.id) as trade_count,
      STRING_AGG(DISTINCT pt.side, ', ') as trade_sides
    FROM signal_predictions sp
    LEFT JOIN paper_trades pt ON sp.market_id = pt.market_id 
      AND pt.time >= sp.created_at 
      AND pt.time <= sp.created_at + INTERVAL '5 minutes'
    WHERE sp.direction = 'short'
      AND sp.created_at > NOW() - INTERVAL '24 hours'
    GROUP BY sp.market_id, sp.direction
    LIMIT 10
  `);
  shortMarketsWithTrades.rows.forEach(r => {
    console.log('  ' + r.market_id.substring(0, 15) + '... | trades: ' + r.trade_count + ' | sides: ' + (r.trade_sides || 'none'));
  });

  // Check the paper_positions for these markets
  console.log('\n=== POSITIONS FOR SHORT-SIGNALED MARKETS ===');
  const positionsForShort = await pool.query(`
    SELECT
      pp.market_id,
      pp.side,
      pp.size,
      pp.closed_at IS NOT NULL as is_closed
    FROM paper_positions pp
    WHERE pp.market_id IN (
      SELECT DISTINCT market_id 
      FROM signal_predictions 
      WHERE direction = 'short' 
        AND created_at > NOW() - INTERVAL '24 hours'
    )
    LIMIT 10
  `);
  if (positionsForShort.rows.length === 0) {
    console.log('  No positions found for SHORT-signaled markets');
  } else {
    positionsForShort.rows.forEach(r => {
      console.log('  ' + r.market_id.substring(0, 15) + '... | side: ' + r.side + ' | size: ' + parseFloat(r.size).toFixed(2) + ' | closed: ' + r.is_closed);
    });
  }

  // Check what signal_type is in paper_trades
  console.log('\n=== SIGNAL TYPES IN TRADES (24h) ===');
  const tradeSignalTypes = await pool.query(`
    SELECT signal_type, side, COUNT(*) as count
    FROM paper_trades
    WHERE time > NOW() - INTERVAL '24 hours'
    GROUP BY signal_type, side
    ORDER BY count DESC
  `);
  tradeSignalTypes.rows.forEach(r => {
    console.log('  ' + (r.signal_type || 'null').padEnd(20) + ' | ' + r.side + ' | ' + r.count);
  });

  // Critical: Check if SHORT signals have token_id (needed for execution)
  console.log('\n=== SHORT PREDICTIONS TOKEN CHECK ===');
  const shortWithToken = await pool.query(`
    SELECT
      token_id IS NOT NULL as has_token,
      COUNT(*) as count
    FROM signal_predictions
    WHERE direction = 'short'
      AND created_at > NOW() - INTERVAL '24 hours'
    GROUP BY token_id IS NOT NULL
  `);
  shortWithToken.rows.forEach(r => {
    console.log('  Has token_id: ' + r.has_token + ' | count: ' + r.count);
  });

  await pool.end();
}

debug().catch(e => { console.error(e); process.exit(1); });
