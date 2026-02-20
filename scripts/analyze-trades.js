const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function analyze() {
  console.log('=== COMPREHENSIVE TRADE ANALYSIS ===\n');

  // 1. Overall statistics (last 24 hours)
  const overall = await pool.query(`
    SELECT
      COUNT(*) as total_trades,
      COUNT(CASE WHEN side = 'buy' THEN 1 END) as buys,
      COUNT(CASE WHEN side = 'sell' THEN 1 END) as sells,
      SUM(value_usd) as total_volume,
      AVG(value_usd) as avg_trade_size,
      COUNT(DISTINCT market_id) as unique_markets
    FROM paper_trades
    WHERE time > NOW() - INTERVAL '24 hours'
  `);
  const o = overall.rows[0];
  console.log('=== LAST 24 HOURS ===');
  console.log('Total trades:', o.total_trades);
  console.log('Buys:', o.buys, '| Sells:', o.sells);
  console.log('Total volume: $' + parseFloat(o.total_volume || 0).toFixed(2));
  console.log('Avg trade size: $' + parseFloat(o.avg_trade_size || 0).toFixed(2));
  console.log('Unique markets:', o.unique_markets);

  // 2. Trade outcomes by signal type
  const bySignal = await pool.query(`
    SELECT
      signal_type,
      COUNT(*) as count,
      SUM(value_usd) as volume
    FROM paper_trades
    WHERE time > NOW() - INTERVAL '24 hours'
    GROUP BY signal_type
    ORDER BY count DESC
  `);
  console.log('\n=== BY SIGNAL TYPE ===');
  bySignal.rows.forEach(r => {
    console.log((r.signal_type || 'unknown').padEnd(20), '|', r.count, 'trades | $' + parseFloat(r.volume || 0).toFixed(2));
  });

  // 3. Analyze closed positions (realized P&L)
  const closedPositions = await pool.query(`
    SELECT
      COUNT(*) as total_closed,
      COUNT(CASE WHEN realized_pnl > 0 THEN 1 END) as winners,
      COUNT(CASE WHEN realized_pnl < 0 THEN 1 END) as losers,
      COUNT(CASE WHEN realized_pnl = 0 THEN 1 END) as breakeven,
      SUM(realized_pnl) as total_pnl,
      AVG(realized_pnl) as avg_pnl,
      AVG(CASE WHEN realized_pnl > 0 THEN realized_pnl END) as avg_win,
      AVG(CASE WHEN realized_pnl < 0 THEN realized_pnl END) as avg_loss
    FROM paper_positions
    WHERE closed_at IS NOT NULL
      AND closed_at > NOW() - INTERVAL '24 hours'
  `);
  const cp = closedPositions.rows[0];
  console.log('\n=== CLOSED POSITIONS (24h) ===');
  console.log('Total closed:', cp.total_closed);
  console.log('Winners:', cp.winners, '| Losers:', cp.losers, '| Breakeven:', cp.breakeven);
  if (parseInt(cp.total_closed) > 0) {
    const winRate = (cp.winners / cp.total_closed * 100).toFixed(1);
    console.log('Win rate:', winRate + '%');
    console.log('Total P&L: $' + parseFloat(cp.total_pnl || 0).toFixed(2));
    console.log('Avg P&L: $' + parseFloat(cp.avg_pnl || 0).toFixed(2));
    console.log('Avg win: $' + parseFloat(cp.avg_win || 0).toFixed(2), '| Avg loss: $' + parseFloat(cp.avg_loss || 0).toFixed(2));
  }

  // 4. Top losing markets
  const losingMarkets = await pool.query(`
    SELECT
      pp.market_id,
      m.question,
      COUNT(*) as trade_count,
      SUM(pp.realized_pnl) as total_pnl
    FROM paper_positions pp
    LEFT JOIN markets m ON pp.market_id = m.id
    WHERE pp.closed_at IS NOT NULL
      AND pp.closed_at > NOW() - INTERVAL '24 hours'
    GROUP BY pp.market_id, m.question
    HAVING SUM(pp.realized_pnl) < 0
    ORDER BY SUM(pp.realized_pnl) ASC
    LIMIT 10
  `);
  console.log('\n=== TOP 10 LOSING MARKETS ===');
  losingMarkets.rows.forEach((r, i) => {
    const question = (r.question || r.market_id).substring(0, 50);
    console.log((i+1) + '. $' + parseFloat(r.total_pnl).toFixed(2), '|', r.trade_count, 'trades |', question + '...');
  });

  // 5. Top winning markets
  const winningMarkets = await pool.query(`
    SELECT
      pp.market_id,
      m.question,
      COUNT(*) as trade_count,
      SUM(pp.realized_pnl) as total_pnl
    FROM paper_positions pp
    LEFT JOIN markets m ON pp.market_id = m.id
    WHERE pp.closed_at IS NOT NULL
      AND pp.closed_at > NOW() - INTERVAL '24 hours'
    GROUP BY pp.market_id, m.question
    HAVING SUM(pp.realized_pnl) > 0
    ORDER BY SUM(pp.realized_pnl) DESC
    LIMIT 10
  `);
  console.log('\n=== TOP 10 WINNING MARKETS ===');
  winningMarkets.rows.forEach((r, i) => {
    const question = (r.question || r.market_id).substring(0, 50);
    console.log((i+1) + '. +$' + parseFloat(r.total_pnl).toFixed(2), '|', r.trade_count, 'trades |', question + '...');
  });

  // 6. Position hold times
  const holdTimes = await pool.query(`
    SELECT
      AVG(EXTRACT(EPOCH FROM (closed_at - created_at))) as avg_hold_seconds,
      MIN(EXTRACT(EPOCH FROM (closed_at - created_at))) as min_hold_seconds,
      MAX(EXTRACT(EPOCH FROM (closed_at - created_at))) as max_hold_seconds
    FROM paper_positions
    WHERE closed_at IS NOT NULL
      AND closed_at > NOW() - INTERVAL '24 hours'
  `);
  const ht = holdTimes.rows[0];
  console.log('\n=== POSITION HOLD TIMES ===');
  console.log('Average:', (parseFloat(ht.avg_hold_seconds || 0) / 60).toFixed(1), 'minutes');
  console.log('Min:', (parseFloat(ht.min_hold_seconds || 0) / 60).toFixed(1), 'min | Max:', (parseFloat(ht.max_hold_seconds || 0) / 60).toFixed(1), 'min');

  // 7. Stop loss and take profit effectiveness
  const stopLossTrades = await pool.query(`
    SELECT
      signal_type,
      COUNT(*) as count
    FROM paper_trades
    WHERE time > NOW() - INTERVAL '24 hours'
      AND signal_type IN ('stop_loss', 'take_profit', 'combined_exit')
    GROUP BY signal_type
  `);
  console.log('\n=== EXIT REASONS ===');
  stopLossTrades.rows.forEach(r => {
    console.log(r.signal_type + ':', r.count);
  });

  // 8. Hourly trade count
  const hourlyTrades = await pool.query(`
    SELECT
      DATE_TRUNC('hour', time) as hour,
      COUNT(*) as trades
    FROM paper_trades
    WHERE time > NOW() - INTERVAL '24 hours'
    GROUP BY DATE_TRUNC('hour', time)
    ORDER BY hour DESC
    LIMIT 12
  `);
  console.log('\n=== HOURLY TRADE COUNT (last 12 hours) ===');
  hourlyTrades.rows.forEach(r => {
    const hour = new Date(r.hour).toISOString().substring(11, 16);
    console.log(hour, 'UTC |', r.trades, 'trades');
  });

  await pool.end();
}

analyze().catch(e => { console.error(e); process.exit(1); });
