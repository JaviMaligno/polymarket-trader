const { Pool } = require('pg');

async function analyze() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log('=== TABLE ANALYSIS ===\n');

  // 1. Markets table analysis
  console.log('--- MARKETS TABLE ---');
  const marketCount = await pool.query('SELECT count(*) FROM markets');
  console.log('Total markets:', marketCount.rows[0].count);

  const marketsByActive = await pool.query(`
    SELECT is_active, count(*) FROM markets GROUP BY is_active
  `);
  console.log('By active status:');
  marketsByActive.rows.forEach(r => console.log('  is_active=' + r.is_active + ':', r.count));

  // Check if we can reduce markets
  const inactiveSize = await pool.query(`
    SELECT pg_size_pretty(pg_total_relation_size('markets')) as size
  `);
  console.log('Markets table size:', inactiveSize.rows[0].size);

  // 2. Events table analysis
  console.log('\n--- EVENTS TABLE ---');
  const eventCount = await pool.query('SELECT count(*) FROM events');
  console.log('Total events:', eventCount.rows[0].count);

  const eventsByStatus = await pool.query(`
    SELECT is_active, count(*) FROM events GROUP BY is_active
  `);
  console.log('By active status:');
  eventsByStatus.rows.forEach(r => console.log('  is_active=' + r.is_active + ':', r.count));

  // 3. Price history - actual date range after cleanup
  console.log('\n--- PRICE HISTORY ACTUAL ---');
  const priceRange = await pool.query(`
    SELECT min(time) as oldest, max(time) as newest, count(*) as total
    FROM price_history
  `);
  console.log('Date range:', priceRange.rows[0].oldest, 'to', priceRange.rows[0].newest);
  console.log('Total rows:', priceRange.rows[0].total);

  // How many markets are we tracking prices for?
  const trackedMarkets = await pool.query(`
    SELECT count(DISTINCT token_id) FROM price_history
  `);
  console.log('Markets being tracked:', trackedMarkets.rows[0].count);

  // 4. Show growth rate
  console.log('\n--- GROWTH RATE ---');
  const dailyGrowth = await pool.query(`
    SELECT date_trunc('day', time) as day, count(*) as rows
    FROM price_history
    WHERE time > now() - interval '7 days'
    GROUP BY day
    ORDER BY day DESC
    LIMIT 7
  `);
  console.log('Rows per day (last 7 days):');
  dailyGrowth.rows.forEach(r => console.log('  ' + r.day.toISOString().split('T')[0] + ':', r.rows));

  // Calculate average daily growth
  if (dailyGrowth.rows.length > 0) {
    const avgDaily = dailyGrowth.rows.reduce((sum, r) => sum + parseInt(r.rows), 0) / dailyGrowth.rows.length;
    console.log('\nAverage rows/day:', Math.round(avgDaily));
    console.log('Estimated MB/day:', (avgDaily * 100 / 466761 * 160).toFixed(1), 'MB'); // rough estimate
  }

  // 5. Check what tables could potentially be removed
  console.log('\n--- POTENTIALLY REMOVABLE TABLES ---');
  const emptyTables = await pool.query(`
    SELECT
      relname as table_name,
      pg_size_pretty(pg_total_relation_size(relid)) as size,
      n_live_tup as rows
    FROM pg_catalog.pg_stat_user_tables
    WHERE n_live_tup = 0
    ORDER BY pg_total_relation_size(relid) DESC
  `);
  console.log('Empty tables:');
  emptyTables.rows.forEach(t => console.log('  ' + t.table_name.padEnd(30) + t.size));

  await pool.end();
}

analyze().catch(console.error);
