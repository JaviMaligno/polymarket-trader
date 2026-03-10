const { Pool } = require('pg');

async function diagnose() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // 1. Active queries (excluding idle and self)
    console.log('=== ACTIVE QUERIES ===');
    const active = await pool.query(`
      SELECT pid, state, usename, application_name,
             NOW() - query_start AS duration,
             LEFT(query, 120) AS query_preview
      FROM pg_stat_activity
      WHERE state != 'idle'
        AND pid != pg_backend_pid()
      ORDER BY query_start ASC
    `);
    if (active.rows.length === 0) {
      console.log('No active queries (besides this connection).');
    } else {
      console.table(active.rows);
    }

    // 2. Long-running queries (>5s)
    console.log('\n=== LONG-RUNNING QUERIES (>5s) ===');
    const longRunning = await pool.query(`
      SELECT pid, state, usename,
             NOW() - query_start AS duration,
             wait_event_type, wait_event,
             LEFT(query, 200) AS query_preview
      FROM pg_stat_activity
      WHERE state != 'idle'
        AND pid != pg_backend_pid()
        AND NOW() - query_start > INTERVAL '5 seconds'
      ORDER BY query_start ASC
    `);
    if (longRunning.rows.length === 0) {
      console.log('No queries running longer than 5 seconds.');
    } else {
      console.table(longRunning.rows);
    }

    // 3. Table sizes (top 15)
    console.log('\n=== TABLE SIZES (top 15) ===');
    const sizes = await pool.query(`
      SELECT
        schemaname || '.' || relname AS table_name,
        pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
        pg_size_pretty(pg_relation_size(relid)) AS table_size,
        pg_size_pretty(pg_total_relation_size(relid) - pg_relation_size(relid)) AS index_toast_size,
        n_live_tup AS live_rows
      FROM pg_stat_user_tables
      ORDER BY pg_total_relation_size(relid) DESC
      LIMIT 15
    `);
    console.table(sizes.rows);

    // 4. Seq scans vs index scans on top tables
    console.log('\n=== SEQ SCANS vs INDEX SCANS (top 20 by seq_scan) ===');
    const scans = await pool.query(`
      SELECT
        schemaname || '.' || relname AS table_name,
        seq_scan,
        seq_tup_read,
        idx_scan,
        idx_tup_fetch,
        n_live_tup AS live_rows,
        CASE WHEN (seq_scan + COALESCE(idx_scan, 0)) > 0
          THEN ROUND(100.0 * seq_scan / (seq_scan + COALESCE(idx_scan, 0)), 1)
          ELSE 0
        END AS seq_scan_pct
      FROM pg_stat_user_tables
      WHERE seq_scan + COALESCE(idx_scan, 0) > 0
      ORDER BY seq_scan DESC
      LIMIT 20
    `);
    console.table(scans.rows);

    // 5. Potentially missing indexes (high seq_scan, >10000 rows)
    console.log('\n=== POTENTIALLY MISSING INDEXES (seq_scan heavy, >10k rows) ===');
    const missing = await pool.query(`
      SELECT
        schemaname || '.' || relname AS table_name,
        seq_scan,
        seq_tup_read,
        idx_scan,
        n_live_tup AS live_rows,
        pg_size_pretty(pg_total_relation_size(relid)) AS total_size
      FROM pg_stat_user_tables
      WHERE n_live_tup > 10000
        AND seq_scan > COALESCE(idx_scan, 0)
      ORDER BY seq_tup_read DESC
      LIMIT 15
    `);
    if (missing.rows.length === 0) {
      console.log('No tables with suspicious seq scan patterns detected.');
    } else {
      console.table(missing.rows);
    }

    // 6. Existing indexes on price_history
    console.log('\n=== INDEXES ON price_history ===');
    const indexes = await pool.query(`
      SELECT
        indexname,
        indexdef
      FROM pg_indexes
      WHERE tablename = 'price_history'
      ORDER BY indexname
    `);
    if (indexes.rows.length === 0) {
      console.log('No indexes found on price_history (this is a problem!).');
    } else {
      indexes.rows.forEach(r => {
        console.log(`  ${r.indexname}`);
        console.log(`    ${r.indexdef}`);
      });
    }

    // Also check index usage stats for price_history
    console.log('\n=== price_history INDEX USAGE ===');
    const idxUsage = await pool.query(`
      SELECT
        indexrelname AS index_name,
        idx_scan AS scans,
        idx_tup_read AS tuples_read,
        idx_tup_fetch AS tuples_fetched,
        pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
      FROM pg_stat_user_indexes
      WHERE relname = 'price_history'
      ORDER BY idx_scan DESC
    `);
    if (idxUsage.rows.length === 0) {
      console.log('No index usage stats for price_history.');
    } else {
      console.table(idxUsage.rows);
    }

    // 7. price_history stats
    console.log('\n=== price_history STATS ===');
    const phStats = await pool.query(`
      SELECT
        COUNT(*) AS total_rows,
        MIN(time) AS oldest_timestamp,
        MAX(time) AS newest_timestamp,
        COUNT(DISTINCT token_id) AS unique_tokens
      FROM price_history
    `);
    console.table(phStats.rows);

    // Row count by day (last 7 days)
    console.log('\n=== price_history ROWS PER DAY (last 7 days) ===');
    const phDaily = await pool.query(`
      SELECT
        time::date AS day,
        COUNT(*) AS rows,
        COUNT(DISTINCT token_id) AS tokens
      FROM price_history
      WHERE time > NOW() - INTERVAL '7 days'
      GROUP BY time::date
      ORDER BY day DESC
    `);
    console.table(phDaily.rows);

    // 8. Connection count by state
    console.log('\n=== CONNECTIONS BY STATE ===');
    const conns = await pool.query(`
      SELECT
        state,
        COUNT(*) AS count,
        COUNT(DISTINCT usename) AS unique_users
      FROM pg_stat_activity
      GROUP BY state
      ORDER BY count DESC
    `);
    console.table(conns.rows);

    // Total connections vs max
    const maxConns = await pool.query(`SHOW max_connections`);
    const totalConns = await pool.query(`SELECT COUNT(*) AS total FROM pg_stat_activity`);
    console.log(`Total connections: ${totalConns.rows[0].total} / ${maxConns.rows[0].max_connections}`);

    // 9. TimescaleDB background jobs
    console.log('\n=== TIMESCALEDB BACKGROUND JOBS ===');
    try {
      const jobs = await pool.query(`
        SELECT
          job_id,
          application_name,
          schedule_interval,
          max_runtime,
          max_retries,
          proc_schema || '.' || proc_name AS procedure,
          hypertable_schema || '.' || hypertable_name AS hypertable
        FROM timescaledb_information.jobs
        ORDER BY job_id
      `);
      if (jobs.rows.length === 0) {
        console.log('No TimescaleDB background jobs found.');
      } else {
        console.table(jobs.rows);
      }
    } catch (e) {
      console.log('TimescaleDB jobs query failed (not TimescaleDB?):', e.message);
    }

    // Job stats - last run times
    console.log('\n=== TIMESCALEDB JOB STATS (last runs) ===');
    try {
      const jobStats = await pool.query(`
        SELECT
          job_id,
          last_run_status,
          last_run_started_at,
          last_run_duration,
          next_start,
          total_runs,
          total_successes,
          total_failures
        FROM timescaledb_information.job_stats
        ORDER BY job_id
      `);
      if (jobStats.rows.length === 0) {
        console.log('No job stats available.');
      } else {
        console.table(jobStats.rows);
      }
    } catch (e) {
      console.log('TimescaleDB job stats query failed:', e.message);
    }

    // 10. Retention policies
    console.log('\n=== RETENTION POLICIES ===');
    try {
      const retention = await pool.query(`
        SELECT
          j.hypertable_schema || '.' || j.hypertable_name AS hypertable,
          j.schedule_interval,
          config,
          js.last_run_status,
          js.last_run_started_at,
          js.next_start
        FROM timescaledb_information.jobs j
        LEFT JOIN timescaledb_information.job_stats js USING (job_id)
        WHERE j.proc_name = 'policy_retention'
        ORDER BY j.hypertable_name
      `);
      if (retention.rows.length === 0) {
        console.log('No retention policies configured.');
      } else {
        console.table(retention.rows);
      }
    } catch (e) {
      console.log('Retention policies query failed:', e.message);
    }

    // Bonus: Continuous aggregate policies (common CPU culprit)
    console.log('\n=== CONTINUOUS AGGREGATE REFRESH POLICIES ===');
    try {
      const cagg = await pool.query(`
        SELECT
          j.hypertable_schema || '.' || j.hypertable_name AS hypertable,
          j.schedule_interval,
          j.config,
          js.last_run_status,
          js.last_run_duration,
          js.next_start
        FROM timescaledb_information.jobs j
        LEFT JOIN timescaledb_information.job_stats js USING (job_id)
        WHERE j.proc_name = 'policy_refresh_continuous_aggregate'
        ORDER BY j.hypertable_name
      `);
      if (cagg.rows.length === 0) {
        console.log('No continuous aggregate refresh policies.');
      } else {
        console.table(cagg.rows);
      }
    } catch (e) {
      console.log('Continuous aggregate query failed:', e.message);
    }

    // Bonus: Chunk info for price_history (bloat indicator)
    console.log('\n=== price_history CHUNKS ===');
    try {
      const chunks = await pool.query(`
        SELECT
          chunk_schema || '.' || chunk_name AS chunk,
          range_start,
          range_end,
          pg_size_pretty(
            pg_total_relation_size(format('%I.%I', chunk_schema, chunk_name))
          ) AS chunk_size
        FROM timescaledb_information.chunks
        WHERE hypertable_name = 'price_history'
        ORDER BY range_start DESC
        LIMIT 15
      `);
      if (chunks.rows.length === 0) {
        console.log('No chunk information (may not be a hypertable).');
      } else {
        console.table(chunks.rows);
      }
    } catch (e) {
      console.log('Chunk info query failed:', e.message);
    }

    console.log('\n=== DIAGNOSIS COMPLETE ===');

  } finally {
    await pool.end();
  }
}

diagnose().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
