# Agent-Trader review log

Operator-only memory of the `agent-trader-review` skill: what each review found, decided and
left pending (⏰). It lives outside `scripts/agent-trader/` on purpose: the betting agent's
tools are scoped to that directory and it must never read review findings (blind rule,
`HYPOTHESIS-side-bias.md`). Never paste the record split by side here either.

Every review — the cloud routine or a local session — reads **Estado actual** first, closes
or carries each ⏰ with evidence, rewrites **Estado actual** to the state that holds today,
and prepends one dated entry to **Histórico**. Keep entries short: numbers, run ids, commits,
decisions. Older detail lives in git history.

## Estado actual

_Updated 2026-11-19 (cloud routine, chained from run 44618693732 — Thu 2026-11-19, Run 29)._

- **Record:** 18 bets, 17 resolved, 10-7, P&L −$60.66, bankroll $939.34, verdict `too_few`
  (mean −$3.57/bet, CI [−12.54, +5.52]). **1 open:** Bet 18, NO on 6831495 (US x Iran
  Effective Ceasefire by Nov 22) at 0.670, $25, p̂ YES 0.20; if won +$12.31, if lost −$25.
  First bet since 2026-10-05 and first of the current regime.
- **Regime:** Sonnet 5.5 via OpenRouter + `search_mcp.py`, Mon + Thu 13:07 UTC (runs start
  ~21:00 UTC). Depth floor (#354) still needs the resumed pass (Run 29: 6 → 18 pages).
  The workflow now fires this routine at the end of each run (#358): worked on run 44618693732.
- **Funnel:** Run 29: 6 candidates, 5 declines (4 below threshold, 1 insufficient evidence),
  1 proposal, 1 review, 1 entry. Many publishers block the fetcher (Reuters, The Hill, USA Today,
  CNN 451, Economist): evidence is often headline-only.
- **Forecast scoring (#356):** 13 forecasts, 0 resolved, stories 0 (resolved), `collecting`.
  Clusters: Iran war, Taiwan local elections, Trump administration personnel. First resolutions:
  Taiwan (3 forecasts) ~2026-11-28. Binding constraint for the first look is 25 distinct stories.
- **Agreed window:** November observation window ends **2026-11-30**. No threshold change before.
- **Cloud network:** Gamma answers 200 from the routine (2026-11-19); `evaluate` and
  `forecast_score update` can run here again.

### ⏰ Pendientes

1. **Bet 18 (6831495):** the YES path needs a 14-day window with no US strike on Iranian land
   starting 2026-11-18..22; settles at the earliest ~2026-12-04 (14 days + 3 reporting days),
   later if strikes continue. Check with `evaluate` on a snapshot once Gamma shows it closed;
   post-mortem thesis vs risk (the agent's risk: Qatar/Oman mediation, Trump "not rushing").
2. **2026-11-30 decision (window close):** the review after the Mon 2026-11-30 run brings,
   with numbers: (a) implicit bar tightening (#355 — prompt says ≥0.05 over `conservative_p_yes`,
   agent trims 0.02-0.05 → effective ≈0.09 over p̂, while `RESEARCH-MONITORING.md` says 5 %);
   (b) bet rate — so far 1 bet in 7 runs since 2026-11-02 (Run 29: 16 searches);
   (c) whether to widen candidates or relax the bar. Operator decision; do not touch before.
3. **Taiwan forecasts (3580932, 3580995, 3581102)** resolve ~2026-11-28: first resolved
   forecasts. Run `forecast_score.py update` on a snapshot in the first review after that and
   check `forecast_outcomes.jsonl` is created and committed by the run.
4. **`forecast_clusters.json`:** extend every review with the new `declines.jsonl` receipts.
5. **Blocked publishers:** watch whether headline-only declines (`insufficient_evidence`) grow;
   if they dominate, the fix is a fetch fallback (restores intended research, inside Authority).

## Histórico

### 2026-11-19 — cloud routine, chained from run 44618693732 (Thu 2026-11-19, Run 29)

- Step 0: run 44618693732 (schedule, start SHA 2c05ee8, track-record commit e414359) ran the
  LLM: AGENT_OK=1, `## Run 29` + `### Continued research`, bets 17→18, 16 searches, 18 pages
  with content over 2 passes, decoder 123/123, lessons guard OK, decision audit complete.
- Integrity OK: 18 rows, settlement formula matches on all 17 resolved, Σpnl −$60.66 = metrics.
- Bet 18 checked: criterion re-read on Gamma (Qeshm is Iranian land; a strike on 11-17 restarts
  the window); price path 0.715 (11-17) → 0.335 (11-19) matches `history`. Theoretical edge
  +0.13 is a claim, not a result. No concentration issue (only open bet). Declines audited:
  numbers consistent with receipts; shutdown decline is an evidence veto with null estimate.
- ⏰ closed: forecast scoring in the run log — CONFIRMED (0 outcomes, so no file; commit fine).
  Search degradation — REFUTED for now (123/123, no 429 in the run log). Schedule lag —
  CLOSED by #358 (chained firing worked). Gamma blocked in cloud — CLOSED (200 now).
- Done: observation row (Run 29) in `HYPOTHESIS-side-bias.md`; clusters +6831495 (Iran) and
  +5784291/1811265/1796706 (Trump personnel). No proposed rules → `rules.md` untouched. No
  lessons correction (no resolutions). Suite 306 OK.
- Asked: nothing new; 11-30 decision pending as agreed.

### 2026-11-18 — cloud routine, Wednesday (no scheduled run)

- No run after #73 (2026-11-16, already reviewed); Wednesday has no cron. Nothing to Step 0.
- Record unchanged: 17 resolved, 10-7, −$60.66, 0 open. Forecasts 9/0 resolved, `collecting`.
  Suite 306 tests OK. No new declines → clusters, observation row and `rules.md` untouched.
- Found: scheduled runs start 8-10 h after 13:07 UTC (⏰6); Gamma blocked by the cloud proxy (⏰7).
- Asked: move the routine after ~02:00 UTC Tue/Fri; allow Polymarket hosts in the environment.

### 2026-11-18 — log created

Seeded from the local project memory when the review moved to a cloud routine (Mon + Thu after
the betting run). Previous reviews: git history of `HYPOTHESIS-side-bias.md`,
`RESEARCH-MONITORING.md` and `rules.md`.
