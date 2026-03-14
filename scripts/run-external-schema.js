#!/usr/bin/env node
/**
 * run-external-schema.js - Apply 004_external_data_schema migration
 *
 * Creates the external_signals and market_crossref tables needed for
 * cross-platform market correlation signals. Safe to run multiple times
 * (uses IF NOT EXISTS).
 *
 * Usage: node scripts/run-external-schema.js
 *
 * Environment:
 *   DATABASE_URL  PostgreSQL connection string (required)
 *
 * Example:
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 DATABASE_URL="postgres://..." node scripts/run-external-schema.js
 */

const { Client } = require('pg');

const statements = [
  // Cross-platform market mappings (Polymarket <-> Metaculus/Manifold)
  `CREATE TABLE IF NOT EXISTS market_crossref (
    polymarket_id VARCHAR(128) NOT NULL,
    platform VARCHAR(50) NOT NULL,
    external_id VARCHAR(255) NOT NULL,
    external_question TEXT,
    external_price DECIMAL(10,6),
    match_confidence FLOAT NOT NULL DEFAULT 0.0,
    matched_at TIMESTAMPTZ DEFAULT NOW(),
    last_fetched_at TIMESTAMPTZ,
    PRIMARY KEY (polymarket_id, platform)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_crossref_platform ON market_crossref(platform)`,
  `CREATE INDEX IF NOT EXISTS idx_crossref_confidence ON market_crossref(match_confidence)`,

  // External signal data (hourly snapshots from external sources)
  `CREATE TABLE IF NOT EXISTS external_signals (
    id SERIAL PRIMARY KEY,
    market_id VARCHAR(128) NOT NULL,
    source VARCHAR(50) NOT NULL,
    signal_type VARCHAR(50) NOT NULL,
    value FLOAT NOT NULL,
    confidence FLOAT DEFAULT 0.5,
    metadata JSONB DEFAULT '{}',
    fetched_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_external_signals_market ON external_signals(market_id, fetched_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_external_signals_source ON external_signals(source, signal_type)`,
];

async function run() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable not set');
    process.exit(1);
  }

  console.log('Connecting to database...');
  const client = new Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    console.log('Connected. Applying 004_external_data_schema...');

    let success = 0, skipped = 0, errors = 0;
    for (const stmt of statements) {
      try {
        await client.query(stmt);
        success++;
        process.stdout.write('.');
      } catch (err) {
        if (err.message.includes('already exists') || err.message.includes('duplicate')) {
          skipped++;
          process.stdout.write('s');
        } else {
          console.error(`\nError: ${err.message.substring(0, 120)}`);
          errors++;
        }
      }
    }

    console.log(`\n\nDone. Success: ${success}, Skipped: ${skipped}, Errors: ${errors}`);

    // Verify tables exist
    const res = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('market_crossref', 'external_signals') ORDER BY table_name"
    );
    console.log(`\nVerification — tables created (${res.rows.length}/2):`);
    res.rows.forEach(r => console.log(`  ✓ ${r.table_name}`));

    if (res.rows.length < 2) {
      console.error('ERROR: Not all tables were created!');
      process.exit(1);
    }

    process.exit(errors > 0 ? 1 : 0);
  } catch (err) {
    console.error('Fatal error:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
