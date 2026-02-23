const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  console.log("=== RECENT SELLS (last 2 hours) ===\n");

  const sells = await pool.query(`
    SELECT
      time,
      signal_type,
      executed_size,
      executed_price,
      value_usd,
      SUBSTRING(market_id, 1, 20) as market_short
    FROM paper_trades
    WHERE side = 'sell' AND time > NOW() - INTERVAL '2 hours'
    ORDER BY time DESC
    LIMIT 15
  `);

  console.log("Time     | Signal Type          | Size   | Price  | Value");
  console.log("-".repeat(70));
  sells.rows.forEach(r => {
    const time = new Date(r.time).toISOString().substring(11, 19);
    const signal = (r.signal_type || "unknown").padEnd(20);
    const size = parseFloat(r.executed_size).toFixed(2).padStart(6);
    const price = parseFloat(r.executed_price).toFixed(3).padStart(6);
    const value = parseFloat(r.value_usd).toFixed(2).padStart(8);
    console.log(time + " | " + signal + " | " + size + " | " + price + " | $" + value);
  });

  // Check signal types distribution
  console.log("\n=== SELL SIGNAL TYPES (24h) ===");
  const signalTypes = await pool.query(`
    SELECT signal_type, COUNT(*) as cnt
    FROM paper_trades
    WHERE side = 'sell' AND time > NOW() - INTERVAL '24 hours'
    GROUP BY signal_type
    ORDER BY cnt DESC
  `);
  signalTypes.rows.forEach(r => console.log("  " + (r.signal_type || "unknown").padEnd(25) + ": " + r.cnt));

  // Check position closures
  console.log("\n=== RECENT POSITION CLOSURES (2h) ===");
  const closures = await pool.query(`
    SELECT
      closed_at,
      realized_pnl,
      EXTRACT(EPOCH FROM (closed_at - opened_at))/60 as hold_minutes
    FROM paper_positions
    WHERE closed_at IS NOT NULL AND closed_at > NOW() - INTERVAL '2 hours'
    ORDER BY closed_at DESC
    LIMIT 10
  `);

  console.log("Closed At  | Realized PnL | Hold Time");
  closures.rows.forEach(r => {
    const time = new Date(r.closed_at).toISOString().substring(11, 19);
    const pnl = parseFloat(r.realized_pnl).toFixed(2).padStart(10);
    const hold = (parseFloat(r.hold_minutes) || 0).toFixed(1).padStart(8) + " min";
    console.log(time + " | $" + pnl + " | " + hold);
  });

  // Buy vs sell ratio
  console.log("\n=== BUY vs SELL RATIO (24h) ===");
  const ratio = await pool.query(`
    SELECT side, COUNT(*) as cnt
    FROM paper_trades
    WHERE time > NOW() - INTERVAL '24 hours'
    GROUP BY side
  `);
  ratio.rows.forEach(r => console.log("  " + r.side.padEnd(5) + ": " + r.cnt));

  await pool.end();
}

check().catch(e => { console.error(e); process.exit(1); });
