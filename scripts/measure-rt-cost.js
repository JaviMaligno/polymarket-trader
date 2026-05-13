#!/usr/bin/env node
/**
 * Measure real round-trip execution cost per market_type from `paper_trades`.
 *
 * Real cost = fees + observed slippage on buys. SELL slippage in paper data is
 * 0 (exits use midpoint), so the BUY side carries the round-trip's slippage
 * burden. Computed as:
 *   per_trade_cost_pct = SUM(fee)/SUM(value_usd) + AVG(|slippage_pct|)/100
 *   rt_cost_pct        = 2 × per_trade_cost_pct
 *
 * Window: trades after `paper_account.last_reset_at` only — pre-reset data has
 * different config (direction multiplier flip, fee changes, etc.).
 *
 * Output: JSON map `{ market_type: rt_cost_fraction }` to stdout, plus a
 * formatted table to stderr. Used by `seed-per-direction-weights.js` as the
 * cost prior for t_net scaling.
 *
 * Usage:
 *   DATABASE_URL=postgres://... NODE_TLS_REJECT_UNAUTHORIZED=0 \
 *     node scripts/measure-rt-cost.js [--min-trades N] [--format=json|table]
 *
 * Flags:
 *   --min-trades N  Drop market_types with fewer than N trades (default 10).
 *                   With <N trades the slippage estimate has too much noise.
 *   --format        Default 'both' — table to stderr + JSON to stdout.
 *                   'json' = JSON only; 'table' = table only.
 *   --default-rt    Fallback RT cost for market_types with insufficient data
 *                   (default 0.01 = 1% — close to the empirical 1.08% measured
 *                   2026-05-13 on event_financial/event_long).
 *
 * Empirical reading 2026-05-13 (post-reset 2026-05-11):
 *   event_financial  RT 1.08% (n=49)
 *   event_long       RT 1.06% (n=14)
 *   crypto_*         no data — used default 1.0%
 *   event_short      no data — used default 1.0%
 */
const { Pool } = require('pg');

function parseArgs(argv) {
  const args = { minTrades: 10, format: 'both', defaultRt: 0.01 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--min-trades') args.minTrades = parseInt(argv[++i], 10);
    else if (k.startsWith('--format=')) args.format = k.slice('--format='.length);
    else if (k === '--format') args.format = argv[++i];
    else if (k === '--default-rt') args.defaultRt = parseFloat(argv[++i]);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const res = await pool.query(`
      WITH reset_cutoff AS (
        SELECT last_reset_at FROM paper_account ORDER BY id LIMIT 1
      ),
      trades_with_type AS (
        SELECT t.*, m.market_type
        FROM paper_trades t
        JOIN markets m ON m.id = t.market_id
        CROSS JOIN reset_cutoff
        WHERE t.time >= reset_cutoff.last_reset_at
          AND t.executed_size > 0
          AND t.value_usd > 0
      )
      SELECT
        market_type,
        COUNT(*) AS n_trades,
        SUM(value_usd) AS total_value_usd,
        SUM(fee) AS total_fees,
        AVG(ABS(COALESCE(slippage_pct, 0))) AS avg_slip_pct,
        SUM(fee) / NULLIF(SUM(value_usd), 0) AS fee_rate,
        AVG(ABS(COALESCE(slippage_pct, 0))) / 100.0 AS slip_rate
      FROM trades_with_type
      GROUP BY 1 ORDER BY 1
    `);

    const types = res.rows.filter((r) => Number(r.n_trades) >= args.minTrades);
    const dropped = res.rows.filter((r) => Number(r.n_trades) < args.minTrades);

    const costs = {};
    for (const r of types) {
      const feeRate = Number(r.fee_rate) || 0;
      const slipRate = Number(r.slip_rate) || 0;
      // RT = 2 × per-trade cost (entry + exit). One side carries slippage
      // (BUY), the other doesn't (SELL = midpoint in paper). Fee applies
      // both sides. So RT ≈ 2×fee + slip_buy (≈ 2×slip_rate average).
      costs[r.market_type] = 2 * (feeRate + slipRate);
    }
    // Fill defaults for any known market_type not present in observations.
    // Default is conservative — overestimating cost slightly is safer than
    // under-estimating (the seed multiplier becomes too cautious, not too
    // permissive).
    const ALL_TYPES = ['crypto_intraday', 'crypto_daily', 'event_financial', 'event_short', 'event_long'];
    for (const t of ALL_TYPES) {
      if (!(t in costs)) costs[t] = args.defaultRt;
    }

    if (args.format === 'table' || args.format === 'both') {
      const fmt = (n, w = 8, d = 4) => Number(n).toFixed(d).padStart(w);
      const out = [];
      out.push('');
      out.push(`Real RT execution cost per market_type (post-last-reset, n_min=${args.minTrades})`);
      out.push('-'.repeat(78));
      out.push(`market_type           n_trades   fee_rate   slip_rate     rt_cost`);
      out.push('-'.repeat(78));
      for (const r of types) {
        const feeRate = Number(r.fee_rate) || 0;
        const slipRate = Number(r.slip_rate) || 0;
        const rt = costs[r.market_type];
        out.push(
          `${r.market_type.padEnd(22)}${String(r.n_trades).padStart(8)}  ${fmt(feeRate)}    ${fmt(slipRate)}    ${fmt(rt)}`
        );
      }
      if (dropped.length > 0) {
        out.push('');
        out.push(`Dropped (n < ${args.minTrades}, default=${args.defaultRt}):`);
        for (const r of dropped) {
          out.push(`  ${r.market_type} (n=${r.n_trades})`);
        }
      }
      out.push('-'.repeat(78));
      out.push('');
      process.stderr.write(out.join('\n') + '\n');
    }

    if (args.format === 'json' || args.format === 'both') {
      process.stdout.write(JSON.stringify(costs, null, 2) + '\n');
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exitCode = 1;
});
