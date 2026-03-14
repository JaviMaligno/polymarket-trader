import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./index.js', () => ({
  query: vi.fn(),
  isDatabaseConfigured: vi.fn(() => true),
}));

import { query } from './index.js';
import { paperPositionsRepo } from './repositories.js';

describe('paperPositionsRepo.upsert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 1 } as any);
  });

  it('should include closed_at = NULL in ON CONFLICT UPDATE', async () => {
    await paperPositionsRepo.upsert({
      market_id: 'market-1',
      token_id: 'token-1',
      side: 'long',
      size: 100,
      avg_entry_price: 0.50,
      current_price: 0.50,
      unrealized_pnl: 0,
      unrealized_pnl_pct: 0,
      opened_at: new Date(),
    } as any);

    const sql = vi.mocked(query).mock.calls[0][0] as string;
    expect(sql).toContain('closed_at = NULL');
    expect(sql).toContain('side = EXCLUDED.side');
    expect(sql).toContain('opened_at = EXCLUDED.opened_at');
    expect(sql).toContain('avg_entry_price = EXCLUDED.avg_entry_price');
  });
});
