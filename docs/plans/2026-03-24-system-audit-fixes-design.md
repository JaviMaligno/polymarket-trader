# System Audit Fixes — 2026-03-24

## Context

Independent review of the auto-review (issue #47) found 15 issues across 3 severity levels that the auto-review missed. Most critically, the reported 190% return ($19K PnL) is phantom — real cash profit is ~$426. Root cause: `realized_pnl` accumulates across position re-opens via upsert.

## Findings Summary

### Critical
1. **Phantom PnL**: upsert preserves `realized_pnl` across re-opens → PnL accumulates across cycles
2. **Port 5432 brute force**: 36,544 auth failures/24h, open to internet
3. **Race condition**: concurrent signals can double-debit capital for same market

### High
4. `available_capital` not locked when opening positions
5. OOM Kill on data-collector (60 MiB limit) → 2 restarts/24h
6. 21 DB connection timeouts cascading to StopLoss, CircuitBreaker, RiskManager
7. Daily PnL check mixes equity (snapshot) with cash (current_capital) → spurious halts

### Medium
8. Only 2/5 signal weights loaded on startup (missing OFI, MLOFI, Hawkes)
9. Render Optuna returning 500 errors on trials
10. 4 markets with empty `token_id` sent to CLOB API
11. 10 markets marked active with price data 3-25 weeks old
12. `checkDayReset()` not awaited in RiskManager

### Low
13. SignalLearning always "0 signals, 0 adjusted" — non-functional
14. Consecutive-loss counter resets on restart (not persisted)
15. Drawdown check uses env var `INITIAL_CAPITAL`, not DB value

## Execution Plan

### Phase 1 — Immediate Security (today)

**1. Restrict GCP firewall**

Update `allow-postgres-render` rule to restrict source IPs to Render's egress ranges only. Currently allows `0.0.0.0/0`.

```bash
gcloud compute firewall-rules update allow-postgres-render \
  --source-ranges="<render-egress-ips>" \
  --description="PostgreSQL access restricted to Render egress IPs"
```

Future: close port entirely, move optimization inside VM (Phase B).

**2. Increase data-collector memory limit**

In `docker-compose.gcp.yml`, change memory limit from 60M to 150M. Dashboard-api uses 180M at 35% — there is headroom on the 1GB VM.

### Phase 2 — Critical PnL Fix (today)

**3. Eliminate upsert — always INSERT**

Replace `ON CONFLICT (market_id, token_id) DO UPDATE` in `paperPositionsRepo.upsert()` with a plain INSERT. Add a partial unique index:

```sql
CREATE UNIQUE INDEX idx_one_open_position_per_token
  ON paper_positions (market_id, token_id)
  WHERE closed_at IS NULL;
```

This prevents two open positions on the same token at DB level while allowing multiple closed rows.

**4. Atomic transaction**

Wrap the position-opening flow in AutoSignalExecutor in a single DB transaction:

```
BEGIN
  SELECT FROM paper_positions
    WHERE market_id=$1 AND token_id=$2 AND closed_at IS NULL
    FOR UPDATE
  → if exists, ROLLBACK
  UPDATE paper_account
    SET available_capital = available_capital - $cost,
        current_capital = current_capital - $cost
  INSERT INTO paper_positions (...)
COMMIT
```

This serializes concurrent signals for the same token. The second signal waits for the lock and sees the already-inserted position.

**5. Account reset from real cash flows**

Script to recalculate capital from `paper_trades` (source of truth for actual cash movement):

```sql
WITH flows AS (
  SELECT
    SUM(CASE WHEN side='sell' THEN amount ELSE -amount END) as net_cash,
    SUM(fee) as total_fees
  FROM paper_trades
)
UPDATE paper_account SET
  current_capital = initial_capital + flows.net_cash,
  available_capital = initial_capital + flows.net_cash,
  total_realized_pnl = flows.net_cash + flows.total_fees,
  total_fees_paid = flows.total_fees
FROM flows;
```

### Phase 3 — Medium/Low Code Fixes

**6. Fix `available_capital` locking**

The atomic transaction from Phase 2 already debits both `current_capital` and `available_capital`. Verify `PositionClosingService` correctly restores both on close.

**7. Daily PnL check — consistent metric**

In `RiskManager.ts:219`, `dayStartEquity` is equity (from snapshot) but compared to `currentCapital` (cash only). Fix: change `PaperTradingService.recordSnapshot()` to store `current_capital` instead of `equity`, making the comparison cash-vs-cash.

**8. Load all 5 signal weights on startup**

In `server.ts:227-243`, add `ofi`, `mlofi`, and `hawkes` to the `weightMap`. Without this, optimizer results for these 3 signal types are silently ignored on restart.

**9. Await `checkDayReset()`**

In `RiskManager.ts:177`, add `await`. One-word fix.

**10. Persist consecutive-loss counter**

Store `consecutiveLosses` in `trading_config` table (same pattern as stop-loss cooldowns). Load on startup. Prevents restart from resetting the circuit breaker counter.

### Phase 4 — Auto-Review Improvements

**11. Expand `daily-review.sh` data collection**

Add generic sections to the JSON output:

- `container_health`: restart count, memory %, uptime, OOM kills from dmesg
- `error_summary`: error count by service, grouped by category (DB timeout, API error, unhandled rejection)
- `db_security`: FATAL count in TimescaleDB logs (detects auth attacks generically)
- `disk_and_resources`: disk usage, active DB connections

Principle: collect data the model can interpret, don't pre-diagnose.

**12. Generalized SQL invariant checks**

Add an `invariant_checks` section with PASS/FAIL queries:

- `capital_consistency`: `|current_capital - (initial + net_cash_flows)| < $1`
- `available_vs_locked`: `|available_capital - (current_capital - SUM(open costs))| < $1`
- `pnl_crosscheck`: `|total_realized_pnl - net_cash_flows| < tolerance`
- `no_zombies`: `COUNT(*) WHERE closed_at IS NOT NULL AND size > 0 = 0`
- `no_orphaned_capital`: open positions must have corresponding locked capital

These validate system invariants regardless of what specific bugs exist.

**13. Weekly deep code review (later)**

Separate workflow with code-reviewer agent. Design after Phases 1-3 complete.

## Decisions

- Upsert eliminated entirely (not just `realized_pnl = 0`) — cleaner data model
- Account reset from cash flows, not clean slate — preserves trade history
- Firewall restricted to Render IPs now, full closure later
- Auto-review improvements are generic invariant checks, not overfitted to today's bugs
- Snapshot stores cash not equity — simpler, avoids mixing metrics
