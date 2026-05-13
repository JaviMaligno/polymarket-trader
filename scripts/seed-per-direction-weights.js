#!/usr/bin/env node
/**
 * Seed per-direction signal_weights rows from cost-aware t-stat data.
 *
 * PR-D of the per-direction-weights series. Reads cost-aware t-stat
 * measurements (data/cost-aware-tstat-*.json) and per-(market_type) RT cost
 * (either from --rt-cost-json or measured via scripts/measure-rt-cost.js),
 * computes the cost-aware t_net per cell, then writes per-direction rows to
 * signal_weights.
 *
 * Formula:
 *   t_net = t_gross × (gross_pct − rt_cost_pct) / gross_pct
 *   scale = clip(1 + 0.05 × t_net, 0.05, 2.0)
 *   weight_per_direction = current_all_weight × scale
 *
 * Why this scaling:
 *   - scale = 1 when t_net = 0 (preserves current weight under no-evidence).
 *   - scale = 2 when t_net = +20 (strong positive evidence doubles the weight).
 *   - scale = 0.05 floor (clipped) means strongly anti-edge cells get
 *     5% of base, not 0 — preserves a non-degenerate starting point that
 *     Optuna can refine. Pure-zero would freeze the cell completely and
 *     prevent re-exploration.
 *   - 0.05 slope = roughly 1σ of evidence → 5% scale change. Modest;
 *     keeps the seed conservative.
 *
 * For cells where we have NO measurement (event_long, event_short until
 * next measurement cycle), no per-direction rows are written. Combiner
 * falls back to the '__all__' direction row via PR-B's lookup chain.
 *
 * Usage:
 *   DATABASE_URL=postgres://... NODE_TLS_REJECT_UNAUTHORIZED=0 \
 *     node scripts/seed-per-direction-weights.js \
 *       --tstat data/cost-aware-tstat-2026-05-13.json \
 *       [--rt-cost data/rt-cost-2026-05-13.json] \
 *       [--default-rt 0.01] \
 *       [--dry-run]
 *
 * Flags:
 *   --tstat PATH       JSON of t-stat measurements (required).
 *   --rt-cost PATH     JSON of per-market_type RT cost; if omitted, uses the
 *                      rt_cost_assumption_pct from the tstat file's _meta.
 *   --default-rt N     Fallback for market_types without measured RT cost
 *                      (default 0.01 = 1%).
 *   --dry-run          Print planned writes without persisting.
 *   --skip-disabled    Skip signals in SIGNAL_TYPES_DISABLED env (default ON).
 *                      Pass --no-skip-disabled to override.
 *
 * Exit status:
 *   0 — applied (or dry-run completed)
 *   1 — error
 */
const { Pool } = require('pg');
const fs = require('fs');

const DEFAULT_DISABLED = (process.env.SIGNAL_TYPES_DISABLED || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function parseArgs(argv) {
  const args = {
    tstat: null,
    rtCost: null,
    defaultRt: 0.01,
    dryRun: false,
    skipDisabled: true,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--tstat') args.tstat = argv[++i];
    else if (k === '--rt-cost') args.rtCost = argv[++i];
    else if (k === '--default-rt') args.defaultRt = parseFloat(argv[++i]);
    else if (k === '--dry-run') args.dryRun = true;
    else if (k === '--skip-disabled') args.skipDisabled = true;
    else if (k === '--no-skip-disabled') args.skipDisabled = false;
  }
  if (!args.tstat) {
    console.error('Error: --tstat <path> is required.');
    process.exit(1);
  }
  return args;
}

/**
 * Compute t_net from t_gross given the cost.
 * t_net = t_gross × (gross − cost) / gross.
 * Edge case: gross = 0 → t_gross would also be 0 → return 0.
 */
function computeTNet({ t_gross, gross_pct, rt_cost_pct }) {
  if (gross_pct === 0) return 0;
  return t_gross * (gross_pct - rt_cost_pct) / gross_pct;
}

/**
 * Map t_net to a scale multiplier for the existing __all__ weight.
 * clip(1 + 0.05 × t_net, 0.05, 2.0)
 */
function scaleFromTNet(t_net) {
  const raw = 1 + 0.05 * t_net;
  return Math.max(0.05, Math.min(2.0, raw));
}

async function main() {
  const args = parseArgs(process.argv);
  const tstatFile = JSON.parse(fs.readFileSync(args.tstat, 'utf-8'));
  const rtCostMap = args.rtCost ? JSON.parse(fs.readFileSync(args.rtCost, 'utf-8')) : null;
  const fallbackRtPct = tstatFile._meta?.rt_cost_assumption_pct ?? (args.defaultRt * 100);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    // Read current '__all__' weights (base) per (signal, market_type).
    const baseRes = await pool.query(`
      SELECT signal_type, market_type, weight, is_enabled
      FROM signal_weights
      WHERE direction = '__all__' AND market_type != '__global__'
    `);
    const base = new Map();  // key: "sig|type" → { weight, is_enabled }
    for (const r of baseRes.rows) {
      base.set(`${r.signal_type}|${r.market_type}`, {
        weight: Number(r.weight),
        is_enabled: r.is_enabled,
      });
    }

    const writes = [];
    const skipped = [];

    for (const cell of tstatFile.cells) {
      const { signal_id, market_type, direction, n, gross_pct, t_gross } = cell;

      // Skip disabled signals — SIGNAL_TYPES_DISABLED zeros them at combiner
      // level anyway, so per-direction rows here would be wasted writes.
      if (args.skipDisabled && DEFAULT_DISABLED.includes(signal_id)) {
        skipped.push({ signal_id, market_type, direction, reason: 'in SIGNAL_TYPES_DISABLED' });
        continue;
      }

      const baseEntry = base.get(`${signal_id}|${market_type}`);
      if (!baseEntry) {
        skipped.push({ signal_id, market_type, direction, reason: 'no __all__ row for base' });
        continue;
      }
      // Keep is_enabled mirrored from the __all__ row — if upstream disabled
      // the signal globally for this type, per-direction shouldn't override.
      if (!baseEntry.is_enabled) {
        skipped.push({ signal_id, market_type, direction, reason: '__all__ is_enabled=false' });
        continue;
      }
      // Skip cells with zero information (gross=0 and t_gross=0 → static
      // midpoint, no measurable drift). Writing a per-direction row with
      // scale=1.0 would just duplicate the __all__ row. Fallback to __all__
      // via the combiner's lookup chain is cleaner.
      if (gross_pct === 0 && t_gross === 0) {
        skipped.push({ signal_id, market_type, direction, reason: 'zero information (gross=0, t_gross=0)' });
        continue;
      }

      const rtPct = rtCostMap?.[market_type] != null
        ? rtCostMap[market_type] * 100
        : fallbackRtPct;
      const t_net = computeTNet({ t_gross, gross_pct, rt_cost_pct: rtPct });
      const scale = scaleFromTNet(t_net);
      const newWeight = baseEntry.weight * scale;

      writes.push({
        signal_id,
        market_type,
        direction,
        n,
        gross_pct,
        rt_pct: rtPct,
        t_gross,
        t_net: Number(t_net.toFixed(3)),
        base_weight: Number(baseEntry.weight.toFixed(4)),
        scale: Number(scale.toFixed(3)),
        new_weight: Number(newWeight.toFixed(4)),
      });
    }

    // Reporting (always, even in dry-run)
    console.log('');
    console.log(`Seed plan (${writes.length} writes, ${skipped.length} skipped):`);
    console.log('-'.repeat(105));
    console.log(
      [
        'signal'.padEnd(22),
        'type'.padEnd(18),
        'dir'.padEnd(6),
        'n'.padStart(6),
        'gross%'.padStart(8),
        't_gross'.padStart(8),
        't_net'.padStart(8),
        'base'.padStart(8),
        'scale'.padStart(7),
        'new_w'.padStart(8),
      ].join(' | ')
    );
    console.log('-'.repeat(105));
    for (const w of writes) {
      console.log(
        [
          w.signal_id.padEnd(22),
          w.market_type.padEnd(18),
          w.direction.padEnd(6),
          String(w.n).padStart(6),
          w.gross_pct.toFixed(3).padStart(8),
          w.t_gross.toFixed(2).padStart(8),
          w.t_net.toFixed(2).padStart(8),
          w.base_weight.toFixed(3).padStart(8),
          w.scale.toFixed(3).padStart(7),
          w.new_weight.toFixed(3).padStart(8),
        ].join(' | ')
      );
    }
    console.log('-'.repeat(105));

    if (skipped.length > 0) {
      console.log(`\nSkipped (${skipped.length}):`);
      for (const s of skipped) {
        console.log(`  ${s.signal_id}@${s.market_type}:${s.direction} → ${s.reason}`);
      }
    }

    if (args.dryRun) {
      console.log('\n(dry-run — no writes applied)');
      return;
    }

    // Actual writes.
    let applied = 0;
    for (const w of writes) {
      await pool.query(
        `INSERT INTO signal_weights
           (signal_type, market_type, direction, weight, is_enabled, min_confidence, updated_at)
         VALUES ($1, $2, $3, $4, true, 0.0, NOW())
         ON CONFLICT (signal_type, market_type, direction)
         DO UPDATE SET weight = EXCLUDED.weight, updated_at = EXCLUDED.updated_at`,
        [w.signal_id, w.market_type, w.direction, w.new_weight]
      );
      applied++;
    }
    console.log(`\nApplied: ${applied} per-direction rows.`);
  } finally {
    await pool.end();
  }
}

// Only run main() when invoked directly (`node seed-per-direction-weights.js`).
// When required by the unit test, `module.parent` is non-null and we skip exec.
if (require.main === module) {
  main().catch((err) => {
    console.error('Error:', err.message);
    process.exitCode = 1;
  });
}

// Exports for unit tests.
module.exports = { computeTNet, scaleFromTNet };
