# Edge Research — Sub-project A (framework + calibration) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the edge-research framework (`Verdict` contract, registry loader, validator interface, runner, scoreboard) end-to-end with the first real validator — Calibration over the resolved `market_panel` rows.

**Architecture:** A Python module under `scripts/edge-research/`. Validators are pure functions over a pandas DataFrame (so tests inject synthetic frames, no DB). A separate data layer loads `market_panel` from Postgres into that DataFrame. The runner loads `registry.yaml`, runs runnable validators, collects `Verdict`s to JSON, and renders a markdown+CSV scoreboard. Determinism: the run timestamp is passed in, never generated.

**Tech Stack:** Python 3, pandas, numpy, PyYAML, psycopg2-binary, pytest. Precedent: `scripts/flb-hierarchical-edge.py`.

**Spec:** `docs/superpowers/specs/2026-06-05-edge-research-program-design.md`

---

## File Structure

- Create: `scripts/edge-research/requirements.txt` — pinned deps.
- Create: `scripts/edge-research/verdict.py` — `Verdict` dataclass + JSON I/O.
- Create: `scripts/edge-research/registry.yaml` — the hypothesis catalogue (§5 of spec).
- Create: `scripts/edge-research/registry.py` — load/validate registry, mark blocked.
- Create: `scripts/edge-research/validators/__init__.py`
- Create: `scripts/edge-research/validators/base.py` — `Validator` protocol + helpers (bootstrap CI).
- Create: `scripts/edge-research/validators/calibration.py` — calibration validator.
- Create: `scripts/edge-research/data.py` — load `market_panel` → DataFrame.
- Create: `scripts/edge-research/scoreboard.py` — render md + CSV.
- Create: `scripts/edge-research/run.py` — the runner CLI.
- Create: `scripts/edge-research/tests/` — pytest suite (one file per module).
- Create: `scripts/edge-research/README.md` — how to run locally and on the VM.

---

## Task 1: Module scaffold + dependencies

**Files:**
- Create: `scripts/edge-research/requirements.txt`
- Create: `scripts/edge-research/__init__.py` (empty)
- Create: `scripts/edge-research/validators/__init__.py` (empty)
- Create: `scripts/edge-research/tests/__init__.py` (empty)
- Create: `scripts/edge-research/README.md`

- [ ] **Step 1: Write requirements.txt**

```
pandas==2.2.2
numpy==1.26.4
PyYAML==6.0.2
psycopg2-binary==2.9.9
pytest==8.3.2
```

- [ ] **Step 2: Create the empty package files**

Create `scripts/edge-research/__init__.py`, `scripts/edge-research/validators/__init__.py`, `scripts/edge-research/tests/__init__.py` — all empty.

- [ ] **Step 3: Write README.md**

```markdown
# Edge Research harness

Validates edge hypotheses against a uniform cost-aware bar. See
`docs/superpowers/specs/2026-06-05-edge-research-program-design.md`.

## Install
    pip install -r scripts/edge-research/requirements.txt

## Test (no DB needed — synthetic fixtures)
    pytest scripts/edge-research/tests -v

## Run against real data (needs DATABASE_URL to the trading DB)
    NODE_TLS_REJECT_UNAUTHORIZED=0 DATABASE_URL=postgres://... \
      python scripts/edge-research/run.py --out scripts/edge-research/out

On the VM the DB is local to the timescaledb container; copy the module in and
run with the container connection string, mirroring p2-tstat.
```

- [ ] **Step 4: Verify install works**

Run: `pip install -r scripts/edge-research/requirements.txt && python -c "import pandas, numpy, yaml, psycopg2"`
Expected: no error.

- [ ] **Step 5: Commit**

```bash
git add scripts/edge-research/
git commit -m "chore(edge-research): module scaffold + deps"
```

---

## Task 2: The `Verdict` contract

**Files:**
- Create: `scripts/edge-research/verdict.py`
- Test: `scripts/edge-research/tests/test_verdict.py`

- [ ] **Step 1: Write the failing test (F2 — JSON round-trip)**

```python
# tests/test_verdict.py
import json
from scripts_edge_research_import import Verdict  # see Step 3 note

def test_verdict_json_roundtrip():
    v = Verdict(
        hypothesis_id="H-CAL-1", hclass="calibration", n=1015,
        edge_net_pct=0.0224, edge_insample_pct=0.0240, significance=3.49,
        split="full", class_metric={"brier": 0.21}, cost_model="entry_only_0.005",
        status="pass", n_caveats=["panel 96% event_long"], computed_at="2026-06-05T00:00:00Z",
    )
    s = v.to_json()
    v2 = Verdict.from_json(s)
    assert v2 == v
    assert json.loads(s)["hypothesis_id"] == "H-CAL-1"

def test_verdict_handles_nulls():
    v = Verdict(hypothesis_id="X", hclass="calibration", n=0,
        edge_net_pct=None, edge_insample_pct=None, significance=None,
        split="full", class_metric={}, cost_model="n/a",
        status="inconclusive", n_caveats=[], computed_at="t")
    assert Verdict.from_json(v.to_json()) == v
```

Note: tests import via a path shim. Add `scripts/edge-research/tests/conftest.py`:

```python
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
```

and in tests use `from verdict import Verdict` (not the placeholder above). Replace the first import line with `from verdict import Verdict`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest scripts/edge-research/tests/test_verdict.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'verdict'`.

- [ ] **Step 3: Implement verdict.py**

```python
# verdict.py
from __future__ import annotations
from dataclasses import dataclass, asdict, field
import json

@dataclass(frozen=True)
class Verdict:
    hypothesis_id: str
    hclass: str
    n: int
    edge_net_pct: float | None
    edge_insample_pct: float | None
    significance: float | None
    split: str
    class_metric: dict
    cost_model: str
    status: str
    n_caveats: list
    computed_at: str

    def to_json(self) -> str:
        return json.dumps(asdict(self), sort_keys=True)

    @staticmethod
    def from_json(s: str) -> "Verdict":
        return Verdict(**json.loads(s))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest scripts/edge-research/tests/test_verdict.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/edge-research/verdict.py scripts/edge-research/tests/test_verdict.py scripts/edge-research/tests/conftest.py
git commit -m "feat(edge-research): Verdict contract + JSON round-trip"
```

---

## Task 3: Registry loader

**Files:**
- Create: `scripts/edge-research/registry.yaml`
- Create: `scripts/edge-research/registry.py`
- Test: `scripts/edge-research/tests/test_registry.py`

- [ ] **Step 1: Write registry.yaml** (the §5 catalogue — full content)

```yaml
- {id: H-CAL-1, class: calibration, name: Price calibration by price band, required_data: [market_panel_resolved], status: planned, priority: 1, depends_on: []}
- {id: H-CAL-2, class: calibration, name: Calibration by market_type, required_data: [market_panel_resolved], status: planned, priority: 2, depends_on: []}
- {id: H-CAL-3, class: calibration, name: Calibration by TTR bucket, required_data: [market_panel_resolved], status: planned, priority: 2, depends_on: []}
- {id: H-CAL-4, class: calibration, name: Calibration by liquidity, required_data: [market_panel_resolved], status: planned, priority: 3, depends_on: []}
- {id: H-SUP-1, class: supervised, name: Supervised model prob vs price, required_data: [market_panel_resolved], status: planned, priority: 2, depends_on: []}
- {id: H-HOR-1, class: horizon, name: Optimal-hold sweep, required_data: [price_history_resolved], status: planned, priority: 3, depends_on: []}
- {id: H-INE-1, class: inefficiency, name: Favorite-longshot hold-to-resolution, required_data: [flb_backtest_prices], status: pass_insample, priority: 1, depends_on: []}
- {id: H-INE-2, class: inefficiency, name: Resolution-day discovery gap, required_data: [market_panel_resolved, price_history_resolved], status: planned, priority: 2, depends_on: []}
- {id: H-INE-3, class: inefficiency, name: News-event price lag, required_data: [price_history_resolved, news], status: planned, priority: 3, depends_on: []}
- {id: H-INE-4, class: inefficiency, name: Conditional markets not updating, required_data: [markets, manual_mapping], status: planned, priority: 4, depends_on: []}
- {id: H-INE-5, class: inefficiency, name: Time-decay extreme band, required_data: [market_panel_resolved], status: planned, priority: 3, depends_on: []}
- {id: H-MM-1, class: market_making, name: Spread capture net of adverse selection, required_data: [price_history_bidask], status: planned, priority: 2, depends_on: []}
- {id: H-MM-2, class: market_making, name: Liquidity-rewards subsidy, required_data: [gamma_rewards], status: planned, priority: 3, depends_on: []}
- {id: H-ENS-1, class: ensemble, name: Combination of validated signals, required_data: [derived], status: planned, priority: 2, depends_on: []}
- {id: H-ARB-1, class: arbitrage, name: Cross-venue, required_data: [], status: closed, priority: 9, depends_on: []}
- {id: H-ARB-2, class: arbitrage, name: Same-venue structural sum-arb, required_data: [], status: closed, priority: 9, depends_on: []}
```

- [ ] **Step 2: Write the failing test (F1 — load + blocked handling)**

```python
# tests/test_registry.py
from registry import load_registry, runnable

def test_load_registry_parses_catalogue():
    entries = load_registry()  # default path = registry.yaml next to module
    ids = {e["id"] for e in entries}
    assert "H-CAL-1" in ids and "H-ARB-1" in ids
    assert len(entries) == 16

def test_runnable_filters_on_available_data_and_status():
    entries = [
        {"id": "A", "status": "planned", "required_data": ["market_panel_resolved"]},
        {"id": "B", "status": "planned", "required_data": ["gamma_rewards"]},
        {"id": "C", "status": "closed", "required_data": []},
    ]
    available = {"market_panel_resolved"}
    run, blocked = runnable(entries, available)
    assert [e["id"] for e in run] == ["A"]
    assert {e["id"] for e in blocked} == {"B"}  # C is closed, not blocked — excluded entirely
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pytest scripts/edge-research/tests/test_registry.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'registry'`.

- [ ] **Step 4: Implement registry.py**

```python
# registry.py
from __future__ import annotations
import pathlib, yaml

_DEFAULT = pathlib.Path(__file__).resolve().parent / "registry.yaml"

def load_registry(path: str | None = None) -> list[dict]:
    p = pathlib.Path(path) if path else _DEFAULT
    with open(p) as f:
        entries = yaml.safe_load(f)
    if not isinstance(entries, list):
        raise ValueError("registry.yaml must be a list of entries")
    for e in entries:
        if "id" not in e or "status" not in e:
            raise ValueError(f"registry entry missing id/status: {e!r}")
    return entries

def runnable(entries: list[dict], available_data: set[str]) -> tuple[list[dict], list[dict]]:
    run, blocked = [], []
    for e in entries:
        if e["status"] == "closed":
            continue  # dead ends stay in registry but never run
        needs = set(e.get("required_data") or [])
        if needs <= available_data:
            run.append(e)
        else:
            blocked.append(e)
    return run, blocked
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pytest scripts/edge-research/tests/test_registry.py -v`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add scripts/edge-research/registry.yaml scripts/edge-research/registry.py scripts/edge-research/tests/test_registry.py
git commit -m "feat(edge-research): registry loader + runnable/blocked resolution"
```

---

## Task 4: Validator base + bootstrap helper

**Files:**
- Create: `scripts/edge-research/validators/base.py`
- Test: `scripts/edge-research/tests/test_base.py`

- [ ] **Step 1: Write the failing test (bootstrap CI determinism)**

```python
# tests/test_base.py
import numpy as np
from validators.base import bootstrap_ci

def test_bootstrap_ci_is_deterministic_with_seed():
    x = np.array([0.01, 0.02, -0.005, 0.03, 0.015, 0.0, 0.04, -0.01])
    lo1, hi1 = bootstrap_ci(x, n_boot=500, seed=42)
    lo2, hi2 = bootstrap_ci(x, n_boot=500, seed=42)
    assert (lo1, hi1) == (lo2, hi2)

def test_bootstrap_ci_excludes_zero_for_clear_positive():
    x = np.full(200, 0.02)
    lo, hi = bootstrap_ci(x, n_boot=500, seed=1)
    assert lo > 0  # constant positive → CI well above 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest scripts/edge-research/tests/test_base.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'validators.base'`.

- [ ] **Step 3: Implement base.py**

```python
# validators/base.py
from __future__ import annotations
from typing import Protocol
import numpy as np

class Validator(Protocol):
    hypothesis_id: str
    hclass: str
    def required_inputs(self) -> list[str]: ...
    def run(self, ctx) -> list:  # returns list[Verdict]
        ...

def bootstrap_ci(x, n_boot: int = 1000, seed: int = 0, alpha: float = 0.05):
    """Percentile bootstrap CI of the mean. Deterministic given seed."""
    x = np.asarray(x, dtype=float)
    if x.size == 0:
        return (float("nan"), float("nan"))
    rng = np.random.default_rng(seed)
    means = x[rng.integers(0, x.size, size=(n_boot, x.size))].mean(axis=1)
    lo = float(np.percentile(means, 100 * alpha / 2))
    hi = float(np.percentile(means, 100 * (1 - alpha / 2)))
    return (lo, hi)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest scripts/edge-research/tests/test_base.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/edge-research/validators/base.py scripts/edge-research/tests/test_base.py
git commit -m "feat(edge-research): Validator protocol + deterministic bootstrap CI"
```

---

## Task 5: Calibration validator — core (overall reliability + edge)

**Files:**
- Create: `scripts/edge-research/validators/calibration.py`
- Test: `scripts/edge-research/tests/test_calibration.py`

Input contract: a pandas DataFrame with columns `yes_price` (float 0-1),
`outcome_yes` (0/1 int), `market_type` (str), `ttr_days` (float), `market_score`
(float). The validator never touches the DB.

- [ ] **Step 1: Write the failing tests (P1, P2, P3, P4, P5 instantiated)**

```python
# tests/test_calibration.py
import numpy as np, pandas as pd
from validators.calibration import CalibrationValidator

def _frame(prices, outcomes):
    n = len(prices)
    return pd.DataFrame({
        "yes_price": prices, "outcome_yes": outcomes,
        "market_type": ["event_long"] * n, "ttr_days": [10.0] * n,
        "market_score": [0.5] * n,
    })

class Ctx:
    def __init__(self, df, cost=0.005, ts="2026-06-05T00:00:00Z"):
        self.df = df; self.cost = cost; self.computed_at = ts
        self.n_bins = 10; self.min_n = 50; self.seed = 7

def test_well_calibrated_has_no_edge():  # P2
    rng = np.random.default_rng(0)
    prices = rng.uniform(0.05, 0.95, 4000)
    outcomes = (rng.uniform(size=4000) < prices).astype(int)  # perfectly calibrated
    v = CalibrationValidator().run(Ctx(_frame(prices, outcomes)))[0]
    assert v.status == "fail"
    assert v.class_metric["brier"] > 0

def test_underpriced_longshots_show_edge():  # P1
    rng = np.random.default_rng(1)
    # price ~0.10 but true prob ~0.18 → positive deviation > cost
    prices = np.full(3000, 0.10)
    outcomes = (rng.uniform(size=3000) < 0.18).astype(int)
    v = CalibrationValidator().run(Ctx(_frame(prices, outcomes)))[0]
    assert v.status == "pass"
    assert v.edge_net_pct is not None and v.edge_net_pct > 0

def test_below_floor_is_inconclusive():  # P3
    v = CalibrationValidator().run(Ctx(_frame([0.1, 0.2], [0, 1])))[0]
    assert v.status == "inconclusive"

def test_deviation_below_cost_is_not_edge():  # P4
    rng = np.random.default_rng(2)
    prices = np.full(3000, 0.10)
    outcomes = (rng.uniform(size=3000) < 0.103).astype(int)  # dev ~0.003 < cost 0.005
    v = CalibrationValidator().run(Ctx(_frame(prices, outcomes), cost=0.005))[0]
    assert v.status == "fail"

def test_determinism():  # P5
    df = _frame(np.full(3000, 0.10), (np.random.default_rng(3).uniform(size=3000) < 0.18).astype(int))
    a = CalibrationValidator().run(Ctx(df))[0]
    b = CalibrationValidator().run(Ctx(df))[0]
    assert a == b
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest scripts/edge-research/tests/test_calibration.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'validators.calibration'`.

- [ ] **Step 3: Implement calibration.py (overall slice only for now)**

```python
# validators/calibration.py
from __future__ import annotations
import numpy as np, pandas as pd
from verdict import Verdict
from validators.base import bootstrap_ci

class CalibrationValidator:
    hypothesis_id = "H-CAL-1"
    hclass = "calibration"

    def required_inputs(self) -> list[str]:
        return ["market_panel_resolved"]

    def run(self, ctx) -> list[Verdict]:
        return [self._overall(ctx)]

    def _overall(self, ctx) -> Verdict:
        df = ctx.df
        n = len(df)
        if n < ctx.min_n:
            return Verdict(self.hypothesis_id, self.hclass, n, None, None, None,
                           "full", {}, f"entry_only_{ctx.cost}", "inconclusive",
                           [f"n={n} below floor {ctx.min_n}"], ctx.computed_at)
        p = df["yes_price"].to_numpy(float)
        y = df["outcome_yes"].to_numpy(float)
        brier = float(np.mean((p - y) ** 2))
        # per-bin reliability
        edges = np.linspace(0.0, 1.0, ctx.n_bins + 1)
        idx = np.clip(np.digitize(p, edges[1:-1]), 0, ctx.n_bins - 1)
        best = None  # (abs_excess, signed_edge, bin_dev, bin_n)
        for b in range(ctx.n_bins):
            m = idx == b
            bn = int(m.sum())
            if bn < ctx.min_n:
                continue
            dev = float(y[m].mean() - p[m].mean())  # outcome - price, payoff units
            excess = abs(dev) - ctx.cost
            if excess <= 0:
                continue
            lo, hi = bootstrap_ci(y[m] - p[m], seed=ctx.seed)
            if lo <= 0 <= hi:   # not significant
                continue
            signed = dev - np.sign(dev) * ctx.cost  # net edge per share, signed
            if best is None or abs(signed) > abs(best[1]):
                best = (excess, signed, dev, bn)
        if best is None:
            return Verdict(self.hypothesis_id, self.hclass, n, None, None, None,
                           "full", {"brier": brier}, f"entry_only_{ctx.cost}",
                           "fail", [], ctx.computed_at)
        _, signed, dev, bn = best
        sig_lo, sig_hi = bootstrap_ci(np.full(bn, dev), seed=ctx.seed)
        return Verdict(self.hypothesis_id, self.hclass, n, float(signed), float(dev),
                       float((sig_hi - sig_lo) / 2 or 1e-9), "full",
                       {"brier": brier, "edged_bin_n": bn}, f"entry_only_{ctx.cost}",
                       "pass", [], ctx.computed_at)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest scripts/edge-research/tests/test_calibration.py -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/edge-research/validators/calibration.py scripts/edge-research/tests/test_calibration.py
git commit -m "feat(edge-research): calibration validator — overall reliability + cost-gated edge"
```

> **Corrections applied during execution (review findings).** The reference
> snippet above has three defects, fixed in follow-up commits — apply them if
> re-running this plan:
> 1. **Significance** must come from the winning bin's real per-row CI, not
>    `bootstrap_ci(np.full(bn, dev))` (a constant → zero width → meaningless
>    `1e-9`). Carry `(lo, hi)` through `best` and report `(hi - lo) / 2`; drop
>    the `or 1e-9` mask.
> 2. **`edge_insample_pct == edge_net_pct`** for this descriptive `split="full"`
>    validator (no train/holdout split = no in-sample/OOS gap). Pass `signed`
>    for both, not `dev` for insample.
> 3. **`pass` requires a POSITIVE net edge.** The gate must be `net = dev - cost;
>    if net <= 0: continue` and `if lo <= 0: continue` (not `abs(dev)` /
>    `lo <= 0 <= hi`). An overpriced favourite bin (dev<0) is the known
>    anti-edge (SHORT-resolves-NO) and must be `fail`, never a negative-edge
>    `pass`.

---

## Task 6: Calibration conditioning (type / TTR / liquidity)

**Files:**
- Modify: `scripts/edge-research/validators/calibration.py`
- Test: `scripts/edge-research/tests/test_calibration_conditioned.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_calibration_conditioned.py
import numpy as np, pandas as pd
from validators.calibration import CalibrationValidator

class Ctx:
    def __init__(self, df):
        self.df = df; self.cost = 0.005; self.computed_at = "t"
        self.n_bins = 10; self.min_n = 50; self.seed = 7

def test_emits_one_verdict_per_slice():
    rng = np.random.default_rng(0)
    n = 4000
    df = pd.DataFrame({
        "yes_price": np.full(n, 0.10),
        "outcome_yes": (rng.uniform(size=n) < 0.18).astype(int),
        "market_type": ["event_long"] * (n // 2) + ["event_short"] * (n // 2),
        "ttr_days": [3.0] * (n // 2) + [40.0] * (n // 2),
        "market_score": [0.5] * n,
    })
    verdicts = CalibrationValidator().run(Ctx(df))
    ids = [v.hypothesis_id for v in verdicts]
    assert "H-CAL-1" in ids       # overall
    assert "H-CAL-2" in ids       # by type
    assert "H-CAL-3" in ids       # by TTR bucket
    # by-type verdict carries the slice label in class_metric
    by_type = [v for v in verdicts if v.hypothesis_id == "H-CAL-2"]
    assert all("slice" in v.class_metric for v in by_type)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest scripts/edge-research/tests/test_calibration_conditioned.py -v`
Expected: FAIL — only `H-CAL-1` present (others not emitted yet).

- [ ] **Step 3: Extend calibration.py — refactor `_overall` body into `_slice` and add conditioning**

Replace the `run` method and add helpers (keep `_overall` logic inside the shared `_slice`):

```python
    def run(self, ctx) -> list[Verdict]:
        out = [self._slice(ctx, ctx.df, "H-CAL-1", {})]
        for mt, sub in ctx.df.groupby("market_type"):
            out.append(self._slice(ctx, sub, "H-CAL-2", {"slice": f"type={mt}"}))
        ttr_bucket = pd.cut(ctx.df["ttr_days"], bins=[-1, 2, 7, 30, 1e9],
                            labels=["<=2d", "2-7d", "7-30d", ">30d"])
        for b, sub in ctx.df.groupby(ttr_bucket, observed=True):
            out.append(self._slice(ctx, sub, "H-CAL-3", {"slice": f"ttr={b}"}))
        q = pd.qcut(ctx.df["market_score"].rank(method="first"), 4, labels=False, duplicates="drop")
        for b, sub in ctx.df.groupby(q, observed=True):
            out.append(self._slice(ctx, sub, "H-CAL-4", {"slice": f"liq_q={int(b)}"}))
        return out
```

Rename `_overall(self, ctx)` to `_slice(self, ctx, df, hid, extra_metric)`: replace its first line `df = ctx.df` with the passed `df`, replace `self.hypothesis_id` with `hid` in every `Verdict(...)`, and merge `extra_metric` into each `class_metric` dict (e.g. `{"brier": brier, **extra_metric}` and `{**extra_metric}` for the inconclusive branch).

- [ ] **Step 4: Run all calibration tests to verify they pass**

Run: `pytest scripts/edge-research/tests/test_calibration.py scripts/edge-research/tests/test_calibration_conditioned.py -v`
Expected: PASS (6 tests — the Task 5 tests still pass because `H-CAL-1` is `out[0]`).

- [ ] **Step 5: Commit**

```bash
git add scripts/edge-research/validators/calibration.py scripts/edge-research/tests/test_calibration_conditioned.py
git commit -m "feat(edge-research): calibration conditioning by type/TTR/liquidity (H-CAL-2/3/4)"
```

---

## Task 7: Data layer — load `market_panel` resolved

**Files:**
- Create: `scripts/edge-research/data.py`
- Test: `scripts/edge-research/tests/test_data.py`

The validator needs `yes_price, outcome_yes, market_type, ttr_days, market_score`.
The leakage rule (spec §9): use the **earliest snapshot per market_id**.

- [ ] **Step 1: Write the failing test (SQL-free transform is the testable unit)**

```python
# tests/test_data.py
import pandas as pd
from data import shape_panel

def test_shape_panel_takes_earliest_snapshot_and_computes_ttr():
    raw = pd.DataFrame({
        "market_id": ["m1", "m1", "m2"],
        "snapshot_at": pd.to_datetime(["2026-05-19", "2026-05-26", "2026-05-19"], utc=True),
        "end_date": pd.to_datetime(["2026-05-29", "2026-05-29", "2026-06-08"], utc=True),
        "yes_price": [0.10, 0.40, 0.80],
        "market_type": ["event_long", "event_long", "event_short"],
        "market_score": [0.5, 0.5, 0.6],
        "outcome_yes": [1, 1, 0],
    })
    df = shape_panel(raw)
    assert len(df) == 2                       # one row per market (earliest)
    m1 = df[df.market_id == "m1"].iloc[0]
    assert m1.yes_price == 0.10               # earliest snapshot kept
    assert abs(m1.ttr_days - 10.0) < 1e-6     # 05-29 minus 05-19
    assert set(["yes_price","outcome_yes","market_type","ttr_days","market_score"]).issubset(df.columns)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest scripts/edge-research/tests/test_data.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'data'`.

- [ ] **Step 3: Implement data.py**

```python
# data.py
from __future__ import annotations
import os, pandas as pd

RESOLVED_SQL = """
  SELECT market_id, snapshot_at, end_date, yes_price, market_type,
         market_score, outcome_yes
  FROM market_panel
  WHERE outcome_yes IS NOT NULL
"""

def shape_panel(raw: pd.DataFrame) -> pd.DataFrame:
    raw = raw.sort_values("snapshot_at")
    earliest = raw.groupby("market_id", as_index=False).first()
    earliest["ttr_days"] = (
        (earliest["end_date"] - earliest["snapshot_at"]).dt.total_seconds() / 86400.0
    )
    earliest["outcome_yes"] = earliest["outcome_yes"].astype(int)
    return earliest[["market_id", "yes_price", "outcome_yes", "market_type",
                     "ttr_days", "market_score"]]

def load_market_panel(database_url: str | None = None) -> pd.DataFrame:
    import psycopg2
    url = database_url or os.environ["DATABASE_URL"]
    with psycopg2.connect(url) as conn:
        raw = pd.read_sql(RESOLVED_SQL, conn)
    return shape_panel(raw)

def available_data(database_url: str | None = None) -> set[str]:
    """Which registry required_data tokens are satisfiable. v1: only the panel."""
    try:
        df = load_market_panel(database_url)
        return {"market_panel_resolved"} if len(df) else set()
    except Exception:
        return set()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest scripts/edge-research/tests/test_data.py -v`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add scripts/edge-research/data.py scripts/edge-research/tests/test_data.py
git commit -m "feat(edge-research): market_panel data layer (earliest-snapshot shaping)"
```

---

## Task 8: Scoreboard renderer

**Files:**
- Create: `scripts/edge-research/scoreboard.py`
- Test: `scripts/edge-research/tests/test_scoreboard.py`

- [ ] **Step 1: Write the failing test (F4 — sorted, blocked shown)**

```python
# tests/test_scoreboard.py
from verdict import Verdict
from scoreboard import render_markdown

def _v(hid, edge, status):
    return Verdict(hid, "calibration", 1000, edge, edge, 3.0, "full",
                   {}, "entry_only_0.005", status, [], "t")

def test_scoreboard_sorts_by_edge_desc_and_lists_blocked():
    verdicts = [_v("A", 0.01, "pass"), _v("B", 0.03, "pass"), _v("C", None, "fail")]
    blocked = [{"id": "H-MM-1", "name": "Spread capture"}]
    md = render_markdown(verdicts, blocked)
    # B (0.03) appears before A (0.01)
    assert md.index("B") < md.index("A")
    # blocked hypotheses are listed, never silently dropped
    assert "H-MM-1" in md and "blocked" in md.lower()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest scripts/edge-research/tests/test_scoreboard.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'scoreboard'`.

- [ ] **Step 3: Implement scoreboard.py**

```python
# scoreboard.py
from __future__ import annotations
import csv, io

def _sort_key(v):
    return (v.edge_net_pct if v.edge_net_pct is not None else float("-inf"))

def render_markdown(verdicts: list, blocked: list[dict]) -> str:
    rows = sorted(verdicts, key=_sort_key, reverse=True)
    lines = ["# Edge Research scoreboard", "",
             "| id | class | n | edge_net% | insample% | sig | status | caveats |",
             "|----|-------|---|-----------|-----------|-----|--------|---------|"]
    for v in rows:
        e = "" if v.edge_net_pct is None else f"{v.edge_net_pct*100:.2f}"
        ins = "" if v.edge_insample_pct is None else f"{v.edge_insample_pct*100:.2f}"
        sig = "" if v.significance is None else f"{v.significance:.2f}"
        cav = "; ".join(v.n_caveats)
        lines.append(f"| {v.hypothesis_id} | {v.hclass} | {v.n} | {e} | {ins} | {sig} | {v.status} | {cav} |")
    if blocked:
        lines += ["", "## Blocked (data not available)", ""]
        for b in blocked:
            lines.append(f"- {b['id']} — {b.get('name','')} (blocked)")
    return "\n".join(lines) + "\n"

def render_csv(verdicts: list) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", "class", "n", "edge_net_pct", "edge_insample_pct",
                "significance", "split", "cost_model", "status", "caveats"])
    for v in sorted(verdicts, key=_sort_key, reverse=True):
        w.writerow([v.hypothesis_id, v.hclass, v.n, v.edge_net_pct, v.edge_insample_pct,
                    v.significance, v.split, v.cost_model, v.status, "; ".join(v.n_caveats)])
    return buf.getvalue()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest scripts/edge-research/tests/test_scoreboard.py -v`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add scripts/edge-research/scoreboard.py scripts/edge-research/tests/test_scoreboard.py
git commit -m "feat(edge-research): scoreboard renderer (md + csv, blocked listed)"
```

---

## Task 9: Runner — wire registry → validators → scoreboard

**Files:**
- Create: `scripts/edge-research/run.py`
- Test: `scripts/edge-research/tests/test_run.py`

- [ ] **Step 1: Write the failing test (F3 — determinism + dispatch)**

```python
# tests/test_run.py
import numpy as np, pandas as pd
from run import run_validators

def _panel():
    rng = np.random.default_rng(0)
    n = 4000
    return pd.DataFrame({
        "market_id": [f"m{i}" for i in range(n)],
        "yes_price": np.full(n, 0.10),
        "outcome_yes": (rng.uniform(size=n) < 0.18).astype(int),
        "market_type": ["event_long"] * n, "ttr_days": [10.0] * n,
        "market_score": [0.5] * n,
    })

def test_run_dispatches_calibration_and_is_deterministic():
    df = _panel()
    r1 = run_validators(df, available={"market_panel_resolved"}, computed_at="t")
    r2 = run_validators(df, available={"market_panel_resolved"}, computed_at="t")
    assert [v.to_json() for v in r1["verdicts"]] == [v.to_json() for v in r2["verdicts"]]
    assert any(v.hypothesis_id == "H-CAL-1" for v in r1["verdicts"])
    # H-MM-1 needs price_history_bidask → blocked when only the panel is available
    assert any(b["id"] == "H-MM-1" for b in r1["blocked"])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest scripts/edge-research/tests/test_run.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'run'`.

- [ ] **Step 3: Implement run.py**

```python
# run.py
from __future__ import annotations
import argparse, os, pathlib, types
from registry import load_registry, runnable
from validators.calibration import CalibrationValidator
from scoreboard import render_markdown, render_csv

# class → validator factory. Extended in sub-projects B/C.
VALIDATORS = {"calibration": CalibrationValidator}

def _ctx(df, computed_at):
    return types.SimpleNamespace(df=df, cost=0.005, computed_at=computed_at,
                                 n_bins=10, min_n=50, seed=7)

def run_validators(df, available: set[str], computed_at: str) -> dict:
    entries = load_registry()
    run_entries, blocked = runnable(entries, available)
    verdicts = []
    seen_classes = set()
    for e in run_entries:
        cls = VALIDATORS.get(e["class"])
        if cls is None or e["class"] in seen_classes:
            continue  # one validator instance per class emits all its slices
        seen_classes.add(e["class"])
        verdicts.extend(cls().run(_ctx(df, computed_at)))
    return {"verdicts": verdicts, "blocked": blocked}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="scripts/edge-research/out")
    ap.add_argument("--computed-at", required=True, help="ISO timestamp (pass explicitly for determinism)")
    args = ap.parse_args()
    from data import load_market_panel, available_data
    df = load_market_panel()
    res = run_validators(df, available_data(), args.computed_at)
    outdir = pathlib.Path(args.out); outdir.mkdir(parents=True, exist_ok=True)
    (outdir / "scoreboard.md").write_text(render_markdown(res["verdicts"], res["blocked"]))
    (outdir / "scoreboard.csv").write_text(render_csv(res["verdicts"]))
    print(f"Wrote {outdir}/scoreboard.md ({len(res['verdicts'])} verdicts, {len(res['blocked'])} blocked)")

if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run all tests to verify they pass**

Run: `pytest scripts/edge-research/tests -v`
Expected: PASS (all tests across the suite).

- [ ] **Step 5: Commit**

```bash
git add scripts/edge-research/run.py scripts/edge-research/tests/test_run.py
git commit -m "feat(edge-research): runner wiring registry→validators→scoreboard"
```

---

## Task 10: Smoke run against real `market_panel` + first scoreboard

**Files:**
- Create: `scripts/edge-research/out/scoreboard.md` (generated artifact, committed once as the first read)

- [ ] **Step 1: Copy the module to the VM dashboard container and install deps**

```bash
gcloud compute scp --recurse scripts/edge-research polymarket-vm:/tmp/edge-research --zone=us-east1-b
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker cp /tmp/edge-research polymarket-dashboard-api:/app/edge-research && docker exec polymarket-dashboard-api sh -c 'command -v python3 || apk add --no-cache python3 py3-pip'"
```

If the container lacks Python/pip, run instead from the host VM with a venv, or
export the panel to CSV and run locally. Document whichever path works in README.

- [ ] **Step 2: Run the harness against the live panel**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker exec -w /app/edge-research -e DATABASE_URL='postgres://polymarket:polymarket_prod@timescaledb:5432/polymarket_trading?sslmode=disable' polymarket-dashboard-api python3 run.py --computed-at 2026-06-05T00:00:00Z --out /app/edge-research/out"
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker exec polymarket-dashboard-api cat /app/edge-research/out/scoreboard.md"
```
Expected: a scoreboard table with H-CAL-1..4 rows (status pass/fail/inconclusive)
and H-MM-1/H-SUP-1 etc. listed as blocked (their data tokens unavailable in v1).

- [ ] **Step 3: Sanity-check the calibration read**

Confirm the overall Brier is in a plausible range (0.1–0.25 for prediction
markets) and that any `pass` row's edged bin has n in the hundreds, not single
digits. If a `pass` appears only on a thin bin, raise `min_n` and re-run — record
the decision in the README. The panel is 96% event_long, so H-CAL-2 for other
types will be `inconclusive`; that is expected, not a bug.

- [ ] **Step 4: Save the first scoreboard as the program's baseline**

Copy the generated `scoreboard.md` back and commit it as the first read:

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker exec polymarket-dashboard-api cat /app/edge-research/out/scoreboard.md" > scripts/edge-research/out/scoreboard.md
git add scripts/edge-research/out/scoreboard.md
git commit -m "chore(edge-research): first calibration scoreboard (baseline read)"
```

- [ ] **Step 5: Clean up the container copy**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker exec polymarket-dashboard-api rm -rf /app/edge-research && rm -rf /tmp/edge-research"
```

---

## Self-review notes (addressed)

- **Spec coverage:** `Verdict` (T2), `Validator`/runner (T4,T9), registry (T3),
  cost model entry-only (T5 `cost_model` string), calibration H-CAL-1..4 (T5,T6),
  scoreboard with blocked-shown (T8), determinism via passed-in timestamp
  (T2,T9), leakage earliest-snapshot rule (T7), panel-skew caveat surfaced
  (T5 inconclusive + T10 step 3). Overfit-gap / split fields exist on `Verdict`
  but are only exercised by split-based validators in Sub-project B — calibration
  is descriptive (`split="full"`), so `edge_insample_pct == edge_net_pct` here by
  construction; documented, not a gap.
- **Out of scope (Sub-project B/C):** SupervisedModel, Horizon, Ensemble (and its
  3 modes + multiple-testing control), MarketMaking. Their registry rows are
  present and correctly resolve to `blocked` in v1.
- **Type consistency:** `Ctx` fields (`df, cost, computed_at, n_bins, min_n,
  seed`) match between `run._ctx` and every test `Ctx`. `Verdict` field order is
  identical everywhere it is constructed.
