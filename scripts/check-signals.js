const { Client } = require('pg');

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // Check markets with enough data for signal generation
  const markets = await client.query(`
    SELECT ph.market_id, m.question, COUNT(*) as bars,
           MIN(ph.close) as min_price, MAX(ph.close) as max_price,
           MAX(ph.time) as latest
    FROM price_history ph
    JOIN markets m ON m.id = ph.market_id
    WHERE ph.time > NOW() - INTERVAL '7 days'
    GROUP BY ph.market_id, m.question
    HAVING COUNT(*) >= 50
    ORDER BY COUNT(*) DESC
    LIMIT 10
  `);

  console.log('Markets with 50+ bars (last 7 days):');
  console.log('─'.repeat(80));
  markets.rows.forEach(m => {
    const priceRange = `${parseFloat(m.min_price).toFixed(2)}-${parseFloat(m.max_price).toFixed(2)}`;
    console.log(`${String(m.bars).padStart(4)} bars | ${priceRange.padStart(11)} | ${(m.question || '').slice(0, 50)}`);
  });

  // Check signal_predictions
  console.log('\n\nRecent signal predictions:');
  console.log('─'.repeat(80));
  const signals = await client.query(`
    SELECT * FROM signal_predictions ORDER BY time DESC LIMIT 10
  `);

  if (signals.rows.length === 0) {
    console.log('No signals generated yet!');
  } else {
    signals.rows.forEach(s => {
      console.log(`${s.time.toISOString().slice(0,19)} | ${s.signal_type.padEnd(20)} | ${s.direction.padEnd(5)} | conf: ${parseFloat(s.confidence).toFixed(2)} | str: ${parseFloat(s.strength).toFixed(2)}`);
    });
  }

  // Check if trading system is actually generating signals by looking at logs
  console.log('\n\nChecking paper_trades for recent activity:');
  console.log('─'.repeat(80));
  const trades = await client.query(`
    SELECT * FROM paper_trades ORDER BY time DESC LIMIT 5
  `);

  if (trades.rows.length === 0) {
    console.log('No paper trades recorded');
  } else {
    trades.rows.forEach(t => {
      console.log(`${t.time.toISOString().slice(0,19)} | ${t.side.padEnd(4)} | ${t.signal_type || 'n/a'} | $${parseFloat(t.value_usd).toFixed(2)}`);
    });
  }

  await client.end();
}

run().catch(e => console.error('Error:', e.message));
