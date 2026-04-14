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
    const weights = await pool.query('SELECT signal_type, weight FROM signal_weights WHERE time = (SELECT MAX(time) FROM signal_weights)');
    console.table(weights.rows);

    // Market distribution by type
    const typeDistribution = await pool.query(`
      SELECT
        COALESCE(market_type, 'unclassified') as type,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE tracking_status = 'active') as active,
        COUNT(*) FILTER (WHERE tracking_status = 'warming') as warming
      FROM markets
      WHERE tracking_status IN ('active', 'warming', 'cooling')
      GROUP BY market_type
      ORDER BY active DESC
    `);
    console.log('\n=== MERCADOS POR TIPO ===');
    if (typeDistribution.rows.length === 0) {
      console.log('(sin mercados trackeados)');
    } else {
      console.table(typeDistribution.rows.map(r => ({
        type: r.type,
        active: r.active,
        warming: r.warming,
        total: r.total
      })));
    }

  } finally {
    await pool.end();
  }
}

analyze().catch(e => console.error('Error:', e.message));
