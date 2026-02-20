const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  console.log('=== SIGNAL PREDICTIONS STATUS ===\n');

  // 1. Overall status
  const status = await pool.query(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE resolved_at IS NOT NULL) as resolved,
      COUNT(*) FILTER (WHERE resolved_at IS NULL) as unresolved,
      COUNT(*) FILTER (WHERE was_correct = true) as correct,
      COUNT(*) FILTER (WHERE was_correct = false) as incorrect
    FROM signal_predictions
    WHERE time > NOW() - INTERVAL '7 days'
  `);

  const s = status.rows[0];
  console.log('Last 7 days:');
  console.log('  Total predictions:', s.total);
  console.log('  Resolved:', s.resolved, `(${(s.resolved/s.total*100).toFixed(1)}%)`);
  console.log('  Unresolved:', s.unresolved);
  if (parseInt(s.resolved) > 0) {
    const accuracy = s.correct / s.resolved * 100;
    console.log('  Accuracy:', accuracy.toFixed(1) + '%', `(${s.correct}/${s.resolved})`);
  }

  // 2. Age of unresolved predictions
  const unresolvedAge = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE time < NOW() - INTERVAL '1 hour') as older_than_1h,
      COUNT(*) FILTER (WHERE time < NOW() - INTERVAL '6 hours') as older_than_6h,
      COUNT(*) FILTER (WHERE time < NOW() - INTERVAL '24 hours') as older_than_24h,
      MIN(time) as oldest,
      MAX(time) as newest
    FROM signal_predictions
    WHERE resolved_at IS NULL
  `);

  console.log('\n=== UNRESOLVED PREDICTIONS AGE ===');
  const ua = unresolvedAge.rows[0];
  console.log('  Older than 1h:', ua.older_than_1h, '(eligible for resolution)');
  console.log('  Older than 6h:', ua.older_than_6h);
  console.log('  Older than 24h:', ua.older_than_24h);
  console.log('  Oldest:', ua.oldest ? new Date(ua.oldest).toLocaleString() : 'none');
  console.log('  Newest:', ua.newest ? new Date(ua.newest).toLocaleString() : 'none');

  // 3. Check if unresolved predictions have matching prices in price_history
  const priceMatch = await pool.query(`
    SELECT
      COUNT(DISTINCT sp.id) as total_unresolved,
      COUNT(DISTINCT sp.id) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM price_history ph
          WHERE ph.market_id = sp.market_id
          AND ph.time > sp.time
        )
      ) as has_newer_price_same_id,
      COUNT(DISTINCT sp.id) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM price_history ph
          JOIN markets m ON ph.market_id = m.id
          WHERE (m.id = sp.market_id OR m.condition_id = sp.market_id)
          AND ph.time > sp.time
        )
      ) as has_newer_price_via_join
    FROM signal_predictions sp
    WHERE sp.resolved_at IS NULL
      AND sp.time < NOW() - INTERVAL '1 hour'
    LIMIT 1000
  `);

  console.log('\n=== PRICE MATCHING FOR UNRESOLVED PREDICTIONS ===');
  const pm = priceMatch.rows[0];
  console.log('  Total unresolved (>1h old):', pm.total_unresolved);
  console.log('  Has newer price (same market_id):', pm.has_newer_price_same_id);
  console.log('  Has newer price (via markets join):', pm.has_newer_price_via_join);

  // 4. Sample unresolved prediction market_ids vs price_history market_ids
  const sampleIds = await pool.query(`
    SELECT DISTINCT sp.market_id as pred_market_id
    FROM signal_predictions sp
    WHERE sp.resolved_at IS NULL
    ORDER BY sp.market_id
    LIMIT 5
  `);

  const priceIds = await pool.query(`
    SELECT DISTINCT market_id as price_market_id
    FROM price_history
    WHERE time > NOW() - INTERVAL '1 hour'
    LIMIT 5
  `);

  console.log('\n=== SAMPLE MARKET_ID FORMATS ===');
  console.log('Prediction market_ids:');
  sampleIds.rows.forEach(r => console.log('  ', r.pred_market_id));
  console.log('\nPrice_history market_ids:');
  priceIds.rows.forEach(r => console.log('  ', r.price_market_id));

  await pool.end();
}

check().catch(e => { console.error(e); process.exit(1); });
