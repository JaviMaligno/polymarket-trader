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
    max: config?.max ?? 10,
    idleTimeoutMillis: config?.idleTimeoutMillis ?? 30000,
    connectionTimeoutMillis: config?.connectionTimeoutMillis ?? 10000,
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

/**
 * Execute a query
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  const client = getPool();
  const start = Date.now();

  try {
    const result = await client.query<T>(text, params);
    const duration = Date.now() - start;

    if (duration > 1000) {
      // console.warn(`Slow query (${duration}ms):`, text.substring(0, 100));
    }

    return result;
  } catch (error) {
    console.error('Query error:', error);
    throw error;
  }
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
