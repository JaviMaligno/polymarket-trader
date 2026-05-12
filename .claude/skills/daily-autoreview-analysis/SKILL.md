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
- **Patch vs root-cause depth** (MANDATORY for every PR): Does this fix the actual cause, or just make the symptom disappear? Ask:
  - What problem upstream had to fail for this symptom to surface? Is that problem addressed?
  - If this PR ships, does the same class of issue reappear in 1-7 days from a different angle?
  - Is there a "longer-term investigation needed" sentence in the PR body? → That's almost always the real work, deferred.
  - Is the fix an env var / threshold / allowlist tweak? → High prior for "patch". Flag and ask if the structural fix is tractable.
  - Explicitly classify each PR: `root-cause` / `containment` / `patch` — and call out parches sold as solutions.

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

**Shadow vs live gap check** (MANDATORY whenever the email/issue surfaces shadow PnL or the user asks about a market_type's profitability):

Shadow PnL is THEORETICAL — no fees, no slippage, computed at the resolution price. It systematically over-states profitability for SHORT direction in prediction markets, where most markets resolve to NO (so SHORT "wins" automatically at resolution price 0). A 100% win rate in `shadow_trades` for a SHORT direction is **not a signal of a profitable strategy** — it's a structural sampling artifact. Always run both queries side-by-side:

```sql
-- Live, by type and side
SELECT m.market_type, p.side, COUNT(*) n, ROUND(SUM(p.realized_pnl)::numeric,2) total_pnl,
       COUNT(*) FILTER (WHERE p.realized_pnl > 0) wins
FROM paper_positions p JOIN markets m ON m.id = p.market_id
WHERE p.closed_at >= (SELECT last_reset_at FROM paper_account ORDER BY id LIMIT 1)
  AND p.realized_pnl IS NOT NULL
GROUP BY m.market_type, p.side ORDER BY m.market_type, p.side;

-- Shadow, by type and direction (shadow_trades uses `direction`, not `side`)
SELECT market_type, direction, COUNT(*) n, ROUND(AVG(theoretical_pnl)::numeric,4) avg_pnl,
       COUNT(*) FILTER (WHERE theoretical_pnl > 0) wins
FROM shadow_trades WHERE resolved_at IS NOT NULL AND time >= NOW() - INTERVAL '30 days'
GROUP BY market_type, direction ORDER BY market_type, direction;
```

Report: live PnL/WR vs shadow PnL/WR side-by-side, per (type, side). Flag when:
- Shadow shows positive PnL while live shows negative for the same (type, side) → sampling artifact, not promotion candidate.
- Shadow win rate > 90% on n ≥ 30 → almost certainly the SHORT-resolves-NO bias; do NOT propose promotion.
- Live SHORT win rate stays < 20% across multiple types → cross-reference `project_short_asymmetry.md`. PRs #110/#111 are partial guardrails.

The empirical haircut for shadow → live (project_shadow_execution_realism.md) is currently 0.33 for `event_long` (n=16, small sample). Do NOT use shadow Sharpe directly to argue for promotion — apply the haircut and note it.

**Per-generator P2 cost-aware t-stat** (whenever proposing to enable, disable, or rebalance a (signal, market_type, direction) cell):

Gross t-stat from raw `generator_predictions` joined to 4h-forward `price_history` drift over-states edge because it ignores execution costs. For low-volatility cohorts (year-horizon binary markets, mid-priced event_financial) the drift is comparable to round-trip cost (~0.5%), so a +8 gross t-stat can be a near-zero or negative net t-stat. Empirically falsified 2026-05-12 (`mean_reversion crypto_intraday LONG`: gross t=+8 → live 0/7 WR).

Always run **both** versions side-by-side via `scripts/p2-tstat.js`:

```bash
# From VM (preferred — pg + DATABASE_URL are present in dashboard container):
docker cp /home/Usuario/polymarket-trader/scripts/p2-tstat.js polymarket-dashboard-api:/app/p2-tstat.js
docker exec polymarket-dashboard-api node /app/p2-tstat.js --window 7d --rtcost 0.005

# Flags:
#   --window {7d|3d|24h}   lookback (default 7d)
#   --rtcost 0.005         round-trip cost as fraction (default 0.005 = 0.5%)
#   --horizon 4h           forward price horizon (default 4h)
#   --minn 100             skip cohorts smaller than N (default 100)
```

The script outputs per-(signal, type, direction) gross_pct, net_pct, t_gross, t_net. **Decisions must use t_net, not t_gross.** Flag any cell with t_gross ≥ 2 but t_net ≤ 0 — that's a cohort where edge exists in theory but is consumed by friction. Captured as a principle in `feedback_realistic_costs.md`.

**Loss-streak forensic** (MANDATORY when consecutive losses ≥ 5 OR daily PnL < −$30 OR day-N win rate < 50% of historical baseline):

Do NOT accept the auto-review's narrative ("warm-up artifact", "post-deploy noise", "low signal confidence on first exposure") at face value. The auto-review is biased toward not creating reactive PRs, which can read as complacency when losses actually fit known dysfunctional patterns. Examine the streak yourself:

1. **Side breakdown**: How many of the losing positions are SHORT vs LONG? If SHORTs ≥ 60% of losses, cross-reference `project_short_asymmetry.md` — the historical 0% SHORT win rate isn't fully fixed; PRs #110/#111 are partial guardrails. Persistent SHORT losses = guardrails too loose.
2. **Same-market churn**: Are there ≥2 positions on the SAME market_id within minutes/hours, with opposite sides? That's signal disagreement that the consensus discount (`consensus_discount_floor`) failed to filter. Symptom of high raw confidence on disagreeing generators. Distinct from warm-up.
3. **Entry price geometry**: For SHORTs, plot the YES entry prices. PR #110 only allows SHORTs at `YES > 0.6`. If most losses are SHORTs at `YES > 0.7`, the gate threshold is the wrong place to filter. If most are at `YES ∈ [0.6, 0.7]`, raising the gate could help.
4. **Stop-loss vs signal-exit ratio**: Stop-losses on small-position OTM longs (e.g. entry < 0.20) are **not** warm-up — they're systematic over-confidence on tail bets. Count separately.
5. **Cross-reference with shadow_summary**: If the losing market_type has shadow Sharpe > 0 over 30d but live Sharpe is sharply negative this session, that's the spec's "regression flag" condition. Surface it.

Frame your output as: **what is observed (with numbers)** → **which historical pattern it matches** → **what the auto-review's narrative claims** → **where the narrative breaks down** → **recommended action: monitor X for Y hours, OR fix Z if pattern is unambiguous**.

The bar for action: if the pattern matches a known dysfunctional class with ≥3 instances, propose a concrete fix. If only 1-2 instances, document and monitor.

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
| PR quality | Tests, boundary cases, CI green, temporary containment labeled honestly | No tests, untested edge cases, symptom patch sold as root fix |
| Persistence tracking | References prior issues, tracks trends | Each review is isolated |
| Fix verification | Checks if yesterday's fix worked | Never looks back |

## Common Auto-Review Failure Patterns

- **Symptom patching**: Creates PR for symptom without finding root cause
- **Root-cause inversion**: Infra/control failure exists but the review prioritizes thresholds or tunables
- **Trending blind spot**: Doesn't compare metrics across consecutive reviews
- **Persistent issue slide**: Flags same P1 issue for days without escalating
- **No fix verification**: Never checks if merged PRs actually resolved the problem
- **Over-classification of pre-reset artifacts**: Spends issue space on known gaps
- **Phantom PnL blindness**: Reports headline PnL without checking for price inversions
- **Direct VM edits (deploy footgun)**: Edits `/home/Usuario/polymarket-trader/docker-compose.gcp.yml` directly on the VM instead of via PR + CI. This leaves uncommitted changes that make the next CI `git pull --ff-only` fail. Always check `git status` on VM as part of the analysis.

## Historical Context: Price Inversion Bug

The system has had recurring phantom PnL from price inversions — buying a token at one price and "selling" using the complementary token's price (entry + exit ≈ 1.0). This produced 4 account resets. **Always verify real PnL with the inversion query.** If inverted positions appear post-fix, it's a regression — stop trading immediately.
