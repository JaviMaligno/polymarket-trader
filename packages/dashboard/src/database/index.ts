/**
 * Database Module
 *
 * PostgreSQL/TimescaleDB connection pool and query utilities.
 */

import pg, { QueryResultRow } from 'pg';

const { Pool } = pg;

export type PoolClient = pg.PoolClient;

// Connection pool singleton
let pool: pg.Pool | null = null;
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

export interface DatabaseConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean | { rejectUnauthorized: boolean };
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

/**
 * Initialize the database connection pool
 */
export function initializeDatabase(config?: DatabaseConfig): pg.Pool {
  if (pool) {
    return pool;
  }

  const connectionString = config?.connectionString ?? process.env.DATABASE_URL;

  if (!connectionString) {
    console.warn('DATABASE_URL not set - database features disabled');
    // Return a mock pool that throws on query
    pool = {
      query: async () => {
        throw new Error('Database not configured');
      },
      connect: async () => {
        throw new Error('Database not configured');
      },
      end: async () => {},
      on: () => {},
    } as unknown as pg.Pool;
    return pool;
  }

  // Parse SSL requirement from connection string or config
  // For cloud databases (Timescale, Neon, etc.), always use SSL with rejectUnauthorized: false
  const isCloudDb = connectionString.includes('timescale.com') ||
                    connectionString.includes('neon.tech') ||
                    connectionString.includes('sslmode=require');

  const sslConfig = isCloudDb
    ? { rejectUnauthorized: false }
    : config?.ssl ?? false;

  console.log(`Database: Connecting to ${isCloudDb ? 'cloud' : 'local'} database with SSL: ${!!sslConfig}`);

  pool = new Pool({
    connectionString,
    ssl: sslConfig,
    max: config?.max ?? parseInt(process.env.DB_POOL_MAX || '5', 10),
    idleTimeoutMillis: config?.idleTimeoutMillis ?? parseInt(process.env.DB_IDLE_TIMEOUT_MS || '10000', 10),
    connectionTimeoutMillis: config?.connectionTimeoutMillis ?? 10000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
  });

  // Log connection events
  pool.on('connect', () => {
    // console.log('Database pool: new client connected');
  });

  pool.on('error', (err) => {
    console.error('Database pool error:', err);
  });

  return pool;
}

/**
 * Get the database connection pool
 */
export function getPool(): pg.Pool {
  if (!pool) {
    return initializeDatabase();
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
    console.warn('Database pool reset failed during end():', error);
  }
}

function isRetryableConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return RETRYABLE_CONNECTION_ERRORS.some(pattern => message.includes(pattern));
}

/**
 * Execute a query
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    queryStats.totalQueries += 1;
    const client = getPool();
    const start = Date.now();

    try {
      const result = await client.query<T>(text, params);
      const duration = Date.now() - start;
      queryStats.consecutiveConnectionFailures = 0;

      if (duration > 1000) {
        // console.warn(`Slow query (${duration}ms):`, text.substring(0, 100));
      }

      return result;
    } catch (error) {
      const retryable = attempt === 0 && isRetryableConnectionError(error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      queryStats.lastError = errorMessage;
      console.error('Query error:', error);

      if (!retryable) {
        throw error;
      }

      queryStats.retries += 1;
      queryStats.consecutiveConnectionFailures += 1;
      console.warn('Retrying query after resetting database pool');
      await resetPool();
    }
  }

  throw new Error('Query retry loop exited unexpectedly');
}

export function getQueryStats(): typeof queryStats {
  return { ...queryStats };
}

/**
 * Get a client from the pool for transactions
 */
export async function getClient(): Promise<PoolClient> {
  return getPool().connect();
}

/**
 * Execute a transaction
 */
export async function transaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getClient();

  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Check database connection health
 */
export async function healthCheck(): Promise<{
  connected: boolean;
  latency?: number;
  error?: string;
}> {
  const start = Date.now();

  try {
    await query('SELECT 1');
    return {
      connected: true,
      latency: Date.now() - start,
    };
  } catch (error) {
    return {
      connected: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Close the database connection pool
 */
export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('Database pool closed');
  }
}

/**
 * Check if database is configured
 */
export function isDatabaseConfigured(): boolean {
  return !!process.env.DATABASE_URL;
}
