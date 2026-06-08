import { Pool } from 'pg';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const connectionString =
      process.env.DATABASE_URL ||
      'postgresql://polymarket:polymarket_dev@localhost:5432/polymarket_trading';
    const isCloudDb =
      connectionString.includes('tsdb.cloud.timescale.com') ||
      connectionString.includes('sslmode=require');
    pool = new Pool({
      connectionString,
      max: parseInt(process.env.DB_POOL_MAX || '4', 10),
      ssl: isCloudDb ? { rejectUnauthorized: false } : undefined,
    });
  }
  return pool;
}

export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await getPool().query(text, params as never[]);
  return res.rows as T[];
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
