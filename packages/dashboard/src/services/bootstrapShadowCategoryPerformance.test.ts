import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../database/index.js', () => ({
  query: vi.fn(),
}));

import { query } from '../database/index.js';
import { bootstrapShadowCategoryPerformanceTable } from './bootstrapShadowCategoryPerformance.js';

describe('bootstrapShadowCategoryPerformanceTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('issues a CREATE TABLE IF NOT EXISTS for category_performance_shadow', async () => {
    (query as any).mockResolvedValueOnce({ rows: [] });
    await bootstrapShadowCategoryPerformanceTable();
    expect(query).toHaveBeenCalledTimes(1);
    const sql = (query as any).mock.calls[0][0] as string;
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS category_performance_shadow/);
    expect(sql).toMatch(/PRIMARY KEY/);
    expect(sql).toMatch(/haircut_applied DOUBLE PRECISION NOT NULL DEFAULT 0\.33/);
    expect(sql).toMatch(/sharpe_ratio DOUBLE PRECISION/);
  });
});
