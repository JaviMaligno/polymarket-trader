const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function checkPositions() {
  console.log("=== POSITION SIDES (ALL) ===");
  const sides = await pool.query(`
    SELECT side, COUNT(*) as cnt,
           SUM(CASE WHEN closed_at IS NULL THEN 1 ELSE 0 END) as open_cnt
    FROM paper_positions GROUP BY side ORDER BY side
  `);
  sides.rows.forEach(r =>
    console.log("  " + (r.side || "NULL").padEnd(6) + ": " + r.cnt + " total (" + r.open_cnt + " open)")
  );

  console.log("\n=== RECENT NEW POSITIONS (last 10 min) ===");
  const recent = await pool.query(`
    SELECT side, size, avg_entry_price, opened_at, closed_at
    FROM paper_positions
    WHERE opened_at > NOW() - INTERVAL '10 minutes'
    ORDER BY opened_at DESC
    LIMIT 20
  `);
  console.log("Time     | Side  | Size  | Entry | Status");
  console.log("-".repeat(50));
  recent.rows.forEach(r => {
    const time = new Date(r.opened_at).toISOString().substring(11, 19);
    const status = r.closed_at ? "CLOSED" : "OPEN";
    console.log(
      time + " | " +
      (r.side || "null").padEnd(5) + " | " +
      parseFloat(r.size).toFixed(0).padStart(5) + " | " +
      parseFloat(r.avg_entry_price).toFixed(3) + " | " +
      status
    );
  });

  console.log("\n=== PAPER ACCOUNT ===");
  const acc = await pool.query(`
    SELECT current_capital, available_capital, total_trades, total_realized_pnl
    FROM paper_account WHERE id = 1
  `);
  console.log("  Capital: $" + parseFloat(acc.rows[0].current_capital).toFixed(2));
  console.log("  Available: $" + parseFloat(acc.rows[0].available_capital).toFixed(2));
  console.log("  Trades: " + acc.rows[0].total_trades);
  console.log("  Realized PnL: $" + parseFloat(acc.rows[0].total_realized_pnl || 0).toFixed(2));

  await pool.end();
}

checkPositions().catch(e => { console.error(e); process.exit(1); });
