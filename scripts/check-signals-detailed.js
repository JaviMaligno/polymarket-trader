const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  // Check signal predictions
  console.log('=== SIGNAL PREDICTIONS (last 100) ===');
  const signals = await pool.query(`
    SELECT time, direction, strength, confidence, signal_type, market_id
    FROM signal_predictions
    ORDER BY time DESC
    LIMIT 100
  `);
  console.log('Total rows:', signals.rows.length);

  if (signals.rows.length > 0) {
    signals.rows.slice(0, 10).forEach(s => {
      console.log(`  ${s.time} | ${s.direction} | str:${s.strength} | conf:${s.confidence} | ${s.signal_type}`);
    });
  }

  // Check count by direction
  console.log('\n=== DIRECTION BREAKDOWN ===');
  const breakdown = await pool.query(`
    SELECT direction, COUNT(*) as cnt
    FROM signal_predictions
    GROUP BY direction
  `);
  breakdown.rows.forEach(r => console.log(`  ${r.direction}: ${r.cnt}`));

  // Check recent trades source
  console.log('\n=== RECENT TRADES DETAIL ===');
  const trades = await pool.query(`
    SELECT time, market_id, side, executed_size, executed_price, signal_type, strategy
    FROM paper_trades
    ORDER BY time DESC
    LIMIT 20
  `);
  trades.rows.forEach(t => {
    console.log(`  ${t.time.toISOString().substring(0,19)} | ${t.side} | size:${t.executed_size} @ ${t.executed_price} | signal:${t.signal_type || 'NULL'} | strat:${t.strategy || 'NULL'}`);
  });

  // Check if there are any non-NEUTRAL signals
  console.log('\n=== NON-NEUTRAL SIGNALS ===');
  const nonNeutral = await pool.query(`
    SELECT COUNT(*) as cnt
    FROM signal_predictions
    WHERE direction != 'NEUTRAL'
  `);
  console.log('Non-NEUTRAL signals:', nonNeutral.rows[0].cnt);

  // Check signal_weights
  console.log('\n=== SIGNAL WEIGHTS ===');
  const weights = await pool.query('SELECT * FROM signal_weights');
  weights.rows.forEach(w => {
    console.log(`  ${w.signal_type} | weight:${w.weight} | enabled:${w.is_enabled}`);
  });

  await pool.end();
}
check().catch(e => console.error(e.message));
