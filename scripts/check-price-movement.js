/**
 * Check actual price movements in database
 * Compare to what live feed would see
 */
const { Pool } = require('pg');

async function analyze() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log('=== PRICE MOVEMENT ANALYSIS ===\n');

  // 1. Check price volatility over different timeframes
  console.log('--- Price Movement by Timeframe ---');

  // Get a sample high-volume market
  const sampleMarket = await pool.query(`
    SELECT m.id, m.question, m.clob_token_id_yes as token_id
    FROM markets m
    JOIN price_history ph ON m.id = ph.market_id
    WHERE ph.time > NOW() - INTERVAL '1 hour'
    GROUP BY m.id, m.question, m.clob_token_id_yes
    HAVING COUNT(*) >= 10
    ORDER BY m.volume_24h DESC NULLS LAST
    LIMIT 1
  `);

  if (sampleMarket.rows.length === 0) {
    console.log('No markets with recent price data');
    await pool.end();
    return;
  }

  const { id: marketId, question, token_id } = sampleMarket.rows[0];
  console.log(`Sample market: ${question?.substring(0, 60)}...`);
  console.log(`Token: ${token_id}`);

  // 2. Get raw price data
  const prices = await pool.query(`
    SELECT time, close
    FROM price_history
    WHERE token_id = $1
    ORDER BY time DESC
    LIMIT 100
  `, [token_id]);

  console.log(`\nFound ${prices.rows.length} price points`);

  if (prices.rows.length < 2) {
    console.log('Not enough data');
    await pool.end();
    return;
  }

  // 3. Calculate price changes
  const priceValues = prices.rows.map(r => parseFloat(r.close)).reverse();

  // Calculate momentum (rate of change) for different periods
  const momentum = (values, period) => {
    if (values.length < period + 1) return 0;
    const current = values[values.length - 1];
    const past = values[values.length - 1 - period];
    return past === 0 ? 0 : (current - past) / past;
  };

  const shortMom = momentum(priceValues, 5);
  const mediumMom = momentum(priceValues, 14);
  const longMom = momentum(priceValues, 30);

  console.log('\n--- Momentum Values ---');
  console.log(`Short (5 bars): ${(shortMom * 100).toFixed(4)}%`);
  console.log(`Medium (14 bars): ${(mediumMom * 100).toFixed(4)}%`);
  console.log(`Long (30 bars): ${(longMom * 100).toFixed(4)}%`);

  // 4. Calculate what the signal strength would be
  // Normalize to -1 to +1 range (assuming max momentum is ~50%)
  const normalizeMax = 0.5;
  const shortNorm = Math.max(-1, Math.min(1, shortMom / normalizeMax));
  const mediumNorm = Math.max(-1, Math.min(1, mediumMom / normalizeMax));
  const longNorm = Math.max(-1, Math.min(1, longMom / normalizeMax));

  const priceMomentumStrength = shortNorm * 0.5 + mediumNorm * 0.3 + longNorm * 0.2;
  console.log(`\nPrice momentum strength: ${priceMomentumStrength.toFixed(6)}`);

  // 5. Calculate RSI
  const calculateRSI = (values, period = 14) => {
    if (values.length < period + 1) return 50;
    const changes = [];
    for (let i = 1; i < values.length; i++) {
      changes.push(values[i] - values[i - 1]);
    }
    const gains = changes.map(c => c > 0 ? c : 0);
    const losses = changes.map(c => c < 0 ? Math.abs(c) : 0);

    const avgGain = gains.slice(-period).reduce((a, b) => a + b, 0) / period;
    const avgLoss = losses.slice(-period).reduce((a, b) => a + b, 0) / period;

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  };

  const rsi = calculateRSI(priceValues, 14);
  const rsiStrength = (rsi - 50) / 50;  // Simplified
  console.log(`RSI: ${rsi.toFixed(2)} -> Strength: ${rsiStrength.toFixed(4)}`);

  // 6. Show raw price changes
  console.log('\n--- Recent Price Changes ---');
  const last10 = prices.rows.slice(0, 10);
  for (let i = 0; i < last10.length - 1; i++) {
    const curr = parseFloat(last10[i].close);
    const prev = parseFloat(last10[i + 1].close);
    const change = prev !== 0 ? ((curr - prev) / prev * 100) : 0;
    console.log(`${last10[i].time.toISOString().substring(11, 19)}: ${curr.toFixed(4)} (${change >= 0 ? '+' : ''}${change.toFixed(4)}%)`);
  }

  // 7. Calculate expected combined strength
  const priceMomWeight = 0.35;
  const rsiWeight = 0.25;
  const macdWeight = 0.25;
  const volumeWeight = 0.15;

  // Approximate MACD and volume (would need more data for accurate)
  const macdStrength = 0;  // Approximate
  const volumeStrength = 0;  // Approximate

  const combinedStrength =
    priceMomentumStrength * priceMomWeight +
    rsiStrength * rsiWeight +
    macdStrength * macdWeight +
    volumeStrength * volumeWeight;

  console.log('\n--- Expected Signal Strength ---');
  console.log(`Combined strength: ${combinedStrength.toFixed(6)}`);
  console.log(`Threshold: 0.05`);
  console.log(`Would generate signal: ${Math.abs(combinedStrength) >= 0.05 ? 'YES' : 'NO (too weak)'}`);

  // 8. What strength would be needed
  console.log('\n--- What Would Be Needed ---');
  console.log(`To reach 0.05 strength:`);
  console.log(`  - Price momentum alone: ${(0.05 / priceMomWeight).toFixed(4)}`);
  console.log(`  - Which requires ~${(0.05 / priceMomWeight * 0.5 * 100).toFixed(2)}% price change`);

  // 9. Check multiple markets
  console.log('\n--- Top 10 Markets by Recent Volatility ---');
  const volatileMarkets = await pool.query(`
    SELECT
      m.question,
      ph.token_id,
      COUNT(*) as data_points,
      MIN(ph.close) as min_price,
      MAX(ph.close) as max_price,
      (MAX(ph.close) - MIN(ph.close)) / NULLIF(AVG(ph.close), 0) * 100 as range_pct,
      STDDEV(ph.close) * 100 as stddev_pct
    FROM price_history ph
    JOIN markets m ON ph.market_id = m.id
    WHERE ph.time > NOW() - INTERVAL '1 hour'
    GROUP BY m.question, ph.token_id
    HAVING COUNT(*) >= 5
    ORDER BY range_pct DESC
    LIMIT 10
  `);

  volatileMarkets.rows.forEach((r, i) => {
    console.log(`${i+1}. Range: ${parseFloat(r.range_pct || 0).toFixed(2)}% | StdDev: ${parseFloat(r.stddev_pct || 0).toFixed(4)}% | ${(r.question || '').substring(0, 40)}...`);
  });

  await pool.end();
  console.log('\n=== Analysis Complete ===');
}

analyze().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
