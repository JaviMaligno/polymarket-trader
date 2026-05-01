import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../database/index.js', () => ({
  query: vi.fn(),
}));

import { query } from '../database/index.js';
import { bootstrapDirectionMultiplierRows } from './bootstrapDirectionMultiplier.js';

describe('bootstrapDirectionMultiplierRows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('issues an INSERT … ON CONFLICT DO NOTHING for the 5 market types', async () => {
    (query as any).mockResolvedValueOnce({ rows: [] });
    await bootstrapDirectionMultiplierRows();
    expect(query).toHaveBeenCalledTimes(1);
    const sql = (query as any).mock.calls[0][0] as string;
    expect(sql).toMatch(/INSERT INTO signal_weights/);
    expect(sql).toMatch(/'direction_multiplier'/);
    expect(sql).toMatch(/'event_financial'.*1\.0/s);
    expect(sql).toMatch(/'crypto_intraday'.*-1\.0/s);
    expect(sql).toMatch(/ON CONFLICT \(signal_type, market_type\) DO NOTHING/);
  });
});
