const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  // Check recent trades
  console.log("=== RECENT TRADES (last 2 hours) ===");
  const trades = await pool.query(`
    SELECT
      time,
      side,
      executed_price,
      value_usd,
      signal_type
    FROM paper_trades
    WHERE time > NOW() - INTERVAL '2 hours'
    ORDER BY time DESC
    LIMIT 20
  `);

  console.log("Time     | Side | Price  | Value     | Signal Type");
  console.log("-".repeat(65));
  trades.rows.forEach(row => {
    const time = new Date(row.time).toISOString().substring(11, 19);
    const side = row.side.padEnd(4);
    const price = parseFloat(row.executed_price).toFixed(3);
    const value = "$" + parseFloat(row.value_usd).toFixed(2).padStart(8);
    const signal = (row.signal_type || "unknown").substring(0, 20);
    console.log(time + " | " + side + " | " + price + " | " + value + " | " + signal);
  });

  // Check if trading resumed after circuit breaker
  console.log("\n=== CIRCUIT BREAKER STATUS ===");
  const lastTrigger = await pool.query(`
    SELECT timestamp FROM circuit_breaker_log ORDER BY timestamp DESC LIMIT 1
  `);

  if (lastTrigger.rows[0]) {
    const timestamp = new Date(lastTrigger.rows[0].timestamp);
    const now = new Date();
    const minutesSince = (now - timestamp) / 1000 / 60;
    console.log("Last trigger: " + timestamp.toISOString());
    console.log("Minutes ago: " + minutesSince.toFixed(1));
    console.log("Cooldown: 30 minutes");
    console.log("Status: " + (minutesSince > 30 ? "SHOULD HAVE RESUMED" : "IN COOLDOWN"));
  }

  // Check account state
  console.log("\n=== ACCOUNT STATE ===");
  const account = await pool.query(`
    SELECT current_capital, initial_capital FROM paper_account WHERE id = 1
  `);
  const current = parseFloat(account.rows[0].current_capital);
  const initial = parseFloat(account.rows[0].initial_capital);
  const drawdown = ((initial - current) / initial * 100).toFixed(2);

  console.log("Capital: $" + current.toFixed(2));
  console.log("Drawdown: " + drawdown + "%");
  console.log("Threshold: 30%");
  console.log("Problem: " + (parseFloat(drawdown) > 30 ? "YES - Drawdown still above threshold!" : "NO"));

  await pool.end();
}

check().catch(e => { console.error(e); process.exit(1); });
