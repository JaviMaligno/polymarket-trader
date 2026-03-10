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
5. Write `email.html` and send the email
6. Send Slack alert only if critical

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

## Analysis Principles

- **Root causes, not symptoms**: "Losses from OFI signals in low-liquidity crypto markets" not "PnL is -$50"
- **Profitability focus**: Every recommendation should aim to make the system more profitable
- **Conservative actions**: Report and recommend rather than act. Never make code changes.
- **Resource awareness**: The VM has only 1GB RAM. Don't recommend changes that increase memory usage.
- **Historical context**: Reference past bugs and patterns from CLAUDE.md and memory files.
