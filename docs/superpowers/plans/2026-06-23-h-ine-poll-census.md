# H-INE-POLL Sub-project A — Poll-supply Census Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-contained poll-supply census that classifies every political-catalog race by poll-coverage tier and (gated) fits a validated margin→win-prob transform, producing a data-backed GO/NO-GO for the full H-INE-POLL validator.

**Architecture:** One pure-Python module `scripts/edge-research/poll_census.py` with four units — race parser, coverage classifier (injectable verifier), census runner/report, and a numpy-only logistic transform calibrator — plus a pytest file using stub verifiers and synthetic data. No DB and no live-web dependency in tests; the live Wikipedia verifier is a thin adapter exercised only at census run time.

**Tech Stack:** Python 3.13, numpy>=2.1, pandas>=2.2.3, pytest>=8.3 (no scipy/sklearn — logistic fit via hand-rolled IRLS). Input is the on-disk CSV `scripts/edge-research/datasets/conditional_catalog_political.csv`.

---

## File Structure

- `scripts/edge-research/poll_census.py` — all census logic (parser, classifier, runner, calibrator, CLI `__main__`). One file; the units are small and change together.
- `scripts/edge-research/tests/test_poll_census.py` — unit + integration tests.
- Outputs (gitignored `datasets/`): `poll_supply_census.csv`, `poll_transform_params.json`.

All commands run from `scripts/edge-research/`. Run tests with `python -m pytest tests/test_poll_census.py -v` (the repo `conftest.py` puts the package root on `sys.path`). `python` is the interpreter (no `python3` on this Windows box).

---

### Task 1: Race parser

**Files:**
- Create: `scripts/edge-research/poll_census.py`
- Test: `scripts/edge-research/tests/test_poll_census.py`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_poll_census.py
import json, math, types
import numpy as np
import pytest
from poll_census import (
    Race, parse_race, classify_coverage, run_census, fit_margin_to_winprob,
)


def test_parse_us_house_seat():
    r = parse_race("Will Thomas Massie be the Republican nominee for KY-04?",
                   "2026-05-19 00:00:00+00", "2026-05-20 03:12:14+00")
    assert r.country == "US"
    assert r.office == "house"
    assert r.race_id == "US/house/KY-04"
    assert r.stage == "nominee"
    assert r.candidate == "thomas massie"


def test_parse_us_senate_state():
    r = parse_race("Will Juliana Stratton be the Democratic nominee for Senate in Illinois?",
                   "2026-03-17 00:00:00+00", "2026-04-20 00:00:00+00")
    assert r.country == "US"
    assert r.office == "senate"
    assert r.race_id == "US/senate/illinois"
    assert r.stage == "nominee"


def test_parse_us_governor_primary():
    r = parse_race("Will Tommy Tuberville win the 2026 Alabama Governor Republican primary election?",
                   "2026-05-19 00:00:00+00", "2026-05-20 04:32:15+00")
    assert r.country == "US"
    assert r.office == "governor"
    assert r.race_id == "US/governor/alabama"
    assert r.stage == "primary"


def test_parse_foreign_parliament():
    r = parse_race("Will Fidesz-KDNP win the national list vote in the 2026 Hungarian Parliamentary election by 0-3%?",
                   "2026-04-12 00:00:00+00", "2026-04-18 00:00:00+00")
    assert r.country == "Hungary"
    assert r.office == "parliament"
    assert r.stage in ("general", "other")


def test_parse_foreign_gubernatorial_is_non_us():
    r = parse_race("Will Yeom Tae-yeong win the 2026 Gyeonggi Province Gubernatorial Election?",
                   "2026-06-03 00:00:00+00", "2026-06-04 04:02:25+00")
    assert r.country == "South Korea"
    assert r.office == "governor"


def test_parse_placeholder_is_unknown():
    r = parse_race("Will Person A be the Democratic Nominee for NJ-12?",
                   "2026-06-01 00:00:00+00", "2026-06-02 00:00:00+00")
    assert r.candidate == "person a"
    # placeholder candidate still parses race geography; candidate flagged by caller
    assert r.country == "US" and r.office == "house"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_poll_census.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'poll_census'`.

- [ ] **Step 3: Implement the parser**

```python
# poll_census.py
from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
import csv, json, re
import numpy as np

HERE = Path(__file__).resolve().parent
CATALOG = HERE / "datasets" / "conditional_catalog_political.csv"
CENSUS_OUT = HERE / "datasets" / "poll_supply_census.csv"
PARAMS_OUT = HERE / "datasets" / "poll_transform_params.json"


@dataclass(frozen=True)
class Race:
    race_id: str
    country: str
    office: str          # senate|governor|house|president|parliament|mayor|other
    stage: str           # primary|nominee|advance|general|other
    candidate: str
    resolution_date: str


@dataclass(frozen=True)
class Coverage:
    race_id: str
    tier: str            # aggregator|raw_polls|none|unknown
    source_url: str | None


# Country keyword -> canonical name. Order matters (first hit wins).
_COUNTRY = [
    ("hungarian", "Hungary"), ("bulgarian", "Bulgaria"), ("peruvian", "Peru"),
    ("colombian", "Colombia"), ("bangladesh", "Bangladesh"), ("tamil nadu", "India"),
    ("kerala", "India"), ("assam", "India"), ("bolivia", "Bolivia"),
    ("cochabamba", "Bolivia"), ("la paz", "Bolivia"), ("santa cruz", "Bolivia"),
    ("gyeonggi", "South Korea"), ("chungcheong", "South Korea"),
    ("gangwon", "South Korea"), ("province", "South Korea"),
    ("cyprus", "Cyprus"), ("armenian", "Armenia"), ("scottish", "UK"),
    ("marseille", "France"), ("australian", "Australia"), ("farrer", "Australia"),
]

_OFFICE = [
    (re.compile(r"\bsenate\b|\bsenator\b", re.I), "senate"),
    (re.compile(r"\bgovernor\b|gubernatorial", re.I), "governor"),
    (re.compile(r"\bpresident", re.I), "president"),
    (re.compile(r"\bmayor\b", re.I), "mayor"),
    (re.compile(r"\bparliament|national list|legislative assembly|chamber of", re.I), "parliament"),
    (re.compile(r"\bhouse\b|\bcongress\b", re.I), "house"),
]

_SEAT = re.compile(r"\b([A-Z]{2}-\d+)\b")
_US_STATES = {
    "alabama", "alaska", "arizona", "arkansas", "california", "colorado",
    "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho",
    "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine",
    "maryland", "massachusetts", "michigan", "minnesota", "mississippi",
    "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey",
    "new mexico", "new york", "north carolina", "north dakota", "ohio",
    "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina",
    "south dakota", "tennessee", "texas", "utah", "vermont", "virginia",
    "washington", "west virginia", "wisconsin", "wyoming",
}


def _candidate(q: str) -> str:
    m = re.match(r"\s*Will\s+(.+?)\s+(?:be|win|advance|finish)\b", q, re.I)
    return m.group(1).strip().lower() if m else ""


def _stage(q: str) -> str:
    ql = q.lower()
    if "advance from" in ql:
        return "advance"
    if "nominee" in ql:
        return "nominee"
    if "primary" in ql:
        return "primary"
    if re.search(r"win the .*(election|seat|governorship|senate|race)", ql):
        return "general"
    return "other"


def _us_state_in(q: str) -> str | None:
    ql = q.lower()
    for st in _US_STATES:
        if re.search(r"\b" + re.escape(st) + r"\b", ql):
            return st
    return None


def parse_race(question: str, end_date: str, resolved_at: str) -> Race:
    cand = _candidate(question)
    stage = _stage(question)
    office = next((name for rx, name in _OFFICE if rx.search(question)), "other")

    # geography: US seat code, US state, or foreign keyword
    seat = _SEAT.search(question)
    country = next((c for kw, c in _COUNTRY if kw in question.lower()), None)
    state = _us_state_in(question)

    if seat:
        country = "US"
        race_id = f"US/house/{seat.group(1).upper()}"
        return Race(race_id, "US", "house", stage, cand, resolved_at)
    if country is None and state is not None:
        country = "US"
    if country is None:
        country = "US" if re.search(r"\bU\.?S\.?\b|United States", question) else "unknown"

    region = state if (country == "US" and state) else _slug_region(question, office)
    race_id = f"{country}/{office}/{region}" if region else f"{country}/{office}/?"
    return Race(race_id, country, office, stage, cand, resolved_at)


def _slug_region(q: str, office: str) -> str | None:
    # words immediately before the office word, e.g. "Gyeonggi Province" before Gubernatorial
    m = re.search(
        r"\b(20\d\d\s+)?([A-Z][\w.'-]+(?:\s+[A-Z][\w.'-]+){0,3})\s+"
        r"(?:Governor|Gubernatorial|Senate|President|Mayor|Parliament|Legislative)",
        q,
    )
    return m.group(2).strip().lower() if m else None
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_poll_census.py -v`
Expected: the 6 parser tests PASS. (Other tests in the file will error on missing
`classify_coverage`/`run_census`/`fit_margin_to_winprob` — that is expected until
later tasks; run only parser tests with `-k parse` if you want a clean pass:
`python -m pytest tests/test_poll_census.py -k parse -v` → 6 passed.)

- [ ] **Step 5: Commit**

```bash
git add scripts/edge-research/poll_census.py scripts/edge-research/tests/test_poll_census.py
git commit -m "feat(h-ine-poll): race parser for poll-supply census"
```

---

### Task 2: Coverage classifier (injectable verifier)

**Files:**
- Modify: `scripts/edge-research/poll_census.py`
- Test: `scripts/edge-research/tests/test_poll_census.py`

- [ ] **Step 1: Write the failing tests**

```python
# append to tests/test_poll_census.py

def _race(country, office, race_id="x", stage="general"):
    return Race(race_id, country, office, stage, "cand", "2026-06-01")


def test_classifier_prior_us_senate_is_aggregator():
    cov = classify_coverage(_race("US", "senate"), verifier=None)
    assert cov.tier == "aggregator"


def test_classifier_prior_us_house_is_raw_polls():
    cov = classify_coverage(_race("US", "house"), verifier=None)
    assert cov.tier == "raw_polls"


def test_classifier_prior_foreign_minor_is_none():
    cov = classify_coverage(_race("Bolivia", "governor"), verifier=None)
    assert cov.tier == "none"


def test_classifier_prior_unknown_geo_is_unknown():
    cov = classify_coverage(_race("unknown", "other"), verifier=None)
    assert cov.tier == "unknown"


def test_classifier_verifier_overrides_prior():
    def verifier(race):
        return Coverage(race.race_id, "aggregator", "http://wiki/x")
    cov = classify_coverage(_race("US", "house"), verifier=verifier)
    assert cov.tier == "aggregator"
    assert cov.source_url == "http://wiki/x"


def test_classifier_verifier_exception_falls_back_to_prior():
    def verifier(race):
        raise RuntimeError("network down")
    cov = classify_coverage(_race("US", "senate"), verifier=verifier)
    assert cov.tier == "aggregator"   # prior, not a crash
    assert cov.source_url is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_poll_census.py -k classifier -v`
Expected: FAIL with `ImportError` / `AttributeError` on `classify_coverage`/`Coverage`
(or NameError) — `classify_coverage` not yet defined.

- [ ] **Step 3: Implement the classifier**

```python
# add to poll_census.py
from typing import Optional

# countries whose national elections have English-language Wikipedia poll tables
_RAW_POLL_COUNTRIES = {"UK", "Australia", "Canada", "Germany", "France", "India"}


def _prior_tier(race: Race) -> str:
    if race.country == "unknown" or race.office == "other":
        return "unknown"
    if race.country == "US":
        if race.office in ("senate", "governor", "president"):
            return "aggregator"     # 2026 US Senate/Gov: Silver/Economist forecasts
        if race.office in ("house",):
            return "raw_polls"      # district polling on Wikipedia, no win-prob agg
        return "raw_polls"
    if race.country in _RAW_POLL_COUNTRIES and race.office in (
        "parliament", "president", "house", "senate",
    ):
        return "raw_polls"
    return "none"                   # foreign minor (provincial/state, niche)


def classify_coverage(
    race: Race, verifier: "Optional[Callable[[Race], Optional[Coverage]]]" = None
) -> Coverage:
    prior = _prior_tier(race)
    if verifier is not None:
        try:
            got = verifier(race)
            if got is not None:
                return got
        except Exception:
            pass   # verifier failure -> fall back to prior, never crash the census
    return Coverage(race.race_id, prior, None)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_poll_census.py -k classifier -v`
Expected: 6 classifier tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/edge-research/poll_census.py scripts/edge-research/tests/test_poll_census.py
git commit -m "feat(h-ine-poll): coverage classifier with injectable verifier"
```

---

### Task 3: Census runner + report (two n's)

**Files:**
- Modify: `scripts/edge-research/poll_census.py`
- Test: `scripts/edge-research/tests/test_poll_census.py`

- [ ] **Step 1: Write the failing tests**

```python
# append to tests/test_poll_census.py

def _row(q, rid):
    return {"market_id": rid, "event_id": "e" + rid, "market_type": "event_long",
            "question": q, "end_date": "2026-06-01 00:00:00+00",
            "resolved_at": "2026-06-02 00:00:00+00", "outcome_yes": "0"}


def test_run_census_counts_two_ns_and_tiers(tmp_path):
    rows = [
        _row("Will A win the 2026 Texas Senate election?", "1"),
        _row("Will B win the 2026 Texas Senate election?", "2"),   # same race, 2nd market
        _row("Will C be the Republican nominee for KY-04?", "3"),
        _row("Will D win the 2026 Cochabamba gubernatorial election?", "4"),
        _row("Will E post 40 posts this week?", "5"),               # office=other -> unknown
    ]
    covs, summary = run_census(rows, verifier=None, out_path=tmp_path / "c.csv")
    # 5 candidate-markets total, no silent drops
    assert summary["candidate_markets_total"] == 5
    # distinct races: TX senate (1), KY-04 (1), Cochabamba (1), unknown (1) = 4
    assert summary["races_total"] == 4
    # aggregator tier: TX senate -> 1 race, 2 candidate-markets
    assert summary["by_tier"]["aggregator"]["races"] == 1
    assert summary["by_tier"]["aggregator"]["candidate_markets"] == 2
    assert summary["by_tier"]["raw_polls"]["races"] == 1     # KY-04
    assert summary["by_tier"]["none"]["races"] == 1          # Cochabamba
    assert summary["by_tier"]["unknown"]["races"] == 1
    # CSV written, one row per candidate-market
    assert (tmp_path / "c.csv").exists()
    import csv as _csv
    written = list(_csv.DictReader((tmp_path / "c.csv").open(encoding="utf-8")))
    assert len(written) == 5
    assert set(written[0].keys()) >= {"market_id", "race_id", "country", "office",
                                      "stage", "tier", "source_url"}


def test_run_census_reachable_n_is_conservative_race_count(tmp_path):
    rows = [_row(f"Will Cand{i} win the 2026 Texas Senate election?", str(i))
            for i in range(5)]
    covs, summary = run_census(rows, verifier=None, out_path=tmp_path / "c.csv")
    # 5 candidate-markets but ONE race -> conservative reachable n for this race = 1
    assert summary["races_total"] == 1
    assert summary["candidate_markets_total"] == 5
    assert summary["reachable_n_conservative"] == summary["by_tier"]["aggregator"]["races"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_poll_census.py -k run_census -v`
Expected: FAIL — `run_census` not defined.

- [ ] **Step 3: Implement the runner**

```python
# add to poll_census.py

def run_census(rows, verifier=None, out_path: Path | None = None):
    """rows: iterable of catalog dicts. Returns (list[per-market record], summary)."""
    out_path = Path(out_path) if out_path is not None else CENSUS_OUT
    records = []
    race_tier: dict[str, str] = {}
    for r in rows:
        race = parse_race(r["question"], r.get("end_date", ""), r.get("resolved_at", ""))
        cov = classify_coverage(race, verifier=verifier)
        race_tier[race.race_id] = cov.tier   # races share a tier; last write is fine (same prior)
        records.append({
            "market_id": r.get("market_id", ""),
            "race_id": race.race_id,
            "country": race.country,
            "office": race.office,
            "stage": race.stage,
            "candidate": race.candidate,
            "resolution_date": race.resolution_date,
            "tier": cov.tier,
            "source_url": cov.source_url or "",
        })

    tiers = ("aggregator", "raw_polls", "none", "unknown")
    by_tier = {t: {"races": 0, "candidate_markets": 0} for t in tiers}
    seen_races_by_tier = {t: set() for t in tiers}
    for rec in records:
        t = rec["tier"]
        by_tier[t]["candidate_markets"] += 1
        if rec["race_id"] not in seen_races_by_tier[t]:
            seen_races_by_tier[t].add(rec["race_id"])
            by_tier[t]["races"] += 1

    summary = {
        "candidate_markets_total": len(records),
        "races_total": len({rec["race_id"] for rec in records}),
        "by_tier": by_tier,
        # conservative reachable n = races with usable polls (aggregator + raw_polls)
        "reachable_n_conservative":
            by_tier["aggregator"]["races"] + by_tier["raw_polls"]["races"],
        "reachable_n_optimistic":
            by_tier["aggregator"]["candidate_markets"] + by_tier["raw_polls"]["candidate_markets"],
    }

    if out_path is not None:
        with out_path.open("w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=list(records[0].keys()) if records else
                               ["market_id", "race_id", "country", "office", "stage",
                                "candidate", "resolution_date", "tier", "source_url"])
            w.writeheader()
            w.writerows(records)
    return records, summary
```

Note the test asserts `reachable_n_conservative == aggregator.races` because that
fixture has only an aggregator race plus a `none` and `unknown` race (no `raw_polls`),
so `aggregator + raw_polls(0) == aggregator`. The second test has a single aggregator
race → conservative n = 1.

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_poll_census.py -k run_census -v`
Expected: 2 census tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/edge-research/poll_census.py scripts/edge-research/tests/test_poll_census.py
git commit -m "feat(h-ine-poll): census runner reporting conservative + optimistic n"
```

---

### Task 4: Transform calibrator (numpy-only logistic + Brier)

**Files:**
- Modify: `scripts/edge-research/poll_census.py`
- Test: `scripts/edge-research/tests/test_poll_census.py`

- [ ] **Step 1: Write the failing tests**

```python
# append to tests/test_poll_census.py

def test_fit_recovers_positive_slope_and_beats_base_brier():
    rng = np.random.default_rng(0)
    margins = rng.uniform(-0.30, 0.30, size=500)      # +/- 30 pts
    true_p = 1.0 / (1.0 + np.exp(-(0.0 + 12.0 * margins)))
    outcomes = (rng.uniform(size=500) < true_p).astype(float)
    res = fit_margin_to_winprob(margins, outcomes)
    assert res["b1"] > 0                               # higher margin -> higher win prob
    base = outcomes.mean()
    base_brier = float(np.mean((base - outcomes) ** 2))
    assert res["brier"] < base_brier                   # model beats unconditional base
    assert 0.0 <= res["brier"] <= 0.25


def test_fit_validates_against_aggregator_winprob():
    rng = np.random.default_rng(1)
    margins = rng.uniform(-0.25, 0.25, size=400)
    true_p = 1.0 / (1.0 + np.exp(-(10.0 * margins)))
    outcomes = (rng.uniform(size=400) < true_p).astype(float)
    res = fit_margin_to_winprob(margins, outcomes, agg_winprob=true_p)
    # our fitted prob should correlate strongly with the aggregator's win-prob
    assert res["agg_corr"] is not None and res["agg_corr"] > 0.9


def test_fit_degenerate_all_same_outcome_is_uninformative():
    margins = np.linspace(-0.2, 0.2, 50)
    outcomes = np.ones(50)
    res = fit_margin_to_winprob(margins, outcomes)
    assert res["status"] == "uninformative"
    assert not math.isnan(res["brier"])
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_poll_census.py -k fit -v`
Expected: FAIL — `fit_margin_to_winprob` not defined.

- [ ] **Step 3: Implement the calibrator**

```python
# add to poll_census.py

def _sigmoid(z):
    return 1.0 / (1.0 + np.exp(-np.clip(z, -30, 30)))


def fit_margin_to_winprob(margin, outcome, agg_winprob=None, iters: int = 50):
    """Hand-rolled IRLS logistic: P(win) = sigmoid(b0 + b1*margin).

    Returns dict with b0, b1, brier (of fitted prob vs outcome), agg_corr
    (Pearson corr of fitted prob vs aggregator win-prob, or None), n, status.
    Degenerate input (all-same outcome) returns status='uninformative' with the
    base-rate prob as a constant prediction and a defined (non-NaN) Brier.
    """
    x = np.asarray(margin, dtype=float)
    y = np.asarray(outcome, dtype=float)
    n = x.size
    base = float(y.mean()) if n else float("nan")

    if n == 0 or len(np.unique(y)) < 2:
        p = np.full(n, base if n else 0.5)
        brier = float(np.mean((p - y) ** 2)) if n else float("nan")
        corr = _corr(p, agg_winprob)
        return {"b0": float(np.log(base / (1 - base))) if 0 < base < 1 else 0.0,
                "b1": 0.0, "brier": brier, "agg_corr": corr, "n": n,
                "status": "uninformative"}

    X = np.column_stack([np.ones(n), x])
    beta = np.zeros(2)
    for _ in range(iters):
        eta = X @ beta
        p = _sigmoid(eta)
        W = np.clip(p * (1 - p), 1e-6, None)
        # IRLS update: beta += (X' W X)^-1 X' (y - p)
        XtWX = X.T @ (X * W[:, None])
        grad = X.T @ (y - p)
        try:
            step = np.linalg.solve(XtWX, grad)
        except np.linalg.LinAlgError:
            break
        beta = beta + step
        if np.max(np.abs(step)) < 1e-8:
            break

    p = _sigmoid(X @ beta)
    brier = float(np.mean((p - y) ** 2))
    return {"b0": float(beta[0]), "b1": float(beta[1]), "brier": brier,
            "agg_corr": _corr(p, agg_winprob), "n": n, "status": "ok"}


def _corr(p, agg_winprob):
    if agg_winprob is None:
        return None
    a = np.asarray(agg_winprob, dtype=float)
    p = np.asarray(p, dtype=float)
    if a.size != p.size or a.size < 2 or np.std(a) == 0 or np.std(p) == 0:
        return None
    return float(np.corrcoef(p, a)[0, 1])
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_poll_census.py -k fit -v`
Expected: 3 calibrator tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/edge-research/poll_census.py scripts/edge-research/tests/test_poll_census.py
git commit -m "feat(h-ine-poll): numpy IRLS margin->win-prob calibrator with Brier"
```

---

### Task 5: CLI entry point + full-suite green

**Files:**
- Modify: `scripts/edge-research/poll_census.py`
- Test: `scripts/edge-research/tests/test_poll_census.py`

- [ ] **Step 1: Write the failing test**

```python
# append to tests/test_poll_census.py

def test_load_catalog_rows_reads_real_file_if_present():
    from poll_census import load_catalog_rows, CATALOG
    if not CATALOG.exists():
        pytest.skip("catalog CSV not on disk")
    rows = load_catalog_rows()
    assert len(rows) > 1000
    assert "question" in rows[0]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_poll_census.py -k load_catalog -v`
Expected: FAIL — `load_catalog_rows` not defined.

- [ ] **Step 3: Implement loader + CLI**

```python
# add to poll_census.py

def load_catalog_rows(path: Path | None = None) -> list[dict]:
    path = Path(path) if path is not None else CATALOG
    with path.open(encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def _print_summary(summary: dict) -> None:
    print(f"candidate-markets: {summary['candidate_markets_total']}  "
          f"races: {summary['races_total']}")
    print(f"reachable n  conservative(races): {summary['reachable_n_conservative']}  "
          f"optimistic(markets): {summary['reachable_n_optimistic']}")
    print("by tier:")
    for t, c in summary["by_tier"].items():
        print(f"  {t:11s} races={c['races']:4d}  candidate-markets={c['candidate_markets']:4d}")
    floor = 200
    verdict = "GO" if summary["reachable_n_conservative"] >= floor else "NO-GO"
    print(f"\nGO/NO-GO (floor {floor} races): {verdict}")


if __name__ == "__main__":
    rows = load_catalog_rows()
    records, summary = run_census(rows, verifier=None)
    _print_summary(summary)
    print(f"\nwrote {CENSUS_OUT}")
```

- [ ] **Step 4: Run the full suite**

Run: `python -m pytest tests/test_poll_census.py -v`
Expected: ALL tests PASS (parser 6 + classifier 6 + census 2 + calibrator 3 + loader 1).

- [ ] **Step 5: Commit**

```bash
git add scripts/edge-research/poll_census.py scripts/edge-research/tests/test_poll_census.py
git commit -m "feat(h-ine-poll): catalog loader + census CLI with GO/NO-GO summary"
```

---

### Task 6: Run the prior-only census + targeted web spot-checks (execution, not unit-tested)

**Files:**
- Run only; may write `scripts/edge-research/datasets/poll_supply_census.csv`.

This task produces the actual GO/NO-GO. It is run inline by the controller, not a TDD unit.

- [ ] **Step 1: Run the prior-only census**

Run: `python poll_census.py`
Record the printed reachable-n table (conservative races by tier) and the GO/NO-GO line.

- [ ] **Step 2: Web spot-check the tier priors (WebSearch/WebFetch)**

For a sample of ~3 races per tier, confirm the prior against reality:
- `aggregator`: search e.g. "Silver Bulletin 2026 <state> Senate forecast" / "2026 <state> gubernatorial election Wikipedia opinion polling" — confirm a win-prob aggregator AND a poll table exist.
- `raw_polls`: confirm a Wikipedia "Opinion polling for the <race>" table exists but no win-prob aggregator.
- `none`: confirm no English poll aggregation (expected for provincial foreign races).

Downgrade/upgrade the tier counts narratively based on what the spot-checks reveal
(do not silently trust the prior — the conditional lesson). If spot-checks show a
prior is systematically wrong (e.g. US House has far less Wikipedia polling than
assumed), note the corrected reachable-n.

- [ ] **Step 3: Decide and record GO/NO-GO**

Write the verdict (with the corrected reachable-n) into the memory file
`project_h_ine_program_2026-06-23.md`:
- **GO** if conservative reachable n (aggregator + confirmed raw_polls) ≥ ~200 → proceed
  to sub-project B (validator + price backfill), sized to the confirmed universe.
- **NO-GO** if well below → document the shortfall like the conditional verdict; the
  poll route is supply-limited on this catalog. Consider H-INE-3 or the program
  quitting bar.

- [ ] **Step 4 (gated on dual-coverage ≥ 30): fit + persist the transform**

If the census surfaces ≥30 races with BOTH an aggregator win-prob and raw poll
margins (sourced in the spot-checks), assemble `(margin, outcome, agg_winprob)` for
them and run `fit_margin_to_winprob`, then persist:

```python
import json
from poll_census import fit_margin_to_winprob, PARAMS_OUT
res = fit_margin_to_winprob(margins, outcomes, agg_winprob=agg)
PARAMS_OUT.write_text(json.dumps(res, indent=2))
print(res)
```

Report the Brier vs base-rate and `agg_corr`. If dual-coverage < 30, skip and record
"transform deferred to B, insufficient dual-coverage" — do not fabricate a fit.

---

## Notes for the implementer

- `python` (not `python3`) on this Windows box. Tests run from `scripts/edge-research/`.
- No scipy/sklearn — the IRLS logistic is intentionally hand-rolled in numpy.
- `datasets/*.csv` and `*.json` are gitignored; commit only `poll_census.py` and the test.
- The web verifier in Task 6 is exercised live by the controller; it is deliberately
  NOT a pytest case (no live-network tests). The classifier stays testable via stubs.
