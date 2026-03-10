# Daily Trade Review Phase 2 — Claude Code Analyst

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace mechanical formatting (format-review.js) with Claude Code CLI running as an intelligent analyst that interprets trading data, identifies patterns, and provides actionable recommendations.

**Architecture:** A new GitHub Actions workflow installs Claude Code CLI, SSHs to the VM to gather data (reusing daily-review.sh), then passes the JSON + a detailed prompt to Claude Code. Claude analyzes the data with full project context (CLAUDE.md, memory) and generates a GitHub Issue, email, and Slack alert. Phase 1 workflow remains as fallback.

**Tech Stack:** Claude Code CLI (`@anthropic-ai/claude-code`), GitHub Actions, Sonnet 4.6, GCP WIF SSH, Node.js (for email sending)

---

### Task 1: Create the analysis prompt

**Files:**
- Create: `scripts/daily-review-prompt.md`

**Step 1: Write the prompt file**

This is the instruction Claude Code receives. It must be comprehensive — Claude has zero context beyond what we give it and the repo files.

```markdown
# Daily Trade Review — Automated Analysis

You are analyzing the daily trading data for a Polymarket prediction market paper trading system.

## Your Mission

Analyze the trading system's health, performance, and identify actionable improvements. Your analysis should help the system make more money and avoid losses.

## Context

- This is an automated paper trading system on Polymarket prediction markets
- VM: GCP e2-micro (0.25 vCPU, 1GB RAM) — resource constrained
- DB: TimescaleDB in Docker on the VM
- Read CLAUDE.md and the memory files for full system context

## Step 1: Gather Data

The data has already been gathered. Read the file `review-data.json` in the current directory.

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
node -e "
const nodemailer = require('nodemailer');
const fs = require('fs');
const t = nodemailer.createTransport({host:'smtp.gmail.com',port:587,auth:{user:process.env.GMAIL_USERNAME,pass:process.env.GMAIL_APP_PASSWORD}});
t.sendMail({from:process.env.GMAIL_USERNAME,to:process.env.GMAIL_TO_ADDRESS,subject:'Polymarket Daily Review — ' + new Date().toISOString().slice(0,10),html:fs.readFileSync('email.html','utf8')}).then(()=>console.log('sent')).catch(e=>console.error(e));
"
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
```

**Step 2: Commit**

```bash
git add scripts/daily-review-prompt.md
git commit -m "feat: add Claude Code analysis prompt for Phase 2 daily review"
```

---

### Task 2: Create the email helper script

**Files:**
- Create: `scripts/send-review-email.js`

**Step 1: Write the email sender**

A simple Node.js script that Claude Code can call to send email. Uses nodemailer (will be installed in the workflow).

```javascript
#!/usr/bin/env node
// Usage: GMAIL_USERNAME=x GMAIL_APP_PASSWORD=x GMAIL_TO_ADDRESS=x node scripts/send-review-email.js <email.html> [subject]
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const htmlFile = process.argv[2] || 'email.html';
const subject = process.argv[3] || `Polymarket Daily Review — ${new Date().toISOString().slice(0, 10)}`;

if (!fs.existsSync(htmlFile)) {
  console.error(`File not found: ${htmlFile}`);
  process.exit(1);
}

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.GMAIL_USERNAME,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

transporter.sendMail({
  from: process.env.GMAIL_USERNAME,
  to: process.env.GMAIL_TO_ADDRESS,
  subject,
  html: fs.readFileSync(htmlFile, 'utf8'),
}).then(() => {
  console.log('Email sent successfully');
}).catch((err) => {
  console.error('Failed to send email:', err.message);
  process.exit(1);
});
```

**Step 2: Commit**

```bash
git add scripts/send-review-email.js
git commit -m "feat: add email sending helper for Claude Code daily review"
```

---

### Task 3: Create the Phase 2 GitHub Actions workflow

**Files:**
- Create: `.github/workflows/daily-trade-review-claude.yml`

**Step 1: Write the workflow**

```yaml
name: Daily Trade Review (Claude Analysis)

on:
  schedule:
    - cron: '0 8 * * *'   # 8:00 UTC daily
  workflow_dispatch:        # Manual trigger for testing

concurrency:
  group: daily-review
  cancel-in-progress: true

permissions:
  contents: read
  id-token: write
  issues: write

jobs:
  daily-review-claude:
    runs-on: ubuntu-latest
    timeout-minutes: 15

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install dependencies
        run: npm install -g @anthropic-ai/claude-code nodemailer

      - name: Authenticate to Google Cloud
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: 'projects/992492426638/locations/global/workloadIdentityPools/github-pool/providers/github-provider'
          service_account: 'github-deploy@project-94e9f6f2-aba7-4cb6-afc.iam.gserviceaccount.com'

      - name: Setup Cloud SDK
        uses: google-github-actions/setup-gcloud@v2

      - name: Gather data from VM
        id: gather
        run: |
          SSH="gcloud compute ssh Usuario@polymarket-vm --zone=us-east1-b --ssh-flag=-o --ssh-flag=ServerAliveInterval=30 --ssh-flag=-o --ssh-flag=StrictHostKeyChecking=no --ssh-flag=-o --ssh-flag=ConnectTimeout=30"

          # Run script on VM, save to temp file
          $SSH --command="cd /home/Usuario/polymarket-trader && git pull --quiet origin main >/dev/null 2>&1; bash scripts/daily-review.sh > /tmp/daily-review-output.json 2>/tmp/daily-review-stderr.log" \
            2>ssh-stderr.log || true

          # Retrieve JSON
          $SSH --command="cat /tmp/daily-review-output.json" \
            > review-data.json 2>>ssh-stderr.log || true

          if ! jq . review-data.json > /dev/null 2>&1; then
            echo "::error::Invalid JSON from daily-review.sh"
            cat ssh-stderr.log 2>/dev/null || true
            exit 1
          fi
          echo "data_collected=true" >> $GITHUB_OUTPUT

      - name: Run Claude Code Analysis
        if: steps.gather.outputs.data_collected == 'true'
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GH_TOKEN: ${{ github.token }}
          GMAIL_USERNAME: ${{ secrets.GMAIL_USERNAME }}
          GMAIL_APP_PASSWORD: ${{ secrets.GMAIL_APP_PASSWORD }}
          GMAIL_TO_ADDRESS: ${{ secrets.GMAIL_TO_ADDRESS }}
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
          RENDER_API_KEY: ${{ secrets.RENDER_API_KEY }}
        run: |
          claude --model claude-sonnet-4-6 \
            --print \
            --max-turns 25 \
            --allowedTools "Bash(readonly=false),Read,Write,Glob,Grep,Edit" \
            "$(cat scripts/daily-review-prompt.md)

          The data file is at: $(pwd)/review-data.json
          The repo is checked out at: $(pwd)
          You have access to gh CLI (authenticated), gcloud CLI, and node.

          IMPORTANT: Create the GitHub Issue, send the email (using node scripts/send-review-email.js), and send Slack alert if needed.
          When done, output a single line: REVIEW_COMPLETE"
```

**Step 2: Commit**

```bash
git add .github/workflows/daily-trade-review-claude.yml
git commit -m "feat: add Phase 2 daily review workflow with Claude Code analysis"
```

---

### Task 4: Disable Phase 1 workflow and configure secrets

**Files:**
- Modify: `.github/workflows/daily-trade-review.yml` (rename cron to avoid double execution)

**Step 1: Comment out the schedule in Phase 1 (keep for manual fallback)**

Change the Phase 1 workflow schedule so it doesn't run automatically, but can still be triggered manually:

In `.github/workflows/daily-trade-review.yml`, change:
```yaml
on:
  schedule:
    - cron: '0 8 * * *'
  workflow_dispatch:
```
To:
```yaml
on:
  # schedule:
  #   - cron: '0 8 * * *'   # Disabled: replaced by Phase 2 (Claude Analysis)
  workflow_dispatch:          # Keep for manual fallback
```

**Step 2: Set the Anthropic API key secret**

```bash
gh secret set ANTHROPIC_API_KEY -R JaviMaligno/polymarket-trader
# Paste the key from local .env file
```

**Step 3: Commit and push**

```bash
git add .github/workflows/daily-trade-review.yml
git commit -m "feat: disable Phase 1 cron, keep as manual fallback"
git push origin main
```

---

### Task 5: Test with manual trigger

**Step 1: Trigger the Phase 2 workflow**

```bash
gh workflow run "Daily Trade Review (Claude Analysis)" -R JaviMaligno/polymarket-trader
```

**Step 2: Watch the run**

```bash
gh run watch
```

**Step 3: Verify outputs**

- Check GitHub Issues for new analysis issue (should have qualitative analysis, not just metrics)
- Check email inbox
- Check Slack (only if critical alerts)

**Step 4: Compare with Phase 1**

Trigger Phase 1 manually for comparison:
```bash
gh workflow run "Daily Trade Review" -R JaviMaligno/polymarket-trader
```

Compare the two issues — Phase 2 should have:
- Executive summary paragraph (not just tables)
- Explanations of WHY patterns exist
- Recommendations ranked by impact
- Risk assessment

---

### Task 6: Iterate on the prompt

After the first test run, review the Claude Code output and refine the prompt based on:
- Is the analysis too shallow or too verbose?
- Are recommendations actionable?
- Is the email format good?
- Did it correctly identify critical alerts?

Adjust `scripts/daily-review-prompt.md` as needed and re-test.

---

## Files Summary

| File | Purpose |
|------|---------|
| `scripts/daily-review-prompt.md` | Analysis instructions for Claude Code |
| `scripts/send-review-email.js` | Email sending helper |
| `.github/workflows/daily-trade-review-claude.yml` | Phase 2 workflow |
| `.github/workflows/daily-trade-review.yml` | Phase 1 (manual fallback) |

## Secrets Required

| Secret | Status |
|--------|--------|
| `ANTHROPIC_API_KEY` | Available in local .env, needs to be added to GitHub |
| `GMAIL_USERNAME` | Already configured |
| `GMAIL_APP_PASSWORD` | Already configured |
| `GMAIL_TO_ADDRESS` | Already configured |
| `SLACK_WEBHOOK_URL` | Already configured |
| `RENDER_API_KEY` | Already configured |
