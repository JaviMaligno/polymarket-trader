# Informational Edge program — sub-project #1: Conditional/dependent market staleness (H-INE-COND)

**Date:** 2026-06-23
**Status:** design approved, spec for review
**Author:** brainstorm session (daily-autoreview continuation)

## Context

Every structural lever measured by the edge-research harness has closed as **no
edge at real cost**: calibration, FLB (4h and hold-to-resolution), supervised,
ensemble, and — as of 2026-06-23 — market-making (gate H-MM-4 FAIL, retained
spread collapses to ~+2bps once the exact initial queue is modelled). The one
structurally-different class left is **informational edge**: knowing the event
better than the market, not exploiting microstructure.

Three candidate domains exist (see `project_next_levers_and_automation` §2 and
`project_prediction_market_alpha_research` §"Inefficiencies"):

- **H-INE-COND** — conditional/dependent market staleness (THIS spec, sub-project #1)
- **H-INE-NEWS** — news-event lag (sub-project #2, self-contained on `news_articles`+`price_history`)
- **H-INE-POLL** — polling-anchored political (sub-project #3, requires sourcing poll data)

Agreed sequencing: **self-contained probes first**. Each domain is an independent
harness hypothesis (Validator → Verdict → scoreboard), measured cost-aware OOS at
the same bar as every prior vía: `t_net > 0` with bootstrap lower bound > 0 on an
out-of-sample split.

**Program quitting bar:** if no cohort of any H-INE-* hypothesis clears `t_net > 0`
cost-aware OOS, informational edge is also inaccessible at our scope, and the
decision turns to venue / product / wind-down. This spec does NOT pre-commit that
verdict — it builds the first measurement.

## Why conditional first

- **100% self-contained**: uses only Polymarket data already in the DB (market
  catalog titles + resolved-market price history + outcomes). No external feed,
  and no semantic news↔market matching — the problem that made `news_sentiment`
  generalise poorly.
- **Crispest, most verifiable edge**: a logical inconsistency, not a statistical
  one. After market A resolves, a logically-dependent market B has a known implied
  value; staleness is directly observable.
- **The untested relative-value class**: `project_cross_venue_arb_feasibility`
  closed *same-venue structural arb* because negRisk multi-outcome sets net to
  Σ=1. Conditional pairs are **separate markets** (e.g. a primary market and a
  general-election market), NOT a netted negRisk set — a distinct, never-measured
  inefficiency.

## Hypothesis

When market A resolves at time `t_A` with outcome `o_A`, a logically-dependent
market B that should reprice to its A-conditional value often does not reprice
immediately. Entering B in the logically-implied direction shortly after `t_A`
and holding to B's reprice/resolution yields edge net of cost.

If B reprices instantly (efficient), entry price ≈ implied value ≈ outcome and the
net edge ≈ −cost. The measured net edge is therefore a direct test of staleness.

## Edge mechanism & relation types

For each ordered pair (A, B) with A resolving before B, the LLM labels a relation
that determines B's implied direction once A's outcome is known:

| relation (A→B) | when A resolves | implied bound on B |
|---|---|---|
| `implies_yes` | A=YES | B must be YES → B should be 1 (long B if stale below) |
| `implies_no` | A=YES | B must be NO → B should be 0 (short B if stale above) |
| `mutual_exclusion` | A=YES | B must be NO → 0 (only for pairs NOT in one negRisk set) |
| `excludes_on_no` | A=NO | B implied (rare; supported but low prior) |

Only pairs whose A-outcome produces a **determinate** bound on B (→ 0 or → 1)
generate a backtest event. Pairs whose A-outcome leaves B unconstrained that
round produce no event (not an error).

**negRisk guard:** pairs where A and B belong to the same negRisk/condition set
are EXCLUDED — those are netted to Σ=1 and already covered by the dead structural
arb. The pair identifier records each market's negRisk/condition group so the
export can drop same-group pairs.

## Components (isolated units)

### 1. `identify_conditional_pairs` (offline, LLM)
- **Input:** resolved-market catalog rows — `market_id`, `title`/`question`,
  `market_type`, `end_date`, `resolved_at`, `outcome_yes`, negRisk/condition group id.
- **Process:** an LLM proposes candidate dependent pairs from titles + metadata,
  each tagged with `relation` (table above), the intended A and B, and a one-line
  rationale. Run in batches over the catalog; dedupe; drop same-negRisk-group pairs.
- **Output:** `conditional_pairs` table/CSV — `pair_id, market_id_a, market_id_b,
  relation, rationale`. Vetted set; cached/committed so the backtest is
  deterministic and re-runnable without re-querying the LLM.
- **Note:** the LLM is a *candidate generator*, not the edge. Every pair is
  re-checked mechanically in the export (A resolves before B; determinate bound;
  both have price history; not same negRisk group). False pairs cost recall, not
  correctness.

### 2. `conditional_events` export (SQL, existing data)
- For each vetted pair where `resolved_at_A < resolved_at_B` and A's outcome
  yields a determinate bound on B, emit one **event row**:
  `pair_id, relation, market_type_b, t_a (=resolved_at_A), outcome_a,
   b_entry_price (B's first priced snapshot at/after t_a + ε), b_implied_value
   (0 or 1), b_outcome (resolved outcome_yes of B), b_resolved_at,
   hold_days (= b_resolved_at − t_a)`.
- Multiple entry horizons captured by snapshotting `b_entry_price` at several
  offsets after `t_a` (e.g. +1min, +1h, +1d) → an `entry_offset` column, so the
  validator can cohort by how fast we react.
- Reuses the same VM-export pattern as the other MM/FLB datasets (psql → CSV →
  harness `--datasets-dir`). Keep it light (no asof over `mm_book_events`; B's
  snapshot lookups hit `price_history`/panel via existing indexes — apply the
  lesson from the H-MM-4 export: no 4M-row temp table).

### 3. `validators/conditional.py` → **H-INE-COND**
- **required_data:** `conditional_events`.
- **Entry/exit:** enter B at `b_entry_price` in the implied direction (long if
  `b_implied_value=1`, short if `=0`); hold to resolution. **Entry is
  unconditional in v1** — every determinate event is traded, with NO staleness
  threshold. This measures the average edge of "blindly trade B's implied
  direction after A resolves"; the distribution of `b_entry_price − b_implied_value`
  (the staleness gap) is reported as a diagnostic. A staleness-threshold entry is
  an explicit later refinement, only if v1 passes (avoids an optimizable parameter
  in the first read). Per-event gross return = directional
  `(b_outcome − b_entry_price)` (long) or `(b_entry_price − b_outcome)` (short),
  in B's own frame.
- **Cost:** one-way real entry cost (hold-to-resolution has no exit trade; matches
  the FLB hold-to-resolution convention). Net = gross − entry_cost. Default entry
  cost a parameter (`--cost`, seed at the established real one-way ~0.54%); the
  scoreboard shows flat-vs-real side by side as it does for FLB.
- **Cohorts:** `headline` (all events) + per `relation` + per `market_type_b` +
  per `entry_offset`. Each × the standard gate.
- **Gate:** `status = pass` iff `edge_net > 0` AND bootstrap lower bound > 0 AND
  `n ≥ floor` (reuse the harness floor, 200; cohorts below floor → inconclusive,
  surfaced honestly).
- **OOS split:** temporal by `t_a` — in-sample = earlier resolutions, OOS = later;
  report the OOS verdict as the decision (the harness already distinguishes
  in-sample vs net split fields).

### 4. Registry + scoreboard integration
- Add an `H-INE-COND` entry to `registry.py` with `required_data:
  ["conditional_events"]`, `class: informational_edge`.
- Add the loader to `data.py` (`load_conditional_events` + offline CSV path in
  `load_all_datasets_from_dir`).
- Wire the validator into `run.py`'s validator list.
- The weekly cron exports `conditional_events.csv` alongside the other datasets
  (deferred until after the first manual verdict — same discipline as the others).

## Data availability (verified directions, exact columns deferred to plan)

- Resolved-market price history + outcomes exist (`flb_backtest_prices` /
  `market_panel`, 6339 resolved markets backfilled for the FLB work).
- Market titles + types + negRisk/condition group live in the `markets` catalog.
- The plan step confirms exact column names and whether a small title/group column
  must be added to the panel export for the LLM pairing input.

## Success criteria

- **Primary:** ≥1 H-INE-COND cohort with `t_net > 0` and bootstrap_lo > 0 on the
  OOS split, at `n ≥ 200`. That is a candidate informational edge → proceed to a
  forward/paper validation as its own next step.
- **Negative (also a result):** all cohorts `t_net ≤ 0` or inconclusive (supply
  too thin / B too illiquid / repricing instant) → conditional is dead; move to
  H-INE-NEWS. Record which failure mode (thin supply vs no-staleness vs cost) so
  the verdict is diagnostic, not just "fail".

## Out of scope (YAGNI)

- No production generator, no live/paper trading wiring — this is measurement only.
- No H-INE-NEWS or H-INE-POLL here (separate sub-projects/specs).
- No new external data source (conditional is self-contained).
- No live B-liquidity modelling beyond recording B's traded volume as a cohort
  filter; depth simulation is deferred unless a cohort passes.

## Risks (measured, not assumed)

- **Pair supply tiny** → headline `n` below floor → inconclusive. Mitigation:
  broad LLM pass over the full resolved catalog; report the realised pair/event count.
- **B illiquid** → the staleness exists but is untradeable. Mitigation: cohort by
  B volume; a pass on illiquid-only cohorts is flagged not-tradeable.
- **Repricing instant** → net ≈ −cost across offsets → the cleanest "no edge" read.
- **Resolution-time precision** → `resolved_at` granularity; the +offset entries
  bracket it.
- **LLM false pairs** → mechanically re-checked in export; cost recall not correctness.
