import { pino } from 'pino';
import { query } from './connection.js';

const logger = pino({ name: 'runtime-schema' });

/**
 * Idempotent runtime DDL that must exist on ALREADY-INITIALISED volumes — the SQL
 * in database/init/ only runs on a fresh volume, so indexes added later never reach
 * the live DB without this. Safe to run on every startup.
 */
export async function ensureRuntimeSchema(): Promise<void> {
  try {
    await query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_dedup
       ON trades (time, tx_hash, token_id, side, price, size)`
    );
    logger.info('Runtime schema ensured (idx_trades_dedup)');
  } catch (error) {
    // Most likely pre-existing duplicate rows block the unique index. Log and
    // continue — bare ON CONFLICT DO NOTHING still inserts safely without it, and
    // the index gets created once the table is purged/clean and the service restarts.
    logger.warn({ error }, 'ensureRuntimeSchema: could not create idx_trades_dedup (will retry next start)');
  }
}
