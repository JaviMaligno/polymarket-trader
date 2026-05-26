import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { pino } from 'pino';

const logger = pino({ name: 'database' });

let pool: Pool | null = null;
const RETRYABLE_CONNECTION_ERRORS = [
  'connection terminated due to connection timeout',
  'timeout exceeded when trying to connect',
  'terminating connection due to administrator command',
  'server closed the connection unexpectedly',
];
const queryStats = {
  totalQueries: 0,
  retries: 0,
  poolResets: 0,
  consecutiveConnectionFailures: 0,
  lastError: null as string | null,
};

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL ||
      'postgresql://polymarket:polymarket_dev@localhost:5432/polymarket_trading';

    // Detect cloud database connections that require SSL
    const isCloudDb = connectionString.includes('tsdb.cloud.timescale.com') ||
                      connectionString.includes('sslmode=require');

    const maxConnections = parseInt(process.env.DB_POOL_MAX || '5', 10);
    const idleTimeoutMs = parseInt(process.env.DB_IDLE_TIMEOUT_MS || '60000', 10);
    const connectionTimeoutMs = parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || '30000', 10);
    pool = new Pool({
      connectionString,
      max: maxConnections,
      idleTimeoutMillis: idleTimeoutMs,
      connectionTimeoutMillis: connectionTimeoutMs,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
      // Configure SSL for cloud databases
      // rejectUnauthorized: false allows connections to databases with self-signed certs
      ssl: isCloudDb ? { rejectUnauthorized: false } : undefined,
    });

    pool.on('error', (err) => {
      logger.error({ err }, 'Unexpected database pool error');
    });

    pool.on('connect', () => {
      logger.debug('New database connection established');
    });
  }

  return pool;
}

async function resetPool(): Promise<void> {
  if (!pool) return;

  const stalePool = pool;
  pool = null;
  queryStats.poolResets += 1;

  try {
    await stalePool.end();
  } catch (error) {
    logger.warn({ err: error }, 'Database pool reset failed during end()');
  }
}

function isRetryableConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return RETRYABLE_CONNECTION_ERRORS.some(pattern => message.includes(pattern));
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    queryStats.totalQueries += 1;
    const pool = getPool();
    const start = Date.now();

    try {
      const result = await pool.query<T>(text, params);
      const duration = Date.now() - start;
      queryStats.consecutiveConnectionFailures = 0;

      if (duration > 1000) {
        logger.warn({ duration, query: text.slice(0, 100) }, 'Slow query detected');
      }

      return result;
    } catch (error: any) {
      const retryable = attempt === 0 && isRetryableConnectionError(error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      queryStats.lastError = errorMessage;
      logger.error({ err: error.message || String(error), query: text.slice(0, 100) }, 'Query error');

      if (!retryable) {
        throw error;
      }

      queryStats.retries += 1;
      queryStats.consecutiveConnectionFailures += 1;
      logger.warn({ query: text.slice(0, 100) }, 'Retrying query after resetting database pool');
      await resetPool();
    }
  }

  throw new Error('Query retry loop exited unexpectedly');
}

export function getQueryStats(): typeof queryStats {
  return { ...queryStats };
}

export async function getClient(): Promise<PoolClient> {
  const pool = getPool();
  return pool.connect();
}

export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getClient();

  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function healthCheck(): Promise<boolean> {
  try {
    const result = await query('SELECT 1');
    return result.rowCount === 1;
  } catch {
    return false;
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('Database pool closed');
  }
}
