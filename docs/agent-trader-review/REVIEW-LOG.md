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

_Updated 2026-11-18 (seeded from the 2026-11-16 local review)._

- **Record:** 17 resolved, 10-7, P&L −$60.66, bankroll $939.34, verdict `too_few`. 0 open bets.
  0 bets placed since 2026-10-05.
- **Regime:** Sonnet 5.5 via OpenRouter + `search_mcp.py`, Mon + Thu 13:07 UTC. Depth floor
  (#354) works but only reaches the minimum (13 pages per run).
- **Funnel:** candidates die at "my p̂ ≈ price" (Run 28: 9/9 within 0.05 of price).
- **Forecast scoring (#356):** every decline `p_hat` scored against resolution vs market mid;
  pre-registered stop rule in `scripts/agent-trader/STOP-RULE.md`. State 2026-11-16: 9 forecasts,
  0 resolved, `collecting`. First look expected around January (many resolve 2026-12-31).
- **Agreed window:** November observation window ends **2026-11-30**. No threshold change before.

### ⏰ Pendientes

1. **Thu 2026-11-19 run:** log shows `=== forecast scoring`, and `forecast_outcomes.jsonl` does
   not break the commit.
2. **Search degradation:** Run 28 decoded `news_urls` 36/68 (53 %, Runs 26-27 at 100 %) and hit
   a search-backend 429 at the end (Russia-Ukraine 6947944 declined without sources). Watch the
   next runs; the warning fires below 50 %.
3. **Implicit bar tightening (#355):** the prompt moved from "~0.05 net edge" to "≥0.05 over
   `conservative_p_yes`" and the agent trims 0.02-0.05 systematically → effective bar ≈0.09 over
   p̂, while `RESEARCH-MONITORING.md` says the bar is still 5 %. Bring to the **2026-11-30**
   review as a decision for the operator; do not touch before.
4. **Bet rate:** count bets and searches per run over the 4 weeks to 2026-11-30 (Mon + Thu). If
   they do not rise, decide with the operator whether to widen the candidate list or relax the bar.
5. **`forecast_clusters.json`:** extend every review with the new `declines.jsonl` receipts
   (seeded with Iran and Taiwan; 4/9 of Run 28 were Iran).

## Histórico

### 2026-11-18 — log created

Seeded from the local project memory when the review moved to a cloud routine (Mon + Thu after
the betting run). Previous reviews: git history of `HYPOTHESIS-side-bias.md`,
`RESEARCH-MONITORING.md` and `rules.md`.
