const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  // Check recent price bars for OHLC variation
  const recent = await pool.query(`
    SELECT
      market_id,
      time,
      open, high, low, close,
      (high - low) / NULLIF(close, 0) * 100 as range_pct
    FROM price_history
    WHERE time > NOW() - INTERVAL '30 minutes'
      AND close > 0
    ORDER BY time DESC
    LIMIT 20
  `);

  console.log('=== RECENT PRICE BARS (last 30 min) ===\n');
  console.log('Time     | Market  | Open   | High   | Low    | Close  | Range%');
  console.log('-'.repeat(75));

  let hasVariation = 0;
  recent.rows.forEach(r => {
    const time = new Date(r.time).toISOString().substring(11, 19);
    const o = parseFloat(r.open).toFixed(3);
    const h = parseFloat(r.high).toFixed(3);
    const l = parseFloat(r.low).toFixed(3);
    const c = parseFloat(r.close).toFixed(3);
    const range = parseFloat(r.range_pct).toFixed(2);

    if (parseFloat(range) > 0.1) hasVariation++;

    console.log(time + ' | ' + r.market_id.toString().padEnd(7) + ' | ' + o + ' | ' + h + ' | ' + l + ' | ' + c + ' | ' + range + '%');
  });

  console.log('\nBars with >0.1% variation: ' + hasVariation + '/' + recent.rows.length);

  if (hasVariation === 0) {
    console.log('\n❌ NO VARIATION DETECTED - New code NOT running');
    console.log('Container needs full rebuild from source');
  } else if (hasVariation > 10) {
    console.log('\n✅ VARIATION DETECTED - New code IS running');
  } else {
    console.log('\n⚠️  PARTIAL VARIATION - Checking further...');
  }

  await pool.end();
}

check().catch(console.error);
