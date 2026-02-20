const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  console.log('=== WHY CANT SHORT SIGNALS OPEN "NO" POSITIONS? ===\n');

  // 1. Check max open positions limit
  const positionCount = await pool.query(`
    SELECT COUNT(*) as open_count
    FROM paper_positions
    WHERE closed_at IS NULL
  `);
  console.log('Current open positions:', positionCount.rows[0].open_count);
  console.log('(Max is usually 50 - if at limit, no new positions can open)');

  // 2. Check position counts over time during the last 24h
  const posOverTime = await pool.query(`
    SELECT
      date_trunc('hour', time) as hour,
      COUNT(*) FILTER (WHERE side = 'buy') as buys,
      COUNT(*) FILTER (WHERE side = 'sell') as sells
    FROM paper_trades
    WHERE time > NOW() - INTERVAL '24 hours'
    GROUP BY 1
    ORDER BY 1 DESC
    LIMIT 6
  `);

  console.log('\n=== TRADES BY HOUR (recent) ===');
  console.log('Hour | Buys | Sells');
  posOverTime.rows.forEach(r => {
    const hour = new Date(r.hour).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    console.log(`${hour} | ${r.buys.toString().padStart(4)} | ${r.sells.toString().padStart(4)}`);
  });

  // 3. Check if the issue is signal->executor flow
  // Check signal_predictions with direction=short and see what signal_type they have
  const shortSignalTypes = await pool.query(`
    SELECT signal_type, COUNT(*) as cnt
    FROM signal_predictions
    WHERE time > NOW() - INTERVAL '24 hours'
      AND direction = 'short'
    GROUP BY signal_type
    ORDER BY cnt DESC
  `);

  console.log('\n=== SHORT PREDICTIONS BY SIGNAL TYPE ===');
  shortSignalTypes.rows.forEach(r => {
    console.log(`${r.signal_type}: ${r.cnt}`);
  });

  // 4. THE KEY: Signal predictions are recorded BEFORE executor decides
  // The combined signal goes to executor, but executor doesnt record rejects
  // Check: Is the issue in SignalEngine or AutoSignalExecutor?

  // Check markets used in SHORT predictions - do they have No tokens in DB?
  const marketsInShort = await pool.query(`
    SELECT
      sp.market_id,
      m.id as db_id,
      m.condition_id,
      m.clob_token_id_yes,
      m.clob_token_id_no,
      m.is_active,
      m.current_price_yes
    FROM signal_predictions sp
    LEFT JOIN markets m ON sp.market_id = m.id OR sp.market_id = m.condition_id
    WHERE sp.time > NOW() - INTERVAL '1 hour'
      AND sp.direction = 'short'
    LIMIT 5
  `);

  console.log('\n=== SAMPLE MARKETS FROM SHORT PREDICTIONS ===');
  marketsInShort.rows.forEach(r => {
    console.log(`Signal market_id: ${r.market_id}`);
    console.log(`  DB id: ${r.db_id || 'NOT FOUND'}`);
    console.log(`  condition_id: ${r.condition_id || 'null'}`);
    console.log(`  Yes token: ${r.clob_token_id_yes ? r.clob_token_id_yes.substring(0, 20) + '...' : 'NULL'}`);
    console.log(`  NO token: ${r.clob_token_id_no ? r.clob_token_id_no.substring(0, 20) + '...' : 'NULL'}`);
    console.log(`  is_active: ${r.is_active}`);
    console.log('');
  });

  // 5. CRITICAL: Check if the market_id in predictions matches paper_trades
  // Maybe SHORT signals use a different market_id format than LONG signals?
  const marketIdFormats = await pool.query(`
    SELECT
      'prediction_long' as source,
      LEFT(market_id, 20) as sample_id,
      LENGTH(market_id) as len,
      COUNT(*) as cnt
    FROM signal_predictions
    WHERE time > NOW() - INTERVAL '24 hours' AND direction = 'long'
    GROUP BY LEFT(market_id, 20), LENGTH(market_id)
    LIMIT 3

    UNION ALL

    SELECT
      'prediction_short' as source,
      LEFT(market_id, 20) as sample_id,
      LENGTH(market_id) as len,
      COUNT(*) as cnt
    FROM signal_predictions
    WHERE time > NOW() - INTERVAL '24 hours' AND direction = 'short'
    GROUP BY LEFT(market_id, 20), LENGTH(market_id)
    LIMIT 3

    UNION ALL

    SELECT
      'trade_buy' as source,
      LEFT(market_id, 20) as sample_id,
      LENGTH(market_id) as len,
      COUNT(*) as cnt
    FROM paper_trades
    WHERE time > NOW() - INTERVAL '24 hours' AND side = 'buy'
    GROUP BY LEFT(market_id, 20), LENGTH(market_id)
    LIMIT 3
  `);

  console.log('\n=== MARKET ID FORMAT COMPARISON ===');
  marketIdFormats.rows.forEach(r => {
    console.log(`${r.source}: ${r.sample_id}... (len=${r.len}) x${r.cnt}`);
  });

  await pool.end();
}

check().catch(e => { console.error(e); process.exit(1); });
