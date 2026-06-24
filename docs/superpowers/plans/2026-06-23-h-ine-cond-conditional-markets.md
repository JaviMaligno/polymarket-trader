# H-INE-4 Conditional/Dependent Market Staleness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure whether a market B that is logically dependent on a resolved market A stays stale after A resolves, yielding edge net of cost when traded in B's implied direction and held to resolution — as a cost-aware OOS harness hypothesis (H-INE-4).

**Architecture:** A pure-Python validator (`validators/conditional.py`) consumes a `conditional_events` dataframe (one row per A-resolution event with B's stale entry price + B's eventual outcome) and emits cost-aware `Verdict`s by cohort, exactly like `validators/flb.py`. The events dataframe is produced offline: an LLM proposes dependent pairs from the resolved-market catalog (`conditional_pairs.csv`, a committed artifact), and a SQL export joins those pairs to `flb_backtest_prices` + `markets` to compute entry/outcome rows. Self-contained: only Polymarket data already in the DB.

**Tech Stack:** Python 3.13 + pandas + numpy + pytest (the existing `scripts/edge-research` harness); psql CSV export on the VM; the harness `--datasets-dir` offline mode.

---

## File structure

- **Create** `scripts/edge-research/validators/conditional.py` — the H-INE-4 validator (pure logic).
- **Create** `scripts/edge-research/tests/test_conditional.py` — TDD tests for the validator.
- **Modify** `scripts/edge-research/data.py` — add `load_conditional_events` (DB) + offline CSV path.
- **Modify** `scripts/edge-research/tests/test_data.py` — test the offline CSV loader for the new dataset.
- **Modify** `scripts/edge-research/registry.yaml` — point H-INE-4 at `conditional_events`.
- **Modify** `scripts/edge-research/run.py` — wire `H-INE-4 → ConditionalValidator`.
- **Modify** `scripts/edge-research/tests/test_run.py` — assert H-INE-4 runs when its data is present.
- **Create** `scripts/edge-research/conditional_catalog.sql` — export resolved-market catalog for LLM pairing.
- **Create** `scripts/edge-research/conditional_events.sql` — join pairs → prices → events rows.
- **Create** `scripts/edge-research/CONDITIONAL_PAIRING.md` — the LLM pairing procedure (how to make `conditional_pairs.csv`).

## The `conditional_events` dataframe contract (the validator's input)

One row per (pair, entry_offset) where A resolved before B and A's outcome makes B determinate:

| column | type | meaning |
|---|---|---|
| `pair_id` | str | stable id of the (A,B) pair |
| `relation` | str | `implies_yes` \| `implies_no` \| `mutual_exclusion` |
| `market_type_b` | str | B's market_type (cohort) |
| `t_a` | datetime (UTC) | A's `resolved_at` |
| `outcome_a` | int | A's resolved outcome (1=yes, 0=no) |
| `entry_offset` | str | `1h` \| `1d` (when B's entry price was sampled after `t_a`) |
| `b_entry_price` | float | B's first `yes_price` at/after `t_a + entry_offset` |
| `b_implied_value` | int | B's logically-implied value once A's outcome is known (0 or 1) |
| `b_outcome` | int | B's eventual resolved outcome (1=yes, 0=no) |
| `b_resolved_at` | datetime (UTC) | B's `resolved_at` |
| `hold_days` | float | `(b_resolved_at − t_a)` in days |

Only events where A's outcome yields a determinate `b_implied_value` are emitted (e.g. `implies_yes` fires only when `outcome_a=1`). The trade direction is **long B if `b_implied_value=1`, short B if `b_implied_value=0`**.

---

### Task 1: Validator core — headline net edge (TDD)

**Files:**
- Create: `scripts/edge-research/validators/conditional.py`
- Test: `scripts/edge-research/tests/test_conditional.py`

- [ ] **Step 1: Write the failing test**

```python
# scripts/edge-research/tests/test_conditional.py
import numpy as np, pandas as pd, types
from validators.conditional import ConditionalValidator


def _ctx(df, min_n=3, cond_cost=0.0054):
    return types.SimpleNamespace(datasets={"conditional_events": df},
                                 cost=0.005, computed_at="t", seed=7,
                                 min_n=min_n, cond_cost=cond_cost)


def _ev(relation, b_entry_price, b_implied_value, b_outcome,
        market_type_b="event_short", entry_offset="1h"):
    return {"pair_id": "p", "relation": relation, "market_type_b": market_type_b,
            "t_a": pd.Timestamp("2026-01-01", tz="UTC"), "outcome_a": 1,
            "entry_offset": entry_offset, "b_entry_price": b_entry_price,
            "b_implied_value": b_implied_value, "b_outcome": b_outcome,
            "b_resolved_at": pd.Timestamp("2026-01-08", tz="UTC"), "hold_days": 7.0}


def _frame(rows):
    df = pd.DataFrame(rows)
    df["pair_id"] = [f"p{i}" for i in range(len(df))]
    return df


def test_headline_long_stale_b_is_profitable_and_passes():
    # implied YES (=1), B stale low at 0.60, resolves YES(1): gross = 1-0.60 = 0.40
    # net = 0.40 - 0.0054 > 0; a significant positive cohort passes.
    rows = [_ev("implies_yes", 0.60, 1, 1) for _ in range(50)]
    v = ConditionalValidator().run(_ctx(_frame(rows)))
    headline = [x for x in v if x.class_metric["slice"] == "headline"][0]
    assert headline.hypothesis_id == "H-INE-4"
    assert headline.n == 50
    assert headline.edge_insample_pct > 0.39 and headline.edge_insample_pct < 0.41   # gross
    assert headline.edge_net_pct > 0                                                  # net
    assert headline.status == "pass"


def test_short_direction_uses_correct_sign():
    # implied NO (=0), B stale high at 0.30, resolves NO(0): gross = 0.30-0 = 0.30
    rows = [_ev("implies_no", 0.30, 0, 0) for _ in range(50)]
    v = ConditionalValidator().run(_ctx(_frame(rows)))
    headline = [x for x in v if x.class_metric["slice"] == "headline"][0]
    assert abs(headline.edge_insample_pct - 0.30) < 1e-6
    assert headline.status == "pass"


def test_efficient_b_no_staleness_fails_on_cost():
    # B already at implied value (1.0), resolves YES(1): gross 0, net = -cost → fail
    rows = [_ev("implies_yes", 1.0, 1, 1) for _ in range(50)]
    v = ConditionalValidator().run(_ctx(_frame(rows)))
    headline = [x for x in v if x.class_metric["slice"] == "headline"][0]
    assert headline.edge_net_pct < 0
    assert headline.status == "fail"


def test_below_floor_is_inconclusive():
    rows = [_ev("implies_yes", 0.60, 1, 1) for _ in range(2)]
    v = ConditionalValidator().run(_ctx(_frame(rows), min_n=200))
    headline = [x for x in v if x.class_metric["slice"] == "headline"][0]
    assert headline.status == "inconclusive"
    assert headline.n == 2
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/edge-research && python -m pytest tests/test_conditional.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'validators.conditional'`

- [ ] **Step 3: Write minimal implementation**

```python
# scripts/edge-research/validators/conditional.py
from __future__ import annotations
import numpy as np
from verdict import Verdict
from validators.base import bootstrap_ci


class ConditionalValidator:
    """H-INE-4: conditional/dependent market staleness.

    After market A resolves, a logically-dependent market B has a determinate
    implied value (`b_implied_value` ∈ {0,1}). We enter B in the implied direction
    at its first price after `t_a + entry_offset` and hold to resolution. Per-event
    gross return is `(b_outcome - b_entry_price)` when implied YES (long) and
    `(b_entry_price - b_outcome)` when implied NO (short). Net subtracts a flat
    one-way entry cost. `pass` only on a positive, bootstrap-significant NET mean
    with n >= floor. edge_insample_pct = gross mean, edge_net_pct = net mean, so
    the scoreboard shows the friction side by side (as FLB does).
    """

    hypothesis_id = "H-INE-4"
    hclass = "inefficiency"

    def required_inputs(self) -> list[str]:
        return ["conditional_events"]

    def run(self, ctx) -> list[Verdict]:
        df = ctx.datasets["conditional_events"].copy()
        # directional gross return in B's frame
        long = df["b_implied_value"].astype(int) == 1
        df["gross"] = np.where(
            long, df["b_outcome"] - df["b_entry_price"],
            df["b_entry_price"] - df["b_outcome"]).astype(float)
        df["staleness"] = (df["b_entry_price"] - df["b_implied_value"]).abs().astype(float)

        cohorts: list[tuple[str, object]] = [("headline", df.index == df.index)]
        for rel in sorted(df["relation"].dropna().unique()):
            cohorts.append((f"relation:{rel}", df["relation"] == rel))
        for mt in sorted(df["market_type_b"].dropna().unique()):
            cohorts.append((f"type:{mt}", df["market_type_b"] == mt))
        for off in sorted(df["entry_offset"].dropna().unique()):
            cohorts.append((f"offset:{off}", df["entry_offset"] == off))
        return [self._verdict(ctx, df[m], label) for label, m in cohorts]

    def _verdict(self, ctx, sub, label) -> Verdict:
        floor = getattr(ctx, "min_n", 200)
        cost = getattr(ctx, "cond_cost", 0.0054)
        n = len(sub)
        if n < floor:
            return Verdict(self.hypothesis_id, self.hclass, n, None, None, None,
                           "full", {"slice": label}, "real_one_way", "inconclusive",
                           [f"n={n} below floor {floor}"], ctx.computed_at)
        gross = sub["gross"].to_numpy(float)
        net = gross - cost
        gmean, nmean = float(gross.mean()), float(net.mean())
        lo, hi = bootstrap_ci(net, seed=ctx.seed)
        status = "pass" if (nmean > 0 and lo > 0) else "fail"
        return Verdict(self.hypothesis_id, self.hclass, n, nmean, gmean,
                       float((hi - lo) / 2), "full",
                       {"slice": label, "staleness": float(sub["staleness"].mean()),
                        "avg_hold_days": float(sub["hold_days"].mean())},
                       "real_one_way", status, [], ctx.computed_at)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/edge-research && python -m pytest tests/test_conditional.py -q`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add scripts/edge-research/validators/conditional.py scripts/edge-research/tests/test_conditional.py
git commit -m "feat(edge-research): H-INE-4 conditional staleness validator (cost-aware, cohorts)"
```

---

### Task 2: OOS temporal cohort (TDD)

The spec requires an out-of-sample read. Add an `oos` cohort: when headline `n >= 2*floor`, split events at the median `t_a` and emit the later half as `oos` (the decision-relevant verdict). Below `2*floor`, emit `oos` as inconclusive with a clear caveat (supply too thin to split) rather than silently dropping it.

**Files:**
- Modify: `scripts/edge-research/validators/conditional.py`
- Test: `scripts/edge-research/tests/test_conditional.py`

- [ ] **Step 1: Write the failing test**

```python
# append to tests/test_conditional.py
def test_oos_cohort_present_and_inconclusive_when_thin():
    rows = [_ev("implies_yes", 0.60, 1, 1) for _ in range(50)]
    v = ConditionalValidator().run(_ctx(_frame(rows), min_n=30))  # floor 30, n=50 < 60
    oos = [x for x in v if x.class_metric["slice"] == "oos"][0]
    assert oos.status == "inconclusive"
    assert any("split" in c for c in oos.n_caveats)


def test_oos_cohort_splits_when_enough():
    rng = np.random.default_rng(1)
    rows = []
    for i in range(80):
        rows.append(_ev("implies_yes", float(0.55 + rng.normal(0, 0.01)), 1, 1))
    df = _frame(rows)
    df["t_a"] = pd.to_datetime(
        ["2026-01-%02d" % (1 + (i % 28)) for i in range(len(df))], utc=True)
    v = ConditionalValidator().run(_ctx(df, min_n=30))  # 2*floor=60, n=80 → split
    oos = [x for x in v if x.class_metric["slice"] == "oos"][0]
    assert oos.n == 40                      # later half
    assert oos.status in ("pass", "fail")   # measured, not inconclusive
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/edge-research && python -m pytest tests/test_conditional.py -k oos -q`
Expected: FAIL (no `oos` slice emitted)

- [ ] **Step 3: Write minimal implementation**

Add to `ConditionalValidator.run`, immediately before the `return`:

```python
        # OOS temporal cohort: later half by t_a (the decision verdict).
        floor = getattr(ctx, "min_n", 200)
        verdicts = [self._verdict(ctx, df[m], label) for label, m in cohorts]
        if len(df) >= 2 * floor:
            ordered = df.sort_values("t_a")
            later = ordered.iloc[len(ordered) // 2:]
            verdicts.append(self._verdict(ctx, later, "oos"))
        else:
            verdicts.append(Verdict(
                self.hypothesis_id, self.hclass, len(df), None, None, None, "full",
                {"slice": "oos"}, "real_one_way", "inconclusive",
                [f"n={len(df)} below 2*floor {2*floor}; cannot split out-of-sample"],
                ctx.computed_at))
        return verdicts
```

Remove the old `return [self._verdict(...) for label, m in cohorts]` line (replaced by the block above).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/edge-research && python -m pytest tests/test_conditional.py -q`
Expected: PASS (6 passed)

- [ ] **Step 5: Commit**

```bash
git add scripts/edge-research/validators/conditional.py scripts/edge-research/tests/test_conditional.py
git commit -m "feat(edge-research): H-INE-4 OOS temporal cohort (later-half by t_a)"
```

---

### Task 3: data.py loader + offline CSV path (TDD)

**Files:**
- Modify: `scripts/edge-research/data.py`
- Test: `scripts/edge-research/tests/test_data.py`

- [ ] **Step 1: Write the failing test**

```python
# append to tests/test_data.py
import pathlib
from data import load_all_datasets_from_dir

def test_conditional_events_loaded_from_dir(tmp_path):
    pd.DataFrame({
        "pair_id": ["p0", "p1"],
        "relation": ["implies_yes", "implies_no"],
        "market_type_b": ["event_short", "event_financial"],
        "t_a": ["2026-01-01T00:00:00+00", "2026-01-02T00:00:00+00"],
        "outcome_a": [1, 1],
        "entry_offset": ["1h", "1d"],
        "b_entry_price": [0.60, 0.30],
        "b_implied_value": [1, 0],
        "b_outcome": [1, 0],
        "b_resolved_at": ["2026-01-08T00:00:00+00", "2026-01-09T00:00:00+00"],
        "hold_days": [7.0, 7.0],
    }).to_csv(tmp_path / "conditional_events.csv", index=False)
    out = load_all_datasets_from_dir(str(tmp_path))
    df = out["conditional_events"]
    assert df is not None and len(df) == 2
    assert str(df["t_a"].dt.tz) == "UTC"

def test_conditional_events_missing_maps_to_none(tmp_path):
    out = load_all_datasets_from_dir(str(tmp_path))
    assert out["conditional_events"] is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/edge-research && python -m pytest tests/test_data.py -k conditional -q`
Expected: FAIL with `KeyError: 'conditional_events'`

- [ ] **Step 3: Write minimal implementation**

In `data.py`, add the SQL + loader near the FLB loader:

```python
# --- conditional_events: dependent-market staleness rows (H-INE-4 validator) ---

CONDITIONAL_EVENTS_SQL = """
  SELECT pair_id, relation, market_type_b, t_a, outcome_a, entry_offset,
         b_entry_price, b_implied_value, b_outcome, b_resolved_at, hold_days
  FROM conditional_events
"""

def load_conditional_events(database_url: str | None = None) -> pd.DataFrame:
    return _read(CONDITIONAL_EVENTS_SQL, database_url)
```

Add it to `_LOADERS`:

```python
_LOADERS = {
    "market_panel_resolved": load_market_panel,
    "market_panel_full": load_market_panel_full,
    "flb_shadow_signals": load_flb_shadow,
    "conditional_events": load_conditional_events,
}
```

Add the offline CSV branch inside `load_all_datasets_from_dir`, before `return out`:

```python
    try:
        cond = _read_raw_csv(d / "conditional_events.csv", ["t_a", "b_resolved_at"])
        out["conditional_events"] = cond if len(cond) else None
    except Exception:
        out["conditional_events"] = None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/edge-research && python -m pytest tests/test_data.py -k conditional -q`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add scripts/edge-research/data.py scripts/edge-research/tests/test_data.py
git commit -m "feat(edge-research): conditional_events loader + offline CSV path"
```

---

### Task 4: Registry + run.py wiring (TDD)

**Files:**
- Modify: `scripts/edge-research/registry.yaml:` (the H-INE-4 line)
- Modify: `scripts/edge-research/run.py` (imports + `VALIDATORS`)
- Test: `scripts/edge-research/tests/test_run.py`

- [ ] **Step 1: Write the failing test**

```python
# append to tests/test_run.py
import pandas as pd
from run import run_validators

def test_h_ine_4_runs_when_conditional_events_present():
    df = pd.DataFrame({
        "pair_id": [f"p{i}" for i in range(5)],
        "relation": ["implies_yes"] * 5, "market_type_b": ["event_short"] * 5,
        "t_a": pd.to_datetime(["2026-01-01"] * 5, utc=True), "outcome_a": [1] * 5,
        "entry_offset": ["1h"] * 5, "b_entry_price": [0.6] * 5,
        "b_implied_value": [1] * 5, "b_outcome": [1] * 5,
        "b_resolved_at": pd.to_datetime(["2026-01-08"] * 5, utc=True),
        "hold_days": [7.0] * 5,
    })
    res = run_validators({"conditional_events": df}, "t")
    ids = {v.hypothesis_id for v in res["verdicts"]}
    assert "H-INE-4" in ids
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/edge-research && python -m pytest tests/test_run.py -k h_ine_4 -q`
Expected: FAIL (H-INE-4 not in verdicts — no validator wired; it lands in `pending`)

- [ ] **Step 3: Write minimal implementation**

In `registry.yaml`, replace the H-INE-4 line with:

```yaml
- {id: H-INE-4, class: inefficiency, name: Conditional/dependent market staleness, required_data: [conditional_events], status: planned, priority: 2, depends_on: []}
```

In `run.py`, add the import after the other validator imports:

```python
from validators.conditional import ConditionalValidator
```

And add to the `VALIDATORS` dict:

```python
              "H-INE-4": ConditionalValidator,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/edge-research && python -m pytest tests/test_run.py -q`
Expected: PASS

- [ ] **Step 5: Run the full suite + commit**

Run: `cd scripts/edge-research && python -m pytest -q`
Expected: PASS (all prior + new tests green)

```bash
git add scripts/edge-research/registry.yaml scripts/edge-research/run.py scripts/edge-research/tests/test_run.py
git commit -m "feat(edge-research): wire H-INE-4 ConditionalValidator + registry data token"
```

---

### Task 5: Catalog export SQL (for LLM pairing input)

**Files:**
- Create: `scripts/edge-research/conditional_catalog.sql`

- [ ] **Step 1: Write the SQL**

```sql
-- Resolved-market catalog for conditional-pair identification (LLM input).
-- One row per resolved market with the fields the LLM needs to spot logical
-- dependence between markets, plus event_id so the export can drop same-event
-- (negRisk-netted) pairs. Only markets with usable price history and a clean
-- yes/no resolution.
COPY (
  SELECT m.id AS market_id, m.event_id, m.market_type, m.question,
         e.title AS event_title, e.category AS event_category,
         m.end_date, m.resolved_at,
         (m.resolution_outcome = 'yes')::int AS outcome_yes
  FROM markets m
  LEFT JOIN events e ON e.id = m.event_id
  WHERE m.is_resolved = true
    AND m.resolution_outcome IN ('yes', 'no')
    AND m.resolved_at IS NOT NULL
    AND EXISTS (SELECT 1 FROM flb_backtest_prices p WHERE p.market_id = m.id)
  ORDER BY e.category NULLS LAST, m.event_id, m.resolved_at
) TO STDOUT WITH CSV HEADER;
```

- [ ] **Step 2: Dry-run the SQL on the VM and sanity-check the row count**

Run (note: stop nothing — this is a light catalog read, but if the VM is loaded, prefer a quiet moment):
```bash
gcloud compute scp scripts/edge-research/conditional_catalog.sql polymarket-vm:/tmp/cc.sql --zone=us-east1-b
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker exec -i polymarket-timescaledb psql -U polymarket -d polymarket_trading -q -v ON_ERROR_STOP=1 < /tmp/cc.sql" > /tmp/conditional_catalog.csv
wc -l /tmp/conditional_catalog.csv
```
Expected: a header + N rows (N = resolved markets with price history; hundreds–thousands). If 0, the join/filters are wrong — fix before continuing.

- [ ] **Step 3: Commit**

```bash
git add scripts/edge-research/conditional_catalog.sql
git commit -m "feat(edge-research): conditional_catalog.sql — resolved-market export for pairing"
```

---

### Task 6: LLM pairing procedure → `conditional_pairs.csv`

**Files:**
- Create: `scripts/edge-research/CONDITIONAL_PAIRING.md`
- Create (artifact, committed): `scripts/edge-research/conditional_pairs.csv`

This step turns the catalog into a vetted pairs table. It is LLM-assisted and run once; the output is committed so the export and backtest are deterministic.

- [ ] **Step 1: Write the procedure doc**

```markdown
# Conditional-pair identification (H-INE-4)

Input: `conditional_catalog.csv` (from `conditional_catalog.sql`).
Output: `conditional_pairs.csv` with columns
`pair_id,market_id_a,market_id_b,relation` where `relation ∈
{implies_yes, implies_no, mutual_exclusion}` and the semantics are:

- `implies_yes`  : A resolving YES forces B to YES (B should → 1).
- `implies_no`   : A resolving YES forces B to NO  (B should → 0).
- `mutual_exclusion`: A and B cannot both be YES (A YES → B NO → 0), for pairs
  in DIFFERENT events (same-event sets are dropped by the export's negRisk guard).

Procedure:
1. Group catalog rows by `event_category` then scan for cross-event logical links
   (e.g. a primary-winner market A and a general-election market B for the same
   entity; a "wins ≥ N seats" market and a "wins majority" market).
2. For each candidate, record A (the EARLIER-resolving market), B (the later),
   and the relation. Only include pairs where A's YES outcome makes B determinate.
3. Do NOT pair two markets with the same `event_id` (the export drops them, but
   skipping saves effort) — those are negRisk-netted and dead (H-ARB-2).
4. Be conservative: a wrong pair costs recall (the export re-checks A-before-B,
   determinacy, and price availability mechanically), but obviously-bogus pairs
   waste backtest rows. Aim for precision; the harness floor (n≥200) needs volume,
   so prefer broad but defensible families (politics, sports brackets, tiered
   numeric thresholds on the same subject).
5. Save as `conditional_pairs.csv`. Commit it.
```

- [ ] **Step 2: Generate `conditional_pairs.csv`**

Run the pairing over `/tmp/conditional_catalog.csv` per the procedure (LLM-assisted, in this session — read the catalog, emit the CSV). Ensure the header is exactly `pair_id,market_id_a,market_id_b,relation` and `pair_id` values are unique.

Sanity check:
```bash
head -1 scripts/edge-research/conditional_pairs.csv     # exact header
wc -l scripts/edge-research/conditional_pairs.csv       # pair count
cut -d, -f4 scripts/edge-research/conditional_pairs.csv | sort | uniq -c   # relation mix
```
Expected: header correct; ≥ a few hundred pairs if supply allows (report the count honestly — a thin count is itself a finding per the spec's "pair supply tiny" risk).

- [ ] **Step 3: Commit**

```bash
git add scripts/edge-research/CONDITIONAL_PAIRING.md scripts/edge-research/conditional_pairs.csv
git commit -m "feat(edge-research): conditional pairing procedure + vetted pairs artifact"
```

---

### Task 7: Events export SQL (pairs → prices → events)

**Files:**
- Create: `scripts/edge-research/conditional_events.sql`

This SQL reads the committed pairs (loaded into a temp table on the VM), joins to `markets` (resolution facts) and `flb_backtest_prices` (B's stale entry price), applies the negRisk guard and determinacy filter, and emits the `conditional_events` rows for two entry offsets (1h, 1d).

- [ ] **Step 1: Write the SQL**

```sql
-- conditional_events export (H-INE-4). Expects the pairs CSV pre-loaded into a
-- TEMP table `cp(pair_id, market_id_a, market_id_b, relation)` by the caller:
--   \copy cp FROM '/tmp/conditional_pairs.csv' WITH CSV HEADER
-- so this script is wrapped by the export step (see the run command in Task 8).
--
-- Determinacy: only A's YES outcome makes B determinate for the relations we use,
-- so we require outcome_a = 1. b_implied_value = 1 for implies_yes, else 0.
-- negRisk guard: drop pairs whose A and B share an event_id (netted sum-arb).
-- Entry price: B's first flb_backtest_prices.yes_price at/after t_a + offset.
WITH base AS (
  SELECT cp.pair_id, cp.relation,
         a.id AS a_id, a.resolved_at AS t_a,
         (a.resolution_outcome = 'yes')::int AS outcome_a,
         b.id AS b_id, b.market_type AS market_type_b,
         b.resolved_at AS b_resolved_at,
         (b.resolution_outcome = 'yes')::int AS b_outcome,
         CASE WHEN cp.relation = 'implies_yes' THEN 1 ELSE 0 END AS b_implied_value
  FROM cp
  JOIN markets a ON a.id = cp.market_id_a
  JOIN markets b ON b.id = cp.market_id_b
  WHERE a.is_resolved AND b.is_resolved
    AND a.resolution_outcome = 'yes'            -- determinate round only
    AND b.resolution_outcome IN ('yes','no')
    AND a.resolved_at IS NOT NULL AND b.resolved_at IS NOT NULL
    AND a.resolved_at < b.resolved_at           -- A resolves before B
    AND a.event_id IS DISTINCT FROM b.event_id  -- negRisk guard
),
offsets AS (
  SELECT * FROM (VALUES ('1h', INTERVAL '1 hour'), ('1d', INTERVAL '1 day')) AS o(entry_offset, dt)
)
COPY (
  SELECT base.pair_id, base.relation, base.market_type_b,
         base.t_a, base.outcome_a, o.entry_offset,
         (SELECT p.yes_price FROM flb_backtest_prices p
          WHERE p.market_id = base.b_id AND p.ts >= base.t_a + o.dt
          ORDER BY p.ts ASC LIMIT 1) AS b_entry_price,
         base.b_implied_value, base.b_outcome, base.b_resolved_at,
         EXTRACT(EPOCH FROM (base.b_resolved_at - base.t_a)) / 86400.0 AS hold_days
  FROM base CROSS JOIN offsets o
  WHERE EXISTS (SELECT 1 FROM flb_backtest_prices p
                WHERE p.market_id = base.b_id AND p.ts >= base.t_a + o.dt)
) TO STDOUT WITH CSV HEADER;
```

- [ ] **Step 2: Commit**

```bash
git add scripts/edge-research/conditional_events.sql
git commit -m "feat(edge-research): conditional_events.sql — pairs+prices → backtest rows"
```

---

### Task 8: First end-to-end manual run + read the verdict

**Files:** none (operational). Produces the first H-INE-4 scoreboard rows.

- [ ] **Step 1: Export `conditional_events.csv` from the VM**

```bash
# pre-load pairs into a temp table, run the events SQL, capture CSV locally
gcloud compute scp scripts/edge-research/conditional_pairs.csv polymarket-vm:/tmp/conditional_pairs.csv --zone=us-east1-b
gcloud compute scp scripts/edge-research/conditional_events.sql polymarket-vm:/tmp/ce.sql --zone=us-east1-b
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker cp /tmp/conditional_pairs.csv polymarket-timescaledb:/tmp/conditional_pairs.csv; docker exec -i polymarket-timescaledb psql -U polymarket -d polymarket_trading -q -v ON_ERROR_STOP=1 -c \"CREATE TEMP TABLE cp(pair_id text, market_id_a text, market_id_b text, relation text); \\copy cp FROM '/tmp/conditional_pairs.csv' WITH CSV HEADER\" -f -" < scripts/edge-research/conditional_events.sql > scripts/edge-research/datasets/conditional_events.csv
wc -l scripts/edge-research/datasets/conditional_events.csv
```
Note: if the single-session temp-table + `-f -` combination is awkward, fall back to wrapping both statements in one `.sql` file (CREATE TEMP + \copy + the events query) and pipe that via `docker exec -i … < file`. The temp table and the query MUST run in the same psql session.
Expected: header + N event rows. N=0 ⇒ no determinate pairs had B price history at the offsets — report it (a real "thin supply" finding), don't fake rows.

- [ ] **Step 2: Run the harness on the new dataset**

```bash
cd scripts/edge-research
python run.py --datasets-dir datasets --out out --computed-at 2026-06-23T00:00:00Z
```
Expected: `Wrote out/scoreboard.md (... verdicts ...)` including H-INE-4 rows.

- [ ] **Step 3: Read the H-INE-4 verdict with cohort labels**

```bash
cd scripts/edge-research
python -c "
import run
from data import load_all_datasets_from_dir
from validators.conditional import ConditionalValidator
ds = load_all_datasets_from_dir('datasets')
ctx = run._ctx(ds, '2026-06-23T00:00:00Z')
for v in ConditionalValidator().run(ctx):
    c = v.class_metric['slice']; net = v.edge_net_pct; gr = v.edge_insample_pct
    print(f'{c:28s} n={v.n:5d} gross={gr if gr is None else round(gr,4)} net={net if net is None else round(net,4)} {v.status}')
"
```
Expected: per-cohort gross/net/status. **Decision:** the `oos` and `headline` cohorts at `n ≥ 200` with `net > 0` and `status=pass` ⇒ candidate edge → next step (forward/paper validation, its own sub-project). All `fail`/`inconclusive` ⇒ record the failure mode (thin supply vs no-staleness `gross≈0` vs cost) and move to H-INE-NEWS.

- [ ] **Step 4: Commit the scoreboard + a short findings note**

```bash
git add scripts/edge-research/out/scoreboard.md scripts/edge-research/out/scoreboard.csv
git commit -m "chore(edge-research): first H-INE-4 conditional-staleness scoreboard"
```

---

## Notes for the executor

- Run everything from `scripts/edge-research` (the harness root; `conftest.py` adds it to `sys.path`).
- The VM (e2-micro, 1GB) is I/O-fragile — see the H-MM-4 export saga. The conditional exports are far lighter (no `mm_book_events` 4M-row temp; B-price lookups hit `idx_flb_bt (market_id, ts)`), but if any export hangs, do NOT pile on; the catalog/events reads should be seconds. Use `docker exec -d` + a sentinel only if a read unexpectedly exceeds a couple of minutes.
- Weekly-cron wiring (exporting `conditional_events.csv` in `edge-research-weekly.yml`) is DEFERRED until after the first manual verdict, mirroring how every other MM/FLB dataset was added — do not wire the cron in this plan.
- `conditional_pairs.csv` is the one non-deterministic artifact; once committed it makes the whole pipeline reproducible.
