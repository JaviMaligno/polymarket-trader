# FLB Hold-to-Resolution Executor — Pre-build Design

**Date**: 2026-05-20
**Status**: Design — **DO NOT BUILD YET**. Decision gate is the forward shadow verdict (~2026-07-15: 60d after `flb_shadow_signals` start on 2026-05-19, n≥100 resolved).
**Related**: `project_flb_strategy_design.md` (proven result + open questions), `project_session_2026-05-19_wrap.md` (Sprint 2 pivot), PR #249 (forward shadow recorder).

## Context

The favorite-longshot-bias hold-to-resolution backtest produced the only proven edge in the system as of 2026-05-19:

| metric | value |
|---|---|
| n (band 0.02–0.10) | 1,015 |
| net / trade | +2.24% |
| t_net | 3.49 |
| win rate | 96.3% |
| hold: median / mean / p95 | 6.2d / 8.6d / 24.6d |

In-sample period spans only ~25 days (2026-04-19 → 05-14). Historical OOS is impossible (Polymarket CLOB serves at most ~40d of price history). Forward validation is therefore the only verdict path — `flb-shadow-snapshot.yml` runs daily, records every market entering the qualifying band, and scores each signal on resolution.

> **⚠️ Censored-hold caveat (added 2026-05-22).** The `6.2d median hold` above — and the `≈+131% annualised` ceiling it produced — is a **data-censoring artifact**. The backtest only saw markets that resolved *inside* its ~25-day window, and the CLOB API serves only ~40d of price path, so entries were truncated to short holds (in-sample `p95 hold 24.6d ≈ the window span itself` — the signature of the truncation). Live `flb_shadow_signals` (2026-05-22) shows the **uncensored** expected hold is **median 164–222 days** per cohort. The per-trade edge (+2.24%, monotonic calibration) may survive, but **annualised capital efficiency is ~25–35× worse than the headline**: +2.24% over ~6 months with capital locked and a −100% tail is low-single-digit annualised, not +131%. This makes the **TTR ceiling (OQ#7) and the cohort/hold segmentation of the verdict (below) load-bearing**, not optional. The short-hold subset that produced the headline cannot be re-derived in-sample (long holds are censored) — only forward data answers the long-hold economics.

This doc specifies the **live executor** that follows if forward shadow confirms. It does NOT specify forward measurement (already built).

## Decision gate (read first)

Build IFF the verdict criteria below hold **on the tradeable cohort** (`crypto_daily` +
`event_financial` + `event_short` — the live-eligible types per decision #5), NOT on the
pooled sample:

- tradeable-cohort `resolved` count ≥ 100.
- Net-of-entry-cost avg PnL ≥ +1.0% per trade.
- `t = avg_net / (sd / √n)` ≥ 2 with the same sign as the in-sample reference (+2.24%).
- Bootstrapped t (on net_pnl) confirms — the parametric t over-states confidence on a −100%-tailed distribution.
- **Annualised return after the realised hold** (not the censored 6.2d) clears a hurdle to
  be set once OQ#7 is answered — a +2.24%/trade edge held ~6 months is not, by itself,
  worth the −100% tail and the capital lockup.

> **⚠️ Timeline correction (2026-05-22).** The original "by 2026-07-15" target is
> **unreachable on the tradeable cohort**. Live `flb_shadow_signals` composition: 92% is
> `event_long` (1,922 of 2,085) — which is **shadow-only by policy and never traded live**.
> The tradeable cohort is only 163 signals, of which ≤44 resolve before 2026-07-15. By
> `end_date` month, cumulative tradeable resolutions don't reach ~100 until **~Dec 2026 /
> Jan 2027**. So:
> - **2026-07-15 gate** can only be an **`event_long` forward read** (its in-sample t=2.60
>   was the strongest type) — scientifically useful, but a verdict about markets the executor
>   won't trade. Do NOT let a healthy *pooled* number greenlight a build (same false-confidence
>   trap as the shadow `event_short`/WTI-Oil misattribution in the daily-review skill).
> - **Tradeable-cohort verdict** realistically lands **~Dec 2026**.
> - If `event_long` forward-confirms strongly, that is a reason to revisit its shadow-only
>   status for FLB specifically (the execution-realism haircut that justified shadow-only was
>   set for the 4h-trading paradigm; FLB settles at par with no spread-crossing exit — see
>   Out of scope note). That re-scope is its own analysis, not an automatic promotion.

> **⚠️ event_long promotion analysis (2026-05-23).** Done. **Verdict: NO promotion now.** The
> structural haircut argument is sound — the 0.33 live/shadow ratio was a 4h-trading artefact
> (entry+exit spreads, stop-loss, timing) and FLB hold-to-resolution erases 3 of the 4 factors;
> the entry cost is already captured by Lever 1. But that argument is necessary, not sufficient.
> The decisive finding is **promoting does not accelerate the verdict** — markets must
> physically resolve, and the shadow recorder already captures the same outcome at zero capital
> risk. So promotion swaps "wait" for "expose," not "wait" for "learn." Combined with bond-like
> annualised return (+1.69%/trade × 365/167d ≈ **+3.7%/yr per position**) against a −100% tail,
> this is not an attractive trade. Wait for Lever 2 to verdict on the event_long shadow at
> ~mid-July 2026 (n_pooled ≥ 100 reachable at current ~1.75/day forward resolution rate).
> Promote only if Lever 2 = HOLDING **and** OQ#7 has a partial answer (forward resolutions
> across ≥ 3 entry-TTR buckets — estimate ~2026-09). Full analysis: see memories
> `project_flb_event_long_promotion_2026-05-23.md` and
> `project_flb_oq_preliminary_answers_2026-05-23.md`. The latter shows OQ#3/#4/#6 now have
> preliminary in-sample answers (1/4 Kelly ≈ $20/position, 10% total exposure, 50-position
> per-week cap) — so they no longer block the promotion gate, only OQ#7 does.

If any criterion fails: do not build. Re-evaluate the edge thesis or kill the track. The exact decision query lives at the bottom of this doc under "Verdict query".

## Pre-registered early-failure kill criteria

The verdict gate above is the *confirmation* test (~Dec 2026 on tradeable cohort). The
criteria below are *falsification* tests — pre-registered checks that can kill the strategy
**weeks earlier** without waiting for resolutions to accumulate. Added 2026-05-23 in response
to "feedback as early as possible". Each has a script that can be cron'd or run on demand.

The discipline matters: pre-registering the kill thresholds avoids the post-hoc rationalisation
trap ("well, it failed but actually the threshold should have been …"). If any of these
fires, the track is dead. No re-litigation.

### Lever 1 — Cost-realism

**Script**: `scripts/flb-cost-realism-check.js` (built 2026-05-23).

**What it tests**: whether the in-sample backtest's 0.54% entry-cost assumption holds against
the forward distribution of live bid-ask spreads. Recomputes per-market_type net/trade at
the p25/p50/p75/p95 percentiles of the forward effective entry cost
`(entry_spread / 2) / (1 − entry_yes_price)`.

**Run cadence**: on demand. The forward sample of spreads is already large (n=2,086) — no
need for time-series build-up.

**Kill rules** (pooled tradeable cohort, fired):
- `cost_p50 ≥ in_sample_gross` → DEAD. Median forward signal is uneconomic.
- `cost_p75 ≥ in_sample_gross` → MARGINAL. ≥25% of forward signals are uneconomic; a
  mandatory spread filter at entry becomes load-bearing, not optional.

**Current state (2026-05-23)**: tradeable cohort verdict **MARGINAL** (gross +2.79%,
cost_p50 = 2.00%, net@p50 = +0.80%, net@p75 = −1.40%). Strategy NOT killed but
[design decision #4 (spread filter)](#settled) is confirmed as load-bearing — without it,
≥25% of signals lose money. event_financial is the worst offender (cost_p50 = 2.24% vs
gross +4.26%). event_long forward (n=1,922) is also MARGINAL at p75. Crypto_daily and
event_short remain comfortably ALIVE.

### Lever 2 — Calibration monotonicity

**Script**: `scripts/flb-calibration-monitor.js` (built 2026-05-23).

**What it tests**: whether the forward resolved signals reproduce the in-sample monotonic
calibration gap — gap shifts from ≈−1.9% (bin 0.02-0.04) to ≈−2.9% (bin 0.08-0.10) as
the longshot becomes a "less-deep" longshot. Monotonicity is the structural signature of
the favorite-longshot bias; if it breaks, the regime is gone.

**Run cadence**: daily after `flb-shadow-snapshot.yml` posts new resolutions.

**Kill rules** (verdict on the pooled forward sample, n_pooled_resolved ≥ 100, with
≥ 3 bins each containing ≥ 10 resolutions):
- All bins have `gap ≥ −0.5%` → `BROKEN_NO_BIAS`. The bias has disappeared.
- Slope of `gap` vs bin midpoint is positive → `BROKEN_SLOPE_REVERSED`. Higher-priced
  longshots resolve YES MORE often than lower-priced ones — the inverse of the bias.
- Otherwise → `HOLDING`. Continue.

Below the n thresholds the verdict is `INSUFFICIENT`; no action either way.

**Earliest fire date**: depends on resolution flow. event_long is currently 92% of
signals and provides 245 resolutions in 30d / 503 in 60d (see forward-flow table in
[[project_per_direction_weights_gap]] discussion). Pooled `n ≥ 100` is reachable
**~mid-June 2026** if event_long inflow continues. This is **3-7 months earlier**
than the tradeable-cohort net/trade verdict gate.

**Current state (2026-05-23)**: n_resolved = 7 (all event_long). Verdict `INSUFFICIENT`.

### Lever 3 — Forward PnL t-stat (deep-negative falsification)

**Script**: not yet a dedicated script — derivable from `flb_shadow_signals` directly
(the snapshot script's Step 3 report). Will be wrapped into the daily monitor in a
follow-up.

**What it tests**: a one-sided floor on the forward per-trade PnL. The full confirmation
gate requires n ≥ 100 with t ≥ 2; this falsification version is the symmetric one-sided
counterpart for early kill.

**Kill rule**: at n ≥ 30 pooled, if `avg_net < −2.0%` **and** `t < −2.0`. Bayesianally
weak as confirmation but adequate as a falsification stop — a strategy that loses 2%
per trade with two standard deviations of confidence at n=30 is not going to recover
to +2.24% at n=100.

**Earliest fire date**: ~end of June 2026 (n=30 reachable from event_long inflow plus
early tradeable resolutions).

**Current state**: n_resolved = 7. Below threshold.

### Decision matrix summary

| Lever | Test | Pre-registered kill | Earliest fire | Today's state |
|---|---|---|---|---|
| 1 | Cost-realism | cost_p50 ≥ gross | NOW (already measurable) | MARGINAL (not killed) |
| 2 | Calibration monotonicity | slope > 0 or all gaps ≥ −0.5% (n_pooled ≥ 100) | ~mid-June 2026 | INSUFFICIENT (n=7) |
| 3 | Forward PnL floor | net < −2% AND t < −2 (n ≥ 30) | ~end-June 2026 | INSUFFICIENT (n=7) |
| Confirmation gate | tradeable net ≥ +1%, t ≥ 2 (n ≥ 100) | ~Dec 2026 / Jan 2027 | far below n |

**Operator note**: if any of Levers 1-3 fires, halt the design work immediately. Do not
proceed to build until either (a) a clean re-test passes after a stated parameter change
(e.g. tighter spread filter), or (b) the FLB track is officially closed.

## Design Decisions

### Settled

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Trade direction | SHORT the longshot (buy NO) when YES ∈ [0.02, 0.10] | Backtest evidence + favorite-longshot literature. Favorite side is empirically dead (t=−0.19). |
| 2 | Entry timing | First bar at which the market qualifies, with TTR-to-end_date ≥ 48h | Backtest with `--ttr-anchor end_date` gives n=927, t=3.88 — ex-ante gate works. |
| 3 | Exit rule | Hold to resolution. No time exit, no stop-loss. | The edge IS the holding-to-resolution. Time exit (the 4h-trading paradigm) destroys it. Stop-loss before resolution is structurally wrong on a 96%-win, −100%-tail distribution. |
| 4 | Spread filter (mandatory) | Skip markets whose live CLOB entry cost > 1.0% OR book is one-sided/empty | 14% of tail-band markets are un-enterable (no book); without the filter the wide-spread tail destroys edge. With the filter the edge holds at net ≈ +2.24%. |
| 5 | Eligible market types | All currently-allowed live types: `crypto_daily`, `event_financial`, `event_short` | Backtest shows the bias is present across event_financial (t=2.06), event_long (t=2.60), event_short (t=1.70). event_long stays shadow-only by existing system policy. |
| 6 | Accounting model | Capital-lockup. Capital committed at open is unavailable until resolution. | Holding period 6–25 days violates the rotating-capital assumption of `PaperTradingService`. Needs explicit lock tracking. |
| 7 | Integration boundary | New service `FLBExecutor` parallel to `AutoSignalExecutor` | Different signal source (a daily scan, not a 60s tick), different exit semantics, different accounting. Mixing them entangles two strategy classes. |
| 8 | Deployment posture | Phase 1: dry-run alongside shadow recorder (logs intent, no fills). Phase 2: live with cap on total locked capital. | Pre-build forward shadow is the only OOS. Phase 1 confirms the executor's plumbing matches the recorder. Phase 2 starts small. |

### Open questions — preliminary answers + remaining blocks

> **⚠️ Re-classification 2026-05-23.** The original "single-cluster" framing was too strict. The in-sample dataset has **5 calendar weeks** (not 1), so heteroskedasticity can be measured. The forward `flb_shadow_signals` end_date distribution already exposes cluster sizes. Three of the four OQs have preliminary in-sample answers; only OQ#7 remains genuinely blocked. Full numbers in memory `project_flb_oq_preliminary_answers_2026-05-23.md`.

| # | Open question | Status (2026-05-23) | Preliminary number / when refines |
|---|---|---|---|
| OQ#3 | Correlation structure of outcomes | **PRELIMINARY** | In-sample wipeout rate by week: 2.2%–6.7% across 5 weeks (worst ≈ 1.8× pooled mean of 3.74%). Election-regime weeks unmeasured; forward refines. |
| OQ#4 | Sizing for ruin-avoidance | **PRELIMINARY ANSWER** | Bernoulli Kelly = 41.3% total. **1/4 Kelly recommended**: 10.3% total exposure, ≈$20 per position on $9,751 (50 concurrent target). 1/8 Kelly is the floor if forward weeks show realized rate > 10%. |
| OQ#6 | Resolution-week concentration cap | **PRELIMINARY ANSWER** | Falls out of OQ#3 + OQ#4: 50 positions OR 10% capital resolving in any one ISO week (whichever binds first). Worst forward cluster identified: 2026-11-02 with 294 unresolved event_long signals. |
| OQ#7 | TTR ceiling / capital efficiency | **STILL BLOCKED** | In-sample is uniformly censored: even entries with ≥90d TTR observed avg realized hold ≤21d (window was 25 days). Forward resolutions across ≥3 entry-TTR buckets, each n≥30. Estimate: ~2026-09. |

The preliminary sizing numbers are **inputs** when the executor is built, with two caveats:
- The 6.7% in-sample worst week is a single observation. Election-correlated weeks could be materially worse. Treat 1/4 Kelly as the upper sizing; 1/8 Kelly as the conservative floor until forward weekly realized rate has ≥ 3 weeks of n ≥ 30.
- Per-position cap assumes ~50 concurrent positions for diversification; with fewer positions, scale per-position size up proportionally.

Do not pretend OQ#7 is answered. It alone now blocks the executor's TTR-ceiling decision — a structural strategy parameter.

## Architecture

### Services and data flow

```
[Daily cron, 06:00 UTC]
        │
        ▼
[FLBScanner]  ─────── reads markets + price_history + CLOB /book
        │            (already exists as scripts/flb-shadow-snapshot.js
        │             — PROMOTE to a packages/dashboard service)
        ▼
[FLBExecutor]  ─────── per qualifying signal:
        │              - check spread (live CLOB /book)
        │              - check correlation cap (OQ#6)
        │              - check sizing (OQ#4)
        │              - open SHORT YES (buy NO) on Polymarket
        ▼
[FLBPositionStore] ─── new table `flb_positions` (separate from paper_positions)
        │              - opened_at, market_id, entry_yes_price, no_size_bought, fee_paid
        │              - resolved_at, outcome, gross_pnl, net_pnl
        │              - reconciles to paper_account.locked_capital
        ▼
[FLBReconciler] ────── daily cron, 02:00 UTC:
                       - check each open position's market for is_resolved
                       - if resolved: settle, mark closed, release locked_capital
                       - if NOT resolved but past expected end_date+24h: alert
```

### Why a separate position store

`paper_positions` is built around: many open positions, rotating capital, short hold (≤4h via `MAX_HOLD_TIME_HOURS`), stop-loss + take-profit. Every existing service assumes those. Shoehorning a 6.2-day-median hold with no exits into `paper_positions` would:

- Break time-exit assumptions in `PositionClosingService`, `RiskManager`, `StopLossService`.
- Conflate two different capital-accounting models in `paper_account.current_capital`.
- Make rollback impossible without surgery.

A separate `flb_positions` table + `flb_locked_capital` accounting column on `paper_account` keeps the two strategy classes orthogonal.

### Why not just keep using `flb_shadow_signals`?

`flb_shadow_signals` is **theoretical**: no fees, no slippage, computed on the resolution price. The live executor needs real entry execution (CLOB order placement), real fee accounting, and reconciliation when a market resolves unexpectedly (e.g., voided, extended). The shadow recorder is the validator; the executor is a parallel system that consumes its output but doesn't share its accounting.

### Bypass of existing gates

The 4h-trading gate chain (`AutoSignalExecutor.canExecute()` gates 0a → 0f) is wrong for FLB:

- `0b near-resolved PRICE (0.03/0.97)` — would block all FLB entries (band is 0.02–0.10).
- `0c near-resolution TIME (24h)` — irrelevant; FLB enters at TTR ≥ 48h by design.
- `0d market_type gate` — would still apply, but FLB's universe is a subset.
- `0e EventOTMGate` — overlapping concern; FLB targets exactly the markets this gates against, but for a different reason (FLB monetises the inefficiency the gate documents).
- `0f direction blocklist` — would block `event_financial:long`/`short` etc. FLB is SHORT only on the tail-band; the blocklist's logic doesn't transfer.

`FLBExecutor` reimplements its own minimal gate chain:

```
flb_0a. market still active and not resolved
flb_0b. TTR ≥ 48h to end_date
flb_0c. YES price ∈ [0.02, 0.10]
flb_0d. CLOB book entry cost ≤ 1.0% (mandatory)
flb_0e. correlation cap (OQ#6, BLOCKED on OQ#3+#4 — Phase 1: disabled, Phase 2: enabled with conservative default)
flb_0f. sizing cap: total locked capital < FLB_MAX_LOCKED_CAPITAL (env-var; Phase 2: 5% of paper_account.initial_capital)
flb_0g. duplicate check: no open flb_position on this market_id
execute
```

## Parameters

All env-var driven. **Structural** params have no Optuna range — changing them changes the strategy class.

| Env var | Default | Optuna range | Meaning |
|---|---|---|---|
| `FLB_EXECUTOR_ENABLED` | `false` | — (structural) | Phase 1 / Phase 2 hard gate. Default off until forward verdict. |
| `FLB_LONGSHOT_LO` | `0.02` | — (structural) | Tail-band lower bound. Backtest-fixed. |
| `FLB_LONGSHOT_HI` | `0.10` | — (structural) | Tail-band upper bound. Backtest-fixed. |
| `FLB_MIN_TTR_HOURS` | `48` | `[36, 96]` | Minimum TTR at entry. Tunable post-Phase-2 once forward data has enough samples. |
| `FLB_MAX_ENTRY_COST_PCT` | `1.0` | `[0.5, 1.5]` | Spread filter ceiling. Below 0.5% empirically rare; above 1.5% the edge is gone. |
| `FLB_MAX_POSITION_PCT` | `0.5` | `[0.1, 1.0]` | Per-position cap as % of `paper_account.initial_capital`. Phase 2 starting default. |
| `FLB_MAX_LOCKED_CAPITAL_PCT` | `5.0` | — (structural) | Hard ceiling on total locked. Phase 2 starting default. |
| `FLB_MAX_SAME_WEEK_POSITIONS` | `null` | `[1, 10]` | Concurrent positions resolving in the same ISO week. BLOCKED until OQ#3 answered. |

## Phase 1 — Dry-run (build-after-decision-gate Phase 1)

**Trigger**: Decision gate passes (2026-07-15 or later).
**Goal**: Confirm the live executor's signal selection matches the shadow recorder's.

- `FLB_EXECUTOR_ENABLED=true`, `FLB_DRY_RUN=true` (new env).
- Daily run: scan, select signals, compute entry cost, **log intended trade** (do not place order).
- Persist into `flb_dry_run_intents` (new table, ephemeral).
- Compare daily against `flb_shadow_signals` for the same date: same markets selected? Same entry cost? If yes for 7 consecutive days → Phase 2.

## Phase 2 — Live with caps

**Trigger**: Phase 1 confirms plumbing matches.
**Goal**: Live trades, real fills, small caps.

- `FLB_DRY_RUN=false`, `FLB_MAX_LOCKED_CAPITAL_PCT=5.0`.
- Place real orders on Polymarket CLOB (uses existing wallet infra from `project_real_trading.md` — that design is approved but not built, so Phase 2 depends on that being built first OR running this in paper-trading mode with synthetic fills.)
- Reconciler runs daily; updates `paper_account.flb_locked_capital`.
- Daily-review skill adds an "FLB live PnL" line.

## Testing

### Unit tests (write at Phase 1 build time)

`packages/dashboard/src/services/FLBExecutor.test.ts`:

| Case | Setup | Expected |
|---|---|---|
| Qualifying market | YES 0.05, TTR 96h, entry cost 0.5% | Intent: SHORT, size = `FLB_MAX_POSITION_PCT × initial_capital` |
| Wide-spread market | YES 0.05, TTR 96h, entry cost 1.5% | REJECTED (flb_0d) |
| TTR too short | YES 0.05, TTR 24h | REJECTED (flb_0b) |
| Out of band low | YES 0.01, TTR 96h | REJECTED (flb_0c) |
| Out of band high | YES 0.15, TTR 96h | REJECTED (flb_0c) |
| Duplicate market | Open `flb_position` already exists | REJECTED (flb_0g) |
| Locked capital cap | Adding this position would exceed `FLB_MAX_LOCKED_CAPITAL_PCT` | REJECTED (flb_0f) |
| Same-week cap (Phase 2 with OQ#3 answered) | 5 positions already resolve this ISO week | REJECTED (flb_0e) |

### Integration tests (write at Phase 1 build time)

- `FLBPositionStore` lifecycle: open → mark resolved → release locked capital. Capital invariants hold.
- Reconciler picks up a market marked `is_resolved=true` and settles within the next cron tick.
- Reconciler does NOT settle a position whose market is unresolved past expected end_date+24h; logs an alert instead.

### VM verification (post Phase 2 deploy)

```sql
-- Confirm executor opens positions
SELECT COUNT(*), MIN(opened_at), MAX(opened_at)
FROM flb_positions
WHERE opened_at > NOW() - INTERVAL '7 days';

-- Confirm reconciler closes them
SELECT COUNT(*) FILTER (WHERE resolved_at IS NULL) AS open_now,
       COUNT(*) FILTER (WHERE resolved_at IS NOT NULL) AS closed_total,
       ROUND(SUM(net_pnl) FILTER (WHERE resolved_at IS NOT NULL)::numeric, 2) AS realised_total
FROM flb_positions;

-- Confirm capital accounting
SELECT current_capital, flb_locked_capital,
       (current_capital + flb_locked_capital) AS total_capital_committed
FROM paper_account ORDER BY id LIMIT 1;
```

## Out of scope

- Multi-leg or basket trades — premature optimisation.
- Stop-loss / time-exit on FLB positions — explicitly rejected (settled decision #3).
- Dynamic re-entry on the same market after wipeout — adds correlation risk without theoretical benefit.
- Real-trading wallet integration — handled by `project_real_trading.md` (separate work item, prerequisite for Phase 2 live fills).
- Cross-strategy capital allocation between 4h-trading and FLB — the system is "trading near zero" on 4h; FLB inherits the full capital pool. Revisit only if 4h re-establishes positive edge.

## Verdict query (run on 2026-07-15)

**Segment by cohort — the tradeable cohort is the gate; `event_long` is reported separately
(forward science, not a build trigger). Never read the pooled row as the verdict.**

```sql
WITH resolved AS (
  SELECT net_pnl, hold_days,
         CASE WHEN market_type = 'event_long' THEN 'event_long (shadow-only)'
              ELSE 'TRADEABLE (cd/ef/es)' END AS cohort
  FROM flb_shadow_signals
  WHERE resolved_at IS NOT NULL
)
SELECT
  cohort,
  COUNT(*) AS n,
  ROUND(AVG(net_pnl)::numeric, 4) AS avg_net_pnl,
  ROUND(STDDEV_SAMP(net_pnl)::numeric, 4) AS sd,
  ROUND((AVG(net_pnl) / NULLIF(STDDEV_SAMP(net_pnl) / SQRT(COUNT(*)), 0))::numeric, 2) AS t_parametric,
  COUNT(*) FILTER (WHERE net_pnl > 0) AS wins,
  ROUND(100.0 * COUNT(*) FILTER (WHERE net_pnl > 0) / NULLIF(COUNT(*), 0), 1) AS win_rate_pct,
  ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY hold_days)::numeric, 1) AS median_hold_days,
  ROUND((AVG(net_pnl) * 365.0 / NULLIF(AVG(hold_days), 0))::numeric, 2) AS naive_annualised_pct
FROM resolved
GROUP BY cohort
ORDER BY cohort;
```

`median_hold_days` and `naive_annualised_pct` are mandatory: a healthy per-trade `t` over a
6-month hold is a low-turnover play, not a +131% strategy (see censored-hold caveat). The
`naive_annualised_pct` ignores correlation (OQ#3) and assumes full redeployment — treat it
as an upper bound, not a forecast.

Also run a bootstrap on `net_pnl` (~10,000 resamples, t-stat distribution) — parametric t over-states on −100%-tailed data. If parametric t ≥ 3 but bootstrap p > 0.05, do NOT build.

## Rollback (post Phase 2)

- Immediate: set `FLB_EXECUTOR_ENABLED=false` in compose, restart dashboard-api. Scanner stops. Open positions remain — they hold to resolution as designed.
- Code revert: separate revert PR; do not drop `flb_positions`; keep as historical record.
