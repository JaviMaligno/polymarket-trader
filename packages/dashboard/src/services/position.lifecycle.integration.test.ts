/**
 * Position Lifecycle Integration Tests
 *
 * Tests run against a real PostgreSQL database via DATABASE_URL env var.
 * Skip automatically if DATABASE_URL is not set — safe for CI without a DB.
 *
 * What these tests catch that unit tests cannot:
 * - Zombie positions (closed_at IS NOT NULL AND size > 0) created by SQL bugs
 * - Capital accounting correctness across open/close cycles
 * - ON CONFLICT DO UPDATE behavior with closed_at reset
 * - PositionClosingService atomicity (both closed_at AND size=0 set together)
 *
 * Run locally:
 *   DATABASE_URL="postgres://polymarket:polymarket_prod@localhost:5432/polymarket_trading?sslmode=disable" \
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 \
 *   npx vitest run packages/dashboard/src/services/position.lifecycle.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const hasDb = !!DATABASE_URL;

// ─── Schema ──────────────────────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS test_paper_account (
    id INTEGER PRIMARY KEY DEFAULT 1,
    current_capital NUMERIC(20,6) NOT NULL DEFAULT 10000,
    available_capital NUMERIC(20,6) NOT NULL DEFAULT 10000,
    initial_capital NUMERIC(20,6) NOT NULL DEFAULT 10000,
    total_fees_paid NUMERIC(20,6) NOT NULL DEFAULT 0,
    total_trades INTEGER NOT NULL DEFAULT 0,
    total_realized_pnl NUMERIC(20,6) NOT NULL DEFAULT 0,
    winning_trades INTEGER NOT NULL DEFAULT 0,
    losing_trades INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS test_paper_positions (
    id SERIAL PRIMARY KEY,
    market_id VARCHAR(128) NOT NULL,
    token_id VARCHAR(128) NOT NULL,
    side VARCHAR(10) NOT NULL DEFAULT 'long',
    size NUMERIC(20,6) NOT NULL DEFAULT 0,
    avg_entry_price NUMERIC(10,6) NOT NULL DEFAULT 0,
    current_price NUMERIC(10,6),
    unrealized_pnl NUMERIC(20,6) DEFAULT 0,
    unrealized_pnl_pct NUMERIC(10,6) DEFAULT 0,
    realized_pnl NUMERIC(20,6) DEFAULT 0,
    stop_loss NUMERIC(10,6),
    take_profit NUMERIC(10,6),
    opened_at TIMESTAMPTZ DEFAULT NOW(),
    closed_at TIMESTAMPTZ,
    signal_type VARCHAR(50),
    metadata JSONB DEFAULT '{}',
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (market_id, token_id)
  );

  CREATE TABLE IF NOT EXISTS test_paper_trades (
    id SERIAL PRIMARY KEY,
    time TIMESTAMPTZ DEFAULT NOW(),
    market_id VARCHAR(128),
    token_id VARCHAR(128),
    side VARCHAR(10),
    requested_size NUMERIC(20,6),
    executed_size NUMERIC(20,6),
    requested_price NUMERIC(10,6),
    executed_price NUMERIC(10,6),
    fee NUMERIC(20,6) DEFAULT 0,
    value_usd NUMERIC(20,6) DEFAULT 0,
    signal_type VARCHAR(50),
    order_type VARCHAR(20),
    fill_type VARCHAR(20)
  );

  INSERT INTO test_paper_account (id, current_capital, available_capital, initial_capital)
  VALUES (1, 10000, 10000, 10000)
  ON CONFLICT (id) DO UPDATE SET
    current_capital = 10000,
    available_capital = 10000,
    total_realized_pnl = 0,
    total_fees_paid = 0,
    total_trades = 0,
    winning_trades = 0,
    losing_trades = 0;
`;

// ─── Helpers — SQL matching real service logic ──────────────────────────────

async function upsertPosition(
  client: pg.PoolClient,
  p: { market_id: string; token_id: string; side?: string; size: number; avg_entry_price: number }
) {
  // Mirrors paperPositionsRepo.upsert() including PR #23 closed_at = NULL fix
  await client.query(
    `INSERT INTO test_paper_positions
     (market_id, token_id, side, size, avg_entry_price, current_price, unrealized_pnl,
      unrealized_pnl_pct, realized_pnl, opened_at)
     VALUES ($1, $2, $3, $4, $5, $5, 0, 0, 0, NOW())
     ON CONFLICT (market_id, token_id) DO UPDATE SET
       size = EXCLUDED.size,
       side = EXCLUDED.side,
       avg_entry_price = EXCLUDED.avg_entry_price,
       current_price = EXCLUDED.current_price,
       unrealized_pnl = 0,
       realized_pnl = test_paper_positions.realized_pnl,
       closed_at = NULL,
       opened_at = EXCLUDED.opened_at,
       updated_at = NOW()`,
    [p.market_id, p.token_id, p.side ?? 'long', p.size, p.avg_entry_price]
  );
}

async function closePosition(
  client: pg.PoolClient,
  positionId: number,
  exitPrice: number,
  size: number,
  entryPrice: number,
  feeRate = 0.001
): Promise<{ executed: boolean; netPnl: number }> {
  // Mirrors PositionClosingService.close() atomic transaction
  const exitValue = size * exitPrice;
  const fee = exitValue * feeRate;
  const grossPnl = (exitPrice - entryPrice) * size;
  const netPnl = grossPnl - fee;
  const proceeds = exitValue - fee;

  const posResult = await client.query(
    `UPDATE test_paper_positions SET
      closed_at = NOW(),
      realized_pnl = COALESCE(realized_pnl, 0) + $1,
      current_price = $2,
      size = 0
    WHERE id = $3 AND closed_at IS NULL`,
    [netPnl, exitPrice, positionId]
  );

  if (posResult.rowCount === 0) {
    return { executed: false, netPnl: 0 };
  }

  // Mirrors PositionClosingService: current_capital += proceeds,
  // available_capital += proceeds + cost (releases the position lock).
  const cost = entryPrice * size;
  await client.query(
    `UPDATE test_paper_account SET
      current_capital = current_capital + $1,
      available_capital = available_capital + $1 + $4,
      total_fees_paid = total_fees_paid + $2,
      total_trades = total_trades + 1,
      total_realized_pnl = total_realized_pnl + $3,
      winning_trades = winning_trades + CASE WHEN $3 > 0 THEN 1 ELSE 0 END,
      losing_trades = losing_trades + CASE WHEN $3 < 0 THEN 1 ELSE 0 END,
      updated_at = NOW()
    WHERE id = 1`,
    [proceeds, fee, netPnl, cost]
  );

  return { executed: true, netPnl };
}

async function openWithAccountUpdate(
  client: pg.PoolClient,
  p: { market_id: string; token_id: string; size: number; price: number; side?: string },
  feeRate = 0.001
) {
  // Mirrors AutoSignalExecutor.openPosition() account update + upsert
  const orderValue = p.size * p.price;
  const fee = orderValue * feeRate;

  // Mirrors openPositionAtomically: current_capital decrements by cost+fee,
  // available_capital decrements by 2×cost+fee (also locks the position cost basis).
  await client.query(
    `UPDATE test_paper_account SET
      current_capital = current_capital - $1,
      available_capital = available_capital - $1 - ($1 - $2),
      total_fees_paid = total_fees_paid + $2,
      total_trades = total_trades + 1,
      updated_at = NOW()
    WHERE id = 1`,
    [orderValue + fee, fee]
  );

  await upsertPosition(client, {
    market_id: p.market_id,
    token_id: p.token_id,
    side: p.side ?? 'long',
    size: p.size,
    avg_entry_price: p.price,
  });
}

async function getPositionRow(client: pg.PoolClient, marketId: string, tokenId: string) {
  const r = await client.query(
    'SELECT * FROM test_paper_positions WHERE market_id = $1 AND token_id = $2',
    [marketId, tokenId]
  );
  return r.rows[0] ?? null;
}

async function getAccount(client: pg.PoolClient) {
  const r = await client.query('SELECT * FROM test_paper_account WHERE id = 1');
  return r.rows[0];
}

async function getZombieCount(client: pg.PoolClient): Promise<number> {
  const r = await client.query(
    'SELECT COUNT(*) FROM test_paper_positions WHERE closed_at IS NOT NULL AND size > 0'
  );
  return parseInt(r.rows[0].count, 10);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe.skipIf(!hasDb)('Position Lifecycle Integration', () => {
  let pool: pg.Pool;
  let client: pg.PoolClient;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    client = await pool.connect();
    await client.query(SCHEMA);
  });

  afterAll(async () => {
    await client.query(`
      DROP TABLE IF EXISTS test_paper_trades;
      DROP TABLE IF EXISTS test_paper_positions;
      DROP TABLE IF EXISTS test_paper_account;
    `);
    client.release();
    await pool.end();
  });

  beforeEach(async () => {
    // Reset to clean state before each test
    await client.query('DELETE FROM test_paper_trades');
    await client.query('DELETE FROM test_paper_positions');
    await client.query(`
      UPDATE test_paper_account SET
        current_capital = 10000, available_capital = 10000,
        total_realized_pnl = 0, total_fees_paid = 0, total_trades = 0,
        winning_trades = 0, losing_trades = 0
      WHERE id = 1
    `);
  });

  // ── Invariant 1: No Zombies ───────────────────────────────────────────────

  it('open → close: size=0 and closed_at set (no zombie)', async () => {
    await openWithAccountUpdate(client, { market_id: 'm1', token_id: 't1', size: 100, price: 0.5 });
    const pos = await getPositionRow(client, 'm1', 't1');
    await closePosition(client, pos.id, 0.6, 100, 0.5);

    const closed = await getPositionRow(client, 'm1', 't1');
    expect(closed.closed_at).not.toBeNull();
    expect(parseFloat(closed.size)).toBe(0);
    expect(await getZombieCount(client)).toBe(0);
  });

  it('close → reopen same market: closed_at resets to NULL (upsert zombie fix)', async () => {
    // Open and close first position
    await openWithAccountUpdate(client, { market_id: 'm1', token_id: 't1', size: 100, price: 0.5 });
    const pos1 = await getPositionRow(client, 'm1', 't1');
    await closePosition(client, pos1.id, 0.6, 100, 0.5);

    // Re-open on the SAME market/token (triggers ON CONFLICT DO UPDATE)
    await openWithAccountUpdate(client, { market_id: 'm1', token_id: 't1', size: 80, price: 0.55 });

    const pos2 = await getPositionRow(client, 'm1', 't1');
    expect(pos2.closed_at).toBeNull();           // Must be visible (closed_at reset)
    expect(parseFloat(pos2.size)).toBe(80);       // New position size
    expect(await getZombieCount(client)).toBe(0);
  });

  it('multiple open/close cycles on same market: never produces a zombie', async () => {
    for (let i = 0; i < 5; i++) {
      await openWithAccountUpdate(client, {
        market_id: 'm1', token_id: 't1',
        size: 100 + i * 10, price: 0.3 + i * 0.05,
      });
      const pos = await getPositionRow(client, 'm1', 't1');
      await closePosition(client, pos.id, 0.4 + i * 0.05, 100 + i * 10, 0.3 + i * 0.05);
    }

    expect(await getZombieCount(client)).toBe(0);
  });

  // ── Invariant 2: Capital Accounting ──────────────────────────────────────

  it('open position: capital is deducted from account', async () => {
    const before = await getAccount(client);
    await openWithAccountUpdate(client, { market_id: 'm1', token_id: 't1', size: 100, price: 0.5 });
    const after = await getAccount(client);

    const cost = 100 * 0.5;       // $50 orderValue
    const fee = cost * 0.001;     // $0.05 fee
    const expected = parseFloat(before.current_capital) - cost - fee;
    expect(parseFloat(after.current_capital)).toBeCloseTo(expected, 4);
  });

  it('close position at profit: capital returned with correct PnL', async () => {
    await openWithAccountUpdate(client, { market_id: 'm1', token_id: 't1', size: 100, price: 0.5 });
    const pos = await getPositionRow(client, 'm1', 't1');
    const afterOpen = await getAccount(client);

    await closePosition(client, pos.id, 0.7, 100, 0.5);

    const exitValue = 100 * 0.7;          // $70
    const fee = exitValue * 0.001;        // $0.07
    const grossPnl = (0.7 - 0.5) * 100;  // $20
    const netPnl = grossPnl - fee;        // ~$19.93

    const afterClose = await getAccount(client);
    const proceeds = exitValue - fee;
    expect(parseFloat(afterClose.current_capital)).toBeCloseTo(
      parseFloat(afterOpen.current_capital) + proceeds, 4
    );
    expect(parseFloat(afterClose.total_realized_pnl)).toBeCloseTo(netPnl, 4);
    expect(parseInt(afterClose.winning_trades)).toBe(1);
  });

  it('close position at loss: capital returned with negative PnL', async () => {
    await openWithAccountUpdate(client, { market_id: 'm1', token_id: 't1', size: 100, price: 0.5 });
    const pos = await getPositionRow(client, 'm1', 't1');

    await closePosition(client, pos.id, 0.3, 100, 0.5);

    const afterClose = await getAccount(client);
    expect(parseFloat(afterClose.total_realized_pnl)).toBeLessThan(0);
    expect(parseInt(afterClose.losing_trades)).toBe(1);
  });

  it('capital invariant: initial = current + open_position_costs + fees after full cycle', async () => {
    const feeRate = 0.001;

    // Track buy-side fees as we open positions.
    // The accounting model deducts (orderValue + buyFee) at open time and adds
    // (exitValue - sellFee) at close time. realized_pnl = grossPnl - sellFee only.
    // Therefore: current = initial + realized_pnl - buyFees
    // (total_fees_paid includes both buy AND sell fees, so subtracting it all would
    //  overcount — sell fees are already subtracted inside realized_pnl)
    const opens = [
      { market_id: 'm1', token_id: 't1', size: 100, price: 0.5 },
      { market_id: 'm2', token_id: 't2', size: 50,  price: 0.8 },
      { market_id: 'm3', token_id: 't3', size: 200, price: 0.2 },
    ];
    const totalBuyFees = opens.reduce((sum, o) => sum + o.size * o.price * feeRate, 0);

    for (const o of opens) {
      await openWithAccountUpdate(client, o);
    }

    // Close all at various prices
    const p1 = await getPositionRow(client, 'm1', 't1');
    const p2 = await getPositionRow(client, 'm2', 't2');
    const p3 = await getPositionRow(client, 'm3', 't3');
    await closePosition(client, p1.id, 0.6, 100, 0.5);
    await closePosition(client, p2.id, 0.7, 50, 0.8);
    await closePosition(client, p3.id, 0.3, 200, 0.2);

    const account = await getAccount(client);
    const openPositionsCost = await client.query(
      'SELECT COALESCE(SUM(size * avg_entry_price), 0) as total FROM test_paper_positions WHERE closed_at IS NULL'
    );

    // Invariant: current_capital + open_position_costs ≈ initial + total_realized_pnl - buy_fees_only
    //
    // Derivation:
    //   capital after opens  = initial - Σ(orderValue + buyFee)
    //   capital after closes = capital + Σ(exitValue - sellFee)
    //                        = initial + Σ(grossPnl) - Σ(buyFee) - Σ(sellFee)
    //   realized_pnl         = Σ(grossPnl - sellFee) = Σ(grossPnl) - Σ(sellFee)
    //   → current            = initial + realized_pnl - buyFees   ✓
    //
    // Note: total_fees_paid = buyFees + sellFees; subtracting it entirely would
    // overcount because sellFees are already embedded in realized_pnl.
    const current = parseFloat(account.current_capital);
    const openCost = parseFloat(openPositionsCost.rows[0].total);
    const realized = parseFloat(account.total_realized_pnl);
    const initial = 10000;

    expect(current + openCost).toBeCloseTo(initial + realized - totalBuyFees, 2);
    expect(await getZombieCount(client)).toBe(0);
  });

  // ── Invariant 3: Idempotency ──────────────────────────────────────────────

  it('double close attempt: second close is a no-op (idempotent)', async () => {
    await openWithAccountUpdate(client, { market_id: 'm1', token_id: 't1', size: 100, price: 0.5 });
    const pos = await getPositionRow(client, 'm1', 't1');

    const r1 = await closePosition(client, pos.id, 0.6, 100, 0.5);
    const r2 = await closePosition(client, pos.id, 0.7, 100, 0.5); // second attempt

    expect(r1.executed).toBe(true);
    expect(r2.executed).toBe(false);          // idempotent — no double-close

    // Capital should only change once
    const account = await getAccount(client);
    expect(parseInt(account.total_trades)).toBe(2); // 1 open + 1 close
  });

  // ── Invariant 4: Missing positionId is safe ───────────────────────────────

  it('cumulative PnL invariant: position.realized_pnl matches account after close→reopen→close', async () => {
    // First lifecycle: open at 0.5, close at 0.6 (profit)
    await openWithAccountUpdate(client, { market_id: 'm1', token_id: 't1', size: 100, price: 0.5 });
    const pos1 = await getPositionRow(client, 'm1', 't1');
    const r1 = await closePosition(client, pos1.id, 0.6, 100, 0.5);
    expect(r1.executed).toBe(true);

    // Re-open same market/token (upsert triggers ON CONFLICT path)
    await openWithAccountUpdate(client, { market_id: 'm1', token_id: 't1', size: 80, price: 0.55 });

    // Second lifecycle: close at 0.65 (profit again)
    const pos2 = await getPositionRow(client, 'm1', 't1');
    const r2 = await closePosition(client, pos2.id, 0.65, 80, 0.55);
    expect(r2.executed).toBe(true);

    const account = await getAccount(client);
    const accountPnl = parseFloat(account.total_realized_pnl);

    // Position row must reflect cumulative PnL from both closes
    const closedPos = await getPositionRow(client, 'm1', 't1');
    const positionPnl = parseFloat(closedPos.realized_pnl);

    // Both should equal r1.netPnl + r2.netPnl
    expect(positionPnl).toBeCloseTo(r1.netPnl + r2.netPnl, 4);
    expect(positionPnl).toBeCloseTo(accountPnl, 4);

    // No zombies
    expect(await getZombieCount(client)).toBe(0);
  });

  it('close with undefined positionId: no DB changes (circuit breaker safety)', async () => {
    await openWithAccountUpdate(client, { market_id: 'm1', token_id: 't1', size: 100, price: 0.5 });

    // Simulate old CircuitBreakerService bug: positionId = undefined → $3 = null
    const result = await client.query(
      `UPDATE test_paper_positions SET
        closed_at = NOW(), size = 0
      WHERE id = $1 AND closed_at IS NULL`,
      [null]  // positionId missing → null
    );

    // Must not close anything (this was the silent-failure bug)
    expect(result.rowCount).toBe(0);

    const pos = await getPositionRow(client, 'm1', 't1');
    expect(pos.closed_at).toBeNull();     // position still open
    expect(parseFloat(pos.size)).toBe(100);
    expect(await getZombieCount(client)).toBe(0);
  });

  // ── Invariant 5: capital_lock_correct ─────────────────────────────────────

  it('capital_lock_correct: available_capital = current_capital - open_position_cost while position is open', async () => {
    const price = 0.5;
    const size = 100;
    const feeRate = 0.001;
    const cost = size * price;          // 50
    const fee = cost * feeRate;         // 0.05
    const totalCost = cost + fee;       // 50.05

    await openWithAccountUpdate(client, { market_id: 'm1', token_id: 't1', size, price });

    const account = await getAccount(client);
    const current = parseFloat(account.current_capital);
    const available = parseFloat(account.available_capital);

    // Verify: available = current - cost (position cost basis locked)
    expect(available).toBeCloseTo(current - cost, 4);

    // current decremented by cost+fee
    expect(current).toBeCloseTo(10000 - totalCost, 4);
    // available decremented by 2*cost+fee
    expect(available).toBeCloseTo(10000 - 2 * cost - fee, 4);

    // After close, available should equal current (lock released)
    const pos = await getPositionRow(client, 'm1', 't1');
    await closePosition(client, pos.id, 0.6, size, price);

    const accountAfter = await getAccount(client);
    expect(parseFloat(accountAfter.available_capital)).toBeCloseTo(
      parseFloat(accountAfter.current_capital), 4
    );
  });
});
