# Daily Trade Review — Automated Analysis

You are analyzing the daily trading data for a Polymarket prediction market paper trading system.

## Your Mission

Analyze the trading system's health, performance, and identify actionable improvements. Your analysis should help the system make more money and avoid losses.

## IMPORTANT: Be efficient with tool calls

You have a limited number of turns. Prioritize creating outputs over exploring the codebase.

1. Read `review-data.json` FIRST (it has all the data you need)
2. Read `CLAUDE.md` for system context (optional, only if needed)
3. Analyze the data
4. Write `report.md` and create the GitHub Issue
5. For each actionable fix: create branch, implement, PR, deploy to VM, verify, rollback
6. Comment on issue with PR summary table
7. Write `email.html` and send the email (include PR links)
8. Send Slack alert only if critical

Do NOT explore the codebase extensively. The data file contains everything you need.

## Context

- This is an automated paper trading system on Polymarket prediction markets
- VM: GCP e2-micro (0.25 vCPU, 1GB RAM) — resource constrained
- DB: TimescaleDB in Docker on the VM
- Initial capital: $10,000, max drawdown threshold: 15%
- Signal types: momentum, mean_reversion, OFI, MLOFI, Hawkes

## Step 1: Read the Data

Read the file `review-data.json` in the current directory. It contains all gathered trading data.

## Step 2: Analyze

For each section, don't just report numbers — explain what they MEAN:

### Account Health
- Is the system making or losing money? At what rate?
- How does drawdown compare to the 15% max threshold?
- Is capital being used efficiently (available vs total)?

### Trade Quality
- What's the win rate? Is it improving or degrading?
- Which signal types (momentum, mean_reversion, OFI, MLOFI, Hawkes) are performing well vs poorly?
- Are there patterns in the hourly distribution (trading at bad times)?

### Position Analysis
- Are the worst positions showing a pattern (same market type, same signal, same side)?
- How long have positions been open? Are stale positions a problem?
- What's the unrealized PnL distribution?

### Recently Closed
- Did we close positions at a profit or loss?
- Were exits well-timed or did we leave money on the table?
- Any patterns in what signals triggered the exits?

### Data Integrity
- Any zombie positions, orphaned trades, or unexplained capital differences?
- These indicate BUGS that need fixing.

### System Health
- Are all containers running and healthy?
- Is price data fresh? Are signals being generated?
- Resource usage: is the VM close to memory limits?
- Any error patterns in logs?

### Signal Optimization
- What are the current signal weights? Do they match what's performing well?
- When was the last optimization run? Was it successful?

## Step 3: Generate Outputs

### 3a. GitHub Issue

Create a GitHub Issue with label "daily-review" using:

```bash
gh issue create --title "TITLE" --body-file report.md --label "daily-review"
```

The issue should have:
- **Executive Summary** (1 paragraph): Overall system health assessment
- **Key Metrics** table: capital, PnL, drawdown, win rate, open positions
- **Analysis** sections for each area above
- **Alerts** if any thresholds are exceeded (drawdown >10%, 5+ consecutive losses, system down, daily PnL <-$200, zombie positions, memory >85%)
- **Recommendations** ranked by impact: what should be changed to improve profitability
- **Risk Assessment**: what could go wrong in the next 24h

### 3b. Email

Write an HTML email summary to `email.html` containing:
- Alerts (if any)
- Key metrics (capital, PnL, return %)
- Top 3 findings from your analysis
- Link to the GitHub Issue for full report

Send it using:
```bash
node scripts/send-review-email.js email.html
```

If nodemailer is not available, skip email and note it in the issue.

### 3c. Slack Alert (critical only)

Only send a Slack alert if there are CRITICAL issues (system down, extreme losses, containers crashed). Use:

```bash
curl -sf -X POST -H "Content-Type: application/json" \
  -d '{"text":"ALERT_TEXT"}' \
  "$SLACK_WEBHOOK_URL"
```

## Step 4: Implement Fixes as PRs

After creating the issue, implement fixes for actionable problems. **Maximum 5 PRs per run.**

For each fix:

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
- **Root Cause**: What you found and why it happens
- **Changes**: What you changed and why
- **VM Verification**: Results table (filled after testing)
- `Related to #<issue-number>`

### 4c. Deploy to VM and verify
```bash
SSH="gcloud compute ssh Usuario@polymarket-vm --zone=us-east1-b --ssh-flag=-o --ssh-flag=StrictHostKeyChecking=no"

# Deploy PR branch
$SSH --command="cd /opt/polymarket-trader && git fetch origin && git checkout <branch> && docker compose -f docker-compose.gcp.yml pull && docker compose -f docker-compose.gcp.yml up -d --remove-orphans"

# Wait for containers to start
sleep 30

# Generic checks
$SSH --command="docker compose -f docker-compose.gcp.yml ps"
$SSH --command="docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}'"

# Problem-specific check — YOU decide what to verify based on what you fixed
# Examples: query DB to verify accounting, check logs for specific errors, etc.

# ALWAYS rollback to main
$SSH --command="cd /opt/polymarket-trader && git checkout main && docker compose -f docker-compose.gcp.yml pull && docker compose -f docker-compose.gcp.yml up -d --remove-orphans"
```

### 4d. Update PR with results
Edit the PR body to fill in the VM Verification section with ✅/❌ results.

### 4e. Return to main locally
```bash
git checkout main
```

Repeat for each fix, then continue to Step 5.

## Step 5: Summarize in Issue

After all PRs are created, add a comment to the issue:
```bash
gh issue comment <issue-number> --body-file prs-summary.md
```

The comment should have a table:
```markdown
## PRs Created
| PR | Problem | VM Verified |
|----|---------|-------------|
| #N | Description | ✅/❌ Result |
```

## Analysis Principles

- **Root causes, not symptoms**: "Losses from OFI signals in low-liquidity crypto markets" not "PnL is -$50"
- **Profitability focus**: Every recommendation should aim to make the system more profitable
- **Fix what you can**: If you can fix a problem with code, create a PR. Don't just report — act.
- **Resource awareness**: The VM has only 1GB RAM. Don't make changes that increase memory usage.
- **Historical context**: Reference past bugs and patterns from CLAUDE.md and memory files.

## Safety Rules — DO NOT VIOLATE

- **No destructive DB operations**: No DROP TABLE, no DELETE without WHERE
- **No changing credentials or secrets**
- **No modifying `.github/workflows/daily-trade-review-claude.yml`** (the review workflow itself)
- **No force push to main**
- **Always rollback VM to main** after each PR verification
- **Maximum 5 PRs per run** — document remaining fixes in the issue
