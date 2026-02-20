const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  // Check sample markets from SHORT predictions
  const r = await pool.query(`
    SELECT
      sp.market_id,
      m.id as db_id,
      m.condition_id,
      m.clob_token_id_no,
      m.is_active
    FROM signal_predictions sp
    LEFT JOIN markets m ON sp.market_id = m.id OR sp.market_id = m.condition_id
    WHERE sp.time > NOW() - INTERVAL '1 hour'
      AND sp.direction = 'short'
    LIMIT 5
  `);

  console.log('=== SAMPLE MARKETS FROM SHORT PREDICTIONS ===');
  r.rows.forEach(row => {
    console.log('Signal market_id:', row.market_id);
    console.log('  DB id:', row.db_id || 'NOT FOUND');
    console.log('  condition_id:', row.condition_id || 'null');
    console.log('  NO token:', row.clob_token_id_no ? row.clob_token_id_no.substring(0, 25) + '...' : '>>> NULL <<<');
    console.log('  is_active:', row.is_active);
    console.log('');
  });

  // Check how predictions are recorded vs what SignalEngine receives
  // The predictions use SignalResult.marketId which is ActiveMarket.id
  // ActiveMarket comes from PolymarketService which uses condition_id from CLOB API

  // Compare market_ids in predictions to what's in markets table
  const idMatch = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE m.id = sp.market_id) as matched_by_id,
      COUNT(*) FILTER (WHERE m.condition_id = sp.market_id) as matched_by_condition_id,
      COUNT(*) FILTER (WHERE m.id IS NULL AND m.condition_id IS NULL) as no_match,
      COUNT(*) as total
    FROM signal_predictions sp
    LEFT JOIN markets m ON sp.market_id = m.id OR sp.market_id = m.condition_id
    WHERE sp.time > NOW() - INTERVAL '24 hours'
  `);

  console.log('=== MARKET ID MATCHING (24h predictions) ===');
  const match = idMatch.rows[0];
  console.log('Matched by id:', match.matched_by_id);
  console.log('Matched by condition_id:', match.matched_by_condition_id);
  console.log('No match:', match.no_match);
  console.log('Total:', match.total);

  await pool.end();
}

check().catch(e => { console.error(e); process.exit(1); });
