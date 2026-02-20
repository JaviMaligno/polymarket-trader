const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  console.log('=== CHECKING IF SHORT SIGNALS ACTUALLY CREATE "NO" TOKEN TRADES ===\n');

  // When a SHORT signal opens a new position (no existing position to close),
  // it creates a BUY trade for the NO token.
  // So we need to check: are any trades for NO tokens?

  // Get sample trades and see their token_ids
  const sampleTrades = await pool.query(`
    SELECT
      t.time,
      t.market_id,
      t.token_id,
      t.side,
      t.signal_type,
      t.value_usd,
      m.clob_token_id_yes,
      m.clob_token_id_no
    FROM paper_trades t
    LEFT JOIN markets m ON t.market_id = m.id OR t.market_id = m.condition_id
    WHERE t.time > NOW() - INTERVAL '24 hours'
      AND t.side = 'buy'
      AND t.signal_type = 'combined'
    ORDER BY t.time DESC
    LIMIT 10
  `);

  console.log('=== SAMPLE BUY TRADES WITH COMBINED SIGNAL ===');
  sampleTrades.rows.forEach(t => {
    const time = new Date(t.time).toLocaleTimeString('es-ES');
    const isYesToken = t.token_id === t.clob_token_id_yes;
    const isNoToken = t.token_id === t.clob_token_id_no;
    const tokenType = isYesToken ? 'YES' : (isNoToken ? '>>> NO <<<' : 'UNKNOWN');
    console.log(`${time} | ${t.side} | ${tokenType} | $${parseFloat(t.value_usd).toFixed(2)}`);
  });

  // Count trades by token type
  const tokenTypeCount = await pool.query(`
    SELECT
      CASE
        WHEN t.token_id = m.clob_token_id_yes THEN 'YES'
        WHEN t.token_id = m.clob_token_id_no THEN 'NO'
        ELSE 'UNKNOWN'
      END as token_type,
      COUNT(*) as cnt
    FROM paper_trades t
    LEFT JOIN markets m ON t.market_id = m.id OR t.market_id = m.condition_id
    WHERE t.time > NOW() - INTERVAL '24 hours'
      AND t.side = 'buy'
    GROUP BY 1
    ORDER BY cnt DESC
  `);

  console.log('\n=== BUY TRADES BY TOKEN TYPE (24h) ===');
  tokenTypeCount.rows.forEach(r => {
    console.log(`${r.token_type}: ${r.cnt}`);
  });

  // Check if positions have been opened on NO tokens
  const positionSides = await pool.query(`
    SELECT
      CASE
        WHEN pp.token_id = m.clob_token_id_yes THEN 'YES'
        WHEN pp.token_id = m.clob_token_id_no THEN 'NO'
        ELSE 'UNKNOWN'
      END as token_type,
      pp.side,
      COUNT(*) as cnt
    FROM paper_positions pp
    LEFT JOIN markets m ON pp.market_id = m.id OR pp.market_id = m.condition_id
    GROUP BY 1, 2
    ORDER BY cnt DESC
  `);

  console.log('\n=== ALL POSITIONS BY TOKEN TYPE ===');
  positionSides.rows.forEach(r => {
    console.log(`${r.token_type} token | ${r.side} side | count: ${r.cnt}`);
  });

  await pool.end();
}

check().catch(e => { console.error(e); process.exit(1); });
