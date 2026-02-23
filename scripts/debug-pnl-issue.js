const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  // Check what 'side' values positions have
  console.log("=== POSITION SIDE VALUES ===");
  const sides = await pool.query("SELECT side, COUNT(*) as cnt FROM paper_positions GROUP BY side");
  sides.rows.forEach(r => console.log("  " + (r.side || "NULL") + ": " + r.cnt));

  // Check sample positions with the price mismatch
  console.log("\n=== SAMPLE POSITIONS WITH ZERO PNL ===");
  const sample = await pool.query(`
    SELECT
      pp.side,
      pp.avg_entry_price,
      pp.realized_pnl,
      m.current_price_yes,
      m.current_price_no
    FROM paper_positions pp
    LEFT JOIN markets m ON pp.market_id = m.id OR pp.market_id = m.condition_id
    WHERE pp.closed_at IS NOT NULL AND pp.realized_pnl = 0
    ORDER BY pp.closed_at DESC
    LIMIT 5
  `);

  sample.rows.forEach(r => {
    const entry = parseFloat(r.avg_entry_price).toFixed(3);
    const yes = r.current_price_yes ? parseFloat(r.current_price_yes).toFixed(3) : "NULL";
    const no = r.current_price_no ? parseFloat(r.current_price_no).toFixed(3) : "NULL";
    console.log("  Side: " + (r.side || "NULL").padEnd(6) + " | Entry: " + entry + " | Yes: " + yes + " | No: " + no);
  });

  // Check if AutoSignalExecutor is setting side correctly
  console.log("\n=== RECENT OPEN POSITIONS ===");
  const open = await pool.query(`
    SELECT
      pp.side,
      pp.avg_entry_price,
      m.current_price_yes,
      m.current_price_no,
      SUBSTRING(pp.market_id, 1, 20) as market_short
    FROM paper_positions pp
    LEFT JOIN markets m ON pp.market_id = m.id OR pp.market_id = m.condition_id
    WHERE pp.closed_at IS NULL
    LIMIT 5
  `);

  open.rows.forEach(r => {
    const entry = parseFloat(r.avg_entry_price).toFixed(3);
    const yes = r.current_price_yes ? parseFloat(r.current_price_yes).toFixed(3) : "NULL";
    const no = r.current_price_no ? parseFloat(r.current_price_no).toFixed(3) : "NULL";
    console.log("  Side: " + (r.side || "NULL").padEnd(6) + " | Entry: " + entry + " | Yes: " + yes + " | No: " + no);
  });

  await pool.end();
}

check().catch(e => { console.error(e); process.exit(1); });
