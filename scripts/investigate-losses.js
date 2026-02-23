const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function investigate() {
  console.log('=== INVESTIGATING RAPID LOSSES ===\n');

  // 1. Position sizing analysis
  const positionSizes = await pool.query(`
    SELECT
      AVG(value_usd) as avg_trade_value,
      MAX(value_usd) as max_trade_value,
      MIN(value_usd) as min_trade_value,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY value_usd) as median_trade_value
    FROM paper_trades
    WHERE time > NOW() - INTERVAL '24 hours'
      AND side = 'buy'
  `);
  console.log('=== POSITION SIZES (24h buys) ===');
  const ps = positionSizes.rows[0];
  console.log('  Avg trade value: $' + parseFloat(ps.avg_trade_value).toFixed(2));
  console.log('  Median: $' + parseFloat(ps.median_trade_value).toFixed(2));
  console.log('  Max: $' + parseFloat(ps.max_trade_value).toFixed(2));
  console.log('  Min: $' + parseFloat(ps.min_trade_value).toFixed(2));

  // 2. How many positions open at once?
  const concurrentPositions = await pool.query(`
    SELECT
      MAX(cnt) as max_concurrent
    FROM (
      SELECT
        COUNT(*) as cnt
      FROM paper_positions
      WHERE opened_at > NOW() - INTERVAL '24 hours'
      GROUP BY date_trunc('minute', opened_at)
    ) sub
  `);
  console.log('\n=== CONCURRENT POSITIONS ===');
  console.log('  Max concurrent (per minute):', concurrentPositions.rows[0].max_concurrent || 'N/A');

  // 3. Time between open and circuit breaker reset
  const resetIntervals = await pool.query(`
    SELECT
      timestamp,
      LAG(timestamp) OVER (ORDER BY timestamp) as prev_reset,
      EXTRACT(EPOCH FROM (timestamp - LAG(timestamp) OVER (ORDER BY timestamp))) / 60 as minutes_since_last
    FROM circuit_breaker_log
    WHERE timestamp > NOW() - INTERVAL '24 hours'
    ORDER BY timestamp
  `);
  console.log('\n=== TIME BETWEEN RESETS ===');
  const intervals = resetIntervals.rows.filter(r => r.minutes_since_last).map(r => parseFloat(r.minutes_since_last));
  if (intervals.length > 0) {
    console.log('  Avg minutes between resets:', (intervals.reduce((a,b) => a+b, 0) / intervals.length).toFixed(1));
    console.log('  Min minutes:', Math.min(...intervals).toFixed(1));
    console.log('  Max minutes:', Math.max(...intervals).toFixed(1));
  }

  // 4. Entry price vs market movement
  const priceMovement = await pool.query(`
    SELECT
      pt.market_id,
      pt.executed_price as entry_price,
      pt.time as entry_time,
      m.current_price_yes,
      m.current_price_no,
      ((m.current_price_yes - pt.executed_price) / pt.executed_price * 100) as price_change_pct
    FROM paper_trades pt
    JOIN markets m ON pt.market_id = m.id OR pt.market_id = m.condition_id
    WHERE pt.time > NOW() - INTERVAL '6 hours'
      AND pt.side = 'buy'
    ORDER BY pt.time DESC
    LIMIT 20
  `);
  console.log('\n=== PRICE MOVEMENT SINCE ENTRY (sample) ===');
  console.log('Entry Price | Current | Change%');
  let totalChange = 0;
  let count = 0;
  priceMovement.rows.forEach(r => {
    if (r.current_price_yes) {
      const entry = parseFloat(r.entry_price);
      const current = parseFloat(r.current_price_yes);
      const change = ((current - entry) / entry * 100);
      totalChange += change;
      count++;
      console.log(`  $${entry.toFixed(4)} | $${current.toFixed(4)} | ${change >= 0 ? '+' : ''}${change.toFixed(2)}%`);
    }
  });
  if (count > 0) {
    console.log(`\nAvg price change: ${(totalChange/count).toFixed(2)}%`);
  }

  // 5. Exposure analysis - how much capital at risk at any time
  const exposure = await pool.query(`
    SELECT
      SUM(value_usd) as total_exposure
    FROM paper_trades pt
    WHERE pt.side = 'buy'
      AND pt.time > NOW() - INTERVAL '30 minutes'
      AND NOT EXISTS (
        SELECT 1 FROM paper_trades sell
        WHERE sell.market_id = pt.market_id
          AND sell.side = 'sell'
          AND sell.time > pt.time
      )
  `);
  console.log('\n=== CURRENT EXPOSURE (last 30min buys without sells) ===');
  console.log('  Total: $' + (parseFloat(exposure.rows[0].total_exposure) || 0).toFixed(2));

  // 6. Signal strength vs outcome
  const signalOutcome = await pool.query(`
    SELECT
      CASE
        WHEN ABS(sp.strength) > 0.5 THEN 'strong'
        WHEN ABS(sp.strength) > 0.3 THEN 'medium'
        ELSE 'weak'
      END as strength_category,
      COUNT(*) as cnt,
      AVG(sp.pnl_pct) FILTER (WHERE sp.resolved_at IS NOT NULL) as avg_pnl
    FROM signal_predictions sp
    WHERE sp.time > NOW() - INTERVAL '7 days'
    GROUP BY 1
    ORDER BY avg_pnl DESC NULLS LAST
  `);
  console.log('\n=== SIGNAL STRENGTH vs OUTCOME ===');
  signalOutcome.rows.forEach(r => {
    const pnl = r.avg_pnl ? parseFloat(r.avg_pnl).toFixed(2) + '%' : 'N/A';
    console.log(`  ${r.strength_category}: ${r.cnt} signals, avg PnL: ${pnl}`);
  });

  // 7. Check max position size config
  console.log('\n=== CURRENT CONFIG (from env) ===');
  console.log('  EXECUTOR_MAX_POSITION_SIZE:', process.env.EXECUTOR_MAX_POSITION_SIZE || '500 (default)');
  console.log('  MAX_EXPOSURE_PER_MARKET:', process.env.MAX_EXPOSURE_PER_MARKET || '0.03 (default)');
  console.log('  MAX_TOTAL_EXPOSURE:', process.env.MAX_TOTAL_EXPOSURE || '0.60 (default)');

  await pool.end();
}

investigate().catch(e => { console.error(e); process.exit(1); });
