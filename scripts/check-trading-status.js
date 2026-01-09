const { Pool } = require('pg');

async function check() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log('=== TRADING STATUS ===\n');

  // 1. Check active strategies
  const strategies = await pool.query(`
    SELECT id, name, is_active, params, created_at
    FROM saved_strategies
    WHERE is_active = true
    ORDER BY created_at DESC
    LIMIT 3
  `);
  console.log('Active strategies:', strategies.rows.length);
  strategies.rows.forEach(s => {
    const params = s.params || {};
    console.log('  -', s.name, '| minEdge:', params.minEdge, '| minConfidence:', params.minConfidence);
  });

  // 2. Check paper account
  const account = await pool.query('SELECT * FROM paper_account LIMIT 1');
  if (account.rows.length > 0) {
    const a = account.rows[0];
    console.log('\nPaper account:');
    console.log('  Cash:', a.cash);
    console.log('  Equity:', a.equity);
  } else {
    console.log('\nNo paper account found');
  }

  // 3. Check recent paper orders
  const orders = await pool.query(`
    SELECT count(*) as total,
           count(CASE WHEN status = 'filled' THEN 1 END) as filled
    FROM paper_orders
  `);
  console.log('\nPaper orders:');
  console.log('  Total:', orders.rows[0].total);
  console.log('  Filled:', orders.rows[0].filled);

  // 4. Check price history (total and recent)
  const priceTotal = await pool.query('SELECT count(*) as rows, count(DISTINCT token_id) as tokens FROM price_history');
  const priceRecent = await pool.query(`
    SELECT count(*) as rows FROM price_history WHERE time > now() - interval '1 hour'
  `);
  console.log('\nPrice data:');
  console.log('  Total rows:', priceTotal.rows[0].rows);
  console.log('  Unique tokens:', priceTotal.rows[0].tokens);
  console.log('  New rows (last hour):', priceRecent.rows[0].rows);

  // 5. Check DB size
  const size = await pool.query("SELECT pg_size_pretty(pg_database_size('tsdb')) as size");
  console.log('\nDatabase size:', size.rows[0].size, '(limit: 750 MB)');

  // 6. Check signal predictions
  const signals = await pool.query(`
    SELECT count(*) as total FROM signal_predictions WHERE created_at > now() - interval '1 hour'
  `);
  console.log('Signal predictions (last hour):', signals.rows[0].total);

  // 7. Check trading_config for active strategies
  const config = await pool.query('SELECT * FROM trading_config LIMIT 1');
  if (config.rows.length > 0) {
    console.log('\nTrading config:', JSON.stringify(config.rows[0], null, 2));
  }

  await pool.end();
}

check().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
