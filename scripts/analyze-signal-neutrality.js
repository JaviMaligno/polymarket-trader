/**
 * Analyze why signals are returning NEUTRAL
 * Checks price volatility, signal components, and thresholds
 */
const { Pool } = require('pg');

async function analyze() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log('=== SIGNAL NEUTRALITY ANALYSIS ===\n');

  // 1. Check recent signal predictions
  console.log('--- Recent Signal Predictions ---');
  const signals = await pool.query(`
    SELECT market_id, signal_type, direction, strength, confidence, metadata, time
    FROM signal_predictions
    ORDER BY time DESC
    LIMIT 10
  `);

  if (signals.rows.length === 0) {
    console.log('No signal predictions found!');
  } else {
    signals.rows.forEach(s => {
      console.log(`Market: ${s.market_id.substring(0, 20)}...`);
      console.log(`  Type: ${s.signal_type} | Direction: ${s.direction} | Strength: ${s.strength ? parseFloat(s.strength).toFixed(4) : 'N/A'} | Confidence: ${s.confidence ? parseFloat(s.confidence).toFixed(4) : 'N/A'}`);
      if (s.metadata) {
        console.log(`  Metadata: ${JSON.stringify(s.metadata)}`);
      }
      console.log('');
    });
  }

  // 2. Check price volatility for top markets
  console.log('\n--- Price Volatility (Last 24h) ---');
  const priceVolatility = await pool.query(`
    SELECT
      token_id,
      COUNT(*) as data_points,
      MIN(close) as min_price,
      MAX(close) as max_price,
      AVG(close) as avg_price,
      STDDEV(close) as stddev_price,
      (MAX(close) - MIN(close)) / NULLIF(AVG(close), 0) * 100 as range_pct
    FROM price_history
    WHERE time > NOW() - INTERVAL '24 hours'
    GROUP BY token_id
    ORDER BY range_pct DESC NULLS LAST
    LIMIT 10
  `);

  if (priceVolatility.rows.length === 0) {
    console.log('No price data in last 24 hours!');
  } else {
    console.log('Top 10 tokens by price range:');
    priceVolatility.rows.forEach((r, i) => {
      const rangePct = r.range_pct ? parseFloat(r.range_pct).toFixed(2) : 'N/A';
      const stddev = r.stddev_price ? parseFloat(r.stddev_price).toFixed(4) : 'N/A';
      console.log(`  ${i+1}. Range: ${rangePct}% | StdDev: ${stddev} | Points: ${r.data_points} | Token: ${r.token_id.substring(0, 20)}...`);
    });
  }

  // 3. Check how much price data we have
  console.log('\n--- Price Data Coverage ---');
  const coverage = await pool.query(`
    SELECT
      COUNT(DISTINCT token_id) as tokens,
      COUNT(*) as total_rows,
      MIN(time) as oldest,
      MAX(time) as newest
    FROM price_history
  `);
  const c = coverage.rows[0];
  console.log(`Tokens with data: ${c.tokens}`);
  console.log(`Total rows: ${c.total_rows}`);
  console.log(`Date range: ${c.oldest} to ${c.newest}`);

  // 4. Check recent price history for a specific market
  console.log('\n--- Sample Market Price History (Last 2 hours) ---');
  const sampleMarket = await pool.query(`
    SELECT DISTINCT ON (market_id) market_id, token_id
    FROM price_history
    WHERE time > NOW() - INTERVAL '2 hours'
    LIMIT 1
  `);

  if (sampleMarket.rows.length > 0) {
    const { market_id, token_id } = sampleMarket.rows[0];
    console.log(`Market: ${market_id.substring(0, 30)}...`);

    const recentPrices = await pool.query(`
      SELECT time, close
      FROM price_history
      WHERE token_id = $1 AND time > NOW() - INTERVAL '2 hours'
      ORDER BY time DESC
      LIMIT 20
    `, [token_id]);

    console.log('Recent prices:');
    recentPrices.rows.forEach(r => {
      console.log(`  ${r.time.toISOString()} | ${parseFloat(r.close).toFixed(4)}`);
    });
  }

  // 5. Check signal thresholds vs actual strength distribution
  console.log('\n--- Signal Strength Distribution ---');
  const strengthDist = await pool.query(`
    SELECT
      CASE
        WHEN strength IS NULL THEN 'NULL'
        WHEN ABS(strength) < 0.05 THEN '< 0.05 (too weak)'
        WHEN ABS(strength) < 0.1 THEN '0.05-0.1 (NEUTRAL zone)'
        WHEN ABS(strength) < 0.2 THEN '0.1-0.2 (weak signal)'
        WHEN ABS(strength) < 0.3 THEN '0.2-0.3 (moderate signal)'
        ELSE '> 0.3 (strong signal)'
      END as strength_range,
      COUNT(*) as count
    FROM signal_predictions
    WHERE time > NOW() - INTERVAL '24 hours'
    GROUP BY strength_range
    ORDER BY count DESC
  `);

  if (strengthDist.rows.length === 0) {
    console.log('No signals in last 24 hours');
  } else {
    strengthDist.rows.forEach(r => {
      console.log(`  ${r.strength_range}: ${r.count}`);
    });
  }

  // 6. Check confidence distribution
  console.log('\n--- Confidence Distribution ---');
  const confDist = await pool.query(`
    SELECT
      CASE
        WHEN confidence IS NULL THEN 'NULL'
        WHEN confidence < 0.1 THEN '< 0.1 (very low)'
        WHEN confidence < 0.2 THEN '0.1-0.2 (low)'
        WHEN confidence < 0.3 THEN '0.2-0.3 (below threshold)'
        WHEN confidence < 0.4 THEN '0.3-0.4 (near threshold)'
        WHEN confidence < 0.5 THEN '0.4-0.5 (above threshold)'
        ELSE '> 0.5 (high)'
      END as conf_range,
      COUNT(*) as count
    FROM signal_predictions
    WHERE time > NOW() - INTERVAL '24 hours'
    GROUP BY conf_range
    ORDER BY count DESC
  `);

  if (confDist.rows.length === 0) {
    console.log('No signals in last 24 hours');
  } else {
    confDist.rows.forEach(r => {
      console.log(`  ${r.conf_range}: ${r.count}`);
    });
  }

  // 7. Check if markets have enough data points for signal calculation
  console.log('\n--- Data Points Per Market (Last 24h) ---');
  const dataPoints = await pool.query(`
    SELECT
      market_id,
      COUNT(*) as points,
      MIN(time) as first_point,
      MAX(time) as last_point
    FROM price_history
    WHERE time > NOW() - INTERVAL '24 hours'
    GROUP BY market_id
    ORDER BY points DESC
    LIMIT 5
  `);

  console.log('Top 5 markets by data points:');
  dataPoints.rows.forEach((r, i) => {
    console.log(`  ${i+1}. ${r.points} points | ${r.market_id.substring(0, 40)}...`);
  });

  // 8. Check strategy parameters
  console.log('\n--- Active Strategy Parameters ---');
  const strategy = await pool.query(`
    SELECT name, params FROM saved_strategies WHERE is_active = true LIMIT 1
  `);

  if (strategy.rows.length > 0) {
    console.log(`Strategy: ${strategy.rows[0].name}`);
    console.log(`Params: ${JSON.stringify(strategy.rows[0].params, null, 2)}`);
  } else {
    console.log('No active strategy found');
  }

  await pool.end();
  console.log('\n=== Analysis Complete ===');
}

analyze().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
