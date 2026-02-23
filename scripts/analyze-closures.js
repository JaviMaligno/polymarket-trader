const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  // What closed them?
  const closedBy = await pool.query(`
    SELECT
      CASE
        WHEN realized_pnl = 0 THEN 'breakeven/reset'
        WHEN realized_pnl > 0 THEN 'profit'
        ELSE 'loss'
      END as result,
      COUNT(*) as cnt
    FROM paper_positions
    WHERE closed_at IS NOT NULL
    GROUP BY 1
  `);
  console.log('Positions closed by result:');
  closedBy.rows.forEach(r => console.log('  ' + r.result + ': ' + r.cnt));

  // Check trades vs positions mismatch
  const buys = await pool.query("SELECT COUNT(*) as cnt FROM paper_trades WHERE side = 'buy' AND time > NOW() - INTERVAL '2 hours'");
  const sells = await pool.query("SELECT COUNT(*) as cnt FROM paper_trades WHERE side = 'sell' AND time > NOW() - INTERVAL '2 hours'");
  console.log('\nLast 2 hours:');
  console.log('  Buy trades:', buys.rows[0].cnt);
  console.log('  Sell trades:', sells.rows[0].cnt);

  // Check positions opened/closed in last 2 hours
  const posOpened = await pool.query("SELECT COUNT(*) as cnt FROM paper_positions WHERE opened_at > NOW() - INTERVAL '2 hours'");
  const posClosed = await pool.query("SELECT COUNT(*) as cnt FROM paper_positions WHERE closed_at > NOW() - INTERVAL '2 hours'");
  console.log('  Positions opened:', posOpened.rows[0].cnt);
  console.log('  Positions closed:', posClosed.rows[0].cnt);

  // Check if positions exist without corresponding sell
  const noSell = await pool.query(`
    SELECT pp.market_id, pp.opened_at, pp.closed_at, pp.realized_pnl
    FROM paper_positions pp
    WHERE pp.closed_at IS NOT NULL
      AND pp.closed_at > NOW() - INTERVAL '2 hours'
      AND NOT EXISTS (
        SELECT 1 FROM paper_trades pt
        WHERE pt.market_id = pp.market_id
          AND pt.side = 'sell'
          AND pt.time BETWEEN pp.opened_at AND pp.closed_at + INTERVAL '1 minute'
      )
    LIMIT 5
  `);
  console.log('\nPositions closed WITHOUT sell trade:');
  if (noSell.rows.length === 0) {
    console.log('  None found');
  } else {
    noSell.rows.forEach(p => {
      const opened = new Date(p.opened_at).toLocaleTimeString('es-ES');
      const closed = new Date(p.closed_at).toLocaleTimeString('es-ES');
      console.log(`  ${p.market_id.substring(0,10)}... | ${opened} -> ${closed} | PnL: ${parseFloat(p.realized_pnl).toFixed(2)}`);
    });
  }

  await pool.end();
}

check().catch(e => { console.error(e); process.exit(1); });
