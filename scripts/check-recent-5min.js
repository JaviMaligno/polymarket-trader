const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  console.log("=== SIGNALS LAST 5 MINUTES ===");
  const signals = await pool.query(`
    SELECT time, signal_type, direction, confidence, strength
    FROM signal_predictions
    WHERE time > NOW() - INTERVAL '5 minutes'
    ORDER BY time DESC
    LIMIT 20
  `);

  if (signals.rows.length === 0) {
    console.log("✅ No signals in last 5 minutes - thresholds filtering is working!");
  } else {
    console.log("Time     | Type     | Dir   | Conf  | Str   | Meets 0.60/0.45?");
    console.log("-".repeat(70));
    let meetingThreshold = 0;
    signals.rows.forEach(r => {
      const time = new Date(r.time).toISOString().substring(11, 19);
      const type = (r.signal_type || "unknown").substring(0, 8).padEnd(8);
      const dir = r.direction.substring(0, 5).padEnd(5);
      const conf = parseFloat(r.confidence).toFixed(2);
      const str = parseFloat(r.strength).toFixed(2);
      const meets = parseFloat(r.confidence) >= 0.60 && Math.abs(parseFloat(r.strength)) >= 0.45;
      if (meets) meetingThreshold++;
      const check = meets ? "✓" : "✗";
      console.log(time + " | " + type + " | " + dir + " | " + conf + " | " + str.padStart(5) + " | " + check);
    });
    console.log("\nMeeting thresholds: " + meetingThreshold + "/" + signals.rows.length);
  }

  console.log("\n=== TRADES LAST 5 MINUTES ===");
  const trades = await pool.query(`
    SELECT time, side, signal_type, value_usd
    FROM paper_trades
    WHERE time > NOW() - INTERVAL '5 minutes'
    ORDER BY time DESC
    LIMIT 10
  `);

  if (trades.rows.length === 0) {
    console.log("✅ No trades in last 5 minutes - filtering is working or circuit breaker active");
  } else {
    console.log("Time     | Side | Type         | Value");
    console.log("-".repeat(50));
    trades.rows.forEach(r => {
      const time = new Date(r.time).toISOString().substring(11, 19);
      const side = r.side.padEnd(4);
      const type = (r.signal_type || "unknown").substring(0, 12).padEnd(12);
      const value = "$" + parseFloat(r.value_usd).toFixed(2);
      console.log(time + " | " + side + " | " + type + " | " + value);
    });
  }

  await pool.end();
}

check().catch(e => {
  console.error(e);
  process.exit(1);
});
