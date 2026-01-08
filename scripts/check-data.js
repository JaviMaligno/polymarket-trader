const { Client } = require('pg');

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // Check price_history columns first
  const cols = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'price_history' ORDER BY ordinal_position
  `);
  console.log('Columns:', cols.rows.map(r => r.column_name).join(', '));

  // Check data availability
  const stats = await client.query(`
    SELECT
      COUNT(*) as total,
      COUNT(DISTINCT market_id) as markets,
      MIN(time) as earliest,
      MAX(time) as latest
    FROM price_history
  `);

  console.log('\nPrice History Stats:');
  console.log('  Total rows:', stats.rows[0].total);
  console.log('  Markets:', stats.rows[0].markets);
  console.log('  Range:', stats.rows[0].earliest, 'to', stats.rows[0].latest);

  // Get markets with most data
  const topMarkets = await client.query(`
    SELECT ph.market_id, m.question, COUNT(*) as points
    FROM price_history ph
    JOIN markets m ON ph.market_id = m.id
    GROUP BY ph.market_id, m.question
    HAVING COUNT(*) >= 50
    ORDER BY COUNT(*) DESC
    LIMIT 10
  `);

  console.log('\nMarkets with 50+ data points:');
  topMarkets.rows.forEach(r => {
    console.log('  -', r.points, 'pts:', (r.question || 'no question').slice(0, 50) + '...');
  });

  await client.end();
}

run().catch(e => console.error(e.message));
