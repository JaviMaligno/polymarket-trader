/**
 * Run retention policies and cleanup on TimescaleDB
 * Fixes storage crisis (>80% usage)
 */

const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

async function run() {
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log('Connected to TimescaleDB');

    // Check TimescaleDB version
    const versionResult = await client.query(`SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'`);
    console.log(`TimescaleDB version: ${versionResult.rows[0]?.extversion || 'unknown'}`);

    // Check current sizes using hypertable_detailed_size function
    console.log('\n=== Current Hypertable Sizes ===');
    try {
      const hypertables = await client.query(`
        SELECT hypertable_name FROM timescaledb_information.hypertables
      `);
      for (const ht of hypertables.rows) {
        try {
          const sizeResult = await client.query(`SELECT pg_size_pretty(hypertable_size('${ht.hypertable_name}')) as size`);
          console.log(`  ${ht.hypertable_name}: ${sizeResult.rows[0]?.size || 'unknown'}`);
        } catch (e) {
          console.log(`  ${ht.hypertable_name}: error getting size`);
        }
      }
    } catch (e) {
      console.log('Could not get hypertable sizes:', e.message);
    }

    // Check total database size
    const totalSize = await client.query(`SELECT pg_size_pretty(pg_database_size(current_database())) as total`);
    console.log(`\nTotal database size: ${totalSize.rows[0].total}`);

    // Run retention and compression policies
    console.log('\n=== Applying Retention Policies ===');

    const policies = [
      { table: 'orderbook_snapshots', interval: '7 days' },
      { table: 'price_history', interval: '30 days' },
      { table: 'trades', interval: '60 days' },
      { table: 'positions', interval: '90 days' },
      { table: 'paper_orders', interval: '90 days' },
      { table: 'paper_equity_history', interval: '180 days' },
      { table: 'signal_predictions', interval: '60 days' },
      { table: 'strategy_performance_log', interval: '180 days' },
      { table: 'backtest_results', interval: '30 days' },
    ];

    for (const policy of policies) {
      try {
        await client.query(`SELECT add_retention_policy('${policy.table}', INTERVAL '${policy.interval}', if_not_exists => TRUE)`);
        console.log(`  ${policy.table}: retention ${policy.interval} - OK`);
      } catch (e) {
        if (e.message.includes('already exists')) {
          console.log(`  ${policy.table}: retention ${policy.interval} - already exists`);
        } else if (e.message.includes('does not exist')) {
          console.log(`  ${policy.table}: table not found, skipping`);
        } else {
          console.log(`  ${policy.table}: ${e.message}`);
        }
      }
    }

    // Apply compression settings
    console.log('\n=== Applying Compression Settings ===');
    const compressionSettings = [
      { table: 'orderbook_snapshots', after: '1 day' },
      { table: 'price_history', after: '3 days' },
      { table: 'trades', after: '3 days' },
      { table: 'paper_equity_history', after: '7 days' },
      { table: 'signal_predictions', after: '3 days' },
      { table: 'strategy_performance_log', after: '7 days' },
    ];

    for (const cs of compressionSettings) {
      try {
        await client.query(`ALTER TABLE ${cs.table} SET (timescaledb.compress_after = '${cs.after}')`);
        console.log(`  ${cs.table}: compress after ${cs.after} - OK`);
      } catch (e) {
        if (e.message.includes('does not exist')) {
          console.log(`  ${cs.table}: table not found, skipping`);
        } else {
          console.log(`  ${cs.table}: ${e.message}`);
        }
      }
    }

    // Immediate cleanup - drop old chunks
    console.log('\n=== Dropping Old Chunks (Immediate Cleanup) ===');
    const dropChunks = [
      { table: 'orderbook_snapshots', older: '7 days' },
      { table: 'price_history', older: '30 days' },
      { table: 'trades', older: '60 days' },
    ];

    for (const dc of dropChunks) {
      try {
        const result = await client.query(`SELECT drop_chunks('${dc.table}', INTERVAL '${dc.older}')`);
        console.log(`  ${dc.table}: dropped chunks older than ${dc.older}`);
      } catch (e) {
        if (e.message.includes('does not exist')) {
          console.log(`  ${dc.table}: table not found, skipping`);
        } else {
          console.log(`  ${dc.table}: ${e.message}`);
        }
      }
    }

    // Compress existing chunks
    console.log('\n=== Compressing Existing Chunks ===');
    const compressChunks = [
      { table: 'orderbook_snapshots', older: '1 day' },
      { table: 'price_history', older: '3 days' },
      { table: 'trades', older: '3 days' },
    ];

    for (const cc of compressChunks) {
      try {
        const result = await client.query(`
          SELECT compress_chunk(c, if_not_compressed => true)
          FROM show_chunks('${cc.table}', older_than => INTERVAL '${cc.older}') c
        `);
        console.log(`  ${cc.table}: compressed ${result.rowCount || 0} chunks`);
      } catch (e) {
        if (e.message.includes('does not exist')) {
          console.log(`  ${cc.table}: table not found, skipping`);
        } else {
          console.log(`  ${cc.table}: ${e.message}`);
        }
      }
    }

    // Check sizes after cleanup
    console.log('\n=== Sizes After Cleanup ===');
    try {
      const hypertables = await client.query(`
        SELECT hypertable_name FROM timescaledb_information.hypertables
      `);
      for (const ht of hypertables.rows) {
        try {
          const sizeResult = await client.query(`SELECT pg_size_pretty(hypertable_size('${ht.hypertable_name}')) as size`);
          console.log(`  ${ht.hypertable_name}: ${sizeResult.rows[0]?.size || 'unknown'}`);
        } catch (e) {
          // Skip errors
        }
      }
    } catch (e) {
      console.log('Could not get hypertable sizes');
    }

    const newTotalSize = await client.query(`SELECT pg_size_pretty(pg_database_size(current_database())) as total`);
    console.log(`\nTotal database size: ${newTotalSize.rows[0].total}`);

    // List active retention policies
    console.log('\n=== Active Retention Policies ===');
    try {
      const policies = await client.query(`
        SELECT hypertable_name, schedule_interval, config
        FROM timescaledb_information.jobs
        WHERE proc_name = 'policy_retention'
      `);
      for (const row of policies.rows) {
        const dropAfter = row.config?.drop_after || 'unknown';
        console.log(`  ${row.hypertable_name}: drop after ${dropAfter}`);
      }
    } catch (e) {
      console.log('Could not list retention policies:', e.message);
    }

    console.log('\n=== Done ===');

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
