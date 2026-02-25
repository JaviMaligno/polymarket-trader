const { Pool } = require('pg');

async function investigate() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    console.log('=== INVESTIGACIÓN DE GENERADORES ===\n');

    // Check if metadata contains generator info
    const sample = await pool.query(`
      SELECT metadata
      FROM signal_predictions
      WHERE time > NOW() - INTERVAL '1 hour'
        AND metadata IS NOT NULL
      LIMIT 5
    `);

    console.log('Sample metadata (first 5):');
    sample.rows.forEach((r, i) => {
      console.log(`${i+1}.`, JSON.stringify(r.metadata));
    });
    console.log('');

    // Check raw generator outputs if metadata exists
    const raw = await pool.query(`
      SELECT
        metadata->>'generator' as generator,
        COUNT(*) as count,
        AVG(confidence) as avg_conf,
        AVG(strength) as avg_str,
        MIN(confidence) as min_conf,
        MAX(confidence) as max_conf,
        MIN(strength) as min_str,
        MAX(strength) as max_str
      FROM signal_predictions
      WHERE time > NOW() - INTERVAL '1 hour'
        AND metadata IS NOT NULL
        AND metadata->>'generator' IS NOT NULL
      GROUP BY metadata->>'generator'
      ORDER BY count DESC
    `);

    console.log('Generadores individuales (última hora):\n');
    if (raw.rows.length > 0) {
      raw.rows.forEach(g => {
        console.log(g.generator || 'unknown');
        console.log('  Count:', g.count);
        console.log('  Conf: avg=' + parseFloat(g.avg_conf).toFixed(2), 'range=[' + parseFloat(g.min_conf).toFixed(2) + '-' + parseFloat(g.max_conf).toFixed(2) + ']');
        console.log('  Str:  avg=' + parseFloat(g.avg_str).toFixed(2), 'range=[' + parseFloat(g.min_str).toFixed(2) + '-' + parseFloat(g.max_str).toFixed(2) + ']');
        console.log('');
      });
    } else {
      console.log('No generator metadata found.\n');
    }

    // Check signal types
    const types = await pool.query(`
      SELECT signal_type, COUNT(*) as count
      FROM signal_predictions
      WHERE time > NOW() - INTERVAL '1 hour'
      GROUP BY signal_type
      ORDER BY count DESC
    `);

    console.log('Tipos de señales (última hora):\n');
    types.rows.forEach(t => {
      console.log('  ' + t.signal_type + ':', t.count);
    });
    console.log('');

    // Get unique signal values to see if they're static
    const uniqueValues = await pool.query(`
      SELECT
        DISTINCT confidence, strength, signal_type
      FROM signal_predictions
      WHERE time > NOW() - INTERVAL '1 hour'
      ORDER BY signal_type, confidence, strength
    `);

    console.log('Valores únicos de señales (última hora):\n');
    console.log('Type         | Conf  | Str');
    console.log('-'.repeat(40));
    uniqueValues.rows.forEach(v => {
      const type = (v.signal_type || 'unknown').padEnd(12);
      const conf = parseFloat(v.confidence).toFixed(2);
      const str = parseFloat(v.strength).toFixed(2);
      console.log(type + ' | ' + conf + ' | ' + str);
    });
    console.log('');
    console.log('Total unique combinations:', uniqueValues.rows.length);

    // Check if generators have price data available
    console.log('\n=== DATOS DE PRECIO DISPONIBLES ===\n');
    const priceData = await pool.query(`
      SELECT
        COUNT(DISTINCT market_id) as markets_with_prices,
        COUNT(*) as total_price_points,
        MIN(time) as oldest,
        MAX(time) as newest
      FROM price_history
      WHERE time > NOW() - INTERVAL '24 hours'
    `);

    console.log('Markets con precio:', priceData.rows[0].markets_with_prices);
    console.log('Puntos de precio:', priceData.rows[0].total_price_points);
    console.log('Oldest:', priceData.rows[0].oldest);
    console.log('Newest:', priceData.rows[0].newest);

    // Check markets being tracked
    const marketsTracked = await pool.query(`
      SELECT COUNT(*) as count FROM markets
      WHERE last_updated > NOW() - INTERVAL '1 hour'
    `);
    console.log('Markets actualizados (última hora):', marketsTracked.rows[0].count);

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await pool.end();
  }
}

investigate().catch(console.error);
