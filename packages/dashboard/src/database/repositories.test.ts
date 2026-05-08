import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./index.js', () => ({
  query: vi.fn(),
  transaction: vi.fn(),
  isDatabaseConfigured: vi.fn(() => true),
}));

import { query, transaction } from './index.js';
import { paperPositionsRepo, generatorPredictionsRepo } from './repositories.js';

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

describe('paperPositionsRepo — direction multiplier fields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 } as any);
  });

  it('includes applied_direction_multiplier and was_exploration in INSERT', async () => {
    await paperPositionsRepo.insert({
      market_id: 'mkt1',
      token_id: 'tok1',
      side: 'long',
      size: 10,
      avg_entry_price: 0.5,
      current_price: 0.5,
      opened_at: new Date('2026-04-20T12:00:00Z'),
      applied_direction_multiplier: 0.75,
      was_exploration: true,
    });
    const sql = vi.mocked(query).mock.calls[0][0] as string;
    const params = vi.mocked(query).mock.calls[0][1] as unknown[];
    expect(sql).toContain('applied_direction_multiplier');
    expect(sql).toContain('was_exploration');
    expect(params).toContain(0.75);
    expect(params).toContain(true);
  });

  it('defaults applied_direction_multiplier to null and was_exploration to false when omitted', async () => {
    await paperPositionsRepo.insert({
      market_id: 'mkt1',
      token_id: 'tok1',
      side: 'long',
      size: 10,
      avg_entry_price: 0.5,
      current_price: 0.5,
      opened_at: new Date(),
    });
    const params = vi.mocked(query).mock.calls[0][1] as unknown[];
    expect(params).toContain(null);
    expect(params).toContain(false);
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

describe('generatorPredictionsRepo.bulkCreate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 } as any);
  });

  it('does nothing on empty input', async () => {
    await generatorPredictionsRepo.bulkCreate([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('emits a single multi-row INSERT for N predictions', async () => {
    await generatorPredictionsRepo.bulkCreate([
      {
        market_id: 'mkt1',
        market_type: 'crypto_intraday',
        signal_id: 'momentum',
        direction: 'long',
        strength: 0.5,
        confidence: 0.7,
        yes_price_at_signal: 0.42,
        metadata: { foo: 'bar' },
      },
      {
        market_id: 'mkt1',
        market_type: 'crypto_intraday',
        signal_id: 'mean_reversion',
        direction: 'short',
        strength: -0.6,
        confidence: 0.8,
        yes_price_at_signal: 0.42,
      },
    ]);

    expect(query).toHaveBeenCalledTimes(1);
    const sql = vi.mocked(query).mock.calls[0][0] as string;
    expect(sql).toContain('INSERT INTO generator_predictions');
    expect(sql).toContain('($1, $2, $3, $4, $5, $6, $7, $8)');
    expect(sql).toContain('($9, $10, $11, $12, $13, $14, $15, $16)');
  });

  it('serializes metadata as JSON and defaults to empty object', async () => {
    await generatorPredictionsRepo.bulkCreate([
      {
        market_id: 'mkt1',
        market_type: null,
        signal_id: 'ofi',
        direction: 'neutral',
        strength: 0,
        confidence: 0.5,
        yes_price_at_signal: 0.5,
        // no metadata field
      },
    ]);

    const params = vi.mocked(query).mock.calls[0][1] as unknown[];
    // 8 cols: market_id, market_type, signal_id, direction, strength, confidence, yes_price_at_signal, metadata
    expect(params[7]).toBe('{}');
  });

  it('preserves signed strength values (negative for SHORT)', async () => {
    await generatorPredictionsRepo.bulkCreate([
      {
        market_id: 'mkt1',
        market_type: 'event_financial',
        signal_id: 'hawkes',
        direction: 'short',
        strength: -0.85,
        confidence: 0.9,
        yes_price_at_signal: 0.7,
      },
    ]);

    const params = vi.mocked(query).mock.calls[0][1] as unknown[];
    expect(params[4]).toBe(-0.85); // strength preserved with negative sign
    expect(params[3]).toBe('short'); // direction lowercase
  });
});
