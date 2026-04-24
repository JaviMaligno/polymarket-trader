import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../database/connection.js', () => ({
  query: vi.fn(),
  getPool: vi.fn(),
}));

import { query } from '../database/connection.js';
import { computeRealizedVolatility } from './Scheduler.js';

describe('computeRealizedVolatility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('executes the UPDATE and the NULL-out UPDATE without throwing', async () => {
    (query as unknown as Mock).mockResolvedValue({ rowCount: 10, rows: [] });
    await expect(computeRealizedVolatility()).resolves.not.toThrow();
    // Two UPDATE statements issued: set vols + null out stale
    const updateCalls = (query as unknown as Mock).mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].trim().startsWith('UPDATE markets'),
    );
    expect(updateCalls.length).toBe(2);
  });

  it('swallows DB errors and does not abort the scheduler', async () => {
    (query as unknown as Mock).mockRejectedValue(new Error('db down'));
    await expect(computeRealizedVolatility()).resolves.not.toThrow();
  });
});
