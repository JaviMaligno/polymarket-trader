# Edge Research Program — registry + validation harness

**Date:** 2026-06-05
**Status:** Approved (brainstorming)
**Author:** daily-review session (RPv2 removal → strategic follow-up)

## 1. Motivation

The 4h taker-trading paradigm is dead — measured exhaustively, no cost-aware
edge survives the ~1.08% round-trip (see `project_prediction_market_alpha_research`,
`project_edge_research_3vias`). The one survivor is the favorite-longshot
**hold-to-resolution** result (longshots 0.02–0.10: net +2.24%/trade, t=3.49,
n=1015) — and even that is modest and under cost-pressure at realistic spread
(the FLB forward sentinel is currently *accumulating*, not proven).

We have several **unexplored or half-explored** alternative edge hypotheses (the
3 vías, market-making, a catalogue of documented inefficiencies). They are
scattered across memory notes and have never been validated under a single,
cost-aware, comparable standard — nor tested **in combination**. While the FLB
forward-test matures (~2026-07), the cost of exploring these is low.

This program builds (a) a **living registry** of every edge hypothesis and (b) a
**validation harness** that scores each one — and their combinations — against a
common cost-aware bar, producing a single scoreboard.

## 2. Goals / Non-goals

**Goals**
- One **registry** that is the source of truth for every edge hypothesis: its
  mechanism, required data, validation method, bar, status, priority, deps.
- One **harness** with a per-class `Validator` adapter, all emitting a
  standardized `Verdict`, so heterogeneous hypotheses are comparable.
- A regenerable **scoreboard** ranking all hypotheses by net-of-cost edge +
  significance.
- Support for **combinations**: an `Ensemble` validator with three modes —
  standalone, ensemble-of-new, and new+current-stack.
- Validate hypotheses **one at a time** (each is independent and appears on the
  board) while making combination testing a first-class operation.

**Non-goals**
- Not building production execution for any new strategy. This is measurement.
- Not promoting anything to live trading inside this program — promotion stays a
  separate, explicit decision gated on the scoreboard.
- Not collecting new data sources in v1 beyond what already exists
  (`market_panel`, `price_history` bid/ask/spread). New collectors (full
  order-book depth, cross-venue) are registry entries, deferred.

## 3. The common contract — `Verdict`

Every validator, regardless of class, returns the same record so results are
comparable on one board:

```
Verdict {
  hypothesis_id:   str          # matches the registry id
  class:           str          # calibration | supervised | horizon | inefficiency | market_making | ensemble | arbitrage
  n:               int          # sample size the verdict rests on
  edge_net_pct:    float|null    # net-of-cost edge per unit, the headline number
  significance:    float|null    # t-stat or bootstrap IC half-width
  class_metric:    dict          # class-specific (brier, logloss, sharpe, spread_capture, auc…)
  cost_model:      str           # how cost was applied (e.g. "rt_1.08pct", "spread_minus_adverse")
  status:          str           # pass | fail | inconclusive | blocked
  n_caveats:       list[str]     # sample skew, data limits, etc.
  computed_at:     str           # ISO timestamp (passed in, not generated — determinism)
}
```

`pass` requires `edge_net_pct > 0` **and** significance clearing a threshold
(default t ≥ 2 or bootstrap IC excluding 0). The bar is uniform; the
`class_metric` and `cost_model` differ by class. This operationalizes
`feedback_realistic_costs`: nothing passes on gross edge.

## 4. The `Validator` interface and the runner

```
class Validator(Protocol):
    hypothesis_id: str
    hclass: str
    def required_inputs(self) -> list[str]   # data dependencies, checked before run
    def run(self, ctx) -> Verdict            # ctx provides DB handle, cost model, params
```

The **runner** (`scripts/edge-research/run.py`):
1. Loads the registry, resolves which validators are runnable (deps satisfied).
2. Runs each, collects `Verdict`s into a JSON results file.
3. Renders the **scoreboard** (markdown + CSV) sorted by `edge_net_pct`,
   with a `status` column and caveats.
4. Skipped/blocked hypotheses are listed explicitly (no silent omission).

Determinism: timestamps are passed in, not generated, so re-runs are
reproducible (mirrors the workflow-script discipline used elsewhere).

## 5. The registry

File: `scripts/edge-research/registry.yaml` (machine-readable, drives the runner)
plus a human view committed at `docs/edge-hypothesis-registry.md` generated from
it. Each entry:

```
- id: H-CAL-1
  name: Price calibration by price band
  class: calibration
  mechanism: "Is the market price a calibrated probability? Reliability curve per band."
  required_data: [market_panel.resolved]
  validation: "Brier/log-loss + per-bin reliability; edge where |mean_outcome - mean_price| > cost"
  bar: "any band with net deviation > round-trip cost and bootstrap-significant"
  status: planned        # planned | in_progress | pass | fail | inconclusive | blocked | closed
  priority: 1
  depends_on: []
```

### Initial catalogue (v1)

| id | class | hypothesis | data | status |
|----|-------|------------|------|--------|
| H-CAL-1 | calibration | Price calibration by price band (reliability curve; FLB is one slice) | market_panel | planned |
| H-CAL-2 | calibration | Calibration conditioned on market_type | market_panel | planned |
| H-CAL-3 | calibration | Calibration conditioned on TTR bucket | market_panel | planned |
| H-CAL-4 | calibration | Calibration conditioned on liquidity/score | market_panel | planned |
| H-SUP-1 | supervised | GBM/logit on features → outcome_yes; trade model_prob − price | market_panel | planned |
| H-HOR-1 | horizon | Optimal-hold sweep {1d,3d,7d,resolution} for edged signals | price_history + resolved | planned |
| H-INE-1 | inefficiency | Favorite-longshot hold-to-resolution (BASELINE — already +2.24%/t=3.49) | flb_backtest_prices | pass (in-sample) |
| H-INE-2 | inefficiency | Resolution-day discovery gap (TTR<2d, price not converged) | market_panel + price_history | planned |
| H-INE-3 | inefficiency | News-event price lag | price_history + news | planned |
| H-INE-4 | inefficiency | Conditional/dependent markets not updating | markets + manual mapping | planned |
| H-INE-5 | inefficiency | Time-decay extreme band mispricing | market_panel | planned |
| H-MM-1 | market_making | Spread capture net of adverse selection | price_history bid/ask/spread | planned |
| H-MM-2 | market_making | Liquidity-rewards subsidy (rewardsMinSize/MaxSpread) | gamma API + measurement | planned |
| H-ENS-1 | ensemble | Combination of validated signals (3 modes) | derived from above | planned |
| H-ARB-1 | arbitrage | Cross-venue (Kalshi/Manifold) | — | closed (Kalshi US-only) |
| H-ARB-2 | arbitrage | Same-venue structural sum-arb | — | closed (negRisk netting forces Σ=1) |

Closed entries stay in the registry as institutional memory (don't re-investigate
dead ends). New hypotheses are appended over time.

## 6. Cost model

Per `feedback_realistic_costs`, all edges are net of realistic cost. The cost
depends on whether the strategy **exits by market** or **holds to resolution**:
- **Hold-to-resolution classes** (calibration, FLB-style inefficiencies): cost is
  **entry-only** — you cross the spread once to enter; the exit is settlement at
  0/1, no second spread crossing. Cost = real per-signal half-spread + entry fee
  (the `entry_cost_real` / enterable-filter approach from the FLB work). Charging
  a full round-trip here would over-state cost by ~2×.
- **Exit-by-market classes** (horizon sweep with hold < resolution, supervised if
  it closes before resolution): full **round trip** ≈ 1.08% default, overridable.
- **Market-making**: cost is inverted — `edge = spread_captured − adverse_selection`.
  Adverse-selection proxy: how far the mid moves against a resting passive quote
  before the far side would fill, measured on `price_history` bid/ask series.

Each validator declares its `cost_model` string in the `Verdict` so the
scoreboard never compares an entry-only edge against a round-trip edge silently.

## 7. Decomposition (build order)

The registry and framework cover everything from v1; construction iterates. Each
sub-project gets its own spec → plan → implementation, all feeding one scoreboard.

- **Sub-project A (this spec's build target):** registry + framework
  (`Verdict`/`Validator`/runner/scoreboard) + the **Calibration** validator
  (H-CAL-1..4) end-to-end. Cheapest, data ready, immediately useful.
- **Sub-project B (next spec):** `SupervisedModel` (H-SUP-1), `Horizon` (H-HOR-1),
  remaining `Inefficiency` validators, and `Ensemble` (H-ENS-1) with its 3 modes.
- **Sub-project C (later spec):** `MarketMaking` (H-MM-1/2) + rewards-program
  research; first-order viability verdict decides whether to build a full
  order-book-depth collector.

## 8. Sub-project A detail — Calibration validator

**Location:** `scripts/edge-research/` (Python; precedent: `flb-hierarchical-edge.py`).
Files: `run.py` (runner), `registry.yaml`, `verdict.py` (dataclass + JSON I/O),
`validators/calibration.py`, plus tests under `scripts/edge-research/tests/`.

**Input:** `market_panel` rows with `outcome_yes IS NOT NULL`. Columns used:
`yes_price` (price at snapshot), `outcome_yes` (0/1), `market_type`, `end_date`,
`snapshot_at` (→ TTR = end_date − snapshot_at), `market_score`. One market may
appear in multiple ISO weeks; for calibration we use **the earliest unresolved
snapshot per (market_id)** to avoid leakage from near-resolution prices (a
parameter, default earliest; a TTR-stratified view also reported).

**Computes:**
- Global Brier = mean((yes_price − outcome_yes)²) and log-loss.
- **Reliability curve**: bin by `yes_price` (default deciles); per bin report
  mean(price), mean(outcome), n, and deviation = mean(outcome) − mean(price).
- Conditioned variants: same, grouped by `market_type` (H-CAL-2), TTR bucket
  (H-CAL-3), liquidity/score quantile (H-CAL-4).
- **Edge read**: a bin with |deviation| > cost is a candidate directional edge
  (buy if outcome > price + cost, sell if outcome < price − cost). Significance
  via bootstrap IC on the per-bin deviation.

**Output:** one `Verdict` per slice (overall + per conditioning), the reliability
tables (CSV), and the scoreboard row(s). `edge_net_pct` = the best
cost-clearing bin deviation; `class_metric` = {brier, logloss, n_bins_edged}.

**Caveats surfaced automatically:** the panel is currently **96% event_long**
(2,134 / 2,165 resolved) — H-CAL-2 will be near-empty for other types until the
panel matures. The runner flags any slice with n below a floor as `inconclusive`,
not `fail`.

**Tests** (TDD, `node`-style self-contained or pytest):
1. Perfectly-calibrated synthetic set → Brier ≈ p(1−p) baseline, all bins
   deviation ≈ 0, status `fail` (no edge) — calibration is good = no edge.
2. Known-biased synthetic (longshots underpriced) → the low band shows positive
   deviation > cost, status `pass`.
3. Below-floor slice → `inconclusive`, not `fail`.
4. Determinism: same input + same passed-in timestamp → identical Verdict.
5. Cost gate: a bin with deviation < cost → not counted as edge.

## 9. Risks / limitations

- **Panel skew**: event_long dominates; cross-type calibration is thin until the
  weekly panel accumulates more types. Mitigation: report n, mark thin slices
  inconclusive; the panel keeps growing weekly.
- **In-sample**: calibration over a forward-collected but still-young panel
  (3 weeks). Treat v1 reads as directional, not final; re-run as data grows.
- **Market-making data**: only top-of-book bid/ask/spread, no depth or real
  fills — H-MM verdicts are first-order viability, explicitly caveated.
- **Leakage**: using near-resolution snapshots would inflate calibration;
  mitigated by the earliest-snapshot rule + TTR stratification.

## 10. Future sub-projects (registered, specs later)

- **B**: supervised model, horizon sweep, remaining inefficiencies, ensemble.
- **C**: market-making viability + rewards research → maybe an order-book
  collector.

Each appends `Verdict`s to the same scoreboard, so the program's state is always
a single ranked table of what has edge net of cost and what doesn't.
