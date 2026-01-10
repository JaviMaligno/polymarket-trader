const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function show() {
  const positions = await pool.query(`
    SELECT
      market_id,
      token_id,
      side,
      size::numeric as size,
      avg_entry_price::numeric as entry,
      current_price::numeric as current,
      unrealized_pnl::numeric as pnl,
      unrealized_pnl_pct::numeric as pnl_pct,
      opened_at
    FROM paper_positions
    WHERE closed_at IS NULL
    ORDER BY unrealized_pnl ASC
  `);

  console.log('=== 8 POSICIONES ABIERTAS ===\n');

  let totalPnl = 0;
  let totalValue = 0;

  positions.rows.forEach((p, i) => {
    const size = parseFloat(p.size);
    const entry = parseFloat(p.entry);
    const current = parseFloat(p.current) || entry;
    const pnl = parseFloat(p.pnl) || 0;
    const pnlPct = parseFloat(p.pnl_pct) || 0;
    const value = size * current;

    totalPnl += pnl;
    totalValue += value;

    const pnlSign = pnl >= 0 ? '+' : '';
    const pnlPctSign = pnlPct >= 0 ? '+' : '';

    console.log((i+1) + '. ' + p.market_id.substring(0, 45) + '...');
    console.log('   Shares: ' + size.toLocaleString() + ' | Entry: $' + entry.toFixed(4) + ' | Current: $' + current.toFixed(4));
    console.log('   Value: $' + value.toFixed(2) + ' | P&L: ' + pnlSign + '$' + pnl.toFixed(2) + ' (' + pnlPctSign + pnlPct.toFixed(2) + '%)');
    console.log('');
  });

  console.log('========================================');
  console.log('TOTAL UNREALIZED P&L: $' + totalPnl.toFixed(2));
  console.log('TOTAL POSITION VALUE: $' + totalValue.toFixed(2));

  await pool.end();
}
show().catch(e => { console.error(e.message); process.exit(1); });
