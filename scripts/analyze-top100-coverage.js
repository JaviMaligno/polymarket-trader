const { Pool } = require('pg');

async function analyze() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log('=== ANALYSIS: TOP 100 vs HISTORICAL ACTIVITY ===\n');

  // 1. Get top 100 markets by volume (current tracking)
  const top100 = await pool.query(`
    SELECT id, clob_token_id_yes, clob_token_id_no, volume_24h, question
    FROM markets
    WHERE is_active = true AND clob_token_id_yes IS NOT NULL
    ORDER BY volume_24h DESC NULLS LAST
    LIMIT 100
  `);

  const top100Ids = new Set(top100.rows.map(m => m.id));
  const top100Tokens = new Set();
  top100.rows.forEach(m => {
    if (m.clob_token_id_yes) top100Tokens.add(m.clob_token_id_yes);
    if (m.clob_token_id_no) top100Tokens.add(m.clob_token_id_no);
  });

  console.log('Top 100 markets:', top100.rows.length);
  console.log('Top 100 tokens:', top100Tokens.size);

  // 2. Check price_history - which tokens have data?
  const priceTokens = await pool.query('SELECT DISTINCT token_id FROM price_history');
  console.log('\nTokens with price history:', priceTokens.rows.length);

  // How many are outside top 100?
  const outsideTop100 = priceTokens.rows.filter(r => !top100Tokens.has(r.token_id));
  console.log('Tokens OUTSIDE top 100:', outsideTop100.length);

  // 3. Check paper_orders count
  const ordersCount = await pool.query('SELECT count(*) as c FROM paper_orders');
  console.log('\nTotal paper orders:', ordersCount.rows[0].c);

  // 4. Check optimization_runs - what markets were best?
  const optRuns = await pool.query(`
    SELECT id, best_params, best_score, created_at
    FROM optimization_runs
    ORDER BY created_at DESC
    LIMIT 3
  `);
  console.log('\nRecent optimization runs:', optRuns.rows.length);
  optRuns.rows.forEach(r => {
    console.log('  - Score:', r.best_score, '| params:', JSON.stringify(r.best_params));
  });

  // 5. Check backtest_results for market performance
  const backtests = await pool.query(`
    SELECT COUNT(*) as total,
           COUNT(CASE WHEN total_return > 0 THEN 1 END) as profitable
    FROM backtest_results
  `);
  console.log('\nBacktest results:', backtests.rows[0].total, '| profitable:', backtests.rows[0].profitable);

  // 6. Show volume distribution of top markets
  console.log('\n=== VOLUME DISTRIBUTION ===');
  console.log('Top 10 by volume:');
  top100.rows.slice(0, 10).forEach((m, i) => {
    const vol = Math.round(m.volume_24h || 0);
    console.log(`  ${i+1}. $${vol.toLocaleString()} - ${(m.question || '').substring(0, 50)}...`);
  });

  console.log('\nMarkets 90-100 by volume:');
  top100.rows.slice(90, 100).forEach((m, i) => {
    const vol = Math.round(m.volume_24h || 0);
    console.log(`  ${91+i}. $${vol.toLocaleString()} - ${(m.question || '').substring(0, 50)}...`);
  });

  // 7. Check market 101-200 volume range
  const next100 = await pool.query(`
    SELECT volume_24h, question
    FROM markets
    WHERE is_active = true AND clob_token_id_yes IS NOT NULL
    ORDER BY volume_24h DESC NULLS LAST
    OFFSET 100 LIMIT 100
  `);

  if (next100.rows.length > 0) {
    const avgVol = next100.rows.reduce((s, m) => s + (m.volume_24h || 0), 0) / next100.rows.length;
    console.log('\nMarkets 101-200:');
    console.log('  Count:', next100.rows.length);
    console.log('  Avg volume: $' + Math.round(avgVol).toLocaleString());
    console.log('  #101: $' + Math.round(next100.rows[0]?.volume_24h || 0).toLocaleString());
    console.log('  #200: $' + Math.round(next100.rows[99]?.volume_24h || 0).toLocaleString());
  }

  // 8. Check total active markets
  const totalActive = await pool.query(`
    SELECT count(*) as c FROM markets WHERE is_active = true AND clob_token_id_yes IS NOT NULL
  `);
  console.log('\nTotal active markets:', totalActive.rows[0].c);

  // 9. Storage estimate if we increase
  const currentSize = await pool.query("SELECT pg_database_size('tsdb') as bytes");
  const currentMB = Math.round(currentSize.rows[0].bytes / 1024 / 1024);
  console.log('\n=== STORAGE ESTIMATES ===');
  console.log('Current DB size:', currentMB, 'MB');
  console.log('Est. with 200 markets:', Math.round(currentMB * 2), 'MB');
  console.log('Est. with 300 markets:', Math.round(currentMB * 3), 'MB');
  console.log('Limit: 750 MB');

  await pool.end();
}

analyze().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
