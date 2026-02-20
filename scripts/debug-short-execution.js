const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  console.log('=== WHY SHORT SIGNALS DONT BECOME TRADES ===\n');

  // 1. Check signal predictions vs trades by direction
  const predVsTrades = await pool.query(`
    WITH predictions AS (
      SELECT direction, COUNT(*) as pred_count
      FROM signal_predictions
      WHERE time > NOW() - INTERVAL '24 hours'
      GROUP BY direction
    ),
    trades AS (
      SELECT
        CASE
          WHEN side = 'buy' AND signal_type LIKE '%combined%' THEN 'long'
          WHEN side = 'sell' AND signal_type LIKE '%exit%' THEN 'short_exit'
          ELSE 'other'
        END as trade_direction,
        COUNT(*) as trade_count
      FROM paper_trades
      WHERE time > NOW() - INTERVAL '24 hours'
      GROUP BY 1
    )
    SELECT * FROM predictions
    FULL OUTER JOIN trades ON predictions.direction = trades.trade_direction
  `);

  console.log('=== PREDICTIONS vs TRADES (24h) ===');
  console.log('Direction | Predictions | Trades');
  predVsTrades.rows.forEach(r => {
    console.log(`${(r.direction || r.trade_direction || 'unknown').padEnd(12)} | ${(r.pred_count || '0').toString().padStart(6)} | ${(r.trade_count || '0').toString().padStart(6)}`);
  });

  // 2. Check sample SHORT predictions - do they have existing positions?
  const shortPreds = await pool.query(`
    SELECT
      sp.time,
      sp.market_id,
      sp.direction,
      sp.signal_type,
      sp.confidence,
      sp.strength,
      pp.id as position_id,
      pp.size as position_size,
      pp.side as position_side
    FROM signal_predictions sp
    LEFT JOIN paper_positions pp ON sp.market_id = pp.market_id AND pp.closed_at IS NULL
    WHERE sp.time > NOW() - INTERVAL '24 hours'
      AND sp.direction = 'short'
    ORDER BY sp.time DESC
    LIMIT 10
  `);

  console.log('\n=== SAMPLE SHORT PREDICTIONS (with position info) ===');
  shortPreds.rows.forEach(r => {
    const time = new Date(r.time).toLocaleTimeString('es-ES');
    const mktId = r.market_id.substring(0, 15);
    const hasPos = r.position_id ? `YES (${r.position_side}, size=${parseFloat(r.position_size).toFixed(2)})` : 'NO';
    console.log(`${time} | ${mktId}... | conf=${parseFloat(r.confidence).toFixed(2)} str=${parseFloat(r.strength).toFixed(2)} | Has position: ${hasPos}`);
  });

  // 3. Check if SHORT predictions have matching markets with NO token
  const shortWithToken = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE m.clob_token_id_no IS NOT NULL) as has_no_token,
      COUNT(*) FILTER (WHERE m.clob_token_id_no IS NULL) as missing_no_token,
      COUNT(*) FILTER (WHERE m.id IS NULL) as market_not_found,
      COUNT(*) as total
    FROM signal_predictions sp
    LEFT JOIN markets m ON sp.market_id = m.id OR sp.market_id = m.condition_id
    WHERE sp.time > NOW() - INTERVAL '24 hours'
      AND sp.direction = 'short'
  `);

  console.log('\n=== SHORT SIGNAL TOKEN AVAILABILITY ===');
  const ts = shortWithToken.rows[0];
  console.log('Total SHORT predictions:', ts.total);
  console.log('Has NO token available:', ts.has_no_token);
  console.log('Missing NO token:', ts.missing_no_token);
  console.log('Market not found in DB:', ts.market_not_found);

  // 4. The real question: Why arent SHORT signals becoming trades?
  // AutoSignalExecutor requires:
  // - Either an existing position (to close it) OR
  // - Space to open a new "No" position
  // Check how many open positions existed when SHORT signals came in
  const openPositionsDuringShort = await pool.query(`
    SELECT
      COUNT(DISTINCT sp.id) as short_preds,
      COUNT(DISTINCT pp.id) as positions_at_time
    FROM signal_predictions sp
    LEFT JOIN paper_positions pp ON pp.closed_at IS NULL
    WHERE sp.time > NOW() - INTERVAL '24 hours'
      AND sp.direction = 'short'
  `);

  console.log('\n=== OPEN POSITIONS DURING SHORT SIGNALS ===');
  console.log('Note: If positions existed, SHORT should close them');
  console.log('SHORT predictions:', openPositionsDuringShort.rows[0].short_preds);

  // 5. Check the actual execution flow - paper_trades with combined signal_type
  const combinedTrades = await pool.query(`
    SELECT
      side,
      signal_type,
      COUNT(*) as cnt
    FROM paper_trades
    WHERE time > NOW() - INTERVAL '24 hours'
      AND (signal_type LIKE '%combined%' OR signal_type LIKE '%exit%')
    GROUP BY side, signal_type
    ORDER BY cnt DESC
  `);

  console.log('\n=== COMBINED SIGNAL TRADES (24h) ===');
  combinedTrades.rows.forEach(r => {
    console.log(`${r.side.padEnd(5)} | ${r.signal_type.padEnd(20)} | ${r.cnt}`);
  });

  // 6. Key insight: Check if markets with SHORT predictions had open LONG positions
  const shortVsPositions = await pool.query(`
    SELECT
      sp.market_id,
      sp.time as signal_time,
      pp.id as pos_id,
      pp.opened_at,
      pp.closed_at,
      pp.side as pos_side,
      pp.size as pos_size
    FROM signal_predictions sp
    LEFT JOIN paper_positions pp ON sp.market_id = pp.market_id
    WHERE sp.time > NOW() - INTERVAL '24 hours'
      AND sp.direction = 'short'
      AND pp.id IS NOT NULL
    ORDER BY sp.time DESC
    LIMIT 10
  `);

  console.log('\n=== SHORT SIGNALS WHERE POSITION EXISTED ===');
  if (shortVsPositions.rows.length === 0) {
    console.log('>>> NONE! SHORT signals came for markets with NO open positions!');
    console.log('>>> This means SHORT signals would try to OPEN "No" positions, not close existing ones.');
  } else {
    shortVsPositions.rows.forEach(r => {
      const signalTime = new Date(r.signal_time).toLocaleTimeString('es-ES');
      console.log(`${signalTime} | ${r.market_id.substring(0, 15)}... | Pos ID: ${r.pos_id} | ${r.pos_side} | closed: ${r.closed_at ? 'YES' : 'NO'}`);
    });
  }

  await pool.end();
}

check().catch(e => { console.error(e); process.exit(1); });
