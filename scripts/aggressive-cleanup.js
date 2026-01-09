const { Pool } = require('pg');

async function cleanup() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log('=== AGGRESSIVE CLEANUP ===\n');

  // 1. Check current size
  const before = await pool.query("SELECT pg_size_pretty(pg_database_size('tsdb')) as size");
  console.log('Size BEFORE cleanup:', before.rows[0].size);

  // 2. Remove old retention policies and create more aggressive ones
  console.log('\n--- Updating retention policies ---');

  // Remove existing retention policies
  const existingJobs = await pool.query(`
    SELECT job_id FROM timescaledb_information.jobs WHERE proc_name = 'policy_retention'
  `);
  for (const job of existingJobs.rows) {
    try {
      await pool.query(`SELECT remove_retention_policy('price_history', if_exists => true)`);
    } catch (e) { /* ignore */ }
  }

  // 3. Drop old chunks manually (keep only 7 days)
  console.log('\n--- Dropping old price_history chunks (older than 7 days) ---');
  const dropped = await pool.query(`
    SELECT drop_chunks('price_history', older_than => INTERVAL '7 days')
  `);
  console.log('Dropped chunks:', dropped.rows.length);

  // 4. Set new retention policy - 7 days for price_history
  console.log('\n--- Setting new retention policies ---');
  try {
    await pool.query(`SELECT remove_retention_policy('price_history', if_exists => true)`);
    await pool.query(`SELECT add_retention_policy('price_history', INTERVAL '7 days')`);
    console.log('price_history: 7 days (was 30 days)');
  } catch (e) {
    console.log('price_history policy error:', e.message);
  }

  // Keep other policies but make them more aggressive
  const policies = [
    ['trades', '14 days'],           // was 60 days
    ['orderbook_snapshots', '3 days'], // was 7 days
    ['paper_orders', '30 days'],      // was 90 days
    ['paper_equity_history', '60 days'], // was 180 days
    ['signal_predictions', '14 days'],  // was 60 days
    ['strategy_performance_log', '60 days'] // was 180 days
  ];

  for (const [table, interval] of policies) {
    try {
      await pool.query(`SELECT remove_retention_policy('${table}', if_exists => true)`);
      await pool.query(`SELECT add_retention_policy('${table}', INTERVAL '${interval}')`);
      console.log(`${table}: ${interval}`);
    } catch (e) {
      console.log(`${table} policy error:`, e.message);
    }
  }

  // 5. VACUUM to reclaim space
  console.log('\n--- Running VACUUM ---');
  await pool.query('VACUUM ANALYZE price_history');
  console.log('VACUUM complete');

  // 6. Check size after
  const after = await pool.query("SELECT pg_size_pretty(pg_database_size('tsdb')) as size");
  console.log('\nSize AFTER cleanup:', after.rows[0].size);

  // 7. Check remaining chunks
  const chunks = await pool.query(`
    SELECT count(*) as num_chunks FROM timescaledb_information.chunks WHERE hypertable_name = 'price_history'
  `);
  console.log('Remaining price_history chunks:', chunks.rows[0].num_chunks);

  // 8. Check remaining rows
  const rows = await pool.query('SELECT count(*) as c FROM price_history');
  console.log('Remaining price_history rows:', rows.rows[0].c);

  // 9. Show new retention policies
  console.log('\n=== NEW RETENTION POLICIES ===');
  const jobs = await pool.query(`
    SELECT job_id, application_name, schedule_interval
    FROM timescaledb_information.jobs
    WHERE proc_name = 'policy_retention'
  `);
  jobs.rows.forEach(j => {
    console.log('Job', j.job_id, j.application_name);
  });

  await pool.end();
}

cleanup().catch(console.error);
