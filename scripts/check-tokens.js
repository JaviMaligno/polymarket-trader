const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  // Check token availability
  const tokenStats = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE clob_token_id_yes IS NOT NULL) as has_yes_token,
      COUNT(*) FILTER (WHERE clob_token_id_no IS NOT NULL) as has_no_token,
      COUNT(*) FILTER (WHERE clob_token_id_yes IS NOT NULL AND clob_token_id_no IS NOT NULL) as has_both,
      COUNT(*) FILTER (WHERE clob_token_id_yes IS NOT NULL AND clob_token_id_no IS NULL) as yes_only,
      COUNT(*) as total
    FROM markets
    WHERE is_active = true
  `);

  console.log('=== MARKET TOKEN AVAILABILITY (Active Markets) ===');
  const stats = tokenStats.rows[0];
  console.log('Total active markets:', stats.total);
  console.log('Has YES token:', stats.has_yes_token);
  console.log('Has NO token:', stats.has_no_token);
  console.log('Has BOTH tokens:', stats.has_both);
  console.log('Has YES only (cannot SHORT):', stats.yes_only);

  const pctMissing = (parseInt(stats.yes_only) / parseInt(stats.total) * 100).toFixed(1);
  console.log(`\n>> ${pctMissing}% of markets CANNOT execute SHORT signals due to missing NO token <<`);

  // Sample some markets to see their structure
  const sample = await pool.query(`
    SELECT id, question, clob_token_id_yes, clob_token_id_no
    FROM markets
    WHERE is_active = true
    LIMIT 5
  `);

  console.log('\n=== SAMPLE MARKETS ===');
  sample.rows.forEach(r => {
    console.log('Question:', (r.question || '').substring(0, 50));
    console.log('  YES token:', r.clob_token_id_yes ? r.clob_token_id_yes.substring(0, 20) + '...' : 'NULL');
    console.log('  NO token:', r.clob_token_id_no ? r.clob_token_id_no.substring(0, 20) + '...' : 'NULL');
  });

  // Check the actual signals database - do we have SHORT signal predictions?
  const signals = await pool.query(`
    SELECT direction, COUNT(*) as cnt
    FROM signal_predictions
    WHERE time > NOW() - INTERVAL '24 hours'
    GROUP BY direction
    ORDER BY cnt DESC
  `);

  console.log('\n=== SIGNAL PREDICTIONS (24h) ===');
  signals.rows.forEach(r => {
    console.log(`${r.direction}: ${r.cnt}`);
  });

  // Check SHORT predictions but see if they could have had NO token
  const shortWithoutToken = await pool.query(`
    SELECT COUNT(*) as cnt
    FROM signal_predictions sp
    LEFT JOIN markets m ON sp.market_id = m.id OR sp.market_id = m.condition_id
    WHERE sp.time > NOW() - INTERVAL '24 hours'
      AND sp.direction = 'short'
      AND m.clob_token_id_no IS NULL
  `);

  console.log('\n=== ROOT CAUSE ANALYSIS ===');
  console.log('SHORT predictions where market has NO NO token:', shortWithoutToken.rows[0].cnt);

  await pool.end();
}

check().catch(e => { console.error(e); process.exit(1); });
