import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('./connection.js', () => ({ query: vi.fn() }));
import { query } from './connection.js';
import { ensureRuntimeSchema } from './runtimeSchema.js';

beforeEach(() => { vi.clearAllMocks(); });

describe('ensureRuntimeSchema', () => {
  it('creates the trades dedup unique index idempotently', async () => {
    (query as any).mockResolvedValue({ rowCount: 0 });
    await ensureRuntimeSchema();
    expect((query as any).mock.calls[0][0]).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_dedup/);
  });
  it('swallows errors (e.g. duplicates blocking the index) without throwing', async () => {
    (query as any).mockRejectedValue(new Error('duplicate key'));
    await expect(ensureRuntimeSchema()).resolves.toBeUndefined();
  });
});
