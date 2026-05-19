# System & Auto-Review Improvements Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix DB timeouts, add cross-review trending to auto-review, and clean up pre-reset noise in invariant checks.

**Architecture:** Four independent improvements — DB keepalive (code), review history tracking (shell script + prompt), fix verification in prompt, and reset-epoch filtering for invariant checks.

**Tech Stack:** TypeScript (pg Pool), Bash (daily-review.sh), Markdown (prompt)

---

### Task 1: DB Connection Pool Keepalive

**Problem:** 20 DB timeouts/day for 2+ days. Pool connections go stale because no keepalive is configured. Idle connections get dropped by Docker/kernel TCP stack, but pg Pool doesn't know until the next query attempt.

**Files:**
- Modify: `packages/dashboard/src/database/index.ts:67-73`
- Modify: `packages/data-collector/src/database/connection.ts:17-26`

**Step 1: Add keepalive to dashboard pool**

In `packages/dashboard/src/database/index.ts`, update Pool config:

```typescript
pool = new Pool({
  connectionString,
  ssl: sslConfig,
  max: config?.max ?? parseInt(process.env.DB_POOL_MAX || '5', 10),
  idleTimeoutMillis: config?.idleTimeoutMillis ?? 30000,
  connectionTimeoutMillis: config?.connectionTimeoutMillis ?? 10000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});
```

**Step 2: Add keepalive to data-collector pool**

In `packages/data-collector/src/database/connection.ts`, update Pool config:

```typescript
pool = new Pool({
  connectionString,
  max: maxConnections,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  ssl: isCloudDb ? { rejectUnauthorized: false } : undefined,
});
```

**Step 3: Run tests**

```bash
pnpm test
```

**Step 4: Commit**

```bash
git add packages/dashboard/src/database/index.ts packages/data-collector/src/database/connection.ts
git commit -m "fix: add TCP keepalive to DB connection pools to prevent stale connections"
```

---

### Task 2: Review History Tracking (Cross-Review Trending)

**Problem:** Each auto-review is a snapshot. It can't detect "timeouts were 20 yesterday AND 20 today" or "tradeable market % dropped from 80% to 40% over 3 days."

**Approach:** At the end of `daily-review.sh`, save key metrics to `/home/Usuario/polymarket-trader/review-history.json` on the VM. Each review run appends an entry. The prompt reads previous entries for trend comparison.

**Files:**
- Modify: `scripts/daily-review.sh` (add history save at end)
- Modify: `scripts/daily-review-prompt.md` (add trending section)

**Step 1: Add history save to daily-review.sh**

At the end of `daily-review.sh` (before the final JSON output), add a section that saves key metrics:

```bash
# Save key metrics to review history for trending
HISTORY_FILE="/home/Usuario/polymarket-trader/review-history.json"
HISTORY_ENTRY=$(cat <<HISTEOF
{
  "date": "$(date -u +%Y-%m-%d)",
  "capital": $(echo "$ACCOUNT" | jq '.current_capital // 0'),
  "realized_pnl": $(echo "$ACCOUNT" | jq '.total_realized_pnl // 0'),
  "drawdown_pct": $(echo "$ACCOUNT" | jq '.max_drawdown // 0'),
  "open_positions": $(echo "$OPEN_POSITIONS" | jq 'length'),
  "trades_24h": $(echo "$TRADES_SUMMARY" | jq '.total_trades // 0'),
  "signals_1h": $(echo "$SIGNAL_FRESHNESS" | jq '.count_1h // 0'),
  "active_markets": $(echo "$MARKET_INTEL" | jq '[.[] | select(.tracking_status == "active")] | .[0].count // 0' 2>/dev/null || echo 0),
  "tradeable_market_pct": $(DB_QUERY "SELECT ROUND(COUNT(*) FILTER (WHERE current_price_yes >= 0.05 AND current_price_yes <= 0.95)::numeric * 100 / NULLIF(COUNT(*), 0), 1) FROM markets WHERE tracking_status = 'active' AND is_active = true" 2>/dev/null || echo 0),
  "db_timeout_errors": $(echo "$ERROR_LOGS" | jq '[.[] | select(.line | test("timeout exceeded"))] | length' 2>/dev/null || echo 0),
  "zombie_count": $(echo "$ZOMBIES" | jq '.count // 0'),
  "invariant_capital_ok": $(echo "$INVARIANT_CHECKS" | jq '.capital_matches_cashflows // false'),
  "invariant_fees_ok": $(echo "$INVARIANT_CHECKS" | jq '.fees_match // false')
}
HISTEOF
)

# Append to history (keep last 30 days)
if [ -f "$HISTORY_FILE" ]; then
  EXISTING=$(cat "$HISTORY_FILE")
  # Remove entries older than 30 days and add new one
  echo "$EXISTING" | jq --argjson new "$HISTORY_ENTRY" \
    '[.[] | select(.date >= (now | strftime("%Y-%m-%d") | . as $today | ($today | strptime("%Y-%m-%d") | mktime) - 2592000 | strftime("%Y-%m-%d")))] + [$new]' \
    > "${HISTORY_FILE}.tmp" && mv "${HISTORY_FILE}.tmp" "$HISTORY_FILE"
else
  echo "[$HISTORY_ENTRY]" > "$HISTORY_FILE"
fi
echo "Saved review history entry" >&2
```

Also, add a new section to the JSON output that reads the last 7 entries of review history:

```bash
# In the final JSON assembly, add:
"review_history": $(cat "$HISTORY_FILE" 2>/dev/null | jq 'sort_by(.date) | .[-7:]' 2>/dev/null || echo "[]"),
```

**Step 2: Add trending section to prompt**

Add to `scripts/daily-review-prompt.md` after the "Market Intelligence System" section:

```markdown
### Cross-Review Trending (mandatory if review_history has 2+ entries)

The `review_history` section contains metrics from previous daily reviews. Compare today vs recent days:

- **Capital trajectory**: Growing, flat, or declining?
- **Tradeable market %**: Is it degrading over time?
- **DB timeout count**: Persistent (same count multiple days) or transient?
- **Signal count trend**: Increasing, decreasing, or volatile?

**If a metric has been bad for 2+ consecutive days**, escalate severity by one level and prefix with `[PERSISTENT]`.

**If a metric improved after a PR was merged**, note: "Fix in PR #N appears effective (metric improved from X to Y)."
```

**Step 3: Commit**

```bash
git add scripts/daily-review.sh scripts/daily-review-prompt.md
git commit -m "feat: add cross-review trending to daily auto-review"
```

---

### Task 3: Fix Verification & Persistent Issue Escalation in Prompt

**Problem:** Auto-review never checks if yesterday's merged PR actually worked, and flags the same P1 issues for days without escalating.

**Files:**
- Modify: `scripts/daily-review-prompt.md`

**Step 1: Add fix verification section to prompt**

Add after "Step 0: Check Existing Work":

```markdown
## Step 0b: Verify Recent Fixes

Check if any PRs were merged since the last review:

```bash
gh pr list --state merged --label daily-review --limit 5 --json number,title,mergedAt
```

For each PR merged in the last 48h:
1. Read its description to understand what it fixed
2. Check if the fix is effective by running the relevant verification (SQL query, log check, etc.)
3. Report in the issue: "PR #N (merged YYYY-MM-DD): [EFFECTIVE|INEFFECTIVE] — evidence: [query result]"

If a fix is **ineffective**, flag as HIGH and investigate why.
```

**Step 2: Add persistent issue escalation rule**

Add to the "Alert Guidance" section:

```markdown
### Persistent Issue Escalation

When `review_history` shows the same problem for 2+ consecutive days:
- **Escalate severity by one level** (Info→Warning, Warning→High, High→Critical)
- **Prefix alert with `[PERSISTENT - N days]`**
- **Require an action**: either create a fix PR or explain why the issue can't be fixed automatically

Never write "recurring known issue" without:
1. Citing the issue number that tracks it
2. Stating how many consecutive days it has persisted
3. Proposing a concrete next step
```

**Step 3: Commit**

```bash
git add scripts/daily-review-prompt.md
git commit -m "feat: add fix verification and persistent issue escalation to auto-review prompt"
```

---

### Task 4: Reset-Epoch Filter for Invariant Checks

**Problem:** `capital_matches_cashflows=false` and `fees_match=false` appear every review because the SQL sums include pre-reset trades against a post-reset account. This is noise that wastes auto-review time.

**Approach:** Store the last reset timestamp in `paper_account` and use it to filter invariant check queries in `daily-review.sh`.

**Files:**
- Modify: `scripts/daily-review.sh` (filter invariant queries by last reset date)

**Step 1: Update invariant check SQL to filter by last reset**

The simplest approach: use the most recent circuit_breaker_log entry or a known reset date. Since we know the last reset was 2026-03-26, and the account reset endpoint doesn't log to circuit_breaker_log, we'll detect the reset time from the earliest post-reset trade.

In `daily-review.sh`, update the invariant checks section:

```bash
# Detect last reset time (earliest trade after last known 0-balance state)
RESET_EPOCH=$(DB_QUERY "
  SELECT COALESCE(
    (SELECT MAX(timestamp) FROM circuit_breaker_log),
    '2026-03-26T00:00:00Z'
  )::text
")

# capital_matches_cashflows — only count post-reset trades
INVARIANT_CHECKS=$(DB_QUERY "
  WITH account AS (SELECT * FROM paper_account WHERE id = 1),
  post_reset_flows AS (
    SELECT
      COALESCE(SUM(CASE WHEN side = 'buy' THEN -(size * price + fee) ELSE (size * price - fee) END), 0) as net_cash_flow,
      COALESCE(SUM(fee), 0) as total_trade_fees
    FROM paper_trades
    WHERE created_at >= '$RESET_EPOCH'
  ),
  ...
")
```

The key change: add `WHERE created_at >= '$RESET_EPOCH'` to the cashflow and fee summation queries.

**Step 2: Test locally**

Run the invariant check SQL manually against the DB to verify it returns `true` for both checks.

**Step 3: Commit**

```bash
git add scripts/daily-review.sh
git commit -m "fix: filter invariant checks by last reset epoch to eliminate pre-reset noise"
```

---

## Execution Order

Tasks are independent and can be parallelized, but the natural order is:

1. **Task 1** (DB keepalive) — quick code change, immediate production impact
2. **Task 4** (reset-epoch) — reduces noise in tomorrow's review
3. **Task 2** (review history) — enables trending in future reviews
4. **Task 3** (prompt improvements) — builds on Task 2's trending data

## Deployment

After all tasks are committed, push and let CI/CD deploy. If CI/CD doesn't trigger, manual deploy:

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b -- \
  "cd /home/Usuario/polymarket-trader && git pull && docker compose -f docker-compose.gcp.yml pull && docker compose -f docker-compose.gcp.yml up -d --remove-orphans"
```
