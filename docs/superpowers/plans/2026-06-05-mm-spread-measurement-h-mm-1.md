# H-MM-1 Market-Making Spread Measurement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land an H-MM-1 verdict per `market_type` on the edge-research scoreboard, measuring whether a passive market-maker retains positive spread after adverse selection — from already-collected `trades` + `orderbook_snapshots`, no new collection.

**Architecture:** A heavy asof-join (trades → book mid before/after) runs in SQL on the VM, exports a sampled CSV; a Python validator consumes it via the harness's offline `--datasets-dir` mode and emits a `Verdict` under the same bootstrap-significant, cost-aware bar as the other vías. The realized-spread decomposition (Lee-Ready quote test) splits each trade's half-spread into `eff_half` (gross), `real_half` (maker-retained ≈ revenue), `impact_half` (adverse selection).

**Tech Stack:** Python 3.13 + pandas/numpy (harness), PostgreSQL/TimescaleDB (VM, SQL export), pytest.

**Base branch:** This builds on the harness state from PR #315 (the `--datasets-dir` offline mode, `load_all_datasets_from_dir`, and the `VALIDATORS` dict in `run.py`). Base this work on `edge-research-automation-ine5` (or on `main` after #315 merges). The spec lives at `docs/superpowers/specs/2026-06-05-mm-spread-measurement-h-mm-1-design.md`.

**Reference — the `Verdict` contract** (`scripts/edge-research/verdict.py`), positional order used throughout:
`Verdict(hypothesis_id, hclass, n, edge_net_pct, edge_insample_pct, significance, split, class_metric, cost_model, status, n_caveats, computed_at)`. `bootstrap_ci(x, n_boot=1000, seed=0, alpha=0.05)` lives in `scripts/edge-research/validators/base.py` and returns `(lo, hi)`.

All `pytest` commands run from `scripts/edge-research/` (where `tests/conftest.py` adds the package dir to `sys.path`). Ignore the harmless `RequestsDependencyWarning` urllib3 line in output.

---

## Task 1: Offline CSV loader for `mm_trade_spreads`

The harness loads datasets from raw CSVs in `--datasets-dir` mode. Add the
`mm_trade_spreads` token. It is a **CSV-mode-only** dataset (the asof-join is too
heavy to run in the DB-mode `load_all_datasets`, and the dashboard container has no
Python), so it is added to `load_all_datasets_from_dir` only, NOT to `_LOADERS`.

**Files:**
- Modify: `scripts/edge-research/data.py` (inside `load_all_datasets_from_dir`)
- Test: `scripts/edge-research/tests/test_data.py`

- [ ] **Step 1: Write the failing test**

Append to `scripts/edge-research/tests/test_data.py`:

```python
def test_load_from_dir_reads_mm_trade_spreads(tmp_path):
    pd.DataFrame({
        "market_id": ["a", "b"],
        "market_type": ["crypto_intraday", "event_long"],
        "token_id": ["t1", "t2"],
        "time": ["2026-06-04T10:00:00Z", "2026-06-04T10:05:00Z"],
        "size": [100.0, 50.0],
        "eff_half": [0.012, 0.020],
        "real_half": [0.004, -0.001],
        "impact_half": [0.008, 0.021],
    }).to_csv(tmp_path / "mm_trade_spreads.csv", index=False)
    out = load_all_datasets_from_dir(str(tmp_path))
    mm = out["mm_trade_spreads"]
    assert mm is not None
    assert len(mm) == 2
    assert set(["market_type", "real_half", "eff_half", "impact_half", "size"]).issubset(mm.columns)
    assert abs(float(mm.iloc[0]["real_half"]) - 0.004) < 1e-9


def test_load_from_dir_mm_missing_maps_to_none(tmp_path):
    # market_panel present, mm file absent → mm token is None, others unaffected
    pd.DataFrame({
        "market_id": ["m1"], "snapshot_at": ["2026-05-19"], "end_date": ["2026-05-29"],
        "yes_price": [0.10], "market_type": ["event_long"], "market_score": [0.5],
        "outcome_yes": [1],
    }).to_csv(tmp_path / "market_panel.csv", index=False)
    out = load_all_datasets_from_dir(str(tmp_path))
    assert out["mm_trade_spreads"] is None
    assert out["market_panel_resolved"] is not None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_data.py -q`
Expected: FAIL — `KeyError: 'mm_trade_spreads'` (key not produced by the loader).

- [ ] **Step 3: Add the loader branch**

In `scripts/edge-research/data.py`, inside `load_all_datasets_from_dir`, after the
existing `flb_shadow_signals` try/except block and before `return out`, add:

```python
    try:
        mm = _read_raw_csv(d / "mm_trade_spreads.csv", ["time"])
        out["mm_trade_spreads"] = mm if len(mm) else None
    except Exception:
        out["mm_trade_spreads"] = None
```

(The existing `_read_raw_csv(path, date_cols)` helper parses the listed date
columns and returns the frame; numeric columns load as floats from the CSV. No
`_LOADERS` entry is added — `mm_trade_spreads` is CSV-mode only.)

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_data.py -q`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add scripts/edge-research/data.py scripts/edge-research/tests/test_data.py
git commit -m "feat(edge-research): mm_trade_spreads offline CSV loader"
```

---

## Task 2: `MMSpreadValidator` (H-MM-1)

**Files:**
- Create: `scripts/edge-research/validators/mm.py`
- Test: `scripts/edge-research/tests/test_mm.py`

- [ ] **Step 1: Write the failing test**

Create `scripts/edge-research/tests/test_mm.py`:

```python
import numpy as np, pandas as pd, types
from validators.mm import MMSpreadValidator


def _ctx(df, mm_min_n=200, mm_maker_fee=0.0):
    return types.SimpleNamespace(datasets={"mm_trade_spreads": df},
                                 cost=0.005, computed_at="t", seed=7,
                                 mm_min_n=mm_min_n, mm_maker_fee=mm_maker_fee)


def _rows(n, market_type, real_half, eff_half, seed):
    rng = np.random.default_rng(seed)
    return pd.DataFrame({
        "market_id": [f"m{seed}_{i}" for i in range(n)],
        "market_type": [market_type] * n,
        "token_id": [f"tk{seed}"] * n,
        "time": ["2026-06-04T10:00:00Z"] * n,
        "size": np.full(n, 100.0),
        "eff_half": np.full(n, eff_half),
        "real_half": real_half + rng.normal(0, 0.001, n),
        "impact_half": np.full(n, eff_half) - real_half,
    })


def _cohort(verdicts, name):
    return [v for v in verdicts if v.class_metric.get("cohort") == name][0]


def test_positive_retained_spread_passes_and_exposes_decomposition():
    df = _rows(300, "crypto_intraday", real_half=0.004, eff_half=0.012, seed=1)
    v = MMSpreadValidator().run(_ctx(df))
    head = _cohort(v, "headline:tradeable")
    assert head.hypothesis_id == "H-MM-1"
    assert head.hclass == "market_making"
    assert head.status == "pass"
    assert head.edge_net_pct > 0
    assert abs(head.class_metric["eff_half"] - 0.012) < 1e-3
    assert abs(head.class_metric["impact_half"] - 0.008) < 1e-3


def test_adverse_selection_eats_spread_fails():
    # eff_half 0.010 but real_half negative (impact 0.012 > eff) → fail
    df = _rows(300, "crypto_intraday", real_half=-0.002, eff_half=0.010, seed=2)
    v = MMSpreadValidator().run(_ctx(df))
    head = _cohort(v, "headline:tradeable")
    assert head.status == "fail"
    assert head.edge_net_pct < 0


def test_below_floor_inconclusive():
    df = _rows(50, "crypto_intraday", real_half=0.004, eff_half=0.012, seed=3)
    v = MMSpreadValidator().run(_ctx(df))
    head = _cohort(v, "headline:tradeable")
    assert head.status == "inconclusive"
    assert head.n == 50


def test_event_long_emitted_as_own_cohort_not_in_headline():
    df = pd.concat([
        _rows(300, "crypto_intraday", real_half=0.004, eff_half=0.012, seed=4),
        _rows(300, "event_long", real_half=0.004, eff_half=0.012, seed=5),
    ], ignore_index=True)
    v = MMSpreadValidator().run(_ctx(df))
    head = _cohort(v, "headline:tradeable")
    el = _cohort(v, "event_long")
    assert head.n == 300                      # headline excludes event_long
    assert el.n == 300
    assert el.class_metric["cohort"] == "event_long"


def test_caveats_present_on_every_verdict():
    df = _rows(300, "crypto_intraday", real_half=0.004, eff_half=0.012, seed=6)
    v = MMSpreadValidator().run(_ctx(df))
    for verdict in v:
        assert any("passive-maker proxy" in c for c in verdict.n_caveats)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_mm.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'validators.mm'`.

- [ ] **Step 3: Implement the validator**

Create `scripts/edge-research/validators/mm.py`:

```python
from __future__ import annotations
from verdict import Verdict
from validators.base import bootstrap_ci

_CAVEAT = ("Δ≈10min (coarse); passive-maker proxy, not simulated fills; "
           "excludes queue priority / inventory risk / rewards (H-MM-2)")


class MMSpreadValidator:
    """H-MM-1 — passive market-maker retained spread net of adverse selection.

    From sampled trades joined to the book mid before/after (mm_trade_spreads):
    real_half is the half-spread a maker keeps after the mid moves (≈ revenue per
    share). Per market_type cohort, edge = mean(real_half) − maker_fee; the eff_half
    (gross) and impact_half (adverse selection) decomposition is exposed in
    class_metric. Headline = tradeable types pooled (market_type != event_long).
    `pass` only on a positive, bootstrap-significant mean with n >= floor.
    """

    hypothesis_id = "H-MM-1"
    hclass = "market_making"

    def required_inputs(self) -> list[str]:
        return ["mm_trade_spreads"]

    def run(self, ctx) -> list[Verdict]:
        df = ctx.datasets["mm_trade_spreads"].copy()
        df["tradeable"] = df["market_type"] != "event_long"
        cohorts = [("headline:tradeable", df[df["tradeable"]])]
        for mt in sorted(df["market_type"].unique()):
            cohorts.append((mt, df[df["market_type"] == mt]))
        return [self._cohort(ctx, label, sub) for label, sub in cohorts]

    def _cohort(self, ctx, label, sub) -> Verdict:
        floor = getattr(ctx, "mm_min_n", 200)
        fee = getattr(ctx, "mm_maker_fee", 0.0)
        cost_model = f"maker_fee_{fee}"
        n = len(sub)
        if n < floor:
            return Verdict(self.hypothesis_id, self.hclass, n, None, None, None,
                           "full", {"cohort": label}, cost_model, "inconclusive",
                           [_CAVEAT, f"n={n} below floor {floor}"], ctx.computed_at)
        real = sub["real_half"].to_numpy(float)
        edge = float(real.mean()) - fee
        lo, hi = bootstrap_ci(real - fee, seed=ctx.seed)
        status = "pass" if (edge > 0 and lo > 0) else "fail"
        meta = {"cohort": label,
                "eff_half": float(sub["eff_half"].to_numpy(float).mean()),
                "impact_half": float(sub["impact_half"].to_numpy(float).mean()),
                "avg_size": float(sub["size"].to_numpy(float).mean())}
        return Verdict(self.hypothesis_id, self.hclass, n, edge, edge,
                       float((hi - lo) / 2), "full", meta, cost_model,
                       status, [_CAVEAT], ctx.computed_at)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_mm.py -q`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/edge-research/validators/mm.py scripts/edge-research/tests/test_mm.py
git commit -m "feat(edge-research): H-MM-1 market-making spread validator"
```

---

## Task 3: Wire H-MM-1 into the runner + registry

**Files:**
- Modify: `scripts/edge-research/run.py` (import + `VALIDATORS`)
- Modify: `scripts/edge-research/registry.yaml` (H-MM-1 `required_data`)
- Test: `scripts/edge-research/tests/test_run.py`

- [ ] **Step 1: Write the failing test**

In `scripts/edge-research/tests/test_run.py`, update the H-MM-1 blocked comment and
add a dispatch test. Change the existing line in
`test_run_dispatches_calibration_and_is_deterministic`:

```python
    # H-MM-1 needs mm_trade_spreads → blocked when only the panel is available
    assert any(b["id"] == "H-MM-1" for b in r1["blocked"])
```

Then append a new test:

```python
def test_run_dispatches_mm_when_trade_spreads_available():
    mm = pd.DataFrame({
        "market_id": [f"m{i}" for i in range(300)],
        "market_type": ["crypto_intraday"] * 300,
        "token_id": ["tk"] * 300,
        "time": ["2026-06-04T10:00:00Z"] * 300,
        "size": [100.0] * 300,
        "eff_half": [0.012] * 300,
        "real_half": [0.004] * 300,
        "impact_half": [0.008] * 300,
    })
    res = run_validators({"mm_trade_spreads": mm}, computed_at="t")
    assert any(v.hypothesis_id == "H-MM-1" for v in res["verdicts"])
    assert not any(b["id"] == "H-MM-1" for b in res["blocked"])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_run.py -q`
Expected: FAIL — `test_run_dispatches_mm_when_trade_spreads_available` fails because
H-MM-1 is in `blocked` / not in `verdicts` (no validator registered, and registry
still requires `price_history_bidask`).

- [ ] **Step 3: Register the validator and rename the registry token**

In `scripts/edge-research/run.py`, add the import next to the other validator imports:

```python
from validators.mm import MMSpreadValidator
```

and add the entry to `VALIDATORS`:

```python
VALIDATORS = {"H-CAL-1": CalibrationValidator, "H-INE-1": FLBValidator,
              "H-SUP-1": SupervisedValidator, "H-ENS-1": EnsembleValidator,
              "H-INE-5": TimeDecayExtremeBandValidator,
              "H-MM-1": MMSpreadValidator}
```

In `scripts/edge-research/registry.yaml`, change the H-MM-1 line's `required_data`
from `[price_history_bidask]` to `[mm_trade_spreads]`:

```yaml
- {id: H-MM-1, class: market_making, name: Spread capture net of adverse selection, required_data: [mm_trade_spreads], status: planned, priority: 2, depends_on: []}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest -q`  (full suite)
Expected: PASS (all tests, including the existing `test_run_dispatches_calibration_and_is_deterministic` whose blocked assertion still holds — `mm_trade_spreads` is absent when only the panel is supplied).

- [ ] **Step 5: Commit**

```bash
git add scripts/edge-research/run.py scripts/edge-research/registry.yaml scripts/edge-research/tests/test_run.py
git commit -m "feat(edge-research): register H-MM-1 + retarget registry to mm_trade_spreads"
```

---

## Task 4: SQL export + first real verdict

This task is integration against the VM (no Python unit test). It produces the
export query, validates the asof-join arithmetic on real data, generates the
scoreboard verdict, and commits both the SQL and the refreshed scoreboard.

**Files:**
- Create: `scripts/edge-research/mm_trade_spreads.sql`
- Modify: `scripts/edge-research/out/scoreboard.md` (regenerated)

- [ ] **Step 1: Write the export SQL**

Create `scripts/edge-research/mm_trade_spreads.sql`. Server-side `COPY (...) TO
STDOUT` (NOT the `\copy` meta-command) so the multi-line query is allowed and
streams CSV to the client:

```sql
-- H-MM-1 export: per sampled trade, the realized-spread decomposition vs the book
-- mid before (mid_t) and after (mid_after). Sign via the quote test. 300 trades
-- per token, deterministic md5 sampling. Both join legs must exist.
COPY (
  WITH sampled AS (
    SELECT market_id, token_id, time, price, size,
           row_number() OVER (PARTITION BY token_id
                              ORDER BY md5(token_id || time::text)) AS rn
    FROM trades
    WHERE time > NOW() - INTERVAL '7 days'
  ),
  s AS (SELECT * FROM sampled WHERE rn <= 300),
  joined AS (
    SELECT s.market_id, s.token_id, s.time, s.size, s.price,
      (SELECT ob.mid_price FROM orderbook_snapshots ob
         WHERE ob.token_id = s.token_id AND ob.time <= s.time
           AND ob.mid_price IS NOT NULL
         ORDER BY ob.time DESC LIMIT 1) AS mid_t,
      (SELECT ob.mid_price FROM orderbook_snapshots ob
         WHERE ob.token_id = s.token_id AND ob.time > s.time
           AND ob.mid_price IS NOT NULL
         ORDER BY ob.time ASC LIMIT 1) AS mid_after
    FROM s
  )
  SELECT j.market_id, m.market_type, j.token_id, j.time, j.size,
         sign(j.price - j.mid_t) * (j.price - j.mid_t)     AS eff_half,
         sign(j.price - j.mid_t) * (j.price - j.mid_after) AS real_half,
         sign(j.price - j.mid_t) * (j.mid_after - j.mid_t) AS impact_half
  FROM joined j
  JOIN markets m ON m.id = j.market_id
  WHERE j.mid_t IS NOT NULL AND j.mid_after IS NOT NULL
    AND j.price <> j.mid_t
) TO STDOUT WITH CSV HEADER;
```

- [ ] **Step 2: Export the real CSV from the VM**

Run (produces `C:/Users/Usuario/edge-datasets/mm_trade_spreads.csv` alongside the
existing panel/flb exports):

```bash
gcloud compute scp scripts/edge-research/mm_trade_spreads.sql polymarket-vm:/tmp/mm.sql --zone=us-east1-b
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker cp /tmp/mm.sql polymarket-timescaledb:/tmp/mm.sql && docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -f /tmp/mm.sql" > "C:/Users/Usuario/edge-datasets/mm_trade_spreads.csv"
wc -l "C:/Users/Usuario/edge-datasets/mm_trade_spreads.csv"
head -3 "C:/Users/Usuario/edge-datasets/mm_trade_spreads.csv"
```

Expected: a header + up to ~155×300 ≈ 46k data rows; each row has numeric
`eff_half, real_half, impact_half`.

- [ ] **Step 3: Sanity-check the asof arithmetic**

Run a Python sanity check on the export (the identity must hold by construction and
signs must be classified):

```bash
python -c "import pandas as pd; d=pd.read_csv('C:/Users/Usuario/edge-datasets/mm_trade_spreads.csv'); import numpy as np; print('rows', len(d), 'tokens', d.token_id.nunique()); print('identity max err', float((d.eff_half - d.real_half - d.impact_half).abs().max())); print('mean real_half', round(d.real_half.mean(),5), 'mean eff_half', round(d.eff_half.mean(),5), 'mean impact_half', round(d.impact_half.mean(),5))"
```

Expected: `identity max err` ≈ 0 (≤ 1e-9); means printed. If `identity max err` is
not ~0, the SQL signs are inconsistent — fix the SQL before proceeding.

- [ ] **Step 4: Regenerate the scoreboard with the real verdict**

Run (uses the offline `--datasets-dir` mode added in PR #315; the dir now contains
all four CSVs):

```bash
python scripts/edge-research/run.py --datasets-dir "C:/Users/Usuario/edge-datasets" --out scripts/edge-research/out --computed-at "2026-06-05T00:00:00Z"
grep -n "H-MM-1" scripts/edge-research/out/scoreboard.md
```

Expected: `Wrote ...scoreboard.md` with one or more H-MM-1 rows visible (headline +
per-type cohorts), each carrying the passive-maker caveat.

- [ ] **Step 5: Commit**

```bash
git add scripts/edge-research/mm_trade_spreads.sql scripts/edge-research/out/scoreboard.md
git commit -m "feat(edge-research): H-MM-1 SQL export + first real-data scoreboard verdict"
```

---

## Task 5: Update memory with the verdict

**Files:**
- Modify: `C:\Users\Usuario\.claude\projects\C--Users-Usuario-github-polymarket-trader\memory\project_market_making_idea.md`
- Modify: `C:\Users\Usuario\.claude\projects\C--Users-Usuario-github-polymarket-trader\memory\project_next_levers_and_automation.md`

- [ ] **Step 1: Record the measurement outcome**

In `project_market_making_idea.md`, under Status, append a dated line stating: the
bid/ask recorder already exists (`orderbook_snapshots`, 10-min, 7-day); H-MM-1 was
measured via realized-spread decomposition; and the verdict (PASS on some cohort →
next step is a quoting-engine spike / H-MM-2 rewards; or FAIL → market-making closed
at this cadence, revisit only with finer Δ). Fill in the actual numbers from Task 4's
scoreboard (headline `edge_net_pct`, `eff_half`, `impact_half`, n).

In `project_next_levers_and_automation.md`, update the market-making section: replace
"data-blocked, build a recorder" with the corrected finding (recorder exists; H-MM-1
measured) and the verdict, linking the spec/plan.

- [ ] **Step 2: Commit (if the memory dir is a tracked repo; otherwise files persist as-is)**

Memory files persist as plain files; no commit required unless the directory is a git
repo you are tracking.

---

## Notes for the implementer

- **Numbers in caveats/memory are placeholders only in Task 5** — fill them from the
  real scoreboard produced in Task 4. Every code step has complete, runnable content.
- **Do not** add `mm_trade_spreads` to `_LOADERS` in `data.py` — it is CSV-mode only
  by design (the asof-join cannot run cheaply in DB mode).
- **Do not** size-weight or shorten Δ in v1 — both are explicitly deferred in the spec.
- After Task 4, the offline run also re-emits H-INE-5 / H-INE-1 / calibration rows;
  that is expected (the scoreboard is regenerated wholesale).
- Final step before finishing the branch: run `python -m pytest -q` from
  `scripts/edge-research/` and confirm the full suite is green, then use
  superpowers:finishing-a-development-branch.
```
