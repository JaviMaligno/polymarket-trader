const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function testResolve() {
  console.log('=== TESTING PREDICTION RESOLUTION ===\n');

  // Run the same query the service now uses
  const result = await pool.query(`
    WITH eligible_predictions AS (
      SELECT
        sp.id as pred_id,
        sp.time as pred_time,
        sp.market_id,
        sp.direction,
        sp.price_at_signal,
        m.id as gamma_id
      FROM signal_predictions sp
      JOIN markets m ON sp.market_id = m.id OR sp.market_id = m.condition_id
      WHERE sp.resolved_at IS NULL
        AND sp.time < NOW() - INTERVAL '1 hour'
      LIMIT 100
    ),
    latest_prices AS (
      SELECT DISTINCT ON (market_id)
        market_id,
        close as current_price
      FROM price_history
      WHERE time > NOW() - INTERVAL '24 hours'
      ORDER BY market_id, time DESC
    )
    SELECT
      ep.pred_id,
      ep.pred_time,
      ep.direction,
      ep.price_at_signal,
      lp.current_price
    FROM eligible_predictions ep
    JOIN latest_prices lp ON ep.gamma_id = lp.market_id
  `);

  console.log(`Found ${result.rows.length} predictions that can be resolved\n`);

  if (result.rows.length === 0) {
    console.log('No predictions can be resolved. Checking why...\n');

    // Check eligible predictions count
    const eligible = await pool.query(`
      SELECT COUNT(*) as cnt
      FROM signal_predictions sp
      JOIN markets m ON sp.market_id = m.id OR sp.market_id = m.condition_id
      WHERE sp.resolved_at IS NULL
        AND sp.time < NOW() - INTERVAL '1 hour'
    `);
    console.log('Eligible predictions (with market match):', eligible.rows[0].cnt);

    // Check latest prices count
    const prices = await pool.query(`
      SELECT COUNT(DISTINCT market_id) as cnt
      FROM price_history
      WHERE time > NOW() - INTERVAL '2 hours'
    `);
    console.log('Markets with recent prices:', prices.rows[0].cnt);

    await pool.end();
    return;
  }

  // Show sample of what would be resolved
  console.log('Sample predictions to resolve:');
  console.log('Dir   | Entry  | Current | PnL%   | Correct?');
  console.log('------|--------|---------|--------|----------');

  let correct = 0;
  let incorrect = 0;

  result.rows.slice(0, 10).forEach(row => {
    const entryPrice = parseFloat(row.price_at_signal);
    const currentPrice = parseFloat(row.current_price);
    const direction = row.direction;

    const pnlPct = direction === 'long'
      ? ((currentPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - currentPrice) / entryPrice) * 100;

    const wasCorrect = pnlPct > 0;
    if (wasCorrect) correct++; else incorrect++;

    console.log(
      `${direction.padEnd(5)} | ${entryPrice.toFixed(4)} | ${currentPrice.toFixed(4)} | ${pnlPct.toFixed(2).padStart(6)}% | ${wasCorrect ? 'YES' : 'NO'}`
    );
  });

  console.log('\nProjected accuracy from sample:', ((correct / (correct + incorrect)) * 100).toFixed(1) + '%');

  // Actually resolve them
  console.log('\n>>> Resolving predictions...');

  let resolved = 0;
  for (const row of result.rows) {
    const entryPrice = parseFloat(row.price_at_signal);
    const currentPrice = parseFloat(row.current_price);
    const direction = row.direction;

    const pnlPct = direction === 'long'
      ? ((currentPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - currentPrice) / entryPrice) * 100;

    const wasCorrect = pnlPct > 0;

    await pool.query(`
      UPDATE signal_predictions
      SET resolved_at = NOW(),
          price_at_resolution = $1,
          was_correct = $2,
          pnl_pct = $3
      WHERE id = $4 AND time = $5
    `, [currentPrice, wasCorrect, pnlPct, row.pred_id, row.pred_time]);

    resolved++;
  }

  console.log(`Resolved ${resolved} predictions!`);

  // Check accuracy now
  const accuracy = await pool.query(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE was_correct = true) as correct,
      AVG(pnl_pct) as avg_pnl
    FROM signal_predictions
    WHERE resolved_at IS NOT NULL
  `);

  console.log('\n=== UPDATED STATS ===');
  const a = accuracy.rows[0];
  console.log('Total resolved:', a.total);
  console.log('Correct:', a.correct, `(${(a.correct/a.total*100).toFixed(1)}%)`);
  console.log('Avg PnL:', parseFloat(a.avg_pnl).toFixed(2) + '%');

  await pool.end();
}

testResolve().catch(e => { console.error(e); process.exit(1); });
