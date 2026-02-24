const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function verify() {
  console.log("=== VERIFICATION: New Thresholds Active ===\n");

  // Check signals generated after deployment
  const recentSignals = await pool.query(`
    SELECT
      sp.time,
      sp.signal_type,
      sp.direction,
      sp.confidence,
      sp.strength
    FROM signal_predictions sp
    WHERE sp.time > NOW() - INTERVAL '30 minutes'
    ORDER BY sp.time DESC
    LIMIT 20
  `);

  console.log("=== SIGNALS GENERATED (last 30 min) ===");
  if (recentSignals.rows.length === 0) {
    console.log("No signals generated yet (expected if thresholds are working)");
  } else {
    console.log("Time     | Type         | Dir   | Conf  | Str");
    console.log("-".repeat(60));
    recentSignals.rows.forEach(r => {
      const time = new Date(r.time).toISOString().substring(11, 19);
      const type = (r.signal_type || "unknown").substring(0, 12).padEnd(12);
      const dir = r.direction.substring(0, 5).padEnd(5);
      const conf = parseFloat(r.confidence).toFixed(2);
      const str = parseFloat(r.strength).toFixed(2);
      console.log(time + " | " + type + " | " + dir + " | " + conf + " | " + str);
    });

    // Check if signals meet new thresholds
    const belowThreshold = recentSignals.rows.filter(r =>
      parseFloat(r.confidence) < 0.60 || Math.abs(parseFloat(r.strength)) < 0.45
    );
    console.log("\nSignals below new thresholds (0.60 conf, 0.45 str): " + belowThreshold.length);
    console.log("Signals meeting thresholds: " + (recentSignals.rows.length - belowThreshold.length));
  }

  // Check trades after deployment
  console.log("\n=== TRADES EXECUTED (last 30 min) ===");
  const recentTrades = await pool.query(`
    SELECT
      time,
      side,
      signal_type,
      value_usd
    FROM paper_trades
    WHERE time > NOW() - INTERVAL '30 minutes'
    ORDER BY time DESC
    LIMIT 10
  `);

  if (recentTrades.rows.length === 0) {
    console.log("No trades executed (expected if filtering is working)");
  } else {
    console.log("Time     | Side | Signal Type       | Value");
    console.log("-".repeat(55));
    recentTrades.rows.forEach(r => {
      const time = new Date(r.time).toISOString().substring(11, 19);
      const side = r.side.padEnd(4);
      const signal = (r.signal_type || "unknown").substring(0, 17).padEnd(17);
      const value = "$" + parseFloat(r.value_usd).toFixed(2);
      console.log(time + " | " + side + " | " + signal + " | " + value);
    });
  }

  // Check account state
  console.log("\n=== ACCOUNT STATE ===");
  const account = await pool.query(`
    SELECT current_capital, total_trades FROM paper_account WHERE id = 1
  `);
  const capital = parseFloat(account.rows[0].current_capital);
  const trades = account.rows[0].total_trades;
  console.log("Capital: $" + capital.toFixed(2));
  console.log("Total trades: " + trades);
  console.log("Since reset: $" + (capital - 10000).toFixed(2));

  await pool.end();
}

verify().catch(e => {
  console.error(e);
  process.exit(1);
});
