# Market Panel Recorder — Design

**Date:** 2026-05-19
**Status:** Approved (brainstorm), pending implementation plan
**Scope:** The data-collection foundation only. The three research analyses it
feeds are out of scope (see below).

## Purpose

The trading research program has three open vías for finding edge on Polymarket:

1. **Calibration** — is the market price a well-calibrated probability, and
   where on the (price × category × time-to-resolution × liquidity) space is it
   biased? (The favorite-longshot finding is one slice of this.)
2. **Supervised models** — train a model on resolved markets' features to
   predict the outcome, and trade the gap vs the market price.
3. **Holding horizon** — sweep the optimal hold (4h proved cost-dominated;
   hold-to-resolution worked for FLB; the middle is unmeasured).

All three need the same foundation: a forward-collected dataset of
`(features, price, outcome)` across the whole market space. Historical
out-of-sample is impossible — the Polymarket CLOB price API serves no history
older than ~6 weeks (verified) — so the dataset must be collected going
forward. This spec designs that collector.

**This spec covers the collector only.** Each of the three analyses is its own
later sub-project, designed once real data exists (the calibration analysis is
light enough to be a quick follow-up script; the model and horizon analyses
warrant their own specs).

## Approach (chosen)

A **weekly panel** of liquid active markets: one row per `(market_id, ISO week)`
capturing that market's features and price each week until it resolves; on
resolution every row of that market is backfilled with the outcome.

Rejected alternatives:
- **Once-per-market snapshot** — cannot do the horizon vía at all, cannot build
  price-path features for the model, and only gives calibration at one
  uncontrolled time-to-resolution. Loses information for all three vías.
- **Daily panel of all markets** — ~1.8M rows / 6 months; daily granularity is
  overkill for resolution-scale analysis; mostly redundant correlated rows.

The weekly panel serves all three vías: horizon (rows at TTR ≈ 8w, 7w, … 1w per
market), calibration (any row's price vs outcome, conditionable on TTR /
category / liquidity), model (each row a training example with TTR a feature;
price-path features derived from consecutive rows).

## Architecture

### Table: `market_panel`

A normal (logged) table — it is the research dataset, not throwaway. One row per
`(market_id, iso_week)`. Self-contained: static market fields are stored
redundantly per row so the dataset survives the `markets` table pruning old
resolved markets (~40 days after resolution).

| Group | Columns |
|---|---|
| Keys | `market_id` text, `iso_week` text (e.g. `2026-W21`) — PRIMARY KEY together; `snapshot_at` timestamptz |
| Static | `market_type` text, `category` text, `question` text, `event_id` text, `end_date` timestamptz, `created_at` timestamptz |
| Time-varying | `yes_price` numeric, `last_trade_price` numeric, `best_bid` numeric, `best_ask` numeric, `spread` numeric, `volume_24h` numeric, `liquidity` numeric, `market_score` numeric, `realized_vol_24h` numeric, `ttr_days` numeric (snapshot_at → end_date), `market_age_days` numeric (created_at → snapshot_at) |
| Outcome (backfilled) | `resolved_outcome` text (`yes`/`no`), `resolved_at` timestamptz, `outcome_yes` smallint (1/0) |

All time-varying features come from the `markets` table, which the
data-collector already syncs — no extra API calls. Index: `(market_id)` for the
scoring UPDATE and analysis joins; the PK covers `(market_id, iso_week)`.

**Not stored, deliberately:**
- Price-path features (week-over-week change, trend, path volatility) — derived
  at analysis time from consecutive panel rows; storing them would fix a
  definition prematurely.
- Order-book depth (CLOB `/book`) — deferred enrichment; needs N API calls per
  run. The `markets`-table features are free and sufficient for v1.
- `description` and other static fields — joinable from `markets` while the
  market exists; not worth the per-row redundancy.

### Script: `scripts/market-panel-snapshot.js`

Node script, idempotent, run from the dashboard container (`pg` + `DATABASE_URL`).
Three steps:

1. **Record** — for every market matching the filter, insert one panel row with
   current features:
   ```
   INSERT INTO market_panel (...)
   SELECT ..., to_char(NOW(),'IYYY"-W"IW') AS iso_week, ...
   FROM markets
   WHERE is_active = true AND COALESCE(is_resolved,false) = false
     AND current_price_yes IS NOT NULL
     AND liquidity >= <LIQUIDITY_FLOOR>
   ON CONFLICT (market_id, iso_week) DO NOTHING;
   ```
   The `ON CONFLICT` makes it exactly one snapshot per market per ISO week
   regardless of how many times the script runs.

2. **Score** — backfill the outcome on every panel row whose market has since
   resolved:
   ```
   UPDATE market_panel p SET
     resolved_outcome = lower(m.resolution_outcome),
     resolved_at = m.resolved_at,
     outcome_yes = CASE WHEN lower(m.resolution_outcome) = 'yes' THEN 1 ELSE 0 END
   FROM markets m
   WHERE m.id = p.market_id AND m.is_resolved = true
     AND lower(m.resolution_outcome) IN ('yes','no')
     AND p.resolved_outcome IS NULL;
   ```
   Runs daily, so a resolution is scored within ~24h — well before `markets`
   prunes the resolved row (~40 days).

3. **Report** — total rows, distinct markets, scored (resolved) count, distinct
   weeks, table size; print for the workflow log.

The table is created by the script with `CREATE TABLE IF NOT EXISTS` (the
project's established pattern — the data-collector does not run migrations for
new tables).

### Scheduling

The existing `flb-shadow-snapshot.yml` workflow (daily, 06:00 UTC) runs this
script as an additional step. One workflow, two scripts. Weekly cadence is
enforced by the `(market_id, iso_week)` PK, not by the cron — a missed day is
harmless as long as one run lands in the week.

`flb_shadow_signals` and its July review routine are untouched. The panel is a
superset but the FLB recorder stays the dedicated, simple FLB tracker.

## Liquidity filter

Not a strict gate — data hygiene. A market with `liquidity = 0` has a stale or
default (0.50) `current_price_yes` that would pollute calibration and the model.
Dead markets are dropped; the sample otherwise stays broad (calibration of
low-liquidity markets is still informative).

Starting floor: `liquidity >= 100`. The **first run reports the resulting market
count**; the threshold is tuned from that real number, not guessed.

## Size budget

Estimate at the broad setting: ~2-4k markets/week, ~7 weekly rows per market of
median life → ~100-200k rows over 6 months → ~50-80MB on disk. TimescaleDB's
350M limit is **container memory**, not disk; a 200k-row table does not
threaten it. No retention policy on `market_panel` — it is the research dataset
and its full history is needed. (Contrast: `generator_predictions` grows
unbounded and is a separate retention-cleanup follow-up.)

## Error handling

The script is idempotent: a failed run is recovered by the next day's run (the
weekly dedup tolerates missed days). DB connection errors retry, then exit
non-zero so the workflow surfaces red. Follow-up note: the daily-review watchdog
prompt should add a check that `market_panel` is still growing (the same
guardian role it now has for `flb_shadow_signals`).

## Validation plan

Testable immediately against current data:

1. **First run** — full snapshot. Inspect: row count (→ tune the liquidity
   floor), features populated with no unexpected nulls, table size.
2. **Within days** — short-lived markets resolve; Step 2 backfills outcomes —
   verify `outcome_yes` populates and the scoring UPDATE works.
3. **~2 weeks** — confirm the weekly dedup: a market seen across two weeks has
   exactly two rows with distinct `iso_week`.

## Out of scope

- The three analyses (calibration, supervised model, horizon sweep) — each its
  own later sub-project, designed against real collected data.
- Price-path features — derived at analysis time, not stored.
- Order-book depth enrichment — deferred.
- DB retention cleanup (`generator_predictions` etc.) — separate PR after an
  investigation of table growth and readers.

## Cross-references

- `project_flb_strategy_design` memo — the FLB hold-to-resolution lead and the
  shadow-recorder this generalises.
- `project_prediction_market_alpha_research` memo — the research program and
  the 6-week API-history limit that forces forward collection.
- `scripts/flb-shadow-snapshot.js` — the FLB-specific recorder this design
  parallels and runs alongside.
