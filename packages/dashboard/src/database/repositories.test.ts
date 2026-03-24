import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./index.js', () => ({
  query: vi.fn(),
  transaction: vi.fn(),
  isDatabaseConfigured: vi.fn(() => true),
}));

import { query, transaction } from './index.js';
import { paperPositionsRepo } from './repositories.js';

describe('paperPositionsRepo.insert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 1 } as any);
  });

  it('should use a plain INSERT without ON CONFLICT', async () => {
    await paperPositionsRepo.insert({
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
    expect(sql).toContain('INSERT INTO paper_positions');
    expect(sql).not.toContain('ON CONFLICT');
  });

  it('should default realized_pnl to 0', async () => {
    await paperPositionsRepo.insert({
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

    const params = vi.mocked(query).mock.calls[0][1] as unknown[];
    // realized_pnl is param index 8 (0-based)
    expect(params[8]).toBe(0);
  });
});

describe('paperPositionsRepo.get', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should only return open positions (closed_at IS NULL)', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 } as any);

    await paperPositionsRepo.get('market-1');

    const sql = vi.mocked(query).mock.calls[0][0] as string;
    expect(sql).toContain('closed_at IS NULL');
  });
});

describe('paperPositionsRepo.openPositionAtomically', () => {
  let mockClient: { query: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = { query: vi.fn() };
    vi.mocked(transaction).mockImplementation(async (cb) => cb(mockClient as any));
  });

  it('should return opened=true when no existing position', async () => {
    // SELECT FOR UPDATE returns no rows
    mockClient.query.mockResolvedValueOnce({ rows: [] });
    // UPDATE paper_account returns available_capital > 0
    mockClient.query.mockResolvedValueOnce({ rows: [{ available_capital: '5000' }] });
    // INSERT succeeds
    mockClient.query.mockResolvedValueOnce({ rowCount: 1 });

    const result = await paperPositionsRepo.openPositionAtomically(
      {
        market_id: 'market-1',
        token_id: 'token-1',
        side: 'long',
        size: 100,
        avg_entry_price: 0.50,
        current_price: 0.50,
        opened_at: new Date(),
      } as any,
      50,
      0.05,
    );

    expect(result.opened).toBe(true);
  });

  it('should return opened=false when position already exists', async () => {
    // SELECT FOR UPDATE returns existing row
    mockClient.query.mockResolvedValueOnce({ rows: [{ id: 42 }] });

    const result = await paperPositionsRepo.openPositionAtomically(
      {
        market_id: 'market-1',
        token_id: 'token-1',
        side: 'long',
        size: 100,
        avg_entry_price: 0.50,
        current_price: 0.50,
        opened_at: new Date(),
      } as any,
      50,
      0.05,
    );

    expect(result.opened).toBe(false);
    expect(result.reason).toContain('already open');
  });

  it('should rollback and throw on insufficient capital', async () => {
    // SELECT FOR UPDATE returns no rows
    mockClient.query.mockResolvedValueOnce({ rows: [] });
    // UPDATE paper_account returns negative available_capital
    mockClient.query.mockResolvedValueOnce({ rows: [{ available_capital: '-10' }] });

    await expect(
      paperPositionsRepo.openPositionAtomically(
        {
          market_id: 'market-1',
          token_id: 'token-1',
          side: 'long',
          size: 100,
          avg_entry_price: 0.50,
          current_price: 0.50,
          opened_at: new Date(),
        } as any,
        50,
        0.05,
      )
    ).rejects.toThrow('Insufficient capital');
  });

  it('should handle unique constraint violation (23505) gracefully', async () => {
    const pgError = new Error('unique violation') as any;
    pgError.code = '23505';
    vi.mocked(transaction).mockRejectedValue(pgError);

    const result = await paperPositionsRepo.openPositionAtomically(
      {
        market_id: 'market-1',
        token_id: 'token-1',
        side: 'long',
        size: 100,
        avg_entry_price: 0.50,
        current_price: 0.50,
        opened_at: new Date(),
      } as any,
      50,
      0.05,
    );

    expect(result.opened).toBe(false);
    expect(result.reason).toContain('unique constraint');
  });

  it('should set realized_pnl to 0 for new positions', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [] });
    mockClient.query.mockResolvedValueOnce({ rows: [{ available_capital: '5000' }] });
    mockClient.query.mockResolvedValueOnce({ rowCount: 1 });

    await paperPositionsRepo.openPositionAtomically(
      {
        market_id: 'market-1',
        token_id: 'token-1',
        side: 'long',
        size: 100,
        avg_entry_price: 0.50,
        current_price: 0.50,
        opened_at: new Date(),
      } as any,
      50,
      0.05,
    );

    // Third query is the INSERT — param index 8 is realized_pnl
    const insertParams = mockClient.query.mock.calls[2][1] as unknown[];
    expect(insertParams[8]).toBe(0);
  });
});
