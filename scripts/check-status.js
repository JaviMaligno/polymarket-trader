const { Pool } = require('pg');

async function analyze() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // Markets count and categories
    console.log('=== MARKETS ===');
    const markets = await pool.query('SELECT COUNT(*) as total FROM markets');
    console.log('Total markets:', markets.rows[0].total);

    const cats = await pool.query(`
      SELECT category, COUNT(*) as count
      FROM markets
      GROUP BY category ORDER BY count DESC LIMIT 15
    `);
    console.log('\n=== CATEGORY DISTRIBUTION ===');
    console.table(cats.rows);

    // Price data freshness
    console.log('\n=== PRICE DATA FRESHNESS ===');
    const prices = await pool.query(`
      SELECT
        COUNT(*) as total_records,
        MIN(time) as oldest,
        MAX(time) as newest,
        COUNT(DISTINCT market_id) as unique_markets
      FROM price_history
    `);
    console.log(prices.rows[0]);

    // Recent price updates
    console.log('\n=== RECENT PRICE UPDATES ===');
    const recent = await pool.query(`
      SELECT time, COUNT(*) as records
      FROM price_history
      WHERE time > NOW() - INTERVAL '7 days'
      GROUP BY time ORDER BY time DESC LIMIT 10
    `);
    console.table(recent.rows);

    // Optimization runs
    console.log('\n=== OPTIMIZATION RUNS ===');
    const opt = await pool.query('SELECT * FROM optimization_runs ORDER BY created_at DESC LIMIT 3');
    opt.rows.forEach((r, i) => {
      console.log(`\n--- Run ${i+1}: ${r.name || r.id} ---`);
      console.log('Status:', r.status);
      console.log('Created:', r.created_at);
      console.log('Best Sharpe:', r.best_sharpe);
      console.log('Best Return:', r.best_return);
      if (r.best_params) {
        console.log('Best Params:', JSON.stringify(r.best_params, null, 2));
      }
    });

    // Signal weights
    console.log('\n=== CURRENT SIGNAL WEIGHTS ===');
    const weights = await pool.query('SELECT * FROM signal_weights_current');
    console.table(weights.rows);

  } finally {
    await pool.end();
  }
}

analyze().catch(e => console.error('Error:', e.message));
