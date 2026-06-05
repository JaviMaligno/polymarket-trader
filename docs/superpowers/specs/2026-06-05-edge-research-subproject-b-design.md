# Edge Research — Sub-project B design (validators + ensemble)

**Date:** 2026-06-05
**Status:** Approved (scope: full B incl. ensemble)
**Builds on:** `2026-06-05-edge-research-program-design.md` (the program spec) and
Sub-project A (framework + calibration, merged to main).

## 1. Goal

Extend the edge-research harness from one validator (calibration) to the full
hypothesis set: FLB (H-INE-1), horizon sweep (H-HOR-1), supervised model
(H-SUP-1), and the ensemble (H-ENS-1, the combinations). Each lands a `Verdict`
on the same scoreboard, judged on the uniform cost-aware OOS bar.

## 2. B0 — Harness refactor (enabler, must land first)

Sub-project A's runner dispatches **one validator per class** over a single
panel DataFrame (`ctx.df`). B needs two things A doesn't have:

1. **Dispatch by `hypothesis_id`, not class.** `inefficiency` will hold several
   heterogeneous validators (H-INE-1 FLB, later H-INE-2…); calibration already
   maps one validator to four ids. New model:
   - `VALIDATORS: dict[str, type]` maps a **primary hypothesis_id** → validator
     class. Calibration registers under `"H-CAL-1"` and its `run()` emits the
     H-CAL-1..4 slices. FLB registers under `"H-INE-1"`, etc.
   - `run_validators` iterates runnable entries; for each whose `id` is in
     `VALIDATORS` (and not already run) it instantiates and runs the validator.
     Entries whose id isn't a key (e.g. H-CAL-2) are covered by their primary's
     emitted slices and are not dispatched directly.
2. **Multi-dataset ctx.** Validators read different tables. `ctx.datasets` is a
   `dict[str, DataFrame]` keyed by the registry `required_data` token. A
   validator reads `ctx.datasets[self.required_inputs()[0]]`. `run_validators`
   receives a `datasets` dict and an `available` set derived from its keys.

**Migration of calibration:** `CalibrationValidator.required_inputs()` already
returns `["market_panel_resolved"]`; change `_slice` to read
`ctx.datasets["market_panel_resolved"]` instead of `ctx.df`. Its tests pass a
`datasets={"market_panel_resolved": df}` ctx. Behaviour is otherwise unchanged.

`run.main` loads every available dataset (see §7) into the dict before dispatch.

## 3. B1 — FLB validator (H-INE-1)

- **required_data:** `flb_shadow_signals` (NOT the empty `flb_backtest_prices`).
- **Input columns:** `entry_yes_price, market_type, net_pnl, net_pnl_real,
  entry_cost_real, resolved_at`. Use rows with `net_pnl_real IS NOT NULL`.
- **Logic (mirrors the deployed `flbForwardVerdict`):** segment into cohorts —
  `tradeable` (market_type != event_long) vs `event_long` (shadow-only) — and an
  `enterable` filter (`entry_cost_real <= max_cost`, default 0.01). The headline
  Verdict is the **tradeable + enterable** cohort: `edge_net_pct =
  mean(net_pnl_real)`, significance via bootstrap CI, `pass` only if positive +
  significant + n≥floor. Emit additional Verdicts for the other cohorts as
  context (with `slice` in class_metric). `cost_model = "real_per_signal"`.
- **Known result (2026-06-05, n=160):** tradeable+enterable = **0** rows →
  `inconclusive`; event_long+enterable n=54 avg -1.35% → `fail`. The validator
  formalizes this on the board.

## 4. B2 — Horizon validator (H-HOR-1)

- **required_data:** `market_panel_full` (ALL snapshots per market, not the
  earliest-only resolved view). The weekly panel gives a coarse price path:
  yes_price at week 1, 2, … until resolution, plus the final outcome.
- **Logic:** for each resolved market entered at its earliest snapshot price
  `p0`, measure the net return of exiting at each horizon:
  - hold = 1 week, 2 weeks, … (later snapshots, exit at that snapshot price →
    **round-trip** cost), and
  - hold = to resolution (settle at outcome → **entry-only** cost).
  Aggregate net return per horizon bucket across markets; report the **best
  horizon's** net edge as the headline (with the horizon in class_metric), and
  one context Verdict per horizon. Significance via bootstrap. `pass` only on a
  positive, significant, cost-cleared horizon with n≥floor.
- **Why this matters:** 4h is dead, hold-to-resolution is FLB; the 1–3 week
  middle is unmeasured. This is the free parameter never swept.

## 5. B3 — Supervised validator (H-SUP-1)

- **required_data:** `market_panel_resolved` (earliest snapshot per market).
- **Features:** `yes_price, market_type` (one-hot), `ttr_days`, `market_score`.
  **Target:** `outcome_yes`.
- **Method:** **temporal** train/holdout split (train = earlier ISO weeks,
  holdout = latest weeks — never random, §7 of the program spec). Fit a
  logistic-regression baseline (simple, interpretable; GBM is a follow-up). The
  signal is `model_prob - yes_price`; trade the gap (LONG if model_prob > price +
  cost, SHORT if <). `edge_net_pct` = mean net trade return on the **holdout**,
  cost-aware; `edge_insample_pct` = same on train (the overfit gap). `pass` only
  if the holdout edge is positive, significant, and n≥floor.
- **Honest prior:** calibration showed the price is already well-calibrated
  (Brier 0.0635), and the panel has only 4 weak features → low prior the model
  beats the price. The value is measuring it rather than assuming.

## 6. B4 — Ensemble (H-ENS-1)

Per program spec §7.2/§7.3. The mechanism is built now even though there is
nothing to combine yet (calibration + FLB are no-edge) — it is infrastructure
that activates the moment any validator passes, and its mechanics are tested on
synthetic signals.

- **Input:** the per-hypothesis signals (each validator, in addition to its
  Verdict, exposes a per-market signal series via a `signals(ctx)` method
  returning `Series` indexed by market_id; validators that can't produce a
  per-market signal opt out). v1 ensembles only the validators that **pass
  standalone**; if fewer than 2 pass, the ensemble Verdict is `inconclusive`
  with a caveat ("nothing to combine").
- **Method:** weighted-average of standardized signals, weights fit on **train**,
  scored on **holdout**. Three modes (standalone baseline / ensemble-of-new /
  new+current-stack — "current-stack" is out of scope for v1 data and emits an
  `inconclusive` placeholder).
- **Lift gate:** ensemble holdout edge must beat its best component's holdout
  edge AND that lift is itself bootstrap-significant. Collinear components
  (correlation > 0.9) are merged before the lift test.
- **Multiple-testing:** record how many combinations were tried; a winner among
  N must clear a Bonferroni-deflated threshold. With <2 passing components this
  is moot but the code path exists and is tested.

## 7. Datasets (loaded by `run.main`)

| token | source | shape |
|-------|--------|-------|
| `market_panel_resolved` | `market_panel WHERE outcome_yes IS NOT NULL` | earliest snapshot per market (existing `shape_panel`) |
| `market_panel_full` | same table, all rows | all snapshots per market + outcome |
| `flb_shadow_signals` | `flb_shadow_signals WHERE net_pnl_real IS NOT NULL` | one row per market |

CSV-export path (dashboard container is Node/Alpine) as in A's README; each
dataset its own export. `available_data` returns the set of tokens whose export
is non-empty.

## 8. Decomposition into tasks (TDD)

1. **B0a** refactor ctx → `datasets` dict + migrate calibration + its tests.
2. **B0b** refactor runner → dispatch by id + tests.
3. **B1** FLB validator + data loader + tests.
4. **B2** Horizon validator + `market_panel_full` loader + tests.
5. **B3** Supervised validator (logistic, temporal split) + tests.
6. **B4** Ensemble (signals interface + weighted avg + lift + multiple-testing) + tests.
7. **Smoke** run all over real data → updated scoreboard committed.

## 9. Risks / honest caveats

- Panel is young (3 weeks) and 96% event_long → horizon has few distinct
  exit-week observations; supervised holdout is small. v1 reads are directional,
  re-run as the panel grows. Mark thin slices `inconclusive`.
- Ensemble is built ahead of having signals to combine — intentional infra, its
  value is latent until a validator passes.
- Supervised: logistic only in v1 (GBM deferred). Few features → low prior.
- Horizon over weekly snapshots is coarse (no intra-week path). It answers
  "weekly-hold" edge, not arbitrary hold; finer paths need a price recorder
  (deferred).
