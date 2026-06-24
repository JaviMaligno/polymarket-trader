# Research Conclusions — what was tried, what happened

_Last updated: 2026-06-24._

This repo started as a quantitative paper-trading system for Polymarket and became a
multi-month **systematic search for a tradeable edge**. This document is the honest
scoreboard: every strategy family that was tried, its verdict, and why. **Short version:
no in-house quant or free-external signal survived realistic execution costs.** The live
work is now a single experiment — Claude as the trading decision-maker — and the old
quant infrastructure has been wound down.

## TL;DR

- **Goal:** find a strategy whose edge clears the bid-ask spread + fees, validated
  out-of-sample (bar: `t_net > 0`, bootstrap lower bound `> 0`, `n ≥ 200` effective).
- **Outcome:** **every quant lever failed at the cost gate.** The lag/mispricing often
  _existed_, but it lived in markets too illiquid (wide spreads) to capture, or in samples
  too small/correlated to confirm. The recurring killer was **realistic costs / effective-n**.
- **Now live:** an **LLM-as-trader experiment** (`scripts/agent-trader/`) — Claude researches
  markets and places hold-to-resolution paper bets weekly. It is the last open question.
- **Infra:** the GCP VM (data-collector + paper-trading + DB) is **stopped**; the quant
  review/research crons are **disabled**. Only the agent-trader weekly workflow runs.

## The scoreboard

Each family was built, tested with a cost-aware out-of-sample harness, and given a verdict.

| Strategy family | Idea | Verdict | Why |
|---|---|---|---|
| **Signal-weighted paper trading** | 11 generators (momentum, OFI, Hawkes, …) combined + optimized | **No edge** | Live win-rate near chance; no combination cleared cost. |
| **Favorite-longshot bias (FLB)** | Hold longshots to resolution (documented 3–8% bias) | **No edge at real cost** | The +3%/t=2.78 was a flat-cost artifact; at real spread, enterable edge ≈ 0. |
| **Market-making (H-MM)** | Earn the spread as maker | **FAIL (gate H-MM-4)** | With exact initial queue, retained tradeable spread collapses to ~+2 bps; bootstrap crosses 0. |
| **Supervised / horizon / ensemble / calibration** | ML prob vs price; optimal-hold; signal stacking | **No edge** | Brier ≈ 0.0635 (well-calibrated market); nothing net-positive after cost. |
| **Cross-venue / structural arbitrage** | Relative-value across venues / within negRisk sets | **Closed** | Kalshi US-only (blocked); same-venue netting forces Σ=1, no free arb. |
| **H-INE-4 conditional staleness** | Market A resolves → dependent market B lags | **No supply** | 0 clean primary→general pairs in the entire catalog (Polymarket doesn't list the second market). |
| **H-INE-POLL polling-anchored** | Poll-implied prob vs market price, political races | **Backtest NO-GO** | Only ~95 pollable races / structural ceiling 125 « 200 floor. Forward (Nov-2026 generals) untested; same cost gate looms. |
| **H-INE-3 news-event lag** | Market underreacts to a news burst; the move continues | **Lag exists, not capturable** | Repricing _is_ gradual (4%/43%/100% over 5m/1h/4h). But the +0.95%/burst flips to **−2.85% at real spread** (commodity longshots 7–19% spread). The one survivor (macro/Fed, +1.98%) was an artifact of one FOMC day across correlated markets. |

**The pattern:** the inefficiency was often real, but (a) the markets where it lived had
spreads larger than the edge, while the liquid markets were efficient; and (b) "wins" and
"losses" were frequently the same correlated event, so the effective independent sample
never reached significance. See `feedback_realistic_costs` — every metric must include
bid-ask + fees _before_ an allow/block decision.

## What's live now: the Agent-Trader experiment

After the quant program closed, the open question became: can **research-driven judgment**
(an LLM) find mispricings the mechanical signals couldn't? Code: `scripts/agent-trader/`.

- **Loop:** fetch liquid researchable Polymarket markets (free Gamma API) → research each
  one (web + reasoning) → place hold-to-resolution **paper** bets (hypothetical $1000, flat
  $25) only where the researched probability beats the price net of spread → evaluate as
  markets resolve → write `lessons.md` (loaded into the next run).
- **Automation:** `.github/workflows/agent-trader-weekly.yml` runs it weekly on GitHub
  runners (no VM needed). Track record: `scripts/agent-trader/bets.jsonl`.
- **Early read (Run 1–3, 2026-06-24):** liquid markets are efficient even vs the model's
  judgment (Fed = CME FedWatch exactly). Edge appears only in mid-priced, less-watched
  political/event markets where a specific current fact (a timeline, a status) is mispriced —
  e.g. a Romanian government-formation bet. First hard resolutions land 2026-06-30. Whether
  this beats the spread over a real sample is **still open**.

## Where to look

- **Edge-research harness + verdicts:** `scripts/edge-research/` (validators, registry, tests).
- **Agent-trader experiment:** `scripts/agent-trader/` (`agent_trader.py`, `bets.jsonl`, `lessons.md`).
- **Design docs / plans:** `docs/superpowers/specs/` and `docs/superpowers/plans/`.
- **The trading system itself** (now dormant): `packages/` (data-collector, dashboard, trader, …).

## Reviving the old stack (only on a regime change)

```bash
gcloud compute instances start polymarket-vm --zone=us-east1-b
# then uncomment the `schedule:` blocks in the disabled workflows and the
# `push:` trigger in deploy-gcp.yml, and redeploy.
```
