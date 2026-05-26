import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('data-collector database query resilience', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.DATABASE_URL;
    delete process.env.DB_POOL_MAX;
    delete process.env.DB_IDLE_TIMEOUT_MS;
    delete process.env.DB_CONNECTION_TIMEOUT_MS;
  });

  it('passes DB_IDLE_TIMEOUT_MS and DB_CONNECTION_TIMEOUT_MS env vars to the Pool', async () => {
    process.env.DATABASE_URL = 'postgres://example';
    process.env.DB_IDLE_TIMEOUT_MS = '45000';
    process.env.DB_CONNECTION_TIMEOUT_MS = '25000';

    const poolInstance = {
      query: vi.fn(),
      connect: vi.fn(),
      end: vi.fn(),
      on: vi.fn(),
    };
    let capturedConfig: Record<string, unknown> | null = null;
    const Pool = vi.fn(class MockPool {
      constructor(cfg: Record<string, unknown>) {
        capturedConfig = cfg;
        return poolInstance;
      }
    } as any);

    vi.doMock('pg', () => ({ Pool }));

    const db = await import('./connection.js');
    db.getPool();

    expect(capturedConfig).toMatchObject({
      idleTimeoutMillis: 45000,
      connectionTimeoutMillis: 25000,
      keepAlive: true,
    });
  });

  it('falls back to safe defaults when env vars are unset', async () => {
    process.env.DATABASE_URL = 'postgres://example';

    const poolInstance = {
      query: vi.fn(),
      connect: vi.fn(),
      end: vi.fn(),
      on: vi.fn(),
    };
    let capturedConfig: Record<string, unknown> | null = null;
    const Pool = vi.fn(class MockPool {
      constructor(cfg: Record<string, unknown>) {
        capturedConfig = cfg;
        return poolInstance;
      }
    } as any);

    vi.doMock('pg', () => ({ Pool }));

    const db = await import('./connection.js');
    db.getPool();

    expect(capturedConfig).toMatchObject({
      idleTimeoutMillis: 60000,
      connectionTimeoutMillis: 30000,
    });
  });

  it('recreates the pool and retries once on transient connection timeout', async () => {
    process.env.DATABASE_URL = 'postgres://example';

    const firstPool = {
      query: vi.fn().mockRejectedValue(new Error('Connection terminated due to connection timeout')),
      connect: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
    };
    const secondPool = {
      query: vi.fn().mockResolvedValue({ rows: [{ ok: 1 }], rowCount: 1 }),
      connect: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
    };

    let instanceCount = 0;
    const Pool = vi.fn(class MockPool {
      constructor() {
        instanceCount += 1;
        return instanceCount === 1 ? firstPool : secondPool;
      }
    } as any);

    vi.doMock('pg', () => ({
      Pool,
    }));

    const db = await import('./connection.js');

    const result = await db.query('SELECT 1');

    expect(result.rows).toEqual([{ ok: 1 }]);
    expect(firstPool.query).toHaveBeenCalledTimes(1);
    expect(firstPool.end).toHaveBeenCalledTimes(1);
    expect(secondPool.query).toHaveBeenCalledTimes(1);
    expect(Pool).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-transient query errors', async () => {
    process.env.DATABASE_URL = 'postgres://example';

    const pool = {
      query: vi.fn().mockRejectedValue(new Error('syntax error at or near "FROM"')),
      connect: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
    };

    const Pool = vi.fn(class MockPool {
      constructor() {
        return pool;
      }
    } as any);

    vi.doMock('pg', () => ({
      Pool,
    }));

    const db = await import('./connection.js');

    await expect(db.query('SELECT FROM')).rejects.toThrow('syntax error at or near "FROM"');

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.end).not.toHaveBeenCalled();
    expect(Pool).toHaveBeenCalledTimes(1);
  });

  it('tracks retry and pool reset stats for transient failures', async () => {
    process.env.DATABASE_URL = 'postgres://example';

    const firstPool = {
      query: vi.fn().mockRejectedValue(new Error('timeout exceeded when trying to connect')),
      connect: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
    };
    const secondPool = {
      query: vi.fn().mockResolvedValue({ rows: [{ ok: 1 }], rowCount: 1 }),
      connect: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
    };

    let instanceCount = 0;
    const Pool = vi.fn(class MockPool {
      constructor() {
        instanceCount += 1;
        return instanceCount === 1 ? firstPool : secondPool;
      }
    } as any);

    vi.doMock('pg', () => ({
      Pool,
    }));

    const db = await import('./connection.js');

    await db.query('SELECT 1');

    expect(db.getQueryStats()).toMatchObject({
      totalQueries: 2,
      retries: 1,
      poolResets: 1,
      consecutiveConnectionFailures: 0,
      lastError: 'timeout exceeded when trying to connect',
    });
  });
});
