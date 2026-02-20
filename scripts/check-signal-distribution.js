const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  console.log('=== SIGNAL PREDICTION ANALYSIS ===\n');

  // Check signal predictions distribution
  const predictions = await pool.query(`
    SELECT
      direction,
      COUNT(*) as count,
      AVG(confidence) as avg_confidence,
      AVG(ABS(strength)) as avg_strength
    FROM signal_predictions
    WHERE created_at > NOW() - INTERVAL '24 hours'
    GROUP BY direction
  `);
  console.log('Signal Directions Generated:');
  predictions.rows.forEach(r => {
    console.log('  ' + r.direction + ': ' + r.count + ' signals (avg conf: ' + parseFloat(r.avg_confidence || 0).toFixed(3) + ', avg str: ' + parseFloat(r.avg_strength || 0).toFixed(3) + ')');
  });

  // Check if SHORT signals are being generated
  const shortSignals = await pool.query(`
    SELECT COUNT(*) as count
    FROM signal_predictions
    WHERE created_at > NOW() - INTERVAL '24 hours'
      AND direction = 'short'
  `);
  console.log('\nSHORT signals generated:', shortSignals.rows[0].count);

  // Check if SHORT signals meet thresholds
  const shortMeetingThresholds = await pool.query(`
    SELECT COUNT(*) as count
    FROM signal_predictions
    WHERE created_at > NOW() - INTERVAL '24 hours'
      AND direction = 'short'
      AND confidence >= 0.43
      AND ABS(strength) >= 0.27
  `);
  console.log('SHORT signals meeting thresholds (conf>=0.43, str>=0.27):', shortMeetingThresholds.rows[0].count);

  // Check sample of SHORT signals
  console.log('\n=== SAMPLE SHORT SIGNALS ===');
  const sampleShort = await pool.query(`
    SELECT
      market_id,
      direction,
      confidence,
      strength,
      created_at
    FROM signal_predictions
    WHERE created_at > NOW() - INTERVAL '6 hours'
      AND direction = 'short'
    ORDER BY created_at DESC
    LIMIT 10
  `);
  if (sampleShort.rows.length === 0) {
    console.log('No SHORT signals in last 6 hours!');
  } else {
    sampleShort.rows.forEach(r => {
      const time = new Date(r.created_at).toISOString().substring(11, 19);
      console.log('  ' + time + ' | conf: ' + parseFloat(r.confidence).toFixed(3) + ' | str: ' + parseFloat(r.strength).toFixed(3) + ' | ' + r.market_id.substring(0, 12) + '...');
    });
  }

  // Check the token_id in paper_trades to see if it's Yes or No tokens
  console.log('\n=== TOKEN TYPE IN TRADES ===');
  const tokenTypes = await pool.query(`
    SELECT
      CASE
        WHEN pt.token_id = m.clob_token_id_yes THEN 'Yes token'
        WHEN pt.token_id = m.clob_token_id_no THEN 'No token'
        ELSE 'Unknown'
      END as token_type,
      COUNT(*) as count
    FROM paper_trades pt
    LEFT JOIN markets m ON pt.market_id = m.id
    WHERE pt.time > NOW() - INTERVAL '24 hours'
      AND pt.signal_type = 'combined'
    GROUP BY token_type
  `);
  tokenTypes.rows.forEach(r => {
    console.log('  ' + r.token_type + ': ' + r.count + ' trades');
  });

  await pool.end();
}

check().catch(e => { console.error(e); process.exit(1); });
