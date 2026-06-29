---
name: agent-trader-review
description: >-
  Private weekly review of the Agent-Trader experiment (the LLM-as-trader benchmark where
  Claude itself is the trading signal on Polymarket). Use whenever the user says "lo de
  siempre", "análisis del agente", "review del agent trader", "cómo va el agente", "revisa
  las apuestas", "analiza el autoreview", or asks how the weekly LLM-trader run went — even
  if they don't name the experiment. This is the CURRENT live experiment; the old quant
  stack (signals/optimizer/VM) is wound-down and its skill `daily-autoreview-analysis` is
  DEPRECATED. The job: verify the weekly cron actually ran the LLM (not a silent null run),
  check track-record integrity, post-mortem resolved bets, judge calibration + cost-aware
  edge, and question the agent's bet narratives. NEVER create public GitHub issues — this is
  a private conversation between you and the user.
---

# Agent-Trader Weekly Review

## Overview

The Agent-Trader experiment is the LAST lever after the whole quant edge-research program
found no cost-surviving edge: **Claude is the trading signal**. Each Monday a GitHub Actions
cron (`agent-trader-weekly.yml`, `Mon 13:07 UTC`) runs a headless Claude that researches
liquid Polymarket markets and places hold-to-resolution paper bets net of spread, then a
deterministic Python layer evaluates resolved bets and snapshots metrics. Track record lives
in `scripts/agent-trader/` and is committed each run.

Your job here is the same spirit as the old quant auto-review, retargeted: **evaluate the
quality and integrity of the weekly run, find blind spots, and decide what to act on.** The
output is a concise private report to the user — not a GitHub issue, not a PR.

## When to Use

- User says "lo de siempre", "análisis del agente / del autoreview", "review del agent trader".
- User wants to know how the weekly LLM-trader run went, or whether bets resolved.
- User wants to verify the ⏰ carry-overs in memory (open bets approaching resolution).
- Any time you want to confirm the experiment is healthy (the cron ran the LLM, track record intact).

## When NOT to Use

- Anything about the old quant stack (signals, optimizer, SignalEngine, VM paper trading) — that
  is wound-down; if the user genuinely revives it, use the deprecated `daily-autoreview-analysis`.
- User asks to create a public issue (different work; never do it here).

## The harness (orientation)

Working dir: `scripts/agent-trader/`. All commands are pure-stdlib Python (run them directly;
no VM, no DB — the experiment runs on free Gamma API + GitHub runners).

| File | Role |
|------|------|
| `agent_trader.py` | fetch candidates, `record_bet`, `evaluate` (resolve + pnl), `summary`, `email_html` |
| `metrics.py` | calibration, cost-aware P&L bootstrap CI, per-run snapshot |
| `bets.jsonl` | append-only track record (source of truth) |
| `lessons.md` | accumulated learning loop, one `## Run N — <date>` per run; fed into each decision prompt |
| `metrics.jsonl` | trajectory: one cumulative-metrics snapshot per run |
| `agent-trader-prompt.md` | the decision prompt handed to headless Claude |
| `.github/workflows/agent-trader-weekly.yml` | the weekly cron |

Useful commands (run locally; they hit the free Gamma API):
```bash
cd scripts/agent-trader
python agent_trader.py summary      # record / open / resolved / bankroll / Brier
python agent_trader.py evaluate     # re-fetch open bets, resolve + compute pnl_net, then summary
python metrics.py                   # full metrics: calibration, cost-aware verdict, by-confidence
```

`bets.jsonl` row: `side`, `my_prob_yes`, `entry_price` (what you pay crossing the spread),
`edge_per_contract` (THEORETICAL EV/contract net of spread at entry — NOT realized), `stake`,
`status` (open/won/lost), `resolved_outcome`, `pnl_net` (realized, net of spread).

**Cost-aware verdict bar** (same bar the quant program used, in `metrics.py`): `too_few` while
`n_resolved < 20`; `edge_shown` only when `mean_pnl_per_bet > 0` AND the bootstrap lower bound
`pnl_boot_lo > 0`; `positive_unproven` if positive but the CI straddles 0; else `no_edge`.

## Workflow

### Step 0 — Did the weekly run ACTUALLY run the LLM? (the silent-null-run gate, MANDATORY)

This is the single most important check and the reason this skill exists. The workflow wraps
every command in `|| true` and commits conditionally, so **a total failure of the LLM looks
identical to a disciplined "0 bets" run** — a green check and a healthy-looking email. Never
trust the green check or the email. Verify the agent actually researched:

```bash
# 1. Find the latest weekly run and confirm it's THIS Monday's cron.
env -u GH_TOKEN -u GITHUB_TOKEN gh run list --workflow=agent-trader-weekly.yml \
  --limit 5 --json databaseId,createdAt,conclusion,headSha

# 2. Pull the run log and look for the failure signature, even on a "success" run.
env -u GH_TOKEN -u GITHUB_TOKEN gh run view <id> --log > /tmp/at-run.log 2>&1
grep -iE "API Error|usage limit|rate limit|Execute error|error: |took too long|timed out" /tmp/at-run.log
```

The real-world failure seen 2026-06-29: `API Error: 400 You have reached your specified API
usage limits. You will regain access on 2026-07-01` — the Anthropic key hit its spend cap, the
agent never ran, the run still reported SUCCESS.

**Corroborate with the commit fingerprint** (the agent always writes `lessons.md` when it runs):
```bash
git fetch origin && git show origin/main:scripts/agent-trader/lessons.md | grep -c "^## Run"
git log --oneline -3 -- scripts/agent-trader/   # find the weekly commit
git show <weekly-commit> --stat                 # what files did it touch?
```
- A healthy run touches `lessons.md` (a new `## Run N — <date>`) and usually `metrics.jsonl`;
  often `bets.jsonl` too.
- **If the weekly commit changed ONLY `metrics.jsonl`** (no new `## Run` in lessons, no bets
  delta) → the LLM did not run. That is a **silent null run** — this week produced zero research,
  zero thesis updates. Make it the lead finding.

Remember `git fetch` first: the cron commits + pushes to `origin/main`, so your local is
usually one commit behind. Reconcile (`git pull --ff-only`) before reading files as current.

### Step 1 — Track-record integrity

Confirm the source of truth is sane before drawing any conclusion from it:
- `bets.jsonl` parses (one JSON object per line), every `open` bet has `pnl_net: null` and every
  `won`/`lost` bet has a numeric `pnl_net` and a `resolved_outcome`.
- `pnl_net` sign matches `status` (won → positive `stake/entry − stake`; lost → `−stake`).
- `metrics.jsonl` has one new row per run (monotonic in `n_resolved`); the latest row's
  `bankroll = 1000 + cumulative pnl_net`. A frozen `metrics.jsonl` across two runs is itself a
  null-run symptom (see Step 0).

### Step 2 — Resolved-bet post-mortem + carry-overs (⏰)

1. Run `python agent_trader.py evaluate` yourself if any open bet's `end_date` has passed — the
   cron only evaluates on its weekly cadence, so a bet that resolved mid-week may still show
   `open` until the next Monday. `evaluate` is deterministic (Gamma re-fetch, no API key), so
   it is safe to run anytime.
2. For each newly-resolved bet: did the **thesis** win or the **risk** win? Cross-check against
   what `lessons.md` predicted (the agent records revised `p_hat` per run). A loss where the
   agent had already revised `p_hat` against itself (e.g. the Hormuz 40-ships AIS-only constraint)
   is *good calibration*, not a process failure — say so. A loss the agent never saw coming is the
   one to dig into.
3. Resolve every ⏰ pending item in memory (grep the memory dir for `⏰`): each names an open bet
   with a resolution date. Record CONFIRMED / REFUTED / PARTIAL with the `pnl_net` evidence, then
   update the ⏰ item (mark done, or replace with the next carry-over).

### Step 3 — Calibration & cost-aware verdict

Run `python metrics.py` and read, in order:
- **verdict**: while `too_few` (n<20) the headline question ("does the agent beat the spread?")
  is genuinely unanswerable — do not let a good or bad few-bet streak be spun either way. State
  the n explicitly.
- **calibration table**: when it says 60–80%, does ~70% actually happen? Miscalibration with the
  right sign of edge is fixable (sizing); good calibration with no edge means the markets are
  efficient against the agent's views. Both matter; report which.
- **by_confidence**: do `high`-confidence bets actually outperform `medium`? If not, the agent's
  confidence signal is noise and conviction-sizing would destroy value.
- **bootstrap CI**: this is the cost-aware significance bar. `edge_shown` needs `pnl_boot_lo > 0`.

### Step 4 — Bet-quality / narrative review (question every substantive claim)

The agent tells stories in `lessons.md` ("market mispriced the SPEED", "near-certain win",
"efficient = CME"). For each substantive open-bet claim, formulate the alternative hypothesis
and check it — a claim with no verifying step is a narrative, not a finding. Specifically:
- **Re-read the resolution criterion** for any bet whose thesis hinges on it (the agent's biggest
  process wins and misses both came from the exact criterion — Portwatch AIS-only, "permanent"
  peace vs ceasefire). Fetch `requests.get(GAMMA/<id>).json()["description"]` and confirm.
- **`edge_per_contract` is theoretical**, computed at entry from the agent's own `p_hat`. It is
  NOT evidence of edge — only resolved `pnl_net` is. Never report `edge_per_contract` as if it
  were realized profit. (This is the agent-trader analogue of the quant skill's shadow-vs-live and
  gross-vs-net-t-stat traps: a model-implied number is not a measured one.)
- **Concentration**: count how many open bets ride one real-world outcome. The agent's own rule is
  a concentration veto (≥2 correlated bets → decline new correlated ones) because correlated bets
  corrupt the calibration signal. Flag violations.
- **Discipline vs drought**: zero new bets is a valid, healthy outcome when nothing clears the bar
  — but ONLY if Step 0 confirmed the LLM actually ran and chose zero. Distinguish "researched and
  declined" from "never started".

### Step 5 — Act

Present findings concisely (see rules). Then do what the user decides. Typical actions:
- Fix a workflow blind spot (e.g. make a null run visible — see the 2026-06-29 fix that surfaces
  the agent's exit status in the email subject + a `::warning::`).
- Trigger a manual run to recover a missed week: the Actions "Run workflow" button, or
  `gh workflow run agent-trader-weekly.yml` (needs JaviMaligno active — the harness injects a
  JavierSapiraAI `GH_TOKEN` that races the keyring; use the `env -u GH_TOKEN -u GITHUB_TOKEN`
  prefix or the UI button).
- Append a correction to `lessons.md` if a resolved bet exposed a process error the agent missed.

## Critical rules

1. **NEVER create public GitHub issues or PRs from this analysis.** It is private. (Workflow fixes
   go through a normal branch + PR only when the user asks.)
2. **Green check ≠ healthy.** Always run Step 0. The `|| true` wrapping makes silent failures the
   default failure mode of this experiment.
3. **`git fetch` before reading the track record** — the cron pushes to origin; local lags.
4. **Theoretical ≠ realized.** `edge_per_contract` and `p_hat` are the agent's claims; only
   `pnl_net` and the calibration table are measured outcomes.
5. **`n < 20` means no verdict.** Don't over-read a tiny streak in either direction.
6. **Check git auth before any push:** `gh auth status` → `gh auth switch --user JaviMaligno`.
7. **Be concise.** Add value by judging quality and finding blind spots, not by restating the email.

## Common failure patterns (this experiment specifically)

- **Silent null run**: API spend cap / timeout kills the headless agent; `|| true` + conditional
  commit + `always()` email make it look like a disciplined healthy run. The tell: weekly commit
  touched only `metrics.jsonl`; no new `## Run` in `lessons.md`. (2026-06-29.)
- **Theoretical-edge-as-result**: reporting `edge_per_contract` sums as if they were profit.
- **Resolution-criterion misread**: betting the casual reading of the question (AIS vs all transits,
  "peace" vs permanent treaty) — the agent's richest seam of both edge and error.
- **Correlated-bet stacking**: multiple open bets on one outcome inflating apparent diversification.
- **Mid-week resolution lag**: a bet resolves between Mondays; `summary` shows it `open` until the
  next cron. Run `evaluate` yourself rather than reporting it as unresolved.
