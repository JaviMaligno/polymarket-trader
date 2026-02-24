const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  console.log("=== CIRCUIT BREAKER TRIGGER ANALYSIS ===\n");

  // Get circuit breaker events from database
  const events = await pool.query(`
    SELECT * FROM circuit_breaker_log
    ORDER BY timestamp DESC
    LIMIT 5
  `);

  if (events.rows.length > 0) {
    console.log("Recent circuit breaker triggers:");
    console.log("Time     | Drawdown | Capital Before | Capital After | Positions");
    console.log("-".repeat(75));
    events.rows.forEach(r => {
      const time = new Date(r.timestamp).toISOString().substring(11, 19);
      const drawdown = parseFloat(r.drawdown_pct).toFixed(1) + "%";
      const before = "$" + parseFloat(r.capital_before).toFixed(2);
      const after = "$" + parseFloat(r.capital_after).toFixed(2);
      console.log(
        time + " | " +
        drawdown.padStart(8) + " | " +
        before.padStart(14) + " | " +
        after.padStart(13) + " | " +
        r.positions_closed
      );
    });
  } else {
    console.log("No circuit breaker events found in database.");
  }

  // Check current account state
  console.log("\n=== CURRENT ACCOUNT STATE ===");
  const account = await pool.query(`
    SELECT current_capital, initial_capital FROM paper_account WHERE id = 1
  `);

  if (account.rows[0]) {
    const current = parseFloat(account.rows[0].current_capital);
    const initial = parseFloat(account.rows[0].initial_capital);
    const drawdown = ((initial - current) / initial * 100).toFixed(2);

    console.log("Initial Capital: $" + initial.toFixed(2));
    console.log("Current Capital: $" + current.toFixed(2));
    console.log("Current Drawdown: " + drawdown + "%");
    console.log("Threshold: 30% (hardcoded in CircuitBreakerService)");
  }

  // Check when positions were closed with circuit_breaker_exit
  console.log("\n=== CIRCUIT BREAKER EXITS (last hour) ===");
  const exits = await pool.query(`
    SELECT time, executed_price, value_usd
    FROM paper_trades
    WHERE side = 'sell' AND signal_type = 'circuit_breaker_exit'
    AND time > NOW() - INTERVAL '1 hour'
    ORDER BY time
    LIMIT 20
  `);

  if (exits.rows.length > 0) {
    console.log("Time     | Exit Price | Value");
    console.log("-".repeat(40));
    exits.rows.forEach(r => {
      const time = new Date(r.time).toISOString().substring(11, 19);
      const price = parseFloat(r.executed_price).toFixed(3);
      const value = "$" + parseFloat(r.value_usd).toFixed(2);
      console.log(time + " | " + price.padStart(10) + " | " + value.padStart(10));
    });
  }

  await pool.end();
}

check().catch(e => { console.error(e); process.exit(1); });
