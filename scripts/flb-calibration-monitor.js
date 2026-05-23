#!/usr/bin/env node
/**
 * flb-calibration-monitor.js
 *
 * Lever 2 of the FLB early-failure detection (see [[project_flb_strategy_design]]).
 *
 * The in-sample backtest's structural support for the favorite-longshot bias
 * is the **monotonic calibration gap** across 4 bins in [0.02, 0.10]:
 *   gap[bin] = actual_YES_rate[bin] − mean_entry_YES_price[bin]
 *   in-sample: gap shifts from ≈ −1.9% (0.02-0.04) to ≈ −2.9% (0.08-0.10),
 *   monotone-more-negative as the bin midpoint climbs (longshots in the
 *   higher end of the band are MORE over-priced).
 *
 * If that monotonicity HOLDS forward → bias regime intact (continue).
 * If it BREAKS (all gaps ≥ 0, or slope reverses) → bias regime gone (DEAD).
 *
 * This is a much earlier failure signal than waiting for net/trade t-stat to
 * resolve over a ~6-month tradeable-cohort horizon — calibration moves with
 * outcome alone, no hold-duration dependency.
 *
 * Usage (dashboard container — has pg + DATABASE_URL):
 *   docker cp scripts/flb-calibration-monitor.js polymarket-dashboard-api:/app/flb-cal.js
 *   docker exec polymarket-dashboard-api node /app/flb-cal.js
 *
 * Flags:
 *   --min-ttr-hours 48        in-sample TTR gate (default 48)
 *   --min-n-bin 10            minimum n per bin to score the bin (default 10)
 *   --min-n-pooled 100        minimum forward-resolved pooled n to verdict (default 100)
 */

const { Pool } = require('pg');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const MIN_TTR_HOURS = parseInt(arg('min-ttr-hours', '48'), 10);
const MIN_N_BIN     = parseInt(arg('min-n-bin', '10'), 10);
const MIN_N_POOLED  = parseInt(arg('min-n-pooled', '100'), 10);

const BINS = [
  [0.02, 0.04],
  [0.04, 0.06],
  [0.06, 0.08],
  [0.08, 0.10],
];

function fmtPct(x, digits = 2) {
  if (!Number.isFinite(x)) return '   n/a';
  return (x * 100 >= 0 ? '+' : '') + (x * 100).toFixed(digits) + '%';
}

// Binomial standard error for a proportion p with sample n.
function binomSE(p, n) {
  if (n <= 1) return Infinity;
  return Math.sqrt(p * (1 - p) / n);
}

// Per-bin calibration stat.
function calibrateBin(rows, [lo, hi]) {
  const b = rows.filter(r => {
    const p = Number(r.entry_price);
    return p >= lo && p < hi;
  });
  const n = b.length;
  if (n === 0) {
    return { n: 0, mean_entry: NaN, yes_rate: NaN, gap: NaN, gap_se: NaN };
  }
  const mean_entry = b.reduce((s, r) => s + Number(r.entry_price), 0) / n;
  const yes_count = b.filter(r => r.outcome === 'yes').length;
  const yes_rate = yes_count / n;
  const gap = yes_rate - mean_entry;
  // SE of gap dominated by the proportion's SE (mean_entry is much less noisy).
  const gap_se = binomSE(yes_rate, n);
  return { n, mean_entry, yes_rate, gap, gap_se };
}

// Monotonicity slope: regress gap_bin against bin_midpoint, return slope and
// its t-stat. Negative slope = "more negative gap as price climbs" = in-sample
// pattern.
function monotonicitySlope(bins) {
  const usable = bins.filter(b => b.n > 0 && Number.isFinite(b.gap));
  if (usable.length < 3) return { slope: NaN, t: NaN, n_bins: usable.length };
  const xs = usable.map(b => (b.lo + b.hi) / 2);
  const ys = usable.map(b => b.gap);
  const meanX = xs.reduce((a, x) => a + x, 0) / xs.length;
  const meanY = ys.reduce((a, y) => a + y, 0) / ys.length;
  const num = xs.reduce((a, x, i) => a + (x - meanX) * (ys[i] - meanY), 0);
  const den = xs.reduce((a, x) => a + (x - meanX) ** 2, 0);
  const slope = den > 0 ? num / den : NaN;
  // SE of slope assumes constant variance ≈ pooled gap_se.
  const pooledSE = Math.sqrt(usable.reduce((a, b) => a + (b.gap_se ** 2), 0) / usable.length);
  const slopeSE = pooledSE / Math.sqrt(den);
  const t = (Number.isFinite(slope) && slopeSE > 0) ? slope / slopeSE : NaN;
  return { slope, t, n_bins: usable.length };
}

function verdict(slope, bins, totalN) {
  if (totalN < MIN_N_POOLED) return 'INSUFFICIENT';
  if (!Number.isFinite(slope)) return 'INSUFFICIENT';
  // All bins must have at least MIN_N_BIN to take the verdict seriously.
  const enoughBins = bins.filter(b => b.n >= MIN_N_BIN).length;
  if (enoughBins < 3) return 'INSUFFICIENT';

  const gaps = bins.filter(b => b.n >= MIN_N_BIN).map(b => b.gap);
  const allNonNeg = gaps.every(g => g >= -0.005);   // gaps ≥ −0.5% ⇒ no bias
  if (allNonNeg) return 'BROKEN_NO_BIAS';
  if (slope > 0.0) return 'BROKEN_SLOPE_REVERSED';
  return 'HOLDING';
}

function fmtBinRow(label, bin) {
  const lo = (bin.lo * 100).toFixed(0).padStart(2);
  const hi = (bin.hi * 100).toFixed(0).padStart(2);
  return [
    label.padEnd(10),
    `[${lo}-${hi}%)`.padEnd(9),
    String(bin.n).padStart(5),
    Number.isFinite(bin.mean_entry) ? bin.mean_entry.toFixed(4).padStart(8) : '   n/a'.padStart(8),
    Number.isFinite(bin.yes_rate)   ? (bin.yes_rate * 100).toFixed(1).padStart(7) + '%' : '    n/a'.padStart(8),
    fmtPct(bin.gap).padStart(8),
    Number.isFinite(bin.gap_se) ? (bin.gap_se * 100).toFixed(2).padStart(6) + '%' : '   n/a'.padStart(7),
  ].join(' ');
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  console.log('=== FLB Calibration Monotonicity Monitor ===');
  console.log(`band: 0.02-0.10  bins=${BINS.length}  minTtrHours=${MIN_TTR_HOURS}  minNBin=${MIN_N_BIN}  minNPooled=${MIN_N_POOLED}`);
  console.log('');

  // --- In-sample reference, computed dynamically from flb_backtest_prices ---
  const inSampleSql = `
    WITH resolved AS (
      SELECT id, lower(resolution_outcome) AS outcome, resolved_at, market_type
      FROM markets
      WHERE is_resolved = true
        AND lower(resolution_outcome) IN ('yes','no')
        AND resolved_at IS NOT NULL
    ),
    entry AS (
      SELECT DISTINCT ON (r.id)
        r.id, r.market_type, r.outcome,
        p.yes_price AS entry_price
      FROM resolved r
      JOIN flb_backtest_prices p ON p.market_id = r.id
      WHERE p.ts <= r.resolved_at - ($1 || ' hours')::interval
        AND p.yes_price >= 0.02 AND p.yes_price < 0.10
      ORDER BY r.id, p.ts ASC
    )
    SELECT * FROM entry`;
  const inSample = await pool.query(inSampleSql, [String(MIN_TTR_HOURS)]);

  const inSampleBins = BINS.map(([lo, hi]) => ({ lo, hi, ...calibrateBin(inSample.rows, [lo, hi]) }));
  const inSampleSlope = monotonicitySlope(inSampleBins);
  const inSampleTotal = inSample.rowCount;

  // --- Forward, from flb_shadow_signals where resolved ---
  // entry_yes_price is the in-band qualifying price (recorded once per market).
  // outcome derived from resolved_outcome.
  const fwdSql = `
    SELECT market_type, entry_yes_price AS entry_price, resolved_outcome AS outcome
    FROM flb_shadow_signals
    WHERE resolved_outcome IN ('yes','no')`;
  const fwd = await pool.query(fwdSql);

  const fwdBins = BINS.map(([lo, hi]) => ({ lo, hi, ...calibrateBin(fwd.rows, [lo, hi]) }));
  const fwdSlope = monotonicitySlope(fwdBins);
  const fwdTotal = fwd.rowCount;

  const fwdVerdict = verdict(fwdSlope.slope, fwdBins, fwdTotal);

  // --- Report ---
  const header = [
    'cohort'.padEnd(10),
    'bin'.padEnd(9),
    'n'.padStart(5),
    'meanEntry'.padStart(8),
    'yesRate'.padStart(8),
    'gap'.padStart(8),
    'gapSE'.padStart(7),
  ].join(' ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const b of inSampleBins) console.log(fmtBinRow('in_sample', b));
  console.log('-'.repeat(header.length));
  for (const b of fwdBins) console.log(fmtBinRow('forward', b));
  console.log('');

  console.log('Monotonicity slope (gap vs bin midpoint; negative slope = in-sample pattern):');
  console.log(`  in_sample: slope = ${fmtPct(inSampleSlope.slope, 2).trim()} per 1.0 price unit,  ` +
    `t = ${Number.isFinite(inSampleSlope.t) ? inSampleSlope.t.toFixed(2) : 'n/a'},  ` +
    `bins_used = ${inSampleSlope.n_bins}/${BINS.length},  total n = ${inSampleTotal}`);
  console.log(`  forward:   slope = ${fmtPct(fwdSlope.slope, 2).trim()} per 1.0 price unit,  ` +
    `t = ${Number.isFinite(fwdSlope.t) ? fwdSlope.t.toFixed(2) : 'n/a'},  ` +
    `bins_used = ${fwdSlope.n_bins}/${BINS.length},  total n = ${fwdTotal}`);
  console.log('');

  console.log(`VERDICT (forward, pre-registered): ${fwdVerdict}`);
  console.log('  Rule:');
  console.log(`    INSUFFICIENT  if total_n < ${MIN_N_POOLED} or fewer than 3 bins have n ≥ ${MIN_N_BIN}`);
  console.log('    BROKEN_NO_BIAS         if all bins have gap ≥ −0.5%');
  console.log('    BROKEN_SLOPE_REVERSED  if slope > 0 (longer-odds favorites resolve YES MORE often, not less)');
  console.log('    HOLDING                otherwise (slope < 0, bias regime intact)');
  console.log('');

  // --- Per-type forward calibration (where the resolved sample lives) ---
  console.log('Forward calibration per market_type (resolved-only):');
  const types = [...new Set(fwd.rows.map(r => r.market_type || '(null)'))].sort();
  for (const t of types) {
    const sub = fwd.rows.filter(r => (r.market_type || '(null)') === t);
    if (sub.length === 0) continue;
    console.log(`  ${t} (n=${sub.length}):`);
    for (const [lo, hi] of BINS) {
      const b = { lo, hi, ...calibrateBin(sub, [lo, hi]) };
      if (b.n === 0) continue;
      console.log('    ' + fmtBinRow('', b));
    }
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
