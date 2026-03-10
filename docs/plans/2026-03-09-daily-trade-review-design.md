# Daily Trade Review Automation

## Goal

Automated daily review of the trading system's health, performance, and integrity. Replaces manual "check how trades are going" requests.

## Channels

| Channel | When | Content |
|---------|------|---------|
| GitHub Issue | Daily 8:00 UTC | Full report with all sections |
| Gmail | Daily 8:00 UTC | Summary email with key metrics and any alerts |
| Slack | Only on critical alerts | Short alert message requiring manual action |

## Critical Alert Thresholds

- Drawdown > 10% of capital
- 5+ consecutive losing trades
- System down (container not running or no prices in >1 hour)
- Zombie positions detected (size=0, not closed)
- Daily PnL < -$200
- Optimization job failed on Render

## Phase 1: GitHub Actions + Scripts

### Workflow

File: `.github/workflows/daily-trade-review.yml`

```yaml
schedule: cron '0 8 * * *'
runner: ubuntu-latest
```

### Connection

SSH tunnel to polymarket-vm (34.148.24.147). Scripts execute directly on the VM inside the TimescaleDB container or via Node.js on the host.

### Secrets Required

| Secret | Purpose |
|--------|---------|
| `GCP_SSH_PRIVATE_KEY` | SSH access to polymarket-vm |
| `GCP_VM_HOST` | VM IP (34.148.24.147) |
| `SLACK_WEBHOOK_URL` | Slack alerts for critical issues |
| `RENDER_API_KEY` | Query optimization job status |
| `GMAIL_APP_PASSWORD` | Send summary email (or use GitHub Action for email) |
| `GMAIL_TO_ADDRESS` | Recipient email |

### Report Sections

1. **Account Status**
   - Current capital, available capital
   - PnL: realized, unrealized, total
   - Drawdown from peak
   - Source: `check-status.js` queries

2. **Trades (24h)**
   - Count, volume, win/loss ratio
   - Breakdown by signal type (momentum, mean_reversion, OFI, MLOFI, Hawkes)
   - Hourly distribution
   - Source: `check-trades.js` queries

3. **Loss Diagnosis**
   - Largest losing trades
   - Common patterns in losses (market type, signal type, holding time)
   - Source: `diagnose-losses.js` queries

4. **Data Integrity**
   - Zombie positions (size=0, not closed)
   - Buy trades without corresponding position
   - Account balance consistency (capital = initial + realized_pnl - fees)
   - Source: `check-integrity.js` queries

5. **System Health**
   - Container status (docker ps)
   - Price collection freshness (last price_history entry)
   - Signal generation (last signal timestamp)
   - Error logs (last 50 lines filtered for ERROR/WARN)

6. **Render Optimizations**
   - Last optimization job: status, timestamp, result
   - Current signal weights
   - Next scheduled run

### Script Architecture

A single consolidated script `scripts/daily-review.js` that:
- Runs all queries in parallel
- Detects alert conditions
- Outputs structured JSON

A formatting script `scripts/format-review.js` that:
- Takes the JSON output
- Generates GitHub-flavored markdown for the issue
- Generates a shorter email-friendly summary
- Generates a Slack alert payload (only if critical alerts exist)

### Workflow Steps

```
1. SSH to VM
2. Copy and run daily-review.js against TimescaleDB
3. SSH to VM: docker ps, docker logs (last 50 lines each container)
4. Query Render API for optimization status
5. Aggregate all data
6. Run format-review.js locally in the runner
7. Create GitHub Issue (gh issue create)
8. Send email via Gmail action
9. IF critical alerts → Send Slack webhook
```

## Phase 2: Claude Code as Analyst

### Workflow

File: `.github/workflows/daily-trade-review-claude.yml` (replaces Phase 1 workflow)

Same schedule: `cron '0 8 * * *'`

### Architecture Change

Phase 1 scripts become **data gathering tools** that Claude Code uses. Instead of formatting output mechanically, Claude:

1. Gathers data (same scripts/queries as Phase 1)
2. Interprets results with project context (CLAUDE.md, memory, past issues)
3. Generates qualitative analysis explaining WHY things are happening
4. Proposes concrete actions with reasoning
5. (Future) Executes fixes via PRs

### Setup

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

Claude Code runs in Docker with:
- Full repo access (skills, CLAUDE.md, memory)
- SSH access to VM (via secret)
- Render API key
- GitHub token for creating issues/PRs
- Slack webhook for critical alerts
- Gmail credentials for email

### Prompt / Skill

File: `scripts/daily-review-prompt.md`

The prompt instructs Claude to:

1. **Gather**: Run queries via SSH, check containers, query Render
2. **Analyze**: Interpret all data holistically
   - Not just "PnL is -$50" but "losses come from X pattern"
   - Compare with historical trends (previous reports)
   - Identify root causes, not symptoms
3. **Report**: Create GitHub Issue + email with:
   - Executive summary (1 paragraph)
   - Detailed sections with analysis
   - Risk assessment (what could go wrong next)
   - Recommended actions ranked by impact
4. **Alert**: Slack only for critical issues requiring human action
5. **Act** (future): For well-understood issues:
   - Create a branch with the fix
   - Open a PR with detailed explanation
   - Never merge automatically — always wait for human review

### Analysis Principles (encoded in prompt)

- **Investigate root causes** — don't patch symptoms
- **Consider profitability impact** — every suggestion should aim to improve the system's ability to make money
- **Document reasoning** — explain why a change is recommended
- **Separate fixes by scope** — config changes vs code changes vs architectural changes
- **Be conservative** — when unsure, report and recommend rather than act
- **Learn from history** — reference past bugs and fixes from memory

## Implementation Order

### Step 1: Consolidated Review Script
- Create `scripts/daily-review.js` — runs all diagnostic queries, outputs JSON
- Create `scripts/format-review.js` — formats JSON into markdown/email/slack
- Test locally against the VM

### Step 2: GitHub Actions Workflow (Phase 1)
- Create `.github/workflows/daily-trade-review.yml`
- Set up SSH connection to VM
- Set up GitHub Issue creation
- Set up Gmail sending
- Set up Slack webhook (critical only)
- Set up Render API check
- Test with manual trigger (`workflow_dispatch`)

### Step 3: Migrate to Claude Code (Phase 2)
- Create `scripts/daily-review-prompt.md`
- Replace mechanical formatting with Claude Code analysis
- Add OAuth token secret
- Test with manual trigger
- Keep Phase 1 workflow as fallback

### Step 4: Evolve to Corrective Actions (Phase C)
- Grant Claude Code ability to create branches/PRs
- Define safe actions (config changes) vs unsafe (code changes)
- Add approval gates for significant changes
- Build feedback loop: track if recommended changes improved performance
