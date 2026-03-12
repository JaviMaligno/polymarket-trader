# Phase C: Daily Review Auto-Fix PRs — Design

## Overview

Extend the daily review workflow so Claude not only analyzes trading data and creates an issue, but also implements fixes as PRs, deploys them to the VM for verification, and rolls back.

## Flow

```
Daily Review Workflow (8:00 UTC)
│
├─ 1. Gather data (SSH → VM → psql) → review-data.json
├─ 2. Claude analyzes → creates Issue with findings
├─ 3. For each actionable fix (max 5 per run):
│   ├─ a. Create branch fix/daily-review-YYYY-MM-DD-<slug>
│   ├─ b. Implement the fix
│   ├─ c. Commit + push + create PR (linked to issue)
│   ├─ d. Deploy branch to VM (docker compose pull + up)
│   ├─ e. Generic checks (health, containers, memory)
│   ├─ f. Problem-specific check (ad-hoc, Claude decides)
│   ├─ g. Document result in PR body
│   └─ h. Rollback → redeploy main on VM
├─ 4. Comment on Issue with PR summary table
└─ 5. Email (summary + PR links) + Slack (critical only)
```

## PR Structure

**Branch:** `fix/daily-review-YYYY-MM-DD-<slug>`

**PR body:**
```markdown
## Root Cause
What was found and why it happens

## Changes
What changed and why

## VM Verification
- ✅/❌ Containers healthy
- ✅/❌ API responding
- ✅/❌ Memory <85%
- ✅/❌ [Problem-specific check]

Tested on VM at HH:MM UTC, rolled back to main.

Related to #<issue-number>
```

**Issue comment at end:**
```markdown
## PRs Created
| PR | Problem | VM Verified |
|----|---------|-------------|
| #12 | Accounting bug | ✅ Capital reconciled |
| #13 | Position stacking | ❌ Need more signal data |
```

## Deploy/Verify/Rollback on VM

```bash
# Deploy PR branch
SSH: cd /opt/polymarket-trader && git fetch && git checkout <branch>
SSH: docker compose -f docker-compose.gcp.yml pull
SSH: docker compose -f docker-compose.gcp.yml up -d

# Wait + verify (2-3 min max)
# Generic: docker compose ps, /api/health, docker stats
# Specific: Claude writes ad-hoc check based on what was fixed

# Always rollback to main
SSH: git checkout main
SSH: docker compose -f docker-compose.gcp.yml pull
SSH: docker compose -f docker-compose.gcp.yml up -d
```

## Safety & Limits

- **Max 5 PRs per run.** Remaining fixes documented in issue as "pending next review"
- **VM always returns to main** after each PR verification
- **Timeout: 60 minutes** for the full workflow job
- **Max turns: 100** for Claude Code CLI
- **Prohibited actions** (in prompt):
  - No destructive DB operations (DROP, DELETE without WHERE)
  - No changing credentials/secrets
  - No modifying the daily review workflow itself
  - No force push to main

## Files Changed

- `.github/workflows/daily-trade-review-claude.yml` — permissions, timeout, max-turns
- `scripts/daily-review-prompt.md` — add Phase C instructions

No new files needed.
