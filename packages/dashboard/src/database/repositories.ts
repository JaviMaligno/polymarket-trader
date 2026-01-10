/**
 * Database Repositories
 *
 * Data access layer for trading system entities.
 */

import { query, transaction, type PoolClient } from './index.js';

// ============================================
// Signal Predictions Repository
// ============================================

export interface SignalPrediction {
  id?: number;
  time: Date;
  market_id: string;
  signal_type: string;
  direction: 'long' | 'short';
  strength: number;
  confidence: number;
  price_at_signal: number;
  resolved_at?: Date;
  price_at_resolution?: number;
  was_correct?: boolean;
  pnl_pct?: number;
  metadata?: Record<string, unknown>;
}

export const signalPredictionsRepo = {
  async create(prediction: Omit<SignalPrediction, 'id'>): Promise<SignalPrediction> {
    const result = await query<SignalPrediction>(
      `INSERT INTO signal_predictions
       (time, market_id, signal_type, direction, strength, confidence, price_at_signal, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        prediction.time,
        prediction.market_id,
        prediction.signal_type,
        prediction.direction,
        prediction.strength,
        prediction.confidence,
        prediction.price_at_signal,
        JSON.stringify(prediction.metadata ?? {}),
      ]
    );
    return result.rows[0];
  },

  async resolve(
    id: number,
    time: Date,
    resolution: {
      price_at_resolution: number;
      was_correct: boolean;
      pnl_pct: number;
    }
  ): Promise<void> {
    await query(
      `UPDATE signal_predictions
       SET resolved_at = $1, price_at_resolution = $2, was_correct = $3, pnl_pct = $4
       WHERE id = $5 AND time = $6`,
      [
        new Date(),
        resolution.price_at_resolution,
        resolution.was_correct,
        resolution.pnl_pct,
        id,
        time,
      ]
    );
  },

  async getUnresolved(limit = 100): Promise<SignalPrediction[]> {
    const result = await query<SignalPrediction>(
      `SELECT * FROM signal_predictions
       WHERE resolved_at IS NULL
       ORDER BY time DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  },

  async getBySignalType(
    signalType: string,
    days = 7
  ): Promise<SignalPrediction[]> {
    const result = await query<SignalPrediction>(
      `SELECT * FROM signal_predictions
       WHERE signal_type = $1
         AND time > NOW() - INTERVAL '1 day' * $2
       ORDER BY time DESC`,
      [signalType, days]
    );
    return result.rows;
  },

  async getAccuracyByType(days = 7): Promise<
    Array<{
      signal_type: string;
      total: number;
      correct: number;
      accuracy: number;
      avg_pnl: number;
    }>
  > {
    const result = await query<{
      signal_type: string;
      total: string;
      correct: string;
      accuracy: string;
      avg_pnl: string;
    }>(
      `SELECT
         signal_type,
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE was_correct = true) as correct,
         AVG(CASE WHEN was_correct THEN 1 ELSE 0 END) as accuracy,
         AVG(pnl_pct) as avg_pnl
       FROM signal_predictions
       WHERE resolved_at IS NOT NULL
         AND time > NOW() - INTERVAL '1 day' * $1
       GROUP BY signal_type`,
      [days]
    );
    return result.rows.map((row) => ({
      signal_type: row.signal_type,
      total: parseInt(row.total, 10),
      correct: parseInt(row.correct, 10),
      accuracy: parseFloat(row.accuracy),
      avg_pnl: parseFloat(row.avg_pnl),
    }));
  },
};

// ============================================
// Signal Weights Repository
// ============================================

export interface SignalWeight {
  signal_type: string;
  weight: number;
  is_enabled: boolean;
  min_confidence: number;
  updated_at: Date;
}

export const signalWeightsRepo = {
  async getAll(): Promise<SignalWeight[]> {
    const result = await query<SignalWeight>(
      'SELECT * FROM signal_weights ORDER BY signal_type'
    );
    return result.rows;
  },

  async get(signalType: string): Promise<SignalWeight | null> {
    const result = await query<SignalWeight>(
      'SELECT * FROM signal_weights WHERE signal_type = $1',
      [signalType]
    );
    return result.rows[0] ?? null;
  },

  async update(
    signalType: string,
    weight: number,
    reason: string
  ): Promise<void> {
    await transaction(async (client: PoolClient) => {
      // Get current weight
      const current = await client.query<SignalWeight>(
        'SELECT weight FROM signal_weights WHERE signal_type = $1',
        [signalType]
      );
      const previousWeight = current.rows[0]?.weight;

      // Update weight
      await client.query(
        `UPDATE signal_weights
         SET weight = $1, updated_at = NOW()
         WHERE signal_type = $2`,
        [weight, signalType]
      );

      // Record history
      await client.query(
        `INSERT INTO signal_weights_history
         (time, signal_type, weight, previous_weight, reason)
         VALUES (NOW(), $1, $2, $3, $4)`,
        [signalType, weight, previousWeight, reason]
      );
    });
  },

  async getHistory(
    signalType: string,
    limit = 50
  ): Promise<
    Array<{
      time: Date;
      weight: number;
      previous_weight?: number;
      reason?: string;
    }>
  > {
    const result = await query<{
      time: Date;
      weight: number;
      previous_weight?: number;
      reason?: string;
    }>(
      `SELECT time, weight, previous_weight, reason
       FROM signal_weights_history
       WHERE signal_type = $1
       ORDER BY time DESC
       LIMIT $2`,
      [signalType, limit]
    );
    return result.rows;
  },
};

// ============================================
// Paper Trades Repository
// ============================================

export interface PaperTrade {
  id?: number;
  time: Date;
  market_id: string;
  token_id: string;
  side: 'buy' | 'sell';
  requested_size: number;
  executed_size: number;
  requested_price: number;
  executed_price: number;
  slippage_pct?: number;
  fee?: number;
  value_usd?: number;
  signal_id?: number;
  signal_type?: string;
  order_type?: string;
  fill_type?: string;
  rejection_reason?: string;
  best_bid?: number;
  best_ask?: number;
}

export const paperTradesRepo = {
  async create(trade: Omit<PaperTrade, 'id'>): Promise<PaperTrade> {
    const result = await query<PaperTrade>(
      `INSERT INTO paper_trades
       (time, market_id, token_id, side, requested_size, executed_size,
        requested_price, executed_price, slippage_pct, fee, value_usd,
        signal_id, signal_type, order_type, fill_type, rejection_reason,
        best_bid, best_ask)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       RETURNING *`,
      [
        trade.time,
        trade.market_id,
        trade.token_id,
        trade.side,
        trade.requested_size,
        trade.executed_size,
        trade.requested_price,
        trade.executed_price,
        trade.slippage_pct,
        trade.fee ?? 0,
        trade.value_usd,
        trade.signal_id,
        trade.signal_type,
        trade.order_type ?? 'market',
        trade.fill_type ?? 'full',
        trade.rejection_reason,
        trade.best_bid,
        trade.best_ask,
      ]
    );
    return result.rows[0];
  },

  async getRecent(limit = 50): Promise<PaperTrade[]> {
    const result = await query<PaperTrade>(
      `SELECT * FROM paper_trades ORDER BY time DESC LIMIT $1`,
      [limit]
    );
    return result.rows;
  },

  async getByMarket(marketId: string, limit = 50): Promise<PaperTrade[]> {
    const result = await query<PaperTrade>(
      `SELECT * FROM paper_trades
       WHERE market_id = $1
       ORDER BY time DESC
       LIMIT $2`,
      [marketId, limit]
    );
    return result.rows;
  },
};

// ============================================
// Paper Positions Repository
// ============================================

export interface PaperPosition {
  market_id: string;
  token_id: string;
  side: 'long' | 'short';
  size: number;
  avg_entry_price: number;
  current_price?: number;
  unrealized_pnl?: number;
  unrealized_pnl_pct?: number;
  realized_pnl?: number;
  stop_loss?: number;
  take_profit?: number;
  opened_at: Date;
  updated_at?: Date;
  signal_type?: string;
  metadata?: Record<string, unknown>;
}

export const paperPositionsRepo = {
  async upsert(position: PaperPosition): Promise<void> {
    await query(
      `INSERT INTO paper_positions
       (market_id, token_id, side, size, avg_entry_price, current_price,
        unrealized_pnl, unrealized_pnl_pct, realized_pnl, stop_loss, take_profit,
        opened_at, signal_type, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (market_id, token_id) DO UPDATE SET
         current_price = EXCLUDED.current_price,
         unrealized_pnl = EXCLUDED.unrealized_pnl,
         unrealized_pnl_pct = EXCLUDED.unrealized_pnl_pct,
         realized_pnl = EXCLUDED.realized_pnl,
         size = EXCLUDED.size,
         updated_at = NOW()`,
      [
        position.market_id,
        position.token_id,
        position.side,
        position.size,
        position.avg_entry_price,
        position.current_price,
        position.unrealized_pnl,
        position.unrealized_pnl_pct,
        position.realized_pnl ?? 0,
        position.stop_loss,
        position.take_profit,
        position.opened_at,
        position.signal_type,
        JSON.stringify(position.metadata ?? {}),
      ]
    );
  },

  async getAll(): Promise<PaperPosition[]> {
    // Only return open positions (not closed)
    const result = await query<PaperPosition>(
      'SELECT * FROM paper_positions WHERE closed_at IS NULL ORDER BY opened_at DESC'
    );
    return result.rows;
  },

  async get(marketId: string): Promise<PaperPosition | null> {
    const result = await query<PaperPosition>(
      'SELECT * FROM paper_positions WHERE market_id = $1',
      [marketId]
    );
    return result.rows[0] ?? null;
  },

  async close(marketId: string): Promise<void> {
    await query('DELETE FROM paper_positions WHERE market_id = $1', [marketId]);
  },
};

// ============================================
// Portfolio Snapshots Repository
// ============================================

export interface PortfolioSnapshot {
  time: Date;
  initial_capital: number;
  current_capital: number;
  available_capital: number;
  total_pnl: number;
  total_pnl_pct: number;
  daily_pnl?: number;
  max_drawdown?: number;
  current_drawdown?: number;
  sharpe_ratio?: number;
  total_trades?: number;
  winning_trades?: number;
  losing_trades?: number;
  win_rate?: number;
  avg_win?: number;
  avg_loss?: number;
  profit_factor?: number;
  open_positions?: number;
  total_exposure?: number;
}

export const portfolioSnapshotsRepo = {
  async create(snapshot: PortfolioSnapshot): Promise<void> {
    await query(
      `INSERT INTO portfolio_snapshots
       (time, initial_capital, current_capital, available_capital, total_pnl, total_pnl_pct,
        daily_pnl, max_drawdown, current_drawdown, sharpe_ratio, total_trades,
        winning_trades, losing_trades, win_rate, avg_win, avg_loss, profit_factor,
        open_positions, total_exposure)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        snapshot.time,
        snapshot.initial_capital,
        snapshot.current_capital,
        snapshot.available_capital,
        snapshot.total_pnl,
        snapshot.total_pnl_pct,
        snapshot.daily_pnl,
        snapshot.max_drawdown,
        snapshot.current_drawdown,
        snapshot.sharpe_ratio,
        snapshot.total_trades ?? 0,
        snapshot.winning_trades ?? 0,
        snapshot.losing_trades ?? 0,
        snapshot.win_rate,
        snapshot.avg_win,
        snapshot.avg_loss,
        snapshot.profit_factor,
        snapshot.open_positions ?? 0,
        snapshot.total_exposure,
      ]
    );
  },

  async getRecent(limit = 100): Promise<PortfolioSnapshot[]> {
    const result = await query<PortfolioSnapshot>(
      `SELECT * FROM portfolio_snapshots ORDER BY time DESC LIMIT $1`,
      [limit]
    );
    return result.rows;
  },

  async getEquityCurve(days = 30): Promise<Array<{ time: Date; value: number }>> {
    const result = await query<{ time: Date; current_capital: number }>(
      `SELECT time, current_capital
       FROM portfolio_snapshots
       WHERE time > NOW() - INTERVAL '1 day' * $1
       ORDER BY time ASC`,
      [days]
    );
    return result.rows.map((row) => ({
      time: row.time,
      value: parseFloat(row.current_capital as unknown as string),
    }));
  },

  async getLatest(): Promise<PortfolioSnapshot | null> {
    const result = await query<PortfolioSnapshot>(
      'SELECT * FROM portfolio_snapshots ORDER BY time DESC LIMIT 1'
    );
    return result.rows[0] ?? null;
  },
};

// ============================================
// Trading Config Repository
// ============================================

export const tradingConfigRepo = {
  async get<T = unknown>(key: string): Promise<T | null> {
    const result = await query<{ value: T }>(
      'SELECT value FROM trading_config WHERE key = $1',
      [key]
    );
    return result.rows[0]?.value ?? null;
  },

  async set(key: string, value: unknown, description?: string): Promise<void> {
    await query(
      `INSERT INTO trading_config (key, value, description, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value,
         description = COALESCE(EXCLUDED.description, trading_config.description),
         updated_at = NOW()`,
      [key, JSON.stringify(value), description]
    );
  },

  async getAll(): Promise<Record<string, unknown>> {
    const result = await query<{ key: string; value: unknown }>(
      'SELECT key, value FROM trading_config'
    );
    const config: Record<string, unknown> = {};
    for (const row of result.rows) {
      config[row.key] = row.value;
    }
    return config;
  },
};
