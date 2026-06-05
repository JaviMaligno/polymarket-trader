# H-MM-1 — Market-Making Spread Measurement (design)

**Date:** 2026-06-05
**Status:** approved (brainstorm), pending implementation plan
**Hypothesis:** H-MM-1 — *Spread capture net of adverse selection* (registry, class `market_making`)

## Goal

Measure, from data already collected, whether a passive market-maker on Polymarket
would retain positive edge after adverse selection — per `market_type` — and land
the verdict on the edge-research scoreboard. **Measure-first:** no new data
collection. If a cohort shows positive, significant retained spread, that is the
trigger to invest in a quoting engine / finer collection; if adverse selection
eats the spread, market-making is closed the same way the other four vías were.

## Context: the recorder already exists

The premise "build a bid/ask recorder" was wrong. `ClobCollector.syncAllOrderBooks()`
runs every 10 min (Scheduler job `sync-orderbooks`) and writes
`orderbook_snapshots` (top-of-book + top-10 depth + `mid_price`), 7-day retention.
`trades` is likewise populated (~15.7M rows, ~7-day retention). Only
`price_history.bid/ask/spread` is NULL — a separate, unused column set. So the raw
inputs for a market-making measurement are present; what is missing is the
**measurement** (the H-MM-1 validator), which this sub-project builds.

Verified on VM 2026-06-05:
- `orderbook_snapshots` 48h: 26,200 rows, 60 markets, 120 tokens, 100% with both
  bid and ask; `spread` mean 1.54%, median 1.00%.
- `trades` 48h: 4.08M rows, 87 markets, 155 tokens; all-time 15.66M since 05-29.

## Measurement method (Lee-Ready realized-spread decomposition)

No own quotes/fills exist, so maker economics are estimated from trades + book.
Per trade, as a fraction of price, **per share**:

- **Taker sign** (quote test): `sign = +1 if price > mid_t else −1` (price below mid
  → taker hit the bid). The recorded `side` field is NOT trusted — the quote test
  is the standard, robust classifier.
- **Effective half-spread** (gross the maker captures at fill): `eff_half = sign·(price − mid_t)`.
- **Realized half-spread** (what the maker keeps after the mid moves; ≈ maker
  revenue): `real_half = sign·(price − mid_after)`.
- **Price impact / adverse selection**: `impact_half = eff_half − real_half = sign·(mid_after − mid_t)`.

where `mid_t` is the last book snapshot at or before the trade and `mid_after` is the
next snapshot for the same token (~5–10 min later).

**Maker edge per share ≈ `mean(real_half) − maker_fee`.** Adverse selection is already
inside `real_half`; if it is positive and significant, the maker retains spread; if
`impact_half` consumes `eff_half`, there is no edge.

**Rejected alternative — simulate a passive maker** (post own quotes at best
bid/ask, fill against trades, carry inventory): more realistic in principle but
assumption-heavy (quote size, queue priority, inventory policy). Inappropriate for a
*first* go/no-go. The realized-spread measure assumes none of that and is the
standard microstructure decomposition.

**Δ caveat:** the book is sampled every 10 min, so `mid_after` is ~5–10 min out
(classic realized spread uses ~5 min). Coarse but valid for a first read; recorded
as a caveat on every verdict.

## Architecture & data flow

The heavy asof-join of ~15M trades to snapshots runs **in SQL on the VM** (where both
tables live); Python only consumes a small sampled export.

1. **`scripts/edge-research/mm_trade_spreads.sql`** (versioned): asof-join each trade
   to its token's `mid_t` and `mid_after`, compute `eff_half / real_half / impact_half`,
   join `market_type`, and **sample N trades per token** (default 300) so the export is
   bounded (~155 tokens × 300 ≈ 46k rows). Output columns:
   `market_id, market_type, token_id, time, size, eff_half, real_half, impact_half`.
   Sampling is deterministic (e.g. `ORDER BY md5(token_id || time::text) LIMIT N` per
   token via a window function) so re-runs are stable. Trades with no `mid_t` (before
   the token's first snapshot) or no `mid_after` (within the last ~10 min, snapshot not
   yet taken) are **excluded** — both legs of the join must exist.
2. **Export** via `psql \copy (…) TO STDOUT WITH CSV HEADER` → `mm_trade_spreads.csv`,
   same pattern as the market_panel / flb exports. The weekly GHA workflow adds this
   export later (out of scope here; this sub-project produces a one-off export to get
   the first verdict).
3. **`data.py`**: new loader `load_mm_trade_spreads` + token `mm_trade_spreads` in
   `_LOADERS`, and a `mm_trade_spreads.csv` branch in `load_all_datasets_from_dir`
   (offline mode). The loader is a near-passthrough (numeric coercion only).

## Validator and verdict (`H-MM-1`)

`MMSpreadValidator` in `scripts/edge-research/validators/mm.py`, `hclass = "market_making"`,
`required_inputs() == ["mm_trade_spreads"]`. Reuses `bootstrap_ci` and the `Verdict`
contract exactly like `FLBValidator` / `TimeDecayExtremeBandValidator`.

For each cohort (one per `market_type`, plus a headline = tradeable types pooled —
tradeable = `market_type != "event_long"`, which is shadow-only for taker flow but
in-scope for making):

- `n = len(cohort)`; if `n < floor` (`getattr(ctx, "mm_min_n", 200)`) → `inconclusive`.
- `edge = mean(real_half) − maker_fee`, `maker_fee = getattr(ctx, "mm_maker_fee", 0.0)`.
- `lo, hi = bootstrap_ci(real_half − maker_fee, seed=ctx.seed)`.
- `status = "pass" if (edge > 0 and lo > 0) else "fail"`.
- `class_metric = {"cohort": label, "eff_half": mean(eff_half), "impact_half": mean(impact_half), "avg_size": mean(size)}` — exposes the spread→revenue decomposition.
- `cost_model = f"maker_fee_{maker_fee}"`; `split = "full"`; `edge_insample_pct = edge`.
- **Caveats on every verdict**: `"Δ≈10min (coarse); passive-maker proxy, not simulated fills; excludes queue priority / inventory risk / rewards (H-MM-2)"`.

`edge_net_pct` (and CI) use the per-share `real_half` (price fraction). Equal-weighted
across trades for the headline number; `avg_size` is surfaced so a future revision can
size-weight without re-exporting.

Registry: change H-MM-1 `required_data` from `[price_history_bidask]` to
`[mm_trade_spreads]` so `runnable()` dispatches it once the export exists; H-MM-2
(rewards) stays blocked.

## Testing

Synthetic fixtures, no DB (mirrors `test_flb.py` / `test_ine5.py`):

1. **Positive retained spread passes**: cohort with `real_half ≈ +0.01`, tight variance
   → headline `pass`, `edge_net_pct > 0`, and `class_metric` carries `eff_half`/`impact_half`.
2. **Adverse selection eats the spread → fail**: `eff_half ≈ +0.01` but `impact_half ≈ +0.012`
   so `real_half ≤ 0` → `fail`.
3. **Below floor → inconclusive**: `n < mm_min_n`.
4. **Cohort split**: `event_long` emitted as its own verdict, not folded into the headline.
5. **`data.py` loader**: synthetic `mm_trade_spreads.csv` in a tmp dir →
   `load_all_datasets_from_dir` returns the token with numeric columns.
6. **`run.py` dispatch**: with `mm_trade_spreads` available, `run_validators` emits an
   H-MM-1 verdict (extends `test_run.py`).

The **SQL** is not unit-tested in Python; it is validated against the VM during
implementation with a sanity check: `real_half = eff_half − impact_half` by
construction, sign distribution matches the quote test, and row count ≈ N×tokens. The
first real export produces the initial scoreboard verdict.

## Scope (anti-scope-creep)

In scope: the SQL export, the loader, the validator, its tests, registry token rename,
scoreboard regen — one PR. **Out of scope**: wiring the export into the weekly GHA
workflow (a follow-up once the first verdict justifies it); H-MM-2 rewards; any quoting
engine; finer-cadence or longer-retention collection (only if the measurement clears
the bar). Size-weighting and shorter Δ are explicit future revisions, not v1.

## Success criteria

A reproducible H-MM-1 verdict per `market_type` on the scoreboard, showing the
`eff_half → real_half` (spread minus adverse selection) decomposition, with an honest
pass/fail under the same bootstrap-significant, cost-aware bar as the other vías. The
outcome — edge or no edge — is the deliverable; a `fail` closes market-making as
cleanly as a `pass` opens it.
