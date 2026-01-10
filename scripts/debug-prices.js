const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function debug() {
  console.log('=== PRICE DATA DEBUG ===\n');

  // Get a sample market
  const market = await pool.query(`
    SELECT market_id, token_id, COUNT(*) as cnt
    FROM price_history
    WHERE time > NOW() - INTERVAL '1 hour'
    GROUP BY market_id, token_id
    ORDER BY cnt DESC
    LIMIT 1
  `);

  if (market.rows.length === 0) {
    console.log('No recent price data');
    await pool.end();
    return;
  }

  const { market_id, token_id, cnt } = market.rows[0];
  console.log('Sample market:', market_id.substring(0, 30) + '...');
  console.log('Token:', token_id.substring(0, 30) + '...');
  console.log('Data points (1h):', cnt);

  // Get price data for this market
  const prices = await pool.query(`
    SELECT time, close, bid, ask
    FROM price_history
    WHERE market_id = $1
    ORDER BY time DESC
    LIMIT 50
  `, [market_id]);

  console.log('\n--- Last 10 prices ---');
  const closes = [];
  prices.rows.slice(0, 10).forEach(p => {
    const close = parseFloat(p.close);
    closes.push(close);
    console.log(`  ${p.time.toISOString().substring(11, 19)} | close: ${close.toFixed(6)} | bid: ${parseFloat(p.bid || 0).toFixed(6)} | ask: ${parseFloat(p.ask || 0).toFixed(6)}`);
  });

  // Calculate some stats
  console.log('\n--- Price Stats ---');
  const allCloses = prices.rows.map(p => parseFloat(p.close));
  const min = Math.min(...allCloses);
  const max = Math.max(...allCloses);
  const avg = allCloses.reduce((a, b) => a + b, 0) / allCloses.length;
  const range = max - min;

  console.log('Min:', min.toFixed(6));
  console.log('Max:', max.toFixed(6));
  console.log('Avg:', avg.toFixed(6));
  console.log('Range:', range.toFixed(6));
  console.log('Range %:', ((range / avg) * 100).toFixed(4) + '%');

  // Check for zero/null values
  const zeros = allCloses.filter(c => c === 0).length;
  const nans = allCloses.filter(c => isNaN(c)).length;
  console.log('Zero values:', zeros);
  console.log('NaN values:', nans);

  // Calculate momentum manually
  console.log('\n--- Momentum Calculation ---');
  if (allCloses.length >= 6) {
    const current = allCloses[0]; // Most recent
    const past5 = allCloses[5];   // 5 bars ago
    const momentum5 = past5 !== 0 ? (current - past5) / past5 : 0;
    console.log('Current price:', current);
    console.log('Price 5 bars ago:', past5);
    console.log('5-bar momentum:', momentum5.toFixed(6), '(' + (momentum5 * 100).toFixed(4) + '%)');
  }

  // Check unique price values
  const uniqueCloses = [...new Set(allCloses.map(c => c.toFixed(6)))];
  console.log('\n--- Price Uniqueness ---');
  console.log('Total prices:', allCloses.length);
  console.log('Unique prices:', uniqueCloses.length);
  console.log('All same?', uniqueCloses.length === 1 ? 'YES (no movement!)' : 'No');

  await pool.end();
}

debug().catch(e => console.error(e));
