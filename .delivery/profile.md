## vcs
- host: GitHub JaviMaligno/polymarket-trader
- integration-branch: main
- production-branch: main
- required-approvals: none enforced on this personal repository; inspect effective rules before merging
Source: GitHub branch API and branch rules API; protected=false and no rules · checked 2026-11-12

## environments
- production-env: published-paper-runner [invariant]
- published-paper-runner: GitHub Actions agent-trader-weekly.yml on main; paper only
- test-env: offline-fixtures
- offline-fixtures: isolated worktree and GitHub PR runner at the exact tested SHA; no provider calls, bets, email or main writes
Source: .github/workflows/agent-trader-weekly.yml; scripts/agent-trader/tests · checked 2026-11-12

## deploy
- kind: GitHub Actions scheduled paper experiment
- via: pipeline
- served-sha-check: PR CI head SHA before merge; origin/main merge SHA after promotion
Source: agent-trader-weekly.yml; no serving application in this task · checked 2026-11-12

## tracker
- kind: none
Source: user request in conversation; private experiment review · checked 2026-11-12

## reviewers
- 1-independent: fresh Codex subagent, plan and full-diff review · weight blocking · on both
Source: available collaboration tool; delivery phase 3 requires an independent plan audit · checked 2026-11-12

## ci
- kind: GitHub Actions
- on-draft: lightweight source checks only
- on-ready: offline Agent-Trader unittest suite; ready_for_review event required
- on-merge: scheduled paper runner uses main; do not dispatch research for this task
Source: security-pr.yml and agent-trader-weekly.yml · checked 2026-11-12
