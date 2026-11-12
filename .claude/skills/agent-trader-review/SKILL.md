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
found no cost-surviving edge: **Claude is the trading signal**. A GitHub Actions
cron (`agent-trader-weekly.yml`, currently Mon + Thu 13:07 UTC) runs a headless Claude that researches
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

Working dir: `scripts/agent-trader/`. Use the dependencies in `requirements.txt` (the harness
uses `requests`); no VM or DB is needed. The experiment uses Gamma/CLOB APIs + GitHub runners.
Read the current workflow, prompt and hypothesis observations: schedules, guards, model and
cohort boundaries below describe historical context and can change.

| File | Role |
|------|------|
| `agent_trader.py` | fetch candidates, `record_bet`, `evaluate` (resolve + pnl), `summary`, `email_html` |
| `metrics.py` | calibration, cost-aware P&L bootstrap CI, per-run snapshot |
| `bets.jsonl` | append-only track record (source of truth) |
| `lessons.md` | accumulated learning loop, one `## Run N — <date>` per run; the prompt currently asks for the last two runs |
| `rules.md` | operator-curated rules, read in full by the agent; keep below 18 KB |
| `metrics.jsonl` | cumulative snapshots keyed by date; multiple same-day runs may share a row |
| `HYPOTHESIS-side-bias.md` | operator-only pre-registration, regime changes and observations |
| `declines.jsonl` | deterministic quoted decline receipts, including conservative probability, fees, edge and reason |
| `research_runs.jsonl` | one research/accounting snapshot per run UUID, with GitHub provenance |
| `RESEARCH-MONITORING.md` | observation window, known historical gaps and next operator review |
| `agent-trader-prompt.md` | the decision prompt handed to headless Claude |
| `.github/workflows/agent-trader-weekly.yml` | the weekly cron |

Useful commands (run locally; they hit the free Gamma API):
```bash
cd scripts/agent-trader
python agent_trader.py summary      # record / open / resolved / bankroll / Brier
python agent_trader.py evaluate     # re-fetch open bets and WRITE updated resolutions/marks
python metrics.py --operator        # full metrics + the YES/NO split. ALWAYS use --operator
                                    # here; bare `metrics.py` is the agent-facing view and
                                    # deliberately omits the split (HYPOTHESIS-side-bias.md)
python agent_trader.py history --open   # price path of each open position's OWN market
```

`summary` and `metrics.py --operator` are local reads. `evaluate` and `history` may access
the network; run `evaluate` on a temporary snapshot for a review rather than silently changing
the checked-out track record. Do not pass a date to `metrics.py --operator`: that writes a snapshot.

### Tools, freshness and local work

- Prefer connected GitHub tools where they expose the required capability; otherwise use `gh`
  with `--repo JaviMaligno/polymarket-trader`. Bash examples below need native equivalents
  on PowerShell (`Select-String`, `$env:TEMP`, separate commands). Do not print tokens.
- Fetch origin before reviewing. If the checkout lags or has user work, inspect `origin/main`
  or export a temporary snapshot; do not require a pull, switch branches or overwrite local edits.
  Identify both the workflow's starting SHA and its published track-record commit.
- The matching Claude project memory may hold the previous review and pending follow-ups;
  read the latest relevant entries, without reviving unrelated retired quant work. Repeated
  reviews must not duplicate observation rows or rules.
- If Git reports dubious ownership, use command-scoped `-c safe.directory=<verified checkout>`
  rather than changing global trust. Check auth on authorization failure; do not change the
  user's active account for a read-only review.

`bets.jsonl` row: `side`, `my_prob_yes`, `entry_price` (what you pay crossing the spread),
`edge_per_contract` (THEORETICAL EV/contract net of spread at entry — NOT realized), `stake`,
`status` (open/won/lost), `resolved_outcome`, `pnl_net` (realized, net of spread).

**Cost-aware verdict bar** (same bar the quant program used, in `metrics.py`): `too_few` while
`n_resolved < 20`; `edge_shown` only when `mean_pnl_per_bet > 0` AND the bootstrap lower bound
`pnl_boot_lo > 0`; `positive_unproven` if positive but the CI straddles 0; else `no_edge`.

## Workflow

### Step 0 — Did the weekly run ACTUALLY run the LLM? (the silent-null-run gate, MANDATORY)

This is the single most important check and the reason this skill exists. The workflow has
historically tolerated command failures and committed conditionally, so **a total failure of the LLM can look
identical to a disciplined "0 bets" run** — a green check and a healthy-looking email. Never
trust the green check or the email. Verify the agent actually researched:

```bash
# 1. Find scheduled runs since the last review; distinguish dispatch, rehearsal and catch-up.
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
- **If the run commit changed ONLY `metrics.jsonl`** (no new `## Run` in lessons, no bets
  delta), suspect a silent null run. Corroborate with the log/transcript, `AGENT_OK` and any
  intentional skip before declaring that the LLM never ran. Evaluation may also change bets
  during a null run; a bets delta alone does not prove research occurred.

Remember `git fetch` first: the cron commits + pushes to `origin/main`, so local files can lag.
Read the fetched version or a temporary export, preserving the user's checkout. Recheck remote
freshness if another run finishes during the review.

### Step 1 — Track-record integrity

Confirm the source of truth is sane before drawing any conclusion from it:
- `bets.jsonl` parses (one JSON object per line), every `open` bet has `pnl_net: null` and every
  `won`/`lost` bet has a numeric `pnl_net` and a `resolved_outcome`.
- Verify the actual settlement formula against `resolve_pnl` and recorded `fee_paid`:
  won → `stake/entry − stake − fee_paid`; lost → `−stake − fee_paid`. Legacy rows without
  `fee_paid` use zero; do not retroactively apply today's fee schedule.
- `metrics.jsonl` is keyed by snapshot date, with monotonic `n_resolved`; the latest row's
  `bankroll = 1000 + cumulative pnl_net`. Reconcile dates with the run history. Unchanged
  totals are expected when no bets resolve, and same-day runs need not add a second row;
  missing expected snapshots require investigation, not an automatic null-run verdict.

### Step 2 — Resolved-bet post-mortem + carry-overs (⏰)

1. Run `python agent_trader.py evaluate` yourself if any open bet's `end_date` has passed — the
   cron only evaluates on its scheduled cadence, so a resolved bet may still show `open`.
   `evaluate` uses Gamma with no API key but writes the local record and depends on current
   API data. Evaluate a temporary snapshot first; report new settlements and any fetch failures.
2. For each newly-resolved bet: did the **thesis** win or the **risk** win? Cross-check against
   what `lessons.md` predicted (the agent records revised `p_hat` per run). A loss where the
   agent had already revised `p_hat` against itself (e.g. the Hormuz 40-ships AIS-only constraint)
   is *good calibration*, not a process failure — say so. A loss the agent never saw coming is the
   one to dig into.
3. Read the latest relevant ⏰ follow-ups in project memory: they can concern bets, research
   depth, guards or a prior change. Record CONFIRMED / REFUTED / PARTIAL with evidence. Update
   writable memory when available; otherwise report the carry-over explicitly. Do not reopen
   old items already closed by later entries or treat elapsed time as an operator decision.

### Step 3 — Calibration & cost-aware verdict

Run `python metrics.py --operator` and read, in order:
- **verdict**: while `too_few` (n<20) the headline question ("does the agent beat the spread?")
  is genuinely unanswerable — do not let a good or bad few-bet streak be spun either way. State
  the n explicitly.
- **calibration table**: when it says 60–80%, does ~70% actually happen? Miscalibration with the
  right sign of edge is fixable (sizing); good calibration with no edge means the markets are
  efficient against the agent's views. Both matter; report which.
- **by_confidence**: do `high`-confidence bets actually outperform `medium`? Report subgroup
  counts and uncertainty; a tiny subgroup cannot establish that confidence is useful or harmful.
- **bootstrap CI**: this is the cost-aware significance bar. `edge_shown` needs `pnl_boot_lo > 0`.
- **by side** (operator-only): the live test of the pre-registered hypothesis. Read it against
  `scripts/agent-trader/HYPOTHESIS-side-bias.md`, which fixes the decision rule in advance.
  Read the whole file, including later regime-change observations: filter by **placement**
  date and the currently applicable model/prompt regime, not merely resolution date. Its bar
  is 20 eligible resolved bets with n>=8 per side; do not pool contaminated or earlier regimes.
  **Do not restate the split as a finding** while the rule is unmet, and do not let a good or
  bad week on one side become a recommendation. Add one row to that file's *Observations*
  table each review (run date, new resolutions, per-side P&L on new bets only, blind intact).

  **Blind check, every review:** the agent must not have been told. Grep this run's
  `lessons.md` section for a side breakdown of its own record. If the agent has derived it,
  the blind is broken — record the date and treat later bets as contaminated. Also confirm the
  prompt still passes `tests/test_blindness_surfaces.py`.

  **The blind broke through a human, not the agent** (found 2026-10-03): the 2026-08-31
  review correction appended "NO 5-0, YES 3-6 … treat a YES bet as needing a higher bar" to
  `lessons.md`, and every run read it for a month. Rules for any correction YOU append to
  `lessons.md`: families, criteria, calibration and process are fine; the record split by
  side, or any side-specific rule, never. Grep the whole file, not just the new section:
  `grep -n -iE "side.?asymmetry|losses are YES|YES bets? (lose|lost)|higher bar than a NO" lessons.md`.
  That restart was historical; later observations can supersede it. Old matches are not a new
  leak if the current prompt excludes those sections. Check the full file for context and the
  actual agent-readable sections for exposure. Do not invent or reset a cohort during review.

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
- **Audit declines as well as bets.** When the agent says an edge is below the entry bar,
  recover the contemporaneous executable quote and fee schedule from its transcript. For
  YES use `ask`; for NO use `1 − bid`. Compare held-side probability with fee-adjusted entry
  using the harness formula; do not subtract the spread twice or use today's price to judge
  yesterday's decision. Separate a numerical threshold failure from an evidence/uncertainty
  veto, and require a stated conservative probability for the latter. Example: Run 27,
  6831495, `p_yes=0.40–0.45`, bid/ask `0.51/0.52`, no fee: NO costs `0.49`, giving a
  theoretical 0.06–0.11 edge. Its prose claim "below 0.05" needs an explicit uncertainty
  adjustment; it is not evidence that the bet would win or should be placed.
- **Concentration**: count how many open bets ride one real-world outcome. The agent's own rule is
  a concentration veto (≥2 correlated bets → decline new correlated ones) because correlated bets
  corrupt the calibration signal. Flag violations.
- **Discipline vs drought**: zero new bets is a valid, healthy outcome when nothing clears the bar
  — but ONLY if Step 0 confirmed the LLM actually ran and chose zero. Distinguish "researched and
  declined" from "never started".

### Step 4b — The guards that now run for you

These checks are automated; confirm they fired rather than redoing them by hand.

- **Decision audit and observation window.** Run `python decision_audit.py report` and
  read `RESEARCH-MONITORING.md`. Compare searches, successful fetches, self-reported
  candidates/sources, proposal attempts, independent reviews and accepted entries.
  The November window ends 2026-11-30; no threshold changes automatically. Historical
  unknown counts stay unknown. A repeated review must not duplicate snapshot rows.
  Inspect `declines.jsonl` for the current run (latest receipt per market), especially
  numerical threshold labels versus evidence/uncertainty vetoes. Compare coverage with
  the transcript: a complete accounting record does not prove deep or correct research.

- **Append-only on `lessons.md`** (`lessons_guard.py`, run in the workflow before the entry
  audit). A `::warning::` in the run log means the agent edited past history: the pre-run file
  was restored and the new sections kept. Read the commit diff and say what it tried to change
  — a typo is noise, a rewritten `p_hat` or a deleted post-mortem is a finding.
- **Quoted numbers.** `positions` now prints `if won` / `if lost` / `bankroll if won` /
  `bankroll if lost`, and `history` prints each market's own path under its id, question and
  creation date. Any projected P&L, bankroll or price path in `lessons.md` that does NOT match
  those outputs is the agent computing in prose again — check it, and flag it if it diverges.
- **TRUNCATED series.** If `history` warns, the first point is the left edge of the fidelity
  window, not an opening price. Any claim of the form "the market opened at X" built on a
  truncated window is wrong; re-fetch coarser (`history <id> <entry_date> 1440`).
- **Depth floor.** The run log's `research:` line carries `ok_fetches` (pages that came back
  with content), `passes` and `news_urls`. Below 12 pages the workflow resumes the same
  session (`::notice::Depth floor not met …`, up to 2 resumed passes); the extra research is
  appended under `### Continued research` in the run's own section. Report successful fetches per
  pass: if the resumed passes still add little, the next lever is per-candidate orchestration
  (the harness picks the candidates, one Claude call each). A `Resumed research pass ended
  in error` warning is not a null run: the first pass did its work.
  `ok_fetches` counts successful fetch calls, not necessarily distinct pages, independent
  sources or deeply researched candidates. Check the transcript's candidate coverage,
  criterion reads, source provenance and stated estimates as well as the count.
- **Google News decoder.** `news_search` decodes its links through Google's undocumented
  `batchexecute` endpoint (first 8 results per search, stops at the first HTTP error). A
  `news_search decoded only X of Y` warning means it broke or got blocked, and the agent is
  back to finding publisher URLs by hand. Report its effect on evidence quality and propose
  a fix; repairing code is a subsequent task, not automatic authorization from this review.

### Step 5 — Act

Present findings concisely (see rules). Local observation rows and evidence-backed rule
maintenance are part of the review; keep them minimal and idempotent. Keep operator-only
findings out of agent-readable files. Publishing, workflow fixes, paid research dispatches
and messages require the user's instruction; the review alone does not authorize them.
Typical subsequent actions when requested:
- Fix a workflow blind spot (e.g. make a null run visible — see the 2026-06-29 fix that surfaces
  the agent's exit status in the email subject + a `::warning::`).
- Trigger a manual run to recover a missed week: the Actions "Run workflow" button, or
  `gh workflow run agent-trader-weekly.yml` (needs JaviMaligno active — the harness injects a
  JavierSapiraAI `GH_TOKEN` that races the keyring; use the `env -u GH_TOKEN -u GITHUB_TOKEN`
  prefix or the UI button).
- Append a correction to `lessons.md` if a resolved bet exposed a process error the agent missed.
- **Fold rules into `rules.md`** (every review). The agent reads `rules.md` in full and only the
  last two runs of `lessons.md` (173 KB by 2026-11-02, too long to read whole: Run 23 read only
  the last 9 KB). Take each `**Proposed rules:**` line from the new run sections, and each rule
  in your own corrections: add it with its origin in brackets, or replace the rule it supersedes.
  A rule needs a resolved bet, a documented failure or an operator decision behind it. Keep the
  file under ~18 KB and never put the side split, or a side-specific rule, in it (same blind
  rule as `lessons.md`; `tests/test_blindness_surfaces.py` checks it).

## Critical rules

1. **NEVER create public GitHub issues or PRs from this analysis.** It is private. (Workflow fixes
   go through a normal branch + PR only when the user asks.)
2. **Green check ≠ healthy.** Always run Step 0. The `|| true` wrapping makes silent failures the
   default failure mode of this experiment.
3. **`git fetch` before reading the track record** — the cron pushes to origin; local lags.
4. **Theoretical ≠ realized.** `edge_per_contract` and `p_hat` are the agent's claims; only
   `pnl_net` and the calibration table are measured outcomes.
5. **`n < 20` means no verdict.** Don't over-read a tiny streak in either direction.
6. **Before an explicitly requested push**, verify the intended account and repo permissions;
   use JaviMaligno for this personal repo. A review does not authorize a push or global auth change.
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
