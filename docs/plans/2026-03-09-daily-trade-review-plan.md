# Daily Trade Review - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Automated daily review of trading system health, performance, and integrity — delivered via GitHub Issue, Gmail, and Slack (critical alerts only).

**Architecture:** A shell script runs on the GCP VM via SSH (using existing WIF auth), executes psql queries via `docker exec`, checks container health, and outputs JSON. A Node.js formatter in the GitHub Actions runner converts JSON to markdown/email/slack payloads. The workflow creates a GitHub Issue, sends email, and optionally pings Slack.

**Tech Stack:** Bash (VM script), Node.js (formatter), GitHub Actions, GCP WIF, psql, Render API, Slack webhooks, Gmail (nodemailer or action)

---

### Task 1: Create the VM data-gathering script

**Files:**
- Create: `scripts/daily-review.sh`

**Step 1: Write the shell script**

This script runs ON the VM. It uses `docker exec` to query TimescaleDB and `docker ps`/`docker logs` for health checks. Outputs a single JSON object to stdout.

```bash
#!/usr/bin/env bash
set -euo pipefail

PSQL="docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -t -A"

# Helper: run a query and return JSON array
query_json() {
  $PSQL -c "SELECT json_agg(t) FROM ($1) t" | sed 's/^$/[]/'
}

# Helper: run a query and return single JSON object
query_one() {
  $PSQL -c "SELECT row_to_json(t) FROM ($1) t" | sed 's/^$/null/'
}

echo "{"

# === ACCOUNT ===
echo '"account":'
query_one "SELECT current_capital, initial_capital, available_capital, total_realized_pnl, total_unrealized_pnl, max_drawdown, total_trades, winning_trades, losing_trades FROM paper_account LIMIT 1"
echo ","

# === TRADES 24H ===
echo '"trades_24h":'
query_json "SELECT time, side, executed_size::float, executed_price::float, value_usd::float, fee::float, signal_type, fill_type, market_id FROM paper_trades WHERE time > NOW() - INTERVAL '24 hours' ORDER BY time DESC"
echo ","

# === TRADES SUMMARY 24H ===
echo '"trades_summary":'
query_one "SELECT COUNT(*) as total_trades, COALESCE(SUM(value_usd),0)::float as total_value, COALESCE(SUM(fee),0)::float as total_fees FROM paper_trades WHERE time > NOW() - INTERVAL '24 hours'"
echo ","

# === SIGNAL DISTRIBUTION 24H ===
echo '"signal_distribution":'
query_json "SELECT signal_type, COUNT(*) as count FROM paper_trades WHERE time > NOW() - INTERVAL '24 hours' GROUP BY signal_type ORDER BY count DESC"
echo ","

# === HOURLY BREAKDOWN 24H ===
echo '"hourly_trades":'
query_json "SELECT date_trunc('hour', time) as hour, COUNT(*) as trades, COALESCE(SUM(value_usd),0)::float as total_value, COALESCE(SUM(fee),0)::float as total_fees FROM paper_trades WHERE time > NOW() - INTERVAL '24 hours' GROUP BY date_trunc('hour', time) ORDER BY hour DESC"
echo ","

# === OPEN POSITIONS ===
echo '"open_positions":'
query_json "SELECT market_id, token_id, side, size::float, avg_entry_price::float, current_price::float, unrealized_pnl::float, unrealized_pnl_pct::float, opened_at FROM paper_positions WHERE size > 0 AND closed_at IS NULL ORDER BY unrealized_pnl ASC"
echo ","

# === WORST POSITIONS (top 10 losers) ===
echo '"worst_positions":'
query_json "SELECT p.market_id, m.question, p.side, p.size::float, p.avg_entry_price::float, p.current_price::float, p.unrealized_pnl::float, p.unrealized_pnl_pct::float, p.opened_at FROM paper_positions p LEFT JOIN markets m ON p.market_id = m.id WHERE p.size > 0 AND p.closed_at IS NULL ORDER BY p.unrealized_pnl ASC LIMIT 10"
echo ","

# === CLOSED POSITIONS (last 24h) ===
echo '"recently_closed":'
query_json "SELECT p.market_id, m.question, p.side, p.realized_pnl::float, p.avg_entry_price::float, p.closed_at FROM paper_positions p LEFT JOIN markets m ON p.market_id = m.id WHERE p.closed_at > NOW() - INTERVAL '24 hours' ORDER BY p.closed_at DESC"
echo ","

# === INTEGRITY: ZOMBIES ===
echo '"zombie_positions":'
query_one "SELECT COUNT(*) as count FROM paper_positions WHERE size = 0 AND closed_at IS NULL"
echo ","

# === INTEGRITY: ORPHANED BUYS ===
echo '"orphaned_buys":'
query_one "SELECT COUNT(*) as count, COALESCE(SUM(t.value_usd),0)::float as value FROM paper_trades t LEFT JOIN paper_positions p ON t.market_id = p.market_id AND t.token_id = p.token_id WHERE t.side = 'buy' AND p.id IS NULL"
echo ","

# === INTEGRITY: ACCOUNT CONSISTENCY ===
echo '"account_consistency":'
query_one "SELECT a.current_capital::float as capital, a.initial_capital::float as initial, a.total_realized_pnl::float as realized_pnl, COALESCE(SUM(t.fee),0)::float as total_fees, (a.current_capital - a.initial_capital - a.total_realized_pnl)::float as unexplained_diff FROM paper_account a, paper_trades t GROUP BY a.current_capital, a.initial_capital, a.total_realized_pnl"
echo ","

# === PRICE DATA FRESHNESS ===
echo '"price_freshness":'
query_one "SELECT MAX(time) as latest_price, COUNT(DISTINCT market_id) as markets_with_data, COUNT(*) as records_1h FROM price_history WHERE time > NOW() - INTERVAL '1 hour'"
echo ","

# === SIGNAL FRESHNESS ===
echo '"signal_freshness":'
query_one "SELECT MAX(created_at) as latest_signal, COUNT(*) as signals_1h FROM trading_signals WHERE created_at > NOW() - INTERVAL '1 hour'"
echo ","

# === OPTIMIZATION RUNS ===
echo '"optimization_runs":'
query_json "SELECT id, status, created_at, best_sharpe::float, best_return::float, best_score::float FROM optimization_runs ORDER BY created_at DESC LIMIT 3"
echo ","

# === CURRENT SIGNAL WEIGHTS ===
echo '"signal_weights":'
query_json "SELECT * FROM signal_weights_current"
echo ","

# === CONSECUTIVE LOSING TRADES ===
echo '"consecutive_losses":'
query_one "
WITH ordered_trades AS (
  SELECT time, side, value_usd,
    CASE WHEN side = 'sell' AND value_usd < 0 THEN 1 ELSE 0 END as is_loss
  FROM paper_trades ORDER BY time DESC LIMIT 50
),
streak AS (
  SELECT is_loss,
    ROW_NUMBER() OVER (ORDER BY time DESC) -
    ROW_NUMBER() OVER (PARTITION BY is_loss ORDER BY time DESC) as grp
  FROM ordered_trades
)
SELECT COALESCE(MAX(cnt),0) as max_consecutive_losses FROM (
  SELECT COUNT(*) as cnt FROM streak WHERE is_loss = 1 GROUP BY grp
) sub"
echo ","

# === CONTAINER HEALTH ===
echo '"containers":'
docker ps --format '{"name":"{{.Names}}","status":"{{.Status}}","image":"{{.Image}}"}' | jq -s '.'
echo ","

# === RECENT ERROR LOGS (last 100 lines per container, filtered) ===
echo '"error_logs": {'
echo '"dashboard_api":'
docker logs --tail 100 polymarket-dashboard-api 2>&1 | grep -iE "(error|warn|fatal|exception)" | tail -20 | jq -R -s 'split("\n") | map(select(length > 0))'
echo ","
echo '"data_collector":'
docker logs --tail 100 polymarket-data-collector 2>&1 | grep -iE "(error|warn|fatal|exception)" | tail -20 | jq -R -s 'split("\n") | map(select(length > 0))'
echo "}"

echo "}"
```

**Step 2: Make it executable and test**

Run: `chmod +x scripts/daily-review.sh`

To test, SSH to VM and run:
```bash
gcloud compute ssh Usuario@polymarket-vm --zone=us-east1-b --command="cd /home/Usuario/polymarket-trader && git pull && bash scripts/daily-review.sh" | jq .
```

Verify: Output is valid JSON with all sections populated.

**Step 3: Commit**

```bash
git add scripts/daily-review.sh
git commit -m "feat: add consolidated daily review data-gathering script"
```

---

### Task 2: Create the formatter script

**Files:**
- Create: `scripts/format-review.js`

**Step 1: Write the formatter**

This runs in the GitHub Actions runner (has Node.js). Reads JSON from stdin, outputs three files: `report.md`, `email.html`, `slack.json` (only if critical alerts).

```javascript
#!/usr/bin/env node
const fs = require('fs');

const input = fs.readFileSync('/dev/stdin', 'utf8');
const data = JSON.parse(input);

const alerts = [];
const now = new Date();

// === DETECT CRITICAL ALERTS ===

// 1. Drawdown > 10%
const account = data.account;
if (account) {
  const drawdown = parseFloat(account.max_drawdown) || 0;
  if (drawdown > 10) {
    alerts.push(`🔴 DRAWDOWN ALERT: ${drawdown.toFixed(1)}% (threshold: 10%)`);
  }
}

// 2. Consecutive losing trades >= 5
const consec = data.consecutive_losses;
if (consec && consec.max_consecutive_losses >= 5) {
  alerts.push(`🔴 LOSING STREAK: ${consec.max_consecutive_losses} consecutive losing trades`);
}

// 3. System down - no prices in last hour
const priceFresh = data.price_freshness;
if (priceFresh && priceFresh.records_1h == 0) {
  alerts.push(`🔴 SYSTEM DOWN: No price data collected in the last hour`);
}

// 4. Zombie positions
const zombies = data.zombie_positions;
if (zombies && zombies.count > 0) {
  alerts.push(`🟡 ZOMBIE POSITIONS: ${zombies.count} positions with size=0 not closed`);
}

// 5. Daily PnL < -$200
const trades24 = data.trades_summary;
if (account) {
  const dailyPnl = parseFloat(account.total_realized_pnl) || 0;
  // Approximate daily PnL from recent closed positions
  const recentClosed = data.recently_closed || [];
  const dailyRealizedPnl = recentClosed.reduce((sum, p) => sum + (p.realized_pnl || 0), 0);
  if (dailyRealizedPnl < -200) {
    alerts.push(`🔴 DAILY LOSS: $${dailyRealizedPnl.toFixed(2)} realized PnL in last 24h (threshold: -$200)`);
  }
}

// 6. Container not running
const containers = data.containers || [];
const expectedContainers = ['polymarket-dashboard-api', 'polymarket-data-collector', 'polymarket-timescaledb'];
for (const name of expectedContainers) {
  const c = containers.find(c => c.name === name || c.name.includes(name.replace('polymarket-', '')));
  if (!c) {
    alerts.push(`🔴 CONTAINER DOWN: ${name} not found in docker ps`);
  } else if (!c.status.toLowerCase().includes('up')) {
    alerts.push(`🔴 CONTAINER UNHEALTHY: ${name} status: ${c.status}`);
  }
}

// 7. Render optimization (from env, added by workflow)
const renderStatus = process.env.RENDER_OPTIMIZATION_STATUS;
if (renderStatus === 'failed') {
  alerts.push(`🟡 RENDER: Last optimization job failed`);
}

const hasCriticalAlerts = alerts.some(a => a.includes('🔴'));

// === FORMAT MARKDOWN REPORT ===

function fmt(n) { return n != null ? parseFloat(n).toFixed(2) : 'N/A'; }

let md = `# 📊 Daily Trade Review — ${now.toISOString().slice(0, 10)}\n\n`;

if (alerts.length > 0) {
  md += `## ⚠️ Alerts\n\n`;
  for (const a of alerts) md += `- ${a}\n`;
  md += `\n`;
}

// Account
if (account) {
  const capital = parseFloat(account.current_capital);
  const initial = parseFloat(account.initial_capital);
  const pnlPct = ((capital - initial) / initial * 100);
  md += `## 💰 Account Status\n\n`;
  md += `| Metric | Value |\n|--------|-------|\n`;
  md += `| Capital | $${fmt(account.current_capital)} |\n`;
  md += `| Available | $${fmt(account.available_capital)} |\n`;
  md += `| Initial | $${fmt(account.initial_capital)} |\n`;
  md += `| Realized PnL | $${fmt(account.total_realized_pnl)} |\n`;
  md += `| Unrealized PnL | $${fmt(account.total_unrealized_pnl)} |\n`;
  md += `| Total Return | ${pnlPct.toFixed(2)}% |\n`;
  md += `| Max Drawdown | ${fmt(account.max_drawdown)}% |\n`;
  md += `| Win Rate | ${account.total_trades > 0 ? (account.winning_trades / account.total_trades * 100).toFixed(1) : 0}% (${account.winning_trades}W / ${account.losing_trades}L) |\n\n`;
}

// Trades 24h
if (trades24) {
  md += `## 📈 Trades (24h)\n\n`;
  md += `- **Total**: ${trades24.total_trades} trades\n`;
  md += `- **Volume**: $${fmt(trades24.total_value)}\n`;
  md += `- **Fees**: $${fmt(trades24.total_fees)}\n\n`;

  const signalDist = data.signal_distribution || [];
  if (signalDist.length > 0) {
    md += `**By Signal Type:**\n\n`;
    md += `| Signal | Count |\n|--------|-------|\n`;
    for (const s of signalDist) md += `| ${s.signal_type || 'unknown'} | ${s.count} |\n`;
    md += `\n`;
  }

  const hourly = data.hourly_trades || [];
  if (hourly.length > 0) {
    md += `**Hourly Breakdown:**\n\n`;
    md += `| Hour | Trades | Value | Fees |\n|------|--------|-------|------|\n`;
    for (const h of hourly) {
      const hr = new Date(h.hour).toISOString().slice(11, 16);
      md += `| ${hr} | ${h.trades} | $${fmt(h.total_value)} | $${fmt(h.total_fees)} |\n`;
    }
    md += `\n`;
  }
}

// Open Positions
const openPos = data.open_positions || [];
md += `## 📂 Open Positions (${openPos.length})\n\n`;

const worstPos = data.worst_positions || [];
if (worstPos.length > 0) {
  md += `**Top 10 Worst:**\n\n`;
  md += `| Market | Side | Entry | Current | PnL | PnL% |\n|--------|------|-------|---------|-----|------|\n`;
  for (const p of worstPos) {
    const name = p.question ? p.question.slice(0, 50) : p.market_id.slice(0, 12);
    md += `| ${name} | ${p.side} | $${fmt(p.avg_entry_price)} | $${fmt(p.current_price)} | $${fmt(p.unrealized_pnl)} | ${fmt(p.unrealized_pnl_pct)}% |\n`;
  }
  md += `\n`;
}

// Recently Closed
const closed = data.recently_closed || [];
if (closed.length > 0) {
  md += `## 🔒 Recently Closed (24h): ${closed.length} positions\n\n`;
  const totalPnl = closed.reduce((s, p) => s + (p.realized_pnl || 0), 0);
  md += `**Total Realized PnL (24h):** $${fmt(totalPnl)}\n\n`;
  md += `| Market | Side | PnL | Closed At |\n|--------|------|-----|----------|\n`;
  for (const p of closed) {
    const name = p.question ? p.question.slice(0, 50) : p.market_id.slice(0, 12);
    md += `| ${name} | ${p.side} | $${fmt(p.realized_pnl)} | ${new Date(p.closed_at).toISOString().slice(11, 19)} |\n`;
  }
  md += `\n`;
}

// Data Integrity
md += `## 🔍 Data Integrity\n\n`;
md += `- **Zombie positions**: ${zombies ? zombies.count : 'N/A'}\n`;
const orphans = data.orphaned_buys;
md += `- **Orphaned buys**: ${orphans ? `${orphans.count} ($${fmt(orphans.value)})` : 'N/A'}\n`;
const consistency = data.account_consistency;
if (consistency) {
  md += `- **Unexplained capital diff**: $${fmt(consistency.unexplained_diff)}\n`;
}
md += `\n`;

// System Health
md += `## 🖥️ System Health\n\n`;
if (priceFresh) {
  md += `- **Latest price**: ${priceFresh.latest_price ? new Date(priceFresh.latest_price).toISOString() : 'NONE'}\n`;
  md += `- **Markets with data (1h)**: ${priceFresh.markets_with_data}\n`;
  md += `- **Price records (1h)**: ${priceFresh.records_1h}\n`;
}
const sigFresh = data.signal_freshness;
if (sigFresh) {
  md += `- **Latest signal**: ${sigFresh.latest_signal ? new Date(sigFresh.latest_signal).toISOString() : 'NONE'}\n`;
  md += `- **Signals (1h)**: ${sigFresh.signals_1h}\n`;
}
md += `\n`;

// Containers
md += `**Containers:**\n\n`;
for (const c of containers) {
  const ok = c.status.toLowerCase().includes('up') ? '✅' : '❌';
  md += `- ${ok} **${c.name}**: ${c.status}\n`;
}
md += `\n`;

// Error Logs
const errorLogs = data.error_logs || {};
const dashErrors = errorLogs.dashboard_api || [];
const collErrors = errorLogs.data_collector || [];
if (dashErrors.length > 0 || collErrors.length > 0) {
  md += `**Recent Errors:**\n\n`;
  if (dashErrors.length > 0) {
    md += `<details><summary>Dashboard API (${dashErrors.length} errors)</summary>\n\n\`\`\`\n${dashErrors.join('\n')}\n\`\`\`\n</details>\n\n`;
  }
  if (collErrors.length > 0) {
    md += `<details><summary>Data Collector (${collErrors.length} errors)</summary>\n\n\`\`\`\n${collErrors.join('\n')}\n\`\`\`\n</details>\n\n`;
  }
}

// Optimization
const optRuns = data.optimization_runs || [];
const weights = data.signal_weights || [];
md += `## ⚙️ Optimization\n\n`;
if (optRuns.length > 0) {
  md += `**Last 3 Runs:**\n\n`;
  md += `| Status | Date | Sharpe | Return | Score |\n|--------|------|--------|--------|-------|\n`;
  for (const r of optRuns) {
    md += `| ${r.status} | ${new Date(r.created_at).toISOString().slice(0, 10)} | ${fmt(r.best_sharpe)} | ${fmt(r.best_return)} | ${fmt(r.best_score)} |\n`;
  }
  md += `\n`;
}
if (weights.length > 0) {
  md += `**Current Signal Weights:**\n\n`;
  md += `| Signal | Weight |\n|--------|--------|\n`;
  for (const w of weights) {
    const name = w.signal_type || w.generator_name || Object.values(w)[0];
    const weight = w.weight || w.value || Object.values(w)[1];
    md += `| ${name} | ${fmt(weight)} |\n`;
  }
  md += `\n`;
}

// Render optimization status (from env)
const renderData = process.env.RENDER_OPTIMIZATION_DATA;
if (renderData) {
  md += `**Render Optimization Jobs:**\n\n`;
  try {
    const jobs = JSON.parse(renderData);
    for (const j of jobs.slice(0, 3)) {
      md += `- ${j.status}: ${j.createdAt || j.created_at} (${j.id})\n`;
    }
  } catch (e) {
    md += `${renderData}\n`;
  }
  md += `\n`;
}

// === WRITE OUTPUT FILES ===

fs.writeFileSync('report.md', md);

// Email: simplified HTML version
let email = `<h2>Polymarket Daily Review — ${now.toISOString().slice(0, 10)}</h2>`;
if (alerts.length > 0) {
  email += `<h3>⚠️ Alerts</h3><ul>`;
  for (const a of alerts) email += `<li>${a}</li>`;
  email += `</ul>`;
}
if (account) {
  const capital = parseFloat(account.current_capital);
  const initial = parseFloat(account.initial_capital);
  email += `<h3>Account</h3>`;
  email += `<p>Capital: <b>$${fmt(account.current_capital)}</b> | `;
  email += `PnL: $${fmt(account.total_realized_pnl)} realized, $${fmt(account.total_unrealized_pnl)} unrealized | `;
  email += `Return: ${((capital - initial) / initial * 100).toFixed(2)}%</p>`;
}
if (trades24) {
  email += `<h3>Trades (24h)</h3>`;
  email += `<p>${trades24.total_trades} trades, $${fmt(trades24.total_value)} volume, $${fmt(trades24.total_fees)} fees</p>`;
}
email += `<p>Open positions: ${openPos.length}</p>`;
if (closed.length > 0) {
  const totalPnl = closed.reduce((s, p) => s + (p.realized_pnl || 0), 0);
  email += `<p>Closed (24h): ${closed.length} positions, $${fmt(totalPnl)} PnL</p>`;
}
email += `<p><a href="https://github.com/JaviMaligno/polymarket-trader/issues">Full report on GitHub →</a></p>`;

fs.writeFileSync('email.html', email);

// Slack: only if critical alerts
if (hasCriticalAlerts) {
  const slack = {
    text: `🚨 Polymarket Trading Alert — ${now.toISOString().slice(0, 10)}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `🚨 Trading Alert — ${now.toISOString().slice(0, 10)}` }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: alerts.filter(a => a.includes('🔴')).join('\n')
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `<https://github.com/JaviMaligno/polymarket-trader/issues|View full report on GitHub>`
        }
      }
    ]
  };
  fs.writeFileSync('slack.json', JSON.stringify(slack));
}

// Output summary for workflow
console.log(JSON.stringify({
  has_critical_alerts: hasCriticalAlerts,
  alert_count: alerts.length,
  alerts: alerts
}));
```

**Step 2: Commit**

```bash
git add scripts/format-review.js
git commit -m "feat: add daily review formatter (markdown, email, slack)"
```

---

### Task 3: Create the GitHub Actions workflow

**Files:**
- Create: `.github/workflows/daily-trade-review.yml`

**Step 1: Write the workflow**

```yaml
name: Daily Trade Review

on:
  schedule:
    - cron: '0 8 * * *'  # 8:00 UTC daily
  workflow_dispatch:       # Manual trigger for testing

permissions:
  contents: read
  id-token: write          # Required for GCP WIF
  issues: write            # Create GitHub issues

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Authenticate to GCP
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: 'projects/992492426638/locations/global/workloadIdentityPools/github-pool/providers/github-provider'
          service_account: 'github-deploy@project-94e9f6f2-aba7-4cb6-afc.iam.gserviceaccount.com'

      - name: Setup Cloud SDK
        uses: google-github-actions/setup-gcloud@v2

      - name: Gather data from VM
        id: gather
        run: |
          gcloud compute ssh Usuario@polymarket-vm \
            --zone=us-east1-b \
            --ssh-flag="-o ServerAliveInterval=30" \
            --ssh-flag="-o StrictHostKeyChecking=no" \
            --command="cd /home/Usuario/polymarket-trader && git pull --quiet origin main && bash scripts/daily-review.sh" \
            > review-data.json 2>/dev/null

          # Validate JSON
          if ! jq . review-data.json > /dev/null 2>&1; then
            echo "::error::Invalid JSON output from daily-review.sh"
            cat review-data.json
            exit 1
          fi

          echo "data_collected=true" >> $GITHUB_OUTPUT

      - name: Query Render API
        id: render
        if: steps.gather.outputs.data_collected == 'true'
        continue-on-error: true
        env:
          RENDER_API_KEY: ${{ secrets.RENDER_API_KEY }}
        run: |
          if [ -n "$RENDER_API_KEY" ]; then
            RENDER_DATA=$(curl -s -H "Authorization: Bearer $RENDER_API_KEY" \
              "https://api.render.com/v1/services?type=cron_job&limit=5" || echo "[]")
            echo "RENDER_OPTIMIZATION_DATA=$RENDER_DATA" >> $GITHUB_ENV

            # Check if latest job failed
            LATEST_STATUS=$(echo "$RENDER_DATA" | jq -r '.[0].service.suspended // "unknown"' 2>/dev/null || echo "unknown")
            echo "RENDER_OPTIMIZATION_STATUS=$LATEST_STATUS" >> $GITHUB_ENV
          else
            echo "RENDER_OPTIMIZATION_STATUS=no_key" >> $GITHUB_ENV
          fi

      - name: Format report
        id: format
        if: steps.gather.outputs.data_collected == 'true'
        run: |
          cat review-data.json | node scripts/format-review.js > format-output.json

          # Parse formatter output
          HAS_CRITICAL=$(jq -r '.has_critical_alerts' format-output.json)
          ALERT_COUNT=$(jq -r '.alert_count' format-output.json)

          echo "has_critical_alerts=$HAS_CRITICAL" >> $GITHUB_OUTPUT
          echo "alert_count=$ALERT_COUNT" >> $GITHUB_OUTPUT

      - name: Create GitHub Issue
        if: steps.gather.outputs.data_collected == 'true'
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          DATE=$(date -u +%Y-%m-%d)
          ALERT_COUNT=${{ steps.format.outputs.alert_count }}

          if [ "$ALERT_COUNT" -gt 0 ]; then
            TITLE="📊 Daily Review $DATE — ⚠️ $ALERT_COUNT alert(s)"
          else
            TITLE="📊 Daily Review $DATE — ✅ All clear"
          fi

          gh issue create \
            --title "$TITLE" \
            --body-file report.md \
            --label "daily-review"

      - name: Send email
        if: steps.gather.outputs.data_collected == 'true'
        uses: dawidd6/action-send-mail@v3
        with:
          server_address: smtp.gmail.com
          server_port: 587
          username: ${{ secrets.GMAIL_USERNAME }}
          password: ${{ secrets.GMAIL_APP_PASSWORD }}
          subject: "Polymarket Daily Review — ${{ steps.format.outputs.alert_count }} alerts"
          to: ${{ secrets.GMAIL_TO_ADDRESS }}
          from: ${{ secrets.GMAIL_USERNAME }}
          html_body: file://email.html

      - name: Send Slack alert (critical only)
        if: steps.format.outputs.has_critical_alerts == 'true'
        run: |
          if [ -f slack.json ] && [ -n "${{ secrets.SLACK_WEBHOOK_URL }}" ]; then
            curl -X POST -H 'Content-type: application/json' \
              --data @slack.json \
              "${{ secrets.SLACK_WEBHOOK_URL }}"
          fi
```

**Step 2: Create the `daily-review` label**

The workflow uses a `daily-review` label for issues. Create it:

```bash
gh label create "daily-review" --description "Automated daily trade review" --color "0075ca"
```

**Step 3: Commit**

```bash
git add .github/workflows/daily-trade-review.yml
git commit -m "feat: add daily trade review GitHub Actions workflow"
```

---

### Task 4: Setup GitHub secrets

**Not automatable — manual steps for the user:**

Required secrets to configure in GitHub repo settings:

```bash
# Gmail (for email reports)
gh secret set GMAIL_USERNAME        # your Gmail address
gh secret set GMAIL_APP_PASSWORD    # Gmail app password (not regular password)
gh secret set GMAIL_TO_ADDRESS      # recipient email

# Slack (for critical alerts)
gh secret set SLACK_WEBHOOK_URL     # Slack incoming webhook URL

# Render (for optimization status)
gh secret set RENDER_API_KEY        # Render API key
```

Note: GCP WIF auth already works (used by deploy-gcp.yml). No additional GCP secrets needed.

---

### Task 5: Test with manual trigger

**Step 1: Push to main and trigger**

```bash
git push origin main
gh workflow run daily-trade-review.yml
```

**Step 2: Watch the run**

```bash
gh run watch
```

**Step 3: Verify outputs**

- Check GitHub Issues for new daily review issue
- Check email inbox
- If there were critical alerts, check Slack

**Step 4: Debug if needed**

```bash
gh run view --log
```

Common issues:
- SSH timeout → check GCP WIF permissions
- Invalid JSON → SSH to VM and run `bash scripts/daily-review.sh | jq .` manually
- Email not sent → verify Gmail app password (need 2FA enabled, then generate app-specific password)
- Label not found → create it with `gh label create`

---

### Task 6: Commit everything and verify

**Step 1: Final verification commit**

After testing and fixing any issues:

```bash
git add -A
git commit -m "feat: daily trade review automation (Phase 1 complete)"
```

---

## Files Summary

| File | Purpose |
|------|---------|
| `scripts/daily-review.sh` | Runs on VM, gathers all data as JSON via psql + docker |
| `scripts/format-review.js` | Runs in GH Actions, formats JSON → markdown, email, slack |
| `.github/workflows/daily-trade-review.yml` | Orchestrates: SSH → gather → format → publish |
| `docs/plans/2026-03-09-daily-trade-review-design.md` | Design document (already exists) |

## Secrets Required

| Secret | Required For |
|--------|-------------|
| `GMAIL_USERNAME` | Email reports |
| `GMAIL_APP_PASSWORD` | Email auth |
| `GMAIL_TO_ADDRESS` | Email recipient |
| `SLACK_WEBHOOK_URL` | Slack critical alerts |
| `RENDER_API_KEY` | Render optimization status |

GCP auth uses Workload Identity Federation (already configured).
