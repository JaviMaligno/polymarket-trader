#!/usr/bin/env node
// analyze-review.js — Calls Claude (Sonnet 4.6) to analyze daily review data.
// Usage: node scripts/analyze-review.js <review-data.json>
// Outputs:
//   report.md       — Full GitHub issue body (Claude narrative)
//   email.html      — Short HTML summary
//   slack.json      — Slack Block Kit payload (only if critical)
//   alerts.json     — Structured alerts: [{severity, message, reason}]
// Prints JSON to stdout: {has_critical_alerts, alert_count}

'use strict';

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk').default;

const inputPath = process.argv[2] || '/dev/stdin';
let rawData;
try {
  rawData = fs.readFileSync(inputPath, 'utf8');
} catch (err) {
  console.error(`Error reading input: ${err.message}`);
  process.exit(1);
}

// Load format template as guidance
let formatTemplate = '';
try {
  const templatePath = path.join(__dirname, 'format-review.js');
  formatTemplate = fs.readFileSync(templatePath, 'utf8');
} catch {
  // Non-fatal — Claude will use defaults
}

const SYSTEM_PROMPT = `You are a trading system monitor for an automated prediction market trading bot.
Your job is to analyze daily review data and produce structured outputs.

THRESHOLD GUIDANCE (use as reference, not hard rules — apply judgment based on context):
- drawdown > 10%: typically critical
- 5+ consecutive losses: typically warning
- no price data for 1h: typically critical (unless market is quiet)
- container down: always critical
- daily PnL < -$200: critical
- high memory > 85%: warning
- 0 signals generated: INFO only if markets are correctly filtered (e.g. all in 50/50 range, or no active markets); WARNING/CRITICAL if due to engine error
- markets filtered by 50/50 rule: expected behavior, mention but do NOT flag as alert
- CPU spikes: warning if sustained (>10min), info if brief (<2min, likely vacuum/maintenance)

IMPORTANT: Distinguish expected behavior from actual problems. The system has many safety filters — markets being filtered is correct behavior.

OUTPUTS REQUIRED (write each to a file):

1. report.md — Full GitHub-flavored markdown issue body. Include:
   - Summary section (3-5 bullets with key metrics)
   - Detailed sections for: account status, signals, trades, risk, infrastructure
   - Alert section if any warnings/critical items
   - Use clear emoji status indicators: ✅ OK, ⚠️ Warning, 🔴 Critical

2. email.html — Short HTML email (3-5 bullet points, plain styling, no external CSS)

3. slack.json — Slack Block Kit JSON payload. ONLY include if there are critical alerts.
   Format: {"blocks": [{"type": "section", "text": {"type": "mrkdwn", "text": "..."}}]}

4. alerts.json — Structured alert array:
   [{"severity": "critical"|"warning"|"info", "message": "...", "reason": "..."}]
   Only include items that genuinely warrant attention. Empty array [] is fine.

Respond with a JSON object:
{
  "report_md": "...",
  "email_html": "...",
  "slack_json": null or {...},
  "alerts": [...]
}`;

async function main() {
  const client = new Anthropic();

  let parsed;
  try {
    parsed = JSON.parse(rawData);
  } catch {
    parsed = { raw: rawData };
  }

  const userMessage = `Analyze this daily trading review data and produce the required outputs.

Raw review data:
\`\`\`json
${JSON.stringify(parsed, null, 2).substring(0, 80000)}
\`\`\`

${formatTemplate ? `\nFormat reference (existing template):\n\`\`\`javascript\n${formatTemplate.substring(0, 5000)}\n\`\`\`` : ''}

Write the analysis. Return valid JSON with report_md, email_html, slack_json, and alerts fields.`;

  let response;
  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const content = message.content[0];
    if (content.type !== 'text') throw new Error('Unexpected response type');

    // Extract JSON from response (may be wrapped in markdown code block)
    let jsonText = content.text.trim();
    const jsonMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonText = jsonMatch[1].trim();

    response = JSON.parse(jsonText);
  } catch (err) {
    console.error(`Claude API error: ${err.message}`);
    // Fallback: write minimal outputs so the workflow doesn't fail
    fs.writeFileSync('report.md', `# Daily Review\n\nClaude analysis failed: ${err.message}\n\nRaw data attached to workflow artifacts.`);
    fs.writeFileSync('email.html', `<p>Claude analysis failed: ${err.message}</p>`);
    fs.writeFileSync('alerts.json', '[]');
    console.log(JSON.stringify({ has_critical_alerts: false, alert_count: 0 }));
    process.exit(0);
  }

  // Write output files
  fs.writeFileSync('report.md', response.report_md || '# Daily Review\n\nNo report generated.');
  fs.writeFileSync('email.html', response.email_html || '<p>No email summary generated.</p>');

  const alerts = Array.isArray(response.alerts) ? response.alerts : [];
  fs.writeFileSync('alerts.json', JSON.stringify(alerts, null, 2));

  const hasCritical = alerts.some(a => a.severity === 'critical');
  if (hasCritical && response.slack_json) {
    fs.writeFileSync('slack.json', JSON.stringify(response.slack_json, null, 2));
  }

  const summary = {
    has_critical_alerts: hasCritical,
    alert_count: alerts.length,
  };
  console.log(JSON.stringify(summary));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
