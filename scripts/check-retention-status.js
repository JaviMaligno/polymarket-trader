const { Pool } = require('pg');

async function check() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // 1. Check database size
    const dbSize = await pool.query("SELECT pg_size_pretty(pg_database_size('tsdb')) as db_size");
    console.log('=== DATABASE SIZE ===');
    console.log('Total:', dbSize.rows[0].db_size);

    // 2. Check retention jobs
    console.log('\n=== RETENTION JOBS ===');
    const jobs = await pool.query(`
      SELECT job_id, application_name, schedule_interval, next_start
      FROM timescaledb_information.jobs
      WHERE proc_name = 'policy_retention'
    `);
    if (jobs.rows.length === 0) {
      console.log('NO RETENTION JOBS FOUND!');
    } else {
      jobs.rows.forEach(j => {
        console.log('Job', j.job_id, ':', j.application_name);
        console.log('  Schedule:', j.schedule_interval);
        console.log('  Next run:', j.next_start);
      });
    }

    // 3. Check all scheduled jobs
    console.log('\n=== ALL TIMESCALEDB JOBS ===');
    const allJobs = await pool.query(`
      SELECT job_id, proc_name, schedule_interval, next_start
      FROM timescaledb_information.jobs
    `);
    allJobs.rows.forEach(j => {
      console.log('Job', j.job_id, j.proc_name, '| interval:', j.schedule_interval);
    });

    // 4. Check table sizes
    console.log('\n=== TABLE SIZES (largest first) ===');
    const tables = await pool.query(`
      SELECT
        relname as table_name,
        pg_size_pretty(pg_total_relation_size(relid)) as total_size,
        pg_total_relation_size(relid) as bytes
      FROM pg_catalog.pg_statio_user_tables
      ORDER BY pg_total_relation_size(relid) DESC
      LIMIT 15
    `);
    tables.rows.forEach(t => {
      console.log(t.table_name.padEnd(30), t.total_size);
    });

    // 5. Check row counts for main tables
    console.log('\n=== ROW COUNTS ===');
    const counts = await pool.query(`
      SELECT 'price_history' as t, count(*) as c FROM price_history
      UNION ALL SELECT 'orderbook_snapshots', count(*) FROM orderbook_snapshots
      UNION ALL SELECT 'trades', count(*) FROM trades
      UNION ALL SELECT 'signal_predictions', count(*) FROM signal_predictions
      UNION ALL SELECT 'paper_orders', count(*) FROM paper_orders
      UNION ALL SELECT 'paper_equity_history', count(*) FROM paper_equity_history
      UNION ALL SELECT 'markets', count(*) FROM markets
    `);
    counts.rows.forEach(r => {
      console.log(r.t.padEnd(25), r.c, 'rows');
    });

    // 6. Check date ranges
    console.log('\n=== DATA DATE RANGES ===');
    const dateRanges = await pool.query(`
      SELECT 'price_history' as t, min(time) as oldest, max(time) as newest FROM price_history
      UNION ALL SELECT 'orderbook_snapshots', min(time), max(time) FROM orderbook_snapshots
      UNION ALL SELECT 'trades', min(time), max(time) FROM trades
    `);
    dateRanges.rows.forEach(r => {
      console.log(r.t.padEnd(25), 'from', r.oldest, 'to', r.newest);
    });

    // 7. Check hypertable info
    console.log('\n=== HYPERTABLE INFO ===');
    const hypertables = await pool.query(`
      SELECT hypertable_name, num_chunks, num_dimensions
      FROM timescaledb_information.hypertables
    `);
    hypertables.rows.forEach(h => {
      console.log(h.hypertable_name.padEnd(25), 'chunks:', h.num_chunks);
    });

    // 8. Check chunks for each hypertable
    console.log('\n=== CHUNK DETAILS ===');
    const chunks = await pool.query(`
      SELECT hypertable_name,
             count(*) as num_chunks,
             pg_size_pretty(sum(total_bytes)) as total_size
      FROM timescaledb_information.chunks
      GROUP BY hypertable_name
      ORDER BY sum(total_bytes) DESC
    `);
    chunks.rows.forEach(c => {
      console.log(c.hypertable_name.padEnd(25), c.num_chunks, 'chunks |', c.total_size);
    });

  } catch (err) {
    console.error('Error:', err.message);
  }

  await pool.end();
}

check();
