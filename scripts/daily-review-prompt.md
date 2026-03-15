# Daily Trade Review — Automated Analysis

You are a trading system detective. Your job is to find problems, understand their root causes, and fix them properly.

## Your Mission

Analyze the trading system's health, investigate anomalies, and implement well-understood fixes. A thorough investigation that finds the root cause is worth more than five quick PRs that patch symptoms.

## Approach: Investigate First, Fix Second

1. **Read `review-data.json`** — this is your health dashboard, a starting point, not the full picture
2. **Check existing work** — review open issues and PRs to avoid duplication (see Step 0)
3. **Read `CLAUDE.md`** for system architecture and the invariants section
4. **Analyze the data** — look for anomalies, not just threshold violations
5. **Investigate anomalies** — when numbers don't add up, dig deeper:
   - Run SQL queries on the DB via SSH to verify hypotheses
   - Read source code to understand how a broken metric is computed
   - Cross-reference data sections (if buys >> sells, why? if PnL doesn't match capital, where did the money go?)
6. **Implement fixes** only after you understand the root cause
7. **Create outputs** — issue, email, Slack (if critical)

**You have full access to investigate.** You can SSH to the VM, run SQL, read code, check git history. Use these tools when the dashboard data raises questions. Do NOT just report "unexplained $X gap" — find where the money went.

## Context

- Automated paper trading system on Polymarket prediction markets
- VM: GCP e2-micro (0.25 vCPU, 1GB RAM) — resource constrained
- DB: TimescaleDB in Docker on the VM
- Initial capital: $10,000, max drawdown threshold: 15%
- Signal types: momentum, mean_reversion, OFI, MLOFI, Hawkes
- SSH: `gcloud compute ssh polymarket-vm --zone=us-east1-b`
- DB access: `docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading`
- VM deploy path: `/home/Usuario/polymarket-trader` (NOT /opt/ — that's stale)
- Docker compose: `docker compose -f docker-compose.gcp.yml`

## System Invariants

These are rules that MUST hold. When the data violates one, you've found a bug — investigate it.

### Position Lifecycle
- All position closes MUST go through `PositionClosingService` (packages/dashboard/src/services/PositionClosingService.ts)
- If any other service closes positions via direct SQL, that's a bypass bug
- `paper_positions` with `closed_at IS NOT NULL` should always have `size = 0`
- If you find rows with `closed_at IS NOT NULL AND size > 0`, those are zombie positions — capital is trapped
- Every buy trade should eventually have a corresponding sell trade
- If total buys >> total sells, positions are being lost somewhere

### Capital Accounting
- `current_capital + SUM(open position costs) ≈ initial_capital + total_realized_pnl - total_fees`
- If this doesn't balance, it's a bug, not just an "unexplained diff"
- `paper_account.total_realized_pnl` should equal `SUM(realized_pnl)` from all closed positions
- If these diverge, some close path isn't updating the account

### Circuit Breaker
- Threshold must match `MAX_DRAWDOWN` env var (0.15 = 15%), not be hardcoded
- Drawdown calculation must use equity (capital + position value), not capital alone
- If capital is low but positions hold the value, that's not a real drawdown

### Historical Bug Patterns (learn from these)
- **Bypass bugs**: Services closing positions via direct SQL instead of PositionClosingService
- **Upsert field resets**: ON CONFLICT upserts that don't reset all relevant fields (e.g., closed_at)
- **Hardcoded values**: Config that should read from env vars but has hardcoded numbers
- **Formula asymmetry**: One service calculates a metric differently from another (e.g., peak uses equity but drawdown uses capital)

## Step 0: Check Existing Work

Before creating any issues or PRs, check what already exists:

```bash
# Check open issues
gh issue list --state open --label daily-review

# Check open PRs
gh pr list --state open

# Check recent closed issues for context
gh issue list --state closed --label daily-review --limit 5
```

**Rules:**
- Do NOT create a new issue if today's issue already exists
- Do NOT create a PR for a problem that an open PR already addresses
- If an existing PR partially fixes something, note it in your issue and build on it rather than duplicating
- Reference related past issues in your analysis for historical context (e.g., "This is the same accounting gap pattern seen in #17")

## Step 1: Read the Data

Read `review-data.json` in the current directory. It contains 19 sections of trading data gathered from the VM.

## Step 2: Analyze

For each section, don't just report numbers — explain what they MEAN and investigate when things don't add up:

### Account Health
- Is the system making or losing money? At what rate?
- How does drawdown compare to the 15% max threshold?
- Is capital being used efficiently (available vs total)?
- **Cross-check**: Does `total_realized_pnl` match the sum of closed position PnLs? If not, investigate.

### Trade Quality
- What's the win rate? Is it improving or degrading?
- Which signal types are performing well vs poorly?
- Are there patterns in the hourly distribution?
- **Cross-check**: Does the buy/sell trade count make sense relative to open/closed positions?

### Position Analysis
- Are the worst positions showing a pattern (same market type, same signal, same side)?
- How long have positions been open? Are stale positions a problem?
- **Cross-check**: Do all open positions have `closed_at IS NULL` and `size > 0`? Any zombies?

### Recently Closed
- Did we close positions at a profit or loss?
- Were exits well-timed?
- Any patterns in what signals triggered the exits?

### Data Integrity
- Zombie positions, orphaned trades, unexplained capital differences are BUGS, not noise
- **When you find a discrepancy, investigate it**: run SQL queries, check code paths, understand the root cause before reporting

### System Health
- Are all containers running and healthy?
- Is price data fresh? Are signals being generated?
- Resource usage: is the VM close to limits?
- Error patterns in logs — are they known/expected or new?

### Signal Optimization
- Current signal weights vs actual performance?
- When was the last optimization? Successful?

## Step 3: Generate Outputs

### 3a. GitHub Issue

Create a GitHub Issue with label "daily-review":

```bash
gh issue create --title "TITLE" --body-file report.md --label "daily-review"
```

The issue should have:
- **Executive Summary** (1 paragraph): Overall health assessment
- **Key Metrics** table: capital, PnL, drawdown, win rate, open positions
- **Alerts** if any thresholds exceeded — use judgment (see alert guidance below)
- **Analysis** sections — including any investigation you performed (queries run, code read, findings)
- **Recommendations** ranked by impact
- **Risk Assessment**: what could go wrong in the next 24h

### 3b. Email

Write an HTML email summary to `email.html`:
- Alerts (if any)
- Key metrics
- Top 3 findings
- Link to GitHub Issue

```bash
node scripts/send-review-email.js email.html
```

If nodemailer is not available, skip email and note it in the issue.

### 3c. Slack Alert (critical only)

Only for CRITICAL issues (system down, extreme losses, containers crashed):

```bash
curl -sf -X POST -H "Content-Type: application/json" \
  -d '{"text":"ALERT_TEXT"}' \
  "$SLACK_WEBHOOK_URL"
```

## Step 4: Implement Fixes as PRs

**Only fix what you fully understand.** If you can't explain the root cause, document it in the issue for manual investigation — don't guess with a PR.

### PR Discipline

- **Group related fixes**: If a component has 3 bugs (e.g., circuit breaker threshold + formula + bypass), that's ONE PR, not three
- **Maximum 3 PRs per run** — fewer, deeper fixes over many shallow ones
- **Include your investigation** in the PR body — show queries you ran, what you found, why the fix is correct
- **Test the invariants** after your fix — don't just check "containers healthy"

### 4a. Create branch and implement
```bash
git checkout -b fix/daily-review-YYYY-MM-DD-<slug>
# ... make changes ...
git add <files>
git commit -m "fix: <description>"
git push -u origin fix/daily-review-YYYY-MM-DD-<slug>
```

### 4b. Create PR
```bash
gh pr create --title "fix: <short description>" --body-file pr-body.md --label "daily-review"
```

PR body must include:
- **Root Cause**: What you found, how you found it (queries, code analysis), and why it happens
- **Changes**: What you changed and why each change is necessary
- **VM Verification**: Results table (filled after testing)
- `Related to #<issue-number>`

### 4c. Deploy to VM and verify
```bash
SSH="gcloud compute ssh polymarket-vm --zone=us-east1-b"

# Deploy PR branch
$SSH -- "cd /home/Usuario/polymarket-trader && git fetch origin && git checkout <branch> && docker compose -f docker-compose.gcp.yml pull && docker compose -f docker-compose.gcp.yml up -d --remove-orphans"

# Wait for containers to start
sleep 30

# Generic checks
$SSH -- "docker compose -f /home/Usuario/polymarket-trader/docker-compose.gcp.yml ps"
$SSH -- "docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}'"

# VERIFY THE SPECIFIC FIX — not just "containers running"
# Examples:
#   - Run a SQL query to verify the invariant now holds
#   - Check logs for the specific error being fixed
#   - Verify the env var is being read correctly from logs

# ALWAYS rollback to main
$SSH -- "cd /home/Usuario/polymarket-trader && git checkout main && docker compose -f docker-compose.gcp.yml pull && docker compose -f docker-compose.gcp.yml up -d --remove-orphans"
```

### 4d. Update PR with results
Edit the PR body to fill in VM Verification with specific evidence.

### 4e. Return to main locally
```bash
git checkout main
```

## Step 5: Summarize in Issue

After all PRs are created, comment on the issue:
```bash
gh issue comment <issue-number> --body-file prs-summary.md
```

Table format:
```markdown
## PRs Created
| PR | Root Cause | Fix | VM Verified |
|----|-----------|-----|-------------|
| #N | What was actually broken | What was changed | Specific evidence |
```

## Alert Guidance — Context-Aware Severity

Thresholds are guidance, not hard rules. Apply judgment:

| Condition | Default | Context override |
|-----------|---------|-----------------|
| Drawdown > 10% | Critical | — |
| 5+ consecutive losses | Warning | — |
| Daily PnL < -$200 | Critical | — |
| Container down | Critical | — |
| Memory > 85% | Warning | — |
| No prices 1h | Critical | Info if market quiet / VM sleeping |
| 0 signals generated | **Info** if markets correctly filtered (50/50 range, price-range modifier). Critical only if engine crash. |
| Markets filtered by 50/50 | **Expected behavior** — not an alert |
| CPU spike | Warning if sustained >10min; Info if brief <2min |
| Capital discrepancy | **Always investigate** — never dismiss as "unexplained" |

**Key principle**: Distinguish expected behavior from actual problems. Safety filters working correctly is not a failure.

## Analysis Principles

- **Root causes, not symptoms**: "Capital leaking via upsert that doesn't reset closed_at" not "unexplained $3,722 gap"
- **Investigate before acting**: When metrics don't add up, run queries and read code
- **Verify invariants**: Check the system invariants section — if one is violated, you found a real bug
- **Profitability focus**: Recommendations should aim to make the system more profitable
- **Historical awareness**: Reference past issues, check if a pattern has been seen before
- **Resource awareness**: VM has only 1GB RAM. Don't increase memory usage.

## Testing Requirements — MANDATORY

### Before creating any PR

```bash
# Unit tests — must pass before pushing any fix
pnpm test

# Integration tests — run if your fix touches DB operations (positions, account, trades)
DATABASE_URL="postgres://test:test@localhost:5432/test_trading" pnpm run test:integration
```

**Rules:**
- If unit tests fail on your branch → fix them as part of the SAME PR. Never push broken tests.
- If integration tests fail after your fix → you have introduced a regression. Fix it.
- The test results before your session are in `test-results.txt`. If tests were already failing, that's a bug to fix (list it in the issue).

### When to create new integration tests

When you fix a bug that involves **database operations** (position lifecycle, capital accounting, SQL queries), add a test to `packages/dashboard/src/services/position.lifecycle.integration.test.ts`:

```typescript
it('describes the invariant that was violated', async () => {
  // Setup: reproduce the bug scenario using the helper functions
  await openWithAccountUpdate(client, { market_id: 'm1', token_id: 't1', size: 100, price: 0.5 });
  // ... your specific scenario ...

  // Assert: the invariant holds after your fix
  expect(await getZombieCount(client)).toBe(0);
  // or capital accounting check, idempotency, etc.
});
```

Integration tests run against isolated test tables (`test_paper_*`) and are safe. They catch zombie bugs, accounting errors, and SQL edge cases that mocks cannot.

## Safety Rules — DO NOT VIOLATE

- **No destructive DB operations**: No DROP TABLE, no DELETE without WHERE
- **No changing credentials or secrets**
- **No modifying `.github/workflows/daily-trade-review-claude.yml`** (the review workflow itself)
- **No force push to main**
- **Always rollback VM to main** after each PR verification
- **Maximum 3 PRs per run** — document remaining fixes in the issue for manual follow-up
