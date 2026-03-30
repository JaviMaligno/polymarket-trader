---
name: daily-autoreview-analysis
description: Use when the user asks to review the daily auto-review, says "lo de siempre", or wants to analyze the auto-review system quality on the polymarket-trader project. Triggers on "analisis", "auto-review", "autoreview", "daily review", "lo de siempre".
---

# Daily Auto-Review Analysis

## Overview

Private analysis of the auto-review system's daily output. Review the issue and PRs it created, evaluate quality, identify blind spots, and take action (merge, reject, investigate). This is a conversation between you and the user — NEVER create public GitHub issues.

## When to Use

- User says "lo de siempre", "analisis del autoreview", "review the daily review"
- User wants to evaluate today's auto-review output
- User asks about auto-review quality or system health

## When NOT to Use

- User asks you to create an issue (that's different work)
- User asks about system architecture or code (use codebase exploration)

## Workflow

### Step 1: Gather Data (parallel)

```bash
# All in parallel
gh issue list --label daily-review --limit 5 --state all
gh pr list --state all --author "app/github-actions" --limit 10
git log --oneline -20
```

### Step 2: Read Today's Issue

Read the latest daily-review issue. Note:
- What problems did it find?
- What severity did it assign?
- What SQL evidence did it provide?
- What PRs did it create?

### Step 3: Review Auto-Review PRs

For each PR created by the auto-review today:
- Read the diff
- Evaluate: correct fix? tests included? edge cases covered?
- Check CI status

### Step 4: Evaluate Quality

Present to user concisely (NOT as a GitHub issue):

**Issue quality** (2-3 sentences):
- Did it find real problems or false positives?
- Did it investigate root causes or just report symptoms?
- Did it correctly classify pre-reset artifacts?

**PR verdict** (per PR):
- Mergeable? Why/why not?
- Code quality, test coverage, boundary cases

**Blind spots** — things the auto-review missed:
- Persistent issues flagged across multiple reviews without fix
- Gradual degradation trends (compare with recent issues)
- Whether previous fixes actually worked

**Real PnL check** (mandatory):
Run this query to separate real from phantom PnL:
```sql
SELECT COUNT(*) AS total,
  COUNT(*) FILTER (WHERE ABS(avg_entry_price + current_price - 1.0) < 0.05
    AND EXTRACT(EPOCH FROM (closed_at - opened_at)) < 1800) AS inverted,
  ROUND(SUM(realized_pnl) FILTER (WHERE NOT (ABS(avg_entry_price + current_price - 1.0) < 0.05
    AND EXTRACT(EPOCH FROM (closed_at - opened_at)) < 1800))::numeric, 2) AS real_pnl
FROM paper_positions WHERE closed_at >= '<last_reset_date>' AND realized_pnl IS NOT NULL;
```
Report: "Real PnL: $X (Y% of reported $Z). Inverted positions: N."
If inverted > 0 after the price inversion fix (commit 6a2bdb6), the fix didn't work — escalate immediately.

**Recommended actions** — what to do now

### Step 5: Act

Execute whatever the user decides: merge PRs, investigate further, improve the prompt, etc.

### Step 6: Verify Deployment

After merging any PR, check if the changes reached the VM. The auto-review sometimes fails to deploy (SSH errors, Docker pull failures, etc.).

```bash
# Check what's running on VM vs what was merged
gcloud compute ssh polymarket-vm --zone=us-east1-b -- "docker compose -f /home/Usuario/polymarket-trader/docker-compose.gcp.yml ps"
gcloud compute ssh polymarket-vm --zone=us-east1-b -- "cd /home/Usuario/polymarket-trader && git log --oneline -3"
```

**If the VM is behind** (merged commit not present):
```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b -- "cd /home/Usuario/polymarket-trader && git pull && docker compose -f docker-compose.gcp.yml pull && docker compose -f docker-compose.gcp.yml up -d --remove-orphans"
```

Wait ~30s, then verify containers are healthy:
```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b -- "docker compose -f /home/Usuario/polymarket-trader/docker-compose.gcp.yml ps"
gcloud compute ssh polymarket-vm --zone=us-east1-b -- "docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}'"
```

**Only skip deployment if** the merged changes are code-only with no runtime effect (e.g., test fixes, docs).

## Critical Rules

1. **NEVER create public GitHub issues.** This analysis is private.
2. **Do the analysis, then present findings.** Don't ask the user what to analyze — you know the workflow.
3. **Be concise.** The user can read the issue themselves. Add value by evaluating quality, finding blind spots, and making merge decisions.
4. **Check git auth** before any push/merge: `gh auth status` → switch to `JaviMaligno` if needed.
5. **Use `rtk` prefix** for all commands per project CLAUDE.md.

## Quick Reference: Quality Criteria

| Dimension | Good | Bad |
|-----------|------|-----|
| Root cause | SQL evidence, code line refs | "likely", "may be", "suggests" |
| Severity | Context-aware, distinguishes resets from bugs | Everything is CRITICAL |
| PR quality | Tests, boundary cases, CI green | No tests, untested edge cases |
| Persistence tracking | References prior issues, tracks trends | Each review is isolated |
| Fix verification | Checks if yesterday's fix worked | Never looks back |

## Common Auto-Review Failure Patterns

- **Symptom patching**: Creates PR for symptom without finding root cause
- **Trending blind spot**: Doesn't compare metrics across consecutive reviews
- **Persistent issue slide**: Flags same P1 issue for days without escalating
- **No fix verification**: Never checks if merged PRs actually resolved the problem
- **Over-classification of pre-reset artifacts**: Spends issue space on known gaps
- **Phantom PnL blindness**: Reports headline PnL without checking for price inversions

## Historical Context: Price Inversion Bug

The system has had recurring phantom PnL from price inversions — buying a token at one price and "selling" using the complementary token's price (entry + exit ≈ 1.0). This produced 4 account resets. **Always verify real PnL with the inversion query.** If inverted positions appear post-fix, it's a regression — stop trading immediately.
