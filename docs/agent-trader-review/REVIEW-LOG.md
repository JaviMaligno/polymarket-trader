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

_Updated 2026-11-26 (cloud routine, chained from run 45903641285 — Thursday 2026-11-26 cron, Run 31)._

- **Record:** 19 bets, 17 resolved, 10-7, P&L −$60.66, bankroll $939.34, verdict `too_few`
  (mean −$3.57/bet, CI [−12.54, +5.52]). **2 open ($50):**
  - Bet 18, NO on 6831495 (US x Iran Effective Ceasefire by Nov 22) at 0.670, p̂ YES 0.20;
    if won +$12.31, if lost −$25. Gamma 11-26: closed=False, YES 0.615. No US strike on
    Iranian soil reported since 11-17 (agent, Run 31): heading to a loss.
  - Bet 19, NO on 678416 (Avengers: Doomsday top domestic calendar gross 2026) at 0.880,
    fee 0.07, p̂ YES 0.02; if won +$3.20, if lost −$25.21. Ends 2027-01-08. Criterion re-read
    on Gamma: Box Office Mojo calendar gross, only 2026 dates count (Doomsday opens 12-18).
    Spider-Man: Brand New Day ≈$923M domestic by 09-08 (Gulf News, independent of the
    agent's Collider source), so the thesis holds on two sources.
- **Regime:** Sonnet 5.5 via OpenRouter + `search_mcp.py`, Mon + Thu 13:07 UTC (runs start
  ~22:00-01:00 UTC). Depth floor still needs the resumed pass every run; Run 31's first pass
  was the thinnest yet (4 pages, only the open position) and the resume did all candidate work.
- **Funnel:** Run 31: 7 in coverage (6 candidates + the open position), 5 declines (2 below
  threshold, 2 insufficient evidence, 1 below threshold with unreliable data), 1 proposal,
  1 bet. Runs since 11-02: 9, bets 2.
- **Forecast scoring (#356):** 18 forecasts, 1 resolved, 1 story, `collecting`. Clusters:
  Iran war (incl. Netanyahu), Taiwan elections, Trump personnel, Nvidia/Huang, Spain
  election, Russia-Ukraine. Ornn B200 (7277636) is a singleton.
- **Agreed window:** November observation window ends **2026-11-30**. No threshold change before.
- **Cloud network:** Gamma 200 from the routine (2026-11-26).

### ⏰ Pendientes

1. **Bet 18 (6831495):** if no US strike on Iranian land, the 14-day window that began on
   11-18 completes ~12-01 → settles YES (a loss) ~12-04. Check with `evaluate` on a snapshot
   once Gamma shows closed; post-mortem thesis vs risk (the agent already flagged the
   weakening in Runs 30-31, so a loss would be seen-coming, not a blind miss).
2. **2026-11-30 decision (window close):** the review after the Mon 2026-11-30 run (probably
   starts 12-01 UTC) brings, with numbers: (a) the implicit bar tightening (#355: ≥0.05 over
   `conservative_p_yes`, effective ≈0.09 over p̂, while `RESEARCH-MONITORING.md` says 5 %);
   (b) bet rate, 2 bets in 9 runs; (c) widen candidates vs relax the bar vs move to
   forecast-only scoring; (d) first-pass depth (7, 7, 6, 9, 4 pages): the resume carries the
   research. Operator decision; nothing is touched before then.
3. **Taiwan forecasts (3580932, 3580994, 3580995, 3581102, 3581389, 3581449, 3581450,
   814612):** the election is 11-28. The first review after it runs `forecast_score.py update`
   on a snapshot and checks the run committed the outcomes. This is the first chance to pass
   1 resolved story.
4. **`forecast_clusters.json`:** extend every review with the new `declines.jsonl` receipts.
5. **Open position in coverage:** Run 31 listed 6831495 (held, not a candidate) in its
   coverage packet without a receipt, which alone made `audit_complete=False` and put
   "DECISION AUDIT INCOMPLETE" in the run email subject. Agent misclassification, not a
   harness bug (prompt: coverage = candidates researched). If it repeats, exclude markets
   with an open bet at run start from `unlogged` in `decision_audit.snapshot` (a report fix,
   inside Authority).
6. **Proposed rule from Run 31** (calendar-year/domestic scope for "top grossing" markets):
   not folded — no resolved bet behind it yet. Fold when Bet 19 resolves, or earlier if the
   operator wants it.
7. **Insufficient-evidence declines:** 2/5 in Run 31 (Taichung, Kaohsiung: no polls; Zaobao
   blocked was one of them). Below the 50 % trigger; keep watching.

## Histórico

### 2026-11-26 — cloud routine, chained from run 45903641285 (Thu 2026-11-26 cron, Run 31)

- Step 0: run 45903641285 (schedule, start SHA 4e84003, track-record commit ad802ad, started
  22:15 UTC) ran the LLM: AGENT_OK=1, `## Run 31` + `### Continued research`, bets 18→19,
  11 searches, 14 pages with content over 2 passes (4 before the resume), decoder 88/88,
  lessons guard OK. Warning: `Decision audit incomplete` — sole cause the open position
  6831495 in coverage without a receipt (⏰5). First pass researched no candidates and said so.
- Integrity OK: 19 rows, 17 resolved unchanged, Σpnl −$60.66 = metrics; Bet 19 fee 0.21 =
  25×0.07×(1−0.88). Quoted numbers (+3.20/−25.21, +12.31/−25, marks 0.385/0.878) match
  `positions`. `evaluate` on a snapshot: no new settlements.
- Bet 19 checked: criterion re-read on Gamma (domestic calendar gross, 2026 dates only);
  Spider-Man ≈$923M by 09-08 corroborated by Gulf News; theoretical edge +0.093 is a claim,
  not a result; payoff asymmetry +3.20 vs −25.21. No concentration (Iran vs box office).
  Declines audited against receipts: numbers consistent; Taichung/Kaohsiung are evidence
  vetoes with null estimates. No injected instructions found in the run text.
- ⏰ closed: none due (Bet 18 not closed on Gamma; Taiwan votes 11-28). Insufficient
  evidence: 2/5, below trigger.
- Done: observation row (Run 31); clusters +3580994/3581389/3581450 (Taiwan). Proposed rule
  not folded (no resolution behind it). No lessons correction. Suite 306 OK.
- Asked: nothing new; the 11-30 decision is still pending as agreed.

### 2026-11-24 — cloud routine, chained from run 45299556904 (Mon 2026-11-23 cron, Run 30)

- Step 0: run 45299556904 (schedule, start SHA 8debece, track-record commit f5dbfc4, started
  00:44 UTC on 11-24) ran the LLM: AGENT_OK=1, `## Run 30` + `### Continued research`, 16 searches,
  16 pages with content over 2 passes (9 before the resume), decoder 120/120, lessons guard OK,
  decision audit complete. No warnings other than the Node 20 deprecation.
- Integrity OK: 18 rows, settlement formula matches on all 17 resolved, Σpnl −$60.66 = metrics.
  The only change to bets.jsonl is the Bet 18 mark (0.46). Quoted numbers (+12.31/−25,
  bankroll 951.65/914.34, history 0.46) match.
- Declines audited against receipts: the numbers are consistent. Sindarov (raw +0.058) was an
  explicit uncertainty veto with a stated conservative p (0.78). Nvidia NO raw −0.004. The
  Anthropic decline cites "my own developer": a self-imposed conflict veto, not an instruction,
  and harmless. No injected instructions found in the run text.
- First resolved forecast: 6998285 YES (Huang), agent Brier 0.846 vs market 0.807.
- ⏰ closed: none (Bet 18 not yet resolved; Taiwan on 11-28). Blocked publishers: PARTIAL
  (5/10 insufficient evidence, 1 caused by blocking).
- Done: observation row (Run 30); clusters +567688 (Iran), +814612/3581449 (Taiwan),
  +6998285/676739 (Nvidia-Huang), +5336560/5336561 (Spain), +6947944/2243897 (Russia-Ukraine).
  No proposed rules → `rules.md` untouched. No lessons correction (no resolutions). Suite 306 OK.
- Asked: nothing new; the 11-30 decision is still pending as agreed.

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
