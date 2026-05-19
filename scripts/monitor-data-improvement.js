const { Pool } = require('pg');

async function monitor() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    console.log('=== MONITORING DATA COLLECTION IMPROVEMENTS ===\n');

    // 1. Check data frequency
    console.log('1. DATA FREQUENCY (last hour):');
    const frequency = await pool.query(`
      SELECT
        COUNT(*) as total_points,
        COUNT(DISTINCT market_id) as unique_markets,
        ROUND(COUNT(*)::numeric / COUNT(DISTINCT market_id), 2) as avg_points_per_market
      FROM price_history
      WHERE time > NOW() - INTERVAL '1 hour'
    `);

    console.log('  Total price points:', frequency.rows[0].total_points);
    console.log('  Unique markets:', frequency.rows[0].unique_markets);
    console.log('  Avg points per market:', frequency.rows[0].avg_points_per_market);
    console.log('  Target: >50 points/market/hour\n');

    // 2. Check OHLC variation
    console.log('2. OHLC VARIATION (sample of recent bars):');
    const variation = await pool.query(`
      SELECT
        market_id,
        AVG(ABS(high - low) / NULLIF(close, 0)) * 100 as avg_range_pct,
        COUNT(*) as bars
      FROM price_history
      WHERE time > NOW() - INTERVAL '1 hour'
        AND close > 0
      GROUP BY market_id
      HAVING COUNT(*) >= 10
      ORDER BY avg_range_pct DESC
      LIMIT 10
    `);

    if (variation.rows.length > 0) {
      console.log('  Top 10 markets by price variation:');
      variation.rows.forEach((r, i) => {
        console.log(`    ${i+1}. Market ${r.market_id}: ${parseFloat(r.avg_range_pct).toFixed(3)}% range (${r.bars} bars)`);
      });
      const avgVariation = variation.rows.reduce((sum, r) => sum + parseFloat(r.avg_range_pct), 0) / variation.rows.length;
      console.log(`  Average variation: ${avgVariation.toFixed(3)}%`);
      console.log('  Target: >1% variation\n');
    } else {
      console.log('  Not enough data yet for variation analysis\n');
    }

    // 3. Check signal diversity
    console.log('3. SIGNAL DIVERSITY (last hour):');
    const signals = await pool.query(`
      SELECT
        COUNT(DISTINCT (confidence, strength)) as unique_combinations,
        COUNT(*) as total_signals
      FROM signal_predictions
      WHERE time > NOW() - INTERVAL '1 hour'
    `);

    console.log('  Unique signal combinations:', signals.rows[0].unique_combinations);
    console.log('  Total signals:', signals.rows[0].total_signals);
    console.log('  Target: >50 unique combinations/hour\n');

    // 4. Check data recency
    console.log('4. DATA RECENCY:');
    const recency = await pool.query(`
      SELECT
        MAX(time) as latest_price,
        NOW() - MAX(time) as age
      FROM price_history
    `);

    const ageSeconds = Math.floor(recency.rows[0].age.seconds + recency.rows[0].age.minutes * 60);
    console.log('  Latest price:', recency.rows[0].latest_price);
    console.log('  Age:', ageSeconds, 'seconds');
    console.log('  Target: <120 seconds\n');

    // 5. Data collector status (from logs if available)
    console.log('5. IMPROVEMENT METRICS:');
    const before = { pointsPerHour: 212, avgVariation: 0, uniqueSignals: 6 };
    const after = {
      pointsPerHour: parseInt(frequency.rows[0].total_points),
      avgVariation: variation.rows.length > 0
        ? variation.rows.reduce((sum, r) => sum + parseFloat(r.avg_range_pct), 0) / variation.rows.length
        : 0,
      uniqueSignals: parseInt(signals.rows[0].unique_combinations)
    };

    console.log('  Before improvements:');
    console.log(`    - ${before.pointsPerHour} points/hour`);
    console.log(`    - ${before.avgVariation.toFixed(3)}% variation`);
    console.log(`    - ${before.uniqueSignals} unique signals`);
    console.log('\n  After improvements:');
    console.log(`    - ${after.pointsPerHour} points/hour (${((after.pointsPerHour / before.pointsPerHour - 1) * 100).toFixed(0)}% change)`);
    console.log(`    - ${after.avgVariation.toFixed(3)}% variation`);
    console.log(`    - ${after.uniqueSignals} unique signals (${((after.uniqueSignals / before.uniqueSignals - 1) * 100).toFixed(0)}% change)`);

    console.log('\n=== RECOMMENDATION ===');
    if (after.pointsPerHour > 1000 && after.avgVariation > 1.0 && after.uniqueSignals > 20) {
      console.log('✅ Data quality significantly improved! Consider enabling trading.');
    } else if (after.pointsPerHour > 500) {
      console.log('⏳ Improvements in progress, wait 30-60 minutes for full effect.');
    } else {
      console.log('⚠️  Not enough improvement yet. Check data-collector logs.');
    }

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await pool.end();
  }
}

monitor().catch(console.error);
