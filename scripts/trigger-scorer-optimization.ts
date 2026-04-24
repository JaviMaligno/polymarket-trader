#!/usr/bin/env npx tsx
/**
 * trigger-scorer-optimization.ts - Manual trigger for ScorerWeightOptimizer
 *
 * Runs ScorerWeightOptimizer.optimizeScorerWeights() immediately, bypassing the
 * weekly Monday 03:17 UTC cron. Useful after deploy to run the first post-deploy
 * per-type training pass on demand.
 *
 * Produces per-type weight rows + __global__ row in scorer_weights table.
 * Each type's optimization is logged with market count and correlation achieved.
 *
 * Usage: npx tsx scripts/trigger-scorer-optimization.ts
 *
 * Environment:
 *   DATABASE_URL  PostgreSQL connection string (required)
 *   NODE_TLS_REJECT_UNAUTHORIZED  Set to 0 for cloud DBs (e.g., self-signed certs)
 *
 * Example:
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 DATABASE_URL="postgres://..." \
 *     npx tsx scripts/trigger-scorer-optimization.ts
 */

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  const { readFileSync } = require('fs');
  const content = readFileSync(process.argv[1], 'utf8');
  const match = content.match(/\/\*\*[\s\S]*?\*\//);
  if (match) console.log(match[0].replace(/^\/\*\*|\*\/$/g, '').replace(/^ \* ?/gm, '').trim());
  process.exit(0);
}

import { optimizeScorerWeights } from '../packages/data-collector/src/services/ScorerWeightOptimizer.js';
import { closePool } from '../packages/data-collector/src/database/connection.js';

async function main() {
  console.log('=== ScorerWeightOptimizer Manual Trigger ===\n');

  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL environment variable not set');
    process.exit(1);
  }

  console.log('Running per-type weight optimization...');
  console.log('This may take several minutes depending on trade history.\n');

  try {
    await optimizeScorerWeights();
    console.log('\n✓ Optimization complete. Weights written to scorer_weights table.');
  } catch (err) {
    console.error('\n✗ Optimization failed:', err);
    process.exit(1);
  } finally {
    await closePool();
  }
}

main();
