# System Audit Fixes — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 15 issues found by independent system audit, starting with security and phantom PnL, then code fixes and auto-review improvements.

**Architecture:** Phase 1 is infra-only (firewall + docker-compose). Phase 2 rewrites position opening to use INSERT + transaction instead of upsert. Phase 3 is targeted code fixes. Phase 4 adds invariant checks to daily-review.sh.

**Tech Stack:** TypeScript (Node.js), PostgreSQL/TimescaleDB, Docker Compose, GCP Firewall, Bash

---

### Task 1: Restrict GCP Firewall to Render IPs

**Files:**
- Modify: `docker-compose.gcp.yml` (port binding)

**Step 1: Get Render's egress IPs and current firewall rule**

Run:
```bash
gcloud compute firewall-rules describe allow-postgres-render --format="yaml(sourceRanges,direction,allowed)"
```
Expected: Shows `sourceRanges: ['0.0.0.0/0']`

Then get the Render service's outbound IP:
```bash
# Check Render docs or the service's outbound IP
curl -s https://polymarket-optimizer-server.onrender.com/health 2>/dev/null || echo "Check Render dashboard for static outbound IPs"
```

**Step 2: Update firewall rule to restrict source IPs**

If Render provides static outbound IPs, use those. Otherwise, restrict to Render's Oregon region ranges. As a minimum, remove `0.0.0.0/0`:

```bash
gcloud compute firewall-rules update allow-postgres-render \
  --source-ranges="<RENDER_IP_1>/32,<RENDER_IP_2>/32" \
  --description="PostgreSQL access restricted to Render Optuna optimizer egress IPs"
```

If Render IPs are dynamic/unknown, bind TimescaleDB to localhost only as an interim measure — change `docker-compose.gcp.yml` port from `"5432:5432"` to `"127.0.0.1:5432:5432"`. This blocks all external access. Optuna would need an SSH tunnel or to run on the VM.

**Step 3: Verify the firewall change**

```bash
gcloud compute firewall-rules describe allow-postgres-render --format="value(sourceRanges)"
```
Expected: Shows the restricted IP range, NOT `0.0.0.0/0`

**Step 4: Commit**

```bash
git add docker-compose.gcp.yml
git commit -m "fix: restrict port 5432 firewall to Render IPs only

Closes active brute-force attack (36,544 auth failures/24h).
Previously open to 0.0.0.0/0 for Render Optuna."
```

---

### Task 2: Increase Data Collector Memory Limit

**Files:**
- Modify: `docker-compose.gcp.yml:88-93`

**Step 1: Update memory limits**

In `docker-compose.gcp.yml`, change the data-collector deploy resources:

```yaml
# Before:
    deploy:
      resources:
        limits:
          memory: 60M
        reservations:
          memory: 40M

# After:
    deploy:
      resources:
        limits:
          memory: 150M
        reservations:
          memory: 60M
```

Also update the comment at top of file:
```yaml
# Before:
# Memory budget: TimescaleDB 350M + Data Collector 60M + Dashboard 180M = 590M

# After:
# Memory budget: TimescaleDB 350M + Data Collector 150M + Dashboard 180M = 680M
```

**Step 2: Verify total memory budget is under 1GB**

350M + 150M + 180M = 680M. VM has 1GB. Linux overhead ~200M. Fits.

**Step 3: Commit**

```bash
git add docker-compose.gcp.yml
git commit -m "fix: increase data-collector memory limit 60M→150M

OOM killer was hitting the container (2 restarts/24h).
55% usage at 60M left no headroom for spikes."
```

---

### Task 3: Deploy Phase 1 to VM

**Step 1: Push changes and wait for CI/CD, or deploy manually**

```bash
git push origin main
```

Then SSH to VM and pull:
```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="cd /home/Usuario/polymarket-trader && git pull && docker compose -f docker-compose.gcp.yml up -d --remove-orphans"
```

**Step 2: Verify containers are healthy**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker ps --format 'table {{.Names}}\t{{.Status}}'"
```
Expected: All 3 containers show "healthy"

**Step 3: Verify data-collector memory**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker stats --no-stream --format '{{.Name}}: {{.MemUsage}}' polymarket-data-collector"
```
Expected: Shows `X MiB / 150 MiB` instead of old `/ 60 MiB`

---

### Task 4: Add Partial Unique Index for Open Positions

**Files:**
- Modify: `packages/dashboard/src/database/repositories.ts:339-384`
- Modify: `packages/data-collector/src/database/init/001-schema.sql` (if index needs to be in init scripts)

**Step 1: Create a migration SQL to add the partial unique index**

The index needs to be created on the VM DB. Add it to the init script AND run it manually for existing DB.

Add to the bottom of the init SQL (or create a new migration script):

```sql
-- Partial unique index: only one open position per (market_id, token_id)
-- Allows multiple closed rows for the same pair
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_position_per_token
  ON paper_positions (market_id, token_id)
  WHERE closed_at IS NULL;
```

**Step 2: Run migration on VM**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_position_per_token ON paper_positions (market_id, token_id) WHERE closed_at IS NULL;\""
```

Expected: `CREATE INDEX` (or notice if already exists)

If it fails with "duplicate key", there are multiple open positions for the same token. Fix first:
```sql
-- Close duplicates keeping only the most recent
UPDATE paper_positions SET closed_at = NOW(), size = 0
WHERE id NOT IN (
  SELECT DISTINCT ON (market_id, token_id) id
  FROM paper_positions
  WHERE closed_at IS NULL
  ORDER BY market_id, token_id, opened_at DESC
)
AND closed_at IS NULL;
```

**Step 3: Commit**

```bash
git add packages/data-collector/src/database/init/
git commit -m "feat: add partial unique index for one open position per token

Prevents phantom PnL from upsert re-opens. Only one open position
allowed per (market_id, token_id) at DB level."
```

---

### Task 5: Replace Upsert with INSERT + Atomic Transaction

**Files:**
- Modify: `packages/dashboard/src/database/repositories.ts:338-434`
- Modify: `packages/dashboard/src/services/AutoSignalExecutor.ts:360-370,640-690`
- Test: `packages/dashboard/src/database/repositories.test.ts`

**Step 1: Replace `paperPositionsRepo.upsert()` with `insert()`**

In `packages/dashboard/src/database/repositories.ts`, replace the `upsert` method:

```typescript
export const paperPositionsRepo = {
  /**
   * Insert a new position. Relies on partial unique index
   * idx_one_open_position_per_token to prevent duplicates.
   */
  async insert(position: PaperPosition): Promise<void> {
    await query(
      `INSERT INTO paper_positions
       (market_id, token_id, side, size, avg_entry_price, current_price,
        unrealized_pnl, unrealized_pnl_pct, realized_pnl, stop_loss, take_profit,
        opened_at, signal_type, metadata, market_score_at_entry, score_dimensions_at_entry,
        execution_mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
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
      ]
    );
  },
```

Keep the old `upsert` method but mark it `@deprecated` and have it call `insert()` internally as a shim if any other code still references it.

**Step 2: Create `openPositionAtomically()` in repositories.ts**

Add a new method that wraps the entire open-position flow in a transaction:

```typescript
  /**
   * Atomically: check no open position exists → debit account → insert position.
   * Uses SELECT FOR UPDATE to serialize concurrent opens on the same token.
   * Returns false if position already exists (no-op).
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

        // Debit account atomically
        const acctResult = await client.query(
          `UPDATE paper_account SET
            current_capital = current_capital - $1,
            available_capital = available_capital - $1,
            total_fees_paid = total_fees_paid + $2,
            total_trades = total_trades + 1,
            updated_at = NOW()
          WHERE id = 1
          RETURNING available_capital`,
          [cost + fee, fee]
        );

        const newAvailable = parseFloat(acctResult.rows[0]?.available_capital ?? '0');
        if (newAvailable < 0) {
          // Insufficient capital — transaction will rollback
          throw new Error(`Insufficient capital: available would be $${newAvailable.toFixed(2)}`);
        }

        // Insert position
        await client.query(
          `INSERT INTO paper_positions
           (market_id, token_id, side, size, avg_entry_price, current_price,
            unrealized_pnl, unrealized_pnl_pct, realized_pnl, stop_loss, take_profit,
            opened_at, signal_type, metadata, market_score_at_entry, score_dimensions_at_entry,
            execution_mode)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
          [
            position.market_id,
            position.token_id,
            position.side,
            position.size,
            position.avg_entry_price,
            position.current_price,
            position.unrealized_pnl ?? 0,
            position.unrealized_pnl_pct ?? 0,
            0, // realized_pnl always starts at 0
            position.stop_loss,
            position.take_profit,
            position.opened_at,
            position.signal_type,
            JSON.stringify(position.metadata ?? {}),
            position.market_score_at_entry ?? null,
            position.score_dimensions_at_entry != null
              ? JSON.stringify(position.score_dimensions_at_entry)
              : null,
            position.execution_mode ?? 'paper',
          ]
        );

        return { opened: true };
      });
    } catch (error: any) {
      // Unique constraint violation = race condition caught by index
      if (error.code === '23505') {
        return { opened: false, reason: 'Position already open (unique constraint)' };
      }
      throw error;
    }
  },
```

**Step 3: Update AutoSignalExecutor to use `openPositionAtomically()`**

In `packages/dashboard/src/services/AutoSignalExecutor.ts`, replace lines 641-689 (the account debit + upsert + reversal block) with:

```typescript
      // Open position atomically: check + debit + insert in one transaction
      const openResult = await paperPositionsRepo.openPositionAtomically(
        {
          market_id: signal.marketId,
          token_id: signal.tokenId,
          side: signal.direction === 'long' ? 'long' : 'short',
          size: actualShares,
          avg_entry_price: actualPrice,
          current_price: actualPrice,
          unrealized_pnl: 0,
          opened_at: new Date(),
          signal_type: signal.signalId,
          market_score_at_entry: marketScoreAtEntry,
          score_dimensions_at_entry: scoreDimensionsAtEntry ?? undefined,
          execution_mode: executionMode,
        },
        actualValue,
        actualFee,
      );

      if (!openResult.opened) {
        // Position already exists or insufficient capital — delete the trade record
        try {
          await query('DELETE FROM paper_trades WHERE id = $1', [trade.id]);
        } catch (delError) {
          console.error('Failed to delete orphaned trade:', delError);
        }
        return { executed: false, reason: openResult.reason || 'Position open failed' };
      }
```

This replaces the separate debit → upsert → reversal pattern with a single atomic call. No reversal needed — if anything fails, the transaction rolls back.

**Step 4: Also remove the pre-check on lines 360-372**

The existing position check at lines 360-372 (`positions = await paperPositionsRepo.getAll(); existingPosition = ...`) is now redundant for open-detection since the transaction handles it. However, keep it because it's also used for:
- Detecting existing positions to close (line 376: `isClosingExistingLong`)
- Per-market concentration limit (line 391)

So keep those lines but remove the early-return based on `existingPosition` for opens — the transaction handles that.

**Step 5: Fix PositionClosingService PnL formula**

In `packages/dashboard/src/services/PositionClosingService.ts:117`, change from additive to absolute:

```typescript
// Before (additive — accumulates across re-opens):
realized_pnl = COALESCE(realized_pnl, 0) + $1,

// After (absolute — each position is independent):
realized_pnl = $1,
```

Since positions are no longer re-opened via upsert (each cycle creates a new row), each position's `realized_pnl` should reflect only its own cycle's PnL.

**Step 6: Update existing tests**

In `packages/dashboard/src/database/repositories.test.ts`, replace any calls to `paperPositionsRepo.upsert()` with `paperPositionsRepo.insert()`.

In `packages/dashboard/src/services/AutoSignalExecutor.test.ts`, update mocks to expect `openPositionAtomically()` instead of `upsert()`.

In `packages/dashboard/src/services/PositionClosingService.test.ts`, verify the test expects `realized_pnl = netPnl` (not additive).

**Step 7: Run tests**

```bash
cd packages/dashboard && npx vitest run
```
Expected: All tests pass

**Step 8: Commit**

```bash
git add packages/dashboard/src/database/repositories.ts packages/dashboard/src/services/AutoSignalExecutor.ts packages/dashboard/src/services/PositionClosingService.ts packages/dashboard/src/database/repositories.test.ts packages/dashboard/src/services/AutoSignalExecutor.test.ts packages/dashboard/src/services/PositionClosingService.test.ts
git commit -m "fix: replace upsert with atomic INSERT + transaction for positions

Fixes phantom PnL bug where realized_pnl accumulated across
position re-opens via ON CONFLICT. Each position is now a fresh row.
Transaction serializes concurrent opens with SELECT FOR UPDATE.
PositionClosingService writes absolute PnL, not additive."
```

---

### Task 6: Reset Account from Real Cash Flows

**Step 1: Run the reset SQL on the VM**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"
WITH flows AS (
  SELECT
    COALESCE(SUM(CASE WHEN side = 'sell' THEN amount ELSE -amount END), 0) as net_cash,
    COALESCE(SUM(fee), 0) as total_fees
  FROM paper_trades
)
UPDATE paper_account SET
  current_capital = initial_capital + flows.net_cash,
  available_capital = initial_capital + flows.net_cash
    - COALESCE((SELECT SUM(size * avg_entry_price) FROM paper_positions WHERE closed_at IS NULL), 0),
  total_realized_pnl = flows.net_cash + flows.total_fees,
  total_fees_paid = flows.total_fees,
  peak_equity = GREATEST(peak_equity, initial_capital + flows.net_cash),
  updated_at = NOW()
FROM flows
WHERE paper_account.id = 1
RETURNING current_capital, available_capital, total_realized_pnl, total_fees_paid;
\""
```

**Step 2: Verify the reset**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"
SELECT current_capital, available_capital, initial_capital, total_realized_pnl, total_fees_paid,
  current_capital - (initial_capital + total_realized_pnl - total_fees_paid) as accounting_gap
FROM paper_account LIMIT 1;
\""
```
Expected: `accounting_gap` should be ~0 (or equal to open position cost if positions are open).

---

### Task 7: Fix Daily PnL Check — Consistent Metric

**Files:**
- Modify: `packages/dashboard/src/services/PaperTradingService.ts:255`
- Modify: `packages/dashboard/src/services/RiskManager.ts:177,219`

**Step 1: Fix snapshot to store cash, not equity**

In `packages/dashboard/src/services/PaperTradingService.ts:255`:

```typescript
// Before:
current_capital: equity,

// After:
current_capital: currentCapital,
```

This makes the snapshot's `current_capital` field actually store cash (current_capital from paper_account), not equity.

**Step 2: Await checkDayReset()**

In `packages/dashboard/src/services/RiskManager.ts:177`:

```typescript
// Before:
this.checkDayReset();

// After:
await this.checkDayReset();
```

**Step 3: Fix daily PnL comparison to use equity consistently**

In `packages/dashboard/src/services/RiskManager.ts:219-221`, since `dayStartEquity` now stores actual cash from snapshot, and `currentCapital` is also cash, the comparison is now cash-vs-cash. Both sides are on the same basis.

No code change needed here — the fix in Step 1 aligns the data.

**Step 4: Run tests**

```bash
cd packages/dashboard && npx vitest run -- RiskManager
```
Expected: Tests pass

**Step 5: Commit**

```bash
git add packages/dashboard/src/services/PaperTradingService.ts packages/dashboard/src/services/RiskManager.ts
git commit -m "fix: daily PnL check now compares cash-vs-cash consistently

Snapshot was storing equity but RiskManager compared it to cash,
causing spurious daily-loss halts when capital was deployed."
```

---

### Task 8: Load All 5 Signal Weights on Startup

**Files:**
- Modify: `packages/dashboard/src/server.ts:227-242`

**Step 1: Add missing signal types to weightMap**

In `packages/dashboard/src/server.ts:227-230`:

```typescript
// Before:
const weightMap: Record<string, string> = {
  'combiner.momentumWeight': 'momentum',
  'combiner.meanReversionWeight': 'mean_reversion',
};

// After:
const weightMap: Record<string, string> = {
  'combiner.momentumWeight': 'momentum',
  'combiner.meanReversionWeight': 'mean_reversion',
  'combiner.ofiWeight': 'ofi',
  'combiner.mlofiWeight': 'mlofi',
  'combiner.hawkesWeight': 'hawkes',
};
```

**Step 2: Commit**

```bash
git add packages/dashboard/src/server.ts
git commit -m "fix: load all 5 signal weights on startup, not just 2

OFI, MLOFI, and Hawkes weights from optimizer were silently
ignored on restart."
```

---

### Task 9: Persist Consecutive-Loss Counter

**Files:**
- Modify: `packages/dashboard/src/services/CircuitBreakerService.ts:59,74-96,122-138`

**Step 1: Load consecutive losses on startup**

In `CircuitBreakerService.start()`, after the `CREATE TABLE IF NOT EXISTS` block (line 96), add:

```typescript
    // Load consecutive loss counter from DB
    try {
      const result = await query<{ value: string }>(
        `SELECT value FROM trading_config WHERE key = 'consecutive_losses'`
      );
      if (result.rows[0]) {
        this.consecutiveLosses = parseInt(result.rows[0].value, 10) || 0;
        console.log(`[CircuitBreaker] Loaded consecutive losses from DB: ${this.consecutiveLosses}`);
      }
    } catch (err) {
      // Non-critical
    }
```

**Step 2: Persist on change**

In the `onPositionClosed` handler (lines 123-138), after `this.consecutiveLosses++` and after `this.consecutiveLosses = 0`, add a persist call:

```typescript
// After incrementing or resetting:
query(
  `INSERT INTO trading_config (key, value, description, updated_at)
   VALUES ('consecutive_losses', $1, 'Consecutive losing trades counter', NOW())
   ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
  [String(this.consecutiveLosses)]
).catch(() => {}); // fire-and-forget, non-critical
```

**Step 3: Run tests**

```bash
cd packages/dashboard && npx vitest run -- CircuitBreaker
```

**Step 4: Commit**

```bash
git add packages/dashboard/src/services/CircuitBreakerService.ts
git commit -m "fix: persist consecutive-loss counter across restarts

Counter was in-memory only, resetting to 0 on restart.
Now stored in trading_config table."
```

---

### Task 10: Remove Deprecated `paperPositionsRepo.close()` and Fix `.get()`

**Files:**
- Modify: `packages/dashboard/src/database/repositories.ts:395-433`

**Step 1: Fix `get()` to only return open positions**

In `packages/dashboard/src/database/repositories.ts:395-401`:

```typescript
// Before:
async get(marketId: string): Promise<PaperPosition | null> {
  const result = await query<PaperPosition>(
    'SELECT * FROM paper_positions WHERE market_id = $1',
    [marketId]
  );
  return result.rows[0] ?? null;
},

// After:
async get(marketId: string): Promise<PaperPosition | null> {
  const result = await query<PaperPosition>(
    'SELECT * FROM paper_positions WHERE market_id = $1 AND closed_at IS NULL',
    [marketId]
  );
  return result.rows[0] ?? null;
},
```

**Step 2: Check if `close()` is called anywhere**

```bash
grep -rn 'paperPositionsRepo.close' packages/dashboard/src/ --include='*.ts' | grep -v test | grep -v '.d.ts'
```

If no callers outside tests, delete the deprecated `close()` method entirely. If there are callers, they should use `PositionClosingService.close()` instead.

**Step 3: Commit**

```bash
git add packages/dashboard/src/database/repositories.ts
git commit -m "fix: paperPositionsRepo.get() now filters to open positions only

Previously returned closed positions too, which could cause
stale data issues for callers expecting only open positions."
```

---

### Task 11: Add Invariant Checks to daily-review.sh

**Files:**
- Modify: `scripts/daily-review.sh`

**Step 1: Add cash-flow crosscheck section (after line 234)**

Add a new section `invariant_checks` with generalized SQL checks:

```bash
# 13b. Generalized invariant checks (PASS/FAIL)
invariant_checks=$(query_one "
  SELECT row_to_json(t) FROM (
    SELECT
      -- Cash flow crosscheck: account PnL vs actual trade flows
      ABS(a.total_realized_pnl - COALESCE(flows.net_cash_plus_fees, 0)) < 1.0 AS pnl_matches_cashflows,
      a.total_realized_pnl::float AS account_pnl,
      COALESCE(flows.net_cash_plus_fees, 0)::float AS cashflow_pnl,
      ABS(a.total_realized_pnl - COALESCE(flows.net_cash_plus_fees, 0))::float AS pnl_gap,

      -- Available capital vs locked
      ABS(a.available_capital - (a.current_capital - COALESCE(pos.open_cost, 0))) < 1.0 AS capital_lock_correct,
      a.available_capital::float AS available,
      a.current_capital::float AS current,
      COALESCE(pos.open_cost, 0)::float AS open_cost,

      -- Fee tracking
      ABS(a.total_fees_paid - COALESCE(fees.actual_fees, 0)) < 1.0 AS fees_match,
      a.total_fees_paid::float AS account_fees,
      COALESCE(fees.actual_fees, 0)::float AS trade_fees
    FROM paper_account a
    LEFT JOIN (
      SELECT SUM(CASE WHEN side = 'sell' THEN amount ELSE -amount END) + SUM(fee) AS net_cash_plus_fees
      FROM paper_trades
    ) flows ON true
    LEFT JOIN (
      SELECT SUM(size * avg_entry_price) AS open_cost
      FROM paper_positions WHERE closed_at IS NULL
    ) pos ON true
    LEFT JOIN (
      SELECT SUM(fee) AS actual_fees FROM paper_trades
    ) fees ON true
    LIMIT 1
  ) t
")
```

**Step 2: Add container restart counts and OOM check**

```bash
# 17b. Container restart counts and OOM events
container_health="[]"
if command -v docker &>/dev/null; then
  restart_json=$(docker inspect --format='{"name":"{{.Name}}","restart_count":{{.RestartCount}},"started_at":"{{.State.StartedAt}}"}' $(docker ps -q) 2>/dev/null | jq -s '.' 2>/dev/null || echo "[]")

  oom_events=$(dmesg 2>/dev/null | grep -ci 'oom\|killed process' || echo "0")

  container_health=$(jq -n \
    --argjson restarts "$restart_json" \
    --argjson oom_count "$oom_events" \
    '{"restarts": $restarts, "oom_kills_in_dmesg": $oom_count}')
fi
```

**Step 3: Add DB security check**

```bash
# 17c. Database security (auth failure count)
db_security="{}"
if command -v docker &>/dev/null; then
  fatal_count=$(docker logs polymarket-timescaledb --since 24h 2>&1 | grep -c "FATAL" 2>/dev/null || echo "0")
  db_security=$(jq -n --argjson fatal_count "$fatal_count" '{"fatal_auth_failures_24h": $fatal_count}')
fi
```

**Step 4: Add disk usage**

```bash
# 17d. Disk usage
disk_usage="{}"
disk_pct=$(df / --output=pcent 2>/dev/null | tail -1 | tr -d ' %' || echo "0")
docker_size=$(du -sm /var/lib/docker/ 2>/dev/null | cut -f1 || echo "0")
disk_usage=$(jq -n --argjson pct "$disk_pct" --argjson docker_mb "$docker_size" \
  '{"root_usage_pct": $pct, "docker_size_mb": $docker_mb}')
```

**Step 5: Add new sections to the final jq assembly**

Add to the `--argjson` list and the output object:
```bash
  --argjson invariant_checks "$invariant_checks" \
  --argjson container_health "$container_health" \
  --argjson db_security "$db_security" \
  --argjson disk_usage "$disk_usage" \
```

And in the JSON body:
```
    invariant_checks: $invariant_checks,
    container_health: $container_health,
    db_security: $db_security,
    disk_usage: $disk_usage,
```

**Step 6: Commit**

```bash
git add scripts/daily-review.sh
git commit -m "feat: add generalized invariant checks to daily review

- Cash-flow crosscheck (PnL vs actual trade flows)
- Available capital vs locked in open positions
- Fee tracking consistency
- Container restart counts + OOM kill detection
- DB security (FATAL auth failure count)
- Disk usage monitoring"
```

---

### Task 12: Update Auto-Review Prompt with Invariant Guidance

**Files:**
- Modify: `scripts/daily-review-prompt.md` (if exists)

**Step 1: Add guidance about new sections**

Add to the prompt instructions:

```markdown
## New Data Sections

### invariant_checks
Contains PASS/FAIL boolean flags for system invariants:
- `pnl_matches_cashflows`: If false, account PnL diverges from actual trade cash flows — indicates phantom PnL
- `capital_lock_correct`: If false, available_capital doesn't match current_capital minus open position costs
- `fees_match`: If false, account fee tracking diverges from actual trade fees

Any `false` value is a **BUG** — investigate immediately and include in report.

### container_health
- `oom_kills_in_dmesg > 0`: Kernel OOM killer has been active — find which container and recommend memory increase
- Any container with `restart_count > 0`: Investigate why

### db_security
- `fatal_auth_failures_24h > 100`: Possible brute force attack on database port — flag as CRITICAL
```

**Step 2: Commit**

```bash
git add scripts/daily-review-prompt.md
git commit -m "feat: update auto-review prompt with invariant check guidance

Teaches the reviewer model how to interpret new invariant_checks,
container_health, and db_security data sections."
```

---

### Task 13: Final Verification

**Step 1: Run full test suite**

```bash
cd packages/dashboard && npx vitest run
```
Expected: All tests pass

**Step 2: Deploy to VM**

```bash
git push origin main
# Wait for CI/CD or manual deploy
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="cd /home/Usuario/polymarket-trader && git pull && docker compose -f docker-compose.gcp.yml pull && docker compose -f docker-compose.gcp.yml up -d --remove-orphans"
```

**Step 3: Verify account reset is correct**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c 'SELECT current_capital, available_capital, total_realized_pnl, total_fees_paid FROM paper_account LIMIT 1;'"
```

**Step 4: Verify trading works with new code**

Watch logs for ~5 minutes:
```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker logs -f --tail=50 polymarket-dashboard-api 2>&1 | head -100"
```

Look for: signal generation, trade execution, no errors about `upsert` or position creation.

**Step 5: Create GitHub issue for Phase B (future)**

Create an issue for closing port 5432 entirely and moving Optuna inside the VM. Also for the weekly deep code review workflow.
