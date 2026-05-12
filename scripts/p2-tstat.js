#!/usr/bin/env node
/**
 * P2 per-generator t-stat — gross AND net of execution costs.
 *
 * Why net: gross t-stat measures the average 4h price drift after each
 * prediction, ignoring fees + spread. For low-volatility cohorts the drift
 * is comparable to round-trip cost (~0.5%), so a gross t-stat of +8 can be
 * a net t-stat near zero or negative.  This was empirically falsified on
 * 2026-05-12 (mean_reversion crypto_intraday LONG: gross t=+8 → live 0/7 WR).
 *
 * Reports both side-by-side so allow/block decisions can use the net version.
 *
 * Usage (run from monorepo root or anywhere with DATABASE_URL set):
 *   DATABASE_URL=postgres://... node scripts/p2-tstat.js
 *   DATABASE_URL=postgres://... node scripts/p2-tstat.js --window 3d --rtcost 0.005
 *
 * Flags:
 *   --window N{d|h}  Lookback window for predictions. Default 7d.
 *   --rtcost X       Round-trip cost as fraction (fee+spread). Default 0.005 (0.5%).
 *                     Overrides env P2_ROUND_TRIP_COST.
 *   --horizon Nh     Forward horizon in hours. Default 4h (= MAX_HOLD_TIME_HOURS).
 *   --minn N         Drop cohorts with fewer than N observations. Default 100.
 *
 * Example output:
 *   signal_id          | market_type     | dir   | n     | gross_pct | net_pct | t_gross | t_net
 *   mean_reversion     | event_financial | long  | 2619  | +0.28     | -0.22   | +8.61   | -6.83
 *   ...
 */
const { Pool } = require('pg');

function parseArgs(argv) {
  const args = { window: '7d', rtcost: null, horizon: '4h', minn: 100 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--window') args.window = argv[++i];
    else if (k === '--rtcost') args.rtcost = parseFloat(argv[++i]);
    else if (k === '--horizon') args.horizon = argv[++i];
    else if (k === '--minn') args.minn = parseInt(argv[++i], 10);
  }
  if (args.rtcost == null) {
    args.rtcost = parseFloat(process.env.P2_ROUND_TRIP_COST || '0.005');
  }
  return args;
}

function intervalLiteral(s) {
  // Accept "7d", "24h", "30d" → "INTERVAL '7 days'" etc.
  const m = s.match(/^(\d+)([dh])$/);
  if (!m) throw new Error(`Invalid window/horizon: ${s}`);
  const unit = m[2] === 'd' ? 'days' : 'hours';
  return `INTERVAL '${m[1]} ${unit}'`;
}

async function main() {
  const args = parseArgs(process.argv);
  const windowSql = intervalLiteral(args.window);
  const horizonSql = intervalLiteral(args.horizon);
  const horizonHi = intervalLiteral(args.horizon.replace(/(\d+)([dh])/, (_, n, u) => `${parseInt(n, 10) + 1}${u}`));

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const q = `
      WITH outcomes AS (
        SELECT
          g.signal_id,
          g.market_type,
          g.direction,
          g.yes_price_at_signal::numeric AS y0,
          (
            SELECT p.close::numeric
            FROM price_history p
            WHERE p.market_id = g.market_id
              AND p.time >= g.time + ${horizonSql}
              AND p.time <  g.time + ${horizonHi}
            ORDER BY p.time ASC
            LIMIT 1
          ) AS y1
        FROM generator_predictions g
        WHERE g.time >= NOW() - ${windowSql}
          AND g.direction IN ('long','short')
      ),
      edges AS (
        SELECT
          signal_id, market_type, direction, y0, y1,
          CASE WHEN direction='long' THEN y1 - y0 ELSE y0 - y1 END AS gross_edge
        FROM outcomes
        WHERE y1 IS NOT NULL
      ),
      stats AS (
        SELECT
          signal_id, market_type, direction,
          COUNT(*) AS n,
          AVG(gross_edge) AS mean_gross,
          STDDEV(gross_edge) AS sd_gross
        FROM edges
        GROUP BY 1,2,3
        HAVING COUNT(*) >= $1
      )
      SELECT
        signal_id, market_type, direction, n,
        ROUND((mean_gross * 100)::numeric, 4)            AS gross_pct,
        ROUND(((mean_gross - $2) * 100)::numeric, 4)     AS net_pct,
        CASE WHEN sd_gross > 0 THEN
          ROUND((mean_gross * SQRT(n) / sd_gross)::numeric, 2)
        END AS t_gross,
        CASE WHEN sd_gross > 0 THEN
          ROUND(((mean_gross - $2) * SQRT(n) / sd_gross)::numeric, 2)
        END AS t_net
      FROM stats
      ORDER BY t_net DESC NULLS LAST;
    `;
    const result = await pool.query(q, [args.minn, args.rtcost]);

    const header = ['signal_id', 'market_type', 'direction', 'n', 'gross_pct', 'net_pct', 't_gross', 't_net'];
    const widths = [22, 18, 8, 8, 10, 10, 10, 10];
    console.log(`\nP2 t-stat (window=${args.window}, horizon=${args.horizon}, round-trip cost=${(args.rtcost * 100).toFixed(2)}%, min n=${args.minn})\n`);
    console.log(header.map((h, i) => h.padEnd(widths[i])).join(' | '));
    console.log(widths.map((w) => '-'.repeat(w)).join('-+-'));
    for (const row of result.rows) {
      const tNet = row.t_net != null ? Number(row.t_net) : null;
      const verdict = tNet == null ? '' : tNet >= 2 ? '  ← edge net' : tNet <= -2 ? '  ← anti net' : '';
      const cells = [
        String(row.signal_id),
        String(row.market_type),
        String(row.direction),
        String(row.n),
        row.gross_pct != null ? Number(row.gross_pct).toFixed(4) : '—',
        row.net_pct != null ? Number(row.net_pct).toFixed(4) : '—',
        row.t_gross != null ? Number(row.t_gross).toFixed(2) : '—',
        row.t_net != null ? Number(row.t_net).toFixed(2) : '—',
      ];
      console.log(cells.map((c, i) => c.padEnd(widths[i])).join(' | ') + verdict);
    }
    console.log(`\nNote: t_gross ignores fees + spread. t_net subtracts the round-trip cost from mean edge.`);
    console.log(`Use t_net (not t_gross) for allow/block decisions. See feedback_realistic_costs.md.\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exitCode = 1;
});
