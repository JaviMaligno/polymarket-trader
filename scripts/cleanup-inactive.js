const { Pool } = require('pg');

async function cleanup() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log('=== CLEANUP INACTIVE DATA ===\n');

  // Check current size
  const before = await pool.query("SELECT pg_size_pretty(pg_database_size('tsdb')) as size");
  console.log('Size BEFORE:', before.rows[0].size);

  // 1. Delete inactive markets (keep only active ones)
  console.log('\n--- Deleting inactive markets ---');
  const inactiveCount = await pool.query("SELECT count(*) FROM markets WHERE is_active = false");
  console.log('Inactive markets to delete:', inactiveCount.rows[0].count);

  // First, delete price_history for inactive markets
  const deletedPrices = await pool.query(`
    DELETE FROM price_history
    WHERE token_id IN (SELECT token_id FROM markets WHERE is_active = false)
  `);
  console.log('Deleted price rows for inactive markets:', deletedPrices.rowCount);

  // Then delete the inactive markets themselves
  const deletedMarkets = await pool.query("DELETE FROM markets WHERE is_active = false");
  console.log('Deleted inactive markets:', deletedMarkets.rowCount);

  // 2. VACUUM to reclaim space
  console.log('\n--- Running VACUUM ---');
  await pool.query('VACUUM ANALYZE markets');
  await pool.query('VACUUM ANALYZE price_history');
  console.log('VACUUM complete');

  // Check final size
  const after = await pool.query("SELECT pg_size_pretty(pg_database_size('tsdb')) as size");
  console.log('\nSize AFTER:', after.rows[0].size);

  // Summary
  console.log('\n=== SUMMARY ===');
  const marketCount = await pool.query("SELECT count(*) FROM markets");
  console.log('Remaining markets:', marketCount.rows[0].count);

  const priceCount = await pool.query("SELECT count(*) FROM price_history");
  console.log('Remaining price_history rows:', priceCount.rows[0].count);

  await pool.end();
}

cleanup().catch(console.error);
