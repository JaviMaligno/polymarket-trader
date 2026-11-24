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

_Updated 2026-11-24 (cloud routine, chained from run 45299556904 — Monday 2026-11-23 cron, Run 30)._

- **Record:** 18 bets, 17 resolved, 10-7, P&L −$60.66, bankroll $939.34, verdict `too_few`
  (mean −$3.57/bet, CI [−12.54, +5.52]). **1 open:** Bet 18, NO on 6831495 (US x Iran
  Effective Ceasefire by Nov 22) at 0.670, $25, p̂ YES 0.20; if won +$12.31, if lost −$25.
  Gamma 2026-11-24: closed=False, YES 0.46 (was 0.335 at entry). Thesis weakened: no US
  strike reported since 11-17 (agent's own reading, Run 30).
- **Regime:** Sonnet 5.5 via OpenRouter + `search_mcp.py`, Mon + Thu 13:07 UTC. The Monday
  11-23 run did not start until 00:44 UTC on the 24th (11.6 h late), so its rows are dated 11-24.
  The depth floor still needs the resumed pass (Run 30: 9 → 16 pages). Chained firing worked again.
- **Funnel:** Run 30: 10 candidates, 10 declines (5 below threshold, 5 insufficient evidence),
  0 proposals. Runs since 11-02: 8, bets 1. Insufficient-evidence declines went from 1/6 (Run 29)
  to 5/10. Only Spain was clearly caused by blocked publishers (5 outlets would not open); the
  others lacked data (no Kaohsiung poll, no seat model, TIME only has odds, Anthropic has no
  post-listing basis).
- **Forecast scoring (#356):** 16 forecasts, 1 resolved (6998285 Huang rejoins Nvidia → YES;
  agent p̂ 0.08 vs mid 0.10, both wrong; it was declined, so no money was lost), 1 story,
  `collecting`. Clusters: Iran war (incl. Netanyahu), Taiwan elections, Trump personnel,
  Nvidia/Huang, Spain election, Russia-Ukraine.
- **Agreed window:** November observation window ends **2026-11-30**. No threshold change before.
- **Cloud network:** Gamma 200 from the routine (2026-11-24).

### ⏰ Pendientes

1. **Bet 18 (6831495):** if no US strike on Iranian land, the 14-day window that began on
   11-18 completes ~12-01 → settles YES (a loss) ~12-04. A strike before then keeps NO alive.
   Check with `evaluate` on a snapshot once Gamma shows closed; post-mortem thesis vs risk.
2. **2026-11-30 decision (window close):** the review after the Mon 2026-11-30 run (it will
   probably start on 12-01 UTC) brings, with numbers: (a) the implicit bar tightening (#355:
   ≥0.05 over `conservative_p_yes`, so effective ≈0.09 over p̂, while
   `RESEARCH-MONITORING.md` says 5 %); (b) bet rate, so far 1 bet in 8 runs; (c) widen
   candidates vs relax the bar vs move to forecast-only scoring. Operator decision; nothing is
   touched before then.
3. **Taiwan forecasts (3580932, 3580995, 3581102, 814612, 3581449):** the election is 11-28.
   The first review after it runs `forecast_score.py update` on a snapshot and checks the run
   committed the outcomes.
4. **`forecast_clusters.json`:** extend every review with the new `declines.jsonl` receipts.
5. **Insufficient-evidence declines:** 5/10 in Run 30, but only 1 caused by blocking. If they
   stay ≥50 % and blocking is the cause, propose a fetch fallback (it restores intended
   research, so it is inside Authority).

## Histórico

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
