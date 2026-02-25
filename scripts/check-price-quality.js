const { Pool } = require('pg');

async function checkQuality() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    console.log('=== CALIDAD DE PRICE BARS ===\n');

    // Check how many markets have price history
    const marketsWithPrices = await pool.query(`
      SELECT COUNT(DISTINCT m.id) as count
      FROM markets m
      JOIN price_history ph ON ph.market_id = m.id
      WHERE ph.time > NOW() - INTERVAL '24 hours'
    `);

    console.log('Markets con precio (24h):', marketsWithPrices.rows[0].count);

    // Check price variability for a sample market
    const sample = await pool.query(`
      SELECT
        m.id,
        m.question,
        COUNT(ph.*) as price_points,
        MIN(ph.close) as min_price,
        MAX(ph.close) as max_price,
        STDDEV(ph.close) as price_stddev
      FROM markets m
      JOIN price_history ph ON ph.market_id = m.id
      WHERE ph.time > NOW() - INTERVAL '1 hour'
      GROUP BY m.id, m.question
      HAVING COUNT(ph.*) >= 30
      ORDER BY COUNT(ph.*) DESC
      LIMIT 10
    `);

    console.log('\nMercados con más datos (últimahora):\n');
    sample.rows.forEach((m, i) => {
      console.log(`${i+1}. ${m.question.substring(0, 50)}...`);
      console.log(`   Price points: ${m.price_points}`);
      console.log(`   Range: ${parseFloat(m.min_price).toFixed(3)} - ${parseFloat(m.max_price).toFixed(3)}`);
      console.log(`   Volatility (stddev): ${parseFloat(m.price_stddev).toFixed(4)}`);
      console.log('');
    });

    // Check if data-collector is running and collecting prices
    const recentPrices = await pool.query(`
      SELECT
        COUNT(*) as count,
        MAX(time) as latest,
        COUNT(DISTINCT market_id) as unique_markets
      FROM price_history
      WHERE time > NOW() - INTERVAL '5 minutes'
    `);

    console.log('Actividad reciente (últimos 5 min):');
    console.log('  Precios registrados:', recentPrices.rows[0].count);
    console.log('  Markets únicos:', recentPrices.rows[0].unique_markets);
    console.log('  Último precio:', recentPrices.rows[0].latest);

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await pool.end();
  }
}

checkQuality().catch(console.error);
