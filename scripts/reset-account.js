const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function reset() {
  console.log("=== RESETTING PAPER ACCOUNT ===\n");

  // Get current state
  const before = await pool.query("SELECT * FROM paper_account WHERE id = 1");
  console.log("Before reset:");
  console.log("  Capital: $" + parseFloat(before.rows[0].current_capital).toFixed(2));
  console.log("  Available: $" + parseFloat(before.rows[0].available_capital).toFixed(2));
  console.log("  Total PnL: $" + parseFloat(before.rows[0].total_realized_pnl || 0).toFixed(2));
  console.log("  Trades: " + before.rows[0].total_trades);
  console.log("  Drawdown: " + parseFloat(before.rows[0].max_drawdown || 0).toFixed(2) + "%");

  // Reset account
  await pool.query(`
    UPDATE paper_account SET
      current_capital = 10000,
      available_capital = 10000,
      initial_capital = 10000,
      total_realized_pnl = 0,
      total_unrealized_pnl = 0,
      total_fees_paid = 0,
      max_drawdown = 0,
      peak_equity = 10000,
      winning_trades = 0,
      losing_trades = 0,
      total_trades = 0,
      updated_at = NOW()
    WHERE id = 1
  `);

  console.log("\n✅ Account reset to initial state!");

  // Verify
  const after = await pool.query("SELECT * FROM paper_account WHERE id = 1");
  console.log("\nAfter reset:");
  console.log("  Capital: $" + parseFloat(after.rows[0].current_capital).toFixed(2));
  console.log("  Available: $" + parseFloat(after.rows[0].available_capital).toFixed(2));
  console.log("  Total PnL: $" + parseFloat(after.rows[0].total_realized_pnl || 0).toFixed(2));
  console.log("  Trades: " + after.rows[0].total_trades);
  console.log("  Drawdown: " + parseFloat(after.rows[0].max_drawdown || 0).toFixed(2) + "%");

  // Clear trading halt
  await pool.query(`
    INSERT INTO trading_config (key, value, description, updated_at)
    VALUES ('trading_halted', $1::jsonb, $2, NOW())
    ON CONFLICT (key) DO UPDATE SET
      value = $1::jsonb,
      description = $2,
      updated_at = NOW()
  `, [JSON.stringify({ halted: false, reason: "Manual account reset" }), "Manual account reset"]);

  console.log("\n✅ Trading halt cleared!");

  await pool.end();
}

reset().catch(e => {
  console.error(e);
  process.exit(1);
});
