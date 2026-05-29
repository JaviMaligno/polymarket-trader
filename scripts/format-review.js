#!/usr/bin/env node
// format-review.js — Reads daily-review JSON from stdin (or file arg), produces:
//   report.md   — Full GitHub-flavored markdown report
//   email.html  — Shorter HTML email summary
//   slack.json  — Slack Block Kit payload (only if critical alerts exist)
// Prints JSON summary to stdout: {has_critical_alerts, alert_count, alerts}

'use strict';

const fs = require('fs');
const path = require('path');
const { detectSupplyCollapse } = require('./coverage-alerts.js');

// ── Read input ──────────────────────────────────────────────────────────────

const inputPath = process.argv[2] || '/dev/stdin';
let raw;
try {
  raw = fs.readFileSync(inputPath, 'utf8');
} catch (err) {
  console.error(`Error reading input: ${err.message}`);
  process.exit(1);
}

let data;
try {
  data = JSON.parse(raw);
} catch (err) {
  console.error(`Error parsing JSON: ${err.message}`);
  process.exit(1);
}

// ── gather_failed early-exit path ───────────────────────────────────────────
// daily-review.sh emits {"gather_failed":true,...} via its EXIT trap when the
// VM/DB is unreachable. In that case the JSON has none of the expected fields,
// so build a minimal failure report (email + slack + stdout) and exit 0 so the
// workflow's notification step still runs and the operator gets paged.
if (data && data.gather_failed === true) {
  const fs2 = require('fs');
  const path2 = require('path');
  const exitCode = data.exit_code ?? 'unknown';
  const ts = data.generated_at || new Date().toISOString();
  const subject = `Polymarket Daily Review FAILED — gather exit ${exitCode} (${ts})`;
  const summary = `Daily review data collection failed (daily-review.sh exited ${exitCode} at ${ts}). The VM, DB, or SSH connection was unreachable. Check VM status and rerun the workflow.`;

  const reportMd = [
    `# Daily Trading Review — FAILED`,
    `> Generated: ${ts}`,
    ``,
    `## \u{1F534} Data collection failed`,
    ``,
    `\`daily-review.sh\` exited with code **${exitCode}**. No metrics were gathered.`,
    ``,
    `Common causes:`,
    `- VM stopped or unreachable (check \`gcloud compute instances describe polymarket-vm\`)`,
    `- TimescaleDB container down (\`docker compose ps\`)`,
    `- SSH auth/network failure on the GitHub runner`,
    ``,
    `Once the infrastructure is restored, rerun the workflow manually.`,
    ``,
  ].join('\n');

  const emailHtml = [
    `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:600px;margin:0 auto;padding:20px;">`,
    `<h1 style="color:#d73a49;">\u{1F534} Polymarket Daily Review FAILED</h1>`,
    `<p><strong>${escapeHtmlMinimal(summary)}</strong></p>`,
    `<p>Generated: ${escapeHtmlMinimal(ts)}<br>Exit code: ${escapeHtmlMinimal(String(exitCode))}</p>`,
    `<p>The workflow's <code>daily-review.sh</code> script failed before any metrics could be collected. Common causes: VM stopped, TimescaleDB down, SSH/auth failure on the runner.</p>`,
    `<p>Restore the infrastructure and rerun the workflow manually from the GitHub Actions UI.</p>`,
    `</body></html>`,
  ].join('\n');

  const slackPayload = {
    text: `Polymarket Alert: ${summary}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '\u{1F534} Polymarket Daily Review FAILED', emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Data collection failed:* daily-review.sh exited ${exitCode} at ${ts}` } },
      { type: 'section', text: { type: 'mrkdwn', text: 'Likely cause: VM, TimescaleDB, or SSH unreachable. Restore infra and rerun the workflow.' } },
    ],
  };

  const outDir2 = process.cwd();
  fs2.writeFileSync(path2.join(outDir2, 'report.md'), reportMd, 'utf8');
  fs2.writeFileSync(path2.join(outDir2, 'email.html'), emailHtml, 'utf8');
  fs2.writeFileSync(path2.join(outDir2, 'slack.json'), JSON.stringify(slackPayload, null, 2), 'utf8');

  console.log(JSON.stringify({
    has_critical_alerts: true,
    alert_count: 1,
    alerts: [`[CRITICAL] Data collection failed (gather_failed, exit ${exitCode})`],
    gather_failed: true,
  }));
  process.exit(0);
}

function escapeHtmlMinimal(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function fmt(n, decimals = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return 'N/A';
  return Number(n).toFixed(decimals);
}

function fmtUsd(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return 'N/A';
  const v = Number(n);
  const sign = v >= 0 ? '' : '-';
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function fmtPct(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return 'N/A';
  return `${(Number(n) * 100).toFixed(2)}%`;
}

function fmtPctRaw(n) {
  // Already a percentage value, just format
  if (n === null || n === undefined || Number.isNaN(n)) return 'N/A';
  return `${Number(n).toFixed(2)}%`;
}

function fmtDate(d) {
  if (!d) return 'N/A';
  try {
    const dt = new Date(d);
    return dt.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  } catch {
    return String(d);
  }
}

function fmtDateShort(d) {
  if (!d) return 'N/A';
  try {
    const dt = new Date(d);
    return dt.toISOString().slice(0, 16).replace('T', ' ');
  } catch {
    return String(d);
  }
}

function truncate(s, len) {
  if (!s) return 'N/A';
  s = String(s);
  return s.length > len ? s.slice(0, len - 3) + '...' : s;
}

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Extract data with safe defaults ─────────────────────────────────────────

const account = data.account || null;
const tradesSummary = data.trades_summary || null;
const signalDistribution = Array.isArray(data.signal_distribution) ? data.signal_distribution : [];
const hourlyTrades = Array.isArray(data.hourly_trades) ? data.hourly_trades : [];
const openPositions = Array.isArray(data.open_positions) ? data.open_positions : [];
const worstPositions = Array.isArray(data.worst_positions) ? data.worst_positions : [];
const recentlyClosed = Array.isArray(data.recently_closed) ? data.recently_closed : [];
const zombiePositions = data.zombie_positions || null;
const orphanedBuys = data.orphaned_buys || null;
const invariantChecks = data.invariant_checks || null;
const priceFreshness = data.price_freshness || null;
const signalFreshness = data.signal_freshness || null;
const optimizationRuns = Array.isArray(data.optimization_runs) ? data.optimization_runs : [];
const signalWeights = Array.isArray(data.signal_weights) ? data.signal_weights : [];
const consecutiveLosses = data.consecutive_losses || null;
const containers = Array.isArray(data.containers) ? data.containers : [];
const errorLogs = data.error_logs || {};
const realPnlCheck = data.real_pnl_check || null;
const categoryPerformance = Array.isArray(data.category_performance) ? data.category_performance : [];
const tradesByType = Array.isArray(data.trades_by_type) ? data.trades_by_type : [];
const shadowSummary = Array.isArray(data.shadow_summary) ? data.shadow_summary : [];
// Phase 5 Pilar 4-A (2026-05-15): health-of-edge metrics.
const edgeCohortsPositive = Array.isArray(data.edge_cohorts_positive) ? data.edge_cohorts_positive : [];
const edgeCohortsTraded = Array.isArray(data.edge_cohorts_traded) ? data.edge_cohorts_traded : [];
const edgeGap = Array.isArray(data.edge_gap) ? data.edge_gap : [];
const edgeMeasurementFreshness = Array.isArray(data.edge_measurement_freshness) ? data.edge_measurement_freshness : [];
// 2026-05-26 #266: added to surface SignalEngine feed coverage gaps and
// current-day open distribution (distinct from rolling 7d edge_cohorts_traded).
const opensToday = Array.isArray(data.opens_today) ? data.opens_today : [];
const coverageByType = Array.isArray(data.coverage_by_type) ? data.coverage_by_type : [];
const generatedAt = data.generated_at || new Date().toISOString();

// ── Trading-state derived signals ───────────────────────────────────────────
// "Inactive" = the executor is not opening or closing positions right now.
// Detect with the data we already collect: zero trades in the last 24h AND no
// open positions. Useful so the email can label "consecutive losses" (which is
// a cumulative DB counter, not a recent metric) with honest context, and to
// surface the inactive state explicitly instead of leaving the reader to
// derive it from a wall of zeroed-out 24h counters.
const tradesIn24h = tradesSummary && Number.isFinite(Number(tradesSummary.total_trades))
  ? Number(tradesSummary.total_trades)
  : 0;
const tradingInactive = tradesIn24h === 0 && openPositions.length === 0 && recentlyClosed.length === 0;

// ── Detect alerts ───────────────────────────────────────────────────────────

const alerts = []; // { level: 'critical'|'warning', message: string }

// Drawdown > 10% (max_drawdown stored as percentage, e.g. 10.0 = 10%)
if (account && account.max_drawdown != null && account.max_drawdown > 10) {
  alerts.push({ level: 'critical', message: `Drawdown at ${fmtPctRaw(account.max_drawdown)} (threshold: 10%)` });
}

// Phase 5 Pilar 4-A: edge_gap = trading without measured edge. The biggest
// failure mode in production. Critical when cumulative loss > $50 across rows.
if (edgeGap.length > 0) {
  const totalLoss = edgeGap.reduce((s, r) => s + (Number(r.total_pnl) < 0 ? Number(r.total_pnl) : 0), 0);
  const level = totalLoss < -50 ? 'critical' : 'warning';
  alerts.push({
    level,
    message: `Edge gap: trading ${edgeGap.length} (type, direction) cohort(s) WITHOUT measured cost-aware edge. Cumulative loss: ${fmtUsd(totalLoss)}`,
  });
}

// Phase 5 Pilar 4-A: measurement infra. Stale edge measurement (>48h) means
// the nightly EdgeCapacityRefresher cron is failing for some types.
const staleMeasurements = edgeMeasurementFreshness.filter((r) => Number(r.hours_since) > 48);
// 2026-05-26 #266: classify stale-measurement alarms — a type that is also
// starved at the feed (with_preds_24h = 0) is a downstream symptom, not a
// cron failure. Suppress the cron-failure alert for those types so it doesn't
// drown out the actual feed bug.
const coverageByMarketType = new Map(coverageByType.map((r) => [r.market_type, r]));
const trueCronStales = staleMeasurements.filter((r) => {
  const cov = coverageByMarketType.get(r.market_type);
  return !cov || Number(cov.with_preds_24h) > 0;
});
if (trueCronStales.length > 0) {
  alerts.push({
    level: 'warning',
    message: `Edge measurement stale (>48h) for ${trueCronStales.length} market_type(s): ${trueCronStales.map((r) => r.market_type).join(', ')}`,
  });
}

// 2026-05-26 #266: SignalEngine feed coverage. A type tracked + priced but
// with 0 predictions in 24h is starved by the signal feed slice (the
// SignalEngine per-type allocation bug). This is the root cause behind
// many "edge stale Xh" downstream alarms.
const feedStarvedTypes = coverageByType.filter((r) => {
  return Number(r.tracked) > 0
    && Number(r.priced_24h) > 0
    && Number(r.with_preds_24h) === 0;
});
if (feedStarvedTypes.length > 0) {
  alerts.push({
    level: 'critical',
    message: `SignalEngine feed starved for ${feedStarvedTypes.length} type(s) (tracked + priced but 0 predictions/24h): ${feedStarvedTypes.map((r) => `${r.market_type} (${r.tracked} tracked)`).join(', ')}`,
  });
}

// 2026-05-29 #280: supply collapse. An ALLOWED (live-tradeable) market type
// with 0 tracked markets — or entirely absent from coverage_by_type because the
// gather query's GROUP BY drops empty groups — means the rotator/collector has
// no supply for that type. The rule used to live only in the LLM prompt §1d;
// Watchdog #280 silently skipped it for crypto_intraday. Deterministic now.
// Warning (not critical): a type can be legitimately empty (e.g. crypto_intraday
// = 5-min markets we can't trade) without being an outage — surfacing it daily
// is the point; paging on it is not.
const supplyCollapseTypes = detectSupplyCollapse(coverageByType);
if (supplyCollapseTypes.length > 0) {
  alerts.push({
    level: 'warning',
    message: `Supply collapse: ${supplyCollapseTypes.length} ALLOWED market_type(s) have 0 tracked markets: ${supplyCollapseTypes.map((r) => r.market_type).join(', ')}. Either the collector/rotator stopped feeding the type, or its catalog is genuinely empty — verify against the live Polymarket catalog before assuming an outage.`,
  });
}

// 5+ consecutive losses. The metric is a cumulative DB counter, so when the
// executor has been idle (tradingInactive) the "5 in a row" is historical and
// not actionable — surface that context instead of paging on stale data.
if (consecutiveLosses && consecutiveLosses.max_consecutive_losses >= 5) {
  const suffix = tradingInactive ? ' (historical — no trades in last 24h)' : '';
  const level = tradingInactive ? 'warning' : 'critical';
  alerts.push({ level, message: `${consecutiveLosses.max_consecutive_losses} consecutive losing trades (threshold: 5)${suffix}` });
}

// No prices in last hour
if (priceFreshness && (priceFreshness.record_count_1h === 0 || priceFreshness.record_count_1h === null)) {
  alerts.push({ level: 'critical', message: 'No price data received in the last hour' });
}

// Container not running
const expectedContainers = ['dashboard', 'collector', 'data-collector', 'timescaledb'];
for (const expected of expectedContainers) {
  const found = containers.find(c => c.name && c.name.toLowerCase().includes(expected));
  if (!found) {
    // data-collector and collector are the same service, skip duplicate
    if (expected === 'collector' && containers.find(c => c.name && c.name.toLowerCase().includes('data-collector'))) continue;
    if (expected === 'data-collector' && containers.find(c => c.name && c.name.toLowerCase().includes('collector'))) continue;
    alerts.push({ level: 'critical', message: `Container "${expected}" not found running` });
  } else if (found.status && !found.status.toLowerCase().startsWith('up')) {
    alerts.push({ level: 'critical', message: `Container "${found.name}" status: ${found.status}` });
  }
}

// Daily realized PnL < -$200
const dailyRealizedPnl = recentlyClosed.reduce((sum, p) => sum + (p.realized_pnl || 0), 0);
if (dailyRealizedPnl < -200) {
  alerts.push({ level: 'critical', message: `Daily realized PnL ${fmtUsd(dailyRealizedPnl)} (threshold: -$200)` });
}

// Zombie positions > 0
const zombieCount = zombiePositions ? (zombiePositions.count || 0) : 0;
if (zombieCount > 0) {
  alerts.push({ level: 'warning', message: `${zombieCount} zombie positions (size=0, not closed)` });
}

// Inverted positions detected (price inversion bug)
if (realPnlCheck && realPnlCheck.inverted_count > 0) {
  const pct = realPnlCheck.total_closed > 0
    ? ((realPnlCheck.inverted_count / realPnlCheck.total_closed) * 100).toFixed(1)
    : '?';
  alerts.push({ level: 'critical', message: `${fmt(realPnlCheck.inverted_count, 0)} inverted positions (${pct}% of ${fmt(realPnlCheck.total_closed, 0)} closed). Real PnL: ${fmtUsd(realPnlCheck.real_pnl)} of reported ${fmtUsd(realPnlCheck.reported_pnl)}` });
}

// Resource usage — high memory alert (VM has only 1GB RAM)
const resourceUsage = data.resource_usage || [];
for (const r of resourceUsage) {
  const memPct = parseFloat((r.mem_pct || '0').replace('%', ''));
  if (memPct > 85) {
    alerts.push({ level: 'warning', message: `Container "${r.name}" memory at ${r.mem_pct} (${r.mem_usage}) — VM limit is 1GB` });
  }
}

// Render optimization
const renderOptData = process.env.RENDER_OPTIMIZATION_DATA || null;
const renderOptStatus = process.env.RENDER_OPTIMIZATION_STATUS || null;
let renderInfo = null;
if (renderOptData) {
  try { renderInfo = JSON.parse(renderOptData); } catch { /* ignore */ }
}
if (renderOptStatus && renderOptStatus.toLowerCase().includes('fail')) {
  alerts.push({ level: 'warning', message: `Render optimization failed: ${renderOptStatus}` });
}

const criticalAlerts = alerts.filter(a => a.level === 'critical');
const warningAlerts = alerts.filter(a => a.level === 'warning');
const hasCritical = criticalAlerts.length > 0;

// ── Computed values ─────────────────────────────────────────────────────────

const returnPct = account && account.initial_capital
  ? ((account.current_capital - account.initial_capital) / account.initial_capital)
  : null;

const winRate = account && account.total_trades > 0
  ? (account.winning_trades / account.total_trades)
  : null;

const closedPnlTotal = recentlyClosed.reduce((s, p) => s + (p.realized_pnl || 0), 0);

// ── Build report.md ─────────────────────────────────────────────────────────

function buildMarkdown() {
  const lines = [];
  const ln = (s = '') => lines.push(s);

  ln(`# Daily Trading Review`);
  ln(`> Generated: ${fmtDate(generatedAt)}`);
  ln();

  // Banner: trading-state context (avoids the "0 trades + 14 consecutive losses"
  // confusion where a stale cumulative counter looks like a fresh alert).
  if (tradingInactive) {
    ln(`> **⚠️ TRADING INACTIVE** — 0 trades in the last 24h, 0 open positions, 0 closed in 24h. All "24h" tables below will be empty by definition; cumulative metrics (consecutive losses, drawdown) are historical, not current.`);
    ln();
  }

  // Alerts
  if (alerts.length > 0) {
    ln(`## Alerts`);
    ln();
    for (const a of alerts) {
      const icon = a.level === 'critical' ? '\u{1F534}' : '\u{1F7E1}';
      ln(`- ${icon} **${a.level.toUpperCase()}**: ${a.message}`);
    }
    ln();
  }

  // Account Status
  ln(`## Account Status`);
  ln();
  if (account) {
    ln(`| Metric | Value |`);
    ln(`|--------|-------|`);
    ln(`| Current Capital | ${fmtUsd(account.current_capital)} |`);
    ln(`| Initial Capital | ${fmtUsd(account.initial_capital)} |`);
    ln(`| Available Capital | ${fmtUsd(account.available_capital)} |`);
    ln(`| Return | ${returnPct !== null ? fmtPct(returnPct) : 'N/A'} |`);
    ln(`| Realized PnL | ${fmtUsd(account.total_realized_pnl)} |`);
    ln(`| Unrealized PnL | ${fmtUsd(account.total_unrealized_pnl)} |`);
    ln(`| Total Fees | ${fmtUsd(account.total_fees_paid)} |`);
    ln(`| Max Drawdown | ${fmtPctRaw(account.max_drawdown)} |`);
    ln(`| Peak Equity | ${fmtUsd(account.peak_equity)} |`);
    ln(`| Win Rate | ${winRate !== null ? fmtPct(winRate) : 'N/A'} (${fmt(account.winning_trades, 0)}W / ${fmt(account.losing_trades, 0)}L / ${fmt(account.total_trades, 0)} total) |`);
    ln(`| Last Updated | ${fmtDate(account.updated_at)} |`);
  } else {
    ln(`*Account data unavailable.*`);
  }
  ln();

  // Real PnL Check
  if (realPnlCheck) {
    ln(`## Real PnL (post-reset)`);
    ln();
    const realPct = realPnlCheck.reported_pnl !== 0
      ? ((realPnlCheck.real_pnl / realPnlCheck.reported_pnl) * 100).toFixed(1)
      : 'N/A';
    ln(`| Metric | Value |`);
    ln(`|--------|-------|`);
    ln(`| Total Closed | ${fmt(realPnlCheck.total_closed, 0)} |`);
    ln(`| Inverted | ${fmt(realPnlCheck.inverted_count, 0)} |`);
    ln(`| Reported PnL | ${fmtUsd(realPnlCheck.reported_pnl)} |`);
    ln(`| **Real PnL** | **${fmtUsd(realPnlCheck.real_pnl)}** (${realPct}%) |`);
    ln(`| Phantom PnL | ${fmtUsd(realPnlCheck.phantom_pnl)} |`);
    ln();
  }

  // Trades 24h
  ln(`## Trades (24h)`);
  ln();
  if (tradesSummary) {
    ln(`**Summary**: ${fmt(tradesSummary.total_trades, 0)} trades | ${fmtUsd(tradesSummary.total_value)} volume | ${fmtUsd(tradesSummary.total_fees)} fees`);
    ln();
  }

  if (signalDistribution.length > 0) {
    ln(`### Signal Distribution`);
    ln();
    ln(`| Signal Type | Trades | Volume |`);
    ln(`|-------------|--------|--------|`);
    for (const s of signalDistribution) {
      ln(`| ${s.signal_type || 'unknown'} | ${fmt(s.trade_count, 0)} | ${fmtUsd(s.total_value)} |`);
    }
    ln();
  }

  if (hourlyTrades.length > 0) {
    ln(`### Hourly Breakdown`);
    ln();
    ln(`| Hour (UTC) | Trades | Volume |`);
    ln(`|------------|--------|--------|`);
    for (const h of hourlyTrades) {
      ln(`| ${fmtDateShort(h.hour)} | ${fmt(h.trade_count, 0)} | ${fmtUsd(h.total_value)} |`);
    }
    ln();
  }

  // Performance breakdown — three independent sources, separated so live and
  // shadow numbers are not visually adjacent (shadow is theoretical-no-fees
  // and was being mistaken for promotion candidates).
  if (
    tradesByType.length > 0 ||
    categoryPerformance.length > 0 ||
    shadowSummary.length > 0 ||
    // Phase 5 Pilar 4-A (2026-05-15): include the Performance Breakdown
    // section even when there are no trades — Health-of-Edge ("we measured
    // and found nothing") is one of the most important findings to surface
    // in exactly that case.
    edgeCohortsPositive.length > 0 ||
    edgeGap.length > 0 ||
    edgeMeasurementFreshness.length > 0 ||
    // 2026-05-29 #280: render the section when we have coverage data even with
    // no trades — "type X has 0 supply" is exactly a no-trades-day finding.
    coverageByType.length > 0
  ) {
    ln(`## Performance Breakdown`);
    ln();

    // Live, last 24h
    ln(`### Live — last 24h`);
    ln();
    if (tradesByType.length > 0) {
      ln(`| Type | Trades | Win % | PnL |`);
      ln(`|------|--------|-------|-----|`);
      for (const t of tradesByType) {
        ln(`| ${t.market_type || 'N/A'} | ${fmt(t.trades_24h, 0)} | ${fmtPctRaw(t.win_pct)} | ${fmtUsd(t.pnl_24h)} |`);
      }
    } else {
      ln(`*No trades in the last 24h.*`);
    }
    ln();

    // Live, since reset (cumulative)
    if (categoryPerformance.length > 0) {
      ln(`### Live — cumulative since last reset`);
      ln();
      ln(`| Type | Trades | Win Rate | Avg PnL | Sharpe | Prior |`);
      ln(`|------|--------|----------|---------|--------|-------|`);
      for (const c of categoryPerformance) {
        ln(`| ${c.market_type || 'N/A'} | ${fmt(c.n_trades, 0)} | ${fmtPct(c.win_rate)} | ${fmtUsd(c.avg_pnl)} | ${fmt(c.sharpe_ratio, 3)} | ${fmt(c.prior, 3)} |`);
      }
      ln();
    }

    // 2026-05-29 #280: SignalEngine feed coverage, always rendered so the
    // per-type tracked/priced/predicted breakdown is visible (not just surfaced
    // as an alert when something is wrong). Watchdog #280 reported only an
    // aggregate "MarketRotator: 72 active" line, which hid crypto_intraday=0.
    if (coverageByType.length > 0) {
      ln(`### Feed Coverage (by market_type)`);
      ln();
      ln(`| Type | Tracked | Priced 24h | Preds 24h | Active in DB |`);
      ln(`|------|---------|------------|-----------|--------------|`);
      for (const c of coverageByType) {
        const collapsed = supplyCollapseTypes.some((s) => s.market_type === c.market_type);
        const label = collapsed ? `${c.market_type} ⚠️` : c.market_type;
        ln(`| ${label} | ${fmt(c.tracked, 0)} | ${fmt(c.priced_24h, 0)} | ${fmt(c.with_preds_24h, 0)} | ${fmt(c.active_in_db, 0)} |`);
      }
      if (supplyCollapseTypes.length > 0) {
        ln();
        ln(`> ⚠️ = ALLOWED type with 0 tracked markets (supply collapse — see Alerts).`);
      }
      ln();
    }

    // Phase 5 Pilar 4-A (2026-05-15): Health-of-Edge section. Shows whether
    // we measured any positive cost-aware edge anywhere, and whether we're
    // trading in cohorts the data says are anti-edge (the "edge gap").
    if (edgeCohortsPositive.length > 0 || edgeGap.length > 0 || edgeMeasurementFreshness.length > 0) {
      ln(`### Health of Edge (cost-aware measurement)`);
      ln();

      if (edgeCohortsPositive.length === 0) {
        ln(`> **No cohort in the active universe currently has measured positive cost-aware edge** (t_net > 0). The system is operating in a measured-anti-edge regime.`);
      } else {
        ln(`**Cohorts with positive cost-aware edge** (top ${Math.min(edgeCohortsPositive.length, 10)} by t_net):`);
        ln();
        ln(`| Signal | Type | Dir | t_net | n | RT cost % |`);
        ln(`|--------|------|-----|-------|---|-----------|`);
        for (const c of edgeCohortsPositive.slice(0, 10)) {
          ln(`| ${c.signal_id || 'N/A'} | ${c.market_type || 'N/A'} | ${c.direction || 'N/A'} | ${fmt(c.t_net, 2)} | ${fmt(c.n, 0)} | ${fmt(c.rt_cost_pct, 2)} |`);
        }
      }
      ln();

      if (edgeGap.length > 0) {
        ln(`**Edge gap — trading WITHOUT measured edge** (capital at risk in anti-edge cohorts):`);
        ln();
        ln(`| Type | Direction | Trades | PnL (7d) |`);
        ln(`|------|-----------|--------|----------|`);
        for (const g of edgeGap) {
          ln(`| ${g.market_type || 'N/A'} | ${g.direction || 'N/A'} | ${fmt(g.n_trades, 0)} | ${fmtUsd(g.total_pnl)} |`);
        }
        ln();
      }

      if (edgeMeasurementFreshness.length > 0) {
        const stale = edgeMeasurementFreshness.filter((r) => Number(r.hours_since) > 48);
        if (stale.length > 0) {
          ln(`**Measurement freshness — stale (>48h)**:`);
          ln();
          ln(`| Type | Latest measurement | Hours since |`);
          ln(`|------|-------------------|-------------|`);
          for (const f of stale) {
            ln(`| ${f.market_type || 'N/A'} | ${fmtDateShort(f.latest_measurement)} | ${fmt(f.hours_since, 1)} |`);
          }
          ln();
        }
      }
    }

    // Shadow — theoretical, NOT directly comparable to live
    if (shadowSummary.length > 0) {
      ln(`### Shadow — last 30d (theoretical, no fees, no slippage)`);
      ln();
      ln(`> Computed at the resolution price. Prediction markets resolve mostly to NO, so SHORT direction systematically over-states win rate (sampling artifact, not strategy edge). **Do not promote based on shadow PnL alone — apply the empirical haircut (≈0.33) and validate with live data.**`);
      ln();
      ln(`| Type | Total | Resolved | Avg PnL |`);
      ln(`|------|-------|----------|---------|`);
      for (const s of shadowSummary) {
        ln(`| ${s.market_type || 'N/A'} | ${fmt(s.total, 0)} | ${fmt(s.resolved, 0)} | ${s.avg_pnl != null ? fmtUsd(s.avg_pnl) : 'N/A'} |`);
      }
      ln();
    }
  }

  // Open Positions
  ln(`## Open Positions (${openPositions.length})`);
  ln();
  if (worstPositions.length > 0) {
    ln(`### Top ${Math.min(worstPositions.length, 10)} Worst Positions`);
    ln();
    ln(`| Market | Side | Size | Entry | Current | PnL | PnL % | Opened |`);
    ln(`|--------|------|------|-------|---------|-----|-------|--------|`);
    for (const p of worstPositions.slice(0, 10)) {
      ln(`| ${truncate(p.question || p.market_id, 40)} | ${p.side || 'N/A'} | ${fmt(p.size)} | ${fmt(p.avg_entry_price, 4)} | ${fmt(p.current_price, 4)} | ${fmtUsd(p.unrealized_pnl)} | ${fmtPctRaw(p.unrealized_pnl_pct)} | ${fmtDateShort(p.opened_at)} |`);
    }
    ln();
  } else {
    ln(`*No open positions.*`);
    ln();
  }

  // Recently Closed
  ln(`## Recently Closed (24h)`);
  ln();
  if (recentlyClosed.length > 0) {
    ln(`**Total Realized PnL**: ${fmtUsd(closedPnlTotal)}`);
    ln();
    ln(`| Market | Side | Entry | PnL | Opened | Closed |`);
    ln(`|--------|------|-------|-----|--------|--------|`);
    for (const p of recentlyClosed) {
      ln(`| ${truncate(p.question || p.market_id, 40)} | ${p.side || 'N/A'} | ${fmt(p.avg_entry_price, 4)} | ${fmtUsd(p.realized_pnl)} | ${fmtDateShort(p.opened_at)} | ${fmtDateShort(p.closed_at)} |`);
    }
    ln();
  } else {
    ln(`*No positions closed in the last 24h.*`);
    ln();
  }

  // Data Integrity
  ln(`## Data Integrity`);
  ln();
  ln(`| Check | Value |`);
  ln(`|-------|-------|`);
  ln(`| Zombie Positions | ${zombieCount} |`);
  ln(`| Orphaned Buys | ${orphanedBuys ? fmt(orphanedBuys.count, 0) : 'N/A'} (${orphanedBuys ? fmtUsd(orphanedBuys.total_value) : 'N/A'}) |`);
  ln(`| Capital Reconciliation (cashflow) | ${invariantChecks ? (invariantChecks.capital_matches_cashflows ? 'OK' : 'MISMATCH') + ` (gap ${fmtUsd(invariantChecks.cashflow_gap)})` : 'N/A'} |`);
  ln(`| Fees Match | ${invariantChecks ? (invariantChecks.fees_match ? 'OK' : 'MISMATCH') : 'N/A'} |`);
  ln();
  if (invariantChecks) {
    ln(`> Capital change ${fmtUsd(invariantChecks.capital_change)} vs net cash flow ${fmtUsd(invariantChecks.net_cash_flow)} (leg-by-leg from paper_trades; convention-independent).`);
    ln();
  }

  // System Health
  ln(`## System Health`);
  ln();

  // Price freshness
  ln(`### Price Data`);
  ln();
  if (priceFreshness) {
    ln(`| Metric | Value |`);
    ln(`|--------|-------|`);
    ln(`| Latest Price | ${fmtDate(priceFreshness.latest_price)} |`);
    ln(`| Markets with Data (1h) | ${fmt(priceFreshness.markets_with_data_1h, 0)} |`);
    ln(`| Records (1h) | ${fmt(priceFreshness.record_count_1h, 0)} |`);
  } else {
    ln(`*Price freshness data unavailable.*`);
  }
  ln();

  // Signal freshness
  ln(`### Signal Data`);
  ln();
  if (signalFreshness) {
    ln(`| Metric | Value |`);
    ln(`|--------|-------|`);
    ln(`| Latest Signal | ${fmtDate(signalFreshness.latest_signal)} |`);
    ln(`| Signals (1h) | ${fmt(signalFreshness.count_last_hour, 0)} |`);
  } else {
    ln(`*Signal freshness data unavailable.*`);
  }
  ln();

  // Container status
  ln(`### Containers`);
  ln();
  if (containers.length > 0) {
    ln(`| Name | Status | Image |`);
    ln(`|------|--------|-------|`);
    for (const c of containers) {
      ln(`| ${c.name || 'N/A'} | ${c.status || 'N/A'} | ${truncate(c.image, 50)} |`);
    }
  } else {
    ln(`*No container data available.*`);
  }
  ln();

  // Error logs
  ln(`### Error Logs (24h)`);
  ln();
  const dashErrors = errorLogs.dashboard_api || errorLogs.dashboard || [];
  const collErrors = errorLogs.data_collector || errorLogs.collector || [];

  if (dashErrors.length === 0 && collErrors.length === 0) {
    ln(`*No errors detected.*`);
  } else {
    if (dashErrors.length > 0) {
      ln(`<details><summary>Dashboard API (${dashErrors.length} errors)</summary>`);
      ln();
      ln('```');
      for (const e of dashErrors) ln(String(e));
      ln('```');
      ln();
      ln(`</details>`);
      ln();
    }
    if (collErrors.length > 0) {
      ln(`<details><summary>Data Collector (${collErrors.length} errors)</summary>`);
      ln();
      ln('```');
      for (const e of collErrors) ln(String(e));
      ln('```');
      ln();
      ln(`</details>`);
      ln();
    }
  }

  // Resource Usage
  if (resourceUsage.length > 0) {
    ln(`### Resource Usage`);
    ln();
    ln(`| Container | CPU | Memory | Mem % | PIDs |`);
    ln(`|-----------|-----|--------|-------|------|`);
    for (const r of resourceUsage) {
      ln(`| ${r.name || 'N/A'} | ${r.cpu_pct || 'N/A'} | ${r.mem_usage || 'N/A'} | ${r.mem_pct || 'N/A'} | ${r.pids || 'N/A'} |`);
    }
    ln();
  }

  // Optimization
  ln(`## Optimization`);
  ln();
  if (optimizationRuns.length > 0) {
    ln(`### Recent Runs`);
    ln();
    ln(`| ID | Name | Status | Best Score | Iterations | Duration | Created |`);
    ln(`|----|------|--------|------------|------------|----------|---------|`);
    for (const r of optimizationRuns) {
      const dur = r.duration_seconds != null ? `${fmt(r.duration_seconds, 0)}s` : 'N/A';
      ln(`| ${r.id || 'N/A'} | ${truncate(r.name, 20)} | ${r.status || 'N/A'} | ${fmt(r.best_score, 4)} | ${fmt(r.iterations_completed, 0)} | ${dur} | ${fmtDateShort(r.created_at)} |`);
    }
    ln();
  } else {
    ln(`*No optimization runs found.*`);
    ln();
  }

  if (signalWeights.length > 0) {
    ln(`### Current Signal Weights`);
    ln();
    ln(`| Signal Type | Weight | Enabled | Min Confidence | Updated |`);
    ln(`|-------------|--------|---------|----------------|---------|`);
    for (const w of signalWeights) {
      ln(`| ${w.signal_type || 'N/A'} | ${fmt(w.weight, 4)} | ${w.is_enabled ? 'Yes' : 'No'} | ${fmt(w.min_confidence, 2)} | ${fmtDateShort(w.updated_at)} |`);
    }
    ln();
  }

  // Render optimization (if env var present)
  if (renderInfo || renderOptStatus) {
    ln(`### Render Optimization`);
    ln();
    if (renderOptStatus) {
      ln(`**Status**: ${renderOptStatus}`);
      ln();
    }
    if (renderInfo) {
      ln('```json');
      ln(JSON.stringify(renderInfo, null, 2));
      ln('```');
      ln();
    }
  }

  return lines.join('\n');
}

// ── Build email.html ────────────────────────────────────────────────────────

function buildEmailHtml() {
  const parts = [];
  const p = (s) => parts.push(s);

  p('<!DOCTYPE html>');
  p('<html><head><meta charset="utf-8"><style>');
  p('body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 16px; color: #24292e; }');
  p('h1 { font-size: 20px; border-bottom: 1px solid #e1e4e8; padding-bottom: 8px; }');
  p('h2 { font-size: 16px; margin-top: 24px; }');
  p('table { border-collapse: collapse; width: 100%; margin: 8px 0; }');
  p('th, td { border: 1px solid #e1e4e8; padding: 6px 10px; text-align: left; font-size: 13px; }');
  p('th { background: #f6f8fa; }');
  p('.alert-critical { color: #cb2431; font-weight: bold; }');
  p('.alert-warning { color: #b08800; font-weight: bold; }');
  p('.positive { color: #22863a; }');
  p('.negative { color: #cb2431; }');
  p('.footer { margin-top: 24px; font-size: 12px; color: #6a737d; border-top: 1px solid #e1e4e8; padding-top: 8px; }');
  p('</style></head><body>');

  p(`<h1>Polymarket Daily Review</h1>`);
  p(`<p style="font-size:12px;color:#6a737d;">${fmtDate(generatedAt)}</p>`);

  // Banner: trading-state context (avoids stale-counter confusion)
  if (tradingInactive) {
    p(`<div style="background:#fff5b1;border:1px solid #d9b400;border-radius:4px;padding:10px 12px;margin:8px 0 16px;font-size:13px;">`);
    p(`<strong>⚠️ TRADING INACTIVE</strong><br>0 trades in the last 24h, 0 open positions, 0 closed in 24h. All "24h" tables below will be empty by definition; cumulative metrics (consecutive losses, drawdown) are historical, not current.`);
    p(`</div>`);
  }

  // Alerts
  if (alerts.length > 0) {
    p('<h2>Alerts</h2><ul>');
    for (const a of alerts) {
      const cls = a.level === 'critical' ? 'alert-critical' : 'alert-warning';
      const icon = a.level === 'critical' ? '\u{1F534}' : '\u{1F7E1}';
      p(`<li class="${cls}">${icon} ${escapeHtml(a.message)}</li>`);
    }
    p('</ul>');
  }

  // Account
  p('<h2>Account</h2>');
  if (account) {
    const retClass = returnPct !== null && returnPct >= 0 ? 'positive' : 'negative';
    p('<table>');
    p(`<tr><td>Capital</td><td>${escapeHtml(fmtUsd(account.current_capital))}</td></tr>`);
    p(`<tr><td>Return</td><td class="${retClass}">${returnPct !== null ? escapeHtml(fmtPct(returnPct)) : 'N/A'}</td></tr>`);
    p(`<tr><td>Realized PnL</td><td>${escapeHtml(fmtUsd(account.total_realized_pnl))}</td></tr>`);
    p(`<tr><td>Unrealized PnL</td><td>${escapeHtml(fmtUsd(account.total_unrealized_pnl))}</td></tr>`);
    p(`<tr><td>Max Drawdown</td><td>${escapeHtml(fmtPctRaw(account.max_drawdown))}</td></tr>`);
    p(`<tr><td>Win Rate</td><td>${winRate !== null ? escapeHtml(fmtPct(winRate)) : 'N/A'}</td></tr>`);
    p('</table>');
  } else {
    p('<p><em>Account data unavailable.</em></p>');
  }

  // Real PnL Check
  if (realPnlCheck) {
    p('<h2>Real PnL (post-reset)</h2>');
    const hasInversions = realPnlCheck.inverted_count > 0;
    const realPct = realPnlCheck.reported_pnl !== 0
      ? ((realPnlCheck.real_pnl / realPnlCheck.reported_pnl) * 100).toFixed(1)
      : 'N/A';
    p('<table>');
    p(`<tr><td>Total Closed</td><td>${escapeHtml(fmt(realPnlCheck.total_closed, 0))}</td></tr>`);
    p(`<tr><td>Inverted</td><td${hasInversions ? ' class="negative"' : ''}>${escapeHtml(fmt(realPnlCheck.inverted_count, 0))}</td></tr>`);
    p(`<tr><td>Reported PnL</td><td>${escapeHtml(fmtUsd(realPnlCheck.reported_pnl))}</td></tr>`);
    p(`<tr><td><strong>Real PnL</strong></td><td><strong>${escapeHtml(fmtUsd(realPnlCheck.real_pnl))} (${escapeHtml(realPct)}%)</strong></td></tr>`);
    p(`<tr><td>Phantom PnL</td><td class="negative">${escapeHtml(fmtUsd(realPnlCheck.phantom_pnl))}</td></tr>`);
    p('</table>');
  }

  // Trades 24h
  p('<h2>Trades (24h)</h2>');
  if (tradesSummary) {
    p(`<p>${escapeHtml(fmt(tradesSummary.total_trades, 0))} trades | ${escapeHtml(fmtUsd(tradesSummary.total_value))} volume | ${escapeHtml(fmtUsd(tradesSummary.total_fees))} fees</p>`);
  } else {
    p('<p><em>No trade data.</em></p>');
  }

  // Performance breakdown — three independent sources kept visually separate.
  // Shadow is theoretical (no fees, no slippage) and was previously rendered
  // adjacent to live with no disclaimer; readers mistook the inflated SHORT
  // win rates for promotion candidates.
  if (tradesByType.length > 0 || shadowSummary.length > 0 || categoryPerformance.length > 0) {
    p('<h2>Performance Breakdown</h2>');

    p('<h3 style="font-size:14px;margin-top:16px;">Live — last 24h</h3>');
    if (tradesByType.length > 0) {
      p('<table>');
      p('<tr><th>Type</th><th>Trades</th><th>Win %</th><th>PnL</th></tr>');
      for (const t of tradesByType) {
        const pnl = Number(t.pnl_24h || 0);
        const cls = pnl >= 0 ? 'positive' : 'negative';
        p(`<tr><td>${escapeHtml(t.market_type || 'N/A')}</td><td>${escapeHtml(fmt(t.trades_24h, 0))}</td><td>${escapeHtml(fmtPctRaw(t.win_pct))}</td><td class="${cls}">${escapeHtml(fmtUsd(t.pnl_24h))}</td></tr>`);
      }
      p('</table>');
    } else {
      p('<p><em>No trades in the last 24h.</em></p>');
    }

    if (categoryPerformance.length > 0) {
      p('<h3 style="font-size:14px;margin-top:16px;">Live — cumulative since last reset</h3>');
      p('<table>');
      p('<tr><th>Type</th><th>Trades</th><th>Win Rate</th><th>Avg PnL</th><th>Sharpe</th></tr>');
      for (const c of categoryPerformance) {
        p(`<tr><td>${escapeHtml(c.market_type || 'N/A')}</td><td>${escapeHtml(fmt(c.n_trades, 0))}</td><td>${escapeHtml(fmtPct(c.win_rate))}</td><td>${escapeHtml(fmtUsd(c.avg_pnl))}</td><td>${escapeHtml(fmt(c.sharpe_ratio, 3))}</td></tr>`);
      }
      p('</table>');
    }

    if (shadowSummary.length > 0) {
      p('<h3 style="font-size:14px;margin-top:16px;">Shadow — last 30d <span style="font-weight:normal;color:#6a737d;font-size:12px;">(theoretical: no fees, no slippage)</span></h3>');
      p('<p style="font-size:12px;color:#6a737d;margin:4px 0 8px;">Resolution-price PnL. Prediction markets mostly resolve to NO, so SHORT win rate is structurally inflated — sampling artifact, not strategy edge. Apply the ≈0.33 empirical haircut before any promotion comparison.</p>');
      p('<table>');
      p('<tr><th>Type</th><th>Total</th><th>Resolved</th><th>Avg PnL</th></tr>');
      for (const s of shadowSummary) {
        p(`<tr><td>${escapeHtml(s.market_type || 'N/A')}</td><td>${escapeHtml(fmt(s.total, 0))}</td><td>${escapeHtml(fmt(s.resolved, 0))}</td><td>${escapeHtml(s.avg_pnl != null ? fmtUsd(s.avg_pnl) : 'N/A')}</td></tr>`);
      }
      p('</table>');
    }
  }

  // Open positions
  p(`<h2>Open Positions: ${openPositions.length}</h2>`);

  // Recently closed
  p('<h2>Recently Closed (24h)</h2>');
  if (recentlyClosed.length > 0) {
    const pnlClass = closedPnlTotal >= 0 ? 'positive' : 'negative';
    p(`<p>${recentlyClosed.length} positions closed | Total PnL: <span class="${pnlClass}">${escapeHtml(fmtUsd(closedPnlTotal))}</span></p>`);
  } else {
    p('<p><em>No positions closed.</em></p>');
  }

  // Footer
  p('<div class="footer">');
  p('<p>For the full report, see <a href="https://github.com/JaviMaligno/polymarket-trader/issues">GitHub Issues</a>.</p>');
  p('</div>');

  p('</body></html>');
  return parts.join('\n');
}

// ── Build slack.json (only if critical) ─────────────────────────────────────

function buildSlackPayload() {
  if (!hasCritical) return null;

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `\u{1F6A8} Polymarket Trading Alert`,
        emoji: true
      }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: criticalAlerts.map(a => `\u{1F534} *${a.message}*`).join('\n')
      }
    }
  ];

  if (warningAlerts.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: warningAlerts.map(a => `\u{1F7E1} ${a.message}`).join('\n')
      }
    });
  }

  // Account summary
  if (account) {
    blocks.push({
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Capital:* ${fmtUsd(account.current_capital)}` },
        { type: 'mrkdwn', text: `*Return:* ${returnPct !== null ? fmtPct(returnPct) : 'N/A'}` },
        { type: 'mrkdwn', text: `*Drawdown:* ${fmtPctRaw(account.max_drawdown)}` },
        { type: 'mrkdwn', text: `*Open Positions:* ${openPositions.length}` }
      ]
    });
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `<https://github.com/JaviMaligno/polymarket-trader/issues|View full report on GitHub>`
      }
    ]
  });

  const textFallback = criticalAlerts.map(a => a.message).join(' | ');
  return { text: `Polymarket Alert: ${textFallback}`, blocks };
}

// ── Write output files ──────────────────────────────────────────────────────

const outDir = process.cwd();

const reportMd = buildMarkdown();
fs.writeFileSync(path.join(outDir, 'report.md'), reportMd, 'utf8');

const emailHtml = buildEmailHtml();
fs.writeFileSync(path.join(outDir, 'email.html'), emailHtml, 'utf8');

const slackPayload = buildSlackPayload();
if (slackPayload) {
  fs.writeFileSync(path.join(outDir, 'slack.json'), JSON.stringify(slackPayload, null, 2), 'utf8');
}

// ── Stdout summary ──────────────────────────────────────────────────────────

const summary = {
  has_critical_alerts: hasCritical,
  alert_count: alerts.length,
  alerts: alerts.map(a => `[${a.level.toUpperCase()}] ${a.message}`)
};

console.log(JSON.stringify(summary));
