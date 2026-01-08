/**
 * Enable compression on TimescaleDB hypertables
 * and compress existing chunks
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

    // Check current database size
    const totalSize = await client.query(`SELECT pg_size_pretty(pg_database_size(current_database())) as total`);
    console.log(`\nCurrent database size: ${totalSize.rows[0].total}`);

    // Get price_history size
    const priceSize = await client.query(`SELECT pg_size_pretty(hypertable_size('price_history')) as size`);
    console.log(`price_history size: ${priceSize.rows[0].size}`);

    // Enable compression on price_history (if not already enabled)
    console.log('\n=== Enabling Compression on price_history ===');
    try {
      await client.query(`
        ALTER TABLE price_history SET (
          timescaledb.compress,
          timescaledb.compress_segmentby = 'market_id, token_id',
          timescaledb.compress_orderby = 'time DESC'
        )
      `);
      console.log('Compression enabled on price_history');
    } catch (e) {
      if (e.message.includes('already')) {
        console.log('Compression already enabled on price_history');
      } else {
        console.log('Error enabling compression:', e.message);
      }
    }

    // Add compression policy (if not already exists)
    console.log('\n=== Adding Compression Policy ===');
    try {
      await client.query(`
        SELECT add_compression_policy('price_history', INTERVAL '3 days', if_not_exists => TRUE)
      `);
      console.log('Compression policy added (compress after 3 days)');
    } catch (e) {
      if (e.message.includes('already exists')) {
        console.log('Compression policy already exists');
      } else {
        console.log('Error adding policy:', e.message);
      }
    }

    // Show chunks for price_history
    console.log('\n=== price_history Chunks ===');
    try {
      const chunks = await client.query(`
        SELECT chunk_name, is_compressed
        FROM timescaledb_information.chunks
        WHERE hypertable_name = 'price_history'
        ORDER BY chunk_name DESC
        LIMIT 20
      `);
      for (const chunk of chunks.rows) {
        console.log(`  ${chunk.chunk_name}: ${chunk.is_compressed ? 'compressed' : 'UNCOMPRESSED'}`);
      }
    } catch (e) {
      console.log('Error listing chunks:', e.message);
    }

    // Manually compress chunks older than 1 day (aggressive)
    console.log('\n=== Compressing Old Chunks (older than 1 day) ===');
    try {
      const result = await client.query(`
        SELECT compress_chunk(c, if_not_compressed => true)
        FROM show_chunks('price_history', older_than => INTERVAL '1 day') c
      `);
      console.log(`Compressed ${result.rowCount || 0} chunks`);
    } catch (e) {
      console.log('Error compressing:', e.message);
    }

    // Check sizes after compression
    console.log('\n=== Sizes After Compression ===');
    const newPriceSize = await client.query(`SELECT pg_size_pretty(hypertable_size('price_history')) as size`);
    console.log(`price_history size: ${newPriceSize.rows[0].size}`);

    const newTotalSize = await client.query(`SELECT pg_size_pretty(pg_database_size(current_database())) as total`);
    console.log(`Total database size: ${newTotalSize.rows[0].total}`);

    // Also enable compression for other tables
    console.log('\n=== Enabling Compression on other tables ===');
    const tablesWithCompression = [
      { table: 'trades', segmentby: 'market_id, token_id', orderby: 'time DESC' },
      { table: 'signal_predictions', segmentby: 'market_id, signal_type', orderby: 'time DESC' },
    ];

    for (const tc of tablesWithCompression) {
      try {
        await client.query(`
          ALTER TABLE ${tc.table} SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = '${tc.segmentby}',
            timescaledb.compress_orderby = '${tc.orderby}'
          )
        `);
        await client.query(`
          SELECT add_compression_policy('${tc.table}', INTERVAL '7 days', if_not_exists => TRUE)
        `);
        console.log(`  ${tc.table}: compression enabled`);
      } catch (e) {
        if (e.message.includes('already')) {
          console.log(`  ${tc.table}: already configured`);
        } else {
          console.log(`  ${tc.table}: ${e.message}`);
        }
      }
    }

    // Final status
    console.log('\n=== Final Status ===');
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

    console.log('\n=== Done ===');

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
