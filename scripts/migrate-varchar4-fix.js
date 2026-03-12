#!/usr/bin/env node
/**
 * migrate-varchar4-fix.js - Fix VARCHAR(4) overflow on direction/side columns
 *
 * Widens VARCHAR(4) columns that must hold 'short' (5 chars) or 'long' (4 chars)
 * to VARCHAR(8). These were originally defined too narrow, causing:
 *   "error: value too long for type character varying(4)"
 *
 * Affected columns:
 *   - signal_predictions.direction  (was VARCHAR(4), must hold 'long'/'short')
 *   - paper_positions.side          (was VARCHAR(4), must hold 'long'/'short')
 *
 * Safe to run multiple times (ALTER TYPE to wider type is always safe in Postgres).
 *
 * Usage:
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 DATABASE_URL="postgres://..." node scripts/migrate-varchar4-fix.js
 */

const { Client } = require('pg');

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('ERROR: DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const client = new Client({
    connectionString,
    ssl: connectionString.includes('timescale.com') || connectionString.includes('sslmode=require')
      ? { rejectUnauthorized: false }
      : undefined,
  });

  await client.connect();
  console.log('Connected to database');

  const migrations = [
    {
      table: 'signal_predictions',
      column: 'direction',
      newType: 'VARCHAR(8)',
      description: 'Widen direction column to hold "short" (5 chars)',
    },
    {
      table: 'paper_positions',
      column: 'side',
      newType: 'VARCHAR(8)',
      description: 'Widen side column to hold "short" (5 chars)',
    },
  ];

  let allOk = true;
  for (const m of migrations) {
    try {
      // Check current type
      const typeCheck = await client.query(
        `SELECT character_maximum_length
         FROM information_schema.columns
         WHERE table_name = $1 AND column_name = $2`,
        [m.table, m.column]
      );

      if (typeCheck.rows.length === 0) {
        console.log(`SKIP: ${m.table}.${m.column} — table/column not found`);
        continue;
      }

      const currentLen = typeCheck.rows[0].character_maximum_length;
      if (currentLen >= 8) {
        console.log(`OK: ${m.table}.${m.column} already VARCHAR(${currentLen}), no change needed`);
        continue;
      }

      console.log(`MIGRATING: ${m.table}.${m.column} VARCHAR(${currentLen}) → VARCHAR(8) — ${m.description}`);
      await client.query(`ALTER TABLE ${m.table} ALTER COLUMN ${m.column} TYPE VARCHAR(8)`);
      console.log(`  Done.`);
    } catch (err) {
      console.error(`  ERROR on ${m.table}.${m.column}: ${err.message}`);
      allOk = false;
    }
  }

  await client.end();

  if (allOk) {
    console.log('\nMigration complete. Dashboard API should recover on next health check.');
    process.exit(0);
  } else {
    console.error('\nMigration completed with errors.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
