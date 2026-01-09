/**
 * Cleanup script to keep only top N markets by volume
 * Run this after setting MAX_TRACKED_MARKETS to reduce storage
 */
const { Pool } = require('pg');

const MAX_MARKETS = parseInt(process.env.MAX_TRACKED_MARKETS || '100', 10);

async function cleanup() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log(`=== CLEANUP TO TOP ${MAX_MARKETS} MARKETS ===\n`);

  // Check current size
  const before = await pool.query("SELECT pg_size_pretty(pg_database_size('tsdb')) as size");
  console.log('Database size BEFORE:', before.rows[0].size);

  // Get current price_history stats
  const priceStats = await pool.query('SELECT count(*) as rows, count(DISTINCT token_id) as tokens FROM price_history');
  console.log('price_history rows:', priceStats.rows[0].rows);
  console.log('price_history unique tokens:', priceStats.rows[0].tokens);

  // Get top N markets by volume
  console.log(`\nGetting top ${MAX_MARKETS} markets by volume...`);
  const topMarkets = await pool.query(`
    SELECT id, clob_token_id_yes, clob_token_id_no, volume_24h, question
    FROM markets
    WHERE is_active = true AND clob_token_id_yes IS NOT NULL
    ORDER BY volume_24h DESC NULLS LAST
    LIMIT $1
  `, [MAX_MARKETS]);

  console.log(`Found ${topMarkets.rows.length} top markets`);

  // Extract all token IDs to keep
  const tokensToKeep = new Set();
  for (const market of topMarkets.rows) {
    if (market.clob_token_id_yes) tokensToKeep.add(market.clob_token_id_yes);
    if (market.clob_token_id_no) tokensToKeep.add(market.clob_token_id_no);
  }
  console.log(`Tokens to keep: ${tokensToKeep.size}`);

  // Show some of the top markets
  console.log('\nTop 5 markets by volume:');
  topMarkets.rows.slice(0, 5).forEach((m, i) => {
    console.log(`  ${i + 1}. ${(m.question || 'Unknown').substring(0, 60)}... (vol: $${Math.round(m.volume_24h || 0).toLocaleString()})`);
  });

  // Delete price_history for tokens NOT in top markets
  console.log('\nDeleting price_history for non-top markets...');
  const tokenArray = Array.from(tokensToKeep);

  // Build placeholders for the IN clause
  const placeholders = tokenArray.map((_, i) => `$${i + 1}`).join(', ');

  const deleteResult = await pool.query(`
    DELETE FROM price_history
    WHERE token_id NOT IN (${placeholders})
  `, tokenArray);

  console.log(`Deleted ${deleteResult.rowCount} rows from price_history`);

  // Also clean up the orderbook_snapshots if any
  const deleteOrderbook = await pool.query(`
    DELETE FROM orderbook_snapshots
    WHERE token_id NOT IN (${placeholders})
  `, tokenArray);
  console.log(`Deleted ${deleteOrderbook.rowCount} rows from orderbook_snapshots`);

  // Drop old chunks (aggressive cleanup)
  console.log('\nDropping old chunks...');
  try {
    await pool.query("SELECT drop_chunks('price_history', older_than => INTERVAL '3 days')");
    console.log('Dropped old chunks');
  } catch (e) {
    console.log('No old chunks to drop');
  }

  // VACUUM to reclaim space
  console.log('\nRunning VACUUM...');
  await pool.query('VACUUM ANALYZE price_history');
  await pool.query('VACUUM ANALYZE orderbook_snapshots');
  console.log('VACUUM complete');

  // Check final size
  const after = await pool.query("SELECT pg_size_pretty(pg_database_size('tsdb')) as size");
  console.log('\nDatabase size AFTER:', after.rows[0].size);

  // Final stats
  const finalStats = await pool.query('SELECT count(*) as rows, count(DISTINCT token_id) as tokens FROM price_history');
  console.log('Final price_history rows:', finalStats.rows[0].rows);
  console.log('Final price_history tokens:', finalStats.rows[0].tokens);

  await pool.end();
  console.log('\nCleanup complete!');
}

cleanup().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
