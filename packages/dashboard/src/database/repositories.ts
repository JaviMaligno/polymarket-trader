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
         (time, signal_type, weight, previous_weight, change_reason)
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
      `SELECT time, weight, previous_weight, change_reason AS reason
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
  fill_source?: string;
  snapshot_age_ms?: number | null;
  available_depth?: number;
  execution_mode?: string;
}

export const paperTradesRepo = {
  async create(trade: Omit<PaperTrade, 'id'>): Promise<PaperTrade> {
    const result = await query<PaperTrade>(
      `INSERT INTO paper_trades
       (time, market_id, token_id, side, requested_size, executed_size,
        requested_price, executed_price, slippage_pct, fee, value_usd,
        signal_id, signal_type, order_type, fill_type, rejection_reason,
        best_bid, best_ask, fill_source, snapshot_age_ms, available_depth,
        execution_mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
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
        trade.fill_source,
        trade.snapshot_age_ms ?? null,
        trade.available_depth,
        trade.execution_mode ?? 'paper',
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
  market_score_at_entry?: number | null;
  score_dimensions_at_entry?: Record<string, unknown> | null;
  execution_mode?: string;
  applied_direction_multiplier?: number | null;
  was_exploration?: boolean;
}

export const paperPositionsRepo = {
  async insert(position: PaperPosition): Promise<void> {
    await query(
      `INSERT INTO paper_positions
       (market_id, token_id, side, size, avg_entry_price, current_price,
        unrealized_pnl, unrealized_pnl_pct, realized_pnl, stop_loss, take_profit,
        opened_at, signal_type, metadata, market_score_at_entry, score_dimensions_at_entry,
        execution_mode, applied_direction_multiplier, was_exploration)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
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
        position.market_score_at_entry ?? null,
        position.score_dimensions_at_entry != null ? JSON.stringify(position.score_dimensions_at_entry) : null,
        position.execution_mode ?? 'paper',
        position.applied_direction_multiplier ?? null,
        position.was_exploration ?? false,
      ]
    );
  },

  /**
   * @deprecated Use insert() for new code. This alias exists for backward
   * compatibility with routes.ts and PaperTradingService.ts.
   */
  async upsert(position: PaperPosition): Promise<void> {
    return this.insert(position);
  },

  /**
   * Open a position atomically: check for duplicates, debit account, and
   * insert position — all inside a single serializable transaction.
   * Returns { opened: false, reason } if a position is already open or
   * capital is insufficient. Rolls back on any failure.
   */
  async openPositionAtomically(
    position: PaperPosition,
    cost: number,
    fee: number,
  ): Promise<{ opened: boolean; reason?: string }> {
    try {
      return await transaction(async (client: PoolClient) => {
        // Lock any existing open position for this token
        const existing = await client.query(
          `SELECT id FROM paper_positions
           WHERE market_id = $1 AND token_id = $2 AND closed_at IS NULL
           FOR UPDATE`,
          [position.market_id, position.token_id]
        );
        if (existing.rows.length > 0) {
          return { opened: false, reason: 'Position already open for this token' };
        }
        // Debit account atomically.
        // current_capital tracks actual cash flow (decrements by cost+fee).
        // available_capital tracks liquid capital = current_capital - locked_in_positions,
        // so it also decrements by the position cost basis on top of the cash outflow.
        const acctResult = await client.query(
          `UPDATE paper_account SET
            current_capital = current_capital - $1,
            available_capital = available_capital - $1 - ($1 - $2),
            total_fees_paid = total_fees_paid + $2,
            total_trades = total_trades + 1,
            updated_at = NOW()
          WHERE id = 1
          RETURNING available_capital`,
          [cost + fee, fee]
        );
        const newAvailable = parseFloat(acctResult.rows[0]?.available_capital ?? '0');
        if (newAvailable < 0) {
          throw new Error(`Insufficient capital: available would be $${newAvailable.toFixed(2)}`);
        }
        // Insert position (realized_pnl always 0 for new positions)
        await client.query(
          `INSERT INTO paper_positions
           (market_id, token_id, side, size, avg_entry_price, current_price,
            unrealized_pnl, unrealized_pnl_pct, realized_pnl, stop_loss, take_profit,
            opened_at, signal_type, metadata, market_score_at_entry, score_dimensions_at_entry,
            execution_mode, applied_direction_multiplier, was_exploration)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
          [
            position.market_id, position.token_id, position.side, position.size,
            position.avg_entry_price, position.current_price,
            position.unrealized_pnl ?? 0, position.unrealized_pnl_pct ?? 0,
            0, position.stop_loss, position.take_profit, position.opened_at,
            position.signal_type, JSON.stringify(position.metadata ?? {}),
            position.market_score_at_entry ?? null,
            position.score_dimensions_at_entry != null ? JSON.stringify(position.score_dimensions_at_entry) : null,
            position.execution_mode ?? 'paper',
            position.applied_direction_multiplier ?? null,
            position.was_exploration ?? false,
          ]
        );
        return { opened: true };
      });
    } catch (error: any) {
      if (error.code === '23505') {
        return { opened: false, reason: 'Position already open (unique constraint)' };
      }
      throw error;
    }
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
      'SELECT * FROM paper_positions WHERE market_id = $1 AND closed_at IS NULL',
      [marketId]
    );
    return result.rows[0] ?? null;
  },

  /**
   * @deprecated Use PositionClosingService.close() instead.
   * This method does not update paper_account, does not record fees,
   * and does not create a sell trade. Kept only for backward compatibility.
   */
  async close(marketId: string, exitPrice?: number): Promise<void> {
    if (exitPrice !== undefined) {
      // Properly close with PnL calculation
      await query(
        `UPDATE paper_positions SET
          closed_at = NOW(),
          current_price = $2,
          realized_pnl = ($2 - avg_entry_price) * size,
          size = 0,
          updated_at = NOW()
        WHERE market_id = $1 AND closed_at IS NULL`,
        [marketId, exitPrice]
      );
    } else {
      // Fallback: close at current_price (better than DELETE with no PnL)
      await query(
        `UPDATE paper_positions SET
          closed_at = NOW(),
          realized_pnl = (current_price - avg_entry_price) * size,
          size = 0,
          updated_at = NOW()
        WHERE market_id = $1 AND closed_at IS NULL`,
        [marketId]
      );
    }
  },

  async getExplorationStats(windowDays: number): Promise<{ count: number; pnl: number }> {
    const result = await query<{ count: string; pnl: string | null }>(
      `SELECT COUNT(*) AS count, COALESCE(SUM(realized_pnl), 0) AS pnl
       FROM paper_positions
       WHERE was_exploration = true
         AND closed_at >= NOW() - ($1 || ' days')::interval
         AND realized_pnl IS NOT NULL`,
      [String(windowDays)],
    );
    const row = result.rows[0];
    return {
      count: Number(row.count ?? 0),
      pnl: Number(row.pnl ?? 0),
    };
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
    const result = await query<{ time: Date; equity: number }>(
      `SELECT time, (current_capital + COALESCE(total_exposure, 0)) as equity
       FROM portfolio_snapshots
       WHERE time > NOW() - INTERVAL '1 day' * $1
       ORDER BY time ASC`,
      [days]
    );
    return result.rows.map((row) => ({
      time: row.time,
      value: parseFloat(row.equity as unknown as string),
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
